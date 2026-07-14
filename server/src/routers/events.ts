// Events + transport + status routes — ported from web/routers/events.py.
// Each handler resolves the session hub, calls RPC, mirrors the returned live
// projection onto the catalog sessions row, and enriches events in the router
// layer using the show profile (keeping show logic out of the hub).

import { Hono } from 'hono';
import { showCategoriesApiShape } from '../db/catalog';
import { audioRecordingLeaseBodySchema, eventUpdateBodySchema, logBodySchema } from '../schemas';
import {
  enrichEventRpc,
  mergeCategoryUiSnapshotsIntoMetadata,
  normalizeEventButtonNameForRelink,
  type StudioProfile,
  stripCategoryUiSnapshots,
} from '../studio';
import { formatSmpte, fromTotalFrames, isoZ } from '../timecode';
import type { AppEnv } from '../types';
import {
  ApiError,
  getSessionHub,
  parseOptionalMarkedAt,
  requireSession,
  timecodeCtx,
} from './_helpers';

export const eventsRouter = new Hono<AppEnv>();

function relinkMaps(profile: StudioProfile): {
  validIds: string[];
  labelToIds: Record<string, string[]>;
} {
  const validIds: string[] = [];
  const labelToIds: Record<string, string[]> = {};
  for (const c of profile.categories) {
    const cid = c.id.trim();
    const name = c.label.trim();
    if (cid) validIds.push(cid);
    if (cid && name) {
      const key = normalizeEventButtonNameForRelink(name);
      if (!labelToIds[key]) labelToIds[key] = [];
      labelToIds[key].push(cid);
    }
  }
  return { validIds, labelToIds };
}

eventsRouter.get('/api/sessions/:sessionId/show-categories', async (c) => {
  const sessionId = c.req.param('sessionId');
  await requireSession(c, sessionId);
  const raw = c.get('catalog').sessions.getSessionShowCategories(sessionId);
  if (raw === null) throw new ApiError(404, 'Session or show not found.');
  return c.json({
    categories: showCategoriesApiShape(raw.categories),
    show_name: raw.showName,
    show_code: raw.showCode,
  });
});

eventsRouter.get('/api/sessions/:sessionId/status', async (c) => {
  const sessionId = c.req.param('sessionId');
  await requireSession(c, sessionId);
  const catalog = c.get('catalog');
  const row = catalog.sessions.getSessionJoinedRow(sessionId, { includeHidden: false });
  if (row === null) throw new ApiError(404, 'Session not found.');
  const ctx = timecodeCtx(row);
  const hub = getSessionHub(c, sessionId);
  const [live, lease] = await Promise.all([hub.statusLive(ctx), hub.leaseStatus()]);

  const now = new Date();
  const startedMs = row.started_at_utc ? Date.parse(String(row.started_at_utc)) : Number.NaN;
  const sec = Number.isNaN(startedMs) ? 0 : Math.max(0, (now.getTime() - startedMs) / 1000);
  const masterTc = fromTotalFrames(Math.round(sec * ctx.frameRate), ctx.frameRate);
  const episode = String(row.episode ?? '');
  const showCode = (row.show_code as string | null) ?? null;
  const deck = sessionDeckFromRow(row, showCode, episode);

  return c.json({
    timecode: live.session_timecode,
    master_timecode: formatSmpte(masterTc),
    session_timecode: live.session_timecode,
    now_utc: isoZ(now),
    session_created_at_utc: row.created_at_utc ? isoZ(new Date(String(row.created_at_utc))) : null,
    frame_rate: ctx.frameRate,
    event_count: live.event_count,
    logged_event_count: live.logged_event_count,
    events_stream_revision: live.events_stream_revision,
    title: String(row.title ?? ''),
    deck_title: deck,
    show_id: (row.show_id as string | null) ?? null,
    show_name: (row.show_name as string | null) ?? null,
    show_code: showCode,
    episode,
    notes: String(row.notes ?? ''),
    is_rolling: live.is_rolling,
    current_take: live.current_take,
    audio_recording_lease_holder_id: lease.holder_client_id,
    audio_recording_lease_alive: lease.lease_alive,
    audio_recording_lease_age_sec: lease.lease_age_sec,
  });
});

