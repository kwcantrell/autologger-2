// batch-audio-import (tasks 2.1 + 2.2) — frozen-surface integration tests
// over POST /api/sessions/:sessionId/local-audio-import (design D2/D11,
// batch-audio-import spec "Local audio import HTTP surface").

import { describe, expect, it, vi } from 'vitest';
import type { Bindings } from '../appEnv';
import { app, env } from '../test/harness';
import { seedSession, seedShow, seedStudio } from '../test/helpers';
import { __setLocalAudioImportByteCapForTests, MAX_LOCAL_AUDIO_IMPORT_BYTES } from './audio';

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
    seamParts?: string;
  },
  bindings: Bindings = env,
): Promise<Response> {
  const qs =
    opts.durationS !== undefined ? `?duration_s=${encodeURIComponent(opts.durationS)}` : '';
  const headers: Record<string, string> = {};
  if (opts.contentType !== null && opts.contentType !== undefined) {
    headers['content-type'] = opts.contentType;
  }
  if (opts.contentLength !== undefined) headers['content-length'] = opts.contentLength;
  if (opts.seamParts !== undefined) headers['x-audio-seam-parts'] = opts.seamParts;
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

/** Keys of every audio blob stored for the session (real BlobStore over the
 * per-test temp DATA_DIR — inspectable directly, no spying required). */
async function listBlobKeys(sessionId: string): Promise<string[]> {
  const listed = await env.ports.audio.list({ prefix: `audio/${sessionId}/` });
  return listed.objects.map((o) => o.key);
}

async function listSegmentsRaw(sessionId: string, bindings: Bindings): Promise<string> {
  const res = await app.request(
    `/api/sessions/${sessionId}/audio/segments`,
    { method: 'GET' },
    bindings,
  );
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

    // Baseline for the rollback suites' blob-gone assertions: a successful
    // import leaves exactly one blob on disk.
    expect(await listBlobKeys(session)).toHaveLength(1);

    expect(hub.transportSnapshot(CTX).elapsed_frames).toBe(3000);

    const types = wsMessages.map((m) => m.type);
    expect(types).toContain('audio.changed');
    expect(types.filter((t) => t === 'event.changed').length).toBe(1);
    expect(types.filter((t) => t === 'transport.changed').length).toBe(1);
    expect(wsMessages).toContainEqual({
      type: 'transport.changed',
      is_rolling: false,
      current_take: 0,
    });
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

  it.each([
    '0',
    '-1',
    'NaN',
    'abc',
    'Infinity',
  ])('400 { detail } when duration_s=%s is invalid', async (bad) => {
    const session = await seededSession();
    const before = await listSegmentsRaw(session, env);

    const res = await postLocalImport(session, { durationS: bad, contentType: 'audio/wav' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ detail: INVALID_DURATION_DETAIL });

    expect(await listSegmentsRaw(session, env)).toBe(before);
  });

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
    const res = await postLocalImport('does-not-exist', {
      durationS: '10',
      contentType: 'audio/wav',
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: 'Session not found' });
  });
});

describe('POST /api/sessions/:sessionId/local-audio-import — put failure rollback', () => {
  it('rolls back the inserted segment row when ports.audio.put fails', async () => {
    const session = await seededSession();
    const before = await listSegmentsRaw(session, env);

    const putSpy = vi
      .spyOn(env.ports.audio, 'put')
      .mockRejectedValueOnce(new Error('ENOSPC: no space left on device'));
    try {
      const res = await postLocalImport(session, { durationS: '10', contentType: 'audio/wav' });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ detail: 'Internal Server Error' });
    } finally {
      putSpy.mockRestore();
    }

    expect(await listSegmentsRaw(session, env)).toBe(before);
    expect(await listBlobKeys(session)).toHaveLength(0);
  });
});

describe('POST /api/sessions/:sessionId/local-audio-import — rolling refusal (409)', () => {
  it('refuses while a recording is live: no segments, no Recording events', async () => {
    const session = await seededSession();

    const startRes = await app.request(
      `/api/sessions/${session}/transport/start`,
      { method: 'POST' },
      env,
    );
    expect(startRes.status).toBe(200);

    const statusBefore = await app.request(
      `/api/sessions/${session}/status`,
      { method: 'GET' },
      env,
    );
    expect(((await statusBefore.json()) as { is_rolling: boolean }).is_rolling).toBe(true);

    const res = await postLocalImport(session, { durationS: '10', contentType: 'audio/wav' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ detail: ROLLING_DETAIL });

    const statusAfter = await app.request(
      `/api/sessions/${session}/status`,
      { method: 'GET' },
      env,
    );
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

    const startRes = await app.request(
      `/api/sessions/${session}/transport/start`,
      { method: 'POST' },
      env,
    );
    expect(startRes.status).toBe(200);

    const res = await postLocalImport(session, { durationS: '10', contentType: 'audio/wav' });
    spy.mockRestore();

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ detail: ROLLING_DETAIL });
    expect(statusLiveCalls).toBeGreaterThanOrEqual(2);

    const segs = await listSegments(session, env);
    expect(segs.segments).toHaveLength(0);

    // PR-3 review fix: the LATE guard fires AFTER the blob landed — rollback
    // must remove the bytes too, or sync-from-disk could resurrect the row.
    expect(await listBlobKeys(session)).toHaveLength(0);

    const statusAfter = await app.request(
      `/api/sessions/${session}/status`,
      { method: 'GET' },
      env,
    );
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

    const anchorSpy = vi.spyOn(hub, 'anchorImportedTake').mockImplementationOnce(() => {
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

    // PR-3 review fix: anchor failure happens AFTER the blob landed — rollback
    // must remove the bytes too, or sync-from-disk could resurrect the row.
    expect(await listBlobKeys(session)).toHaveLength(0);

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

  // PR-3 review fix: a chunked body (no Content-Length) must be capped WHILE
  // streaming, not buffered whole and checked after. Uses the test-only cap
  // seam so no GiBs are allocated; the {detail} template is identical to the
  // pre-check's (with the production cap it is byte-for-byte OVERSIZE_DETAIL).
  it('413 mid-stream for a chunked body (no Content-Length) that crosses the cap: no segment row, no blob', async () => {
    const session = await seededSession();
    const before = await listSegmentsRaw(session, env);

    __setLocalAudioImportByteCapForTests(64);
    const putSpy = vi.spyOn(env.ports.audio, 'put');
    try {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < 5; i++) controller.enqueue(new Uint8Array(32).fill(0x41));
          controller.close();
        },
      });
      const res = await app.request(
        `/api/sessions/${session}/local-audio-import?duration_s=10`,
        {
          method: 'POST',
          headers: { 'content-type': 'audio/wav' },
          body,
          duplex: 'half',
        } as RequestInit,
        env,
      );
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ detail: 'Audio payload exceeds the 64-byte limit.' });
      expect(putSpy).not.toHaveBeenCalled();
    } finally {
      putSpy.mockRestore();
      __setLocalAudioImportByteCapForTests(null);
    }

    expect(await listSegmentsRaw(session, env)).toBe(before);
    expect(await listBlobKeys(session)).toHaveLength(0);
  });
});

