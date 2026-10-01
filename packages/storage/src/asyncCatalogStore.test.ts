// async-catalog-adapter tasks 1.2 (design D2-D4; core-ports-architecture "The catalog transaction
// contract" and "The SQLite catalog adapter serialises each connection"). The contract cases live in
// the shared suite (postgres-catalog-adapter design D8); this file adds the SQLite-only ones.
import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  AsyncSqliteCatalogDb,
  CatalogAdapterBrokenError,
  CatalogTxMisuseError,
} from './asyncCatalogStore';
import { describeCatalogDbContract, gate, pendingAfter, prompt } from './test/catalogDbContract';

function raw(): Database.Database {
  const r = new Database(':memory:');
  r.pragma('foreign_keys = ON');
  r.exec('CREATE TABLE t (k TEXT PRIMARY KEY, v INTEGER)');
  r.exec('CREATE TABLE log (n INTEGER PRIMARY KEY AUTOINCREMENT, who TEXT NOT NULL)');
  r.exec('CREATE TABLE p (id INTEGER PRIMARY KEY)');
  r.exec('CREATE TABLE c (pid INTEGER REFERENCES p(id) DEFERRABLE INITIALLY DEFERRED)');
  return r;
}

const count = (r: Database.Database, table = 't') =>
  (r.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describeCatalogDbContract('AsyncSqliteCatalogDb', {
  uniqueViolation: 'SQLITE_CONSTRAINT_PRIMARYKEY',
  foreignKeyViolation: 'SQLITE_CONSTRAINT_FOREIGNKEY',
  shortTxTimeoutMs: 50,
  async make(opts) {
    const r = raw();
    const db = new AsyncSqliteCatalogDb(r, opts);
    return {
      db,
      async count(table, where) {
        const sql = `SELECT COUNT(*) AS n FROM ${table}${where ? ` WHERE ${where[0]} = ?` : ''}`;
        expect(r.inTransaction, 'connection left inside a transaction').toBe(false);
        return (r.prepare(sql).get(...(where ? [where[1]] : [])) as { n: number }).n;
      },
      async close() {
        r.close();
      },
    };
  },
});

const unhandled: unknown[] = [];
const trap = (e: unknown) => unhandled.push(e);
beforeAll(() => {
  process.on('unhandledRejection', trap);
});
afterAll(() => {
  process.off('unhandledRejection', trap);
});
afterEach(async () => {
  await new Promise((r) => setTimeout(r, 5));
  expect(unhandled, 'unhandled rejections').toEqual([]);
  unhandled.length = 0;
});

describe('AsyncSqliteCatalogDb: SQLite auto-rollback', () => {
  it('a caught auto-rollback (RAISE(ROLLBACK)) does not let later writes autocommit', async () => {
    const r = raw();
    r.exec(
      "CREATE TRIGGER trg BEFORE INSERT ON t WHEN NEW.k = 'boom' BEGIN SELECT RAISE(ROLLBACK, 'boom'); END",
    );
    const a = new AsyncSqliteCatalogDb(r);
    await expect(
      a.tx(async (t) => {
        await t.run('INSERT INTO t (k, v) VALUES (?, ?)', 'a', 1);
        try {
          await t.run('INSERT INTO t (k, v) VALUES (?, ?)', 'boom', 2);
        } catch {
          // swallowed on purpose
        }
        try {
          await t.run('INSERT INTO t (k, v) VALUES (?, ?)', 'd', 4);
        } catch {
          // swallowed on purpose
        }
      }),
    ).rejects.toThrow('boom');
    expect(count(r)).toBe(0);
    expect(r.inTransaction).toBe(false);
  });
});

describe('AsyncSqliteCatalogDb: lock', () => {
  it('a root read waits for an open transaction and sees its outcome', async () => {
    const r = raw();
    const a = new AsyncSqliteCatalogDb(r);
    for (const outcome of ['commit', 'rollback'] as const) {
      r.exec('DELETE FROM t');
      const g = gate();
      const txp = a.tx(async (t) => {
        await t.run('INSERT INTO t (k, v) VALUES (?, ?)', 'a', 1);
        await g.wait;
        if (outcome === 'rollback') throw new Error('rb');
      });
      const read = a.first<{ n: number }>('SELECT COUNT(*) AS n FROM t');
      expect(await pendingAfter(read)).toBe(true);
      g.open();
      await txp.catch(() => {});
      expect(await read).toEqual({ n: outcome === 'commit' ? 1 : 0 });
    }
  });

  it('serves callers in call order', async () => {
    const r = raw();
    const a = new AsyncSqliteCatalogDb(r);
    const g = gate();
    const p1 = a.tx(async (t) => {
      await g.wait;
      await t.run('INSERT INTO log (who) VALUES (?)', 'tx1');
    });
    const p2 = a.run('INSERT INTO log (who) VALUES (?)', 'root');
    const p3 = a.tx(async (t) => {
      await t.run('INSERT INTO log (who) VALUES (?)', 'tx2');
    });
    g.open();
    await Promise.all([p1, p2, p3]);
    expect(r.prepare('SELECT who FROM log ORDER BY n').all()).toEqual([
      { who: 'tx1' },
      { who: 'root' },
      { who: 'tx2' },
    ]);
  });

  it('two adapters on one connection share the lock; separate connections do not block', async () => {
    const r = raw();
    const a1 = new AsyncSqliteCatalogDb(r);
    const a2 = new AsyncSqliteCatalogDb(r);
    const other = new AsyncSqliteCatalogDb(raw());
    const g = gate();
    const txp = a1.tx(async (t) => {
      await t.run('INSERT INTO t (k, v) VALUES (?, ?)', 'a', 1);
      await g.wait;
      throw new Error('rb');
    });
    const fromSecond = a2.first<{ n: number }>('SELECT COUNT(*) AS n FROM t');
    expect(await pendingAfter(fromSecond)).toBe(true);
    expect(await prompt(other.first('SELECT COUNT(*) AS n FROM t'))).toEqual({ n: 0 });
    g.open();
    await txp.catch(() => {});
    expect(await fromSecond).toEqual({ n: 0 });
  });

  it('releases the lock after a failed transaction', async () => {
    const r = raw();
    const a = new AsyncSqliteCatalogDb(r);
    await expect(a.tx(async () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    await expect(
      a.tx(async () => {
        throw new Error('sync-ish');
      }),
    ).rejects.toThrow('sync-ish');
    expect(await prompt(a.run('INSERT INTO t (k, v) VALUES (?, ?)', 'a', 1))).toEqual({
      changes: 1,
    });
    expect(await prompt(a.tx(async (t) => t.first('SELECT k FROM t')))).toEqual({ k: 'a' });
  });

  it('refuses a connection left inside a raw transaction, then recovers once it ends', async () => {
    const r = raw();
    const a = new AsyncSqliteCatalogDb(r);
    r.exec('BEGIN');
    await expect(prompt(a.all('SELECT * FROM t'))).rejects.toBeInstanceOf(CatalogTxMisuseError);
    await expect(prompt(a.tx(async () => 1))).rejects.toBeInstanceOf(CatalogTxMisuseError);
    r.exec('ROLLBACK');
    expect(await prompt(a.all('SELECT * FROM t'))).toEqual([]);
    expect(await prompt(a.tx(async () => 2))).toBe(2);
  });
});

describe('AsyncSqliteCatalogDb: broken connection', () => {
  it('a failed ROLLBACK refuses every later and queued call', async () => {
    const r = raw();
    r.exec("INSERT INTO t (k, v) VALUES ('seed', 0)");
    const a = new AsyncSqliteCatalogDb(r);
    const original = new Error('body failed');
    let it!: IterableIterator<unknown>;
    const failing = a.tx(async (t) => {
      await t.run('INSERT INTO t (k, v) VALUES (?, ?)', 'a', 1);
      // A raw iterator opened inside the transaction keeps the connection busy, so ROLLBACK fails.
      it = r.prepare('SELECT * FROM t').iterate();
      it.next();
      throw original;
    });
    // The failing call keeps its own (first) error; only later calls see "broken".
    await expect(failing).rejects.toBe(original);
    await expect(prompt(a.all('SELECT * FROM t'))).rejects.toBeInstanceOf(
      CatalogAdapterBrokenError,
    );
    await expect(prompt(a.tx(async () => 1))).rejects.toBeInstanceOf(CatalogAdapterBrokenError);
    it.return?.();
  });

  it('a call already queued behind the failing transaction rejects as broken', async () => {
    const r = raw();
    r.exec("INSERT INTO t (k, v) VALUES ('seed', 0)");
    const a = new AsyncSqliteCatalogDb(r);
    let it!: IterableIterator<unknown>;
    const g = gate();
    const failing = a.tx(async () => {
      await g.wait;
      it = r.prepare('SELECT * FROM t').iterate();
      it.next();
      throw new Error('body failed');
    });
    const queued = a.all('SELECT * FROM t');
    g.open();
    await expect(failing).rejects.toThrow('body failed');
    await expect(prompt(queued)).rejects.toBeInstanceOf(CatalogAdapterBrokenError);
    it.return?.();
  });
});

describe('AsyncSqliteCatalogDb: onBroken (async-catalog-stores D5)', () => {
  it('is called once, after the failing call rejects with its own error', async () => {
    const r = raw();
    r.exec("INSERT INTO t (k, v) VALUES ('seed', 0)");
    const events: string[] = [];
    const a = new AsyncSqliteCatalogDb(r, { onBroken: () => events.push('broken') });
    let it!: IterableIterator<unknown>;
    const failing = a
      .tx(async () => {
        it = r.prepare('SELECT * FROM t').iterate();
        it.next(); // keeps the connection busy, so ROLLBACK fails
        throw new Error('body failed');
      })
      .catch((e: Error) => {
        events.push(`rejected: ${e.message}`);
      });
    await failing;
    await new Promise((res) => setImmediate(res));
    await a.all('SELECT 1').catch(() => {});
    await new Promise((res) => setImmediate(res));
    expect(events).toEqual(['rejected: body failed', 'broken']);
    it.return?.();
  });

  it('a throwing onBroken does not affect the adapter', async () => {
    const r = raw();
    r.exec("INSERT INTO t (k, v) VALUES ('seed', 0)");
    const a = new AsyncSqliteCatalogDb(r, {
      onBroken: () => {
        throw new Error('callback blew up');
      },
    });
    let it!: IterableIterator<unknown>;
    await expect(
      a.tx(async () => {
        it = r.prepare('SELECT * FROM t').iterate();
        it.next();
        throw new Error('body failed');
      }),
    ).rejects.toThrow('body failed');
    await new Promise((res) => setImmediate(res));
    await expect(prompt(a.all('SELECT 1'))).rejects.toBeInstanceOf(CatalogAdapterBrokenError);
    it.return?.();
  });
});
