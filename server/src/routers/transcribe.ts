// Transcript words + topics — ported from web/routers/transcribe.py. Manual CRUD
// is backed by the session hub; transcript generation is env-gated on
// DEEPGRAM_API_KEY, returning a clean 503 that the frontend surfaces as a toast
// when unconfigured. topics/generate is likewise configuration-gated (503 unless
// CLAUDE_CLI_PATH is set): configured, it runs a one-shot CLI turn via
// generateTopicsTurn (topic-generation change) — a paid-spend endpoint. The
// legacy transcribe.csv download remains intentionally unavailable on this
// deployment and always returns 503.

import type { Context } from 'hono';
import { Hono } from 'hono';
import {
  aiChatConfigured,
  aiChatMaxConcurrent,
  aiChatOpenNetworkRefused,
  deepgramConfigured,
  topicGenerateMaxBudgetUsd,
  topicGenerateTimeoutSec,
} from '../env';
import {
  DEEPGRAM_MAX_GROUP_BYTES,
  exceedsGroupSizeLimit,
  GENERATION_IN_FLIGHT_DETAIL,
  generateTranscriptWords,
  TRANSCRIPT_UNAVAILABLE,
  TranscriptGenerateError,
} from '../node/generateTranscript';
import { transcriptGenerationLock } from '../node/transcriptGenerationLock';
import {
  topicCreateSchema,
  topicUpdateSchema,
  transcriptWordCreateSchema,
  transcriptWordUpdateSchema,
} from '../schemas';
import type { AppEnv } from '../types';
import { ApiError, getSessionHub, requireSession, timecodeCtx } from './_helpers';
import { aiChatTurns } from './aiChatRegistry';
import { allTranscriptPagesServed } from './aiMcpServer';
import { generateTopicsTurn } from './topicGenerate';

export const transcribeRouter = new Hono<AppEnv>();

const UNAVAILABLE = TRANSCRIPT_UNAVAILABLE;

// Re-export for existing tests that import the size-limit helpers from this module.
export { DEEPGRAM_MAX_GROUP_BYTES, exceedsGroupSizeLimit };

export function enforceGroupSizeLimit(bytes: number): void {
  if (exceedsGroupSizeLimit(bytes)) {
    throw new ApiError(
      502,
      `Combined audio for one codec group is ${bytes} bytes, over DeepGram's ${DEEPGRAM_MAX_GROUP_BYTES}-byte (2 GB) upload limit.`,
    );
  }
}

function mapGenerateError(err: unknown): never {
  if (err instanceof TranscriptGenerateError) {
    const status =
      err.code === 'unavailable'
        ? 503
        : err.code === 'in_flight'
          ? 409
          : err.code === 'upstream' || err.code === 'oversize'
            ? 502
            : 400;
    throw new ApiError(status, err.message);
  }
  throw err;
}

function resolveCatalogSessionTitle(
  catalog: AppEnv['Variables']['catalog'],
  sessionId: string,
): string | null {
  const row = catalog.sessions.getSessionIndexRow(sessionId);
  if (row === null) return null;
  return String(row.title ?? '');
}

/** Whether the requester may see the lock holder's session identifiers.
 * Mirrors `requireSession`'s studio-membership scope exactly (including the
 * dev-anonymous `user === null` case, which sees everything on every sibling
 * route): a logged-in non-member gets the busy-ness fact but never the
 * holder's session id or title — the same existence/title oracle sibling
 * routes close by 404ing non-members. */
function requesterCanViewSession(c: Context<AppEnv>, sessionId: string): boolean {
  const user = c.get('user');
  if (user === null) return true;
  const catalog = c.get('catalog');
  const studioId = catalog.sessions.getSessionStudioId(sessionId);
  return studioId !== null && catalog.auth.authUserHasStudio(user.id, studioId);
}

// ── Transcript generation lock status (transcript-gen-lock-status) ───────────