eventsRouter.post('/api/sessions/:sessionId/audio-recording-lease', async (c) => {
  const sessionId = c.req.param('sessionId');
  await requireSession(c, sessionId);
  const body = audioRecordingLeaseBodySchema.parse(await c.req.json());
  const ok = await getSessionHub(c, sessionId).claimLease(body.client_id.trim());
  if (!ok) {
    throw new ApiError(
      409,
      'Another window, tab, or user is already recording audio for this session.',
    );
  }
  return c.json({ ok: true });
});

eventsRouter.post('/api/sessions/:sessionId/audio-recording-lease/heartbeat', async (c) => {
  const sessionId = c.req.param('sessionId');
  await requireSession(c, sessionId);
  const body = audioRecordingLeaseBodySchema.parse(await c.req.json());
  const ok = await getSessionHub(c, sessionId).heartbeatLease(body.client_id.trim());
  return c.json({ ok });
});

eventsRouter.post('/api/sessions/:sessionId/audio-recording-lease/release', async (c) => {
  const sessionId = c.req.param('sessionId');
  await requireSession(c, sessionId);
  const body = audioRecordingLeaseBodySchema.parse(await c.req.json());
  await getSessionHub(c, sessionId).releaseLease(body.client_id.trim());
  return c.json({ ok: true });
});

eventsRouter.post('/api/sessions/:sessionId/transport/start', async (c) => {
  const sessionId = c.req.param('sessionId');
  const row = await requireSession(c, sessionId);
  const { state, projection } = await getSessionHub(c, sessionId).startTake(timecodeCtx(row));
  c.get('catalog').sessions.projectSessionLive(sessionId, projection);
  return c.json(state);
});

eventsRouter.post('/api/sessions/:sessionId/transport/stop', async (c) => {
  const sessionId = c.req.param('sessionId');
  const row = await requireSession(c, sessionId);
  const { state, projection } = await getSessionHub(c, sessionId).stopTake(timecodeCtx(row));
  c.get('catalog').sessions.projectSessionLive(sessionId, projection);
  return c.json(state);
});

