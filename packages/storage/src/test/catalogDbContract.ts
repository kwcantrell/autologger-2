// The catalog transaction contract as one suite, run against every CatalogDb adapter
// (postgres-catalog-adapter design D8; core-ports-architecture "The catalog transaction
// contract"). Each adapter's test file supplies a fixture over fresh tables:
//   t (k text primary key, v bigint), p (id bigint primary key),
//   c (pid bigint references p(id) deferrable initially deferred).
import type { CatalogDb } from '@autologger/ports';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CatalogTxMisuseError, CatalogTxTimeoutError } from '../asyncCatalogStore';

export interface ContractFixture {
  db: CatalogDb;
  /** Row count read outside the adapter; `where` is an equality on one column. */
  count(table: 't' | 'c', where?: [column: string, value: unknown]): Promise<number>;
  close(): Promise<void>;
}

export interface ContractTarget {
  make(opts?: { txTimeoutMs?: number }): Promise<ContractFixture>;
  uniqueViolation: string;
  foreignKeyViolation: string;
  /** A deadline short enough for a test, long enough for one statement. */
  shortTxTimeoutMs: number;
}

export function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => {
    open = r;
  });
  return { wait, open };
}

const HUNG = Symbol('hung');
/** Races `p` against a short timer so a hang fails with a message, not a test timeout. */
export async function prompt<T>(p: Promise<T>, ms = 1000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const r = await Promise.race([
    p,
    new Promise<typeof HUNG>((res) => {
      timer = setTimeout(() => res(HUNG), ms);
    }),
  ]).finally(() => clearTimeout(timer));
  if (r === HUNG) throw new Error(`call did not settle within ${ms} ms (deadlock?)`);
  return r as T;
}