transcribeRouter.get('/api/transcript-generation/status', async (c) => {
  const holder = transcriptGenerationLock.getLock();
  if (holder === null) {
    return c.json({ in_flight: false });
  }
  // Cross-tenant redaction: the lock is process-wide, so the holder may belong
  // to a studio the requester is not a member of. Busy-ness stays truthful;
  // the identifiers are nulled (same key set, null values, never absent keys).
  const visible = requesterCanViewSession(c, holder.sessionId);
  return c.json({
    in_flight: true,
    session_id: visible ? holder.sessionId : null,
    session_title: visible ? resolveCatalogSessionTitle(c.get('catalog'), holder.sessionId) : null,
    started_at: new Date(holder.startedAtMs).toISOString(),
  });
});

// ── Legacy CSV download (transcription unavailable) ─────────────────────────────

transcribeRouter.get('/api/sessions/:sessionId/transcribe.csv', async (c) => {
  requireSession(c, c.req.param('sessionId'));
  throw new ApiError(503, UNAVAILABLE);
});

// ── Transcript words ────────────────────────────────────────────────────────────

transcribeRouter.get('/api/sessions/:sessionId/transcript-words', async (c) => {
  const sessionId = c.req.param('sessionId');
  requireSession(c, sessionId);
  const words = getSessionHub(c, sessionId).listTranscriptWords();
  return c.json({ words: words.map((w) => ({ ...w, session_id: sessionId })) });
});

transcribeRouter.post('/api/sessions/:sessionId/transcript-words/generate', async (c) => {
  const sessionId = c.req.param('sessionId');
  const row = requireSession(c, sessionId);

  if (!deepgramConfigured(c.env.config)) {
    throw new ApiError(503, UNAVAILABLE);
  }

  try {
    const words = await generateTranscriptWords({
      config: c.env.config,
      audio: c.env.ports.audio,
      getHub: () => getSessionHub(c, sessionId),
      ctx: timecodeCtx(row),
      sessionId,
      signal: c.req.raw.signal,
      resolveSessionTitle: (id) => resolveCatalogSessionTitle(c.get('catalog'), id),
    });
    return c.json({ words: words.map((w) => ({ ...w, session_id: sessionId })) });
  } catch (err) {
    // Cross-tenant redaction on the enriched 409: the in-flight detail names
    // the HOLDER's session (title or id), which may belong to a studio the
    // requester is not a member of. Swap in the identifier-free generic
    // detail for non-members (and for the rare race where the holder released
    // between the failed acquire and this catch, leaving nothing to check
    // membership against). Same 409 status either way.
    if (err instanceof TranscriptGenerateError && err.code === 'in_flight') {
      const holder = transcriptGenerationLock.getLock();
      if (holder === null || !requesterCanViewSession(c, holder.sessionId)) {
        throw new ApiError(409, GENERATION_IN_FLIGHT_DETAIL);
      }
    }
    mapGenerateError(err);
  }
});

transcribeRouter.post('/api/sessions/:sessionId/transcript-words', async (c) => {
  const sessionId = c.req.param('sessionId');
  requireSession(c, sessionId);
  const body = transcriptWordCreateSchema.parse(await c.req.json());
  const word = getSessionHub(c, sessionId).insertTranscriptWord(body);
  return c.json({ ...word, session_id: sessionId }, 201);
});

transcribeRouter.patch('/api/sessions/:sessionId/transcript-words/:wordId', async (c) => {
  const sessionId = c.req.param('sessionId');
  requireSession(c, sessionId);
  const body = transcriptWordUpdateSchema.parse(await c.req.json());
  const patch: { session_time?: string; speaker?: string; word?: string } = {};
  if (body.session_time != null) patch.session_time = body.session_time;
  if (body.speaker != null) patch.speaker = body.speaker;
  if (body.word != null) patch.word = body.word;
  const row = getSessionHub(c, sessionId).updateTranscriptWord(c.req.param('wordId'), patch);
  if (row === null) throw new ApiError(404, 'Transcript word not found.');
  return c.json({ ...row, session_id: sessionId });
});

transcribeRouter.delete('/api/sessions/:sessionId/transcript-words/:wordId', async (c) => {
  const sessionId = c.req.param('sessionId');
  requireSession(c, sessionId);
  const ok = getSessionHub(c, sessionId).deleteTranscriptWord(c.req.param('wordId'));
  if (!ok) throw new ApiError(404, 'Transcript word not found.');
  return c.body(null, 204);
});

// ── Topics ───────────────────────────────────────────────────────────────────

