import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LeaseStore } from './leaseStore';
import type { SessionCore } from './sessionCore';

function fakeCore() {
  const meta = new Map<string, string>();
  const alarms: number[] = [];
  const broadcasts: unknown[] = [];
  const core = {
    now: (): number => Date.now(), // vitest fake timers control this
    metaGet: (k: string): string | null => (meta.has(k) ? (meta.get(k) as string) : null),
    metaSet: (k: string, v: string): void => void meta.set(k, v),
    metaDelete: (k: string): void => void meta.delete(k),
    setAlarm: (atMs: number): void => void alarms.push(atMs),
    broadcast: (m: unknown): void => void broadcasts.push(m),
  };
  return { core: core as unknown as SessionCore, meta, alarms, broadcasts };
}

const STALE = LeaseStore.LEASE_STALE_MS; // 40_000

describe('LeaseStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-25T00:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('claimLease on a free lease sets holder/seen, arms the alarm, broadcasts', () => {
    const { core, meta, alarms, broadcasts } = fakeCore();
    const lease = new LeaseStore(core);
    expect(lease.claimLease('c1')).toBe(true);
    expect(meta.get('lease_holder')).toBe('c1');
    expect(meta.get('lease_seen_ms')).toBe(String(Date.now()));
    expect(alarms).toEqual([Date.now() + STALE]);
    expect(broadcasts).toEqual([{ type: 'lease.changed' }]);
  });

  it('claimLease by a different client while alive returns false and mutates nothing', () => {
    const { core, meta } = fakeCore();
    const lease = new LeaseStore(core);
    lease.claimLease('c1');
    expect(lease.claimLease('c2')).toBe(false);
    expect(meta.get('lease_holder')).toBe('c1');
  });

  it('claimLease steals the lease once it is stale', () => {
    const { core, meta } = fakeCore();
    const lease = new LeaseStore(core);
    lease.claimLease('c1');
    vi.advanceTimersByTime(STALE);
    expect(lease.claimLease('c2')).toBe(true);
    expect(meta.get('lease_holder')).toBe('c2');
  });

  it('heartbeatLease re-arms for the holder and rejects a non-holder', () => {
    const { core, alarms } = fakeCore();
    const lease = new LeaseStore(core);
    lease.claimLease('c1');
    alarms.length = 0;
    vi.advanceTimersByTime(10_000);
    expect(lease.heartbeatLease('c1')).toBe(true);
    expect(alarms).toEqual([Date.now() + STALE]);
    expect(lease.heartbeatLease('c2')).toBe(false);
  });

  it('releaseLease clears + broadcasts for the holder, no-ops for others', () => {
    const { core, meta, broadcasts } = fakeCore();
    const lease = new LeaseStore(core);
    lease.claimLease('c1');
    broadcasts.length = 0;
    lease.releaseLease('c2');
    expect(meta.has('lease_holder')).toBe(true);
    lease.releaseLease('c1');
    expect(meta.has('lease_holder')).toBe(false);
    expect(broadcasts).toEqual([{ type: 'lease.changed' }]);
  });

  it('expireIfStale frees a stale lease and does NOT re-arm', () => {
    const { core, meta, alarms, broadcasts } = fakeCore();
    const lease = new LeaseStore(core);
    lease.claimLease('c1');
    alarms.length = 0;
    broadcasts.length = 0;
    vi.advanceTimersByTime(STALE);
    lease.expireIfStale();
    expect(meta.has('lease_holder')).toBe(false);
    expect(broadcasts).toEqual([{ type: 'lease.changed' }]);
    expect(alarms).toEqual([]);
  });

  // Regression guard for the core fix:
  it('expireIfStale re-arms (does NOT free) when the lease is still alive', () => {
    const { core, meta, alarms, broadcasts } = fakeCore();
    const lease = new LeaseStore(core);
    lease.claimLease('c1');
    const seen = Number(meta.get('lease_seen_ms'));
    alarms.length = 0;
    broadcasts.length = 0;
    vi.advanceTimersByTime(10_000); // still < STALE
    lease.expireIfStale();
    expect(meta.get('lease_holder')).toBe('c1');
    expect(broadcasts).toEqual([]);
    expect(alarms).toEqual([seen + STALE]);
  });

  it('treats a non-numeric lease_seen_ms as 0 (stale), not NaN (alive forever)', () => {
    const { core, meta } = fakeCore();
    const lease = new LeaseStore(core);
    meta.set('lease_holder', 'c1');
    meta.set('lease_seen_ms', 'x');
    lease.expireIfStale();
    expect(meta.has('lease_holder')).toBe(false);
  });
});
