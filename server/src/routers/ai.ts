// ai-topics-chat — the AI chat endpoint (POST /api/sessions/:sessionId/ai/chat).
// New frozen API surface authorized by the ai-topics-chat delta spec. This file
// is the route SHELL plus the two pieces of state the ai router module is the
// preassigned shared home for (apply ledger): the resume-binding
// issued-`claude_session_id`→`:sessionId` map (design "Multi-turn continuity
// bound to the autologger session") and the guard order itself. Once every
// guard passes, it registers an MCP turn (task 2.1), spawns the locked-down
// CLI (task 3.2's `spawnAiChatTurn`), and relays its stdout to the client via
// the JSONL→SSE relay (task 3.3's `relayAiChatTurn`), all orchestrated by
// task 3.4's `runAiChatTurn` — which additionally races the guaranteed turn
// timeout and a best-effort client-disconnect signal, and terminates the
// child's process group on EVERY path (spec "Subprocess lifecycle").
//
// Guard order (spec "Chat request contract" + "Multi-turn continuity"),
// matching the transcript-words/generate sibling: authentication
// (authContext middleware, 401) → session resolution/scoping (requireSession,
// 404 — masks unauthorized sessions before anything below) → configuration
// gate + open-network refusal (503) → body validation (422 schema / 400
// malformed JSON) → foreign/stale claude_session_id (422, before any
// subprocess) → single-flight & process-wide concurrency (409). All error
// bodies are the repo `{ detail }` shape; none of these steps spawns.

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  aiChatConfigured,
  aiChatMaxBudgetUsd,
  aiChatMaxConcurrent,
  aiChatOpenNetworkRefused,
  aiChatTimeoutSec,
} from '../env';
import { chatRequestSchema } from '../schemas';
import type { AppEnv } from '../types';
import { aiChatTurns } from './aiChatRegistry';
import {
  type AiChatSpawnResult,
  killAiChatProcessGroup,
  runAiChatTurn,
  spawnAiChatTurn,
} from './aiChatRunner';
import { type AiMcpTurn, getAiMcpListener } from './aiMcpServer';
import { ApiError, requireSession } from './_helpers';

export const aiRouter = new Hono<AppEnv>();

const NOT_CONFIGURED_DETAIL =
  'AI chat is not configured on this deployment. Set CLAUDE_CLI_PATH to the claude CLI to enable it.';
const OPEN_NETWORK_DETAIL =
  'AI chat is refused: the server is bound to a non-loopback address with REQUIRE_LOGIN disabled and no IP_ALLOWLIST. ' +
  'Enable login, set an IP_ALLOWLIST, or bind to loopback (HOST=127.0.0.1) before using a paid AI endpoint.';
const FOREIGN_CLAUDE_SESSION_ID_DETAIL =
  'claude_session_id was not issued for this session. Omit it to start a new conversation, or resume with the ' +
  "id from this session's most recent done event.";
// Shared with the AI v2 design-turn registry (aiV2.ts, task 2.7) by design —
// the wording names BOTH features, never just "AI chat", because the actual
// holder of a busy slot may be either one (spec "Spend and concurrency
// bounds": "responds 409 ... naming which feature holds the slot").
const SESSION_BUSY_DETAIL =
  'A turn (AI chat or AI v2) is already in progress for this session; wait for it to finish before sending ' +
  'another. AI chat and AI v2 share one per-session slot by design.';
const AT_CAPACITY_DETAIL =
  'The server is at its AI turn concurrency limit (AI_CHAT_MAX_CONCURRENT, shared between AI chat and AI v2); ' +
  'try again shortly.';

// ── Multi-turn continuity: issued-claude_session_id → autologger :sessionId ──
// (design "Multi-turn continuity bound to the autologger session"). Recorded
// when a turn's `done` event carries a session id; consulted before a LATER
// turn is allowed to pass that id as `--resume`. An id this map has never
// seen, or has seen for a DIFFERENT :sessionId, is foreign/stale/forged and
// MUST be rejected with 422 before any subprocess spawns (spec scenario
// "Foreign session id is rejected, not resumed"). Module-level singleton,
// mirroring `aiChatTurns` — one process, one map.
const issuedClaudeSessionIds = new Map<string, string>();

function isClaudeSessionIdIssuedFor(claudeSessionId: string, sessionId: string): boolean {
  return issuedClaudeSessionIds.get(claudeSessionId) === sessionId;
}

/** Test-only: drop all resume bindings so the shared module singleton doesn't
 * leak across test cases. Not used on any request path. */
export function __resetAiChatIssuedSessionIdsForTests(): void {
  issuedClaudeSessionIds.clear();
}

