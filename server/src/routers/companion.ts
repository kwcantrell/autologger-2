// Companion routes — ported from web/routers/companion.py + companion_state.py.
// The Python CompanionHub (in-memory presence + long-poll command queue) becomes:
//   • presence  → short-TTL KV keys (browser heartbeats), scanned to find the
//     freshest visible tab and its active session;
//   • commands  → broadcast over the session hub's WebSocket (the browser executes
//     record/play because it owns the mic), replacing the long-poll relay.
// The thin HTTP endpoints still drive the per-session hub.

import { type Row, showCategoriesApiShape } from '@autologger/catalog';
import {
  companionCommandAckBodySchema,
  companionCommandBodySchema,
  companionLogBodySchema,
  companionPresenceBodySchema,
  companionTransportBodySchema,
} from '@autologger/contract';
import {
  enrichEventRpc,
  mergeCategoryUiSnapshotsIntoMetadata,
  sessionDeckDisplayTitle,
} from '@autologger/domain';
import type { PresenceRegistry } from '@autologger/ports';
import { type Context, Hono } from 'hono';
import type { AppEnv } from '../appEnv';
import { ApiError, getSessionHub, timecodeCtx } from './_helpers';

export const companionRouter = new Hono<AppEnv>();

// ── /api/companion/state wire payload (server-side declaration) ──────────────
// FROZEN wire shapes (capability spec api-contract-freeze). The Companion
// module mirrors these in companion/src/state.ts — documented mirroring, the
// same pattern as web/src/api/types.ts; keep the copies in sync by hand.
// Companion's `LastCommand` deliberately under-declares `session_id` and
// `created_at_utc`: both ARE sent (written in /api/companion/command below),
// and the extra fields are benign to a structural TS consumer. Do not change
// field names/shapes without an authorizing OpenSpec delta.

interface CompanionSessionState {
  id: string;
  title: string;
  deck_title: string;
  timecode: string;
  frame_rate: number;
  is_rolling: boolean;
  current_take: number;
  is_recording: boolean;
  is_playing: boolean;
  logged_event_count: number;
  events_stream_revision: number;
  show_id: string | null;
  show_name: string | null;
  show_code: string | null;
}

interface CompanionLastCommand {
  id: string;
  type: string;
  session_id: string;
  created_at_utc: string;
  delivered_to: string | null;
  ok: boolean;
  error: string | null;
}

interface CompanionStatePayload {
  connected_clients: number;
  active_session_id: string | null;
  session: CompanionSessionState | null;
  last_command: CompanionLastCommand | null;
}

const LAST_COMMAND_KEY = 'companion:last_command';

/** Freshest live presence with a session open, preferring visible tabs (hub.primary). */
function primarySession(presence: PresenceRegistry): string | null {
  const live = presence.list().filter((p) => p.session_id);
  if (!live.length) return null;
  live.sort((a, b) => {
    const v = (b.visible ? 1 : 0) - (a.visible ? 1 : 0);
    return v !== 0 ? v : b.updated - a.updated;
  });
  return live[0].session_id;
}

/** Resolve the primary session AND its catalog row — callers reuse the row
 *  instead of re-fetching (and non-null-casting) it per handler. */
function requireActiveSession(c: Context<AppEnv>): { sid: string; row: Row } {
  const sid = primarySession(c.env.ports.presence);
  const row = sid
    ? c.get('catalog').sessions.getSessionIndexRow(sid, { includeHidden: true })
    : null;
  if (!sid || row === null) {
    throw new ApiError(409, 'No active session — open AutoLogger in a browser and open a session.');
  }
  return { sid, row };
}

companionRouter.post('/api/companion/presence', async (c) => {
  const body = companionPresenceBodySchema.parse(await c.req.json());
  const cid = body.client_id.trim();
  if (body.closing) {
    c.env.ports.presence.remove(cid);
    return c.json({ ok: true });
  }
  const meta = {
    session_id: (body.session_id ?? '').trim(),
    visible: body.visible,
    is_playing: body.is_playing,
    updated: c.env.ports.clock.now(),
  };
  c.env.ports.presence.upsert(cid, meta);
  return c.json({ ok: true });
});

