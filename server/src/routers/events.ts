// Events + transport + status routes — ported from web/routers/events.py.
// Each handler resolves the session hub, calls RPC (a hub write commits the
// session's live projection onto the catalog sessions row in its own
// transaction, session-tables design D8), and enriches events in the router
// layer using the show profile (keeping show logic out of the hub).

import { showCategoriesApiShape } from '@autologger/catalog';
import {
  audioRecordingLeaseBodySchema,
  deleteVersionQuerySchema,
  eventGenerateBodySchema,
  eventUpdateBodySchema,
  logBodySchema,
} from '@autologger/contract';
import {
  categoryIsInstructionBearing,
  enrichEventRpc,
  formatSmpte,
  fromTotalFrames,
  isoZ,
  mergeCategoryUiSnapshotsIntoMetadata,
  normalizeEventButtonNameForRelink,
  type StudioProfile,
  sessionDeckDisplayTitle,
  stripCategoryUiSnapshots,
} from '@autologger/domain';
import { type SessionHubFacade, systemCaller } from '@autologger/session-core';
import type { Context } from 'hono';
import { Hono } from 'hono';
import type { AppEnv } from '../appEnv';
import {
  EVENT_GENERATE_FAILURE_DETAIL,
  EVENT_GENERATE_NOT_CONFIGURED_DETAIL,
  EVENT_GENERATE_SESSION_BUSY_DETAIL,
  runEvents,
} from '../generation/events';
import { ApiError } from '../httpError';
import {
  expectedVersion,
  getSessionHub,
  parseOptionalMarkedAt,
  principalOf,
  RUN_FEATURE_FORBIDDEN_DETAIL,
  requireSession,
  timecodeCtx,
  versionConflict,
} from './_helpers';

/** An undo step's hub (session-content-policies D7, owner decision P1): a request whose later step
 * failed, or was refused after a revoke, removes only what it wrote itself (the segment it just
 * created, or the snapshot its regenerate replaced) as the reviewed system task `session-undo`, so
 * the undo cannot itself be refused. */
async function undoHub(c: Context<AppEnv>, sessionId: string): Promise<SessionHubFacade> {
  return (await c.env.ports.sessions.get(sessionId)).as(systemCaller('session-undo'));
}

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
  const raw = await c.get('catalog').sessions.getSessionShowCategories(sessionId);
  if (raw === null) throw new ApiError(404, 'Session or show not found.');
  return c.json({
    categories: showCategoriesApiShape(raw.categories),
    show_name: raw.showName,
    show_code: raw.showCode,
    // Additive top-level boolean (auto-generate-event-logs delta): true iff any
    // of the show's categories is instruction-bearing per the single definition
    // in `categoryIsInstructionBearing`. Computed here in the router — the
    // shared `showCategoriesApiShape` projection (also serving Companion) is
    // deliberately NOT extended, and the `categories` entries carry no
    // instruction fields.
    auto_instructions_present: raw.categories.some(categoryIsInstructionBearing),
  });
});

eventsRouter.get('/api/sessions/:sessionId/status', async (c) => {
  const sessionId = c.req.param('sessionId');
  await requireSession(c, sessionId);
  const catalog = c.get('catalog');
  const row = await catalog.sessions.getSessionJoinedRow(sessionId, { includeHidden: false });
  if (row === null) throw new ApiError(404, 'Session not found.');
  const ctx = timecodeCtx(row);
  const hub = await getSessionHub(c, sessionId);
  const live = await hub.statusLive(ctx);
  const lease = await hub.leaseStatus();

  const now = new Date(c.env.ports.clock.now());
  const startedMs = row.started_at_utc ? Date.parse(String(row.started_at_utc)) : Number.NaN;
  const sec = Number.isNaN(startedMs) ? 0 : Math.max(0, (now.getTime() - startedMs) / 1000);
  const masterTc = fromTotalFrames(Math.round(sec * ctx.frameRate), ctx.frameRate);
  const episode = String(row.episode ?? '');
  const showCode = (row.show_code as string | null) ?? null;
  const deck = sessionDeckDisplayTitle({ storedTitle: String(row.title ?? '') });

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
  const ok = await (await getSessionHub(c, sessionId)).claimLease(body.client_id.trim());
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
  const ok = await (await getSessionHub(c, sessionId)).heartbeatLease(body.client_id.trim());
  return c.json({ ok });
});

eventsRouter.post('/api/sessions/:sessionId/audio-recording-lease/release', async (c) => {
  const sessionId = c.req.param('sessionId');
  await requireSession(c, sessionId);
  const body = audioRecordingLeaseBodySchema.parse(await c.req.json());
  await (await getSessionHub(c, sessionId)).releaseLease(body.client_id.trim());
  return c.json({ ok: true });
});

