// Who a generation runner works for (OpenSpec change `batch-autogenerate`, design D4, D6): the
// signed-in user of a request, or the recorded initiator of a batch job. A runner reads and writes
// only through these: the catalog and the session caller are bound to `user`, and provider
// credentials are resolved from `user` when each step starts (provider-credentials "Work runs on
// its user's credentials").

import type { AuthUser, CatalogFacade, Row } from '@autologger/catalog';
import type { SessionCaller, TimecodeCtx } from '@autologger/session-core';
import type { Bindings } from '../appEnv';

/** The run routes' refusal of a user who is not approved (run-status-and-sweeper D9); also the
 * batch start's (batch-autogenerate D14). */
export const RUN_FEATURE_FORBIDDEN_DETAIL =
  'This feature is limited to approved users on this server.';

export interface GenerationPrincipal {
  user: AuthUser;
  /** The catalog bound to `user` (catalog_user under `user`'s row-level security). */
  catalog: CatalogFacade;
  /** The session caller for `user`: every hub call runs as it. */
  caller: SessionCaller;
  env: Bindings;
}

/** A session row's timecode context (moved here from `routers/_helpers.ts`, which re-exports it). */
export function timecodeCtx(row: Row): TimecodeCtx {
  return {
    frameRate: Number(row.frame_rate ?? 24.0),
    startOffsetFrames: Number(row.start_offset_frames ?? 0),
  };
}

/** An `AuthUser` from a `users` row, as the auth middleware builds it (auth/identity.ts). */
export function authUserFromRow(row: Row): AuthUser {
  return {
    id: String(row.id),
    email: String(row.email),
    google_sub: String(row.google_sub),
    given_name: String(row.given_name ?? ''),
    family_name: String(row.family_name ?? ''),
    picture_url: String(row.picture_url ?? ''),
  };
}

/** Hub resolution for a principal, at the point of use (async-session-hub design D6). */
export async function hubFor(p: GenerationPrincipal, sessionId: string) {
  return (await p.env.ports.sessions.get(sessionId)).as(p.caller);
}

/** A turn's provider failure with an HTTP status other than 429: the provider refused the
 * request (a revoked or over-quota key, an outage), reported `provider-failed` by a batch step
 * (batch spec "A revoked language-model key stops the job while transcription works"). */
export function isProviderRefusal(failure: { kind: string; status?: number } | undefined): boolean {
  return (
    failure?.kind === 'provider' && typeof failure.status === 'number' && failure.status !== 429
  );
}

/** A runner's provider failure that answered HTTP 429 (design D9, D17). */
export function isRateLimitStatus(status: unknown): boolean {
  return status === 429;
}
