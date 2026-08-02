// batch-audio-import (tasks 2.1 + 2.2) — frozen-surface integration tests
// over POST /api/sessions/:sessionId/local-audio-import (design D2/D11,
// batch-audio-import spec "Local audio import HTTP surface").

import { describe, expect, it, vi } from 'vitest';
import { app, env } from '../test/harness';
import { seedSession, seedShow, seedStudio } from '../test/helpers';
import type { Bindings } from '../types';
import { MAX_LOCAL_AUDIO_IMPORT_BYTES } from './audio';

// Detail strings copied verbatim from `server/src/routers/sessions.ts`'s own
// module-private constants (not exported) so these tests assert the EXACT
// response body, not just a status code or a loose substring match.
const INVALID_DURATION_DETAIL = 'duration_s must be a positive finite number.';
const DURATION_EXCEEDS_MAX_DETAIL =
  'duration_s exceeds the maximum supported duration of 86400 seconds (24 hours).';
const MISSING_CONTENT_TYPE_DETAIL = 'Content-Type header is required and must be non-empty.';
const ROLLING_DETAIL =
  'Local audio import is refused while this session is actively recording; stop the recording and try again.';
const OVERSIZE_DETAIL = `Audio payload exceeds the ${MAX_LOCAL_AUDIO_IMPORT_BYTES}-byte limit.`;

const CTX = { frameRate: 24, startOffsetFrames: 0 };

const FAKE_AUDIO = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00]); // minimal RIFF-ish bytes

async function seededSession(): Promise<string> {
  const studio = await seedStudio();
  const show = await seedShow({ studioId: studio });
  return seedSession({ showId: show });
}

async function postLocalImport(
  sessionId: string,
  opts: {
    durationS?: string;
    body?: ArrayBuffer | Uint8Array | null;
    contentType?: string | null;
    contentLength?: string;
  },
  bindings: Bindings = env,
): Promise<Response> {
  const qs = opts.durationS !== undefined ? `?duration_s=${encodeURIComponent(opts.durationS)}` : '';
  const headers: Record<string, string> = {};
  if (opts.contentType !== null && opts.contentType !== undefined) {
    headers['content-type'] = opts.contentType;
  }
  if (opts.contentLength !== undefined) headers['content-length'] = opts.contentLength;
  return app.request(
    `/api/sessions/${sessionId}/local-audio-import${qs}`,
    {
      method: 'POST',
      headers,
      body: opts.body ?? FAKE_AUDIO,
    },
    bindings,
  );
}

async function listSegmentsRaw(sessionId: string, bindings: Bindings): Promise<string> {
  const res = await app.request(`/api/sessions/${sessionId}/audio/segments`, { method: 'GET' }, bindings);
  expect(res.status).toBe(200);
  return res.text();
}

async function listSegments(
  sessionId: string,
  bindings: Bindings,
): Promise<{ segments: Array<Record<string, unknown>>; has_audio: boolean }> {
  return JSON.parse(await listSegmentsRaw(sessionId, bindings));
}

interface HttpEvent {
  message: string;
  category: string;
  timecode_total_frames: number | null;
  frame_rate: number | null;
}

async function listEvents(
  sessionId: string,
  bindings: Bindings,
): Promise<{ total: number; events: HttpEvent[] }> {
  const res = await app.request(`/api/sessions/${sessionId}/events`, { method: 'GET' }, bindings);
  expect(res.status).toBe(200);
  return (await res.json()) as { total: number; events: HttpEvent[] };
}

