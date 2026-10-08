// Companion routes — ported from web/routers/companion.py + companion_state.py.
// The Python CompanionHub (in-memory presence + long-poll command queue) becomes:
//   • presence  → the caller's own fresh rows in the shared presence table (browser
//     heartbeats, companion-devices D4), scanned for the freshest visible tab's session;
//   • commands  → broadcast over the session hub's WebSocket (the browser executes
//     record/play because it owns the mic), replacing the long-poll relay.
// The thin HTTP endpoints still drive the per-session hub. Every route runs as a user: the
// signed-in user, or a Companion device's user (companion-devices D3).

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
import type { PresenceRow } from '@autologger/ports';
import type { SessionHubFacade } from '@autologger/session-core';
import { SessionAccessDeniedError } from '@autologger/storage';
import { type Context, Hono } from 'hono';
import type { AppEnv } from '../appEnv';
import { ApiError } from '../httpError';
import {
  canAccessSession,
  getSessionHub,
  requireSession,
  requireUser,
  timecodeCtx,
} from './_helpers';

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

/** The calling device's last-command key (companion-devices D3, owner decision 6), or null for a
 * cookie caller, which has no device: its commands are delivered but recorded under no key. */
function lastCommandKey(c: Context<AppEnv>): string | null {
  const device = c.get('companionDevice');
  return device === null ? null : `companion:last_command:${device.id}`;
}

/** The active session among the caller's own presence rows (companion-devices D3): rows with a
 * session open, visible first, then freshest. Takes one presence snapshot so callers derive every
 * value from the same list. */
function primarySession(presences: PresenceRow[]): string | null {
  const live = presences.filter((p) => p.session_id);
  if (!live.length) return null;
  live.sort((a, b) => {
    const v = (b.visible ? 1 : 0) - (a.visible ? 1 : 0);
    return v !== 0 ? v : b.updated - a.updated;
  });
  return live[0].session_id;
}

/** The caller's own fresh presence rows: the signed-in user's, or the device's user's (every
 * Companion request has a user, companion-devices D2/D3). */
function ownPresences(c: Context<AppEnv>): Promise<PresenceRow[]> {
  return c.env.ports.presence.list(requireUser(c).id);
}

const NO_ACTIVE_SESSION_DETAIL =
  'No active session — open AutoLogger in a browser and open a session.';

/** A hub call refused for missing access after `requireActiveSession` (session-content-policies
 * D8) answers the no-active-session `409`, as the check itself would. */
async function activeSessionCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof SessionAccessDeniedError) throw new ApiError(409, NO_ACTIVE_SESSION_DETAIL);
    throw err;
  }
}

/** Resolve the primary session AND its catalog row — callers reuse the row instead of
 * re-fetching it per handler. A caller who can't access the session their own presence names
 * gets exactly the no-active-session answer (show-grants D10, companion-devices D3), so its
 * existence doesn't leak. */
async function requireActiveSession(c: Context<AppEnv>): Promise<{ sid: string; row: Row }> {
  const sid = primarySession(await ownPresences(c));
  const row = sid
    ? await c.get('catalog').sessions.getSessionIndexRow(sid, { includeHidden: true })
    : null;
  if (!sid || row === null || !(await canAccessSession(c, sid))) {
    throw new ApiError(409, NO_ACTIVE_SESSION_DETAIL);
  }
  return { sid, row };
}

const DEVICE_PRESENCE_DETAIL =
  'Presence is posted by the AutoLogger browser app, not by a Companion device.';
const NUL_DETAIL = 'Text must not contain NUL characters.';

companionRouter.post('/api/companion/presence', async (c) => {
  // Presence comes from the browser (companion-devices D3, owner decision 7): a device caller is
  // refused first, before the body is read or anything is written.
  if (c.get('companionDevice') !== null) throw new ApiError(403, DEVICE_PRESENCE_DETAIL);
  const user = requireUser(c);
  const body = companionPresenceBodySchema.parse(await c.req.json());
  const cid = body.client_id.trim();
  // A NUL can't be stored (catalog-on-postgres D5) and a blank id would fail the table's check
  // (a 500): both are refused before any write, closing included.
  if (cid.includes('\u0000') || body.session_id?.includes('\u0000')) {
    throw new ApiError(400, NUL_DETAIL);
  }
  if (!cid) throw new ApiError(400, 'client_id must not be blank.');
  if (body.closing) {
    // Deletes only the caller's own row (companion-devices D3/D4); another user's is untouched.
    await c.env.ports.presence.remove(cid, user.id);
    return c.json({ ok: true });
  }
  const sessionId = (body.session_id ?? '').trim();
  // The caller may only point presence at a session they can access (show-grants D10); a session
  // they can't access and one that doesn't exist get the same masked 404, and nothing is stored.
  if (sessionId) await requireSession(c, sessionId, { includeHidden: true });
  // An upsert for a live row another user owns changes nothing and still answers 200 (the port's
  // ownership rule, companion-devices D4), so the answer reveals nothing about other users' rows.
  await c.env.ports.presence.upsert(cid, {
    user_id: user.id,
    session_id: sessionId || null,
    visible: body.visible,
    is_playing: body.is_playing,
    updated: c.env.ports.clock.now(),
  });
  return c.json({ ok: true });
});

