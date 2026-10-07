// ai-topics-chat — the AI chat endpoint (POST /api/sessions/:sessionId/ai/chat).
// New frozen API surface authorized by the ai-topics-chat delta spec. This file
// is the route SHELL plus the two pieces of state the ai router module is the
// preassigned shared home for (apply ledger): the resume binding
// `claude_session_id` → {sessionId, userId} (design "Multi-turn continuity
// bound to the autologger session"; in the catalog kv since
// shared-request-state D3) and the guard order itself. Once every
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
// gate (503) → body validation (422 schema / 400
// malformed JSON) → foreign/stale claude_session_id (422, before any
// subprocess) → per-session single-flight (409; no process-wide ceiling,
// run-status-and-sweeper D2). All error
// bodies are the repo `{ detail }` shape; none of these steps spawns.

import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { aiChatTurns } from '@autologger/ai-runtime/aiChatRegistry';
import { aiChatConversationFile } from '@autologger/ai-runtime/aiChatRunner';
import type { AiMcpToolName } from '@autologger/ai-runtime/aiMcpServer';
import { driveAiTurn } from '@autologger/ai-runtime/aiTurn';
import { chatRequestSchema } from '@autologger/contract';
import { type Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AppEnv } from '../appEnv';
import { aiChatConfigured, aiChatMaxBudgetUsd, aiChatTimeoutSec } from '../env';
import { ApiError } from '../httpError';
import { claimAiLease } from './_aiSlot';
import { requireSession, requireUser, sessionCaller } from './_helpers';

export const aiRouter = new Hono<AppEnv>();

/** Chat's tool surface, pinned EXPLICITLY (auto-generate-event-logs D7, task
 * 3.4): exactly the three chat tools, deliberately NOT derived from the full
 * `AI_MCP_TOOL_NAMES` registry — the registry now also carries `create_event`
 * (generation turns only), and growing it must never silently widen a chat
 * turn. Passed to `driveAiTurn` below as BOTH the CLI `--allowedTools`
 * allowlist and the server-side MCP registration context (`mcpContext`), so
 * chat relies on the omit-path defaults nowhere. The wire string this produces
 * is byte-identical to the pre-3.4 omit-path default (`AI_CHAT_DEFAULT_TOOLS`
 * in `aiChatRunner.ts`, which stays as the fallback for callers that omit) —
 * pinned by ai.int.test.ts "tool surface pinned explicitly". */
export const AI_CHAT_ALLOWED_TOOLS = [
  'get_transcript_words',
  'list_topics',
  'create_topic',
] as const satisfies readonly AiMcpToolName[];

const NOT_CONFIGURED_DETAIL =
  'AI chat is not configured on this deployment. Set CLAUDE_CLI_PATH to the claude CLI to enable it.';
const FOREIGN_CLAUDE_SESSION_ID_DETAIL =
  'claude_session_id was not issued for this session. Omit it to start a new conversation, or resume with the ' +
  "id from this session's most recent done event.";
// Shared with the AI v2 design-turn registry (aiV2.ts, task 2.7) and the
// generate endpoints by design — the wording names EVERY possible holder,
// never just "AI chat", because the actual holder of a busy slot may be any
// of them (spec "Spend and concurrency bounds": "responds 409 ... naming
// which feature holds the slot"; naming event generation is authorized by
// the auto-event-generation delta).
const SESSION_BUSY_DETAIL =
  'A turn (AI chat, AI v2, topic generation, or event generation) is already in progress for this session; ' +
  'wait for it to finish before sending another. These features share one per-session AI slot by design.';

// ── Multi-turn continuity: the resume binding (shared-request-state D3) ──
// (design "Multi-turn continuity bound to the autologger session"). Written to
// the catalog kv when a turn's `done` event carries a session id, as
// `{v:1, sessionId, userId}` with a 7-day expiry, so any server process sharing
// the database sees it; consulted before a LATER turn may pass that id as
// `--resume`. An id that is malformed, unbound, bound to a DIFFERENT
// :sessionId or user (a co-member of the session included), expired, or whose
// conversation file is not at the exact path the CLI will read under this
// process's CLI home, is rejected with 422 before any subprocess spawns (spec
// scenarios "Foreign session id is rejected, not resumed", "A co-member cannot
// resume another user's conversation", "A missing conversation file is a 422").

const RESUME_KEY_PREFIX = 'ai-chat-resume:';
const RESUME_TTL_S = 7 * 24 * 60 * 60;
/** Checked first, before any key or path is built from the id (D3). */
const CLAUDE_SESSION_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

async function resumeAccepted(
  c: Context<AppEnv>,
  claudeSessionId: string,
  sessionId: string,
  userId: string,
): Promise<boolean> {
  if (!CLAUDE_SESSION_ID_RE.test(claudeSessionId)) return false;
  const raw = await c.env.ports.kv.get(RESUME_KEY_PREFIX + claudeSessionId);
  if (raw === null) return false;
  let binding: { sessionId?: unknown; userId?: unknown } | null;
  try {
    binding = JSON.parse(raw) as { sessionId?: unknown; userId?: unknown } | null;
  } catch {
    return false;
  }
  if (binding?.sessionId !== sessionId || binding.userId !== userId) return false;
  const cliHome = c.env.config.AI_CHAT_CLI_HOME ?? homedir();
  try {
    return (await stat(aiChatConversationFile(cliHome, sessionId, claudeSessionId))).isFile();
  } catch {
    return false;
  }
}

