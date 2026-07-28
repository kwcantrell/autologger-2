// Shared router helpers — the session access gate (_session_access_gate),
// per-session hub resolution, timecode context, and marked-at parsing.

import type { Context } from 'hono';
import type { Row } from '../db/catalog';
import type { SessionHub } from '../session/SessionHub';
import type { AppEnv } from '../types';

/** Maps to an HTTP response in app.onError — mirrors FastAPI's HTTPException. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(detail);
    this.name = 'ApiError';
  }
}

export interface TimecodeCtx {
  frameRate: number;
  startOffsetFrames: number;
}

export function timecodeCtx(row: Row): TimecodeCtx {
  return {
    frameRate: Number(row.frame_rate ?? 24.0),
    startOffsetFrames: Number(row.start_offset_frames ?? 0),
  };
}

/** Resolve the in-process per-session hub (addressed by session id). */
export function getSessionHub(c: Context<AppEnv>, sessionId: string): SessionHub {
  return c.env.ports.sessions.get(sessionId);
}

/** _session_access_gate — existence + studio-membership scope. Returns the
 * catalog row. Authentication (the unauthenticated-401 decision) happens once,
 * in the authContext middleware via apiRequestRequiresLogin — every caller of
 * this helper is an /api/ route that middleware already gates. */
export function requireSession(
  c: Context<AppEnv>,
  sessionId: string,
  opts: { includeHidden?: boolean } = {},
): Row {
  const catalog = c.get('catalog');
  const user = c.get('user');
  const row = catalog.sessions.getSessionIndexRow(sessionId, { includeHidden: opts.includeHidden });
  if (row === null) throw new ApiError(404, 'Session not found');
  if (user !== null) {
    const studioId = catalog.sessions.getSessionStudioId(sessionId);
    if (!studioId || !catalog.auth.authUserHasStudio(user.id, studioId)) {
      throw new ApiError(404, 'Session not found');
    }
  }
  return row;
}

/** _parse_optional_marked_at — validate an ISO-8601 instant; throw 400 on garbage. */
export function parseOptionalMarkedAt(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || !String(raw).trim()) return null;
  const ms = Date.parse(String(raw).trim().replace('+00:00', 'Z'));
  if (Number.isNaN(ms)) throw new ApiError(400, 'Invalid marked_at_utc; use ISO-8601.');
  return new Date(ms).toISOString();
}
