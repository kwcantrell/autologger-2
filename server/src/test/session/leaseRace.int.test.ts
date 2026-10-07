// The recording lease across processes (session-leases design A1, D3, D5, D6 cross-process cases;
// task 4.1): two registries over two adapter instances share one fake time, so the two hubs share
// no in-process lock, no alarm and no memory, only the database. Each lease statement decides its
// outcome on its own: (a) concurrent claims by two users have one winner per round; (b) the bare
// claim upsert has one winner even without the session row lock; (c) a lease whose holder died
// reads not alive once expired and is taken over in one write; (d) two processes' alarms for one
// expiry free it once; (e) a process whose clock runs 500 ms ahead never frees a lease that is
// heartbeated every 8 s. The run leases (session-run-leases D6, task 3.2): (f) concurrent ai-turn
// claims from two processes have one winner per round and never move the revision; (g) a dead
// process's youtube-import lease is taken over by process B after expiry in one write.

import type { CatalogDb } from '@autologger/ports';
import { LeaseStore } from '@autologger/session-core/leaseStore';
import { userCaller } from '@autologger/session-core/sessionCaller';
import { SessionCore, type SessionSql } from '@autologger/session-core/sessionCore';
import { PostgresCatalogDb } from '@autologger/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testDatabase } from '../harness';
import { seedSession, seedShow, seedStudio, seedUser } from '../helpers';
import {
  catalogRoot,
  DRIVER_SAFE_FAKE_TIMERS,
  sessionDb,
  type TestRegistry,
  testRegistry,
} from './sessionRows';

const T = 1_750_000_000_000;
const TTL = LeaseStore.TTL_MS.recording;
const RUN_TTL = LeaseStore.TTL_MS['ai-turn'];

