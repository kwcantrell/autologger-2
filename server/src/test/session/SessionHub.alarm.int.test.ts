// The lease alarm under the async hub (async-session-hub design D6, D12). A real-timer case: a
// timer armed inside a transaction body would inherit that body's AsyncLocalStorage context, and
// fake timers don't propagate the context, so only real timers can show that the alarm is armed
// outside it (spike A11). And the backoff case: a failed expiry run logs and re-arms after 1 s,
// doubling, capped at the 40 s stale threshold, and a successful run resets it.

import type { AsyncLocalStorage } from 'node:async_hooks';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LeaseStore } from '@autologger/session-core/leaseStore';
import { SessionHub } from '@autologger/session-core/SessionHub';
import { type SlowStorage, slowStorage } from './slowStorage';
import { createSessionRow, DRIVER_SAFE_FAKE_TIMERS, openTestHub, testStorage } from './sessionRows';

const unhandled: unknown[] = [];
const trap = (reason: unknown): void => {
  unhandled.push(reason);
};
beforeAll(() => {
  process.on('unhandledRejection', trap);
});
afterAll(() => {
  process.off('unhandledRejection', trap);
  expect(unhandled).toEqual([]);
});

let sessionId: string;
beforeEach(async () => {
  sessionId = await createSessionRow();
});

const STALE = LeaseStore.LEASE_STALE_MS;

/** Resolves once `check` passes, or rejects after `ms` of real time. */
async function within(ms: number, check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`not within ${ms} ms`);
}

