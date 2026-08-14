// Audio routes — ported from web/routers/audio.py. Bytes live in the blob
// store keyed `audio/<session_id>/<ordinal>_<uuid>.<ext>`; segment metadata
// lives in the session hub. Upload streams to the blob store then records
// metadata; download streams back with HTTP range support (audio scrubbing).

import { audioSegmentWaveformBodySchema } from '@autologger/contract';
import type { BlobRange } from '@autologger/ports';
import type { AudioSegmentMeta } from '@autologger/session-core';
import { InvalidRangeError } from '@autologger/storage';
import { Hono } from 'hono';
import type { AppEnv } from '../appEnv';
import { ApiError } from '../httpError';
import { getSessionHub, parseOptionalMarkedAt, requireSession } from './_helpers';

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

/** What an audio segment is stored/served as when the caller's content-type is
 * absent, blank, or outside {@link ALLOWED_AUDIO_MIME_FAMILIES}. Matches the
 * fallback `addAudioSegment` already applies to an empty mime. */
const DEFAULT_AUDIO_MIME_TYPE = 'audio/webm';

/**
 * The audio content-types a segment may be stored/served as — the enforcement
 * point for the invariant `app.ts` relies on when it scopes `compress()` to
 * `/api/*` without excluding audio ("audio/* content-types never match the
 * compressible filter"). Nothing else enforced it: the upload handler used to
 * persist the caller's `content-type` verbatim and the download handler echoes
 * it, so a segment uploaded as `text/plain` (any script whose `fetch` defaults
 * the header) had its >=1KB **206** responses gzipped — hono's `compress()` has
 * no 206/Content-Range guard, so it drops the hand-set `Content-Length` while
 * `Content-Range` still describes identity bytes. Corrupt audio for any
 * range-assembling client.
 *
 * A bare `audio/` prefix test would NOT be enough: hono's compressible regex
 * ends with a structured-suffix alternative (`[^;\s]+?\+(?:json|text|xml|…)`)
 * that matches ANY type, `audio/x+json` included. Hence a closed set of
 * families, matched after stripping parameters.
 *
 * Membership covers every mime the real producers emit:
 * - `MediaRecorder` defaults from `web/…/AudioRecorder.tsx` (which passes
 *   `mr.mimeType` / the delivered Blob's `.type` straight through):
 *   `audio/webm;codecs=opus` (Chrome), `audio/ogg;codecs=opus` (Firefox),
 *   `audio/mp4` (Safari).
 * - `packages/session-core`'s mime<->ext table (`audioStore.ts`), i.e. what the
 *   `sync-from-disk` blob scan restores: ogg / wav / mpeg / aiff / mp4 / webm.
 * - `@autologger/media-import`'s `CONTENT_TYPE_BY_EXT` (yt-dlp import):
 *   webm / ogg / wav / mp4.
 * - `@autologger/transcription`'s `contentTypeForFamily`: webm / mp4 / wav.
 * - Batch/local import file types (`BatchImportModal`): `audio/mpeg`,
 *   `audio/wav`.
 * The x-/legacy spellings are the common browser variants for those same
 * containers, kept so a normalization never silently changes a real upload's
 * declared type.
 */
const ALLOWED_AUDIO_MIME_FAMILIES: ReadonlySet<string> = new Set([
  'audio/webm',
  'audio/ogg',
  'audio/opus',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/mpeg',
  'audio/mp3',
  'audio/aac',
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/vnd.wave',
  'audio/aiff',
  'audio/x-aiff',
  'audio/flac',
  'audio/x-flac',
  'audio/3gpp',
  'audio/3gpp2',
]);

/**
 * Clamp a content-type to the audio allowlist. An allowlisted type is returned
 * **verbatim** (parameters and case included) so real uploads round-trip
 * byte-identically — `audio/webm;codecs=opus` stays exactly that. Anything else
 * — missing, blank, `text/plain`, `application/octet-stream` — degrades to
 * {@link DEFAULT_AUDIO_MIME_TYPE}.
 *
 * Deliberately NOT a rejection: a 4xx here would be an observable change for
 * existing clients (api-contract-freeze). Normalizing keeps every upload
 * succeeding and only moves the *stored* mime of a payload that was never
 * declared as audio in the first place.
 *
 * Idempotent, so the download handler can apply it as a second line of defense
 * over rows written by other writers (local-audio-import, youtube-import) and
 * by older builds.
 */
export function normalizeAudioMimeType(raw: string | undefined | null): string {
  const trimmed = raw?.trim() ?? '';
  const family = trimmed.split(';')[0]?.trim().toLowerCase() ?? '';
  return ALLOWED_AUDIO_MIME_FAMILIES.has(family) ? trimmed : DEFAULT_AUDIO_MIME_TYPE;
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
  const mime = normalizeAudioMimeType(c.req.header('content-type'));
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
  return c.json({
    inserted: out.inserted,
    updated: 0,
    scanned: known.length,
    has_audio: hub.listAudioSegments().length > 0,
  });
});

audioRouter.get('/api/sessions/:sessionId/audio/segments/:segmentId', async (c) => {
  const sessionId = c.req.param('sessionId');
  const segmentId = c.req.param('segmentId');
  requireSession(c, sessionId);
  const got = getSessionHub(c, sessionId).getAudioSegmentKey(segmentId);
  if (got === null) throw new ApiError(404, 'Audio segment not found.');
  // Defense in depth for the "audio responses are never compressible" invariant
  // (see normalizeAudioMimeType): upload normalization covers rows written from
  // here on, this covers rows written by the other segment writers
  // (local-audio-import, youtube-import) and by older builds. No-op for every
  // mime those paths actually produce.
  const contentType = normalizeAudioMimeType(got.mime_type);

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
        'content-type': contentType,
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
      'content-type': contentType,
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
