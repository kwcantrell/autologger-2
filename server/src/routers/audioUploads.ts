// Resumable audio uploads (OpenSpec change `media-worker`, design D12; api-contract-freeze
// "Resumable audio upload endpoints"). Five routes under `/api/sessions/:sessionId/audio/uploads`,
// login and session access as the segment routes. Parts are staged in the API-owned sparse file
// `BLOB_DIR/.tmp/upload-<id>`, each hashed while it is written and compared with the hash the client
// declared; completion re-hashes every part of the staged file, then renames it into `audio/` and
// attaches it exactly as `local-audio-import` (import mode) or the segment POST (segment mode) does.
// Rows live in `catalog.media_uploads`, read and written on the reviewed system binding
// `media-uploads`, every statement scoped to the session and the creating user in code.

import { createHash } from 'node:crypto';
import { audioUploadCreateBodySchema } from '@autologger/contract';
import { isoZ } from '@autologger/domain';
import type { MediaSql, MediaUpload } from '@autologger/ports/media';
import {
  AUDIO_SEAM_PARTS_HEADER,
  type AudioSeamPart,
  ImportWhileRollingError,
  parseAudioSeamPartsHeader,
} from '@autologger/session-core';
import { PartTooLargeError } from '@autologger/storage';
import {
  MEDIA_MIN_FREE_BYTES,
  UPLOAD_MAX_BYTES,
  UPLOAD_MAX_OPEN_PER_USER,
  UPLOAD_MAX_STAGED_BYTES_PER_USER,
  UPLOAD_PART_BYTES,
} from '@autologger/storage/mediaLimits';
import { mediaUploads } from '@autologger/storage/mediaUploads';
import type { Context } from 'hono';
import { Hono } from 'hono';
import type { AppEnv } from '../appEnv';
import { ApiError } from '../httpError';
import {
  getSessionHub,
  parseOptionalMarkedAt,
  requireSession,
  requireUser,
  timecodeCtx,
} from './_helpers';
import { normalizeAudioMimeType, parseRecordingOrdinalQuery, storeLiveSegment } from './audio';
import {
  addImportedAfterBlob,
  LOCAL_AUDIO_IMPORT_ROLLING_DETAIL,
  parseLocalAudioImportDurationS,
  rollbackLocalAudioImportSegment,
} from './sessions';

export const audioUploadsRouter = new Hono<AppEnv>();

const BASE = '/api/sessions/:sessionId/audio/uploads';
const LOW_DISK_DETAIL = 'The server is low on disk space; try the upload again later.';
const UNKNOWN_DETAIL = 'Upload not found.';

/** The reviewed system binding of the upload rows (catalog-roles D11). */
function uploadsDb(c: Context<AppEnv>): MediaSql {
  return c.env.ports.catalog.bindSystem('media-uploads') as unknown as MediaSql;
}

/** The size part `n` (1-based) must have (D12). */
export function expectedPartBytes(
  u: Pick<MediaUpload, 'sizeBytes' | 'partSize' | 'partsTotal'>,
  n: number,
): number {
  return n < u.partsTotal ? u.partSize : u.sizeBytes - (u.partsTotal - 1) * u.partSize;
}

async function refuseLowDisk(c: Context<AppEnv>): Promise<void> {
  if ((await c.env.ports.mediaBlobs.freeBytes()) < MEDIA_MIN_FREE_BYTES) {
    throw new ApiError(507, LOW_DISK_DETAIL);
  }
}

/** The caller's open, unexpired upload of this session, else 404 (an upload of another user or
 * session is indistinguishable from an unknown one). */
async function openUpload(
  c: Context<AppEnv>,
  sessionId: string,
  uploadId: string,
): Promise<MediaUpload> {
  const u = await loadUpload(c, sessionId, uploadId);
  if (u.status !== 'open') throw new ApiError(404, UNKNOWN_DETAIL);
  return u;
}

