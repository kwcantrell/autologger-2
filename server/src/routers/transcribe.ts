// Transcript words + topics — ported from web/routers/transcribe.py. Manual CRUD
// is backed by the session hub; transcript generation is env-gated on
// DEEPGRAM_API_KEY, returning a clean 503 that the frontend surfaces as a toast
// when unconfigured. topics/generate and the legacy transcribe.csv download
// remain intentionally unavailable on this deployment and always return 503.

import { Hono } from 'hono';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { deepgramConfigured, deepgramModel } from '../env';
import { mergeAudioSegments } from '../node/audioMerge';
import { DeepgramUpstreamError, transcribeGroup } from '../node/deepgram';
import type { DeepgramWord } from '../node/deepgram';
import {
  recordingStartAnchors,
  remapTranscriptWords,
} from '../node/transcriptRemap';
import type { GroupWords, SegmentAnchorInfo } from '../node/transcriptRemap';
import {
  topicCreateSchema,
  topicUpdateSchema,
  transcriptWordCreateSchema,
  transcriptWordUpdateSchema,
} from '../schemas';
import type { AppEnv } from '../types';
import { ApiError, getSessionHub, requireSession, timecodeCtx } from './_helpers';

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
    const groupWords: GroupWords[] = [];
    for (const group of groups) {
      const { size } = await stat(group.outPath);
      enforceGroupSizeLimit(size);
      if (c.req.raw.signal?.aborted) {
        throw new ApiError(400, ABORTED_DETAIL);
      }
      let words: DeepgramWord[];
      try {
        // The provider call itself: per spec, a client disconnect from here
        // on does NOT abandon the run — no abort-check after this point.
        // Enrichment (paragraphs/sentiments) is captured by transcribeGroup
        // but not yet threaded through here — that's Phase 4 (task 4.2),
        // which will assemble remapped enrichment for the extended
        // atomic-replace RPC. Words remain the only piece wired today.
        ({ words } = await transcribeGroup({ outPath: group.outPath, family: group.family, apiKey, model }));
      } catch (err) {
        if (err instanceof DeepgramUpstreamError) {
          throw new ApiError(502, UPSTREAM_FAILURE_DETAIL);
        }
        throw err;
      }
      groupWords.push({ segments: group.segments, words });
    }

    // Re-acquire the hub after the merge/provider awaits above.
    const events = await getSessionHub(c, sessionId).exportEvents();
    const anchors = recordingStartAnchors(events);
    const segmentInfo: SegmentAnchorInfo[] = segments.map((s, i) => ({
      path: inputPaths[i],
      ordinal: s.ordinal,
      recordingOrdinal: s.recording_ordinal,
    }));
    const remapped = remapTranscriptWords(groupWords, segmentInfo, anchors, timecodeCtx(row).frameRate);

    if (remapped.length === 0) {
      throw new ApiError(400, NO_SPEECH_DETAIL);
    }

    // Replace only after ALL groups succeeded (design D5/D10) — a failed run
    // never reaches this call, so pre-existing words are left untouched.
    const words = await getSessionHub(c, sessionId).replaceTranscriptWords(remapped);
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

transcribeRouter.post('/api/sessions/:sessionId/topics/generate', async (c) => {
  await requireSession(c, c.req.param('sessionId'));
  throw new ApiError(503, UNAVAILABLE);
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
