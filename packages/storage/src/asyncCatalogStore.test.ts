// async-catalog-adapter tasks 1.2 (design D2-D4; core-ports-architecture "The catalog transaction
// contract" and "The SQLite catalog adapter serialises each connection").
import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  AsyncSqliteCatalogDb,
  CatalogAdapterBrokenError,
  CatalogTxMisuseError,
  CatalogTxTimeoutError,
} from './asyncCatalogStore';

function raw(): Database.Database {
  const r = new Database(':memory:');
  r.pragma('foreign_keys = ON');
  r.exec('CREATE TABLE t (k TEXT PRIMARY KEY, v INTEGER)');
  r.exec('CREATE TABLE log (n INTEGER PRIMARY KEY AUTOINCREMENT, who TEXT NOT NULL)');
  return r;
}

const count = (r: Database.Database, table = 't') =>
  (r.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => {
    open = r;
  });
  return { wait, open };
}

const HUNG = Symbol('hung');
/** Races `p` against a short timer so a hang fails with a message, not a test timeout. */
async function prompt<T>(p: Promise<T>, ms = 200): Promise<T> {
  const r = await Promise.race([
    p,
    new Promise<typeof HUNG>((res) => setTimeout(() => res(HUNG), ms)),
  ]);
  if (r === HUNG) throw new Error(`call did not settle within ${ms} ms (deadlock?)`);
  return r as T;
}

/** Resolves true if `p` is still pending after `ms`. */
async function pendingAfter(p: Promise<unknown>, ms = 20): Promise<boolean> {
  let settled = false;
  p.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise((r) => setTimeout(r, ms));
  return !settled;
}

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

describe('AsyncSqliteCatalogDb: statements', () => {
  it('all, first and run match better-sqlite3', async () => {
    const r = raw();
    const a = new AsyncSqliteCatalogDb(r);
    expect((await a.run('INSERT INTO t (k, v) VALUES (?, ?)', 'a', 1)).changes).toBe(1);
    expect((await a.run('UPDATE t SET v = 9 WHERE k = ?', 'missing')).changes).toBe(0);
    await a.run('INSERT INTO t (k, v) VALUES (?, ?)', 'b', 2);
    expect(await a.all('SELECT * FROM t ORDER BY k')).toEqual(
      r.prepare('SELECT * FROM t ORDER BY k').all(),
    );
    expect(await a.first('SELECT * FROM t WHERE k = ?', 'b')).toEqual({ k: 'b', v: 2 });
    expect(await a.first('SELECT * FROM t WHERE k = ?', 'nope')).toBeNull();
  });
});