eventsRouter.get('/api/sessions/:sessionId/events', async (c) => {
  const sessionId = c.req.param('sessionId');
  await requireSession(c, sessionId);
  const catalog = c.get('catalog');
  const limit = clampInt(c.req.query('limit'), 200, 1, 2000);
  const offset = clampInt(c.req.query('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
  const profile = catalog.sessions.studioProfileForSession(sessionId);
  const hub = getSessionHub(c, sessionId);
  if (offset === 0) {
    await hub.maybeRelinkOrphans(relinkMaps(profile));
  }
  const res = await hub.listEvents({ limit, offset });
  return c.json({
    events: res.events.map((e) => enrichEventRpc(e, profile)),
    total: res.total,
    logged_event_count: res.loggedTotal,
    offset,
    limit,
  });
});

eventsRouter.post('/api/sessions/:sessionId/events', async (c) => {
  const sessionId = c.req.param('sessionId');
  const row = await requireSession(c, sessionId);
  const body = logBodySchema.parse(await c.req.json());
  const catalog = c.get('catalog');
  const profile = catalog.sessions.studioProfileForSession(sessionId);
  const validIds = new Set(profile.categories.map((cat) => cat.id));
  if (!validIds.has(body.category) && body.category !== 'internal') {
    throw new ApiError(400, 'Unknown category for this studio profile.');
  }
  let meta: Record<string, unknown> = { ...body.metadata };
  if (body.category.toLowerCase() !== 'internal') {
    const catDef = profile.categories.find((cat) => cat.id === body.category) ?? null;
    if (catDef !== null) meta = mergeCategoryUiSnapshotsIntoMetadata(meta, catDef);
  }
  const marked = parseOptionalMarkedAt(body.marked_at_utc);
  const { event, projection } = await getSessionHub(c, sessionId).addEvent({
    category: body.category,
    message: body.message,
    metadataJson: JSON.stringify(meta),
    markedAtUtc: marked,
    ctx: timecodeCtx(row),
  });
  catalog.sessions.projectSessionLive(sessionId, projection);
  return c.json(enrichEventRpc(event, profile));
});

eventsRouter.put('/api/sessions/:sessionId/events/:eventId', async (c) => {
  const sessionId = c.req.param('sessionId');
  const eventId = c.req.param('eventId');
  const row = await requireSession(c, sessionId);
  const body = eventUpdateBodySchema.parse(await c.req.json());
  const catalog = c.get('catalog');
  const profile = catalog.sessions.studioProfileForSession(sessionId);
  const catDef = profile.categories.find((cat) => cat.id === body.category) ?? null;
  if (catDef === null) throw new ApiError(400, 'Unknown category for this studio profile.');
  const dt = parseOptionalMarkedAt(body.wall_time_utc);
  if (dt === null) throw new ApiError(400, 'wall_time_utc is required.');
  const parts = body.timecode_hms.split(':');
  if (parts.length !== 3 || !parts.every((p) => /^\d+$/.test(p))) {
    throw new ApiError(400, 'timecode_hms must be HH:MM:SS.');
  }
  const [hh, mm, ss] = parts.map((x) => Number(x));
  if (mm > 59 || ss > 59 || hh < 0) throw new ApiError(400, 'Invalid timecode_hms.');
  const fps = Math.round(Number(row.frame_rate));
  const totalFrames = (hh * 3600 + mm * 60 + ss) * fps;

  const hub = getSessionHub(c, sessionId);
  const old = await hub.getEvent(eventId);
  if (old === null) throw new ApiError(404, 'Event not found.');
  let oldMeta: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(old.metadata_json || '{}');
    if (parsed && typeof parsed === 'object') oldMeta = parsed as Record<string, unknown>;
  } catch {
    oldMeta = {};
  }
  let meta = { ...oldMeta };
  if (body.category.toLowerCase() === 'internal') meta = stripCategoryUiSnapshots(meta);
  else meta = mergeCategoryUiSnapshotsIntoMetadata(meta, catDef);

  const result = await hub.updateEvent({
    eventId,
    category: body.category,
    message: body.message,
    wallTimeUtc: dt,
    timecodeTotalFrames: totalFrames,
    metadataJson: JSON.stringify(meta),
  });
  if (result === null) throw new ApiError(404, 'Event not found.');
  catalog.sessions.projectSessionLive(sessionId, result.projection);
  return c.json(enrichEventRpc(result.event, profile));
});

eventsRouter.delete('/api/sessions/:sessionId/events/:eventId', async (c) => {
  const sessionId = c.req.param('sessionId');
  const eventId = c.req.param('eventId');
  await requireSession(c, sessionId);
  const { ok, projection } = await getSessionHub(c, sessionId).deleteEvent(eventId);
  if (!ok) throw new ApiError(404, 'Event not found.');
  c.get('catalog').sessions.projectSessionLive(sessionId, projection);
  return c.json({ ok: true });
});

function clampInt(raw: string | undefined, dflt: number, lo: number, hi: number): number {
  if (raw === undefined) return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
}

function sessionDeckFromRow(
  row: { title?: unknown },
  showCode: string | null,
  episode: string,
): string {
  const sc = String(showCode ?? '').trim();
  if (sc) return `${sc} - ${episode.trim() || '1'}`;
  const t = String(row.title ?? '').trim();
  return t || '—';
}