describe('POST /api/sessions/:sessionId/local-audio-import — happy path + anchor side-effects', () => {
  it('200 { ok: true }, one anchored take, transport advance, and WS emissions', async () => {
    const session = await seededSession();
    const durationS = '125'; // 125s @ 24fps → 3000 frames (same as youtube-import fixture)

    const hub = env.ports.sessions.get(session);
    const wsMessages: Array<Record<string, unknown>> = [];
    hub.attachSocket({ send: (d: string) => void wsMessages.push(JSON.parse(d)) }, 'browser');

    expect(hub.transportSnapshot(CTX).elapsed_frames).toBe(0);

    const res = await postLocalImport(session, { durationS, contentType: 'audio/wav' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const { events, total } = await listEvents(session, env);
    expect(total).toBe(2);
    const started = events.find((e) => e.message === 'Recording 1 Started');
    const stopped = events.find((e) => e.message === 'Recording 1 Stopped');
    expect(started).toBeDefined();
    expect(stopped).toBeDefined();
    expect(started?.category).toBe('internal');
    expect(started?.timecode_total_frames).toBe(0);
    expect(started?.frame_rate).toBe(24);
    expect(stopped?.timecode_total_frames).toBe(3000);

    const segs = await listSegments(session, env);
    expect(segs.segments).toHaveLength(1);
    const seg = segs.segments[0] as {
      recording_ordinal: number | null;
      started_at_utc: string | null;
      ended_at_utc: string | null;
      mime_type: string;
    };
    expect(seg.recording_ordinal).toBe(1);
    expect(seg.mime_type).toBe('audio/wav');
    expect(seg.started_at_utc).not.toBeNull();
    expect(seg.ended_at_utc).not.toBeNull();

    expect(hub.transportSnapshot(CTX).elapsed_frames).toBe(3000);

    const types = wsMessages.map((m) => m.type);
    expect(types).toContain('audio.changed');
    expect(types.filter((t) => t === 'event.changed').length).toBe(1);
    expect(types.filter((t) => t === 'transport.changed').length).toBe(1);
    expect(wsMessages).toContainEqual({ type: 'transport.changed', is_rolling: false, current_take: 0 });
  });
});

describe('POST /api/sessions/:sessionId/local-audio-import — duration_s validation', () => {
  it('400 { detail } when duration_s is omitted', async () => {
    const session = await seededSession();
    const before = await listSegmentsRaw(session, env);

    const res = await postLocalImport(session, { durationS: undefined, contentType: 'audio/wav' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ detail: INVALID_DURATION_DETAIL });

    expect(await listSegmentsRaw(session, env)).toBe(before);
  });

  it.each(['0', '-1', 'NaN', 'abc', 'Infinity'])(
    '400 { detail } when duration_s=%s is invalid',
    async (bad) => {
      const session = await seededSession();
      const before = await listSegmentsRaw(session, env);

      const res = await postLocalImport(session, { durationS: bad, contentType: 'audio/wav' });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ detail: INVALID_DURATION_DETAIL });

      expect(await listSegmentsRaw(session, env)).toBe(before);
    },
  );

  it('400 { detail } when duration_s exceeds the supported upper bound', async () => {
    const session = await seededSession();
    const before = await listSegmentsRaw(session, env);

    const res = await postLocalImport(session, { durationS: '1e308', contentType: 'audio/wav' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ detail: DURATION_EXCEEDS_MAX_DETAIL });

    expect(await listSegmentsRaw(session, env)).toBe(before);
  });
});

describe('POST /api/sessions/:sessionId/local-audio-import — Content-Type validation', () => {
  it('400 { detail } when Content-Type is omitted', async () => {
    const session = await seededSession();
    const before = await listSegmentsRaw(session, env);

    const res = await postLocalImport(session, { durationS: '10', contentType: null });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ detail: MISSING_CONTENT_TYPE_DETAIL });

    expect(await listSegmentsRaw(session, env)).toBe(before);
  });

  it.each(['', '   '])('400 { detail } when Content-Type is blank (%j)', async (blank) => {
    const session = await seededSession();
    const before = await listSegmentsRaw(session, env);

    const res = await postLocalImport(session, { durationS: '10', contentType: blank });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ detail: MISSING_CONTENT_TYPE_DETAIL });

    expect(await listSegmentsRaw(session, env)).toBe(before);
  });
});

describe('POST /api/sessions/:sessionId/local-audio-import — requireSession guard', () => {
  it('404 { detail: Session not found } for a nonexistent session', async () => {
    const res = await postLocalImport('does-not-exist', { durationS: '10', contentType: 'audio/wav' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: 'Session not found' });
  });
});

describe('POST /api/sessions/:sessionId/local-audio-import — put failure rollback', () => {
  it('rolls back the inserted segment row when ports.audio.put fails', async () => {
    const session = await seededSession();
    const before = await listSegmentsRaw(session, env);

    const putSpy = vi.spyOn(env.ports.audio, 'put').mockRejectedValueOnce(new Error('ENOSPC: no space left on device'));
    try {
      const res = await postLocalImport(session, { durationS: '10', contentType: 'audio/wav' });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ detail: 'Internal Server Error' });
    } finally {
      putSpy.mockRestore();
    }

    expect(await listSegmentsRaw(session, env)).toBe(before);
  });
});

