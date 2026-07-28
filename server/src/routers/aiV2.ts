// ai-v2-dashboards — the design-turn endpoint (tasks 2.1/2.2 guard shell +
// 2.5/2.6 real streaming turn + 3.1/3.2/3.3 question round trip) and the
// answer endpoint (task 3.2). POST /api/sessions/:sessionId/ai/v2/design;
// POST /api/sessions/:sessionId/ai/v2/answer. New frozen API surface
// authorized by the ai-v2-dashboards delta spec (additive only — no
// existing route, shape, status code, or WS emission changes). The design
// route emits Server-Sent Events: `delta` (assistant text), `question`
// (a pending AskUserQuestion, addressed ONLY to this turn's own stream —
// never the session's WS fan-out, design D6), `dashboard` (task 5.4/5.5,
// design D10: a validated PROPOSED DashboardConfig, addressed ONLY to this
// turn's own stream — never the session's WS fan-out, same as `question`),
// `done` (terminal success), `error` ({ detail }, terminal failure) —
// `delta`/`question`/`dashboard` are never terminal; exactly one terminal
// event per completed stream. The answer route is a plain JSON POST (D6: the
// answer hop needs a client→server path SSE cannot provide), returning `{ ok:
// true }` on success or `{ detail }` on every rejection.
//
// Also: the dashboard persistence endpoints (task 5.2, spec "Dashboard
// persistence") — GET/PUT/DELETE /api/sessions/:sessionId/ai/v2/dashboard —
// defined near the bottom of this file, alongside their own doc comment. The
// `propose_dashboard` MCP tool (task 5.4) can also write through the SAME
// store (design D10), carrying its originating turn id, once the client
// chooses to persist a proposal it received on the `dashboard` event.
//
// Guard order (spec "Design turn contract"), matching the ai-chat sibling
// (./ai.ts) and the transcript-words/generate route: authentication
// (authContext middleware, 401) → session resolution/scoping (requireSession,
// 404 — masks an unauthorized session before configuration or in-flight
// state can leak, spec scenario "Unauthorized session is masked as 404") →
// principal-less (device-token / API_TOKEN) refusal (404, design D7,
// Phase-3 fix wave: "Authentication mechanisms that do not identify an
// individual principal SHALL NOT be accepted on these routes" — stated
// normatively rather than left emergent; masked as 404, NOT 401/403, same
// pattern as requireSession, so a device token learns nothing from the
// response) → configuration gate + open-network refusal + agent-credentials
// refusal (503, spec "Configuration-gated AI v2 endpoints" / "Open-network
// refusal" / "Agent credentials") → body validation (422 schema / 400
// malformed JSON, spec scenario "Invalid body rejected without side
// effects") → turn slot (409, spec "Spend and concurrency bounds" — shared
// with the AI chat's OWN registry BY DESIGN: "acquire a slot from the same
// registry the AI chat uses ... so per-session single-flight and the
// process-wide ceiling bound both features together rather than doubling
// the operator's exposure").
//
// SPAWN BOUNDARY: no guard-rejecting path reaches attemptDesignTurnSpawn
// (server/src/routers/aiV2SdkSpawn.ts) — the one call site that reaches the
// Agent SDK's `query()` (task 0.9). It is called ONLY after every guard has
// passed, inside the SSE stream body, strictly downstream of the slot
// acquisition — so "no guard path spawns a subprocess" holds. The turn's
// child process group is terminated and its concurrency slot released in the
// stream's `finally` on EVERY exit path (completion, error, timeout, client
// disconnect), so no orphan survives to keep spending the operator's
// credentials (spec "Subprocess and turn lifecycle"). Task 2.7 (Unit D)
// refines the slot-acquisition semantics; the option set, spawn override,
// kill ladder, SSE relay, and timeout backstop live in aiV2SdkSpawn.ts.

