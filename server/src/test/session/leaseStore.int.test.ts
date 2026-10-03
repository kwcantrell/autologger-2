import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LeaseStore } from '@autologger/session-core/leaseStore';
import { boundCore } from './boundCore';

// A REAL core over the bound-core harness (code-health-tail task 5.2,
// session-tables D12) — replaces this file's hand-rolled `as unknown as
// SessionCore` cast fake. Meta state is read/seeded through the core's own
// meta helpers; the clock follows Date.now() so vitest's faked Date controls
// it, as before (only Date is faked: the database driver needs real timers).
async function setup() {
  const { run, read, alarms, broadcasts } = await boundCore({ now: () => Date.now() });
  return { run, read, alarms, broadcasts };
}

const STALE = LeaseStore.LEASE_STALE_MS; // 40_000

describe('LeaseStore', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-25T00:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('claimLease on a free lease sets holder/seen, arms the alarm, broadcasts', async () => {
    const { run, read, alarms, broadcasts } = await setup();
    expect(await run((s) => s.lease.claimLease('c1'))).toBe(true);
    expect(await read((s) => s.core.metaGet('lease_holder'))).toBe('c1');
    expect(await read((s) => s.core.metaGet('lease_seen_ms'))).toBe(String(Date.now()));
    expect(alarms).toEqual([Date.now() + STALE]);
    expect(broadcasts).toEqual([{ type: 'lease.changed' }]);
  });

  it('claimLease by a different client while alive returns false and mutates nothing', async () => {
    const { run, read } = await setup();
    await run((s) => s.lease.claimLease('c1'));
    expect(await run((s) => s.lease.claimLease('c2'))).toBe(false);
    expect(await read((s) => s.core.metaGet('lease_holder'))).toBe('c1');
  });

  it('claimLease steals the lease once it is stale', async () => {
    const { run, read } = await setup();
    await run((s) => s.lease.claimLease('c1'));
    vi.advanceTimersByTime(STALE);
    expect(await run((s) => s.lease.claimLease('c2'))).toBe(true);
    expect(await read((s) => s.core.metaGet('lease_holder'))).toBe('c2');
  });

  it('heartbeatLease re-arms for the holder and rejects a non-holder', async () => {
    const { run, alarms } = await setup();
    await run((s) => s.lease.claimLease('c1'));
    alarms.length = 0;
    vi.advanceTimersByTime(10_000);
    expect(await run((s) => s.lease.heartbeatLease('c1'))).toBe(true);
    expect(alarms).toEqual([Date.now() + STALE]);
    expect(await run((s) => s.lease.heartbeatLease('c2'))).toBe(false);
  });

  it('releaseLease clears + broadcasts for the holder, no-ops for others', async () => {
    const { run, read, broadcasts } = await setup();
    await run((s) => s.lease.claimLease('c1'));
    broadcasts.length = 0;
    await run((s) => s.lease.releaseLease('c2'));
    expect(await read((s) => s.core.metaGet('lease_holder'))).not.toBeNull();
    await run((s) => s.lease.releaseLease('c1'));
    expect(await read((s) => s.core.metaGet('lease_holder'))).toBeNull();
    expect(broadcasts).toEqual([{ type: 'lease.changed' }]);
  });

  it('expireIfStale frees a stale lease and does NOT re-arm', async () => {
    const { run, read, alarms, broadcasts } = await setup();
    await run((s) => s.lease.claimLease('c1'));
    alarms.length = 0;
    broadcasts.length = 0;
    vi.advanceTimersByTime(STALE);
    await run((s) => s.lease.expireIfStale());
    expect(await read((s) => s.core.metaGet('lease_holder'))).toBeNull();
    expect(broadcasts).toEqual([{ type: 'lease.changed' }]);
    expect(alarms).toEqual([]);
  });

  // Regression guard for the core fix:
  it('expireIfStale re-arms (does NOT free) when the lease is still alive', async () => {
    const { run, read, alarms, broadcasts } = await setup();
    await run((s) => s.lease.claimLease('c1'));
    const seen = Number(await read((s) => s.core.metaGet('lease_seen_ms')));
    alarms.length = 0;
    broadcasts.length = 0;
    vi.advanceTimersByTime(10_000); // still < STALE
    await run((s) => s.lease.expireIfStale());
    expect(await read((s) => s.core.metaGet('lease_holder'))).toBe('c1');
    expect(broadcasts).toEqual([]);
    expect(alarms).toEqual([seen + STALE]);
  });

  it('treats a non-numeric lease_seen_ms as 0 (stale), not NaN (alive forever)', async () => {
    const { run, read } = await setup();
    await run((s) => s.core.metaSet('lease_holder', 'c1'));
    await run((s) => s.core.metaSet('lease_seen_ms', 'x'));
    await run((s) => s.lease.expireIfStale());
    expect(await read((s) => s.core.metaGet('lease_holder'))).toBeNull();
  });
});