aiRouter.post('/api/sessions/:sessionId/ai/chat', async (c) => {
  const sessionId = c.req.param('sessionId');

  // 2. Session resolution/scoping — 404 for nonexistent/deleted/out-of-studio.
  // Runs first (after the authContext 401 gate) so an unauthorized session is
  // masked as 404 before the config/single-flight state below can leak.
  await requireSession(c, sessionId);

  // 3. Configuration gate — 503, before body parse and before any spawn
  // (design D8).
  if (!aiChatConfigured(c.env.config)) {
    throw new ApiError(503, NOT_CONFIGURED_DETAIL);
  }

  // 4. Body validation — ZodError → 422, malformed JSON → 400 (global onError),
  // spawning nothing. c.req.json() throws SyntaxError on malformed JSON.
  const body = chatRequestSchema.parse(await c.req.json());

  // 4b. Multi-turn continuity ownership — a claude_session_id not issued for
  // THIS :sessionId and THIS user (foreign, another user's, expired, or
  // forged), or whose conversation file is missing here, is rejected with 422
  // BEFORE any subprocess spawns (spec "Multi-turn continuity bound to the
  // autologger session"; shared-request-state D3). The schema above only
  // enforces "non-empty string when present" — ownership is checked here,
  // against the kv binding this same handler writes on `done`.
  const userId = requireUser(c).id;
  let resumeSessionId: string | undefined;
  if (body.claude_session_id) {
    if (!(await resumeAccepted(c, body.claude_session_id, sessionId, userId))) {
      throw new ApiError(422, FOREIGN_CLAUDE_SESSION_ID_DETAIL);
    }
    resumeSessionId = body.claude_session_id;
  }

  // 5. Single-flight (per session) — 409, spawning nothing. There is no
  // process-wide ceiling (run-status-and-sweeper D2). The slot is held for the whole turn and released when the
  // stream ends.
  const proc = aiChatTurns.tryAcquire(sessionId);
  if (!proc.ok) throw new ApiError(409, SESSION_BUSY_DETAIL);
  // 5b. The session's `ai-turn` lease (session-run-leases D4), behind the slot:
  // a refusal means another process runs a turn here, so it reads as session-busy.
  const slot = await claimAiLease(c, sessionId, proc);
  if (slot === null) throw new ApiError(409, SESSION_BUSY_DETAIL);

  // Every guard passed: `driveAiTurn` (topic-generation design D7 — the
  // shared helper `topics/generate` also uses) registers an MCP turn, spawns
  // the locked-down CLI, and relays its stdout as real delta/tool/done/error
  // events while racing the guaranteed timeout and a best-effort
  // client-disconnect signal. Registration, spawn, the generated MCP config,
  // and the child's process group are all dropped/killed inside the helper's
  // own `finally`, regardless of how the turn ends; this router still
  // releases the concurrency slot in ITS OWN `finally` (slot lifecycle is
  // per-endpoint — the 409 wording differs from `topics/generate`'s) —
  // together this preserves the Phase 1 "slot release in finally" seam and
  // "no orphan process, ever" (spec "Subprocess lifecycle").
  return streamSSE(c, async (stream) => {
    try {
      const outcome = await driveAiTurn({
        clock: c.env.ports.clock,
        registry: c.env.ports.sessions,
        caller: sessionCaller(c),
        cliPath: c.env.config.CLAUDE_CLI_PATH.trim(),
        sessionId,
        message: body.message,
        // Explicit tool surface (D7, task 3.4): argv allowlist AND server-side
        // MCP registration both name exactly the three chat tools — no
        // reliance on either omit-path default, so a growing registry can
        // never widen a chat turn.
        allowedTools: AI_CHAT_ALLOWED_TOOLS,
        mcpContext: { tools: AI_CHAT_ALLOWED_TOOLS },
        maxBudgetUsd: aiChatMaxBudgetUsd(c.env.config),
        timeoutMs: aiChatTimeoutSec(c.env.config) * 1000,
        resumeSessionId,
        emit: async (event) => {
          await stream.writeSSE({ event: event.event, data: JSON.stringify(event.data) });
        },
        abortSignal: c.req.raw.signal,
      });
      if (outcome.ok) {
        // A write error is logged and does not fail the turn; the next resume then gets 422 (D3).
        try {
          await c.env.ports.kv.put(
            RESUME_KEY_PREFIX + outcome.claudeSessionId,
            JSON.stringify({ v: 1, sessionId, userId }),
            { expirationTtl: RESUME_TTL_S },
          );
        } catch (err) {
          console.warn(
            `[ai-chat] could not record the resume binding (${err instanceof Error ? err.message : String(err)})`,
          );
        }
      }
    } finally {
      // Lease, then slot, before the stream closes (session-run-leases D4).
      await slot.release();
    }
  });
});