import type { Context } from 'hono';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { buildAggregateMcpServer } from '../aiV2/mcpTools';
import type { AuthUser } from '../db/catalog';
import {
  aiChatMaxConcurrent,
  aiChatTimeoutSec,
  aiV2ApiKey,
  aiV2Configured,
  aiV2CredentialsRefused,
  aiV2MaxBudgetUsd,
  aiV2OpenNetworkRefused,
} from '../env';
import { aiV2AnswerRequestSchema, aiV2DesignRequestSchema } from '../schemas';
import { DashboardBoundsError, DashboardValidationError } from '../session/SessionHub';
import type { AppEnv } from '../types';
import { aiChatTurns } from './aiChatRegistry';
import { aiV2PendingQuestions, buildPendingQuestionOnQuestion, generatePendingQuestionId } from './aiV2PendingQuestions';
import {
  attemptDesignTurnSpawn,
  buildDesignTurnCanUseTool,
  buildDesignTurnOptions,
  createDesignTurnSpawner,
  createDesignTurnWorkspace,
  prepareDesignTurnCredentials,
  runDesignTurn,
} from './aiV2SdkSpawn';
import { ApiError, getSessionHub, requireSession } from './_helpers';

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
// Task 3.2 (spec "Design question round trip", design D7). Deliberately the
// SAME detail for "no such pending question" and "wrong answering
// principal" — the route never reveals which reason applied, matching the
// session-masking pattern above (anti-enumeration: a caller with session
// access must not learn, from the response, whether a question exists for
// someone else's turn).
const ANSWER_NOT_FOUND_DETAIL =
  'No question is pending for this session, turn, and request. It may already have been answered or ' +
  'abandoned, the identifiers may be wrong, or only the principal who started the turn may answer its ' +
  'questions.';
// Same literal `requireSession` (_helpers.ts) throws for a nonexistent/
// out-of-studio session — reused here so a device token's principal-less
// refusal on /design is indistinguishable from an ordinary "no such
// session" 404 (design D7, Phase-3 fix wave).
const SESSION_NOT_FOUND_DETAIL = 'Session not found';

// Task 5.2 (spec "Dashboard persistence", design D5 ruled session DB). v1's
// UI (AiV2Panel) and its `DashboardPersistencePort` operate on exactly ONE
// dashboard per session (`load(sessionId)`/`save(sessionId, config)` — no
// dashboard id in that interface), so the route always addresses this single
// well-known slot. The underlying store (dashboardStore.ts) is more general
// (arbitrary caller-supplied ids, a genuine per-session COUNT bound) so a
// future multi-dashboard feature can reuse it without a storage migration.
const PRIMARY_DASHBOARD_ID = 'primary';

/**
 * Design D7 / Phase-3 fix wave: "Authentication mechanisms that do not
 * identify an individual principal SHALL NOT be accepted on these routes."
 * A shared `API_TOKEN` device token leaves `c.get('user') === null`
 * (`requireSession` deliberately skips the studio-membership check for it,
 * since that check is session-scoped, not principal-scoped — a device
 * token would otherwise pass for ANY session). Refused here, masked as 404
 * (never 401/403, which would leak that the session exists/is accessible)
 * — call this IMMEDIATELY after `requireSession` and BEFORE the
 * config/open-network/credentials 503 gate, so a device token learns
 * nothing about configuration or in-flight state either. Shared by BOTH
 * `/design` and `/answer` so the two routes cannot drift on this check.
 *
 * Deliberately gated on `apiTokenAuth` (set by the `authContext` middleware
 * from `requestHasValidApiToken`) rather than on `user === null` alone:
 * `user` is ALSO `null` for plain anonymous access with no credentials at
 * all (this repo's documented dev convention — "Dev auth is anonymous",
 * `REQUIRE_LOGIN=0`, no cookie, no token), which every earlier guard
 * (`aiV2OpenNetworkRefused` for a non-loopback bind, or the accepted
 * loopback/allowlisted-network trust boundary otherwise) already covers and
 * is NOT the vulnerability this fix closes — refusing it here too would
 * regress that existing, intentionally-permitted anonymous path. The actual
 * hole is specifically an authenticated-but-principal-less DEVICE token
 * bypassing per-user studio scoping, so only `user === null &&
 * apiTokenAuth` is refused.
 *
 * Returns the (possibly still-null, for the permitted anonymous case)
 * `AuthUser`; callers that need a guaranteed non-null principal (the answer
 * route, which has no legitimate anonymous-answer path) re-check.
 */