/** Resolves true if `p` is still pending after `ms`. */
export async function pendingAfter(p: Promise<unknown>, ms = 20): Promise<boolean> {
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

const INSERT = 'INSERT INTO t (k, v) VALUES (?, ?)';

export function describeCatalogDbContract(name: string, target: ContractTarget): void {
  describe(`${name}: catalog transaction contract`, () => {
    const unhandled: unknown[] = [];
    const trap = (e: unknown) => unhandled.push(e);
    const open: ContractFixture[] = [];
    const make = async (opts?: { txTimeoutMs?: number }) => {
      const f = await target.make(opts);
      open.push(f);
      return f;
    };
    beforeAll(() => {
      process.on('unhandledRejection', trap);
    });
    afterAll(() => {
      process.off('unhandledRejection', trap);
    });
    afterEach(async () => {
      await new Promise((r) => setTimeout(r, 5));
      for (const f of open.splice(0)) await f.close();
      expect(unhandled, 'unhandled rejections').toEqual([]);
      unhandled.length = 0;
    });

    it('all, first and run return rows, a row or null, and affected-row counts', async () => {
      const { db } = await make();
      expect((await db.run(INSERT, 'a', 1)).changes).toBe(1);
      expect((await db.run('UPDATE t SET v = 9 WHERE k = ?', 'missing')).changes).toBe(0);
      await db.run(INSERT, 'b', 2);
      expect(await db.all('SELECT k, v FROM t ORDER BY k')).toEqual([
        { k: 'a', v: 1 },
        { k: 'b', v: 2 },
      ]);
      expect(await db.first('SELECT k, v FROM t WHERE k = ?', 'b')).toEqual({ k: 'b', v: 2 });
      expect(await db.first('SELECT k, v FROM t WHERE k = ?', 'nope')).toBeNull();
    });

    it('commits and returns the body value', async () => {
      const f = await make();
      const out = await f.db.tx(async (t) => {
        await t.run(INSERT, 'a', 1);
        await Promise.resolve();
        await t.run(INSERT, 'b', 2);
        return 'done';
      });
      expect(out).toBe('done');
      expect(await f.count('t')).toBe(2);
    });

    it('a body that writes then throws persists nothing and rejects with that error', async () => {
      const f = await make();
      const boom = new Error('boom');
      await expect(
        f.db.tx(async (t) => {
          await t.run(INSERT, 'a', 1);
          throw boom;
        }),
      ).rejects.toBe(boom);
      expect(await f.count('t')).toBe(0);
    });

    it('a constraint violation mid-body rolls everything back', async () => {
      const f = await make();
      await expect(
        f.db.tx(async (t) => {
          await t.run(INSERT, 'a', 1);
          await t.run(INSERT, 'a', 2);
        }),
      ).rejects.toMatchObject({ code: target.uniqueViolation });
      expect(await f.count('t')).toBe(0);
    });

    it('a caught statement error still fails the transaction with that error', async () => {
      const f = await make();
      await expect(
        f.db.tx(async (t) => {
          await t.run(INSERT, 'a', 1);
          try {
            await t.run(INSERT, 'a', 2);
          } catch {
            // swallowed on purpose
          }
          await t.run(INSERT, 'b', 3);
        }),
      ).rejects.toMatchObject({ code: target.uniqueViolation });
      expect(await f.count('t')).toBe(0);
    });

    it('a failing statement the body dropped without awaiting still fails the transaction', async () => {
      const f = await make();
      await expect(
        f.db.tx(async (t) => {
          // The second is queued behind the first, so it is still unsent when the body returns.
          void t.run(INSERT, 'a', 1);
          void t.run(INSERT, 'a', 2);
          return 'returned early';
        }),
      ).rejects.toMatchObject({ code: target.uniqueViolation });
      expect(await f.count('t')).toBe(0);
    });

    it('a failed COMMIT (deferred foreign key) rolls back and rejects', async () => {
      const f = await make();
      await expect(
        f.db.tx(async (t) => {
          await t.run(INSERT, 'a', 1);
          await t.run('INSERT INTO c (pid) VALUES (?)', 99);
        }),
      ).rejects.toMatchObject({ code: target.foreignKeyViolation });
      expect(await f.count('t')).toBe(0);
      expect(await f.count('c')).toBe(0);
      expect(await prompt(f.db.tx(async (t) => t.run(INSERT, 'after', 1)))).toEqual({
        changes: 1,
      });
    });

    it('t.tx writes commit with the outer transaction', async () => {
      const f = await make();
      await f.db.tx(async (t) => {
        await t.run(INSERT, 'a', 1);
        await t.tx(async (u) => {
          await u.run(INSERT, 'b', 2);
        });
      });
      expect(await f.count('t')).toBe(2);
    });

    it('a joined body that throws rolls back the outer writes, even when the outer catches', async () => {
      const f = await make();
      const inner = new Error('inner');
      await expect(
        f.db.tx(async (t) => {
          await t.run(INSERT, 'a', 1);
          try {
            await t.tx(async (u) => {
              await u.run(INSERT, 'b', 2);
              throw inner;
            });
          } catch {
            // swallowed on purpose
          }
          return 'ignored';
        }),
      ).rejects.toBe(inner);
      expect(await f.count('t')).toBe(0);
    });

    it('a body returning while a joined body runs rejects, persists nothing, and refuses the late write', async () => {
      const f = await make();
      const g = gate();
      let late: unknown = 'not reached';
      let orphanDone!: Promise<void>;
      await expect(
        f.db.tx(async (t) => {
          await t.run(INSERT, 'a', 1);
          orphanDone = new Promise<void>((done) => {
            void t.tx(async (u) => {
              await g.wait;
              try {
                await u.run(INSERT, 'late', 2);
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
      expect(await f.count('t')).toBe(0);
    });

    it('the first error wins over a still-running sibling', async () => {
      const f = await make();
      const g = gate();
      const conflict = new Error('409 last admin');
      await expect(
        f.db.tx(async (t) => {
          await Promise.all([
            t.tx(async (u) => {
              await u.run(INSERT, 'a', 1);
              throw conflict;
            }),
            t.tx(async () => {
              await g.wait;
            }),
          ]);
        }),
      ).rejects.toBe(conflict);
      g.open();
      expect(await f.count('t')).toBe(0);
    });

    it('the root handle inside a transaction rejects promptly (statement and tx)', async () => {
      const { db } = await make();
      await expect(prompt(db.tx(async () => db.all('SELECT k FROM t')))).rejects.toBeInstanceOf(
        CatalogTxMisuseError,
      );
      await expect(prompt(db.tx(async () => db.tx(async () => 1)))).rejects.toBeInstanceOf(
        CatalogTxMisuseError,
      );
      expect(await prompt(db.first<{ n: number }>('SELECT COUNT(*) AS n FROM t'))).toEqual({
        n: 0,
      });
    });

    it('a handle used after its transaction ended rejects and writes nothing', async () => {
      const f = await make();
      let saved!: CatalogDb;
      await f.db.tx(async (t) => {
        saved = t;
      });
      await expect(saved.run(INSERT, 'x', 1)).rejects.toBeInstanceOf(CatalogTxMisuseError);
      expect(await f.count('t')).toBe(0);
    });

    it('root work detached from a committed transaction runs; from a failed one it rejects with cause', async () => {
      const f = await make();
      const { db } = f;
      const g1 = gate();
      let detached!: Promise<unknown>;
      await db.tx(async (t) => {
        await t.run(INSERT, 'a', 1);
        detached = (async () => {
          await g1.wait;
          return db.first<{ n: number }>('SELECT COUNT(*) AS n FROM t');
        })();
      });
      g1.open();
      expect(await prompt(detached)).toEqual({ n: 1 });

      const g2 = gate();
      const failure = new Error('failed tx');
      let detached2!: Promise<unknown>;
      await expect(
        db.tx(async () => {
          detached2 = (async () => {
            await g2.wait;
            return db.run(INSERT, 'zombie', 2);
          })();
          throw failure;
        }),
      ).rejects.toBe(failure);
      g2.open();
      await expect(prompt(detached2)).rejects.toMatchObject({ cause: failure });
      expect(await f.count('t')).toBe(1);
    });

    it('a stalled body is rolled back at the deadline, its later calls are refused, and the next caller commits', async () => {
      const f = await make({ txTimeoutMs: target.shortTxTimeoutMs });
      const { db } = f;
      const g = gate();
      const late: unknown[] = [];
      let bodyDone!: Promise<void>;
      const stalled = db.tx(async (t) => {
        await t.run(INSERT, 'a', 1);
        bodyDone = (async () => {
          await g.wait;
          for (const call of [() => t.run(INSERT, 'h', 2), () => db.run(INSERT, 'root', 3)]) {
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
      await expect(prompt(stalled, target.shortTxTimeoutMs + 2000)).rejects.toBeInstanceOf(
        CatalogTxTimeoutError,
      );
      expect(await f.count('t')).toBe(0);

      // The next transaction is open when the timed-out body finally settles.
      const g2 = gate();
      const next = db.tx(async (t) => {
        await t.run(INSERT, 'next', 9);
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
      expect(await f.count('t')).toBe(1);
      expect(await f.count('t', ['k', 'next'])).toBe(1);
    });

    it('300 interleaved operations leave no orphan rows and the adapter usable', async () => {
      const f = await make();
      const { db } = f;
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
          ops.push(db.run(INSERT, `r${id}`, id).then(() => ({ id, ok: true, rows: 1 })));
          continue;
        }
        const willThrow = rand() < 0.3;
        ops.push(
          db
            .tx(async (t) => {
              await t.run(INSERT, `t${id}a`, id);
              await pause();
              await t.tx(async (u) => {
                await pause();
                await u.run(INSERT, `t${id}b`, id);
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
        expect(await f.count('t', ['v', res.id]), `op ${res.id}`).toBe(res.ok ? res.rows : 0);
      }
      expect(await prompt(db.first('SELECT 1 AS one'))).toEqual({ one: 1 });
    });
  });
}
