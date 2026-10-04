// Fake-clock determinism (de-cloudflare-strong-core task 5.3): the alarm
// scheduler and every staleness read share one injected time base, so lease
// expiry is provable with zero real elapsed time. tick() advances the fake
// Clock and vitest's timer queue in lockstep — the shared-time-base guarantee
// under test. The KV-TTL and presence-freshness suites that used to live here
// moved beside the modules they test (storage's kvStore.pg.test.ts,
// node/presence.test.ts — code-health-tail task 5.2); the shared helper is
// the server's ../fakeClock (moved here from @autologger/session-core,
// session-tables D12).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakeClock } from '../fakeClock';
import { createSessionRow, DRIVER_SAFE_FAKE_TIMERS, openTestHub, testStorage } from './sessionRows';

describe('lease expiry through the hub with a fake clock (task 5.3)', () => {
  let id: string;
  beforeEach(async () => {
    id = await createSessionRow();
    vi.useFakeTimers(DRIVER_SAFE_FAKE_TIMERS);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('claim → advance past stale threshold → alarm frees the lease, no real time', async () => {
    const { clock, tick } = makeFakeClock();
    const hub = await openTestHub(id, testStorage(id), clock);

    expect(await hub.claimLease('tab-a')).toBe(true);
    expect((await hub.leaseStatus()).holder_client_id).toBe('tab-a');
    expect(hub.hasArmedAlarm).toBe(true);

    // Just before the stale threshold: alarm may fire but must NOT free (and re-arms).
    tick(39_999);
    expect((await hub.leaseStatus()).holder_client_id).toBe('tab-a');

    // Cross the threshold: the alarm fires once and frees the stale lease.
    tick(40_001);
    expect((await hub.leaseStatus()).holder_client_id).toBeNull();
    // Freed lease → no holder → the alarm must not busy-refire.
    expect(hub.hasArmedAlarm).toBe(false);

    await hub.close();
  });

  it('heartbeat keeps the lease alive across would-be expiry', async () => {
    const { clock, tick } = makeFakeClock();
    const hub = await openTestHub(id, testStorage(id), clock);

    await hub.claimLease('tab-a');
    tick(30_000);
    expect(await hub.heartbeatLease('tab-a')).toBe(true);
    tick(30_000); // 60s after claim, but only 30s after heartbeat
    expect((await hub.leaseStatus()).holder_client_id).toBe('tab-a');
    tick(45_000); // now stale relative to the heartbeat
    expect((await hub.leaseStatus()).holder_client_id).toBeNull();

    await hub.close();
  });
});