async function loadUpload(
  c: Context<AppEnv>,
  sessionId: string,
  uploadId: string,
): Promise<MediaUpload> {
  const user = requireUser(c);
  if (!/^[A-Za-z0-9-]{1,128}$/.test(uploadId)) throw new ApiError(404, UNKNOWN_DETAIL);
  const u = await mediaUploads.get(uploadsDb(c), uploadId);
  if (
    u === null ||
    u.sessionId !== sessionId ||
    u.createdByUserId !== user.id ||
    u.expiresAtMs <= c.env.ports.clock.now()
  ) {
    throw new ApiError(404, UNKNOWN_DETAIL);
  }
  return u;
}

function statusDict(u: MediaUpload): Record<string, unknown> {
  return {
    upload_id: u.id,
    status: u.status,
    size_bytes: u.sizeBytes,
    part_size: u.partSize,
    parts_total: u.partsTotal,
    received: [...u.received].sort((a, b) => a - b),
    expires_at_utc: isoZ(new Date(u.expiresAtMs)),
  };
}

/** Removes the row and its staging file (an abort). */
async function abortUpload(c: Context<AppEnv>, id: string): Promise<void> {
  await mediaUploads.remove(uploadsDb(c), id);
  await c.env.ports.mediaBlobs.removeStaging(id);
}

audioUploadsRouter.post(BASE, async (c) => {
  const sessionId = c.req.param('sessionId');
  await requireSession(c, sessionId);
  const user = requireUser(c);
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, 'The body must be JSON: { content_type, size_bytes, part_sha256 }.');
  }
  const declared = (raw as { size_bytes?: unknown } | null)?.size_bytes;
  if (typeof declared === 'number' && declared > UPLOAD_MAX_BYTES) {
    throw new ApiError(413, `size_bytes exceeds the ${UPLOAD_MAX_BYTES}-byte limit.`);
  }
  const parsed = audioUploadCreateBodySchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(
      400,
      'content_type must be non-blank, size_bytes a positive integer and part_sha256 a list of 64 lowercase hex.',
    );
  }
  const body = parsed.data;
  const partsTotal = Math.ceil(body.size_bytes / UPLOAD_PART_BYTES);
  if (body.part_sha256.length !== partsTotal) {
    throw new ApiError(
      400,
      `part_sha256 must list exactly ${partsTotal} hashes of ${UPLOAD_PART_BYTES}-byte parts.`,
    );
  }
  await refuseLowDisk(c);
  const now = c.env.ports.clock.now();
  const id = crypto.randomUUID();
  const db = c.env.ports.catalog.bindSystem('media-uploads');
  // The caps and the insert are one transaction under a per-user advisory lock, so two concurrent
  // creates cannot both pass the count (D12).
  const upload = await db.tx(async (t) => {
    await t.all(
      'SELECT pg_advisory_xact_lock(hashtextextended(?, 7719))',
      `media-uploads:${user.id}`,
    );
    const sql = t as unknown as MediaSql;
    const usage = await mediaUploads.openUsage(sql, user.id, now);
    if (usage.count >= UPLOAD_MAX_OPEN_PER_USER) {
      throw new ApiError(429, `At most ${UPLOAD_MAX_OPEN_PER_USER} uploads may be open at once.`);
    }
    if (usage.bytes + body.size_bytes > UPLOAD_MAX_STAGED_BYTES_PER_USER) {
      throw new ApiError(
        429,
        `At most ${UPLOAD_MAX_STAGED_BYTES_PER_USER} bytes may be staged at once.`,
      );
    }
    return mediaUploads.create(sql, {
      id,
      sessionId,
      createdByUserId: user.id,
      contentType: body.content_type.trim(),
      sizeBytes: body.size_bytes,
      partSize: UPLOAD_PART_BYTES,
      partSha256: body.part_sha256,
      nowMs: now,
    });
  });
  try {
    await c.env.ports.mediaBlobs.openStaging(id, body.size_bytes);
  } catch (err) {
    await abortUpload(c, id).catch(() => {});
    throw err;
  }
  return c.json(
    {
      upload_id: upload.id,
      part_size: upload.partSize,
      parts_total: upload.partsTotal,
      expires_at_utc: isoZ(new Date(upload.expiresAtMs)),
    },
    201,
  );
});

