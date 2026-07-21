import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, env, envWith } from '../test/harness';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { seedSession, seedShow, seedStudio } from '../test/helpers';

async function seededSession(): Promise<string> {
  const studio = await seedStudio();
  const show = await seedShow({ studioId: studio });
  return seedSession({ showId: show });
}
const J = { 'content-type': 'application/json' };

describe('unavailable endpoints (503)', () => {
  it('transcribe.csv, transcript-words/generate, topics/generate are 503', async () => {
    const s = await seededSession();
    for (const path of [
      `/api/sessions/${s}/transcribe.csv`,
      `/api/sessions/${s}/transcript-words/generate`,
      `/api/sessions/${s}/topics/generate`,
    ]) {
      const method = path.endsWith('.csv') ? 'GET' : 'POST';
      const res = await app.request(path, { method }, { ...env });
      expect(res.status).toBe(503);
    }
  });

  it('unconfigured generate is byte-identical to the pre-change frozen response', async () => {
    const s = await seededSession();
    const res = await app.request(
      `/api/sessions/${s}/transcript-words/generate`,
      { method: 'POST' },
      { ...env }, // DEEPGRAM_API_KEY unset in the base test env
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      detail: 'Transcription is unavailable on this deployment.',
    });
  });
});

describe('transcript-words CRUD', () => {
  it('create → list → patch → delete', async () => {
    const s = await seededSession();
    const create = await app.request(
      `/api/sessions/${s}/transcript-words`,
      { method: 'POST', headers: J, body: JSON.stringify({ speaker: 'Host', word: 'hello' }) },
      { ...env },
    );
    expect(create.status).toBe(201);
    const wordId = ((await create.json()) as { id: string }).id;

    const list = await app.request(
      `/api/sessions/${s}/transcript-words`,
      { method: 'GET' },
      { ...env },
    );
    expect(((await list.json()) as { words: unknown[] }).words.length).toBe(1);

    const patch = await app.request(
      `/api/sessions/${s}/transcript-words/${wordId}`,
      { method: 'PATCH', headers: J, body: JSON.stringify({ word: 'world' }) },
      { ...env },
    );
    expect(patch.status).toBe(200);
    expect(((await patch.json()) as { word: string }).word).toBe('world');

    const del = await app.request(
      `/api/sessions/${s}/transcript-words/${wordId}`,
      { method: 'DELETE' },
      { ...env },
    );
    expect(del.status).toBe(204);
  });

  it('404 patching an unknown word', async () => {
    const s = await seededSession();
    const res = await app.request(
      `/api/sessions/${s}/transcript-words/nope`,
      { method: 'PATCH', headers: J, body: JSON.stringify({ word: 'x' }) },
      { ...env },
    );
    expect(res.status).toBe(404);
  });
});

describe('topics CRUD', () => {
  it('create → list → patch → delete', async () => {
    const s = await seededSession();
    const create = await app.request(
      `/api/sessions/${s}/topics`,
      { method: 'POST', headers: J, body: JSON.stringify({ summary: 'Intro', topic_level: 1 }) },
      { ...env },
    );
    expect(create.status).toBe(201);
    const topicId = ((await create.json()) as { id: string }).id;

    const list = await app.request(`/api/sessions/${s}/topics`, { method: 'GET' }, { ...env });
    expect(((await list.json()) as { topics: unknown[] }).topics.length).toBe(1);

    const patch = await app.request(
      `/api/sessions/${s}/topics/${topicId}`,
      { method: 'PATCH', headers: J, body: JSON.stringify({ summary: 'Outro' }) },
      { ...env },
    );
    expect(patch.status).toBe(200);

    const del = await app.request(
      `/api/sessions/${s}/topics/${topicId}`,
      { method: 'DELETE' },
      { ...env },
    );
    expect(del.status).toBe(204);
  });

  it('404 deleting an unknown topic', async () => {
    const s = await seededSession();
    const res = await app.request(`/api/sessions/${s}/topics/nope`, { method: 'DELETE' }, { ...env });
    expect(res.status).toBe(404);
  });
});

