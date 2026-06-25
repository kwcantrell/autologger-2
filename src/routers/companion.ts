// Companion routes — ported from web/routers/companion.py + companion_state.py.
// The Python CompanionHub (in-memory presence + long-poll command queue) becomes:
//   • presence  → short-TTL KV keys (browser heartbeats), scanned to find the
//     freshest visible tab and its active session;
//   • commands  → broadcast over the session DO's WebSocket (the browser executes
//     record/play because it owns the mic), replacing the long-poll relay.
// The thin HTTP endpoints still drive the per-session DO.

import { type Context, Hono } from 'hono';
import { showCategoriesApiShape } from '../db/d1';
import {
  companionCommandAckBodySchema,
  companionCommandBodySchema,
  companionLogBodySchema,
  companionPresenceBodySchema,
  companionTransportBodySchema,
} from '../schemas';
import { enrichEventRpc, mergeCategoryUiSnapshotsIntoMetadata } from '../studio';
import type { AppEnv } from '../types';
import { ApiError, getSessionDO, timecodeCtx } from './_helpers';

export const companionRouter = new Hono<AppEnv>();

const PRESENCE_PREFIX = 'companion:presence:';
const LAST_COMMAND_KEY = 'companion:last_command';
// KV enforces a 60s floor on expirationTtl, so the key lingers up to 60s; logical
// presence freshness (15s, matching the Python hub) is enforced via `updated`.
const PRESENCE_KV_TTL_SEC = 60;
const PRESENCE_FRESH_MS = 15_000;

interface PresenceMeta {
  session_id: string;
  visible: boolean;
  is_playing: boolean;
  updated: number;
}

async function listPresence(kv: KVNamespace): Promise<PresenceMeta[]> {
  const out: PresenceMeta[] = [];
  let cursor: string | undefined;
  do {
    const res = await kv.list<PresenceMeta>({ prefix: PRESENCE_PREFIX, cursor });
    const now = Date.now();
    for (const k of res.keys) {
      if (k.metadata && now - k.metadata.updated <= PRESENCE_FRESH_MS) out.push(k.metadata);
    }
    cursor = res.list_complete ? undefined : res.cursor;
  } while (cursor);
  return out;
}

/** Freshest live presence with a session open, preferring visible tabs (hub.primary). */
async function primarySession(kv: KVNamespace): Promise<string | null> {
  const live = (await listPresence(kv)).filter((p) => p.session_id);
  if (!live.length) return null;
  live.sort((a, b) => {
    const v = (b.visible ? 1 : 0) - (a.visible ? 1 : 0);
    return v !== 0 ? v : b.updated - a.updated;
  });
  return live[0].session_id;
}

async function requireActiveSession(c: Context<AppEnv>): Promise<string> {
  const sid = await primarySession(c.env.AUTH);
  if (!sid || (await c.get('catalog').getSessionIndexRow(sid, { includeHidden: true })) === null) {
    throw new ApiError(409, 'No active session — open AutoLogger in a browser and open a session.');
  }
  return sid;
}

companionRouter.post('/api/companion/presence', async (c) => {
  const body = companionPresenceBodySchema.parse(await c.req.json());
  const cid = body.client_id.trim();
  if (body.closing) {
    await c.env.AUTH.delete(`${PRESENCE_PREFIX}${cid}`);
    return c.json({ ok: true });
  }
  const meta: PresenceMeta = {
    session_id: (body.session_id ?? '').trim(),
    visible: body.visible,
    is_playing: body.is_playing,
    updated: Date.now(),
  };
  await c.env.AUTH.put(`${PRESENCE_PREFIX}${cid}`, '1', {
    expirationTtl: PRESENCE_KV_TTL_SEC,
    metadata: meta,
  });
  return c.json({ ok: true });
});

companionRouter.get('/api/companion/state', async (c) => {
  const catalog = c.get('catalog');
  const presences = await listPresence(c.env.AUTH);
  const activeSid = await primarySession(c.env.AUTH);
  let sessionOut: Record<string, unknown> | null = null;
  let resolvedSid: string | null = activeSid;
  if (activeSid) {
    const row = await catalog.getSessionJoinedRow(activeSid, { includeHidden: true });
    if (row === null) {
      resolvedSid = null;
    } else {
      const stub = getSessionDO(c, activeSid);
      const [live, lease] = await Promise.all([
        stub.statusLive(timecodeCtx(row)),
        stub.leaseStatus(),
      ]);
      const isPlaying = presences.some((p) => p.session_id === activeSid && p.is_playing);
      sessionOut = {
        id: activeSid,
        title: String(row.title ?? ''),
        deck_title: deckTitle(row),
        timecode: live.session_timecode,
        frame_rate: Number(row.frame_rate ?? 24.0),
        is_rolling: live.is_rolling,
        current_take: live.current_take,
        is_recording: lease.lease_alive,
        is_playing: isPlaying,
        logged_event_count: live.logged_event_count,
        events_stream_revision: live.events_stream_revision,
        show_id: (row.show_id as string | null) ?? null,
        show_name: (row.show_name as string | null) ?? null,
        show_code: (row.show_code as string | null) ?? null,
      };
    }
  }
  const lastRaw = await c.env.AUTH.get(LAST_COMMAND_KEY);
  return c.json({
    connected_clients: presences.length,
    active_session_id: resolvedSid,
    session: sessionOut,
    last_command: lastRaw ? JSON.parse(lastRaw) : null,
  });
});