describe('AsyncSqliteCatalogDb: transaction contract', () => {
  it('commits and returns the body value', async () => {
    const r = raw();
    const a = new AsyncSqliteCatalogDb(r);
    const out = await a.tx(async (t) => {
      await t.run('INSERT INTO t (k, v) VALUES (?, ?)', 'a', 1);
      await Promise.resolve();
      await t.run('INSERT INTO t (k, v) VALUES (?, ?)', 'b', 2);
      return 'done';
    });
    expect(out).toBe('done');
    expect(count(r)).toBe(2);
    expect(r.inTransaction).toBe(false);
  });

  it('a body that writes then throws persists nothing and rejects with that error', async () => {
    const r = raw();
    const a = new AsyncSqliteCatalogDb(r);
    const boom = new Error('boom');
    await expect(
      a.tx(async (t) => {
        await t.run('INSERT INTO t (k, v) VALUES (?, ?)', 'a', 1);
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(count(r)).toBe(0);
  });

  it('a constraint violation mid-body rolls everything back', async () => {
    const r = raw();
    const a = new AsyncSqliteCatalogDb(r);
    await expect(
      a.tx(async (t) => {
        await t.run('INSERT INTO t (k, v) VALUES (?, ?)', 'a', 1);
        await t.run('INSERT INTO t (k, v) VALUES (?, ?)', 'a', 2);
      }),
    ).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT_PRIMARYKEY' });
    expect(count(r)).toBe(0);
  });

  it('a caught statement error still fails the transaction with that error', async () => {
    const r = raw();
    const a = new AsyncSqliteCatalogDb(r);
    await expect(
      a.tx(async (t) => {
        await t.run('INSERT INTO t (k, v) VALUES (?, ?)', 'a', 1);
        try {
          await t.run('INSERT INTO t (k, v) VALUES (?, ?)', 'a', 2);
        } catch {
          // swallowed on purpose
        }
        await t.run('INSERT INTO t (k, v) VALUES (?, ?)', 'b', 3);
      }),
    ).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT_PRIMARYKEY' });
    expect(count(r)).toBe(0);
  });

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

  it('a failed COMMIT (deferred foreign key) rolls back and rejects', async () => {
    const r = raw();
    r.exec('CREATE TABLE p (id INTEGER PRIMARY KEY)');
    r.exec('CREATE TABLE c (pid INTEGER REFERENCES p(id) DEFERRABLE INITIALLY DEFERRED)');
    const a = new AsyncSqliteCatalogDb(r);
    await expect(
      a.tx(async (t) => {
        await t.run('INSERT INTO t (k, v) VALUES (?, ?)', 'a', 1);
        await t.run('INSERT INTO c (pid) VALUES (?)', 99);
      }),
    ).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT_FOREIGNKEY' });
    expect(count(r)).toBe(0);
    expect(count(r, 'c')).toBe(0);
    expect(r.inTransaction).toBe(false);
  });
});

describe('AsyncSqliteCatalogDb: joined transactions', () => {
  it('t.tx writes commit with the outer transaction', async () => {
    const r = raw();
    const a = new AsyncSqliteCatalogDb(r);
    await a.tx(async (t) => {
      await t.run('INSERT INTO t (k, v) VALUES (?, ?)', 'a', 1);
      await t.tx(async (u) => {
        await u.run('INSERT INTO t (k, v) VALUES (?, ?)', 'b', 2);
      });
    });
    expect(count(r)).toBe(2);
  });

  it('a joined body that throws rolls back the outer writes, even when the outer catches', async () => {
    const r = raw();
    const a = new AsyncSqliteCatalogDb(r);
    const inner = new Error('inner');
    await expect(
      a.tx(async (t) => {
        await t.run('INSERT INTO t (k, v) VALUES (?, ?)', 'a', 1);
        try {
          await t.tx(async (u) => {
            await u.run('INSERT INTO t (k, v) VALUES (?, ?)', 'b', 2);
            throw inner;
          });
        } catch {
          // swallowed on purpose
        }
        return 'ignored';
      }),
    ).rejects.toBe(inner);
    expect(count(r)).toBe(0);
  });

  it('a body returning while a joined body runs rejects, persists nothing, and refuses the late write', async () => {
    const r = raw();
    const a = new AsyncSqliteCatalogDb(r);
    const g = gate();
    let late: unknown = 'not reached';
    let orphanDone!: Promise<void>;
    await expect(
      a.tx(async (t) => {
        await t.run('INSERT INTO t (k, v) VALUES (?, ?)', 'a', 1);
        orphanDone = new Promise<void>((done) => {
          void t.tx(async (u) => {
            await g.wait;
            try {
              await u.run('INSERT INTO t (k, v) VALUES (?, ?)', 'late', 2);
              late = 'written';
            } catch (e) {
              late = e;
            } finally {
              done();
            }
          });
        });
      }),
    ).rejects.toBeInstanceOf(CatalogTxMisuseError);
    g.open();
    await orphanDone;
    expect(late).toBeInstanceOf(CatalogTxMisuseError);
    expect(count(r)).toBe(0);
  });

  it('the first error wins over a still-running sibling', async () => {
    const r = raw();
    const a = new AsyncSqliteCatalogDb(r);
    const g = gate();
    class Conflict extends Error {}
    const conflict = new Conflict('409 last admin');
    await expect(
      a.tx(async (t) => {
        await Promise.all([
          t.tx(async (u) => {
            await u.run('INSERT INTO t (k, v) VALUES (?, ?)', 'a', 1);
            throw conflict;
          }),
          t.tx(async () => {
            await g.wait;
          }),
        ]);
      }),
    ).rejects.toBe(conflict);
    g.open();
    expect(count(r)).toBe(0);
  });
});

describe('AsyncSqliteCatalogDb: misuse', () => {
  it('the root handle inside a transaction rejects promptly (statement and tx)', async () => {
    const r = raw();
    const a = new AsyncSqliteCatalogDb(r);
    await expect(prompt(a.tx(async () => a.all('SELECT * FROM t')))).rejects.toBeInstanceOf(
      CatalogTxMisuseError,
    );
    await expect(prompt(a.tx(async () => a.tx(async () => 1)))).rejects.toBeInstanceOf(
      CatalogTxMisuseError,
    );
    expect(await prompt(a.first<{ n: number }>('SELECT COUNT(*) AS n FROM t'))).toEqual({ n: 0 });
  });

  it('a handle used after its transaction ended rejects and writes nothing', async () => {
    const r = raw();
    const a = new AsyncSqliteCatalogDb(r);
    let saved!: Parameters<Parameters<typeof a.tx>[0]>[0];
    await a.tx(async (t) => {
      saved = t;
    });
    await expect(saved.run('INSERT INTO t (k, v) VALUES (?, ?)', 'x', 1)).rejects.toBeInstanceOf(
      CatalogTxMisuseError,
    );
    expect(count(r)).toBe(0);
  });

  it('root work detached from a committed transaction runs; from a failed one it rejects with cause', async () => {
    const r = raw();
    const a = new AsyncSqliteCatalogDb(r);
    const g1 = gate();
    let detached!: Promise<unknown>;
    await a.tx(async (t) => {
      await t.run('INSERT INTO t (k, v) VALUES (?, ?)', 'a', 1);
      detached = (async () => {
        await g1.wait;
        return a.first<{ n: number }>('SELECT COUNT(*) AS n FROM t');
      })();
    });
    g1.open();
    expect(await prompt(detached)).toEqual({ n: 1 });

    const g2 = gate();
    const failure = new Error('failed tx');
    let detached2!: Promise<unknown>;
    await expect(
      a.tx(async () => {
        detached2 = (async () => {
          await g2.wait;
          return a.run('INSERT INTO t (k, v) VALUES (?, ?)', 'zombie', 2);
        })();
        throw failure;
      }),
    ).rejects.toBe(failure);
    g2.open();
    await expect(prompt(detached2)).rejects.toMatchObject({ cause: failure });
    expect(count(r)).toBe(1);
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

describe('AsyncSqliteCatalogDb: deadline', () => {
  it('rolls back a stalled body, refuses its later calls, and lets the next caller commit', async () => {
    const r = raw();
    const a = new AsyncSqliteCatalogDb(r, { txTimeoutMs: 50 });
    const g = gate();
    const late: unknown[] = [];
    let bodyDone!: Promise<void>;
    const stalled = a.tx(async (t) => {
      await t.run('INSERT INTO t (k, v) VALUES (?, ?)', 'a', 1);
      bodyDone = (async () => {
        await g.wait;
        for (const call of [
          () => t.run('INSERT INTO t (k, v) VALUES (?, ?)', 'h', 2),
          () => a.run('INSERT INTO t (k, v) VALUES (?, ?)', 'root', 3),
        ]) {
          try {
            await call();
            late.push('written');
          } catch (e) {
            late.push(e);
          }
        }
      })();
      await bodyDone;
    });
    await expect(prompt(stalled, 500)).rejects.toBeInstanceOf(CatalogTxTimeoutError);
    expect(count(r)).toBe(0);

    // The next transaction is open when the timed-out body finally settles.
    const g2 = gate();
    const next = a.tx(async (t) => {
      await t.run('INSERT INTO t (k, v) VALUES (?, ?)', 'next', 9);
      await g2.wait;
    });
    await new Promise((res) => setTimeout(res, 5));
    g.open();
    await bodyDone;
    g2.open();
    await expect(prompt(next)).resolves.toBeUndefined();
    expect(late).toHaveLength(2);
    expect(late[0]).toBeInstanceOf(CatalogTxMisuseError);
    expect(late[1]).toMatchObject({ cause: expect.any(CatalogTxTimeoutError) });
    expect(r.prepare('SELECT k FROM t').all()).toEqual([{ k: 'next' }]);
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

describe('AsyncSqliteCatalogDb: stress', () => {
  it('300 interleaved operations leave no orphan rows and a free lock', async () => {
    const r = raw();
    const a = new AsyncSqliteCatalogDb(r);
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const pause = () =>
      rand() < 0.5 ? Promise.resolve() : new Promise<void>((res) => setImmediate(res));
    const ops: Promise<{ id: number; ok: boolean; rows: number }>[] = [];
    for (let id = 0; id < 300; id++) {
      if (rand() < 0.3) {
        ops.push(
          a
            .run('INSERT INTO t (k, v) VALUES (?, ?)', `r${id}`, id)
            .then(() => ({ id, ok: true, rows: 1 })),
        );
        continue;
      }
      const willThrow = rand() < 0.3;
      ops.push(
        a
          .tx(async (t) => {
            await t.run('INSERT INTO t (k, v) VALUES (?, ?)', `t${id}a`, id);
            await pause();
            await t.tx(async (u) => {
              await pause();
              await u.run('INSERT INTO t (k, v) VALUES (?, ?)', `t${id}b`, id);
            });
            if (willThrow) throw new Error(`fail ${id}`);
          })
          .then(
            () => ({ id, ok: true, rows: 2 }),
            () => ({ id, ok: false, rows: 2 }),
          ),
      );
    }
    const results = await Promise.all(ops);
    for (const res of results) {
      const n = (r.prepare('SELECT COUNT(*) AS n FROM t WHERE v = ?').get(res.id) as { n: number })
        .n;
      expect(n, `op ${res.id}`).toBe(res.ok ? res.rows : 0);
    }
    expect(r.inTransaction).toBe(false);
    expect(await prompt(a.first('SELECT 1 AS one'))).toEqual({ one: 1 });
  });
});
