// Audio routes — ported from web/routers/audio.py. Bytes live in the blob
// store keyed `audio/<session_id>/<ordinal>_<uuid>.<ext>`; segment metadata
// lives in the session hub. Upload streams to the blob store then records
// metadata; download streams back with HTTP range support (audio scrubbing).

import { Hono } from 'hono';
import type { BlobRange } from '../node/blobStore';
import { InvalidRangeError } from '../node/blobStore';
import { audioSegmentWaveformBodySchema } from '../schemas';
import type { AudioSegmentMeta } from '../session/SessionHub';
import type { AppEnv } from '../types';
import { ApiError, getSessionHub, parseOptionalMarkedAt, requireSession } from './_helpers';

export const audioRouter = new Hono<AppEnv>();

function segmentApiDict(sessionId: string, m: AudioSegmentMeta): Record<string, unknown> {
  return {
    id: m.id,
    ordinal: m.ordinal,
    started_at_utc: m.started_at_utc,
    ended_at_utc: m.ended_at_utc,
    mime_type: m.mime_type,
    recording_ordinal: m.recording_ordinal,
    url: `/api/sessions/${sessionId}/audio/segments/${m.id}`,
    waveform_peaks: m.waveform_peaks,
    waveform_db_floor: m.waveform_db_floor,
  };
}

export const MAX_AUDIO_BYTES = 50 * 1024 * 1024; // 50 MB — live recorder segment upload.

/**
 * Batch / local-audio-import may send full episode files (compressed MP3/M4A),
 * not short WebM chunks. Cap is higher than {@link MAX_AUDIO_BYTES}; still a
 * single heap buffer per request (see README upload note).
 */
// Stay under typical V8 ArrayBuffer max (~2 GiB) while allowing full-episode MP3s.
export const MAX_LOCAL_AUDIO_IMPORT_BYTES = 1500 * 1024 * 1024; // ~1.46 GiB

/** Reject an over-cap upload with 413. No-op for unknown (null) or NaN sizes;
 * the post-read byteLength check is the backstop when Content-Length is absent. */
export function enforceAudioByteLimit(bytes: number | null): void {
  if (bytes !== null && Number.isFinite(bytes) && bytes > MAX_AUDIO_BYTES) {
    throw new ApiError(413, `Audio payload exceeds the ${MAX_AUDIO_BYTES}-byte limit.`);
  }
}

// Live cap for the local-audio-import helpers below. Always
// MAX_LOCAL_AUDIO_IMPORT_BYTES in production; only the test seam ever lowers
// it (so the streaming 413 path is exercisable without allocating GiBs).
let localAudioImportByteCap = MAX_LOCAL_AUDIO_IMPORT_BYTES;

/** TEST-ONLY seam: lower the local-audio-import byte cap; `null` restores the
 * production cap. Production code never calls this. */
export function __setLocalAudioImportByteCapForTests(cap: number | null): void {
  localAudioImportByteCap = cap ?? MAX_LOCAL_AUDIO_IMPORT_BYTES;
}

/** The ONE place the local-audio-import 413 body is built — the Content-Length
 * pre-check and the streaming mid-read abort must stay byte-identical
 * (api-contract-freeze: same {detail} string either way). */
function localAudioImportOversizeError(): ApiError {
  return new ApiError(413, `Audio payload exceeds the ${localAudioImportByteCap}-byte limit.`);
}

/** Same as {@link enforceAudioByteLimit} but for POST …/local-audio-import. */
export function enforceLocalAudioImportByteLimit(bytes: number | null): void {
  if (bytes !== null && Number.isFinite(bytes) && bytes > localAudioImportByteCap) {
    throw localAudioImportOversizeError();
  }
}

/** Buffer a local-audio-import request body while counting bytes, aborting
 * with the SAME 413 the Content-Length pre-check uses the moment the cap is
 * crossed — a chunked request (no Content-Length) or one with a lying
 * Content-Length can no longer buffer unbounded heap before the post-read
 * backstop. Well-formed under-cap requests see byte-identical behavior to the
 * previous whole-body `arrayBuffer()` read. */
