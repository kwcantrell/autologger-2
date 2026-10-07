import { LeaseStore, type RunLeaseKind } from '@autologger/session-core/leaseStore';
import { userCaller } from '@autologger/session-core/sessionCaller';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedSession, seedShow, seedStudio, seedUser } from '../helpers';
import { boundCoreOn } from './boundCore';
import {
  catalogRoot,
  insertRaw,
  rawRows,
  type TestRegistry,
  testRegistry,
  testStorage,
} from './sessionRows';

// The silent run leases on `catalog.session_leases` (session-run-leases D2), over a REAL core on
// the bound-core harness, as the recording lease's own test runs (leaseStore.int.test.ts). Two
// users, A and B, both reach the session's show. A run lease is claimed, renewed (a re-claim by the
// same holder) and released on the raw handle: the revision never moves, nothing is broadcast and
// no alarm is armed. Only Date is faked (the database driver needs real timers).

const KINDS: RunLeaseKind[] = ['ai-turn', 'transcript-generation', 'youtube-import'];
const TTL = 40_000;

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
  const leases = () => rawRows(storage, 'session_leases', { orderBy: 'kind' });
  const revision = () => h.read((s) => s.core.revision());
  /** Forget the frames and alarms so far. */
  const clear = () => {
    h.alarms.length = 0;
    h.broadcasts.length = 0;
  };
  return { ...h, A, B, a, b, sessionId, storage, leases, revision, clear };
}

const row = (
  kind: string,
  client: string,
  user: string | null,
  heartbeat: number,
  expires = heartbeat + TTL,
) => ({
  kind,
  holder_client_id: client,
  holder_user_id: user,
  heartbeat_at_ms: heartbeat,
  expires_at_ms: expires,
});

describe('silent run leases on catalog.session_leases (session-run-leases D2)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-07T00:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('the run kinds live 40 s; the recording TTL is unchanged', () => {
    expect(LeaseStore.TTL_MS).toEqual({
      recording: LeaseStore.LEASE_STALE_MS,
      'ai-turn': TTL,
      'transcript-generation': TTL,
      'youtube-import': TTL,
    });
  });

  it.each(KINDS)(
    '%s: claim, re-claim and release leave the revision, broadcast nothing and arm no alarm',
    async (kind) => {
      const { A, a, alarms, broadcasts, leases, revision } = await setup();
      const r = await revision();
      const t0 = Date.now();
      expect(await A.run((s) => s.lease.claimRunLease(kind, 'srv:x:1'))).toBe(true);
      expect(await leases()).toEqual([row(kind, 'srv:x:1', a, t0)]);
      vi.advanceTimersByTime(10_000);
      const t1 = Date.now();
      expect(await A.run((s) => s.lease.claimRunLease(kind, 'srv:x:1'))).toBe(true);
      expect(await leases()).toEqual([row(kind, 'srv:x:1', a, t1)]);
      await A.run((s) => s.lease.releaseRunLease(kind, 'srv:x:1'));
      expect(await leases()).toEqual([]);
      expect(await revision()).toBe(r);
      expect(broadcasts).toEqual([]);
      expect(alarms).toEqual([]);
    },
  );

  it('another holder is refused while the lease is live, and takes it over once it expired', async () => {
    const { A, B, a, b, alarms, broadcasts, leases, revision } = await setup();
    const t0 = Date.now();
    expect(await A.run((s) => s.lease.claimRunLease('ai-turn', 'srv:x:1'))).toBe(true);
    const r = await revision();
    vi.advanceTimersByTime(TTL - 1);
    // Another run of the same user, the same run id for another user, and another user's run.
    expect(await A.run((s) => s.lease.claimRunLease('ai-turn', 'srv:x:2'))).toBe(false);
    expect(await B.run((s) => s.lease.claimRunLease('ai-turn', 'srv:x:1'))).toBe(false);
    expect(await B.run((s) => s.lease.claimRunLease('ai-turn', 'srv:y:1'))).toBe(false);
    expect(await leases()).toEqual([row('ai-turn', 'srv:x:1', a, t0)]);
    // A different kind of the same session is its own lease.
    expect(await B.run((s) => s.lease.claimRunLease('youtube-import', 'srv:y:1'))).toBe(true);
    vi.advanceTimersByTime(1);
    const t1 = Date.now();
    expect(await B.run((s) => s.lease.claimRunLease('ai-turn', 'srv:y:2'))).toBe(true);
    expect((await leases())[0]).toEqual(row('ai-turn', 'srv:y:2', b, t1));
    expect(await revision()).toBe(r);
    expect(broadcasts).toEqual([]);
    expect(alarms).toEqual([]);
  });

  it('the holder re-takes its own lapsed row that nobody took', async () => {
    const { A, a, leases } = await setup();
    expect(await A.run((s) => s.lease.claimRunLease('transcript-generation', 'srv:x:1'))).toBe(
      true,
    );
    vi.advanceTimersByTime(TTL + 5_000);
    const t1 = Date.now();
    expect(await A.run((s) => s.lease.claimRunLease('transcript-generation', 'srv:x:1'))).toBe(
      true,
    );
    expect(await leases()).toEqual([row('transcript-generation', 'srv:x:1', a, t1)]);
  });

  it("a former holder's release leaves the new holder's row", async () => {
    const { A, B, b, leases } = await setup();
    await A.run((s) => s.lease.claimRunLease('youtube-import', 'srv:x:1'));
    vi.advanceTimersByTime(TTL);
    const t1 = Date.now();
    expect(await B.run((s) => s.lease.claimRunLease('youtube-import', 'srv:y:1'))).toBe(true);
    await A.run((s) => s.lease.releaseRunLease('youtube-import', 'srv:x:1'));
    // The same run id as another user does not release it either.
    await A.run((s) => s.lease.releaseRunLease('youtube-import', 'srv:y:1'));
    expect(await leases()).toEqual([row('youtube-import', 'srv:y:1', b, t1)]);
  });

  it('a blank or NUL holder id: claim false, release a no-op, nothing stored', async () => {
    const { A, a, leases, revision } = await setup();
    for (const id of ['', '   ', 'a\u0000b', '\u0000']) {
      expect(await A.run((s) => s.lease.claimRunLease('ai-turn', id)), JSON.stringify(id)).toBe(
        false,
      );
      await A.run((s) => s.lease.releaseRunLease('ai-turn', id));
    }
    expect(await leases()).toEqual([]);
    const t0 = Date.now();
    await A.run((s) => s.lease.claimRunLease('ai-turn', 'srv:x:1'));
    const r = await revision();
    await A.run((s) => s.lease.releaseRunLease('ai-turn', 'srv:x:1\u0000'));
    expect(await leases()).toEqual([row('ai-turn', 'srv:x:1', a, t0)]);
    expect(await revision()).toBe(r);
  });

  it('expireIfStale frees only recording rows and re-arms only from recording expiries', async () => {
    const { a, run, alarms, broadcasts, leases, revision, storage, clear } = await setup();
    const now = Date.now();
    // Run rows: one expired, one live with the earliest expiry of all.
    await insertRaw(storage, 'session_leases', [
      row('ai-turn', 'srv:x:1', a, now - TTL, now - 1),
      row('youtube-import', 'srv:x:2', a, now, now + 1_000),
    ]);
    const r = await revision();
    await run((s) => s.lease.expireIfStale());
    // Only run rows: nothing freed, nothing broadcast, no alarm.
    expect(await leases()).toEqual([
      row('ai-turn', 'srv:x:1', a, now - TTL, now - 1),
      row('youtube-import', 'srv:x:2', a, now, now + 1_000),
    ]);
    expect(alarms).toEqual([]);
    expect(broadcasts).toEqual([]);
    expect(await revision()).toBe(r);
    // A live recording row: re-armed at its expiry, not at the earlier run expiry.
    await insertRaw(storage, 'session_leases', row('recording', 'tab-1', a, now, now + 5_000));
    await run((s) => s.lease.expireIfStale());
    expect(alarms).toEqual([now + 5_000]);
    expect(broadcasts).toEqual([]);
    clear();
    // Past every expiry: the recording row goes (one broadcast, revision +1), the run rows stay.
    vi.setSystemTime(now + 5_000);
    await run((s) => s.lease.expireIfStale());
    expect(await leases()).toEqual([
      row('ai-turn', 'srv:x:1', a, now - TTL, now - 1),
      row('youtube-import', 'srv:x:2', a, now, now + 1_000),
    ]);
    expect(broadcasts).toEqual([{ type: 'lease.changed' }]);
    expect(alarms).toEqual([]);
    expect(await revision()).toBe(r + 1);
  });

  it('leaseStatus ignores run rows', async () => {
    const { A, read } = await setup();
    await A.run((s) => s.lease.claimRunLease('ai-turn', 'srv:x:1'));
    await A.run((s) => s.lease.claimRunLease('youtube-import', 'srv:x:2'));
    const none = { holder_client_id: null, lease_alive: false, lease_age_sec: null };
    expect(await A.read((s) => s.lease.leaseStatus())).toEqual(none);
    expect(await read((s) => s.lease.leaseStatus())).toEqual(none);
  });
});