function requireIndividualPrincipal(c: Context<AppEnv>, notFoundDetail: string): AuthUser | null {
  const user = c.get('user');
  if (user === null && c.get('apiTokenAuth')) throw new ApiError(404, notFoundDetail);
  return user;
}

/**
 * code-health-tail 2.3 (finding 2.11): the shared route prologue every AI v2
 * route runs after the authContext middleware's 401 gate — previously five
 * hand-copied blocks. The ORDER is frozen behavior (spec "Design turn
 * contract") and identical for every route:
 *
 *   1. Session resolution/scoping — `requireSession`, 404. Masks a
 *      nonexistent/deleted/out-of-studio session BEFORE configuration or
 *      in-flight state can leak (spec scenario "Unauthorized session is
 *      masked as 404": "whether or not the feature is configured or a turn
 *      is in flight").
 *   2. Principal-less (device-token) refusal — `requireIndividualPrincipal`,
 *      404 with the caller's `notFoundDetail`, BEFORE any 503 gate so a
 *      device token learns nothing about configuration or in-flight state
 *      either (design D7, Phase-3 fix wave; see that helper's doc comment
 *      for why ONLY the device-token case is refused here).
 *   3. The 503 gate SET named by `gates` — a PARAMETER, deliberately NOT
 *      uniform across routes (fact-check S10):
 *      - 'design-turn' (/design, /answer): `aiV2Configured` +
 *        `aiV2OpenNetworkRefused` + `aiV2CredentialsRefused`, in that
 *        order — these routes lead to a turn that spends the operator's
 *        credentials, which is what the two refusal predicates exist for.
 *      - 'configured-only' (dashboard GET/PUT/DELETE): `aiV2Configured`
 *        ONLY. See the dashboard block comment below ("Deliberately NOT
 *        gated on aiV2OpenNetworkRefused/aiV2CredentialsRefused…") for why
 *        the CRUD routes must never inherit the other two gates.
 *
 * Returns the (possibly null, for the permitted anonymous case) principal —
 * the PUT dashboard route binds it for `createdBy`; the answer route
 * re-checks non-null for its own no-anonymous-answer rule (its step 6).
 */
async function guardAiV2Route(
  c: Context<AppEnv>,
  sessionId: string,
  notFoundDetail: string,
  gates: 'design-turn' | 'configured-only',
): Promise<AuthUser | null> {
  await requireSession(c, sessionId);
  const principal = requireIndividualPrincipal(c, notFoundDetail);
  if (!aiV2Configured(c.env.config)) {
    throw new ApiError(503, NOT_CONFIGURED_DETAIL);
  }
  if (gates === 'design-turn') {
    if (aiV2OpenNetworkRefused(c.env.config)) {
      throw new ApiError(503, OPEN_NETWORK_DETAIL);
    }
    if (aiV2CredentialsRefused(c.env.config)) {
      throw new ApiError(503, CREDENTIALS_REFUSED_DETAIL);
    }
  }
  return principal;
}

