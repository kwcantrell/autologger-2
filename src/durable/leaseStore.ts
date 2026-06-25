// Recording-lease domain — a single-holder lease in the meta table with
// heartbeat + alarm-driven staleness expiry. Moved verbatim out of SessionDO.ts.

import type { SessionCore } from './sessionCore';

export class LeaseStore {
  // Heartbeats older than this free the recording lease (AUDIO_RECORDING_LEASE_STALE_SEC).
  static readonly LEASE_STALE_MS = 40_000;

  constructor(private core: SessionCore) {}

  claimLease(clientId: string): boolean {
    const cid = clientId.trim();
    if (!cid) return false;
    const now = Date.now();
    const holder = this.core.metaGet('lease_holder');
    const seen = Number(this.core.metaGet('lease_seen_ms') ?? 0);
    if (holder === null || holder === cid || now - seen >= LeaseStore.LEASE_STALE_MS) {
      this.core.metaSet('lease_holder', cid);
      this.core.metaSet('lease_seen_ms', String(now));
      this.core.setAlarm(now + LeaseStore.LEASE_STALE_MS);
      this.core.broadcast({ type: 'lease.changed' });
      return true;
    }
    return false;
  }

  heartbeatLease(clientId: string): boolean {
    const cid = clientId.trim();
    if (!cid) return false;
    if (this.core.metaGet('lease_holder') !== cid) return false;
    const now = Date.now();
    this.core.metaSet('lease_seen_ms', String(now));
    this.core.setAlarm(now + LeaseStore.LEASE_STALE_MS);
    return true;
  }

  releaseLease(clientId: string): void {
    const cid = clientId.trim();
    if (!cid) return;
    if (this.core.metaGet('lease_holder') !== cid) return;
    this.core.metaDelete('lease_holder');
    this.core.metaDelete('lease_seen_ms');
    this.core.broadcast({ type: 'lease.changed' });
  }

  leaseStatus(): {
    holder_client_id: string | null;
    lease_alive: boolean;
    lease_age_sec: number | null;
  } {
    const holder = this.core.metaGet('lease_holder');
    if (holder === null) return { holder_client_id: null, lease_alive: false, lease_age_sec: null };
    const seen = Number(this.core.metaGet('lease_seen_ms') ?? 0);
    const age = Math.max(0, (Date.now() - seen) / 1000);
    return {
      holder_client_id: holder,
      lease_alive: age < LeaseStore.LEASE_STALE_MS / 1000,
      lease_age_sec: age,
    };
  }

  /** The former SessionDO.alarm body: free the lease if its heartbeat went stale. */
  expireIfStale(): void {
    const holder = this.core.metaGet('lease_holder');
    if (holder === null) return;
    const seen = Number(this.core.metaGet('lease_seen_ms') ?? 0);
    if (Date.now() - seen >= LeaseStore.LEASE_STALE_MS) {
      this.core.metaDelete('lease_holder');
      this.core.metaDelete('lease_seen_ms');
      this.core.broadcast({ type: 'lease.changed' });
    }
  }
}
