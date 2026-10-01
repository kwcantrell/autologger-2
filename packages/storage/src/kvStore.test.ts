import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AsyncSqliteCatalogDb } from './asyncCatalogStore';
import { KvStore } from './kvStore';
import { makeFakeClock } from './test/fakeClock';

function store(): KvStore {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER)');
  // clock is required (task 2.4); vi.useFakeTimers() (beforeEach below) fakes
  // global Date, so a plain Date.now()-reading clock still advances with
  // vi.advanceTimersByTime — identical behavior to the old DEFAULT_CLOCK.
  return new KvStore(new AsyncSqliteCatalogDb(db), { now: () => Date.now() });
}

describe('KvStore', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('every operation returns a promise (async-session-callers D2)', async () => {
    const s = store();
    const ops = [s.put('a', 'b'), s.get('a'), s.delete('a'), s.purgeExpired()];
    for (const op of ops) expect(op).toBeInstanceOf(Promise);
    await Promise.all(ops);
  });

  it('an expired get returns null and has removed the row once it resolves', async () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER)');
    const s = new KvStore(new AsyncSqliteCatalogDb(db), { now: () => Date.now() });
    await s.put('k', 'v', { expirationTtl: 1 });
    vi.advanceTimersByTime(2_000);
    expect(await s.get('k')).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM kv').get()).toEqual({ n: 0 });
  });

  it('round-trips a value without TTL', async () => {
    const s = store();
    await s.put('a', 'hello');
    expect(await s.get('a')).toBe('hello');
    await s.delete('a');
    expect(await s.get('a')).toBeNull();
  });

  it('expires lazily on get after expirationTtl seconds', async () => {
    const s = store();
    await s.put('sess', 'tok', { expirationTtl: 60 });
    expect(await s.get('sess')).toBe('tok');
    vi.advanceTimersByTime(61_000);
    expect(await s.get('sess')).toBeNull();
  });

  it('put overwrites value and TTL', async () => {
    const s = store();
    await s.put('k', 'v1', { expirationTtl: 10 });
    await s.put('k', 'v2'); // no TTL now
    vi.advanceTimersByTime(60_000);
    expect(await s.get('k')).toBe('v2');
  });

  it('purgeExpired deletes dead rows and keeps live ones', async () => {
    const s = store();
    await s.put('dead', 'x', { expirationTtl: 1 });
    await s.put('live', 'y', { expirationTtl: 9999 });
    await s.put('forever', 'z');
    vi.advanceTimersByTime(5_000);
    await s.purgeExpired();
    expect(await s.get('live')).toBe('y');
    expect(await s.get('forever')).toBe('z');
    expect(await s.get('dead')).toBeNull();
  });

  it("an expired key re-put between get's read and its expiry delete survives", async () => {
    const s = store();
    await s.put('k', 'old', { expirationTtl: 1 });
    vi.advanceTimersByTime(2_000);
    // get's SELECT, this put, then get's DELETE are separate lock acquisitions, in call order.
    const [got] = await Promise.all([s.get('k'), s.put('k', 'fresh')]);
    expect(got).toBeNull();
    expect(await s.get('k')).toBe('fresh');
  });
});

// async-catalog-adapter D5: KV shares the catalog connection, so it waits for an open adapter
// transaction instead of joining it.
describe('KvStore on the async catalog adapter', () => {
  it('a write issued during an open transaction lands after it and survives its rollback', async () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER)');
    const catalog = new AsyncSqliteCatalogDb(db);
    const s = new KvStore(catalog, { now: () => Date.now() });
    let open!: () => void;
    const held = new Promise<void>((r) => {
      open = r;
    });
    const txp = catalog.tx(async (t) => {
      await t.run("INSERT INTO kv (key, value, expires_at) VALUES ('in-tx', 'x', NULL)");
      await held;
      throw new Error('roll back');
    });
    let written = false;
    const put = s.put('k', 'v').then(() => {
      written = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(written).toBe(false);
    open();
    await expect(txp).rejects.toThrow('roll back');
    await put;
    expect(await s.get('k')).toBe('v');
    expect(await s.get('in-tx')).toBeNull();
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
    return { store: new KvStore(new AsyncSqliteCatalogDb(raw), clock), tick };
  }

  it('an entry expires once the fake clock passes its TTL', async () => {
    const { store, tick } = kv();
    await store.put('csrf:x', '1', { expirationTtl: 600 }); // 10 minutes
    expect(await store.get('csrf:x')).toBe('1');
    tick(599_000);
    expect(await store.get('csrf:x')).toBe('1');
    tick(2_000);
    expect(await store.get('csrf:x')).toBeNull();
  });

  it('purgeExpired removes only entries past their TTL', async () => {
    const { store, tick } = kv();
    await store.put('short', 'a', { expirationTtl: 10 });
    await store.put('long', 'b', { expirationTtl: 1000 });
    await store.put('forever', 'c');
    tick(11_000);
    await store.purgeExpired();
    expect(await store.get('short')).toBeNull();
    expect(await store.get('long')).toBe('b');
    expect(await store.get('forever')).toBe('c');
  });
});
