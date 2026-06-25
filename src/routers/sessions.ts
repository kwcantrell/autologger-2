// Sessions routes — ported from web/routers/sessions.py. Listing + metadata are
// pure D1 (no DO wake); create initializes the D1 index row and the SessionDO.
// YouTube import is a 503 stub on this deployment (phase 6 decision).

import { Hono } from 'hono';
import type { Row } from '../db/d1';
import { oauthConfigured } from '../env';
import { newSessionBodySchema, sessionUpdateBodySchema } from '../schemas';
import { SETTING_ACTIVE_SHOW, sessionDeckDisplayTitle, ValidationError } from '../studio';
import { formatRuntimeHms, formatSmpte, isoZ, toTotalFrames, transportTimecode } from '../timecode';
import type { AppEnv } from '../types';
import { ApiError, getSessionDO, requireSession } from './_helpers';

export const sessionsRouter = new Hono<AppEnv>();

function sessionStatusUi(row: Row): string {
  if (Number(row.ui_hidden ?? 0)) return 'deleted';
  if (Number(row.archived ?? 0)) return 'archived';
  return 'active';
}

/** _list_runtime_total_frames — max of last logged timecode vs transport. */
function listRuntimeTotalFrames(row: Row, transportTotalFrames: number): number {
  const evMax = Math.max(0, Number(row.max_timecode_total_frames ?? 0));
  const trTf = Math.max(0, transportTotalFrames);
  if (Number(row.is_rolling ?? 0)) return Math.max(evMax, trTf);
  if (evMax > 0) return Math.max(evMax, trTf);
  return 0;
}

sessionsRouter.get('/api/sessions', async (c) => {
  const catalog = c.get('catalog');
  const user = c.get('user');
  const active = await catalog.getEffectiveStudioForUser(user, oauthConfigured(c.env));
  if (active === null) return c.json({ active: [], archived: [] });

  const shows = await catalog.listShowsForStudio(active.id);
  const validShowIds = new Set(shows.map((r) => String(r.id)));
  let rawActiveShow = '';
  if (user === null) {
    rawActiveShow = String((await catalog.getSetting(SETTING_ACTIVE_SHOW)) ?? '').trim();
  } else {
    const prow = await catalog.authGetPrefs(user.id);
    rawActiveShow = prow ? String(prow.active_show_id ?? '').trim() : '';
  }
  let activeShowId = validShowIds.has(rawActiveShow) ? rawActiveShow : '';
  if (!activeShowId && shows.length) {
    activeShowId = String(shows[0].id);
    if (user === null) await catalog.setSetting(SETTING_ACTIVE_SHOW, activeShowId);
    else await catalog.authSetPrefs(user.id, active.id, activeShowId);
  }
  if (!activeShowId) return c.json({ active: [], archived: [] });

  const activeRows: Record<string, unknown>[] = [];
  const archivedRows: Record<string, unknown>[] = [];
  for (const s of await catalog.listSessionsForShow(activeShowId)) {
    const frameRate = Number(s.frame_rate ?? 24.0);
    const startOffset = Number(s.start_offset_frames ?? 0);
    const isRolling = Boolean(Number(s.is_rolling ?? 0));
    const tc = transportTimecode(
      frameRate,
      startOffset,
      {
        is_rolling: isRolling,
        elapsed_frames: Number(s.transport_elapsed_frames ?? 0),
        roll_started_at_utc: (s.roll_started_at_utc as string | null) ?? null,
      },
      Date.now(),
    );
    const trTotal = toTotalFrames(tc);
    const rtFrames = listRuntimeTotalFrames(s, trTotal);
    const ep = String(s.episode ?? '').trim();
    const archived = Boolean(Number(s.archived ?? 0));
    const row = {
      id: String(s.id),
      title: String(s.title ?? ''),
      deck_title: sessionDeckDisplayTitle({
        showCode: s.show_code as string | null,
        episode: ep,
        storedTitle: String(s.title ?? ''),
      }),
      show_id: (s.show_id as string | null) ?? null,
      show_code: (s.show_code as string | null) ?? null,
      show_name: (s.show_name as string | null) ?? null,
      episode: ep,
      notes: String(s.notes ?? ''),
      session_status: sessionStatusUi(s),
      frame_rate: frameRate,
      start_offset_frames: startOffset,
      created_at_utc: s.created_at_utc ? isoZ(new Date(String(s.created_at_utc))) : null,
      episode_date: (s.episode_date as string | null) ?? null,
      event_count: Number(s.event_count ?? 0),
      is_rolling: isRolling,
      current_take: Number(s.current_take ?? 0),
      rolling_timecode: formatSmpte(tc),
      total_runtime_hms: formatRuntimeHms(rtFrames, frameRate),
      archived,
    };
    if (archived) archivedRows.push(row);
    else activeRows.push(row);
  }
  return c.json({ active: activeRows, archived: archivedRows });
});

