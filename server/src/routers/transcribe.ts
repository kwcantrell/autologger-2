// Transcript words + topics — ported from web/routers/transcribe.py. Manual CRUD
// is backed by the session hub; transcript generation and the legacy CSV
// download are unavailable on this deployment, so they return a clean 503 that the
// frontend surfaces as a toast (phase 6 decision — no transcription integration).

import { Hono } from 'hono';
import {
  topicCreateSchema,
  topicUpdateSchema,
  transcriptWordCreateSchema,
  transcriptWordUpdateSchema,
} from '../schemas';
import type { AppEnv } from '../types';
import { ApiError, getSessionHub, requireSession } from './_helpers';

export const transcribeRouter = new Hono<AppEnv>();

const UNAVAILABLE = 'Transcription is unavailable on this deployment.';

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
  await requireSession(c, c.req.param('sessionId'));
  throw new ApiError(503, UNAVAILABLE);
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
