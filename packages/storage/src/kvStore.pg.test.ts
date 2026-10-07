// KvStore against the Postgres catalog adapter, as the app's least-privilege role on a cloned
// test database (retire-sqlite-catalog D2). Time comes from an injected mutable clock: fake global
// timers would also freeze postgres.js's own timers.
import type { CatalogDb } from '@autologger/ports';
import { afterEach, describe, expect, it } from 'vitest';
import { KvStore } from './kvStore';
import { PostgresCatalogDb } from './postgresCatalogStore';
import { createTestDatabase } from './test/pgDb';

const open: PostgresCatalogDb[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((db) => db.close()));
});

interface Env {
  /** A `system:kv` handle, as the server builds KV (catalog-roles D9). */
  db: CatalogDb;
  s: KvStore;
  tick(ms: number): void;
}

async function env(wrap?: (db: CatalogDb) => CatalogDb): Promise<Env> {
  const root = new PostgresCatalogDb((await createTestDatabase()).app);
  open.push(root);
  const db = root.bindSystem('kv');
  let now = 1_750_000_000_000;
  const s = new KvStore(wrap ? wrap(db) : db, { now: () => now });
  return {
    db,
    s,
    tick: (ms) => {
      now += ms;
    },
  };
}

const rows = async (db: CatalogDb) =>
  (await db.first<{ n: number }>('SELECT count(*) AS n FROM kv'))?.n;

describe('KvStore', () => {
  it('every operation returns a promise (async-session-callers D2)', async () => {
    const { s } = await env();
    const ops = [s.put('a', 'b'), s.get('a'), s.delete('a'), s.purgeExpired()];
    for (const op of ops) expect(op).toBeInstanceOf(Promise);
    await Promise.all(ops);
  });

  it('round-trips a value without TTL, and deletes it', async () => {
    const { s } = await env();
    await s.put('a', 'hello');
    expect(await s.get('a')).toBe('hello');
    await s.delete('a');
    expect(await s.get('a')).toBeNull();
  });

  it('an entry expires once the clock passes its TTL, and the expired get removes the row', async () => {
    const { db, s, tick } = await env();
    await s.put('csrf:x', '1', { expirationTtl: 600 });
    expect(await s.get('csrf:x')).toBe('1');
    tick(599_000);
    expect(await s.get('csrf:x')).toBe('1');
    tick(2_000);
    expect(await s.get('csrf:x')).toBeNull();
    expect(await rows(db)).toBe(0);
  });

  it('put overwrites value and TTL', async () => {
    const { s, tick } = await env();
    await s.put('k', 'v1', { expirationTtl: 10 });
    await s.put('k', 'v2'); // no TTL now
    tick(60_000);
    expect(await s.get('k')).toBe('v2');
  });

  it('purgeExpired deletes dead rows and keeps live ones', async () => {
    const { s, tick } = await env();
    await s.put('dead', 'x', { expirationTtl: 1 });
    await s.put('live', 'y', { expirationTtl: 9999 });
    await s.put('forever', 'z');
    tick(5_000);
    await s.purgeExpired();
    expect(await s.get('live')).toBe('y');
    expect(await s.get('forever')).toBe('z');
    expect(await s.get('dead')).toBeNull();
  });

  it("a key re-put between an expired get's read and its delete survives", async () => {
    // After get's SELECT returns, the re-put lands before get's DELETE is sent.
    let rePut: (() => Promise<void>) | null = null;
    const { s, tick } = await env((db) => ({
      ...db,
      all: db.all.bind(db),
      run: db.run.bind(db),
      tx: db.tx.bind(db),
      first: async <T>(sql: string, ...binds: unknown[]) => {
        const row = await db.first<T>(sql, ...binds);
        if (rePut && sql.startsWith('SELECT value')) {
          const go = rePut;
          rePut = null;
          await go();
        }
        return row;
      },
    }));
    await s.put('k', 'old', { expirationTtl: 1 });
    tick(2_000);
    rePut = () => s.put('k', 'fresh');
    expect(await s.get('k')).toBeNull();
    expect(await s.get('k')).toBe('fresh');
  });
});

