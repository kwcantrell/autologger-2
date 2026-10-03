// The lease alarm is armed after COMMIT (session-tables design D7): a body that sets the alarm and
// then fails leaves no alarm armed (7a kept it armed), and an alarm armed by a committed body fires
// outside the storage call's async context, on real timers as 7a's alarm test. The storage here
// runs every transaction body inside a probe AsyncLocalStorage context, standing in for the
// adapter's own: a timer created inside a body would carry it.

import { AsyncLocalStorage } from 'node:async_hooks';
import { LeaseStore } from '@autologger/session-core/leaseStore';
import { SessionHub } from '@autologger/session-core/SessionHub';
import type { SessionStorage } from '@autologger/session-core/sessionCore';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { slowStorage } from './slowStorage';
import { createSessionRow, testStorage } from './sessionRows';

afterEach(() => vi.restoreAllMocks());

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

const probe = new AsyncLocalStorage<string>();

/** `inner` with every transaction body and snapshot body run inside the probe's context. */
function probed(inner: SessionStorage): SessionStorage {
  return {
    tx: (caller, fn) => inner.tx(caller, (t) => probe.run('inside the storage call', () => fn(t))),
    snapshot: (caller, fn) =>
      inner.snapshot(caller, (t) => probe.run('inside the storage call', () => fn(t))),
  };
}

describe('the lease alarm after commit', () => {
  it('a lease body that sets the alarm and then fails leaves no alarm armed', async () => {
    const id = await createSessionRow();
    const slow = slowStorage(testStorage(id));
    const hub = await SessionHub.open(id, slow, { now: () => 1_750_000_000_000 });
    const frames: unknown[] = [];
    hub.attachSocket({ send: (d: string) => void frames.push(JSON.parse(d)) }, 'browser');

    slow.failAfterBody(1, new Error('fails after the alarm'));
    await expect(hub.claimLease('client-a')).rejects.toThrow('fails after the alarm');

    expect(hub.hasArmedAlarm).toBe(false);
    expect(frames).toEqual([]);
    expect((await hub.leaseStatus()).holder_client_id).toBeNull();
    await hub.close();
  });

  it('an alarm armed by a committed body fires outside the storage call context', async () => {
    const id = await createSessionRow();
    const T = 1_750_000_000_000;
    const time = { now: T };
    const clock = { now: () => time.now };

    const first = await SessionHub.open(id, probed(testStorage(id)), clock);
    expect(await first.claimLease('client-a')).toBe(true);
    await first.close();

    // Reopen 10 ms before the lease goes stale: the open's expiry run sets the alarm about 10 ms
    // ahead from inside its transaction body.
    time.now = T + STALE - 10;
    const hub = await SessionHub.open(id, probed(testStorage(id)), clock);
    const frames: Record<string, unknown>[] = [];
    hub.attachSocket({ send: (d: string) => void frames.push(JSON.parse(d)) }, 'browser');
    expect(hub.hasArmedAlarm).toBe(true);

    const contexts: unknown[] = [];
    const target = hub as unknown as { runAlarm(): Promise<void> };
    const original = target.runAlarm.bind(hub);
    vi.spyOn(target, 'runAlarm').mockImplementation(() => {
      contexts.push(probe.getStore());
      return original();
    });
    time.now = T + STALE + 1;

    await within(2000, async () => (await hub.leaseStatus()).holder_client_id === null);
    expect(frames).toContainEqual({ type: 'lease.changed' });
    expect(contexts).toEqual([undefined]);
    expect(hub.hasArmedAlarm).toBe(false);
    await hub.close();
  });
});
