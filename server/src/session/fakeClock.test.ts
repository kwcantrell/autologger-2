// Fake-clock determinism (de-cloudflare-strong-core tasks 5.3/5.4): the alarm
// scheduler and every staleness/TTL read share one injected time base, so
// expiry is provable with zero real elapsed time. tick() advances the fake
// Clock and vitest's timer queue in lockstep — the shared-time-base guarantee
// under test.

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Clock } from '../clock';
import { KvStore } from '../node/kvStore';
import { PresenceRegistry, PRESENCE_FRESH_MS } from '../node/presence';
import { SessionHub } from './SessionHub';

function makeFakeClock(startMs = 1_750_000_000_000): { clock: Clock; tick(ms: number): void } {
  let now = startMs;
  return {
    clock: { now: () => now },
    tick(ms: number) {
      now += ms;
      vi.advanceTimersByTime(ms); // keep the setTimeout queue on the same base
    },
  };
}

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

describe('KV TTL with a fake clock (task 5.4)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function kv(): { store: KvStore; tick(ms: number): void } {
    const { clock, tick } = makeFakeClock();
    const raw = new Database(':memory:');
    raw.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER)');
    return { store: new KvStore(raw, clock), tick };
  }

  it('an entry expires once the fake clock passes its TTL', () => {
    const { store, tick } = kv();
    store.put('csrf:x', '1', { expirationTtl: 600 }); // 10 minutes
    expect(store.get('csrf:x')).toBe('1');
    tick(599_000);
    expect(store.get('csrf:x')).toBe('1');
    tick(2_000);
    expect(store.get('csrf:x')).toBeNull();
  });

  it('purgeExpired removes only entries past their TTL', () => {
    const { store, tick } = kv();
    store.put('short', 'a', { expirationTtl: 10 });
    store.put('long', 'b', { expirationTtl: 1000 });
    store.put('forever', 'c');
    tick(11_000);
    store.purgeExpired();
    expect(store.get('short')).toBeNull();
    expect(store.get('long')).toBe('b');
    expect(store.get('forever')).toBe('c');
  });
});

describe('presence freshness with a fake clock (task 5.4)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('an entry goes stale once the fake clock passes the freshness window', () => {
    const { clock, tick } = makeFakeClock();
    const reg = new PresenceRegistry(clock);
    reg.upsert('tab-1', {
      session_id: 's1',
      visible: true,
      is_playing: false,
      updated: clock.now(),
    });
    expect(reg.list()).toHaveLength(1);
    tick(PRESENCE_FRESH_MS);
    expect(reg.list()).toHaveLength(1); // exactly at the window edge is still fresh
    tick(1);
    expect(reg.list()).toHaveLength(0); // pruned as stale
  });
});
