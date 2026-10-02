// Shared router helpers — the session and show access gates (_session_access_gate,
// requireShowAccess, canAccessSession; show-grants D3), per-session hub resolution, timecode
// context, and marked-at parsing.

import type { AuthUser, Row } from '@autologger/catalog';
import type { SessionHubFacade, TimecodeCtx } from '@autologger/session-core';
import type { Context } from 'hono';
import type { AppEnv } from '../appEnv';
import { ApiError } from '../httpError';

export function timecodeCtx(row: Row): TimecodeCtx {
  return {
    frameRate: Number(row.frame_rate ?? 24.0),
    startOffsetFrames: Number(row.start_offset_frames ?? 0),
  };
}

/** Resolve the in-process per-session hub (addressed by session id). */
export function getSessionHub(c: Context<AppEnv>, sessionId: string): SessionHubFacade {
  return c.env.ports.sessions.get(sessionId);
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

/** _parse_optional_marked_at — validate an ISO-8601 instant; throw 400 on garbage. */
export function parseOptionalMarkedAt(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || !String(raw).trim()) return null;
  const ms = Date.parse(String(raw).trim().replace('+00:00', 'Z'));
  if (Number.isNaN(ms)) throw new ApiError(400, 'Invalid marked_at_utc; use ISO-8601.');
  return new Date(ms).toISOString();
}