async function storedRevision(sessionId: string): Promise<number> {
  const rows = await catalogRoot()
    .bindSystem('test')
    .all<{ revision: number }>('SELECT revision FROM sessions WHERE id = ?', sessionId);
  return Number(rows[0]?.revision);
}

describe('the run-lease facade (session-run-leases D2)', () => {
  const registries: TestRegistry[] = [];
  afterEach(async () => {
    for (const r of registries.splice(0)) await r.closeAll();
  });

  it('claimRunLease and releaseRunLease on a hub as a user: silent, held by that user', async () => {
    const studio = await seedStudio();
    const a = await seedUser({ studios: [studio], role: 'owner' });
    const b = await seedUser({ studios: [studio], role: 'admin' });
    const show = await seedShow({ studioId: studio });
    const sessionId = await seedSession({ showId: show });
    const storage = testStorage(sessionId);
    const registry = testRegistry();
    registries.push(registry);
    const entry = await registry.get(sessionId);
    const frames: unknown[] = [];
    entry.attachSocket({ send: (d: string) => void frames.push(JSON.parse(d)) }, 'browser');
    const va = entry.as(userCaller(a));
    const vb = entry.as(userCaller(b));
    const before = await storedRevision(sessionId);
    expect(await va.claimRunLease('ai-turn', 'srv:x:1')).toBe(true);
    expect(await vb.claimRunLease('ai-turn', 'srv:y:1')).toBe(false);
    expect(await rawRows(storage, 'session_leases', { columns: 'kind, holder_user_id' })).toEqual(
      [{ kind: 'ai-turn', holder_user_id: a }],
    );
    await vb.releaseRunLease('ai-turn', 'srv:x:1');
    expect(await rawRows(storage, 'session_leases', { columns: 'kind' })).toEqual([
      { kind: 'ai-turn' },
    ]);
    await va.releaseRunLease('ai-turn', 'srv:x:1');
    expect(await rawRows(storage, 'session_leases')).toEqual([]);
    expect(await storedRevision(sessionId)).toBe(before);
    expect(frames).toEqual([]);
  });
});