eventsRouter.post('/api/sessions/:sessionId/transport/start', async (c) => {
  const sessionId = c.req.param('sessionId');
  const row = await requireSession(c, sessionId);
  const { state } = await (await getSessionHub(c, sessionId)).startTake(timecodeCtx(row));
  return c.json(state);
});

eventsRouter.post('/api/sessions/:sessionId/transport/stop', async (c) => {
  const sessionId = c.req.param('sessionId');
  const row = await requireSession(c, sessionId);
  const { state } = await (await getSessionHub(c, sessionId)).stopTake(timecodeCtx(row));
  return c.json(state);
});

eventsRouter.get('/api/sessions/:sessionId/events', async (c) => {
  const sessionId = c.req.param('sessionId');
  await requireSession(c, sessionId);
  const catalog = c.get('catalog');
  const limit = clampInt(c.req.query('limit'), 200, 1, 2000);
  const offset = clampInt(c.req.query('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
  const profile = await catalog.sessions.studioProfileForSession(sessionId);
  const hub = await getSessionHub(c, sessionId);
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
    // event-generate-hardening D1 — computed whole-session (independent of
    // this page's limit/offset), the same predicate the regenerate pre-spawn
    // snapshot uses.
    has_auto_generated: await hub.hasAutoGeneratedEvents(),
  });
});

eventsRouter.post('/api/sessions/:sessionId/events', async (c) => {
  const sessionId = c.req.param('sessionId');
  const row = await requireSession(c, sessionId);
  const body = logBodySchema.parse(await c.req.json());
  const catalog = c.get('catalog');
  const profile = await catalog.sessions.studioProfileForSession(sessionId);
  const validIds = new Set(profile.categories.map((cat) => cat.id));
  if (!validIds.has(body.category) && body.category !== 'internal') {
    throw new ApiError(400, 'Unknown category for this studio profile.');
  }
  // event-metadata-reserved-keys D1/D2 — strip the auto-generation
  // attribution keys unconditionally (both the internal and non-internal
  // category paths below), silently and regardless of the values sent, so a
  // client can never stamp a row as generation-attributed. The size cap
  // (logBodySchema's refine) already ran on the body as sent, pre-strip.
  let meta: Record<string, unknown> = { ...body.metadata };
  for (const key of AUTO_GENERATION_RESERVED_METADATA_KEYS) delete meta[key];
  if (body.category.toLowerCase() !== 'internal') {
    const catDef = profile.categories.find((cat) => cat.id === body.category) ?? null;
    if (catDef !== null) meta = mergeCategoryUiSnapshotsIntoMetadata(meta, catDef);
  }
  const marked = parseOptionalMarkedAt(body.marked_at_utc);
  const { event } = await (await getSessionHub(c, sessionId)).addEvent({
    category: body.category,
    message: body.message,
    metadataJson: JSON.stringify(meta),
    markedAtUtc: marked,
    ctx: timecodeCtx(row),
  });
  return c.json(enrichEventRpc(event, profile));
});

// ── Event auto-generation (auto-generate-event-logs, design D2/D3, task 4.3) ─
// POST …/events/generate — a synchronous JSON route over the shared events runner
// (batch-autogenerate D6, `server/src/generation/events.ts`), which keeps the guard ORDER (spec
// "Gated generation endpoint with pre-spawn preconditions" — nothing spawns, and no MCP
// registration exists, until every guard passes): session 404-mask → body 400 → configuration
// 503 → approval 403 → anchored-transcript 400 → no-instructions 400 →
// aggregate-instruction-bound 400 → shared AI slot 409. The slot is held by the runner and
// released before this handler answers.

/** event-metadata-reserved-keys D2 — the auto-generation attribution keys a
 * client is never allowed to write via the manual events POST. Stripped
 * unconditionally from client-supplied metadata in that handler so the auto
 * predicate below stays server-authoritative. ONE place to extend if
 * generation ever grows more attribution keys (tests pin this constant to
 * superset the predicate’s own key — see events.metadataStrip.test.ts). NOT a
 * general allowlist: every other metadata key remains client-writable. */
export const AUTO_GENERATION_RESERVED_METADATA_KEYS = [
  'auto_generated',
  'auto_generate_run_id',
] as const;

