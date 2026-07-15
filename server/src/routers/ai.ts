// ai-topics-chat — the AI chat endpoint (POST /api/sessions/:sessionId/ai/chat).
// New frozen API surface authorized by the ai-topics-chat delta spec. This file
// is the route SHELL: it enforces the guard order and, once every guard passes,
// hands off to the turn runner. The turn runner (claude subprocess spawn), the
// in-process MCP toolset, and the real delta/tool/done/error SSE relay are
// Phases 2–3 — see the TODO at the acceptance point.
//
// Guard order (spec "Chat request contract"), matching the transcript-words/
// generate sibling: authentication (authContext middleware, 401) → session
// resolution/scoping (requireSession, 404 — masks unauthorized sessions before
// anything below) → configuration gate + open-network refusal (503) → body
// validation (422 schema / 400 malformed JSON, spawning nothing) → single-flight
// & process-wide concurrency (409). All error bodies are the repo `{ detail }`.

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  aiChatConfigured,
  aiChatMaxConcurrent,
  aiChatOpenNetworkRefused,
} from '../env';
import { chatRequestSchema } from '../schemas';
import type { AppEnv } from '../types';
import { aiChatTurns } from './aiChatRegistry';
import { ApiError, requireSession } from './_helpers';

export const aiRouter = new Hono<AppEnv>();

const NOT_CONFIGURED_DETAIL =
  'AI chat is not configured on this deployment. Set CLAUDE_CLI_PATH to the claude CLI to enable it.';
const OPEN_NETWORK_DETAIL =
  'AI chat is refused: the server is bound to a non-loopback address with REQUIRE_LOGIN disabled and no IP_ALLOWLIST. ' +
  'Enable login, set an IP_ALLOWLIST, or bind to loopback (HOST=127.0.0.1) before using a paid AI endpoint.';
const SESSION_BUSY_DETAIL =
  'An AI chat turn is already in progress for this session; wait for it to finish before sending another.';
const AT_CAPACITY_DETAIL =
  'The server is at its AI chat concurrency limit (AI_CHAT_MAX_CONCURRENT); try again shortly.';

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
  // TODO(Phase 3, task 3.3): reject a foreign/stale `claude_session_id` (one not
  // issued for this :sessionId) with 422 BEFORE spawning — needs the per-session
  // issued-id set the turn runner maintains. The shape check above only enforces
  // "non-empty string when present".
  void body;

  // 5. Single-flight (per session) + process-wide concurrency ceiling — 409,
  // spawning nothing. The slot is held for the whole turn and released when the
  // stream ends.
  const slot = aiChatTurns.tryAcquire(sessionId, aiChatMaxConcurrent(c.env.config));
  if (!slot.ok) {
    throw new ApiError(409, slot.reason === 'session-busy' ? SESSION_BUSY_DETAIL : AT_CAPACITY_DETAIL);
  }

  // Every guard passed. TODO(Phase 3, tasks 2.x/3.x): spawn the locked-down
  // claude turn runner + in-process MCP toolset here and relay real delta/tool/
  // done/error events. Until then, the placeholder emits a single terminal
  // `error` (one of the spec's fixed scrubbed strings) and closes — it spawns
  // nothing and keeps the one-terminal-event-per-completed-stream invariant.
  return streamSSE(c, async (stream) => {
    try {
      await stream.writeSSE({ event: 'error', data: JSON.stringify({ detail: 'internal-error' }) });
    } finally {
      slot.release();
    }
  });
});