// ── Transcript generation (deepgram-transcription) ──────────────────────────

const FIXTURES = join(import.meta.dirname, '..', 'test', 'fixtures', 'audio');
const SEG1 = join(FIXTURES, 'seg1.webm');
const CORRUPT = join(FIXTURES, 'seg-corrupt.bin');

function deepgramResponse(words: unknown[]) {
  return { results: { channels: [{ alternatives: [{ words }] }] } };
}

function configuredEnv(overrides: Record<string, unknown> = {}) {
  return envWith({ DEEPGRAM_API_KEY: 'test-deepgram-key', DEEPGRAM_MODEL: 'nova-3', ...overrides });
}

async function uploadSegment(
  sessionId: string,
  filePath: string,
  opts: { mime?: string; recordingOrdinal?: number } = {},
): Promise<void> {
  const bytes = readFileSync(filePath);
  const qs = opts.recordingOrdinal ? `?recording_ordinal=${opts.recordingOrdinal}` : '';
  const res = await app.request(
    `/api/sessions/${sessionId}/audio/segments${qs}`,
    { method: 'POST', headers: { 'content-type': opts.mime ?? 'audio/webm' }, body: bytes },
    { ...env },
  );
  expect(res.status).toBe(200);
}

async function logRecordingStarted(sessionId: string, ordinal: number): Promise<void> {
  const res = await app.request(
    `/api/sessions/${sessionId}/events`,
    {
      method: 'POST',
      headers: J,
      body: JSON.stringify({ category: 'internal', message: `Recording ${ordinal} Started`, metadata: {} }),
    },
    { ...env },
  );
  expect(res.status).toBe(200);
}

async function addManualWord(sessionId: string, word: string): Promise<void> {
  const res = await app.request(
    `/api/sessions/${sessionId}/transcript-words`,
    { method: 'POST', headers: J, body: JSON.stringify({ speaker: 'Manual', word }) },
    { ...env },
  );
  expect(res.status).toBe(201);
}

async function listWords(sessionId: string): Promise<Array<{ word: string }>> {
  const res = await app.request(`/api/sessions/${sessionId}/transcript-words`, { method: 'GET' }, { ...env });
  return ((await res.json()) as { words: Array<{ word: string }> }).words;
}

function generate(sessionId: string, init: RequestInit = {}, envOverride = configuredEnv()) {
  return app.request(
    `/api/sessions/${sessionId}/transcript-words/generate`,
    { method: 'POST', ...init },
    envOverride,
  );
}

