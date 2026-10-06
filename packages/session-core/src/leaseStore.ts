// Recording-lease domain (session-leases D3, D4, D5): one lease per session and kind in
// `catalog.session_leases`, bound to a client id and the user who claimed it. Liveness is always
// judged from the stored expiry against the Clock port, so any process sharing the database reads
// and claims the lease correctly; each statement decides its outcome on its own.

import type { SessionCore } from './sessionCore';

/** The lease kinds (session-leases D1): the table's `session_leases_kind_check` admits exactly
 * these. */
export type LeaseKind = 'recording';

/** What a non-holder sees instead of the holder's client id (session-leases D4): non-empty, and
 * never equal to a tab id. */
export const MASKED_HOLDER_ID = 'another-client';

/** A usable client id (session-leases D3): non-empty after trimming and free of NUL, which
 * Postgres text cannot hold; null when the id is refused before any statement. */
function usableClientId(clientId: string): string | null {
  const cid = clientId.trim();
  if (!cid || cid.includes('\u0000')) return null;
  return cid;
}

export class LeaseStore {
  // A lease whose heartbeat is older than this expires (AUDIO_RECORDING_LEASE_STALE_SEC).
  static readonly LEASE_STALE_MS = 40_000;

  /** Time to live per kind (session-leases D2). */
  static readonly TTL_MS: Readonly<Record<LeaseKind, number>> = {
    recording: LeaseStore.LEASE_STALE_MS,
  };

  constructor(private core: SessionCore) {}

  /** Claim (D3): a conditional upsert through the counting handle that wins on a free or expired
   * lease, or on the caller's own (same client and user); a refused claim writes nothing. No
   * `RETURNING`: the win is the changed-row count. */
  async claimLease(clientId: string, kind: LeaseKind = 'recording'): Promise<boolean> {
    const cid = usableClientId(clientId);
    if (cid === null) return false;
    const now = this.core.now();
    const expires = now + LeaseStore.TTL_MS[kind];
    const { changes } = await this.core.db.run(
      `INSERT INTO session_leases
         (session_id, kind, holder_client_id, holder_user_id, heartbeat_at_ms, expires_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (session_id, kind) DO UPDATE SET
         holder_client_id = excluded.holder_client_id, holder_user_id = excluded.holder_user_id,
         heartbeat_at_ms = excluded.heartbeat_at_ms, expires_at_ms = excluded.expires_at_ms
       WHERE session_leases.expires_at_ms <= ?
          OR (session_leases.holder_client_id = excluded.holder_client_id
              AND session_leases.holder_user_id IS NOT DISTINCT FROM excluded.holder_user_id)`,
      this.core.sessionId,
      kind,
      cid,
      this.core.callerUserId,
      now,
      expires,
      now,
    );
    if (changes !== 1) return false;
    this.core.setAlarm(expires);
    this.core.broadcast({ type: 'lease.changed' });
    return true;
  }

  /** Heartbeat (D3, D5): strict, the holder only and only while alive; never advances the revision
   * and never broadcasts. */
  async heartbeatLease(clientId: string, kind: LeaseKind = 'recording'): Promise<boolean> {
    const cid = usableClientId(clientId);
    if (cid === null) return false;
    const now = this.core.now();
    const expires = now + LeaseStore.TTL_MS[kind];
    const ok = await this.core.heartbeatLeaseUncounted(
      kind,
      cid,
      this.core.callerUserId,
      now,
      expires,
    );
    if (ok) this.core.setAlarm(expires);
    return ok;
  }

  /** Release (D3): frees the lease only for the same client and user. */
  async releaseLease(clientId: string, kind: LeaseKind = 'recording'): Promise<void> {
    const cid = usableClientId(clientId);
    if (cid === null) return;
    const { changes } = await this.core.db.run(
      `DELETE FROM session_leases WHERE session_id = ? AND kind = ? AND holder_client_id = ?
         AND holder_user_id IS NOT DISTINCT FROM ?`,
      this.core.sessionId,
      kind,
      cid,
      this.core.callerUserId,
    );
    if (changes > 0) this.core.broadcast({ type: 'lease.changed' });
  }

  /** Status of the recording lease (D3, D4): alive from the stored expiry, age from the last
   * heartbeat; the holder's client id only for the holding user (or a system caller reading a
   * system-held lease), `MASKED_HOLDER_ID` for everyone else. */
  async leaseStatus(): Promise<{
    holder_client_id: string | null;
    lease_alive: boolean;
    lease_age_sec: number | null;
  }> {
    const kind: LeaseKind = 'recording';
    const r = await this.core.first(
      `SELECT holder_client_id, holder_user_id, heartbeat_at_ms, expires_at_ms
       FROM session_leases WHERE session_id = ? AND kind = ?`,
      this.core.sessionId,
      kind,
    );
    if (r === null) return { holder_client_id: null, lease_alive: false, lease_age_sec: null };
    const now = this.core.now();
    const holderUser = (r.holder_user_id as string | null) ?? null;
    const own = this.core.callerUserId === holderUser;
    return {
      holder_client_id: own ? String(r.holder_client_id) : MASKED_HOLDER_ID,
      lease_alive: now < Number(r.expires_at_ms),
      lease_age_sec: Math.max(0, (now - Number(r.heartbeat_at_ms)) / 1000),
    };
  }

  /** The alarm body, also run when the session opens (D3, D5): deletes every expired lease of the
   * session (all kinds), then re-arms the alarm at the earliest remaining expiry, so an early
   * alarm never leaks a live lease. A second run, or another process's, deletes nothing. */
  async expireIfStale(): Promise<void> {
    const now = this.core.now();
    const { changes } = await this.core.db.run(
      'DELETE FROM session_leases WHERE session_id = ? AND expires_at_ms <= ?',
      this.core.sessionId,
      now,
    );
    if (changes > 0) this.core.broadcast({ type: 'lease.changed' });
    const next = await this.core.first(
      'SELECT MIN(expires_at_ms) AS next FROM session_leases WHERE session_id = ?',
      this.core.sessionId,
    );
    if (next?.next !== null && next?.next !== undefined) this.core.setAlarm(Number(next.next));
  }
}
