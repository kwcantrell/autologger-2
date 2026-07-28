import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeRuntime } from '../test/fakeCore';
import { LeaseStore } from './leaseStore';

// A REAL core over the shared typed fake runtime (code-health-tail task 5.2)
// — replaces this file's hand-rolled `as unknown as SessionCore` cast fake.
// Meta state is read/seeded through the core's own meta helpers; the clock
// follows Date.now() so vitest fake timers control it, as before.
function setup() {
  const { core, alarms, broadcasts } = fakeRuntime({ now: () => Date.now() });
  return { core, alarms, broadcasts };
}

const STALE = LeaseStore.LEASE_STALE_MS; // 40_000

describe('LeaseStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-25T00:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('claimLease on a free lease sets holder/seen, arms the alarm, broadcasts', () => {
    const { core, alarms, broadcasts } = setup();
    const lease = new LeaseStore(core);
    expect(lease.claimLease('c1')).toBe(true);
    expect(core.metaGet('lease_holder')).toBe('c1');
    expect(core.metaGet('lease_seen_ms')).toBe(String(Date.now()));
    expect(alarms).toEqual([Date.now() + STALE]);
    expect(broadcasts).toEqual([{ type: 'lease.changed' }]);
  });

  it('claimLease by a different client while alive returns false and mutates nothing', () => {
    const { core } = setup();
    const lease = new LeaseStore(core);
    lease.claimLease('c1');
    expect(lease.claimLease('c2')).toBe(false);
    expect(core.metaGet('lease_holder')).toBe('c1');
  });

  it('claimLease steals the lease once it is stale', () => {
    const { core } = setup();
    const lease = new LeaseStore(core);
    lease.claimLease('c1');
    vi.advanceTimersByTime(STALE);
    expect(lease.claimLease('c2')).toBe(true);
    expect(core.metaGet('lease_holder')).toBe('c2');
  });

  it('heartbeatLease re-arms for the holder and rejects a non-holder', () => {
    const { core, alarms } = setup();
    const lease = new LeaseStore(core);
    lease.claimLease('c1');
    alarms.length = 0;
    vi.advanceTimersByTime(10_000);
    expect(lease.heartbeatLease('c1')).toBe(true);
    expect(alarms).toEqual([Date.now() + STALE]);
    expect(lease.heartbeatLease('c2')).toBe(false);
  });

  it('releaseLease clears + broadcasts for the holder, no-ops for others', () => {
    const { core, broadcasts } = setup();
    const lease = new LeaseStore(core);
    lease.claimLease('c1');
    broadcasts.length = 0;
    lease.releaseLease('c2');
    expect(core.metaGet('lease_holder')).not.toBeNull();
    lease.releaseLease('c1');
    expect(core.metaGet('lease_holder')).toBeNull();
    expect(broadcasts).toEqual([{ type: 'lease.changed' }]);
  });

  it('expireIfStale frees a stale lease and does NOT re-arm', () => {
    const { core, alarms, broadcasts } = setup();
    const lease = new LeaseStore(core);
    lease.claimLease('c1');
    alarms.length = 0;
    broadcasts.length = 0;
    vi.advanceTimersByTime(STALE);
    lease.expireIfStale();
    expect(core.metaGet('lease_holder')).toBeNull();
    expect(broadcasts).toEqual([{ type: 'lease.changed' }]);
    expect(alarms).toEqual([]);
  });

  // Regression guard for the core fix:
  it('expireIfStale re-arms (does NOT free) when the lease is still alive', () => {
    const { core, alarms, broadcasts } = setup();
    const lease = new LeaseStore(core);
    lease.claimLease('c1');
    const seen = Number(core.metaGet('lease_seen_ms'));
    alarms.length = 0;
    broadcasts.length = 0;
    vi.advanceTimersByTime(10_000); // still < STALE
    lease.expireIfStale();
    expect(core.metaGet('lease_holder')).toBe('c1');
    expect(broadcasts).toEqual([]);
    expect(alarms).toEqual([seen + STALE]);
  });

  it('treats a non-numeric lease_seen_ms as 0 (stale), not NaN (alive forever)', () => {
    const { core } = setup();
    const lease = new LeaseStore(core);
    core.metaSet('lease_holder', 'c1');
    core.metaSet('lease_seen_ms', 'x');
    lease.expireIfStale();
    expect(core.metaGet('lease_holder')).toBeNull();
  });
});