aiV2Router.post('/api/sessions/:sessionId/ai/v2/design', async (c) => {
  const sessionId = c.req.param('sessionId');

  // Steps 2-4 — the shared prologue (guardAiV2Route, full 'design-turn'
  // gate set): session scoping (404, masked before config/credentials/
  // single-flight state can leak) -> device-token refusal (404, masked
  // identically to requireSession's own "Session not found") -> config +
  // open-network + agent-credentials gates (all 503, before body parse and
  // before any spawn — design D7/D9, spec "Unauthorized session is masked
  // as 404" / "Configuration-gated AI v2 endpoints" / "Open-network
  // refusal" / "Agent credentials"). No guard below this line can ever run
  // for a device token.
  await guardAiV2Route(c, sessionId, SESSION_NOT_FOUND_DETAIL, 'design-turn');

  // 5. Body validation — ZodError → 422, malformed JSON → 400 (both via the
  // global onError handler in app.ts), spawning nothing. c.req.json() throws
  // SyntaxError on malformed JSON.
  const body = aiV2DesignRequestSchema.parse(await c.req.json());

  // 6. Turn slot — 409, shared with the AI chat's registry (see module doc).
  // Acquired BEFORE any spawn and held across the whole turn; released in the
  // stream's `finally` on every exit path (task 2.7 refines the acquisition
  // semantics; the hold-and-release lifecycle is real here).
  const slot = aiChatTurns.tryAcquire(sessionId, aiChatMaxConcurrent(c.env.config));
  if (!slot.ok) {
    throw new ApiError(409, slot.reason === 'session-busy' ? SESSION_BUSY_DETAIL : AT_CAPACITY_DETAIL);
  }

  // Every guard passed. Build the locked-down design turn (task 2.3's
  // closed-world option set), spawn it through the group-kill spawn override
  // (task 2.6), and relay its assistant text as SSE `delta`/`done`/`error`
  // events (task 2.5). The child group is terminated and the slot released on
  // EVERY exit path — completion, error, timeout, client disconnect — so no
  // orphan ever survives to keep spending the operator's credentials (spec
  // "Subprocess and turn lifecycle").
  const apiKey = aiV2ApiKey(c.env.config);
  const maxBudgetUsd = aiV2MaxBudgetUsd(c.env.config);
  const timeoutMs = aiChatTimeoutSec(c.env.config) * 1000;
  // Task 3.1/3.2 (spec "Design question round trip", design D7): a fresh
  // >=128-bit turn id, scoping this turn's pending questions so an answer's
  // (sessionId, turnId, requestId) triple can never resolve a DIFFERENT
  // turn's question, even one on the same session. The initiating PRINCIPAL
  // is recorded too, not just session access. `requireIndividualPrincipal`
  // above already refused the API_TOKEN/device-token case (`user === null
  // && apiTokenAuth`) with a 404 before this line, so THAT path can no
  // longer reach here principal-less (Phase-3 fix wave) — but `user` can
  // still legitimately be `null` for plain anonymous dev-mode access
  // (`REQUIRE_LOGIN=0`, no credentials at all; see the helper's doc
  // comment), which is why `principalUserId` keeps its `string | null`
  // type: a safe degraded state (the question simply times out via
  // abandonment, task 3.3), not a security bypass, per the registry's own
  // docs — a `null` principal can never equal any real answering user id.
  const turnId = generatePendingQuestionId();
  const principalUserId = c.get('user')?.id ?? null;

  return streamSSE(c, async (stream) => {
    const workspace = createDesignTurnWorkspace();
    const spawner = createDesignTurnSpawner();
    const abortController = new AbortController();
    try {
      prepareDesignTurnCredentials(workspace.configDir, apiKey || undefined);
      const options = buildDesignTurnOptions({
        cwd: workspace.cwd,
        configDir: workspace.configDir,
        apiKey: apiKey || undefined,
        maxBudgetUsd,
        mcpServer: buildAggregateMcpServer(sessionId, c.env.ports.sessions, {
          // Task 5.4/5.5 (design D10). The propose_dashboard tool has ALREADY
          // validated the whole config (the same validator a user write is
          // held to, ../aiV2/catalog.ts) before this callback ever runs — an
          // invalid/markup-bearing proposal never reaches here at all. Emits
          // a direct `stream.writeSSE` on THIS turn's own stream, exactly
          // mirroring the `question` event immediately below: independent of
          // runDesignTurn's guardedEmit/delta/done/error union, and never on
          // the session's WS fan-out (this callback has no reference to any
          // WS broadcast — the session hub's fan-out machinery is never
          // imported by this file).
          onProposeDashboard: async (config) => {
            try {
              // Fix wave (Phase 5 review, D5b completeness): carry this
              // turn's own id alongside the validated config — the same
              // `turnId` the `question` event already includes — so a
              // caller that later persists this proposal can supply it as
              // the PUT route's `?turnId=` and have `createdByTurnId`
              // actually populated (previously always null for the
              // proposal-persist path, since nothing upstream ever
              // supplied it).
              await stream.writeSSE({ event: 'dashboard', data: JSON.stringify({ config, turnId }) });
            } catch {
              // The client stream is gone. The agent already received an
              // "accepted" tool result (the proposal WAS validated), but
              // nothing further to do here — there is no fan-out to fall
              // back to, matching the question event's identical best-effort
              // write below.
            }
          },
        }),
        canUseTool: buildDesignTurnCanUseTool({
          onQuestion: buildPendingQuestionOnQuestion({
            sessionId,
            turnId,
            principalUserId,
            emitQuestion: async (payload) => {
              try {
                await stream.writeSSE({ event: 'question', data: JSON.stringify(payload) });
              } catch {
                // The client stream is gone; the abandonment path (client
                // disconnect/timeout, task 3.3) still resolves and deletes
                // the pending entry so it can't be answered late.
              }
            },
          }),
        }),
        abortController,
        spawnClaudeCodeProcess: spawner.spawnClaudeCodeProcess,
        // Test seam (task 6.2): `pathToClaudeCodeExecutable` (aiV2SdkSpawn.ts,
        // "Never set in production") wired from an env var so the hermetic
        // e2e server can point the SDK at the scripted fake agent
        // (server/src/test/fixtures/ai-v2-fake-agent.mjs) instead of the real
        // `claude` CLI. Unset in every real deployment — playwright.config.ts
        // is the only place that sets AI_V2_SDK_EXECUTABLE_PATH.
        pathToClaudeCodeExecutable: process.env.AI_V2_SDK_EXECUTABLE_PATH || undefined,
      });
      const turn = attemptDesignTurnSpawn(body.message, options);
      await runDesignTurn({
        query: turn,
        emit: async (event) => {
          await stream.writeSSE({ event: event.event, data: JSON.stringify(event.data) });
        },
        timeoutMs,
        abortController,
        abortSignal: c.req.raw.signal,
        terminate: spawner.terminate,
        release: slot.release,
        abandonPendingQuestions: () => aiV2PendingQuestions.abandonTurn(sessionId, turnId),
        // code-health-consolidation D3: the workspace (cwd + config-dir)
        // cleanup rides in the orchestrator's every-exit-path `onFinally`;
        // the idempotent call in the `finally` below stays as
        // defense-in-depth for setup failures before runDesignTurn ran.
        cleanupWorkspace: workspace.cleanup,
      });
    } catch {
      // Any unexpected failure BEFORE runDesignTurn took over (e.g. building
      // options or the synchronous spawn throwing) still owes the client
      // exactly one scrubbed terminal event — never the raw exception text.
      await stream.writeSSE({ event: 'error', data: JSON.stringify({ detail: 'internal-error' }) });
    } finally {
      // Defense-in-depth: runDesignTurn already terminates + releases +
      // abandons on the paths it controls, but if setup threw before it
      // ran, these idempotent calls guarantee no orphaned group, no leaked
      // slot, and no pending question left able to resolve late (task 3.3).
      await spawner.terminate();
      aiV2PendingQuestions.abandonTurn(sessionId, turnId);
      slot.release();
      workspace.cleanup();
    }
  });
});