export async function readLocalAudioImportBody(
  body: ReadableStream<Uint8Array> | null,
): Promise<Uint8Array> {
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > localAudioImportByteCap) throw localAudioImportOversizeError();
      chunks.push(value);
    }
  } catch (err) {
    // Abort the remaining upload; best-effort — never mask the 413/read error.
    await reader.cancel().catch(() => {});
    throw err;
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

audioRouter.get('/api/sessions/:sessionId/audio/segments', async (c) => {
  const sessionId = c.req.param('sessionId');
  requireSession(c, sessionId);
  const segs = getSessionHub(c, sessionId).listAudioSegments();
  return c.json({
    segments: segs.map((s) => segmentApiDict(sessionId, s)),
    has_audio: segs.length > 0,
  });
});

audioRouter.post('/api/sessions/:sessionId/audio/segments', async (c) => {
  const sessionId = c.req.param('sessionId');
  requireSession(c, sessionId);
  const declared = c.req.header('content-length');
  enforceAudioByteLimit(declared !== undefined ? Number(declared) : null);
  const payload = await c.req.arrayBuffer();
  if (payload.byteLength === 0) throw new ApiError(400, 'Audio payload is empty.');
  enforceAudioByteLimit(payload.byteLength);
  const mime = c.req.header('content-type') ?? 'audio/webm';
  const started = parseOptionalMarkedAt(c.req.query('started_at_utc'));
  const ended = parseOptionalMarkedAt(c.req.query('ended_at_utc'));
  const roRaw = c.req.query('recording_ordinal');
  const recordingOrdinal = roRaw !== undefined && /^\d+$/.test(roRaw) ? Number(roRaw) : null;

  const seg = getSessionHub(c, sessionId).addAudioSegment({
    sessionId,
    mimeType: mime,
    startedAtUtc: started,
    endedAtUtc: ended,
    recordingOrdinal,
  });
  try {
    await c.env.ports.audio.put(seg.r2_key, payload, { contentType: seg.mime_type });
  } catch (e) {
    // Roll back the dangling metadata row if the bytes never landed.
    getSessionHub(c, sessionId).deleteAudioSegment(seg.id);
    throw e;
  }
  return c.json(segmentApiDict(sessionId, seg));
});

audioRouter.post('/api/sessions/:sessionId/audio/segments/sync-from-disk', async (c) => {
  const sessionId = c.req.param('sessionId');
  requireSession(c, sessionId);
  const prefix = `audio/${sessionId}/`;
  const known: Array<{ r2_key: string; ordinal: number }> = [];
  let cursor: string | undefined;
  do {
    const listed = await c.env.ports.audio.list({ prefix, cursor });
    for (const obj of listed.objects) {
      const m = /\/(\d{4})_/.exec(obj.key);
      if (m) known.push({ r2_key: obj.key, ordinal: Number(m[1]) });
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  const hub = getSessionHub(c, sessionId);
  const out = hub.syncAudioFromBlobs(known);
  const segs = hub.listAudioSegments();
  return c.json({
    inserted: out.inserted,
    updated: 0,
    scanned: known.length,
    segments: segs.map((s) => segmentApiDict(sessionId, s)),
    has_audio: segs.length > 0,
  });
});

audioRouter.get('/api/sessions/:sessionId/audio/segments/:segmentId', async (c) => {
  const sessionId = c.req.param('sessionId');
  const segmentId = c.req.param('segmentId');
  requireSession(c, sessionId);
  const got = getSessionHub(c, sessionId).getAudioSegmentKey(segmentId);
  if (got === null) throw new ApiError(404, 'Audio segment not found.');

  const rangeHeader = c.req.header('range');
  if (rangeHeader) {
    const parsed = parseRange(rangeHeader);
    let obj: Awaited<ReturnType<typeof c.env.ports.audio.get>>;
    try {
      obj = await c.env.ports.audio.get(got.r2_key, parsed ? { range: parsed } : undefined);
    } catch (e) {
      if (e instanceof InvalidRangeError) {
        throw new ApiError(416, 'Requested range not satisfiable.');
      }
      throw e;
    }
    if (obj === null) throw new ApiError(404, 'Audio segment not found.');
    const size = obj.size;
    const r = obj.range;
    let start = 0;
    let length = size;
    if (r) {
      start = r.offset ?? 0;
      length = r.length ?? size - start;
    }
    const end = start + length - 1;
    return new Response(obj.body, {
      status: 206,
      headers: {
        'content-type': got.mime_type,
        'accept-ranges': 'bytes',
        'content-length': String(length),
        'content-range': `bytes ${start}-${end}/${size}`,
      },
    });
  }

  const obj = await c.env.ports.audio.get(got.r2_key);
  if (obj === null) throw new ApiError(404, 'Audio segment not found.');
  return new Response(obj.body, {
    headers: {
      'content-type': got.mime_type,
      'accept-ranges': 'bytes',
      'content-length': String(obj.size),
    },
  });
});

audioRouter.put('/api/sessions/:sessionId/audio/segments/:segmentId/waveform', async (c) => {
  const sessionId = c.req.param('sessionId');
  const segmentId = c.req.param('segmentId');
  requireSession(c, sessionId);
  const body = audioSegmentWaveformBodySchema.parse(await c.req.json());
  for (const x of body.peaks) {
    if (!Number.isFinite(x) || x < -0.02 || x > 1.02) {
      throw new ApiError(400, 'waveform peaks must be in [0, 1].');
    }
  }
  const ok = getSessionHub(c, sessionId).setAudioSegmentWaveform({
    segmentId,
    peaks: body.peaks,
  });
  if (!ok) throw new ApiError(404, 'Audio segment not found.');
  return c.json({ ok: true });
});

/** Parse a single `bytes=start-end` range into BlobStore's range form. */
function parseRange(header: string): BlobRange | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (m === null) return null;
  const startRaw = m[1];
  const endRaw = m[2];
  if (startRaw === '' && endRaw === '') return null;
  if (startRaw === '') return { suffix: Number(endRaw) };
  const offset = Number(startRaw);
  if (endRaw === '') return { offset };
  return { offset, length: Number(endRaw) - offset + 1 };
}