companionRouter.get('/api/companion/state', async (c) => {
  const catalog = c.get('catalog');
  const presences = c.env.ports.presence.list();
  const activeSid = primarySession(c.env.ports.presence);
  let sessionOut: CompanionSessionState | null = null;
  let resolvedSid: string | null = activeSid;
  if (activeSid) {
    const row = catalog.sessions.getSessionJoinedRow(activeSid, { includeHidden: true });
    if (row === null) {
      resolvedSid = null;
    } else {
      const hub = getSessionHub(c, activeSid);
      const live = hub.statusLive(timecodeCtx(row));
      const lease = hub.leaseStatus();
      const isPlaying = presences.some((p) => p.session_id === activeSid && p.is_playing);
      sessionOut = {
        id: activeSid,
        title: String(row.title ?? ''),
        deck_title: sessionDeckDisplayTitle({ storedTitle: String(row.title ?? '') }),
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
  const lastRaw = c.env.ports.kv.get(LAST_COMMAND_KEY);
  const payload: CompanionStatePayload = {
    connected_clients: presences.length,
    active_session_id: resolvedSid,
    session: sessionOut,
    last_command: lastRaw ? (JSON.parse(lastRaw) as CompanionLastCommand) : null,
  };
  return c.json(payload);
});

companionRouter.post('/api/companion/log', async (c) => {
  const body = companionLogBodySchema.parse(await c.req.json());
  const { sid, row } = requireActiveSession(c);
  const catalog = c.get('catalog');
  const profile = catalog.sessions.studioProfileForSession(sid);
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
  const { event, projection } = getSessionHub(c, sid).addEvent({
    category: cat.id,
    message: body.message,
    metadataJson: JSON.stringify(meta),
    markedAtUtc: null,
    ctx: timecodeCtx(row),
  });
  catalog.sessions.projectSessionLive(sid, projection);
  return c.json(enrichEventRpc(event, profile));
});

companionRouter.post('/api/companion/transport', async (c) => {
  const body = companionTransportBodySchema.parse(await c.req.json());
  const { sid, row } = requireActiveSession(c);
  const catalog = c.get('catalog');
  const ctx = timecodeCtx(row);
  const hub = getSessionHub(c, sid);
  let action: 'start' | 'stop' = body.action === 'start' ? 'start' : 'stop';
  if (body.action === 'toggle') {
    const tr = hub.transportSnapshot(ctx);
    action = tr.is_rolling ? 'stop' : 'start';
  }
  const { state, projection } = action === 'start' ? hub.startTake(ctx) : hub.stopTake(ctx);
  catalog.sessions.projectSessionLive(sid, projection);
  return c.json({
    ok: true,
    is_rolling: Boolean(state.is_rolling),
    current_take: Number(state.current_take),
  });
});

companionRouter.post('/api/companion/command', async (c) => {
  const body = companionCommandBodySchema.parse(await c.req.json());
  const { sid } = requireActiveSession(c);
  const commandId = crypto.randomUUID();
  getSessionHub(c, sid).broadcastCommand(body.type);
  const last: CompanionLastCommand = {
    id: commandId,
    type: body.type,
    session_id: sid,
    created_at_utc: new Date(c.env.ports.clock.now()).toISOString(),
    delivered_to: null,
    ok: false,
    error: null,
  };
  c.env.ports.kv.put(LAST_COMMAND_KEY, JSON.stringify(last));
  return c.json({ ok: true, command_id: commandId, active_session_id: sid });
});

companionRouter.get('/api/companion/categories', async (c) => {
  const { sid, row } = requireActiveSession(c);
  const catalog = c.get('catalog');
  const raw = catalog.sessions.getSessionShowCategories(sid);
  if (raw === null) throw new ApiError(409, 'Active session has no show categories.');
  const showId = (row.show_id as string | null) ?? null;
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
  const lastRaw = c.env.ports.kv.get(LAST_COMMAND_KEY);
  if (lastRaw) {
    const last = JSON.parse(lastRaw) as CompanionLastCommand;
    if (last.id === commandId) {
      last.ok = body.ok;
      last.error = body.error ?? null;
      last.delivered_to = body.client_id;
      c.env.ports.kv.put(LAST_COMMAND_KEY, JSON.stringify(last));
      return c.json({ ok: true });
    }
  }
  return c.json({ ok: false });
});