companionRouter.get('/api/companion/state', async (c) => {
  const catalog = c.get('catalog');
  const presences = await ownPresences(c);
  const activeSid = primarySession(presences);
  let sessionOut: CompanionSessionState | null = null;
  let resolvedSid: string | null = activeSid;
  // A caller without access to the session their own presence names sees none (show-grants D10,
  // companion-devices D3).
  if (activeSid && !(await canAccessSession(c, activeSid))) resolvedSid = null;
  if (resolvedSid !== null && activeSid) {
    const row = await catalog.sessions.getSessionJoinedRow(activeSid, { includeHidden: true });
    if (row === null) {
      resolvedSid = null;
    } else {
      const hub = await getSessionHub(c, activeSid);
      let status:
        | [
            Awaited<ReturnType<SessionHubFacade['statusLive']>>,
            Awaited<ReturnType<SessionHubFacade['leaseStatus']>>,
          ]
        | null;
      try {
        status = [await hub.statusLive(timecodeCtx(row)), await hub.leaseStatus()];
      } catch (err) {
        // A refusal for missing access (session-content-policies D8) is "cannot see the active
        // session": the masked answer, not an error.
        if (!(err instanceof SessionAccessDeniedError)) throw err;
        status = null;
      }
      if (status === null) {
        resolvedSid = null;
      } else {
        const [live, lease] = status;
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
  }
  // The calling device's own last command; a cookie caller has none (companion-devices D3).
  const key = lastCommandKey(c);
  const lastRaw = key === null ? null : await c.env.ports.kv.get(key);
  let lastCommand = lastRaw ? (JSON.parse(lastRaw) as CompanionLastCommand) : null;
  // The last command names its session: hidden from a caller who can't access it.
  if (lastCommand !== null && !(await canAccessSession(c, lastCommand.session_id))) {
    lastCommand = null;
  }
  const payload: CompanionStatePayload = {
    connected_clients: presences.length,
    active_session_id: resolvedSid,
    session: sessionOut,
    last_command: lastCommand,
  };
  return c.json(payload);
});

companionRouter.post('/api/companion/log', async (c) => {
  const body = companionLogBodySchema.parse(await c.req.json());
  const { sid, row } = await requireActiveSession(c);
  const catalog = c.get('catalog');
  const profile = await catalog.sessions.studioProfileForSession(sid);
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
  const { event } = await activeSessionCall(async () =>
    (await getSessionHub(c, sid)).addEvent({
      category: cat.id,
      message: body.message,
      metadataJson: JSON.stringify(meta),
      markedAtUtc: null,
      ctx: timecodeCtx(row),
    }),
  );
  return c.json(enrichEventRpc(event, profile));
});

companionRouter.post('/api/companion/transport', async (c) => {
  const body = companionTransportBodySchema.parse(await c.req.json());
  const { sid, row } = await requireActiveSession(c);
  const ctx = timecodeCtx(row);
  const hub = await getSessionHub(c, sid);
  // A toggle reads the transport and starts or stops the take in one hub transaction
  // (async-session-hub design D7, S6), so two concurrent toggles equal a serial order.
  const { state } = await activeSessionCall(() =>
    body.action === 'toggle'
      ? hub.toggleTake(ctx)
      : body.action === 'start'
        ? hub.startTake(ctx)
        : hub.stopTake(ctx),
  );
  return c.json({
    ok: true,
    is_rolling: Boolean(state.is_rolling),
    current_take: Number(state.current_take),
  });
});

companionRouter.post('/api/companion/command', async (c) => {
  const body = companionCommandBodySchema.parse(await c.req.json());
  const { sid } = await requireActiveSession(c);
  const commandId = crypto.randomUUID();
  const last: CompanionLastCommand = {
    id: commandId,
    type: body.type,
    session_id: sid,
    created_at_utc: new Date(c.env.ports.clock.now()).toISOString(),
    delivered_to: null,
    ok: false,
    error: null,
  };
  // Stored under the calling device's key before the broadcast, so a fast ack always finds it
  // (async-session-callers D5). A cookie caller's command is delivered but recorded under no key
  // (companion-devices D3).
  const key = lastCommandKey(c);
  if (key !== null) await c.env.ports.kv.put(key, JSON.stringify(last));
  (await getSessionHub(c, sid)).broadcastCommand(body.type);
  return c.json({ ok: true, command_id: commandId, active_session_id: sid });
});

companionRouter.get('/api/companion/categories', async (c) => {
  const { sid, row } = await requireActiveSession(c);
  const catalog = c.get('catalog');
  const raw = await catalog.sessions.getSessionShowCategories(sid);
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
  // Matched only against the calling device's own last command; a cookie caller has none.
  const key = lastCommandKey(c);
  const lastRaw = key === null ? null : await c.env.ports.kv.get(key);
  if (key !== null && lastRaw) {
    const last = JSON.parse(lastRaw) as CompanionLastCommand;
    if (last.id === commandId) {
      last.ok = body.ok;
      last.error = body.error ?? null;
      last.delivered_to = body.client_id;
      // Only while A is still the latest command: a newer one stored meanwhile wins, and this ack
      // gets the superseded-command answer (catalog-concurrency-hazards D7).
      const marked = await c.env.ports.kv.replaceIf(key, lastRaw, JSON.stringify(last));
      return c.json({ ok: marked });
    }
  }
  return c.json({ ok: false });
});