describe('POST /api/sessions/:sessionId/local-audio-import — rolling refusal (409)', () => {
  it('refuses while a recording is live: no segments, no Recording events', async () => {
    const session = await seededSession();

    const startRes = await app.request(`/api/sessions/${session}/transport/start`, { method: 'POST' }, env);
    expect(startRes.status).toBe(200);

    const statusBefore = await app.request(`/api/sessions/${session}/status`, { method: 'GET' }, env);
    expect(((await statusBefore.json()) as { is_rolling: boolean }).is_rolling).toBe(true);

    const res = await postLocalImport(session, { durationS: '10', contentType: 'audio/wav' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ detail: ROLLING_DETAIL });

    const statusAfter = await app.request(`/api/sessions/${session}/status`, { method: 'GET' }, env);
    expect(((await statusAfter.json()) as { is_rolling: boolean }).is_rolling).toBe(true);

    const { total } = await listEvents(session, env);
    expect(total).toBe(0);

    const segs = await listSegments(session, env);
    expect(segs.segments).toHaveLength(0);
  });

  // Phase-2 fix-wave: exercises the LATE rolling guard (after put, before anchor) —
  // same hermetic seam as sessions.youtubeImport.int.test.ts's late-guard case.
  it('the LATE guard (post-put, pre-anchor) refuses a recording that started during upload: 409, segment rolled back, live roll untouched, no Recording events', async () => {
    const session = await seededSession();
    const hub = env.ports.sessions.get(session);
    const originalStatusLive = hub.statusLive.bind(hub);
    let statusLiveCalls = 0;
    const spy = vi.spyOn(hub, 'statusLive').mockImplementation((ctx) => {
      statusLiveCalls += 1;
      const real = originalStatusLive(ctx);
      return statusLiveCalls === 1 ? { ...real, is_rolling: false } : real;
    });

    const startRes = await app.request(`/api/sessions/${session}/transport/start`, { method: 'POST' }, env);
    expect(startRes.status).toBe(200);

    const res = await postLocalImport(session, { durationS: '10', contentType: 'audio/wav' });
    spy.mockRestore();

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ detail: ROLLING_DETAIL });
    expect(statusLiveCalls).toBeGreaterThanOrEqual(2);

    const segs = await listSegments(session, env);
    expect(segs.segments).toHaveLength(0);

    const statusAfter = await app.request(`/api/sessions/${session}/status`, { method: 'GET' }, env);
    const afterBody = (await statusAfter.json()) as { is_rolling: boolean; current_take: number };
    expect(afterBody.is_rolling).toBe(true);
    expect(afterBody.current_take).toBe(1);

    const { total } = await listEvents(session, env);
    expect(total).toBe(0);
  });
});

describe('POST /api/sessions/:sessionId/local-audio-import — anchor failure rollback', () => {
  it('rolls back the inserted segment and leaves events/transport unchanged when anchorImportedTake throws', async () => {
    const session = await seededSession();
    const hub = env.ports.sessions.get(session);
    const before = await listSegmentsRaw(session, env);
    expect(hub.transportSnapshot(CTX).elapsed_frames).toBe(0);

    const anchorSpy = vi
      .spyOn(hub, 'anchorImportedTake')
      .mockImplementationOnce(() => {
        throw new Error('simulated anchor failure');
      });

    try {
      const res = await postLocalImport(session, { durationS: '10', contentType: 'audio/wav' });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ detail: 'Internal Server Error' });
    } finally {
      anchorSpy.mockRestore();
    }

    expect(await listSegmentsRaw(session, env)).toBe(before);

    const { total } = await listEvents(session, env);
    expect(total).toBe(0);
    expect(hub.transportSnapshot(CTX).elapsed_frames).toBe(0);
  });
});

describe('POST /api/sessions/:sessionId/local-audio-import — byte limit (413)', () => {
  it('413 { detail } when Content-Length exceeds the audio cap', async () => {
    const session = await seededSession();
    const before = await listSegmentsRaw(session, env);

    const res = await postLocalImport(session, {
      durationS: '10',
      contentType: 'audio/wav',
      contentLength: String(MAX_LOCAL_AUDIO_IMPORT_BYTES + 1),
      body: new Uint8Array([0x00]),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ detail: OVERSIZE_DETAIL });

    expect(await listSegmentsRaw(session, env)).toBe(before);
  });
});