// Task 3.2 — POST /api/sessions/:sessionId/ai/v2/answer. New frozen API
// surface authorized by this same delta (spec "Design question round trip":
// "Answers SHALL be submitted to a dedicated endpoint which SHALL evaluate
// the same guard chain as the design endpoint, masking an inaccessible
// session as 404"). Guard order matches the design route EXACTLY through
// body validation — auth (401) → session resolution/scoping (404) →
// principal-less (device-token) refusal (404, design D7, Phase-3 fix wave)
// → configuration/open-network/agent-credentials gate (503) → body
// validation (422/400) — then adds an ANSWER-SPECIFIC authz layer on top:
// the answering principal must be the SAME principal that initiated the
// turn, and the (sessionId, turnId, requestId) triple must name a question
// CURRENTLY pending (design D7). Never spawns a subprocess; never touches
// the shared turn-slot registry (that slot belongs to the design turn this
// answer unblocks, already held since that turn started).
aiV2Router.post('/api/sessions/:sessionId/ai/v2/answer', async (c) => {
  const sessionId = c.req.param('sessionId');

  // Steps 2-4 — the SAME shared prologue the design route runs (so the two
  // routes cannot drift), full 'design-turn' gate set, with the
  // ANSWER-specific masked detail: the device-token refusal (design D7:
  // "Authentication mechanisms that do not identify an individual principal
  // SHALL NOT be accepted on these routes" — a device token has no user id
  // and so can never equal the principal recorded when a turn's question
  // was posed, refused up front rather than left to fall out of the
  // `resolveAnswer` comparison below) uses the SAME ANSWER_NOT_FOUND_DETAIL
  // as "no matching pending question" so the response never reveals which
  // reason applied, and runs BEFORE the config/open-network gate so a
  // device token learns nothing about configuration either (Phase-3 fix
  // wave). NOTE: that refusal covers ONLY the device-token case (see
  // requireIndividualPrincipal's doc comment) — `user` may still
  // legitimately be `null` here for plain anonymous dev-mode access
  // (`REQUIRE_LOGIN=0`, no credentials at all), which is handled separately
  // at step 6 below, since it must still be allowed to reach the
  // config/body-validation gates first.
  await guardAiV2Route(c, sessionId, ANSWER_NOT_FOUND_DETAIL, 'design-turn');

  // 5. Body validation — ZodError → 422 (also rejects an 'option' answer
  // naming a widget type outside the closed catalog, since `widgetType` is
  // validated against the SAME enum dashboards are — spec "Previews reflect
  // the rendered result": "An option naming no catalog type is rejected"),
  // malformed JSON → 400 (both via the global onError handler in app.ts).
  const body = aiV2AnswerRequestSchema.parse(await c.req.json());

  // 6. The remaining principal-less case: plain anonymous access with no
  // credentials at all (`user === null`, `apiTokenAuth` false — step 3
  // above only refuses the DEVICE-TOKEN case). `resolveAnswer` needs a
  // concrete principal id to match against the turn's recorded initiator,
  // and no anonymous caller can ever legitimately equal it (a `null`
  // initiator, e.g. an anonymous `/design` turn, is itself unanswerable by
  // design — see aiV2PendingQuestions.ts), so this is refused with the
  // SAME masked detail rather than reaching `user.id` on a `null` value.
  const user = c.get('user');
  if (user === null) {
    throw new ApiError(404, ANSWER_NOT_FOUND_DETAIL);
  }

  // 7. Resolve the pending question. `resolveAnswer` itself enforces BOTH
  // the (sessionId, turnId, requestId) match AND the principal match,
  // returning the SAME 'not-found' outcome for either failure (see its
  // docstring) — a foreign id and a foreign principal are indistinguishable
  // from the response, and a late answer (the turn already ended and its
  // pending entries were abandoned — task 3.3) is rejected here too, since
  // there is nothing left to resolve.
  const outcome = aiV2PendingQuestions.resolveAnswer(
    { sessionId, turnId: body.turnId, requestId: body.requestId },
    user.id,
    body.answers,
  );
  if (outcome === 'not-found') {
    throw new ApiError(404, ANSWER_NOT_FOUND_DETAIL);
  }
  return c.json({ ok: true });
});

