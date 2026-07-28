import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakeClock } from '../test/fakeClock';
import { KvStore } from './kvStore';

function store(): KvStore {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER)');
  return new KvStore(db);
}

describe('KvStore', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('round-trips a value without TTL', () => {
    const s = store();
    s.put('a', 'hello');
    expect(s.get('a')).toBe('hello');
    s.delete('a');
    expect(s.get('a')).toBeNull();
  });

  it('expires lazily on get after expirationTtl seconds', () => {
    const s = store();
    s.put('sess', 'tok', { expirationTtl: 60 });
    expect(s.get('sess')).toBe('tok');
    vi.advanceTimersByTime(61_000);
    expect(s.get('sess')).toBeNull();
  });

  it('put overwrites value and TTL', () => {
    const s = store();
    s.put('k', 'v1', { expirationTtl: 10 });
    s.put('k', 'v2'); // no TTL now
    vi.advanceTimersByTime(60_000);
    expect(s.get('k')).toBe('v2');
  });

  it('purgeExpired deletes dead rows and keeps live ones', () => {
    const s = store();
    s.put('dead', 'x', { expirationTtl: 1 });
    s.put('live', 'y', { expirationTtl: 9999 });
    s.put('forever', 'z');
    vi.advanceTimersByTime(5_000);
    s.purgeExpired();
    expect(s.get('live')).toBe('y');
    expect(s.get('forever')).toBe('z');
    expect(s.get('dead')).toBeNull();
  });
});

// Relocated from session/fakeClock.test.ts (code-health-tail task 5.2) — this
// suite tests KvStore, so it lives beside it. Fake-clock determinism
// (de-cloudflare-strong-core task 5.4): TTL reads share the injected time
// base, so expiry is provable with zero real elapsed time.
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
