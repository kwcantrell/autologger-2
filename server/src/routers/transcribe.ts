// Transcript words + topics — ported from web/routers/transcribe.py. Manual CRUD
// is backed by the session hub; transcript generation is env-gated on
// DEEPGRAM_API_KEY, returning a clean 503 that the frontend surfaces as a toast
// when unconfigured. topics/generate and the legacy transcribe.csv download
// remain intentionally unavailable on this deployment and always return 503.

import { Hono } from 'hono';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  aiChatConfigured,
  aiChatMaxConcurrent,
  aiChatOpenNetworkRefused,
  deepgramConfigured,
  deepgramModel,
  topicGenerateMaxBudgetUsd,
  topicGenerateTimeoutSec,
} from '../env';
import { mergeAudioSegments } from '../node/audioMerge';
import { DeepgramUpstreamError, transcribeGroup } from '../node/deepgram';
import type { TranscribeGroupResult } from '../node/deepgram';
import {
  recordingStartAnchors,
  remapTranscriptEnrichment,
  remapTranscriptWords,
} from '../node/transcriptRemap';
import type { EnrichmentGroup, SegmentAnchorInfo } from '../node/transcriptRemap';
import {
  topicCreateSchema,
  topicUpdateSchema,
  transcriptWordCreateSchema,
  transcriptWordUpdateSchema,
} from '../schemas';
import type { AppEnv } from '../types';
import { aiChatTurns } from './aiChatRegistry';
import { ApiError, getSessionHub, requireSession, timecodeCtx } from './_helpers';
import { generateTopicsTurn } from './topicGenerate';

export const transcribeRouter = new Hono<AppEnv>();

const UNAVAILABLE = 'Transcription is unavailable on this deployment.';

// ── Transcript generation (design: deepgram-transcription) ──────────────────

const GENERATION_IN_FLIGHT_DETAIL =
  'A transcript generation run is already in progress on this deployment; try again once it completes.';
const NO_AUDIO_DETAIL = 'This session has no recorded audio to transcribe.';
const ALL_UNREADABLE_DETAIL =
  "None of this session's recorded audio segments could be read for transcription.";
const NO_SPEECH_DETAIL =
  "DeepGram detected no speech in this session's audio; the existing transcript was left unchanged.";
const UPSTREAM_FAILURE_DETAIL = 'DeepGram transcription failed or timed out.';
const ABORTED_DETAIL =
  'Transcript generation request was aborted before transcription started; no provider request was made.';

/** DeepGram's documented pre-recorded upload limit (2 GB = 2×10⁹ bytes; design
 * D2 / the phase-1 spike's size-limit math — a 3h stereo PCM session is the
 * real case that crosses it). */
export const DEEPGRAM_MAX_GROUP_BYTES = 2_000_000_000;

function sizeLimitDetail(bytes: number): string {
  return `Combined audio for one codec group is ${bytes} bytes, over DeepGram's ${DEEPGRAM_MAX_GROUP_BYTES}-byte (2 GB) upload limit.`;
}

/** Pure predicate so the group-size cutoff is unit-testable without spooling
 * a real 2 GB file (design D2 / spike task 1.1's size-limit math). */
export function exceedsGroupSizeLimit(bytes: number): boolean {
  return bytes > DEEPGRAM_MAX_GROUP_BYTES;
}

export function enforceGroupSizeLimit(bytes: number): void {
  if (exceedsGroupSizeLimit(bytes)) {
    throw new ApiError(502, sizeLimitDetail(bytes));
  }
}

/** Single process-wide slot (design D9): at most one generation run at a
 * time, across every session — a stricter bound than "one per session", so a
 * plain module-level flag suffices without a per-session map. Cleared in the
 * route's `finally`, so it can never wedge true across requests. */
let generationInFlight = false;

// ── Legacy CSV download (transcription unavailable) ─────────────────────────────

transcribeRouter.get('/api/sessions/:sessionId/transcribe.csv', async (c) => {
  await requireSession(c, c.req.param('sessionId'));
  throw new ApiError(503, UNAVAILABLE);
});

// ── Transcript words ────────────────────────────────────────────────────────────

transcribeRouter.get('/api/sessions/:sessionId/transcript-words', async (c) => {
  const sessionId = c.req.param('sessionId');
  await requireSession(c, sessionId);
  const words = await getSessionHub(c, sessionId).listTranscriptWords();
  return c.json({ words: words.map((w) => ({ ...w, session_id: sessionId })) });
});