// ── Task 5.2 — dashboard persistence (spec "Dashboard persistence", design ──
// D5/D5a/D5b). GET/PUT/DELETE /api/sessions/:sessionId/ai/v2/dashboard. New
// frozen API surface authorized by this delta's "Dashboard persistence"
// requirement — additive only. Backs the web `DashboardPersistencePort`
// (dashboardPersistence.ts)'s `load(sessionId)`/`save(sessionId, config)`
// shape EXACTLY: the GET/PUT bodies ARE a bare `DashboardConfig`, never
// wrapped, so the fetch-backed implementation needs no shape beyond what
// catalog.ts already defines.
//
// Guard order — matches the design/answer routes through the config gate
// (the SAME shared prologue, guardAiV2Route, with the 'configured-only'
// gate set), then adds body validation on PUT:
//   auth (401, global authContext middleware)
//   -> session resolution/scoping (404, requireSession — READ is scoped
//      EXACTLY as the session; WRITE/DELETE reuse the identical check, so
//      they are scoped AT LEAST as tightly, spec "Dashboard persistence":
//      "Reading SHALL be scoped exactly as the session... Writing SHALL be
//      scoped at least as tightly")
//   -> principal-less (device-token) refusal (404, requireIndividualPrincipal
//      — the SAME helper the design/answer routes use, masked identically)
//   -> AI v2 configuration gate (503, spec "Configuration-gated AI v2
//      endpoints": "every AI v2 route SHALL respond 503" when unconfigured —
//      stated with no carve-out for persistence, so this new surface is
//      gated exactly like design/answer)
//   -> whole-config validation (422, PUT only, via validateDashboardConfig
//      inside DashboardStore.saveDashboard — the SAME function the design
//      route's future propose_dashboard tool, task 5.4, will also call) and
//      the per-session dashboard-count bound (422, same store call)
//   -> store operation.
//
// Deliberately NOT gated on aiV2OpenNetworkRefused/aiV2CredentialsRefused:
// both exist because "a design turn spends the operator's credentials" over
// a paid external API call (spec "Open-network refusal" / "Agent
// credentials"). A dashboard CRUD operation never spawns a subprocess or
// spends anything — gating it on those two would block a user's OWN
// direct-manipulation edits (spec "Dashboards are edited directly, not only
// by conversation") for a reason that doesn't apply to them. Flagged
// explicitly in this task's report for gate review.
aiV2Router.get('/api/sessions/:sessionId/ai/v2/dashboard', async (c) => {
  const sessionId = c.req.param('sessionId');
  await guardAiV2Route(c, sessionId, SESSION_NOT_FOUND_DETAIL, 'configured-only');
  const hub = getSessionHub(c, sessionId);
  const stored = hub.getDashboard(PRIMARY_DASHBOARD_ID);
  // `config: null` means "no dashboard saved yet" (never a fabricated empty
  // dashboard) — matches the port's own doc comment on `load()`.
  return c.json({ config: stored ? stored.config : null });
});