// async-catalog-stores D4: take() is one atomic DELETE … RETURNING (OAuth state is single-use).
describe('KvStore.take', () => {
  it('returns a live value once and removes it', async () => {
    const { s } = await env();
    await s.put('k', 'v');
    expect(await s.take('k')).toBe('v');
    expect(await s.take('k')).toBeNull();
    expect(await s.get('k')).toBeNull();
  });

  it('returns null for a missing key', async () => {
    const { s } = await env();
    expect(await s.take('nope')).toBeNull();
  });

  it('returns null for an expired entry and removes it', async () => {
    const { db, s, tick } = await env();
    await s.put('k', 'v', { expirationTtl: 1 });
    tick(2_000);
    expect(await s.take('k')).toBeNull();
    expect(await rows(db)).toBe(0);
  });

  it('two concurrent takes: exactly one gets the value', async () => {
    const { s } = await env();
    await s.put('state', '1');
    const got = await Promise.all([s.take('state'), s.take('state')]);
    expect(got.filter((v) => v === '1')).toHaveLength(1);
    expect(got.filter((v) => v === null)).toHaveLength(1);
    expect(await s.get('state')).toBeNull();
  });
});

describe('KvStore.replaceIf (catalog-concurrency-hazards D7)', () => {
  it('replaces only when the stored value is the expected one, keeping the expiry', async () => {
    const { s, tick } = await env();
    await s.put('k', 'a', { expirationTtl: 60 });
    expect(await s.replaceIf('k', 'stale', 'x')).toBe(false);
    expect(await s.get('k')).toBe('a');
    expect(await s.replaceIf('k', 'a', 'b')).toBe(true);
    expect(await s.get('k')).toBe('b');
    tick(61_000);
    expect(await s.get('k')).toBeNull(); // the expiry was kept
  });

  it('refuses a missing or expired key', async () => {
    const { s, tick } = await env();
    expect(await s.replaceIf('nope', 'a', 'b')).toBe(false);
    await s.put('k', 'a', { expirationTtl: 1 });
    tick(2_000);
    expect(await s.replaceIf('k', 'a', 'b')).toBe(false);
  });

  // shared-request-state D1: the log-import job store refreshes its record's expiry on every write.
  it('with {expirationTtl} sets the new expiry in the same swap; without it keeps the old one', async () => {
    const { s, tick } = await env();
    await s.put('k', 'a', { expirationTtl: 60 });
    expect(await s.replaceIf('k', 'a', 'b', { expirationTtl: 600 })).toBe(true);
    tick(61_000);
    expect(await s.get('k')).toBe('b'); // the old 60 s expiry was replaced
    expect(await s.replaceIf('k', 'b', 'c')).toBe(true);
    tick(538_000);
    expect(await s.get('k')).toBe('c'); // 599 s after the swap: kept the 600 s expiry
    tick(2_000);
    expect(await s.get('k')).toBeNull();
  });

  it('with {expirationTtl} still refuses a stale expected value and leaves the expiry alone', async () => {
    const { s, tick } = await env();
    await s.put('k', 'a', { expirationTtl: 60 });
    expect(await s.replaceIf('k', 'stale', 'x', { expirationTtl: 600 })).toBe(false);
    tick(61_000);
    expect(await s.get('k')).toBeNull();
  });
});

// core-ports-architecture "The Postgres catalog adapter": a key/value call never joins a catalog
// transaction.
describe('KvStore beside a catalog transaction', () => {
  it('a write made while a transaction is open survives its rollback; the transaction row does not', async () => {
    const { db, s } = await env();
    let open!: () => void;
    const held = new Promise<void>((r) => {
      open = r;
    });
    let inserted!: () => void;
    const didInsert = new Promise<void>((r) => {
      inserted = r;
    });
    const txp = db.tx(async (t) => {
      await t.run("INSERT INTO kv (key, value, expires_at) VALUES ('in-tx', 'x', NULL)");
      inserted();
      await held;
      throw new Error('roll back');
    });
    await didInsert;
    await s.put('k', 'v'); // resolves while the transaction is still open
    open();
    await expect(txp).rejects.toThrow('roll back');
    expect(await s.get('k')).toBe('v');
    expect(await s.get('in-tx')).toBeNull();
  });
});
