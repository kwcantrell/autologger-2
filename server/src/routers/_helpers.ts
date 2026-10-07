// Shared router helpers — the session and show access gates (_session_access_gate,
// requireShowAccess, canAccessSession; show-grants D3), publishing the closes of sockets whose user
// lost access inside the revoking transaction (publishAccessLossInTx; show-grants D20,
// session-frame-bus D5), per-session hub resolution, timecode context,
// marked-at parsing, and the version-check answers (session-row-versions D4).

import type { AuthUser, CatalogFacade, Row } from '@autologger/catalog';
import {
  type BusMessage,
  type BusTxHandle,
  type SessionCaller,
  type SessionFrameBus,
  type SessionHubFacade,
  type SqlValue,
  type TimecodeCtx,
  userCaller,
  type VersionExpectation,
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

/** At most this many session ids per close message (session-frame-bus D5): about 6 KB signed,
 * under the NOTIFY payload limit. */
export const ACCESS_LOSS_CLOSE_CHUNK = 150;

/** A catalog transaction as the bus's transaction handle: the bus's one statement, `pg_notify`,
 * runs through the transaction's `notify`, under its binding (session-frame-bus D5). */
function catalogNotifyHandle(cat: CatalogFacade): BusTxHandle {
  return {
    all: async <T>(sql: string, ...binds: SqlValue[]): Promise<T[]> => {
      const [channel, payload] = binds;
      if (
        !/^select pg_notify\(/i.test(sql) ||
        typeof channel !== 'string' ||
        typeof payload !== 'string'
      ) {
        throw new TypeError('a catalog transaction publishes only pg_notify(channel, payload)');
      }
      await cat.notify(channel, payload);
      return [];
    },
  };
}

/** Publish closes (code 4403) of `userId`'s sockets on `sessionIds`, split at
 * `ACCESS_LOSS_CLOSE_CHUNK` ids per message, inside the open transaction `cat` (session-frame-bus
 * D5). Returns the messages; the caller hands them to `bus.afterCommit` once the transaction
 * committed (the local bus delivers then; the Postgres bus's listener already does in every
 * process). A publish failure rejects, so the revoke fails and changes nothing. */
export async function publishClosesInTx(
  cat: CatalogFacade,
  bus: SessionFrameBus,
  userId: string,
  sessionIds: readonly string[],
): Promise<BusMessage[]> {
  const msgs: BusMessage[] = [];
  for (let i = 0; i < sessionIds.length; i += ACCESS_LOSS_CLOSE_CHUNK) {
    const s = sessionIds.slice(i, i + ACCESS_LOSS_CLOSE_CHUNK);
    msgs.push({ k: 'close', u: userId, s, c: ACCESS_LOST_CLOSE_CODE });
  }
  if (msgs.length > 0) await bus.publishInTx(catalogNotifyHandle(cat), msgs);
  return msgs;
}

/** The last step inside a revoking transaction (session-frame-bus D5; show-grants D20): re-check
 * `userId`'s access to each of `showIds` on the transaction's own handle, which reads its own
 * uncommitted revoke, and publish closes of their sockets on the sessions of the shows they lost. A
 * show they still reach (a surviving grant, an admin role) keeps its sockets. Any failure rejects
 * and fails the revoke. The handle must still see the rows: the leave route, whose caller loses
 * them with the membership, lists its sessions before the delete and uses `publishClosesInTx`. */
export async function publishAccessLossInTx(
  cat: CatalogFacade,
  bus: SessionFrameBus,
  userId: string,
  showIds: readonly string[],
): Promise<BusMessage[]> {
  const lost: string[] = [];
  for (const showId of showIds) {
    if (!(await cat.auth.authCanAccessShow(userId, showId))) lost.push(showId);
  }
  const sessionIds = lost.length === 0 ? [] : await cat.sessions.listSessionIdsForShows(lost);
  return publishClosesInTx(cat, bus, userId, sessionIds);
}

/** The ids of every show of a team, for `publishAccessLossInTx` after a team-wide loss. */
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

/** An edit's expected version from its parsed body or DELETE query (session-row-versions D4):
 * undefined when it sent none, so the edit stays last-writer-wins. */
export function expectedVersion(parsed: {
  version?: number;
  overwrite?: boolean;
}): VersionExpectation | undefined {
  return parsed.version === undefined
    ? undefined
    : { version: parsed.version, overwrite: parsed.overwrite === true };
}

/** The stale-version answer (api-contract-freeze "Opt-in version checks on session content
 * edits"): `409` with the row as the route's own success response would return it. */
export function versionConflict(c: Context<AppEnv>, current: unknown): Response {
  return c.json({ detail: 'Version conflict.', current }, 409);
}
