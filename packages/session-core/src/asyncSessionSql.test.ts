// The async session SQL seam's SQLite adapter (async-session-hub design D2): today's adapter's
// all/run/exec behaviour, and the transaction contract (commit, rollback on any error, joins,
// misuse, a failed COMMIT, a failed ROLLBACK). In-memory databases; an unhandled rejection fails
// the file; every "promptly" case races a 200 ms timer.

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SessionTxMisuseError, sqliteSessionSql } from './asyncSessionSql';
import type { SessionSql } from './sessionCore';

const unhandled: unknown[] = [];
const trap = (reason: unknown): void => {
  unhandled.push(reason);
};
beforeAll(() => {
  process.on('unhandledRejection', trap);
});
afterAll(() => {
  process.off('unhandledRejection', trap);
  expect(unhandled).toEqual([]);
});

/** Settles as `p` does, or rejects if `p` takes longer than 200 ms. */
function promptly<T>(p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('not settled within 200 ms')), 200);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

function setup() {
  const db = new Database(':memory:');
  const sql = sqliteSessionSql(db);
  return { db, sql };
}

async function withTable() {
  const s = setup();
  await s.sql.exec('CREATE TABLE t (x INTEGER)');
  return s;
}

const rows = (sql: SessionSql) => sql.all<{ x: number }>('SELECT x FROM t ORDER BY x');

describe('sqliteSessionSql: all/run/exec as today', () => {
  it('exec() runs multi-statement SQL with no binds (initSchema shape)', async () => {
    const { sql } = setup();
    await sql.exec(`
      CREATE TABLE a (x INTEGER);
      CREATE TABLE b (y TEXT);
      INSERT INTO a (x) VALUES (1);
    `);
    expect(await sql.all('SELECT x FROM a')).toEqual([{ x: 1 }]);
  });

  it('all() returns rows for bound SELECTs', async () => {
    const { sql } = setup();
    await sql.exec('CREATE TABLE t (k TEXT, v INTEGER)');
    await sql.run('INSERT INTO t (k, v) VALUES (?, ?)', 'a', 1);
    await sql.run('INSERT INTO t (k, v) VALUES (?, ?)', 'b', 2);
    expect(await sql.all('SELECT * FROM t WHERE v > ? ORDER BY v', 0)).toEqual([
      { k: 'a', v: 1 },
      { k: 'b', v: 2 },
    ]);
  });

  it('run() reports changes for writes (UPDATE hit and miss)', async () => {
    const { sql } = setup();
    await sql.exec('CREATE TABLE t (k TEXT PRIMARY KEY, v INTEGER)');
    await sql.run('INSERT INTO t (k, v) VALUES (?, ?)', 'a', 1);
    expect((await sql.run("UPDATE t SET v = 2 WHERE k = 'a'")).changes).toBe(1);
    expect((await sql.run("UPDATE t SET v = 2 WHERE k = 'zzz'")).changes).toBe(0);
  });

  it('binds null and numeric values', async () => {
    const { sql } = setup();
    await sql.exec('CREATE TABLE t (a, b)');
    await sql.run('INSERT INTO t (a, b) VALUES (?, ?)', null, 3.5);
    expect(await sql.all('SELECT * FROM t')).toEqual([{ a: null, b: 3.5 }]);
  });

  it('run() rejects on multi-statement SQL (exec is the only multi-statement path)', async () => {
    const { sql } = setup();
    await expect(promptly(sql.run('SELECT 1; SELECT 2', 5))).rejects.toThrow();
  });
});

