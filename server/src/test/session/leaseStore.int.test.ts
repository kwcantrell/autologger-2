import { LeaseStore } from '@autologger/session-core/leaseStore';
import { userCaller } from '@autologger/session-core/sessionCaller';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedSession, seedShow, seedStudio, seedUser } from '../helpers';
import { boundCoreOn } from './boundCore';
import { insertRaw, rawRows, testStorage } from './sessionRows';

// The recording lease on `catalog.session_leases` (session-leases D3, D4, D5), over a REAL core on
// the bound-core harness. Two users, A and B, both reach the session's show; `A`/`B` run as them,
// and the harness's own `run`/`read` as the system test caller. The clock follows Date.now() so
// vitest's faked Date controls it (only Date is faked: the database driver needs real timers).

const STALE = LeaseStore.LEASE_STALE_MS; // 40_000

async function setup() {
  const studio = await seedStudio();
  const a = await seedUser({ studios: [studio], role: 'owner' });
  const b = await seedUser({ studios: [studio], role: 'admin' });
  const show = await seedShow({ studioId: studio });
  const sessionId = await seedSession({ showId: show });
  const storage = testStorage(sessionId);
  const h = await boundCoreOn(storage, sessionId, { now: () => Date.now() });
  const A = h.as(userCaller(a));
  const B = h.as(userCaller(b));
  const leases = () => rawRows(storage, 'session_leases');
  const revision = () => h.read((s) => s.core.revision());
  /** Forget the frames and alarms so far. */
  const clear = () => {
    h.alarms.length = 0;
    h.broadcasts.length = 0;
  };
  return { ...h, A, B, a, b, storage, leases, revision, clear };
}

const row = (
  client: string,
  user: string | null,
  heartbeat: number,
  expires = heartbeat + STALE,
) => ({
  kind: 'recording',
  holder_client_id: client,
  holder_user_id: user,
  heartbeat_at_ms: heartbeat,
  expires_at_ms: expires,
});

