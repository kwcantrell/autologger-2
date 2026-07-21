// ai-v2-dashboards — the design-turn endpoint (tasks 2.1/2.2 guard shell +
// 2.5/2.6 real streaming turn + 3.1/3.2/3.3 question round trip) and the
// answer endpoint (task 3.2). POST /api/sessions/:sessionId/ai/v2/design;
// POST /api/sessions/:sessionId/ai/v2/answer. New frozen API surface
// authorized by the ai-v2-dashboards delta spec (additive only — no
// existing route, shape, status code, or WS emission changes). The design
// route emits Server-Sent Events: `delta` (assistant text), `question`
// (a pending AskUserQuestion, addressed ONLY to this turn's own stream —
// never the session's WS fan-out, design D6), `done` (terminal success),
// `error` ({ detail }, terminal failure) — exactly one terminal event per
// completed stream. The answer route is a plain JSON POST (D6: the answer
// hop needs a client→server path SSE cannot provide), returning `{ ok:
// true }` on success or `{ detail }` on every rejection.
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

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { buildAggregateMcpServer } from '../aiV2/mcpTools';
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
  const body = aiV2DesignRequestSchema.parse(await c.req.json());

  // 5. Turn slot — 409, shared with the AI chat's registry (see module doc).
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
  // turn's question, even one on the same session. The initiating
  // PRINCIPAL is recorded too, not just session access — `user` is null
  // only for the API_TOKEN/device-token auth path (requireSession above
  // deliberately skips the studio check for it), which then can never
  // answer any question this turn asks (see the /answer route below): a
  // safe degraded state (the question simply times out via abandonment,
  // task 3.3), not a security bypass.
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
        mcpServer: buildAggregateMcpServer(sessionId, c.env.ports.sessions),
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
// configuration/open-network/agent-credentials gate (503) → body
// validation (422/400) — then adds an ANSWER-SPECIFIC authz layer on top:
// the answering principal must be the SAME principal that initiated the
// turn, and the (sessionId, turnId, requestId) triple must name a question
// CURRENTLY pending (design D7). Never spawns a subprocess; never touches
// the shared turn-slot registry (that slot belongs to the design turn this
// answer unblocks, already held since that turn started).
aiV2Router.post('/api/sessions/:sessionId/ai/v2/answer', async (c) => {
  const sessionId = c.req.param('sessionId');

  // 2. Session resolution/scoping — 404, identical to the design route.
  await requireSession(c, sessionId);

  // 3. Configuration gate + open-network refusal + agent-credentials
  // refusal — all 503, identical to the design route.
  if (!aiV2Configured(c.env.config)) {
    throw new ApiError(503, NOT_CONFIGURED_DETAIL);
  }
  if (aiV2OpenNetworkRefused(c.env.config)) {
    throw new ApiError(503, OPEN_NETWORK_DETAIL);
  }
  if (aiV2CredentialsRefused(c.env.config)) {
    throw new ApiError(503, CREDENTIALS_REFUSED_DETAIL);
  }

  // 4. Body validation — ZodError → 422 (also rejects an 'option' answer
  // naming a widget type outside the closed catalog, since `widgetType` is
  // validated against the SAME enum dashboards are — spec "Previews reflect
  // the rendered result": "An option naming no catalog type is rejected"),
  // malformed JSON → 400 (both via the global onError handler in app.ts).
  const body = aiV2AnswerRequestSchema.parse(await c.req.json());

  // 5. Principal check (design D7): "Authentication mechanisms that do not
  // identify an individual principal SHALL NOT be accepted on these
  // routes." `user` is null ONLY for the API_TOKEN/device-token path
  // (requireSession above deliberately skips the studio check for it,
  // since that check is session-scoped, not principal-scoped) — a device
  // token has no user id and so can never equal the principal recorded
  // when a turn's question was posed. Refused explicitly and up front,
  // stated normatively rather than left to fall out of the comparison
  // below, and folded into the SAME 404 as "no matching pending question"
  // so the response never reveals which reason applied.
  const user = c.get('user');
  if (user === null) {
    throw new ApiError(404, ANSWER_NOT_FOUND_DETAIL);
  }

  // 6. Resolve the pending question. `resolveAnswer` itself enforces BOTH
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