describe('lease alarm on real timers', () => {
  it('fires outside any transaction context, clears the stale holder and sends lease.changed', async () => {
    const T = 1_750_000_000_000;
    const time = { now: T };
    const clock = { now: () => time.now };
    const first = await openTestHub(sessionId, testStorage(sessionId), clock);
    expect(await first.claimLease('client-a')).toBe(true);
    await first.close();

    // Reopen 10 ms before the lease goes stale: the open's expiry run re-arms the alarm about
    // 10 ms ahead, from inside its transaction body.
    time.now = T + STALE - 10;
    const hub = await openTestHub(sessionId, testStorage(sessionId), clock);
    const frames: Record<string, unknown>[] = [];
    hub.attachSocket({ send: (d: string) => void frames.push(JSON.parse(d)) }, 'browser');
    expect(hub.hasArmedAlarm).toBe(true);

    const context = (SessionHub as unknown as { txContext: AsyncLocalStorage<unknown> }).txContext;
    const contexts: unknown[] = [];
    const target = hub as unknown as { runAlarm(): Promise<void> };
    const original = target.runAlarm.bind(hub);
    vi.spyOn(target, 'runAlarm').mockImplementation(() => {
      contexts.push(context.getStore());
      return original();
    });
    time.now = T + STALE + 1;

    await within(500, async () => (await hub.leaseStatus()).holder_client_id === null);
    expect(frames).toContainEqual({ type: 'lease.changed' });
    expect(contexts).toEqual([undefined]);
    expect(hub.hasArmedAlarm).toBe(false);
    await hub.close();
  });

  // Spec "Lease expiry is ordered with the session's operations": an expiry run that starts
  // while another transaction is open waits for it (no interruption), never sees its uncommitted
  // heartbeat (no dirty read), and still frees the stale lease once that transaction rolls back.
  it('an expiry during an open transaction waits for it, ignores its rolled-back heartbeat, and still frees the lease', async () => {
    const T = 1_750_000_000_000;
    const time = { now: T };
    const hub = await openTestHub(sessionId, testStorage(sessionId), { now: () => time.now });
    const frames: Record<string, unknown>[] = [];
    hub.attachSocket({ send: (d: string) => void frames.push(JSON.parse(d)) }, 'browser');
    expect(await hub.claimLease('client-a')).toBe(true);
    frames.length = 0;
    time.now = T + STALE + 1;

    type Stores = { core: { metaSet(k: string, v: string): Promise<void> }; lease: LeaseStore };
    const internals = hub as unknown as {
      inTxn<R>(body: (s: Stores) => Promise<R>): Promise<R>;
      runAlarm(): Promise<void>;
    };
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const seenInside: unknown[] = [];
    const held = internals.inTxn(async (s) => {
      // A fresh heartbeat that is never committed: an expiry that read it would keep the lease.
      await s.core.metaSet('lease_seen_ms', String(time.now));
      entered();
      await gate;
      seenInside.push((await s.lease.leaseStatus()).holder_client_id);
      throw new Error('roll back the heartbeat');
    });
    const heldOutcome = held.then(
      () => 'committed',
      (e: Error) => e.message,
    );
    await inside;

    const alarmDone = { value: false };
    const alarm = internals.runAlarm().then(() => {
      alarmDone.value = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(alarmDone.value).toBe(false);
    expect(hub.inFlightCount).toBe(2);

    openGate();
    expect(await heldOutcome).toBe('roll back the heartbeat');
    await alarm;
    expect(seenInside).toEqual(['client-a']);
    expect((await hub.leaseStatus()).holder_client_id).toBeNull();
    expect(frames).toEqual([{ type: 'lease.changed' }]);
    await hub.close();
  });
});

describe('lease alarm backoff (fake timers)', () => {
  beforeEach(() => {
    vi.useFakeTimers(DRIVER_SAFE_FAKE_TIMERS);
    vi.setSystemTime(new Date('2026-10-03T00:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function hubWithFailingSql() {
    const sql: SlowStorage = slowStorage(testStorage(sessionId), { delayMs: 0 });
    const hub = await openTestHub(sessionId, sql, { now: () => Date.now() });
    return { hub, sql };
  }

  const retryDelays = (log: { mock: { calls: unknown[][] } }) =>
    log.mock.calls
      .map((args) => /retrying in (\d+) ms/.exec(String(args[0]))?.[1])
      .filter((x) => x !== undefined)
      .map(Number);

  it('re-arms after 1 s and then 2 s, succeeds on the third run, and resets', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { hub, sql } = await hubWithFailingSql();
    expect(await hub.claimLease('client-a')).toBe(true);

    sql.failNextTx(2);
    await vi.advanceTimersByTimeAsync(STALE);
    expect(retryDelays(log)).toEqual([1000]);
    expect(hub.hasArmedAlarm).toBe(true);
    expect((await hub.leaseStatus()).holder_client_id).toBe('client-a');

    await vi.advanceTimersByTimeAsync(1000);
    expect(retryDelays(log)).toEqual([1000, 2000]);
    expect((await hub.leaseStatus()).holder_client_id).toBe('client-a');

    await vi.advanceTimersByTimeAsync(2000);
    expect((await hub.leaseStatus()).holder_client_id).toBeNull();
    expect(hub.hasArmedAlarm).toBe(false);

    // Reset: the next failure starts again at 1 s.
    expect(await hub.claimLease('client-b')).toBe(true);
    sql.failNextTx(1);
    await vi.advanceTimersByTimeAsync(STALE);
    expect(retryDelays(log)).toEqual([1000, 2000, 1000]);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await hub.leaseStatus()).holder_client_id).toBeNull();
    await hub.close();
  });

  it('a run of failures stops doubling at the 40 s stale threshold', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { hub, sql } = await hubWithFailingSql();
    expect(await hub.claimLease('client-a')).toBe(true);

    sql.failNextTx(8);
    await vi.advanceTimersByTimeAsync(STALE);
    for (const ms of [1000, 2000, 4000, 8000, 16000, 32000, 40000]) {
      await vi.advanceTimersByTimeAsync(ms);
    }
    expect(retryDelays(log)).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 40000, 40000]);
    await vi.advanceTimersByTimeAsync(40000);
    expect((await hub.leaseStatus()).holder_client_id).toBeNull();
    await hub.close();
  });
});
