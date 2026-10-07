import { LeaseStore, type RunLeaseKind } from '@autologger/session-core/leaseStore';
import { holdRunLease } from '@autologger/session-core/runLease';
import type { SessionHubEntry, SessionHubFacade } from '@autologger/session-core/SessionHub';
import { userCaller } from '@autologger/session-core/sessionCaller';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedSession, seedShow, seedStudio, seedUser } from '../helpers';
import { boundCoreOn } from './boundCore';
import {
  catalogRoot,
  DRIVER_SAFE_FAKE_TIMERS,
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
  started: number | null = null,
) => ({
  kind,
  holder_client_id: client,
  holder_user_id: user,
  heartbeat_at_ms: heartbeat,
  expires_at_ms: expires,
  started_at_ms: started,
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

  it.each(
    KINDS,
  )('%s: claim, re-claim and release leave the revision, broadcast nothing and arm no alarm', async (kind) => {
    const { A, a, alarms, broadcasts, leases, revision } = await setup();
    const r = await revision();
    const t0 = Date.now();
    expect(await A.run((s) => s.lease.claimRunLease(kind, 'srv:x:1'))).toBe(true);
    expect(await leases()).toEqual([row(kind, 'srv:x:1', a, t0, t0 + TTL, t0)]);
    vi.advanceTimersByTime(10_000);
    const t1 = Date.now();
    expect(await A.run((s) => s.lease.claimRunLease(kind, 'srv:x:1'))).toBe(true);
    expect(await leases()).toEqual([row(kind, 'srv:x:1', a, t1, t1 + TTL, t0)]);
    await A.run((s) => s.lease.releaseRunLease(kind, 'srv:x:1'));
    expect(await leases()).toEqual([]);
    expect(await revision()).toBe(r);
    expect(broadcasts).toEqual([]);
    expect(alarms).toEqual([]);
  });

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
    expect(await leases()).toEqual([row('ai-turn', 'srv:x:1', a, t0, t0 + TTL, t0)]);
    // A different kind of the same session is its own lease.
    expect(await B.run((s) => s.lease.claimRunLease('youtube-import', 'srv:y:1'))).toBe(true);
    vi.advanceTimersByTime(1);
    const t1 = Date.now();
    expect(await B.run((s) => s.lease.claimRunLease('ai-turn', 'srv:y:2'))).toBe(true);
    expect((await leases())[0]).toEqual(row('ai-turn', 'srv:y:2', b, t1, t1 + TTL, t1));
    expect(await revision()).toBe(r);
    expect(broadcasts).toEqual([]);
    expect(alarms).toEqual([]);
  });

  it('the holder re-takes its own lapsed row that nobody took', async () => {
    const { A, a, leases } = await setup();
    const t0 = Date.now();
    expect(await A.run((s) => s.lease.claimRunLease('transcript-generation', 'srv:x:1'))).toBe(
      true,
    );
    vi.advanceTimersByTime(TTL + 5_000);
    const t1 = Date.now();
    expect(await A.run((s) => s.lease.claimRunLease('transcript-generation', 'srv:x:1'))).toBe(
      true,
    );
    // The same holder: a renewal, so the start is kept (run-status-and-sweeper D4).
    expect(await leases()).toEqual([row('transcript-generation', 'srv:x:1', a, t1, t1 + TTL, t0)]);
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
    expect(await leases()).toEqual([row('youtube-import', 'srv:y:1', b, t1, t1 + TTL, t1)]);
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
    expect(await leases()).toEqual([row('ai-turn', 'srv:x:1', a, t0, t0 + TTL, t0)]);
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

  it('started_at_ms: set by a claim, kept by renewals, reset by a takeover (run-status-and-sweeper D4)', async () => {
    const { A, B, a, b, leases, revision } = await setup();
    const started = async () => (await leases()).map((l) => l.started_at_ms);
    const t0 = Date.now();
    expect(await A.run((s) => s.lease.claimRunLease('transcript-generation', 'srv:x:1'))).toBe(
      true,
    );
    expect(await started()).toEqual([t0]);
    const r = await revision();
    // Renewals by the same holder keep the start.
    for (let i = 0; i < 3; i += 1) {
      vi.advanceTimersByTime(10_000);
      expect(await A.run((s) => s.lease.claimRunLease('transcript-generation', 'srv:x:1'))).toBe(
        true,
      );
    }
    expect(await started()).toEqual([t0]);
    // A refused claim leaves it.
    expect(await B.run((s) => s.lease.claimRunLease('transcript-generation', 'srv:y:1'))).toBe(
      false,
    );
    expect(await started()).toEqual([t0]);
    // Another holder takes the expired row over: a new run, so a new start.
    vi.advanceTimersByTime(TTL);
    const t1 = Date.now();
    expect(await B.run((s) => s.lease.claimRunLease('transcript-generation', 'srv:y:1'))).toBe(
      true,
    );
    expect(await leases()).toEqual([row('transcript-generation', 'srv:y:1', b, t1, t1 + TTL, t1)]);
    // The same user with another run id is another holder too.
    vi.advanceTimersByTime(TTL);
    const t2 = Date.now();
    expect(await B.run((s) => s.lease.claimRunLease('transcript-generation', 'srv:y:2'))).toBe(
      true,
    );
    expect(await started()).toEqual([t2]);
    // The same run id as another user is another holder.
    vi.advanceTimersByTime(TTL);
    const t3 = Date.now();
    expect(await A.run((s) => s.lease.claimRunLease('transcript-generation', 'srv:y:2'))).toBe(
      true,
    );
    expect(await leases()).toEqual([row('transcript-generation', 'srv:y:2', a, t3, t3 + TTL, t3)]);
    expect(await revision()).toBe(r);
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
    expect(await rawRows(storage, 'session_leases', { columns: 'kind, holder_user_id' })).toEqual([
      { kind: 'ai-turn', holder_user_id: a },
    ]);
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

// The lease-hold helper on Postgres (session-run-leases D3; the stub-hub cases are in
// packages/session-core/src/runLease.test.ts). The registry's clock reads `time.now`, the renewal
// timer is faked (driver-safe), and each tick's claim is awaited before the next step.
describe('holdRunLease on Postgres (session-run-leases D3)', () => {
  const registries: TestRegistry[] = [];
  afterEach(async () => {
    vi.useRealTimers();
    for (const r of registries.splice(0)) await r.closeAll();
  });

  const T = 1_750_000_000_000;

  async function hold() {
    vi.useFakeTimers(DRIVER_SAFE_FAKE_TIMERS);
    const studio = await seedStudio();
    const a = await seedUser({ studios: [studio], role: 'owner' });
    const b = await seedUser({ studios: [studio], role: 'admin' });
    const show = await seedShow({ studioId: studio });
    const sessionId = await seedSession({ showId: show });
    const storage = testStorage(sessionId);
    const time = { now: T };
    const registry = testRegistry({ clock: { now: () => time.now } });
    registries.push(registry);
    const claims: Promise<boolean>[] = [];
    const holders: string[] = [];
    const entries: SessionHubEntry[] = [];
    const ctl = { failing: false };
    /** The caller-bound thunk the routes pass: resolves the hub on every call, as user A, and
     * records each claim so the test can await it. */
    const getHub = async (): Promise<SessionHubFacade> => {
      if (ctl.failing) throw new Error('database unreachable');
      const entry = await registry.get(sessionId);
      entries.push(entry);
      const hub = entry.as(userCaller(a));
      return {
        claimRunLease: (kind: RunLeaseKind, holderId: string) => {
          holders.push(holderId);
          const p = hub.claimRunLease(kind, holderId);
          claims.push(p);
          return p;
        },
        releaseRunLease: (kind: RunLeaseKind, holderId: string) =>
          hub.releaseRunLease(kind, holderId),
      } as unknown as SessionHubFacade;
    };
    const vb = async () => (await registry.get(sessionId)).as(userCaller(b));
    const log = vi.fn();
    /** Moves both clocks by `ms` and waits until `n` claims in all were sent and settled. */
    const step = async (ms: number, n?: number) => {
      time.now += ms;
      vi.advanceTimersByTime(ms);
      // `performance` is not faked: wait up to 10 s of real time (a re-opened hub does I/O).
      const deadline = performance.now() + 10_000;
      while (n !== undefined && claims.length < n) {
        if (performance.now() > deadline)
          throw new Error(`waited for claim ${n}, have ${claims.length}`);
        await new Promise((r) => setImmediate(r));
      }
      await Promise.allSettled(claims);
      for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
    };
    const leases = () =>
      rawRows(storage, 'session_leases', {
        columns: 'kind, holder_client_id, holder_user_id, expires_at_ms',
      });
    return {
      a,
      b,
      sessionId,
      registry,
      time,
      getHub,
      vb,
      log,
      step,
      claims,
      holders,
      entries,
      ctl,
      leases,
    };
  }

  it('a 180 s hold renews 18 times, stays alive throughout, and refuses a competing claim throughout', async () => {
    const h = await hold();
    const run = await holdRunLease({ getHub: h.getHub, kind: 'ai-turn', log: h.log });
    expect(run).not.toBeNull();
    const competitor = await h.vb();
    const bad: string[] = [];
    for (let i = 1; i <= 18; i += 1) {
      await h.step(10_000, 1 + i);
      const [row] = await h.leases();
      if (!(Number(row?.expires_at_ms) > h.time.now)) bad.push(`t+${i * 10}s: not alive`);
      if (await competitor.claimRunLease('ai-turn', `srv:other:${i}`))
        bad.push(`t+${i * 10}s: competitor won`);
    }
    expect(bad).toEqual([]);
    expect(h.claims).toHaveLength(19); // the claim and 18 renewals
    expect(await Promise.all(h.claims)).toEqual(Array(19).fill(true));
    expect(new Set(h.holders).size).toBe(1);
    expect(await h.leases()).toEqual([
      {
        kind: 'ai-turn',
        holder_client_id: h.holders[0],
        holder_user_id: h.a,
        expires_at_ms: T + 180_000 + 40_000,
      },
    ]);
    await run?.release();
    expect(await h.leases()).toEqual([]);
    expect(h.log).not.toHaveBeenCalled();
  }, 60_000);

  it('after more than 40 s of failed renewals, a renewal re-takes the lapsed row', async () => {
    const h = await hold();
    const run = await holdRunLease({ getHub: h.getHub, kind: 'transcript-generation', log: h.log });
    h.ctl.failing = true;
    for (let i = 0; i < 5; i += 1) await h.step(10_000);
    expect(h.log).toHaveBeenCalledTimes(5);
    const [lapsed] = await h.leases();
    expect(Number(lapsed?.expires_at_ms)).toBeLessThan(h.time.now); // lapsed, nobody took it
    h.ctl.failing = false;
    await h.step(10_000, 2);
    expect(await h.claims[1]).toBe(true);
    expect(await h.leases()).toEqual([
      {
        kind: 'transcript-generation',
        holder_client_id: h.holders[0],
        holder_user_id: h.a,
        expires_at_ms: h.time.now + 40_000,
      },
    ]);
    await run?.release();
    expect(await h.leases()).toEqual([]);
  }, 60_000);

  it('a renewal refused after another holder took the expired lease logs once, stops, and the release leaves the new row', async () => {
    const h = await hold();
    const run = await holdRunLease({ getHub: h.getHub, kind: 'youtube-import', log: h.log });
    h.time.now += 41_000; // the run stalled past its expiry; no tick ran
    expect(await (await h.vb()).claimRunLease('youtube-import', 'srv:other:1')).toBe(true);
    await h.step(10_000, 2);
    expect(await h.claims[1]).toBe(false);
    await h.step(30_000);
    expect(h.claims).toHaveLength(2);
    expect(h.log).toHaveBeenCalledTimes(1);
    expect(h.log.mock.calls[0]?.[0]).toMatch(/^run lease lost: youtube-import/);
    await run?.release();
    expect(await h.leases()).toEqual([
      {
        kind: 'youtube-import',
        holder_client_id: 'srv:other:1',
        holder_user_id: h.b,
        expires_at_ms: T + 41_000 + 40_000,
      },
    ]);
  }, 60_000);

  it('an evicted hub is re-resolved on the next tick', async () => {
    const h = await hold();
    const run = await holdRunLease({ getHub: h.getHub, kind: 'ai-turn', log: h.log });
    const first = h.entries[0];
    h.time.now += 1;
    h.registry.evictIdle(0);
    await h.step(10_000, 2);
    expect(await h.claims[1]).toBe(true);
    expect(h.entries).toHaveLength(2);
    expect(h.entries[1]).not.toBe(first);
    const [row] = await h.leases();
    expect(Number(row?.expires_at_ms)).toBe(h.time.now + 40_000);
    await run?.release();
    expect(await h.leases()).toEqual([]);
    expect(h.log).not.toHaveBeenCalled();
  }, 60_000);
});