const others: PostgresCatalogDb[] = [];
const registries: TestRegistry[] = [];
afterEach(async () => {
  for (const r of registries.splice(0)) await r.closeAll();
  for (const db of others.splice(0)) await db.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A second adapter instance: a second process's connections. */
function secondAdapter(): PostgresCatalogDb {
  const db = new PostgresCatalogDb(testDatabase());
  others.push(db);
  return db;
}

/** A team with owner `a` and admin `b`, both with access to a show, and `sessions` sessions of
 * it. */
async function team(sessions = 1) {
  const studio = await seedStudio();
  const a = await seedUser({ studios: [studio], role: 'owner' });
  const b = await seedUser({ studios: [studio], role: 'admin' });
  const show = await seedShow({ studioId: studio });
  const ids: string[] = [];
  for (let i = 0; i < sessions; i += 1) ids.push(await seedSession({ showId: show }));
  return { a, b, ids };
}

/** Process one (the harness's adapter) and process two (a second adapter), each with its own
 * registry; `skewMs` puts process two's clock ahead of the shared time. */
function twoProcesses(time: { now: number }, skewMs = 0) {
  const one = testRegistry({ clock: { now: () => time.now } });
  const two = testRegistry({
    clock: { now: () => time.now + skewMs },
    db: sessionDb(secondAdapter()),
  });
  registries.push(one, two);
  return [one, two] as const;
}

async function revision(sessionId: string): Promise<number> {
  const [row] = await catalogRoot()
    .bindSystem('test')
    .all<{ revision: number }>('SELECT revision FROM sessions WHERE id = ?', sessionId);
  return Number(row?.revision);
}

async function leaseRows(sessionId: string) {
  return catalogRoot()
    .bindSystem('test')
    .all<{ holder_client_id: string; holder_user_id: string | null; expires_at_ms: number }>(
      'SELECT holder_client_id, holder_user_id, expires_at_ms FROM session_leases WHERE session_id = ?',
      sessionId,
    );
}

/** Frames sent to a browser socket attached to `hub`. */
function socketOn(hub: { attachSocket(ws: { send(d: string): void }, role: 'browser'): void }) {
  const frames: { type: string }[] = [];
  hub.attachSocket({ send: (d: string) => void frames.push(JSON.parse(d)) }, 'browser');
  return frames;
}

/** Counts `hub`'s alarm runs (the private `runAlarm`, still run for real). */
function countAlarms(hub: object): { runs: number } {
  const count = { runs: 0 };
  const target = hub as unknown as { runAlarm(): Promise<void> };
  const original = target.runAlarm.bind(hub);
  vi.spyOn(target, 'runAlarm').mockImplementation(() => {
    count.runs += 1;
    return original();
  });
  return count;
}

/** Resolves once no call is in flight on any of `hubs` (an alarm run counts from its timer
 * callback on); `setImmediate` is never faked. */
async function idle(...hubs: { inFlightCount: number }[]): Promise<void> {
  do {
    await new Promise((resolve) => setImmediate(resolve));
  } while (hubs.some((h) => h.inFlightCount > 0));
}

describe('the recording lease across two processes (session-leases D6)', () => {
  it('(a) 200 rounds of two users claiming at once: one winner per round, revision +2 per round', async () => {
    const { a, b, ids } = await team();
    const [id] = ids;
    const time = { now: T };
    const [one, two] = twoProcesses(time);
    const [hubOne, hubTwo] = await Promise.all([one.get(id), two.get(id)]);
    const va = hubOne.as(userCaller(a));
    const vb = hubTwo.as(userCaller(b));
    const start = await revision(id);
    const bad: string[] = [];
    const winners = { a: 0, b: 0 };
    for (let round = 0; round < 200; round += 1) {
      const before = await revision(id);
      // Alternate who is sent first, so neither process is always ahead.
      const [okA, okB] =
        round % 2 === 0
          ? await Promise.all([va.claimLease('tab-a'), vb.claimLease('tab-b')])
          : await Promise.all([vb.claimLease('tab-b'), va.claimLease('tab-a')]).then(
              ([y, x]) => [x, y] as const,
            );
      if (Number(okA) + Number(okB) !== 1) {
        bad.push(`round ${round}: a=${okA} b=${okB}`);
        await catalogRoot()
          .bindSystem('test')
          .run('DELETE FROM session_leases WHERE session_id = ?', id);
        continue;
      }
      const [row] = await leaseRows(id);
      if (row?.holder_user_id !== (okA ? a : b))
        bad.push(`round ${round}: row held by ${row?.holder_user_id}`);
      if (okA) {
        winners.a += 1;
        await va.releaseLease('tab-a');
      } else {
        winners.b += 1;
        await vb.releaseLease('tab-b');
      }
      const after = await revision(id);
      if (after !== before + 2) bad.push(`round ${round}: revision ${before} -> ${after}`);
    }
    expect(bad).toEqual([]);
    expect(winners.a + winners.b).toBe(200);
    expect(await revision(id)).toBe(start + 400);
    expect(await leaseRows(id)).toEqual([]);
    console.info(`[leaseRace a] 200 rounds: a won ${winners.a}, b won ${winners.b}`);
    // 600 transactions across two adapters (versionRace precedent).
  }, 90_000);

  it('(b) the claim upsert alone, on two transactions without the session row lock, has one winner', async () => {
    // Each transaction is a READ COMMITTED session transaction that locks a different session's
    // row (its own dummy), so nothing serializes the two claims on the target session but the
    // claim statement itself (design A1). The claim is LeaseStore's own, on a core bound to that
    // transaction's raw handle, as the user.
    const { a, b, ids } = await team(3);
    const [target, dummyA, dummyB] = ids;
    const time = { now: T };
    const clock = { now: () => time.now };
    const roots = { a: catalogRoot().bindUser(a), b: secondAdapter().bindUser(b) };
    const raw = (t: CatalogDb): SessionSql => {
      const h: SessionSql = {
        all: (sql, ...binds) => t.all(sql, ...binds),
        run: (sql, ...binds) => t.run(sql, ...binds),
        tx: (fn) => t.tx(async () => fn(h)),
      };
      return h;
    };
    const root = new SessionCore({
      sessionId: target,
      clock,
      sockets: () => [],
      setAlarm: () => {},
    });
    /** Runs the claim as `who`, in a transaction locking only `lockRow`; `hold` is awaited after
     * the claim and before COMMIT (a rejection rolls the claim back). */
    const claim = (who: 'a' | 'b', lockRow: string, hold?: (won: boolean) => Promise<void>) =>
      roots[who].sessionTx(lockRow, async (t) => {
        const h = raw(t);
        const core = root.forSnapshot(h, userCaller(who === 'a' ? a : b));
        const won = await new LeaseStore(core).claimLease(`tab-${who}`);
        if (hold) await hold(won);
        return won;
      });
    const clear = () =>
      catalogRoot()
        .bindSystem('test')
        .run('DELETE FROM session_leases WHERE session_id = ?', target);

    // 200 unordered rounds.
    const bad: string[] = [];
    for (let round = 0; round < 200; round += 1) {
      const [x, y] = await Promise.all([claim('a', dummyA), claim('b', dummyB)]);
      if (Number(x) + Number(y) !== 1) bad.push(`round ${round}: a=${x} b=${y}`);
      await clear();
    }
    expect(bad).toEqual([]);

    // The committed-winner interleaving: A's claim is in and uncommitted, B's claim waits on the
    // row, A commits, and B re-evaluates the WHERE against A's live lease and writes nothing.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inA!: () => void;
    const claimedA = new Promise<void>((resolve) => {
      inA = resolve;
    });
    const first = claim('a', dummyA, async (won) => {
      inA();
      if (won) await gate;
    });
    await claimedA;
    let bDone = false;
    const second = claim('b', dummyB).then((won) => {
      bDone = true;
      return won;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(bDone).toBe(false); // waiting on A's uncommitted row
    release();
    expect(await first).toBe(true);
    expect(await second).toBe(false);
    expect((await leaseRows(target)).map((r) => r.holder_user_id)).toEqual([a]);
    await clear();

    // The rolled-back-winner interleaving: A's claim rolls back, so B's waiting claim wins.
    let abort!: () => void;
    const aborted = new Promise<void>((_, reject) => {
      abort = () => reject(new Error('roll back A'));
    });
    let inA2!: () => void;
    const claimedA2 = new Promise<void>((resolve) => {
      inA2 = resolve;
    });
    const rolled = claim('a', dummyA, async () => {
      inA2();
      await aborted;
    }).catch((e: Error) => e.message);
    await claimedA2;
    const after = claim('b', dummyB);
    await new Promise((resolve) => setTimeout(resolve, 100));
    abort();
    expect(await rolled).toBe('roll back A');
    expect(await after).toBe(true);
    expect((await leaseRows(target)).map((r) => r.holder_user_id)).toEqual([b]);
  }, 90_000);

  it("(c) A claims and its process dies; past expiry B reads not alive and B's claim takes it over in one write", async () => {
    const { a, b, ids } = await team();
    const [id] = ids;
    const time = { now: T };
    const [one, two] = twoProcesses(time);
    const [hubOne, hubTwo] = await Promise.all([one.get(id), two.get(id)]);
    expect(await hubOne.as(userCaller(a)).claimLease('tab-a')).toBe(true);
    await one.closeAll(); // dies without releasing: its alarm goes with it
    const vb = hubTwo.as(userCaller(b));
    expect(await vb.leaseStatus()).toEqual({
      holder_client_id: 'another-client',
      lease_alive: true,
      lease_age_sec: 0,
    });
    expect(await vb.claimLease('tab-b')).toBe(false);

    time.now = T + TTL; // the expiry instant: no longer alive
    expect(await vb.leaseStatus()).toMatchObject({
      holder_client_id: 'another-client',
      lease_alive: false,
    });
    // Nobody freed the row: B's claim is the one write that takes it over.
    expect((await leaseRows(id)).map((r) => r.holder_user_id)).toEqual([a]);
    const before = await revision(id);
    const frames = socketOn(hubTwo);
    expect(await vb.claimLease('tab-b')).toBe(true);
    expect(await revision(id)).toBe(before + 1);
    expect(frames).toEqual([{ type: 'lease.changed' }]);
    expect(await leaseRows(id)).toEqual([
      { holder_client_id: 'tab-b', holder_user_id: b, expires_at_ms: T + 2 * TTL },
    ]);
    expect(await vb.leaseStatus()).toEqual({
      holder_client_id: 'tab-b',
      lease_alive: true,
      lease_age_sec: 0,
    });
  });

  it('(d) both processes alarm for the same expiry: the row goes once, revision +1, one lease.changed in total', async () => {
    vi.useFakeTimers(DRIVER_SAFE_FAKE_TIMERS);
    const { a, ids } = await team();
    const [id] = ids;
    const time = { now: T };
    const [one, two] = twoProcesses(time);
    const hubOne = await one.get(id);
    expect(await hubOne.as(userCaller(a)).claimLease('tab-a')).toBe(true); // arms one's alarm
    const hubTwo = await two.get(id); // its open arms two's alarm at the same expiry
    expect([hubOne.hasArmedAlarm, hubTwo.hasArmedAlarm]).toEqual([true, true]);
    const runs = [countAlarms(hubOne), countAlarms(hubTwo)];
    const frames = [socketOn(hubOne), socketOn(hubTwo)];
    const before = await revision(id);

    time.now = T + TTL;
    vi.advanceTimersByTime(TTL);
    await idle(hubOne, hubTwo);

    expect(runs.map((r) => r.runs)).toEqual([1, 1]);
    expect(await leaseRows(id)).toEqual([]);
    expect(await revision(id)).toBe(before + 1);
    expect([...frames[0], ...frames[1]]).toEqual([{ type: 'lease.changed' }]);
    expect([hubOne.hasArmedAlarm, hubTwo.hasArmedAlarm]).toEqual([false, false]);
  });

  it("(e) with B's clock 500 ms ahead and A heartbeating every 8 s, B's repeated alarms never free the lease", async () => {
    vi.useFakeTimers(DRIVER_SAFE_FAKE_TIMERS);
    const { a, ids } = await team();
    const [id] = ids;
    const time = { now: T };
    const [one, two] = twoProcesses(time, 500);
    const hubOne = await one.get(id);
    const va = hubOne.as(userCaller(a));
    expect(await va.claimLease('tab-a')).toBe(true);
    const hubTwo = await two.get(id); // armed 500 ms early by its own clock
    expect(hubTwo.hasArmedAlarm).toBe(true);
    const runsTwo = countAlarms(hubTwo);
    const frames = [socketOn(hubOne), socketOn(hubTwo)];
    const before = await revision(id);

    const MINUTES = 5;
    const bad: string[] = [];
    let heartbeats = 0;
    for (let s = 1; s <= MINUTES * 60; s += 1) {
      time.now += 1000;
      vi.advanceTimersByTime(1000);
      await idle(hubOne, hubTwo);
      if (s % 8 === 0) {
        heartbeats += 1;
        if (!(await va.heartbeatLease('tab-a'))) bad.push(`t+${s}s: heartbeat refused`);
      }
      if ((await leaseRows(id)).length !== 1) bad.push(`t+${s}s: lease row gone`);
    }
    expect(bad).toEqual([]);
    expect(heartbeats).toBe(Math.floor((MINUTES * 60) / 8));
    expect(runsTwo.runs).toBeGreaterThanOrEqual(5);
    expect(await va.leaseStatus()).toMatchObject({ holder_client_id: 'tab-a', lease_alive: true });
    expect(await revision(id)).toBe(before); // heartbeats don't count, and nothing was freed
    expect([...frames[0], ...frames[1]]).toEqual([]);
    console.info(
      `[leaseRace e] ${MINUTES} min fake time: ${heartbeats} heartbeats, B's alarm ran ${runsTwo.runs} times`,
    );
  }, 60_000);
});

describe('run leases across two processes (session-run-leases D2, D6)', () => {
  it('(f) 200 rounds of two processes claiming ai-turn for different users: one winner per round, revision unchanged', async () => {
    const { a, b, ids } = await team();
    const [id] = ids;
    const time = { now: T };
    const [one, two] = twoProcesses(time);
    const [hubOne, hubTwo] = await Promise.all([one.get(id), two.get(id)]);
    const va = hubOne.as(userCaller(a));
    const vb = hubTwo.as(userCaller(b));
    const start = await revision(id);
    const bad: string[] = [];
    const winners = { a: 0, b: 0 };
    for (let round = 0; round < 200; round += 1) {
      const ha = `srv:one:${round}`;
      const hb = `srv:two:${round}`;
      // Alternate who is sent first, so neither process is always ahead.
      const [okA, okB] =
        round % 2 === 0
          ? await Promise.all([va.claimRunLease('ai-turn', ha), vb.claimRunLease('ai-turn', hb)])
          : await Promise.all([
              vb.claimRunLease('ai-turn', hb),
              va.claimRunLease('ai-turn', ha),
            ]).then(([y, x]) => [x, y] as const);
      if (Number(okA) + Number(okB) !== 1) {
        bad.push(`round ${round}: a=${okA} b=${okB}`);
        await catalogRoot()
          .bindSystem('test')
          .run('DELETE FROM session_leases WHERE session_id = ?', id);
        continue;
      }
      const [row] = await leaseRows(id);
      if (row?.holder_user_id !== (okA ? a : b))
        bad.push(`round ${round}: row held by ${row?.holder_user_id}`);
      if (okA) {
        winners.a += 1;
        await va.releaseRunLease('ai-turn', ha);
      } else {
        winners.b += 1;
        await vb.releaseRunLease('ai-turn', hb);
      }
    }
    expect(bad).toEqual([]);
    expect(winners.a + winners.b).toBe(200);
    expect(await revision(id)).toBe(start);
    expect(await leaseRows(id)).toEqual([]);
    console.info(`[leaseRace f] 200 rounds: a won ${winners.a}, b won ${winners.b}`);
  }, 90_000);

  it("(g) a dead process's youtube-import lease is taken over through process B after expiry, replacing the row", async () => {
    const { a, b, ids } = await team();
    const [id] = ids;
    const time = { now: T };
    const [one, two] = twoProcesses(time);
    const [hubOne, hubTwo] = await Promise.all([one.get(id), two.get(id)]);
    expect(await hubOne.as(userCaller(a)).claimRunLease('youtube-import', 'srv:one:1')).toBe(true);
    await one.closeAll(); // dies without releasing
    const vb = hubTwo.as(userCaller(b));
    const before = await revision(id);
    time.now = T + RUN_TTL - 1;
    expect(await vb.claimRunLease('youtube-import', 'srv:two:1')).toBe(false);
    expect((await leaseRows(id)).map((r) => r.holder_client_id)).toEqual(['srv:one:1']);
    time.now = T + RUN_TTL + 1_000; // 41 s later
    expect(await vb.claimRunLease('youtube-import', 'srv:two:1')).toBe(true);
    expect(await leaseRows(id)).toEqual([
      {
        holder_client_id: 'srv:two:1',
        holder_user_id: b,
        expires_at_ms: T + RUN_TTL + 1_000 + RUN_TTL,
      },
    ]);
    expect(await revision(id)).toBe(before);
  });
});
