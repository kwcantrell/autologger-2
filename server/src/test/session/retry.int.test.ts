// A retried hub write (session-tables design D2, D7; core-ports-architecture "A retried
// transaction announces once"): the first run of a lease claim issues its broadcast and sets the
// alarm, then fails with a deadlock after its body; the adapter runs the body again and commits.
// The caller gets one result, the committed run's frame is sent once, and the alarm is armed once.

import { LeaseStore } from '@autologger/session-core/leaseStore';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deadlock, type SlowStorage, slowStorage } from './slowStorage';
import { createSessionRow, rawRows, testRegistry, testStorage } from './sessionRows';

afterEach(() => vi.restoreAllMocks());

describe('a hub write retried after a deadlock', () => {
  it('returns one result, sends the committed run frames once, and arms the alarm once', async () => {
    const id = await createSessionRow();
    const T = 1_750_000_000_000;
    let slow!: SlowStorage;
    const registry = testRegistry({
      clock: { now: () => T },
      wrap: (storage) => {
        slow = slowStorage(storage);
        return slow;
      },
    });
    const hub = await registry.get(id);
    const frames: unknown[] = [];
    hub.attachSocket({ send: (d: string) => void frames.push(JSON.parse(d)) }, 'browser');
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const alarmsArmed = () =>
      timers.mock.calls.filter(([, ms]) => ms === LeaseStore.LEASE_STALE_MS).length;

    slow.failAfterBody(1, deadlock());
    expect(await hub.claimLease('client-a')).toBe(true);

    expect(frames).toEqual([{ type: 'lease.changed' }]);
    expect(alarmsArmed()).toBe(1);
    expect(hub.hasArmedAlarm).toBe(true);
    expect(
      await rawRows(testStorage(id), 'session_leases', { columns: 'kind, holder_client_id' }),
    ).toEqual([{ kind: 'recording', holder_client_id: 'client-a' }]);
    await registry.closeAll();
  });
});
