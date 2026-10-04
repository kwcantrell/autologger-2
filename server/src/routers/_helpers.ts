// Shared router helpers — the session and show access gates (_session_access_gate,
// requireShowAccess, canAccessSession; show-grants D3), closing sockets after access is lost
// (closeSocketsAfterAccessLoss; show-grants D20), per-session hub resolution, timecode context,
// and marked-at parsing.

import type { AuthUser, CatalogFacade, Row } from '@autologger/catalog';
import {
  type SessionCaller,
  type SessionHubFacade,
  type TimecodeCtx,
  userCaller,
} from '@autologger/session-core';
import type { Context } from 'hono';
import type { AppEnv } from '../appEnv';
import { ApiError } from '../httpError';

export function timecodeCtx(row: Row): TimecodeCtx {
  return {
    frameRate: Number(row.frame_rate ?? 24.0),
    startOffsetFrames: Number(row.start_offset_frames ?? 0),
  };
}

/** The signed-in route's session caller (session-content-policies D7): every hub call it makes
 * runs as its user, under the database's content policies. */
export function sessionCaller(c: Context<AppEnv>): SessionCaller {
  return userCaller(requireUser(c).id);
}

/** Resolve the in-process per-session hub (addressed by session id), bound to the signed-in
 * caller (session-content-policies D7); the first `get` of a session opens it. A handler may use
 * the hub across its own hub calls, and re-resolves it after a long non-hub `await` (an AI turn,
 * a download), since an idle hub can be evicted meanwhile (async-session-hub design D6). */
export async function getSessionHub(
  c: Context<AppEnv>,
  sessionId: string,
): Promise<SessionHubFacade> {
  return (await c.env.ports.sessions.get(sessionId)).as(sessionCaller(c));
}

/** A route that needs a signed-in user ran without one. The authContext middleware makes the one
 * login decision (401) before any such route, so this is an invariant violation: the error
 * handler answers 500 and logs it (require-login D3), never a second 401. */
export class MissingPrincipalError extends Error {
  override name = 'MissingPrincipalError';
  constructor() {
    super('route reached without a signed-in user (the login gate should have answered 401)');
  }
}

/** The signed-in user. Asserts the principal the middleware already required; it makes no login
 * decision of its own (core-ports-architecture: the login check is not duplicated). */
export function requireUser(c: Context<AppEnv>): AuthUser {
  const user = c.get('user');
  if (user === null) throw new MissingPrincipalError();
  return user;
}

/** _session_access_gate — existence + show access (show-grants D3). Returns the catalog row.
 * Authentication (the unauthenticated-401 decision) happens once, in the authContext middleware via
 * apiRequestRequiresLogin — every caller of this helper is an /api/ route that middleware already
 * gates. Authorization is the show access rule (`authCanAccessShow`: owner or admin of the show's
 * team, or a member with a grant for the show). A nonexistent session, a session with no show, a
 * foreign team's session and an ungranted member's session all get the same masked
 * `404 Session not found`, so the existence oracle stays closed. */
export async function requireSession(
  c: Context<AppEnv>,
  sessionId: string,
  opts: { includeHidden?: boolean } = {},
): Promise<Row> {
  const user = requireUser(c);
  const catalog = c.get('catalog');
  const row = await catalog.sessions.getSessionIndexRow(sessionId, {
    includeHidden: opts.includeHidden,
  });
  if (row === null) throw new ApiError(404, 'Session not found');
  const showId = row.show_id == null ? '' : String(row.show_id);
  if (!showId || !(await catalog.auth.authCanAccessShow(user.id, showId))) {
    throw new ApiError(404, 'Session not found');
  }
  return row;
}

/** The show-scoped gate (show-grants D3): the show row when the signed-in user can access the
 * show; a nonexistent show and a show the user can't access throw the same masked 404. */
export async function requireShowAccess(
  c: Context<AppEnv>,
  showId: string,
  notFoundDetail = 'Show not found.',
): Promise<Row> {
  const user = requireUser(c);
  const catalog = c.get('catalog');
  const show = await catalog.shows.getShowRow(showId);
  if (!show || !(await catalog.auth.authCanAccessShow(user.id, showId))) {
    throw new ApiError(404, notFoundDetail);
  }
  return show;
}

/** The non-throwing form of `requireSession` (show-grants D3, D12): whether the signed-in user can
 * access the session, hidden sessions included. False for a nonexistent session or one with no
 * show. */
export async function canAccessSession(c: Context<AppEnv>, sessionId: string): Promise<boolean> {
  const user = requireUser(c);
  const catalog = c.get('catalog');
  const row = await catalog.sessions.getSessionIndexRow(sessionId, { includeHidden: true });
  if (row === null || row.show_id == null || !String(row.show_id)) return false;
  return catalog.auth.authCanAccessShow(user.id, String(row.show_id));
}

/** The WebSocket close code for a socket whose user lost access to its session (show-grants D20;
 * api-contract-freeze "Session sockets close when access is lost"). */
export const ACCESS_LOST_CLOSE_CODE = 4403;

/** Close `userId`'s session sockets on the shows in `showIds` they can no longer access
 * (show-grants D20). Call it only AFTER the write that removed the access has committed, so the
 * access check below reads the committed state: a show the user still reaches (a grant that
 * survived, an admin role) keeps its sockets. In-process only (owner decision E); a failure here
 * never fails the committed write, whose response has already been decided. */
export async function closeSocketsAfterAccessLoss(
  c: Context<AppEnv>,
  userId: string,
  showIds: readonly string[] | ((catalog: CatalogFacade) => Promise<readonly string[]>),
): Promise<void> {
  try {
    // catalog-roles D10: it reads another user's access, so it runs as a system task; the
    // `showIds` thunk gets this catalog, so the admin path never reaches the unbound one.
    const catalog = c.get('catalog').system('access-loss-check');
    const shows = typeof showIds === 'function' ? await showIds(catalog) : showIds;
    const lost: string[] = [];
    for (const showId of shows) {
      if (!(await catalog.auth.authCanAccessShow(userId, showId))) lost.push(showId);
    }
    const sessionIds = await catalog.sessions.listSessionIdsForShows(lost);
    if (sessionIds.length === 0) return;
    c.env.ports.sessions.closeUserSockets(userId, new Set(sessionIds), ACCESS_LOST_CLOSE_CODE);
  } catch (e) {
    // Name and code only: a database error's message can echo the values involved.
    const err = e as { name?: unknown; code?: unknown } | null;
    console.error("closeSocketsAfterAccessLoss failed; closing all of the user's sockets", {
      name: err?.name,
      code: err?.code,
    });
    // Fail closed: the write committed, so close every socket of the user; one that still has
    // access reconnects through the gate.
    c.env.ports.sessions.closeUserSockets(userId, 'all', ACCESS_LOST_CLOSE_CODE);
  }
}

/** The ids of every show of a team, for `closeSocketsAfterAccessLoss` after a team-wide loss. */
export async function teamShowIds(catalog: CatalogFacade, teamId: string): Promise<string[]> {
  return (await catalog.shows.listShowsForStudio(teamId)).map((r) => String(r.id));
}

/** _parse_optional_marked_at — validate an ISO-8601 instant; throw 400 on garbage. */
export function parseOptionalMarkedAt(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || !String(raw).trim()) return null;
  const ms = Date.parse(String(raw).trim().replace('+00:00', 'Z'));
  if (Number.isNaN(ms)) throw new ApiError(400, 'Invalid marked_at_utc; use ISO-8601.');
  return new Date(ms).toISOString();
}