describe('sqliteSessionSql: transactions', () => {
  it('tx commits and resolves with the body value', async () => {
    const { db, sql } = await withTable();
    const value = await sql.tx(async (t) => {
      await t.run('INSERT INTO t (x) VALUES (?)', 1);
      await t.run('INSERT INTO t (x) VALUES (?)', 2);
      return 'done';
    });
    expect(value).toBe('done');
    expect(await rows(sql)).toEqual([{ x: 1 }, { x: 2 }]);
    expect(db.inTransaction).toBe(false);
  });

  it('a body that writes and then throws persists nothing and rejects with its error', async () => {
    const { db, sql } = await withTable();
    const boom = new Error('boom');
    await expect(
      promptly(
        sql.tx(async (t) => {
          await t.run('INSERT INTO t (x) VALUES (1)');
          throw boom;
        }),
      ),
    ).rejects.toBe(boom);
    expect(await rows(sql)).toEqual([]);
    expect(db.inTransaction).toBe(false);
  });

  it('a statement error the body catches still rolls the transaction back', async () => {
    const { sql } = await withTable();
    let caught: unknown;
    await expect(
      promptly(
        sql.tx(async (t) => {
          await t.run('INSERT INTO t (x) VALUES (1)');
          try {
            await t.run('INSERT INTO missing_table (x) VALUES (2)');
          } catch (error) {
            caught = error;
          }
          return 'kept going';
        }),
      ),
    ).rejects.toSatisfy((e) => e === caught && /no such table/.test(String(e)));
    expect(await rows(sql)).toEqual([]);
  });

  it('a failed COMMIT rolls back and rejects with the commit error', async () => {
    const { db, sql } = setup();
    await sql.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE p (id INTEGER PRIMARY KEY);
      CREATE TABLE c (pid INTEGER REFERENCES p (id) DEFERRABLE INITIALLY DEFERRED);
    `);
    await expect(
      promptly(
        sql.tx(async (t) => {
          await t.run('INSERT INTO c (pid) VALUES (42)');
        }),
      ),
    ).rejects.toThrow(/FOREIGN KEY/);
    expect(db.inTransaction).toBe(false);
    expect(await sql.all('SELECT * FROM c')).toEqual([]);
    expect(sql.rollbackFailed).toBe(false);
  });

  it('t.tx joins: the joined writes commit with the outer transaction', async () => {
    const { sql } = await withTable();
    await sql.tx(async (t) => {
      await t.run('INSERT INTO t (x) VALUES (1)');
      const inner = await t.tx(async (t2) => {
        await t2.run('INSERT INTO t (x) VALUES (2)');
        return 'inner';
      });
      expect(inner).toBe('inner');
    });
    expect(await rows(sql)).toEqual([{ x: 1 }, { x: 2 }]);
  });

  it('t.tx joins: an inner throw rolls back the outer writes, even when the outer catches it', async () => {
    const { sql } = await withTable();
    const inner = new Error('inner');
    await expect(
      promptly(
        sql.tx(async (t) => {
          await t.run('INSERT INTO t (x) VALUES (1)');
          await t
            .tx(async (t2) => {
              await t2.run('INSERT INTO t (x) VALUES (2)');
              throw inner;
            })
            .catch(() => {});
        }),
      ),
    ).rejects.toBe(inner);
    expect(await rows(sql)).toEqual([]);
  });

  it('a body that returns while a joined body runs rejects with SessionTxMisuseError, and the late write is refused', async () => {
    const { sql } = await withTable();
    let late: Promise<unknown> | undefined;
    await expect(
      promptly(
        sql.tx(async (t) => {
          await t.run('INSERT INTO t (x) VALUES (1)');
          late = t.tx(async (t2) => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            await t2.run('INSERT INTO t (x) VALUES (2)');
          });
        }),
      ),
    ).rejects.toBeInstanceOf(SessionTxMisuseError);
    await expect(promptly(late as Promise<unknown>)).rejects.toBeInstanceOf(SessionTxMisuseError);
    expect(await rows(sql)).toEqual([]);
  });

  it('a handle used after its transaction ended rejects', async () => {
    const { sql } = await withTable();
    let kept: SessionSql | undefined;
    await sql.tx(async (t) => {
      kept = t;
    });
    const handle = kept as SessionSql;
    await expect(promptly(handle.run('INSERT INTO t (x) VALUES (1)'))).rejects.toBeInstanceOf(
      SessionTxMisuseError,
    );
    await expect(promptly(handle.all('SELECT x FROM t'))).rejects.toBeInstanceOf(
      SessionTxMisuseError,
    );
    await expect(promptly(handle.tx(async () => 1))).rejects.toBeInstanceOf(SessionTxMisuseError);
    expect(await rows(sql)).toEqual([]);
  });

  it('a root statement while the transaction is open rejects instead of joining it', async () => {
    const { sql } = await withTable();
    let rootWrite: Promise<unknown> | undefined;
    let rootTx: Promise<unknown> | undefined;
    await expect(
      sql.tx(async (t) => {
        await t.run('INSERT INTO t (x) VALUES (1)');
        rootWrite = sql.run('INSERT INTO t (x) VALUES (2)');
        rootTx = sql.tx(async () => 1);
        await rootWrite.catch(() => {});
        await rootTx.catch(() => {});
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');
    await expect(promptly(rootWrite as Promise<unknown>)).rejects.toBeInstanceOf(
      SessionTxMisuseError,
    );
    await expect(promptly(rootTx as Promise<unknown>)).rejects.toBeInstanceOf(SessionTxMisuseError);
    expect(await rows(sql)).toEqual([]);
  });

  it("a failing ROLLBACK rejects with the body's error, carries the rollback error as cause, and reports rollbackFailed", async () => {
    const { db, sql } = await withTable();
    await sql.run('INSERT INTO t (x) VALUES (1), (2)');
    const boom = new Error('boom');
    let iterator: IterableIterator<unknown> | undefined;
    const outcome = await promptly(
      sql
        .tx(async (t) => {
          await t.run('INSERT INTO t (x) VALUES (3)');
          // An iterator left open keeps the connection busy, so ROLLBACK fails (spike A7).
          iterator = db.prepare('SELECT x FROM t').iterate();
          iterator.next();
          throw boom;
        })
        .then(
          () => null,
          (error: unknown) => error,
        ),
    );
    expect(outcome).toBe(boom);
    expect(String((outcome as Error).cause)).toMatch(/busy/);
    expect(sql.rollbackFailed).toBe(true);
    expect(db.inTransaction).toBe(true);
    iterator?.return?.();
    db.close();
  });
});