describe('POST /api/sessions/:sessionId/local-audio-import — X-Audio-Seam-Parts validation (pr-3-review)', () => {
  // Detail strings are the exact `parseAudioSeamPartsHeader` error messages —
  // the handler rethrows them verbatim as the 400 {detail} body.
  it.each([
    ['not JSON at all', 'not-json', 'X-Audio-Seam-Parts must be a JSON array of { duration_s }.'],
    [
      'a JSON object, not an array',
      '{"duration_s":10}',
      'X-Audio-Seam-Parts must be a non-empty JSON array.',
    ],
    ['an empty array', '[]', 'X-Audio-Seam-Parts must be a non-empty JSON array.'],
    ['a non-object entry', '[10]', 'X-Audio-Seam-Parts entries must be objects with duration_s.'],
    [
      'a non-positive duration_s',
      '[{"duration_s":0}]',
      'X-Audio-Seam-Parts duration_s must be a positive finite number.',
    ],
  ])('400 { detail } for a malformed header (%s): no segment, no seam parts', async (_label, header, detail) => {
    const session = await seededSession();
    const before = await listSegmentsRaw(session, env);

    const res = await postLocalImport(session, {
      durationS: '10',
      contentType: 'audio/wav',
      seamParts: header,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ detail });

    expect(await listSegmentsRaw(session, env)).toBe(before);
    expect(env.ports.sessions.get(session).getAudioSeamParts()).toBeNull();
  });

  it('400 { detail } when the parts sum disagrees with duration_s beyond the 0.5 s tolerance', async () => {
    const session = await seededSession();
    const before = await listSegmentsRaw(session, env);

    const res = await postLocalImport(session, {
      durationS: '100',
      contentType: 'audio/wav',
      seamParts: JSON.stringify([{ duration_s: 30 }, { duration_s: 60 }]), // sums to 90
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      detail: 'X-Audio-Seam-Parts durations sum (90) must be within 0.5s of duration_s (100).',
    });

    expect(await listSegmentsRaw(session, env)).toBe(before);
    expect(env.ports.sessions.get(session).getAudioSeamParts()).toBeNull();
  });

  it('a valid header persists its parts in order (readable via the hub the log-import sync uses)', async () => {
    const session = await seededSession();

    const res = await postLocalImport(session, {
      durationS: '100',
      contentType: 'audio/wav',
      seamParts: JSON.stringify([{ duration_s: 40 }, { duration_s: 60 }]),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(env.ports.sessions.get(session).getAudioSeamParts()).toEqual([
      { duration_s: 40 },
      { duration_s: 60 },
    ]);
  });
});

describe('POST /api/sessions/:sessionId/local-audio-import — repeated imports accumulate seam parts', () => {
  it('a second import APPENDS its parts after the first take’s (full-timeline order for log-import sync)', async () => {
    const session = await seededSession();

    const first = await postLocalImport(session, {
      durationS: '90',
      contentType: 'audio/wav',
      seamParts: JSON.stringify([{ duration_s: 30 }, { duration_s: 60 }]),
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true });

    // Second import (take 2) — header omitted, so it contributes the single
    // whole-file part [{ duration_s: 45 }].
    const second = await postLocalImport(session, { durationS: '45', contentType: 'audio/wav' });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true });

    const hub = env.ports.sessions.get(session);
    expect(hub.getAudioSeamParts()).toEqual([
      { duration_s: 30 },
      { duration_s: 60 },
      { duration_s: 45 },
    ]);

    // Both takes' segments + blobs exist; take 2 got the next ordinal.
    const segs = await listSegments(session, env);
    expect(segs.segments).toHaveLength(2);
    expect(segs.segments.map((s) => s.recording_ordinal).sort()).toEqual([1, 2]);
    expect(await listBlobKeys(session)).toHaveLength(2);
  });
});