/** Hashes a body without writing it (a re-sent part already received keeps its stored bytes). */
async function hashOnly(
  body: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<{ bytes: number; sha256: string }> {
  const h = createHash('sha256');
  let n = 0;
  for await (const chunk of body) {
    n += chunk.byteLength;
    if (n > maxBytes) throw new PartTooLargeError('part too large');
    h.update(chunk);
  }
  return { bytes: n, sha256: h.digest('hex') };
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({ start: (ctl) => ctl.close() });
}

audioUploadsRouter.put(`${BASE}/:uploadId/parts/:n`, async (c) => {
  const sessionId = c.req.param('sessionId');
  await requireSession(c, sessionId);
  const u = await openUpload(c, sessionId, c.req.param('uploadId'));
  const nRaw = c.req.param('n');
  const n = /^\d+$/.test(nRaw) ? Number(nRaw) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < 1 || n > u.partsTotal) {
    throw new ApiError(400, `The part number must be 1 to ${u.partsTotal}.`);
  }
  const expected = expectedPartBytes(u, n);
  const declaredRaw = c.req.header('content-length');
  const declared = declaredRaw !== undefined ? Number(declaredRaw) : null;
  if (declared !== null && Number.isFinite(declared)) {
    if (declared > u.partSize) throw new ApiError(413, `A part is at most ${u.partSize} bytes.`);
    if (declared !== expected)
      throw new ApiError(400, `Part ${n} must be exactly ${expected} bytes.`);
  }
  await refuseLowDisk(c);
  // One reader over the body, so after a refusal the rest can be counted: past part_size is
  // `413`, a body that only overruns the last part's remainder is a wrong size (`400`).
  const reader = (c.req.raw.body ?? emptyStream())[Symbol.asyncIterator]();
  let total = 0;
  const counted: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        const r = await reader.next();
        if (!r.done) total += r.value.byteLength;
        return r;
      },
    }),
  };
  let got: { bytes: number; sha256: string };
  try {
    got = u.received.includes(n)
      ? await hashOnly(counted, u.partSize)
      : await c.env.ports.mediaBlobs.writePart(u.id, (n - 1) * u.partSize, counted, {
          maxBytes: u.partSize,
        });
  } catch (err) {
    if (err instanceof PartTooLargeError) {
      while (total <= u.partSize) {
        const r = await reader.next();
        if (r.done) break;
        total += r.value.byteLength;
      }
      await reader.return?.();
      if (total > u.partSize) throw new ApiError(413, `A part is at most ${u.partSize} bytes.`);
      throw new ApiError(400, `Part ${n} must be exactly ${expected} bytes.`);
    }
    throw err;
  }
  if (got.bytes !== expected)
    throw new ApiError(400, `Part ${n} must be exactly ${expected} bytes.`);
  if (got.sha256 !== u.partSha256[n - 1]) {
    throw new ApiError(400, `Part ${n} does not match its declared sha256; send it again.`);
  }
  if (!(await mediaUploads.recordPart(uploadsDb(c), u.id, n, c.env.ports.clock.now()))) {
    throw new ApiError(404, UNKNOWN_DETAIL);
  }
  return c.body(null, 204);
});

audioUploadsRouter.get(`${BASE}/:uploadId`, async (c) => {
  const sessionId = c.req.param('sessionId');
  await requireSession(c, sessionId);
  return c.json(statusDict(await loadUpload(c, sessionId, c.req.param('uploadId'))));
});

audioUploadsRouter.delete(`${BASE}/:uploadId`, async (c) => {
  const sessionId = c.req.param('sessionId');
  await requireSession(c, sessionId);
  const u = await loadUpload(c, sessionId, c.req.param('uploadId'));
  await abortUpload(c, u.id);
  return c.body(null, 204);
});