sessionsRouter.post('/api/sessions', async (c) => {
  const catalog = c.get('catalog');
  const user = c.get('user');
  const body = newSessionBodySchema.parse(await c.req.json());
  const active = await catalog.getEffectiveStudioForUser(user, oauthConfigured(c.env));
  if (active === null) throw new ApiError(403, 'No team access.');

  const showRow = await catalog.getShowRow(body.show_id.trim());
  if (showRow === null) throw new ApiError(400, 'Unknown show_id.');
  if (String(showRow.studio_id) !== active.id) {
    throw new ApiError(400, 'Show does not belong to the active team.');
  }

  const episode = body.episode.trim() || '1';
  const notes = (body.notes ?? '').trim();
  const showCode = String(showRow.show_code ?? '').trim();
  const title =
    (body.title ?? '').trim() || sessionDeckDisplayTitle({ showCode, episode, storedTitle: '' });
  const now = isoZ(new Date());
  const id = await catalog.createSessionIndex({
    showId: body.show_id.trim(),
    title,
    frameRate: body.frame_rate,
    startOffsetFrames: body.start_offset_frames,
    episode,
    notes,
    startedAtUtc: now,
    createdAtUtc: now,
  });
  // Instantiate the DO so its transport row exists.
  await getSessionDO(c, id).ensure();
  return c.json({
    id,
    title,
    frame_rate: body.frame_rate,
    start_offset_frames: body.start_offset_frames,
    show_id: body.show_id.trim(),
    episode,
    notes,
  });
});

sessionsRouter.put('/api/sessions/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId');
  await requireSession(c, sessionId);
  const body = sessionUpdateBodySchema.parse(await c.req.json());
  const catalog = c.get('catalog');
  let row: Row | null;
  try {
    row = await catalog.updateSessionIndex(sessionId, {
      title: body.title,
      startOffsetFrames: body.start_offset_frames,
    });
  } catch (e) {
    if (e instanceof ValidationError) throw new ApiError(400, e.message);
    throw e;
  }
  if (row === null) throw new ApiError(404, 'Session not found');
  return c.json({
    id: String(row.id),
    title: String(row.title),
    frame_rate: Number(row.frame_rate),
    start_offset_frames: Number(row.start_offset_frames ?? 0),
  });
});

sessionsRouter.post('/api/sessions/:sessionId/archive', async (c) => {
  const sessionId = c.req.param('sessionId');
  await requireSession(c, sessionId);
  if (!(await c.get('catalog').setSessionArchived(sessionId, true))) {
    throw new ApiError(404, 'Session not found');
  }
  return c.json({ ok: true, archived: true });
});

sessionsRouter.post('/api/sessions/:sessionId/restore', async (c) => {
  const sessionId = c.req.param('sessionId');
  await requireSession(c, sessionId);
  if (!(await c.get('catalog').setSessionArchived(sessionId, false))) {
    throw new ApiError(404, 'Session not found');
  }
  return c.json({ ok: true, archived: false });
});

sessionsRouter.delete('/api/sessions/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId');
  await requireSession(c, sessionId, { includeHidden: true });
  if (!(await c.get('catalog').setSessionUiHidden(sessionId, true))) {
    throw new ApiError(404, 'Session not found');
  }
  return c.json({ ok: true, hidden: true });
});

// YouTube import is unavailable on this deployment (no yt-dlp / Workers AI box).
sessionsRouter.post('/api/sessions/:sessionId/youtube-import', async (c) => {
  await requireSession(c, c.req.param('sessionId'));
  throw new ApiError(503, 'YouTube import is unavailable on this deployment.');
});