describe('LeaseStore on catalog.session_leases (session-leases D3)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-25T00:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('a claim on a free lease stores the holder, arms the alarm and broadcasts', async () => {
    const { A, a, alarms, broadcasts, leases } = await setup();
    const now = Date.now();
    expect(await A.run((s) => s.lease.claimLease('c1'))).toBe(true);
    expect(await leases()).toEqual([row('c1', a, now)]);
    expect(alarms).toEqual([now + STALE]);
    expect(broadcasts).toEqual([{ type: 'lease.changed' }]);
  });

  it('the same user and client claim again: refreshed', async () => {
    const { A, a, alarms, broadcasts, leases, clear } = await setup();
    await A.run((s) => s.lease.claimLease('c1'));
    clear();
    vi.advanceTimersByTime(10_000);
    const now = Date.now();
    expect(await A.run((s) => s.lease.claimLease('c1'))).toBe(true);
    expect(await leases()).toEqual([row('c1', a, now)]);
    expect(alarms).toEqual([now + STALE]);
    expect(broadcasts).toEqual([{ type: 'lease.changed' }]);
  });

  it('another client while alive is refused, writes nothing and leaves the revision', async () => {
    const { A, a, alarms, broadcasts, leases, revision, clear } = await setup();
    const now = Date.now();
    await A.run((s) => s.lease.claimLease('c1'));
    clear();
    const r = await revision();
    vi.advanceTimersByTime(STALE - 1);
    expect(await A.run((s) => s.lease.claimLease('c2'))).toBe(false);
    expect(await leases()).toEqual([row('c1', a, now)]);
    expect(await revision()).toBe(r);
    expect(alarms).toEqual([]);
    expect(broadcasts).toEqual([]);
  });

  it('the same client for another user while alive is refused', async () => {
    const { A, B, a, leases } = await setup();
    const now = Date.now();
    await A.run((s) => s.lease.claimLease('c1'));
    vi.advanceTimersByTime(10_000);
    expect(await B.run((s) => s.lease.claimLease('c1'))).toBe(false);
    expect(await leases()).toEqual([row('c1', a, now)]);
  });

  it('another user takes the lease over once it has expired', async () => {
    const { A, B, b, alarms, broadcasts, leases, clear } = await setup();
    await A.run((s) => s.lease.claimLease('c1'));
    clear();
    vi.advanceTimersByTime(STALE);
    const now = Date.now();
    expect(await B.run((s) => s.lease.claimLease('c2'))).toBe(true);
    expect(await leases()).toEqual([row('c2', b, now)]);
    expect(alarms).toEqual([now + STALE]);
    expect(broadcasts).toEqual([{ type: 'lease.changed' }]);
  });

  it('a blank or NUL client id: claim false, heartbeat false, release a no-op, nothing stored', async () => {
    const { A, a, broadcasts, alarms, leases, revision, clear } = await setup();
    for (const cid of ['', '   ', 'a\u0000b', '\u0000']) {
      expect(await A.run((s) => s.lease.claimLease(cid)), JSON.stringify(cid)).toBe(false);
      expect(await A.run((s) => s.lease.heartbeatLease(cid)), JSON.stringify(cid)).toBe(false);
      await A.run((s) => s.lease.releaseLease(cid));
    }
    expect(await leases()).toEqual([]);
    expect(broadcasts).toEqual([]);
    expect(alarms).toEqual([]);
    // With a lease held, a NUL id still neither errors nor touches it.
    const now = Date.now();
    await A.run((s) => s.lease.claimLease('c1'));
    clear();
    const r = await revision();
    expect(await A.run((s) => s.lease.claimLease('c1\u0000'))).toBe(false);
    expect(await A.run((s) => s.lease.heartbeatLease('c1\u0000'))).toBe(false);
    await A.run((s) => s.lease.releaseLease('c1\u0000'));
    expect(await leases()).toEqual([row('c1', a, now)]);
    expect(await revision()).toBe(r);
    expect(broadcasts).toEqual([]);
  });

  it('a heartbeat by the holder re-arms; by another user or client, or after expiry, it is refused', async () => {
    const { A, B, a, alarms, broadcasts, leases, revision, clear } = await setup();
    await A.run((s) => s.lease.claimLease('c1'));
    clear();
    const r = await revision();
    vi.advanceTimersByTime(10_000);
    const beat = Date.now();
    expect(await A.run((s) => s.lease.heartbeatLease('c1'))).toBe(true);
    expect(await leases()).toEqual([row('c1', a, beat)]);
    expect(alarms).toEqual([beat + STALE]);
    expect(broadcasts).toEqual([]);
    expect(await revision()).toBe(r);
    clear();
    expect(await B.run((s) => s.lease.heartbeatLease('c1'))).toBe(false);
    expect(await A.run((s) => s.lease.heartbeatLease('c2'))).toBe(false);
    expect(await leases()).toEqual([row('c1', a, beat)]);
    expect(alarms).toEqual([]);
    // Expired but not freed: strict, the lease cannot be revived.
    vi.advanceTimersByTime(STALE);
    expect(await A.run((s) => s.lease.heartbeatLease('c1'))).toBe(false);
    expect(await leases()).toEqual([row('c1', a, beat)]);
    expect(alarms).toEqual([]);
  });

  it('release frees the lease only for the same user and client', async () => {
    const { A, B, a, broadcasts, leases, clear } = await setup();
    const now = Date.now();
    await A.run((s) => s.lease.claimLease('c1'));
    clear();
    await B.run((s) => s.lease.releaseLease('c1'));
    await A.run((s) => s.lease.releaseLease('c2'));
    expect(await leases()).toEqual([row('c1', a, now)]);
    expect(broadcasts).toEqual([]);
    await A.run((s) => s.lease.releaseLease('c1'));
    expect(await leases()).toEqual([]);
    expect(broadcasts).toEqual([{ type: 'lease.changed' }]);
  });

  it('status: alive from expires_at_ms, age from heartbeat_at_ms, an expired row not alive', async () => {
    const { A, a, storage, run, read } = await setup();
    expect(await A.read((s) => s.lease.leaseStatus())).toEqual({
      holder_client_id: null,
      lease_alive: false,
      lease_age_sec: null,
    });
    const now = Date.now();
    // Expiry 1 s after a heartbeat 3 s ago: not the TTL apart, so each field has one source.
    await insertRaw(storage, 'session_leases', row('c1', a, now - 3_000, now + 1_000));
    expect(await A.read((s) => s.lease.leaseStatus())).toEqual({
      holder_client_id: 'c1',
      lease_alive: true,
      lease_age_sec: 3,
    });
    vi.advanceTimersByTime(1_000);
    expect(await A.read((s) => s.lease.leaseStatus())).toEqual({
      holder_client_id: 'c1',
      lease_alive: false,
      lease_age_sec: 4,
    });
    // A heartbeat in the future (clock skew) reports age 0, never negative.
    const later = Date.now();
    await run((s) =>
      s.core.db.run('DELETE FROM session_leases WHERE session_id = ?', s.core.sessionId),
    );
    await insertRaw(storage, 'session_leases', row('c1', a, later + 500));
    expect((await read((s) => s.lease.leaseStatus())).lease_age_sec).toBe(0);
  });

  it('status: the holder id is real only for the holding user, or a system caller on a system lease (D4)', async () => {
    const { A, B, run, read } = await setup();
    await A.run((s) => s.lease.claimLease('c1'));
    vi.advanceTimersByTime(5_000);
    expect(await A.read((s) => s.lease.leaseStatus())).toEqual({
      holder_client_id: 'c1',
      lease_alive: true,
      lease_age_sec: 5,
    });
    expect(await B.read((s) => s.lease.leaseStatus())).toEqual({
      holder_client_id: 'another-client',
      lease_alive: true,
      lease_age_sec: 5,
    });
    expect((await read((s) => s.lease.leaseStatus())).holder_client_id).toBe('another-client');
    // In a write transaction too.
    expect((await B.run((s) => s.lease.leaseStatus())).holder_client_id).toBe('another-client');
    await A.run((s) => s.lease.releaseLease('c1'));
    // A system-held lease: real for a system caller, masked for a user.
    expect(await run((s) => s.lease.claimLease('sys'))).toBe(true);
    expect((await read((s) => s.lease.leaseStatus())).holder_client_id).toBe('sys');
    expect((await A.read((s) => s.lease.leaseStatus())).holder_client_id).toBe('another-client');
  });

  it('expireIfStale deletes only an expired lease, re-arms at the stored expiry, and a second run is a no-op', async () => {
    const { A, a, run, alarms, broadcasts, leases, revision, storage, clear } = await setup();
    // No lease: nothing.
    await run((s) => s.lease.expireIfStale());
    expect(alarms).toEqual([]);
    expect(broadcasts).toEqual([]);
    // A live lease with an expiry the TTL does not give: kept, re-armed at that stored value.
    const now = Date.now();
    await insertRaw(storage, 'session_leases', row('c1', a, now, now + 12_345));
    vi.advanceTimersByTime(10_000);
    const r = await revision();
    await run((s) => s.lease.expireIfStale());
    expect(await leases()).toEqual([row('c1', a, now, now + 12_345)]);
    expect(alarms).toEqual([now + 12_345]);
    expect(broadcasts).toEqual([]);
    expect(await revision()).toBe(r);
    clear();
    // Expired (exactly at its expiry): deleted once, one broadcast, the revision +1, no re-arm.
    vi.setSystemTime(now + 12_345);
    await run((s) => s.lease.expireIfStale());
    expect(await leases()).toEqual([]);
    expect(broadcasts).toEqual([{ type: 'lease.changed' }]);
    expect(alarms).toEqual([]);
    expect(await revision()).toBe(r + 1);
    // A second run: no-op.
    await run((s) => s.lease.expireIfStale());
    expect(broadcasts).toEqual([{ type: 'lease.changed' }]);
    expect(alarms).toEqual([]);
    expect(await revision()).toBe(r + 1);
    // A user caller's claim after that still works (the row is gone, not stuck).
    expect(await A.run((s) => s.lease.claimLease('c2'))).toBe(true);
  });
});
