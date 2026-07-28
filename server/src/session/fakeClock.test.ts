// Fake-clock determinism (de-cloudflare-strong-core task 5.3): the alarm
// scheduler and every staleness read share one injected time base, so lease
// expiry is provable with zero real elapsed time. tick() advances the fake
// Clock and vitest's timer queue in lockstep — the shared-time-base guarantee
// under test. The KV-TTL and presence-freshness suites that used to live here
// moved beside the modules they test (node/kvStore.test.ts,
// node/presence.test.ts — code-health-tail task 5.2); the shared helper is
// ../test/fakeClock.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakeClock } from '../test/fakeClock';
import { SessionHub } from './SessionHub';

describe('lease expiry through the hub with a fake clock (task 5.3)', () => {
  let dir: string;
  beforeEach(() => {
    vi.useFakeTimers();
    dir = mkdtempSync(join(tmpdir(), 'autologger-clock-'));
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it('claim → advance past stale threshold → alarm frees the lease, no real time', () => {
    const { clock, tick } = makeFakeClock();
    const hub = new SessionHub(join(dir, 's1.db'), clock);

    expect(hub.claimLease('tab-a')).toBe(true);
    expect(hub.leaseStatus().holder_client_id).toBe('tab-a');
    expect(hub.hasArmedAlarm).toBe(true);

    // Just before the stale threshold: alarm may fire but must NOT free (and re-arms).
    tick(39_999);
    expect(hub.leaseStatus().holder_client_id).toBe('tab-a');

    // Cross the threshold: the alarm fires once and frees the stale lease.
    tick(40_001);
    expect(hub.leaseStatus().holder_client_id).toBeNull();
    // Freed lease → no holder → the alarm must not busy-refire.
    expect(hub.hasArmedAlarm).toBe(false);

    hub.close();
  });

  it('heartbeat keeps the lease alive across would-be expiry', () => {
    const { clock, tick } = makeFakeClock();
    const hub = new SessionHub(join(dir, 's1.db'), clock);

    hub.claimLease('tab-a');
    tick(30_000);
    expect(hub.heartbeatLease('tab-a')).toBe(true);
    tick(30_000); // 60s after claim, but only 30s after heartbeat
    expect(hub.leaseStatus().holder_client_id).toBe('tab-a');
    tick(45_000); // now stale relative to the heartbeat
    expect(hub.leaseStatus().holder_client_id).toBeNull();

    hub.close();
  });
});