transcribeRouter.get('/api/sessions/:sessionId/topics', async (c) => {
  const sessionId = c.req.param('sessionId');
  requireSession(c, sessionId);
  return c.json({ topics: getSessionHub(c, sessionId).listTopics() });
});

// ── Topic generation (topic-generation, design D1-D7) ───────────────────────
// Reuses the AI chat's CLI/MCP lockdown + gate + turn registry (env.ts "Topic
// generation" section) for a one-shot, non-conversational generate turn
// (`generateTopicsTurn`, task 2.3) run to completion server-side (design D2 —
// no SSE, no abortSignal). The `aiChatTurns` slot is acquired HERE (not inside
// `generateTopicsTurn`) and released in this handler's own `finally`, mirroring
// `ai.ts`'s per-endpoint slot lifecycle (409 wording is generate-specific).

const TOPIC_GENERATE_OPEN_NETWORK_DETAIL =
  'Topic generation is refused: the server is bound to a non-loopback address with REQUIRE_LOGIN disabled and no ' +
  'IP_ALLOWLIST. Enable login, set an IP_ALLOWLIST, or bind to loopback (HOST=127.0.0.1) before using a paid AI endpoint.';
const NO_TRANSCRIPT_DETAIL = 'This session has no transcript words to generate topics from.';
// Names EVERY possible slot holder (the registry is shared with AI chat,
// AI v2, and event generation; wording change authorized by the
// auto-event-generation delta).
const TOPIC_GENERATE_SESSION_BUSY_DETAIL =
  'A turn (AI chat, AI v2, topic generation, or event generation) is already in progress for this session; ' +
  'wait for it to finish before generating topics again. These features share one per-session AI slot by design.';
const TOPIC_GENERATE_AT_CAPACITY_DETAIL =
  'The server is at its AI turn concurrency limit (AI_CHAT_MAX_CONCURRENT, shared between AI chat, AI v2, ' +
  'topic generation, and event generation); try again shortly.';
// Fixed, handler-owned — never the CLI's raw output or its internal outcome
// token (design D3/spec "Failure mapping").
const TOPIC_GENERATE_FAILURE_DETAIL = 'Topic generation failed.';