transcribeRouter.post('/api/sessions/:sessionId/transcript-words/generate', async (c) => {
  const sessionId = c.req.param('sessionId');
  const row = await requireSession(c, sessionId);

  if (!deepgramConfigured(c.env.config)) {
    throw new ApiError(503, UNAVAILABLE);
  }
  if (generationInFlight) {
    throw new ApiError(409, GENERATION_IN_FLIGHT_DETAIL);
  }
  generationInFlight = true;

  const blobStore = c.env.ports.audio;
  let scratchDir: string | null = null;
  try {
    const segments = await getSessionHub(c, sessionId).listAudioSegments();
    if (segments.length === 0) {
      throw new ApiError(400, NO_AUDIO_DETAIL);
    }

    scratchDir = await mkdtemp(join(blobStore.scratchRoot(), `${sessionId}-`));
    const inputPaths = segments.map((s) => blobStore.resolveKeyPath(s.r2_key));

    // Concat + probe is genuinely long disk I/O; no hub reference is held
    // across this await (each subsequent hub access below re-acquires via
    // getSessionHub — idle eviction may have closed the prior handle).
    const { groups } = await mergeAudioSegments(inputPaths, scratchDir);
    if (groups.length === 0) {
      throw new ApiError(400, ALL_UNREADABLE_DETAIL);
    }

    if (c.req.raw.signal?.aborted) {
      throw new ApiError(400, ABORTED_DETAIL);
    }

    const apiKey = c.env.config.DEEPGRAM_API_KEY;
    const model = deepgramModel(c.env.config);
    const enrichmentGroups: EnrichmentGroup[] = [];
    for (const group of groups) {
      const { size } = await stat(group.outPath);
      enforceGroupSizeLimit(size);
      if (c.req.raw.signal?.aborted) {
        throw new ApiError(400, ABORTED_DETAIL);
      }
      let result: TranscribeGroupResult;
      try {
        // The provider call itself: per spec, a client disconnect from here
        // on does NOT abandon the run — no abort-check after this point.
        result = await transcribeGroup({ outPath: group.outPath, family: group.family, apiKey, model });
      } catch (err) {
        if (err instanceof DeepgramUpstreamError) {
          throw new ApiError(502, UPSTREAM_FAILURE_DETAIL);
        }
        throw err;
      }
      // EnrichmentGroup extends GroupWords, so this same per-group array
      // feeds both remapTranscriptWords and remapTranscriptEnrichment below.
      enrichmentGroups.push({
        segments: group.segments,
        words: result.words,
        paragraphs: result.paragraphs,
        sentiments: result.sentiments,
      });
    }

    // Re-acquire the hub after the merge/provider awaits above.
    const events = await getSessionHub(c, sessionId).exportEvents();
    const anchors = recordingStartAnchors(events);
    const segmentInfo: SegmentAnchorInfo[] = segments.map((s, i) => ({
      path: inputPaths[i],
      ordinal: s.ordinal,
      recordingOrdinal: s.recording_ordinal,
    }));
    const remappedWords = remapTranscriptWords(enrichmentGroups, segmentInfo, anchors, timecodeCtx(row).frameRate);

    if (remappedWords.length === 0) {
      throw new ApiError(400, NO_SPEECH_DETAIL);
    }

    // Enrichment is remapped here, at the same point remapTranscriptWords ran
    // above — i.e. only after ALL groups' provider calls succeeded (design
    // D5/D10) — so a failed run persists neither words nor enrichment, and
    // its output's `{ paragraphs, sentiment }` shape matches the replace
    // RPC's enrichment param field-for-field (passed straight through).
    const remappedEnrichment = remapTranscriptEnrichment(enrichmentGroups, segmentInfo, anchors);

    // Replace only after ALL groups succeeded (design D5/D10) — a failed run
    // never reaches this call, so pre-existing words and enrichment are left
    // untouched. Words + enrichment go together in the one atomic RPC (no
    // second write path).
    const words = await getSessionHub(c, sessionId).replaceTranscriptWords(remappedWords, remappedEnrichment);
    return c.json({ words: words.map((w) => ({ ...w, session_id: sessionId })) });
  } finally {
    generationInFlight = false;
    if (scratchDir) await rm(scratchDir, { recursive: true, force: true });
  }
});

transcribeRouter.post('/api/sessions/:sessionId/transcript-words', async (c) => {
  const sessionId = c.req.param('sessionId');
  await requireSession(c, sessionId);
  const body = transcriptWordCreateSchema.parse(await c.req.json());
  const word = await getSessionHub(c, sessionId).insertTranscriptWord(body);
  return c.json({ ...word, session_id: sessionId }, 201);
});

transcribeRouter.patch('/api/sessions/:sessionId/transcript-words/:wordId', async (c) => {
  const sessionId = c.req.param('sessionId');
  await requireSession(c, sessionId);
  const body = transcriptWordUpdateSchema.parse(await c.req.json());
  const patch: { session_time?: string; speaker?: string; word?: string } = {};
  if (body.session_time != null) patch.session_time = body.session_time;
  if (body.speaker != null) patch.speaker = body.speaker;
  if (body.word != null) patch.word = body.word;
  const row = await getSessionHub(c, sessionId).updateTranscriptWord(c.req.param('wordId'), patch);
  if (row === null) throw new ApiError(404, 'Transcript word not found.');
  return c.json({ ...row, session_id: sessionId });
});

transcribeRouter.delete('/api/sessions/:sessionId/transcript-words/:wordId', async (c) => {
  const sessionId = c.req.param('sessionId');
  await requireSession(c, sessionId);
  const ok = await getSessionHub(c, sessionId).deleteTranscriptWord(c.req.param('wordId'));
  if (!ok) throw new ApiError(404, 'Transcript word not found.');
  return c.body(null, 204);
});