companionRouter.post('/api/companion/log', async (c) => {
  const body = companionLogBodySchema.parse(await c.req.json());
  const sid = await requireActiveSession(c);
  const catalog = c.get('catalog');
  const profile = await catalog.studioProfileForSession(sid);
  let cat = null;
  if (body.category_id?.trim()) {
    cat = profile.categories.find((x) => x.id === body.category_id?.trim()) ?? null;
  }
  if (cat === null && body.category_label?.trim()) {
    const want = body.category_label.trim().toLowerCase();
    cat = profile.categories.find((x) => x.label.trim().toLowerCase() === want) ?? null;
  }
  if (cat === null) {
    throw new ApiError(400, "Unknown category for the active session's show (by id or label).");
  }
  const meta = mergeCategoryUiSnapshotsIntoMetadata({}, cat);
  const row = await catalog.getSessionIndexRow(sid, { includeHidden: true });
  const { event, projection } = await getSessionDO(c, sid).addEvent({
    category: cat.id,
    message: body.message,
    metadataJson: JSON.stringify(meta),
    markedAtUtc: null,
    ctx: timecodeCtx(row as NonNullable<typeof row>),
  });
  await catalog.projectSessionLive(sid, projection);
  return c.json(enrichEventRpc(event, profile));
});

companionRouter.post('/api/companion/transport', async (c) => {
  const body = companionTransportBodySchema.parse(await c.req.json());
  const sid = await requireActiveSession(c);
  const catalog = c.get('catalog');
  const row = await catalog.getSessionIndexRow(sid, { includeHidden: true });
  const ctx = timecodeCtx(row as NonNullable<typeof row>);
  const stub = getSessionDO(c, sid);
  let action: 'start' | 'stop' = body.action === 'start' ? 'start' : 'stop';
  if (body.action === 'toggle') {
    const tr = await stub.transportSnapshot(ctx);
    action = tr.is_rolling ? 'stop' : 'start';
  }
  const { state, projection } =
    action === 'start' ? await stub.startTake(ctx) : await stub.stopTake(ctx);
  await catalog.projectSessionLive(sid, projection);
  return c.json({
    ok: true,
    is_rolling: Boolean(state.is_rolling),
    current_take: Number(state.current_take),
  });
});

companionRouter.post('/api/companion/command', async (c) => {
  const body = companionCommandBodySchema.parse(await c.req.json());
  const sid = await requireActiveSession(c);
  const commandId = crypto.randomUUID();
  await getSessionDO(c, sid).broadcastCommand(body.type);
  await c.env.AUTH.put(
    LAST_COMMAND_KEY,
    JSON.stringify({
      id: commandId,
      type: body.type,
      session_id: sid,
      created_at_utc: new Date().toISOString(),
      delivered_to: null,
      ok: false,
      error: null,
    }),
  );
  return c.json({ ok: true, command_id: commandId, active_session_id: sid });
});

companionRouter.get('/api/companion/categories', async (c) => {
  const sid = await requireActiveSession(c);
  const catalog = c.get('catalog');
  const raw = await catalog.getSessionShowCategories(sid);
  if (raw === null) throw new ApiError(409, 'Active session has no show categories.');
  const row = await catalog.getSessionIndexRow(sid, { includeHidden: true });
  const showId = row ? ((row.show_id as string | null) ?? null) : null;
  return c.json({
    session_id: sid,
    show_id: showId,
    show_name: raw.showName,
    show_code: raw.showCode,
    categories: showCategoriesApiShape(raw.categories),
  });
});

// Long-poll relay is retired in favor of the WebSocket; held open then empty so
// any not-yet-migrated client degrades to a slow poll instead of a tight loop.
companionRouter.get('/api/companion/commands/wait', async (c) => {
  const timeout = Math.min(30, Math.max(0, Number(c.req.query('timeout') ?? 25)));
  await new Promise((r) => setTimeout(r, timeout * 1000));
  return c.json({ commands: [] });
});

companionRouter.post('/api/companion/commands/:commandId/ack', async (c) => {
  const commandId = c.req.param('commandId');
  const body = companionCommandAckBodySchema.parse(await c.req.json());
  const lastRaw = await c.env.AUTH.get(LAST_COMMAND_KEY);
  if (lastRaw) {
    const last = JSON.parse(lastRaw) as Record<string, unknown>;
    if (last.id === commandId) {
      last.ok = body.ok;
      last.error = body.error ?? null;
      last.delivered_to = body.client_id;
      await c.env.AUTH.put(LAST_COMMAND_KEY, JSON.stringify(last));
      return c.json({ ok: true });
    }
  }
  return c.json({ ok: false });
});

function deckTitle(row: Record<string, unknown>): string {
  const sc = String(row.show_code ?? '').trim();
  if (sc) return `${sc} - ${String(row.episode ?? '').trim() || '1'}`;
  const t = String(row.title ?? '').trim();
  return t || '—';
}
