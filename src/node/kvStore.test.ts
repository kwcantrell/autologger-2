import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