aiRouter.post('/api/sessions/:sessionId/ai/chat', async (c) => {
  const sessionId = c.req.param('sessionId');

  // 2. Session resolution/scoping — 404 for nonexistent/deleted/out-of-studio.
  // Runs first (after the authContext 401 gate) so an unauthorized session is
  // masked as 404 before the config/single-flight state below can leak.
  await requireSession(c, sessionId);

  // 3. Configuration gate + open-network refusal — both 503, before body parse
  // and before any spawn (design D8).
  if (!aiChatConfigured(c.env.config)) {
    throw new ApiError(503, NOT_CONFIGURED_DETAIL);
  }
  if (aiChatOpenNetworkRefused(c.env.config)) {
    throw new ApiError(503, OPEN_NETWORK_DETAIL);
  }

  // 4. Body validation — ZodError → 422, malformed JSON → 400 (global onError),
  // spawning nothing. c.req.json() throws SyntaxError on malformed JSON.
  const body = chatRequestSchema.parse(await c.req.json());

  // 4b. Multi-turn continuity ownership — a claude_session_id not issued for
  // THIS :sessionId (foreign, stale, or forged) is rejected with 422 BEFORE
  // any subprocess spawns (spec "Multi-turn continuity bound to the
  // autologger session"; design "Multi-turn continuity" 422 scenario). The
  // schema above only enforces "non-empty string when present" — ownership
  // is checked here, against the map this same handler writes on `done`.
  let resumeSessionId: string | undefined;
  if (body.claude_session_id) {
    if (!isClaudeSessionIdIssuedFor(body.claude_session_id, sessionId)) {
      throw new ApiError(422, FOREIGN_CLAUDE_SESSION_ID_DETAIL);
    }
    resumeSessionId = body.claude_session_id;
  }

  // 5. Single-flight (per session) + process-wide concurrency ceiling — 409,
  // spawning nothing. The slot is held for the whole turn and released when the
  // stream ends.
  const slot = aiChatTurns.tryAcquire(sessionId, aiChatMaxConcurrent(c.env.config));
  if (!slot.ok) {
    throw new ApiError(409, slot.reason === 'session-busy' ? SESSION_BUSY_DETAIL : AT_CAPACITY_DETAIL);
  }

  // Every guard passed: register an MCP turn (task 2.1), spawn the locked-down
  // CLI (task 3.2), and let `runAiChatTurn` (task 3.4) relay its stdout as
  // real delta/tool/done/error events (task 3.3's `relayAiChatTurn`) while
  // racing the guaranteed timeout and a best-effort client-disconnect signal.
  // Registration, spawn, the generated MCP config, and the child's process
  // group are all dropped/killed in `finally` alongside the concurrency
  // slot, regardless of how the turn ends — this preserves the Phase 1 "slot
  // release in finally" seam and extends it to "no orphan process, ever"
  // (spec "Subprocess lifecycle").
  return streamSSE(c, async (stream) => {
    let mcpTurn: AiMcpTurn | null = null;
    let spawned: AiChatSpawnResult | null = null;
    try {
      const listener = await getAiMcpListener(c.env.ports.sessions);
      mcpTurn = listener.registerTurn(sessionId);
      spawned = spawnAiChatTurn({
        cliPath: c.env.config.CLAUDE_CLI_PATH.trim(),
        sessionId,
        message: body.message,
        mcpTurn: { url: mcpTurn.url, token: mcpTurn.token },
        maxBudgetUsd: aiChatMaxBudgetUsd(c.env.config),
        resumeSessionId,
      });
      const outcome = await runAiChatTurn({
        child: spawned.child,
        emit: async (event) => {
          await stream.writeSSE({ event: event.event, data: JSON.stringify(event.data) });
        },
        timeoutMs: aiChatTimeoutSec(c.env.config) * 1000,
        abortSignal: c.req.raw.signal,
      });
      if (outcome.ok) {
        issuedClaudeSessionIds.set(outcome.claudeSessionId, sessionId);
      }
    } catch {
      // Any unexpected failure setting up the turn (e.g. the MCP listener
      // failing to start, or spawnAiChatTurn's cwd/config write throwing)
      // still owes the client exactly one terminal event — never Hono's
      // default streamSSE `onError` fallback, which would relay the raw
      // exception message (a secrecy leak the spec forbids).
      await stream.writeSSE({ event: 'error', data: JSON.stringify({ detail: 'internal-error' }) });
    } finally {
      // Defensive-in-depth: runAiChatTurn already kills the process group on
      // every path it controls, but this call is idempotent (a fast no-op
      // once the child has exited) and guarantees no orphan even if setup
      // threw before runAiChatTurn ever ran (e.g. spawnAiChatTurn itself
      // failed after the child was already forked).
      if (spawned) await killAiChatProcessGroup(spawned.child);
      mcpTurn?.dispose();
      spawned?.cleanupConfig();
      slot.release();
    }
  });
});