aiV2Router.put('/api/sessions/:sessionId/ai/v2/dashboard', async (c) => {
  const sessionId = c.req.param('sessionId');
  // The one route that BINDS the prologue's returned principal — recorded
  // as `createdBy` on the write below.
  const principal = await guardAiV2Route(c, sessionId, SESSION_NOT_FOUND_DETAIL, 'configured-only');
  // Malformed JSON -> 400 via the global onError handler (c.req.json() throws
  // SyntaxError), same as the design/answer routes.
  const body = await c.req.json();
  // Optional provenance for a write that originates from a design turn's
  // committed proposal (task 5.4/5.5, wired: the port's `save(sessionId,
  // config, turnId?)` carries it, `AiV2Panel.keepProposedDashboard` passes
  // the proposal's originating turnId, and the `dashboard` SSE event is the
  // source of that turnId). A direct-manipulation save (`handleDashboardChange`)
  // or a "Start blank" save never has one, so those calls omit this and the
  // write records createdByTurnId: null. Carried out-of-band (query param,
  // not a body field) so this route never needs a second config-shaped
  // schema alongside `validateDashboardConfig`.
  const turnIdRaw = c.req.query('turnId');
  const turnId = turnIdRaw && turnIdRaw.trim() ? turnIdRaw.trim().slice(0, 64) : null;

  const hub = getSessionHub(c, sessionId);
  let stored: ReturnType<typeof hub.saveDashboard>;
  try {
    stored = hub.saveDashboard({
      id: PRIMARY_DASHBOARD_ID,
      config: body,
      createdBy: principal?.id ?? null,
      createdByTurnId: turnId,
    });
  } catch (err) {
    if (err instanceof DashboardValidationError || err instanceof DashboardBoundsError) {
      throw new ApiError(422, err.message);
    }
    throw err;
  }
  return c.json({ config: stored.config });
});

aiV2Router.delete('/api/sessions/:sessionId/ai/v2/dashboard', async (c) => {
  const sessionId = c.req.param('sessionId');
  await guardAiV2Route(c, sessionId, SESSION_NOT_FOUND_DETAIL, 'configured-only');
  const hub = getSessionHub(c, sessionId);
  hub.deleteDashboard(PRIMARY_DASHBOARD_ID);
  return c.json({ ok: true });
});
