// ai-v2-dashboards — the design-turn endpoint's guard SHELL (tasks 2.1/2.2).
// POST /api/sessions/:sessionId/ai/v2/design. New frozen API surface
// authorized by the ai-v2-dashboards delta spec (additive only — no existing
// route, shape, status code, or WS emission changes).
//
// Guard order (spec "Design turn contract"), matching the ai-chat sibling
// (./ai.ts) and the transcript-words/generate route: authentication
// (authContext middleware, 401) → session resolution/scoping (requireSession,
// 404 — masks an unauthorized session before configuration or in-flight
// state can leak, spec scenario "Unauthorized session is masked as 404") →
// configuration gate + open-network refusal + agent-credentials refusal
// (503, spec "Configuration-gated AI v2 endpoints" / "Open-network refusal" /
// "Agent credentials") → body validation (422 schema / 400 malformed JSON,
// spec scenario "Invalid body rejected without side effects") → turn slot
// (409, spec "Spend and concurrency bounds" — shared with the AI chat's OWN
// registry BY DESIGN: "acquire a slot from the same registry the AI chat
// uses ... so per-session single-flight and the process-wide ceiling bound
// both features together rather than doubling the operator's exposure").
//
// SPAWN BOUNDARY: this unit (2.1/2.2) stops here, before the SDK is ever
// touched. Nothing below calls attemptDesignTurnSpawn
// (server/src/routers/aiV2SdkSpawn.ts) — the one call site that reaches the
// Agent SDK's `query()` (task 0.9) — so "no guard path spawns a subprocess"
// is true by construction: there is no spawn call anywhere in this file.
// Tasks 2.3-2.8 (closed-world option-set build, MCP aggregate tools, turn
// runner, SSE relay, lifecycle, and the FINAL slot-acquisition semantics —
// hold across the turn, release in `finally`) replace the placeholder 501
// tail below with the real turn; they own that call, strictly downstream of
// every guard already enforced here. The slot acquire/release pair just
// above that tail is real (not a stub): it is this unit's honest answer to
// "the guard chain must reach the point where a slot would be acquired" —
// acquired and immediately released because there is no actual turn yet to
// hold it across; task 2.7 replaces the immediate release with a
// hold-for-the-turn's-duration + release-on-every-path lifecycle.

import { Hono } from 'hono';
import {
  aiChatMaxConcurrent,
  aiV2Configured,
  aiV2CredentialsRefused,
  aiV2OpenNetworkRefused,
} from '../env';
import { aiV2DesignRequestSchema } from '../schemas';
import type { AppEnv } from '../types';
import { aiChatTurns } from './aiChatRegistry';
import { ApiError, requireSession } from './_helpers';

export const aiV2Router = new Hono<AppEnv>();

const NOT_CONFIGURED_DETAIL =
  'AI v2 is not configured on this deployment. Set AI_V2_ENABLED=1 to enable it.';
const OPEN_NETWORK_DETAIL =
  'AI v2 is refused: the server is bound to a non-loopback address with REQUIRE_LOGIN disabled and no IP_ALLOWLIST. ' +
  'Enable login, set an IP_ALLOWLIST, or bind to loopback (HOST=127.0.0.1) before using a paid AI endpoint.';
const CREDENTIALS_REFUSED_DETAIL =
  'AI v2 has no AI_V2_API_KEY configured and the server is bound to a non-loopback address; the interactive ' +
  '`claude login` fallback is loopback-only. Configure AI_V2_API_KEY or bind to loopback (HOST=127.0.0.1).';
const SESSION_BUSY_DETAIL =
  'A turn (AI chat or AI v2) is already in progress for this session; wait for it to finish before starting ' +
  'another. AI chat and AI v2 share one per-session slot by design.';
const AT_CAPACITY_DETAIL =
  'The server is at its AI turn concurrency limit (AI_CHAT_MAX_CONCURRENT, shared between AI chat and AI v2); ' +
  'try again shortly.';
const NOT_IMPLEMENTED_DETAIL =
  'AI v2 design turns are not implemented yet on this branch (guard chain only — tasks 2.3-2.8 pending).';

aiV2Router.post('/api/sessions/:sessionId/ai/v2/design', async (c) => {
  const sessionId = c.req.param('sessionId');

  // 2. Session resolution/scoping — 404 for nonexistent/deleted/out-of-studio.
  // Runs first (after the authContext 401 gate) so an unauthorized session is
  // masked as 404 before the config/credentials/single-flight state below can
  // leak (spec scenario "Unauthorized session is masked as 404": "whether or
  // not the feature is configured or a turn is in flight").
  await requireSession(c, sessionId);

  // 3. Configuration gate + open-network refusal + agent-credentials refusal
  // — all 503, before body parse and before any spawn (design D9, spec
  // "Configuration-gated AI v2 endpoints" / "Open-network refusal" /
  // "Agent credentials").
  if (!aiV2Configured(c.env.config)) {
    throw new ApiError(503, NOT_CONFIGURED_DETAIL);
  }
  if (aiV2OpenNetworkRefused(c.env.config)) {
    throw new ApiError(503, OPEN_NETWORK_DETAIL);
  }
  if (aiV2CredentialsRefused(c.env.config)) {
    throw new ApiError(503, CREDENTIALS_REFUSED_DETAIL);
  }

  // 4. Body validation — ZodError → 422, malformed JSON → 400 (both via the
  // global onError handler in app.ts), spawning nothing. c.req.json() throws
  // SyntaxError on malformed JSON.
  // The parsed body itself (message, optional resume id) is unused past
  // validation in this unit — tasks 2.3-2.8 own reading it to actually run a
  // turn. aiV2ApiKeyConfigured (env.ts) and aiV2MaxBudgetUsd (env.ts) are
  // likewise config accessors this unit exports for Unit C's consumption
  // (building the SDK's auth + maxBudgetUsd options) rather than something
  // this guard-only route needs to call itself.
  aiV2DesignRequestSchema.parse(await c.req.json());

  // 5. Turn slot — 409, shared with the AI chat's registry (see module
  // doc). Acquired for real so the guard-order tests above are genuine (a
  // slot already busy — from EITHER feature — 409s here, before body
  // validation would even matter), then released immediately: this unit
  // runs no actual turn to hold it across.
  const slot = aiChatTurns.tryAcquire(sessionId, aiChatMaxConcurrent(c.env.config));
  if (!slot.ok) {
    throw new ApiError(409, slot.reason === 'session-busy' ? SESSION_BUSY_DETAIL : AT_CAPACITY_DETAIL);
  }
  slot.release();

  // SPAWN BOUNDARY (see module doc): every guard has passed. Tasks 2.3-2.8
  // own the real SDK turn; this unit deliberately stops before it.
  throw new ApiError(501, NOT_IMPLEMENTED_DETAIL);
});