eventsRouter.post('/api/sessions/:sessionId/events/generate', async (c) => {
  const sessionId = c.req.param('sessionId');
  // 1. Session resolution — unknown/out-of-studio masks as 404 before any
  // configuration state below can leak (sibling-route pattern).
  const row = await requireSession(c, sessionId);
  const rawBody = await c.req.text();
  const parsedBody = eventGenerateBodySchema.safeParse(
    rawBody.trim() === '' ? {} : JSON.parse(rawBody),
  );
  if (!parsedBody.success) {
    throw new ApiError(400, 'Invalid event generation request.');
  }
  const body = parsedBody.data;

  const out = await runEvents(principalOf(c), sessionId, {
    row,
    selection: body.selection,
    regenerate: body.regenerate === true,
    // The regenerate's delete of the snapshot it replaced, as the reviewed undo step.
    deleteRegenerateSnapshot: async (ids: string[]) =>
      (await undoHub(c, sessionId)).deleteEventsByIds(ids),
  });
  switch (out.kind) {
    case 'ok':
      return c.json({
        created: out.created,
        cap_hit: out.capHit,
        ...(out.deleted === undefined ? {} : { deleted: out.deleted }),
      });
    case 'unconfigured':
      throw new ApiError(503, EVENT_GENERATE_NOT_CONFIGURED_DETAIL);
    case 'forbidden':
      throw new ApiError(403, RUN_FEATURE_FORBIDDEN_DETAIL);
    case 'precondition':
      throw new ApiError(400, out.detail);
    case 'busy':
      throw new ApiError(409, EVENT_GENERATE_SESSION_BUSY_DETAIL);
    case 'failed':
      throw new ApiError(502, EVENT_GENERATE_FAILURE_DETAIL);
    case 'present':
    case 'stopped':
      // Only a batch step (with `batch` options) ends here.
      throw new Error(`events route: unexpected ${out.kind} outcome`);
  }
});

eventsRouter.put('/api/sessions/:sessionId/events/:eventId', async (c) => {
  const sessionId = c.req.param('sessionId');
  const eventId = c.req.param('eventId');
  const row = await requireSession(c, sessionId);
  const body = eventUpdateBodySchema.parse(await c.req.json());
  const catalog = c.get('catalog');
  const profile = await catalog.sessions.studioProfileForSession(sessionId);
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

  // The stored metadata is read, merged and written in one hub transaction
  // (async-session-hub design D7, S3), so two concurrent edits of one event
  // equal a serial order. A missing event answers 404 from `updateEvent`.
  const mergeMetadata = (storedMetadataJson: string): string => {
    let oldMeta: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(storedMetadataJson || '{}');
      if (parsed && typeof parsed === 'object') oldMeta = parsed as Record<string, unknown>;
    } catch {
      oldMeta = {};
    }
    const meta = { ...oldMeta };
    // FROZEN edge (api-contract-freeze): this `internal` branch is REACHABLE, not
    // dead — category-id validation (validateCategoriesList) reserves no ids, so
    // a studio profile MAY define a category whose id case-insensitively equals
    // 'internal'; the profile-membership 400 above then passes and this branch
    // strips the UI snapshots. The PUT-vs-POST asymmetry is deliberate frozen
    // behavior: POST admits the built-in 'internal' category even when the
    // profile does not define it, PUT requires profile membership first. Do not
    // remove this branch as dead code, and do not align PUT to POST — either is
    // an observable contract change (pinned by events.putInternal.int.test.ts).
    return JSON.stringify(
      body.category.toLowerCase() === 'internal'
        ? stripCategoryUiSnapshots(meta)
        : mergeCategoryUiSnapshotsIntoMetadata(meta, catDef),
    );
  };

  // session-row-versions D4: with a version, a stale event answers 409 with its current row.
  const result = await (await getSessionHub(c, sessionId)).updateEvent({
    eventId,
    category: body.category,
    message: body.message,
    wallTimeUtc: dt,
    timecodeTotalFrames: totalFrames,
    mergeMetadata,
    expect: expectedVersion(body),
  });
  if (result === null) throw new ApiError(404, 'Event not found.');
  if ('conflict' in result) return versionConflict(c, enrichEventRpc(result.conflict, profile));
  return c.json(enrichEventRpc(result.event, profile));
});

eventsRouter.delete('/api/sessions/:sessionId/events/:eventId', async (c) => {
  const sessionId = c.req.param('sessionId');
  const eventId = c.req.param('eventId');
  await requireSession(c, sessionId);
  const query = deleteVersionQuerySchema.parse(c.req.query());
  const result = await (await getSessionHub(c, sessionId)).deleteEvent(
    eventId,
    expectedVersion(query),
  );
  if ('conflict' in result) {
    const profile = await c.get('catalog').sessions.studioProfileForSession(sessionId);
    return versionConflict(c, enrichEventRpc(result.conflict, profile));
  }
  if (!result.ok) throw new ApiError(404, 'Event not found.');
  return c.json({ ok: true });
});

function clampInt(raw: string | undefined, dflt: number, lo: number, hi: number): number {
  if (raw === undefined) return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
}
