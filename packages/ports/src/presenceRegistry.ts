// PresenceRegistry port (spec: core-ports-architecture "Companion presence is shared by every
// process"): Companion presence lives in `catalog.companion_presence` (companion-devices D4), so
// every server process sharing the database sees the same presence. The implementation is
// `PostgresPresence` in `@autologger/storage`.

/** The freshness window: a row updated at or after `now - PRESENCE_FRESH_MS` is listed. A runtime
 * constant, so the barrel re-exports this module as types only (`index.ts`, the barrel stays free of
 * runtime values); import it from `@autologger/ports/presenceRegistry`. */
export const PRESENCE_FRESH_MS = 15_000;

export interface PresenceMeta {
  /** The posting user; a row belongs to the user who first wrote it (D3 ownership). */
  user_id: string;
  /** The open session, or null for none (stored as SQL NULL). */
  session_id: string | null;
  visible: boolean;
  is_playing: boolean;
  /** The row's last update (Clock ms). The implementation stores its own Clock's now on upsert. */
  updated: number;
}

/** A listed presence row. */
export interface PresenceRow extends PresenceMeta {
  client_id: string;
}

export interface PresenceRegistry {
  /** Insert, or update the row for `clientId` only when it belongs to `meta.user_id` or is stale
   * (older than PRESENCE_FRESH_MS); a fresh row of another user is left unchanged. */
  upsert(clientId: string, meta: PresenceMeta): Promise<void>;
  /** Delete the row for `clientId` only when it belongs to `userId`. */
  remove(clientId: string, userId: string): Promise<void>;
  /** That user's fresh rows only (inclusive at the PRESENCE_FRESH_MS edge). */
  list(userId: string): Promise<PresenceRow[]>;
  /** Delete rows last updated before `cutoffMs` (the lease sweeper's first step). */
  deleteOlderThan(cutoffMs: number): Promise<void>;
}