audioUploadsRouter.post(`${BASE}/:uploadId/complete`, async (c) => {
  const sessionId = c.req.param('sessionId');
  const sessionRow = await requireSession(c, sessionId);
  const u = await openUpload(c, sessionId, c.req.param('uploadId'));
  const segmentMode = c.req.query('recording_ordinal') !== undefined;

  // Import mode's query and header rules are local-audio-import's, checked before anything else.
  let durationS = 0;
  let seamParts: AudioSeamPart[] = [];
  if (!segmentMode) {
    durationS = parseLocalAudioImportDurationS(c.req.query('duration_s'));
    try {
      seamParts = parseAudioSeamPartsHeader(c.req.header(AUDIO_SEAM_PARTS_HEADER), durationS);
    } catch (err) {
      throw new ApiError(400, err instanceof Error ? err.message : 'Invalid X-Audio-Seam-Parts.');
    }
  }
  const started = segmentMode ? parseOptionalMarkedAt(c.req.query('started_at_utc')) : null;
  const ended = segmentMode ? parseOptionalMarkedAt(c.req.query('ended_at_utc')) : null;

  const received = new Set(u.received);
  const missing: number[] = [];
  for (let n = 1; n <= u.partsTotal; n += 1) if (!received.has(n)) missing.push(n);
  if (missing.length > 0) {
    return c.json(
      { detail: 'Every part must be received before completion.', missing_parts: missing },
      409,
    );
  }

  // The whole-file check the server builds itself (D12): size and every part's re-hash.
  const re = await c.env.ports.mediaBlobs.rehashParts(u.id, u.partSize);
  if (re.size !== u.sizeBytes || re.sha256.join(',') !== u.partSha256.join(',')) {
    await abortUpload(c, u.id);
    throw new ApiError(
      400,
      'The staged file does not match the declared parts; the upload was aborted.',
    );
  }

  if (segmentMode) {
    const seg = await storeLiveSegment(
      c,
      sessionId,
      {
        mimeType: normalizeAudioMimeType(u.contentType),
        startedAtUtc: started,
        endedAtUtc: ended,
        recordingOrdinal: parseRecordingOrdinalQuery(c.req.query('recording_ordinal')),
        bytes: u.sizeBytes,
      },
      (key) => c.env.ports.mediaBlobs.adoptStaging(u.id, key),
    );
    // A replayed window stored nothing: its staging is not needed.
    await c.env.ports.mediaBlobs.removeStaging(u.id);
    await mediaUploads.markComplete(uploadsDb(c), u.id, c.env.ports.clock.now());
    return c.json({ ok: true, segment_id: seg.id });
  }

  // Import mode: exactly local-audio-import's sequence, with the staged file as the bytes.
  const ctx = timecodeCtx(sessionRow);
  if ((await (await getSessionHub(c, sessionId)).statusLive(ctx)).is_rolling) {
    throw new ApiError(409, LOCAL_AUDIO_IMPORT_ROLLING_DETAIL);
  }
  const nowMs = c.env.ports.clock.now();
  const startedAtUtc = isoZ(new Date(nowMs));
  const endedAtUtc = isoZ(new Date(nowMs + durationS * 1000));
  // The staged file becomes the blob under its final key before the row commits (coordinator
  // decision 2026-10-12): a listed row always has its bytes.
  const plan = await (await getSessionHub(c, sessionId)).planAudioSegment(u.contentType);
  await c.env.ports.mediaBlobs.adoptStaging(u.id, plan.r2Key);
  const { segment: seg, recordingOrdinal } = await addImportedAfterBlob(c, sessionId, plan, {
    sessionId,
    mimeType: u.contentType,
    startedAtUtc,
    endedAtUtc,
    inputBytes: u.sizeBytes,
  });
  // The staged bytes are now the segment's blob: the upload is spent, whatever follows.
  await mediaUploads.markComplete(uploadsDb(c), u.id, c.env.ports.clock.now());

  if ((await (await getSessionHub(c, sessionId)).statusLive(ctx)).is_rolling) {
    await rollbackLocalAudioImportSegment(c, sessionId, seg);
    throw new ApiError(409, LOCAL_AUDIO_IMPORT_ROLLING_DETAIL);
  }
  try {
    await (await getSessionHub(c, sessionId)).anchorImportedTake({
      recordingOrdinal,
      durationS,
      ctx,
      startedAtUtc,
    });
    await (await getSessionHub(c, sessionId)).appendAudioSeamParts(seamParts);
  } catch (err) {
    await rollbackLocalAudioImportSegment(c, sessionId, seg);
    if (err instanceof ImportWhileRollingError) {
      throw new ApiError(409, LOCAL_AUDIO_IMPORT_ROLLING_DETAIL);
    }
    throw err;
  }
  return c.json({ ok: true, segment_id: seg.id });
});
