// Audio routes — ported from web/routers/audio.py. Bytes live in R2 keyed
// `audio/<session_id>/<ordinal>_<uuid>.<ext>`; segment metadata lives in the
// SessionDO. Upload streams to R2 then records metadata; download streams R2
// back with HTTP range support (audio scrubbing).

import { Hono } from 'hono';
import type { AudioSegmentMeta } from '../durable/SessionDO';
import { audioSegmentWaveformBodySchema } from '../schemas';
import type { AppEnv } from '../types';
import { ApiError, getSessionDO, parseOptionalMarkedAt, requireSession } from './_helpers';

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

audioRouter.get('/api/sessions/:sessionId/audio/segments', async (c) => {
  const sessionId = c.req.param('sessionId');
  await requireSession(c, sessionId);
  const segs = await getSessionDO(c, sessionId).listAudioSegments();
  return c.json({
    segments: segs.map((s) => segmentApiDict(sessionId, s)),
    has_audio: segs.length > 0,
  });
});

audioRouter.post('/api/sessions/:sessionId/audio/segments', async (c) => {
  const sessionId = c.req.param('sessionId');
  await requireSession(c, sessionId);
  const payload = await c.req.arrayBuffer();
  if (payload.byteLength === 0) throw new ApiError(400, 'Audio payload is empty.');
  const mime = c.req.header('content-type') ?? 'audio/webm';
  const started = parseOptionalMarkedAt(c.req.query('started_at_utc'));
  const ended = parseOptionalMarkedAt(c.req.query('ended_at_utc'));
  const roRaw = c.req.query('recording_ordinal');
  const recordingOrdinal = roRaw !== undefined && /^\d+$/.test(roRaw) ? Number(roRaw) : null;

  const seg = await getSessionDO(c, sessionId).addAudioSegment({
    sessionId,
    mimeType: mime,
    startedAtUtc: started,
    endedAtUtc: ended,
    recordingOrdinal,
  });
  try {
    await c.env.AUDIO.put(seg.r2_key, payload, { httpMetadata: { contentType: seg.mime_type } });
  } catch (e) {
    // Roll back the dangling metadata row if the bytes never landed.
    await getSessionDO(c, sessionId).deleteAudioSegment(seg.id);
    throw e;
  }
  return c.json(segmentApiDict(sessionId, seg));
});

audioRouter.post('/api/sessions/:sessionId/audio/segments/sync-from-disk', async (c) => {
  const sessionId = c.req.param('sessionId');
  await requireSession(c, sessionId);
  const prefix = `audio/${sessionId}/`;
  const known: Array<{ r2_key: string; ordinal: number }> = [];
  let cursor: string | undefined;
  do {
    const listed = await c.env.AUDIO.list({ prefix, cursor });
    for (const obj of listed.objects) {
      const m = /\/(\d{4})_/.exec(obj.key);
      if (m) known.push({ r2_key: obj.key, ordinal: Number(m[1]) });
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  const stub = getSessionDO(c, sessionId);
  const out = await stub.syncAudioFromR2(known);
  const segs = await stub.listAudioSegments();
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
  await requireSession(c, sessionId);
  const got = await getSessionDO(c, sessionId).getAudioSegmentKey(segmentId);
  if (got === null) throw new ApiError(404, 'Audio segment not found.');

  const rangeHeader = c.req.header('range');
  if (rangeHeader) {
    const parsed = parseRange(rangeHeader);
    const obj = await c.env.AUDIO.get(got.r2_key, parsed ? { range: parsed } : undefined);
    if (obj === null) throw new ApiError(404, 'Audio segment not found.');
    const size = obj.size;
    const r = obj.range;
    let start = 0;
    let length = size;
    if (r && 'offset' in r) {
      start = r.offset ?? 0;
      length = r.length ?? size - start;
    } else if (r && 'suffix' in r) {
      length = r.suffix;
      start = size - length;
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

  const obj = await c.env.AUDIO.get(got.r2_key);
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
  await requireSession(c, sessionId);
  const body = audioSegmentWaveformBodySchema.parse(await c.req.json());
  for (const x of body.peaks) {
    if (!Number.isFinite(x) || x < -0.02 || x > 1.02) {
      throw new ApiError(400, 'waveform peaks must be in [0, 1].');
    }
  }
  const ok = await getSessionDO(c, sessionId).setAudioSegmentWaveform({
    segmentId,
    peaks: body.peaks,
  });
  if (!ok) throw new ApiError(404, 'Audio segment not found.');
  return c.json({ ok: true });
});

/** Parse a single `bytes=start-end` range into R2's range form. */
function parseRange(header: string): R2Range | null {
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