transcribeRouter.post('/api/sessions/:sessionId/topics/generate', async (c) => {
  const sessionId = c.req.param('sessionId');
  requireSession(c, sessionId);

  // Configuration gate + open-network refusal — both 503, before any spawn,
  // byte-identical unconfigured detail to the pre-change stub (task 1.1).
  if (!aiChatConfigured(c.env.config)) {
    throw new ApiError(503, UNAVAILABLE);
  }
  if (aiChatOpenNetworkRefused(c.env.config)) {
    throw new ApiError(503, TOPIC_GENERATE_OPEN_NETWORK_DETAIL);
  }

  // Transcript precondition (design D4) — 400 before any spawn.
  const transcriptWords = getSessionHub(c, sessionId).listTranscriptWords();
  if (transcriptWords.length === 0) {
    throw new ApiError(400, NO_TRANSCRIPT_DETAIL);
  }

  // Single-flight (per session) + process-wide concurrency ceiling — 409,
  // spawning nothing. Acquired here (not inside generateTopicsTurn) and
  // released in this handler's own finally.
  const slot = aiChatTurns.tryAcquire(sessionId, aiChatMaxConcurrent(c.env.config));
  if (!slot.ok) {
    throw new ApiError(
      409,
      slot.reason === 'session-busy'
        ? TOPIC_GENERATE_SESSION_BUSY_DETAIL
        : TOPIC_GENERATE_AT_CAPACITY_DETAIL,
    );
  }

  try {
    // Record pre-run topic ids BEFORE the run (design D3's crash-safe swap):
    // nothing below ever mutates these topics until the atomic
    // delete-on-success.
    const preRunIds = new Set(
      getSessionHub(c, sessionId)
        .listTopics()
        .map((t) => t.id),
    );

    const outcome = await generateTopicsTurn({
      registry: c.env.ports.sessions,
      cliPath: c.env.config.CLAUDE_CLI_PATH.trim(),
      sessionId,
      maxBudgetUsd: topicGenerateMaxBudgetUsd(c.env.config),
      timeoutMs: topicGenerateTimeoutSec(c.env.config) * 1000,
    });

    // Re-acquire the hub after the async, potentially multi-minute turn
    // above — the idle sweeper may have closed the prior handle in the
    // meantime (invariant: hubs close their DB handles and reopen lazily).
    const hub = getSessionHub(c, sessionId);
    const after = hub.listTopics();
    const newIds = after.filter((t) => !preRunIds.has(t.id)).map((t) => t.id);

    // Page-coverage gate (topic-generate-paged-transcript D6): a run that
    // created topics from only SOME of its transcript pages must not replace
    // a full-session topic set with partial-coverage ones — a corruption
    // strictly less detectable than the oversized-payload bug paging fixes.
    // This is the server's own bookkeeping (it served the pages), never
    // model-output inference; a turn whose registration carried no word
    // snapshot claims no coverage and cannot fail here.
    const fullyRead = allTranscriptPagesServed(outcome.pageCoverage);

    if (outcome.ok && newIds.length >= 1 && fullyRead) {
      // Success: delete the pre-run topics, leaving only the fresh set.
      hub.deleteTopics([...preRunIds]);
      return c.json({ topics: hub.listTopics() });
    }

    // Failure (turn error/timeout/CLI error, a run that created no topics, or
    // one that never read the whole transcript): delete only the topics THIS
    // run created — the pre-run topics were never touched and remain exactly
    // as they were. Same status, same body as every other failure cause.
    hub.deleteTopics(newIds);
    // Operator-facing diagnostic: the `502` body is deliberately opaque to the
    // client (a fixed, non-sensitive string), but a self-hosted operator needs
    // the real reason to debug — an exceeded `--max-budget-usd` surfaces as the
    // outcome detail `upstream-failed`, a slow turn as `timeout`, an auth
    // problem as `not-logged-in`, a turn that ran clean but made no topics
    // as `ok` with zero new topics, and a model that stopped reading pages
    // early as incomplete page coverage. Logged to the server console only;
    // never the response.
    console.warn(
      `[topics/generate] session=${sessionId}: generation failed — ` +
        (!outcome.ok
          ? `CLI turn failed (${outcome.detail})`
          : newIds.length === 0
            ? 'CLI turn succeeded but created 0 topics'
            : `CLI turn created ${newIds.length} topic(s) after reading only ` +
              `${outcome.pageCoverage.servedPages} of ${outcome.pageCoverage.totalPages} ` +
              'transcript page(s)'),
    );
    throw new ApiError(502, TOPIC_GENERATE_FAILURE_DETAIL);
  } finally {
    slot.release();
  }
});

transcribeRouter.post('/api/sessions/:sessionId/topics', async (c) => {
  const sessionId = c.req.param('sessionId');
  requireSession(c, sessionId);
  const body = topicCreateSchema.parse(await c.req.json());
  const topic = getSessionHub(c, sessionId).insertTopic(body);
  return c.json(topic, 201);
});

transcribeRouter.patch('/api/sessions/:sessionId/topics/:topicId', async (c) => {
  const sessionId = c.req.param('sessionId');
  requireSession(c, sessionId);
  const body = topicUpdateSchema.parse(await c.req.json());
  const patch: {
    session_time?: string;
    duration_sec?: number;
    topic_level?: number;
    summary?: string;
  } = {};
  if (body.session_time != null) patch.session_time = body.session_time;
  if (body.duration_sec != null) patch.duration_sec = body.duration_sec;
  if (body.topic_level != null) patch.topic_level = body.topic_level;
  if (body.summary != null) patch.summary = body.summary;
  const row = getSessionHub(c, sessionId).updateTopic(c.req.param('topicId'), patch);
  if (row === null) throw new ApiError(404, 'Topic not found.');
  return c.json(row);
});

transcribeRouter.delete('/api/sessions/:sessionId/topics/:topicId', async (c) => {
  const sessionId = c.req.param('sessionId');
  requireSession(c, sessionId);
  const ok = getSessionHub(c, sessionId).deleteTopic(c.req.param('topicId'));
  if (!ok) throw new ApiError(404, 'Topic not found.');
  return c.body(null, 204);
});