// ── Topics ───────────────────────────────────────────────────────────────────

transcribeRouter.get('/api/sessions/:sessionId/topics', async (c) => {
  const sessionId = c.req.param('sessionId');
  await requireSession(c, sessionId);
  return c.json({ topics: await getSessionHub(c, sessionId).listTopics() });
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
const NO_TRANSCRIPT_DETAIL =
  'This session has no transcript words to generate topics from.';
const TOPIC_GENERATE_SESSION_BUSY_DETAIL =
  'A turn (AI chat or topic generation) is already in progress for this session; wait for it to finish before ' +
  'generating topics again. AI chat and topic generation share one per-session slot by design.';
const TOPIC_GENERATE_AT_CAPACITY_DETAIL =
  'The server is at its AI turn concurrency limit (AI_CHAT_MAX_CONCURRENT, shared between AI chat and topic ' +
  'generation); try again shortly.';
// Fixed, handler-owned — never the CLI's raw output or its internal outcome
// token (design D3/spec "Failure mapping").
const TOPIC_GENERATE_FAILURE_DETAIL = 'Topic generation failed.';

transcribeRouter.post('/api/sessions/:sessionId/topics/generate', async (c) => {
  const sessionId = c.req.param('sessionId');
  await requireSession(c, sessionId);

  // Configuration gate + open-network refusal — both 503, before any spawn,
  // byte-identical unconfigured detail to the pre-change stub (task 1.1).
  if (!aiChatConfigured(c.env.config)) {
    throw new ApiError(503, UNAVAILABLE);
  }
  if (aiChatOpenNetworkRefused(c.env.config)) {
    throw new ApiError(503, TOPIC_GENERATE_OPEN_NETWORK_DETAIL);
  }

  // Transcript precondition (design D4) — 400 before any spawn.
  const transcriptWords = await getSessionHub(c, sessionId).listTranscriptWords();
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
      slot.reason === 'session-busy' ? TOPIC_GENERATE_SESSION_BUSY_DETAIL : TOPIC_GENERATE_AT_CAPACITY_DETAIL,
    );
  }

  try {
    // Record pre-run topic ids BEFORE the run (design D3's crash-safe swap):
    // nothing below ever mutates these topics until the atomic
    // delete-on-success.
    const preRunIds = new Set((await getSessionHub(c, sessionId).listTopics()).map((t) => t.id));

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
    const after = await hub.listTopics();
    const newIds = after.filter((t) => !preRunIds.has(t.id)).map((t) => t.id);

    if (outcome.ok && newIds.length >= 1) {
      // Success: delete the pre-run topics, leaving only the fresh set.
      await hub.deleteTopics([...preRunIds]);
      return c.json({ topics: await hub.listTopics() });
    }

    // Failure (turn error/timeout/CLI error, or a run that created no
    // topics): delete only the topics THIS run created — the pre-run topics
    // were never touched and remain exactly as they were.
    await hub.deleteTopics(newIds);
    // Operator-facing diagnostic: the `502` body is deliberately opaque to the
    // client (a fixed, non-sensitive string), but a self-hosted operator needs
    // the real reason to debug — an exceeded `--max-budget-usd` surfaces as the
    // outcome detail `upstream-failed`, a slow turn as `timeout`, an auth
    // problem as `not-logged-in`, and a turn that ran clean but made no topics
    // as `ok` with zero new topics. Logged to the server console only; never
    // the response.
    console.warn(
      `[topics/generate] session=${sessionId}: generation failed — ` +
        (outcome.ok
          ? 'CLI turn succeeded but created 0 topics'
          : `CLI turn failed (${outcome.detail})`),
    );
    throw new ApiError(502, TOPIC_GENERATE_FAILURE_DETAIL);
  } finally {
    slot.release();
  }
});

transcribeRouter.post('/api/sessions/:sessionId/topics', async (c) => {
  const sessionId = c.req.param('sessionId');
  await requireSession(c, sessionId);
  const body = topicCreateSchema.parse(await c.req.json());
  const topic = await getSessionHub(c, sessionId).insertTopic(body);
  return c.json(topic, 201);
});

transcribeRouter.patch('/api/sessions/:sessionId/topics/:topicId', async (c) => {
  const sessionId = c.req.param('sessionId');
  await requireSession(c, sessionId);
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
  const row = await getSessionHub(c, sessionId).updateTopic(c.req.param('topicId'), patch);
  if (row === null) throw new ApiError(404, 'Topic not found.');
  return c.json(row);
});

transcribeRouter.delete('/api/sessions/:sessionId/topics/:topicId', async (c) => {
  const sessionId = c.req.param('sessionId');
  await requireSession(c, sessionId);
  const ok = await getSessionHub(c, sessionId).deleteTopic(c.req.param('topicId'));
  if (!ok) throw new ApiError(404, 'Topic not found.');
  return c.body(null, 204);
});