describe('transcript generation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('200 {words}: session_time/speaker strings, start_sec/end_sec, contiguous ordinals, ordinal order', async () => {
    const s = await seededSession();
    await logRecordingStarted(s, 1);
    await uploadSegment(s, SEG1, { recordingOrdinal: 1 });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify(
            deepgramResponse([
              { word: 'hello', punctuated_word: 'Hello,', start: 0.5, end: 0.9, speaker: 0 },
              { word: 'world', start: 1.0, end: 1.4, speaker: 1 },
            ]),
          ),
          { status: 200 },
        ),
      ),
    );

    const res = await generate(s);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      words: Array<{
        word: string;
        speaker: string;
        session_time: string;
        start_sec: number;
        end_sec: number;
        ordinal: number;
        session_id: string;
      }>;
    };
    expect(body.words).toHaveLength(2);
    expect(body.words[0].word).toBe('Hello,');
    expect(body.words[0].speaker).toBe('0');
    expect(body.words[1].word).toBe('world');
    expect(body.words[1].speaker).toBe('1');
    for (const w of body.words) {
      expect(typeof w.session_time).toBe('string');
      expect(w.session_time.length).toBeGreaterThan(0);
      expect(w.session_id).toBe(s);
    }
    expect(body.words[0].start_sec).toBeCloseTo(0.5, 1);
    expect(body.words[1].start_sec).toBeCloseTo(1.0, 1);
    // Contiguous ordinals from 0, and the array is already in ordinal order.
    expect(body.words.map((w) => w.ordinal)).toEqual([0, 1]);
  });

  it('400 no-audio: a session with zero audio segments', async () => {
    const s = await seededSession();
    const res = await generate(s);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail: string };
    expect(body.detail).toMatch(/no.*audio/i);
  });

  it('400 all-unreadable: segments exist but none is readable (distinct detail from no-audio)', async () => {
    const s = await seededSession();
    await uploadSegment(s, CORRUPT);

    const res = await generate(s);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail: string };

    const noAudioRes = await generate(await seededSession());
    const noAudioBody = (await noAudioRes.json()) as { detail: string };
    expect(body.detail).not.toBe(noAudioBody.detail);
  });

  it('400 zero-word result does not wipe the transcript (gate decision 2)', async () => {
    const s = await seededSession();
    await uploadSegment(s, SEG1);
    await addManualWord(s, 'existing');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(deepgramResponse([])), { status: 200 })),
    );

    const res = await generate(s);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail: string };
    expect(body.detail).toMatch(/speech/i);

    const words = await listWords(s);
    expect(words.map((w) => w.word)).toEqual(['existing']);
  });

  it('abandons the run without provider spend when the request is already aborted', async () => {
    const s = await seededSession();
    await uploadSegment(s, SEG1);

    const fetchMock = vi.fn(async () => new Response(JSON.stringify(deepgramResponse([])), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const controller = new AbortController();
    controller.abort();

    const res = await generate(s, { signal: controller.signal });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail: string };
    expect(body.detail).toMatch(/aborted/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('409 concurrent: a second run is rejected with no additional provider spend', async () => {
    const s = await seededSession();
    await uploadSegment(s, SEG1);

    const release: { fn: (() => void) | null } = { fn: null };
    const fetchMock = vi.fn(async () => {
      const gate = new Promise<void>((resolve) => {
        release.fn = resolve;
      });
      await gate;
      return new Response(
        JSON.stringify(deepgramResponse([{ word: 'hi', start: 0, end: 0.2, speaker: 0 }])),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const firstReq = generate(s);
    // Poll until the provider call has actually started (single-flight lock held).
    while (fetchMock.mock.calls.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    const secondRes = await generate(s);
    expect(secondRes.status).toBe(409);
    expect(fetchMock).toHaveBeenCalledTimes(1); // second made no provider request

    release.fn?.();
    const firstRes = await firstReq;
    expect(firstRes.status).toBe(200);
  });

  it('502 upstream failure preserves existing words', async () => {
    const s = await seededSession();
    await uploadSegment(s, SEG1);
    await addManualWord(s, 'existing');

    vi.stubGlobal('fetch', vi.fn(async () => new Response('server error', { status: 500 })));

    const res = await generate(s);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { detail: string };
    expect(body.detail).not.toContain('test-deepgram-key');

    const words = await listWords(s);
    expect(words.map((w) => w.word)).toEqual(['existing']);
  });

  // ── Enrichment persistence (persist-deepgram-enrichment, task 4.1) ──────

  function deepgramEnrichmentFixture(): unknown {
    return JSON.parse(
      readFileSync(
        join(import.meta.dirname, '..', 'test', 'fixtures', 'deepgram-enrichment-response.json'),
        'utf8',
      ),
    );
  }

  function stubFetchWithFixture(): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(deepgramEnrichmentFixture()), { status: 200 })),
    );
  }

  it('persists real-fixture enrichment and reads it back in ordinal order (anchored)', async () => {
    const s = await seededSession();
    await logRecordingStarted(s, 1);
    await uploadSegment(s, SEG1, { recordingOrdinal: 1 });
    stubFetchWithFixture();

    const res = await generate(s);
    expect(res.status).toBe(200);

    const enrichment = env.ports.sessions.get(s).listTranscriptEnrichment();
    expect(enrichment.paragraphs).toHaveLength(3);
    expect(enrichment.sentiment).toHaveLength(3);
    // Anchored (recording-start anchor resolved) — real timeline positions,
    // never the never-zeros-as-data NULL, and non-decreasing (ordinal order
    // is anchored-by-start_sec-ascending for this single-group, all-anchored
    // case).
    for (const p of enrichment.paragraphs) {
      expect(typeof p.start_sec).toBe('number');
      expect(typeof p.end_sec).toBe('number');
      expect(p.end_sec).toBeGreaterThanOrEqual(p.start_sec as number);
      expect(p.text.length).toBeGreaterThan(0);
    }
    for (const seg of enrichment.sentiment) {
      expect(typeof seg.start_sec).toBe('number');
      expect(typeof seg.end_sec).toBe('number');
      expect(seg.sentiment.length).toBeGreaterThan(0);
    }
    const paraStarts = enrichment.paragraphs.map((p) => p.start_sec as number);
    expect(paraStarts).toEqual([...paraStarts].sort((a, b) => a - b));
    const sentStarts = enrichment.sentiment.map((seg) => seg.start_sec as number);
    expect(sentStarts).toEqual([...sentStarts].sort((a, b) => a - b));
  });

  it('anchorless-group enrichment reads back with NULL start/end, not zeros', async () => {
    const s = await seededSession();
    // No "Recording N Started" event logged — the segment's group resolves
    // no recording-start anchor (3-step chain step 3: anchorless).
    await uploadSegment(s, SEG1);
    stubFetchWithFixture();

    const res = await generate(s);
    expect(res.status).toBe(200);

    const enrichment = env.ports.sessions.get(s).listTranscriptEnrichment();
    expect(enrichment.paragraphs.length).toBeGreaterThan(0);
    expect(enrichment.sentiment.length).toBeGreaterThan(0);
    for (const p of enrichment.paragraphs) {
      expect(p.start_sec).toBeNull();
      expect(p.end_sec).toBeNull();
    }
    for (const seg of enrichment.sentiment) {
      expect(seg.start_sec).toBeNull();
      expect(seg.end_sec).toBeNull();
    }
  });

  it('a never-generated session reads listTranscriptEnrichment as empty arrays', async () => {
    const s = await seededSession();
    expect(env.ports.sessions.get(s).listTranscriptEnrichment()).toEqual({
      paragraphs: [],
      sentiment: [],
    });
  });

  it('GET transcript-words shape is unchanged after enrichment is persisted', async () => {
    const s = await seededSession();
    await logRecordingStarted(s, 1);
    await uploadSegment(s, SEG1, { recordingOrdinal: 1 });
    stubFetchWithFixture();

    const genRes = await generate(s);
    expect(genRes.status).toBe(200);

    const res = await app.request(`/api/sessions/${s}/transcript-words`, { method: 'GET' }, { ...env });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { words: Array<Record<string, unknown>> };
    expect(body.words.length).toBeGreaterThan(0);
    for (const w of body.words) {
      expect(Object.keys(w).sort()).toEqual(
        ['created_at_utc', 'end_sec', 'id', 'ordinal', 'session_id', 'session_time', 'speaker', 'start_sec', 'word'].sort(),
      );
    }
  });

  it('no transcript-enrichment HTTP route exists (in-process read only, design D5)', async () => {
    const s = await seededSession();
    const res = await app.request(
      `/api/sessions/${s}/transcript-enrichment`,
      { method: 'GET' },
      { ...env },
    );
    expect(res.status).toBe(404);
  });

  it('replace-on-rerun: a successful run replaces prior words atomically', async () => {
    const s = await seededSession();
    await uploadSegment(s, SEG1);
    await addManualWord(s, 'stale');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify(deepgramResponse([{ word: 'fresh', start: 0, end: 0.3, speaker: 0 }])),
          { status: 200 },
        ),
      ),
    );

    const res = await generate(s);
    expect(res.status).toBe(200);

    const words = await listWords(s);
    expect(words.map((w) => w.word)).toEqual(['fresh']);
  });
});
