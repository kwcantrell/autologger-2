// postgres-catalog-adapter tasks 3.1 (design D1-D8; core-ports-architecture "The Postgres catalog
// adapter"): the shared contract suite and the Postgres-only cases, against the pinned image as
// the app's least-privilege role, one cloned database per adapter.
import postgres from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import { CatalogAdapterBrokenError, CatalogTxTimeoutError } from './asyncCatalogStore';
import { PostgresCatalogDb } from './postgresCatalogStore';
import { describeCatalogDbContract, gate, prompt } from './test/catalogDbContract';
import { createTestDatabase, type TestDatabase } from './test/pgDb';

const TABLES = `
  create table catalog.t (k text collate "C" primary key, v bigint);
  create table catalog.p (id bigint primary key);
  create table catalog.c (pid bigint references catalog.p (id) deferrable initially deferred);`;

interface Env {
  tdb: TestDatabase;
  admin: postgres.Sql;
  db: PostgresCatalogDb;
}

/** A fresh database with the fixture tables, an admin client and an app-role adapter. */
async function env(opts: { txTimeoutMs?: number; txSlots?: number } = {}): Promise<Env> {
  const tdb = await createTestDatabase();
  const admin = postgres({ ...tdb.admin, max: 2, onnotice: () => {} });
  await admin.unsafe(TABLES);
  const db = new PostgresCatalogDb({ ...tdb.app, ...opts });
  return { tdb, admin, db };
}

async function count(admin: postgres.Sql, table: string, where?: [string, unknown]) {
  const sql = `select count(*)::int as n from catalog.${table}${where ? ` where ${where[0]} = $1` : ''}`;
  const [row] = await admin.unsafe(sql, where ? [where[1] as string] : []);
  return (row as unknown as { n: number }).n;
}

/** App-role sessions still connected to this test's database. */
async function appSessions(e: Env): Promise<number> {
  const [row] = await e.admin.unsafe(
    "select count(*)::int as n from pg_stat_activity where datname = $1 and usename = 'autologger_app'",
    [e.tdb.name],
  );
  return (row as unknown as { n: number }).n;
}

describeCatalogDbContract('PostgresCatalogDb', {
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  shortTxTimeoutMs: 300,
  async make(opts) {
    const e = await env(opts);
    return {
      db: e.db,
      count: (table, where) => count(e.admin, table, where),
      async close() {
        await e.db.close();
        await e.admin.end();
      },
    };
  },
});

describe('PostgresCatalogDb: Postgres-only cases', () => {
  const open: Env[] = [];
  const make = async (opts?: { txTimeoutMs?: number; txSlots?: number }) => {
    const e = await env(opts);
    open.push(e);
    return e;
  };
  afterEach(async () => {
    for (const e of open.splice(0)) {
      await e.db.close().catch(() => {});
      await e.admin.end();
    }
  });

  const INSERT = 'INSERT INTO t (k, v) VALUES (?, ?)';
  const raise = (code: string) =>
    `DO $$ BEGIN RAISE EXCEPTION 'forced %', '${code}' USING ERRCODE = '${code}'; END $$`;

  it('int8 is a number, and a quoted ? is not a placeholder', async () => {
    const { db } = await make();
    await db.run(INSERT, 'a', 5);
    expect(await db.first('SELECT COUNT(*) AS n FROM t')).toEqual({ n: 1 });
    expect(await db.first('SELECT v FROM t WHERE k = ?', 'a')).toEqual({ v: 5 });
    expect(await db.first("SELECT '?' AS q, ?::bigint AS v", 5)).toEqual({ q: '?', v: 5 });
  });

  it('two concurrent read-modify-write transactions both commit after one retry', async () => {
    const e = await make();
    await e.db.run(INSERT, 'c', 0);
    let runs = 0;
    let reads = 0;
    const both = gate();
    const body = async (t: Parameters<Parameters<PostgresCatalogDb['tx']>[0]>[0]) => {
      runs++;
      const row = await t.first<{ v: number }>('SELECT v FROM t WHERE k = ?', 'c');
      if (++reads === 2) both.open();
      await both.wait;
      await t.run('UPDATE t SET v = ? WHERE k = ?', (row?.v ?? 0) + 1, 'c');
    };
    await Promise.all([e.db.tx(body), e.db.tx(body)]);
    expect(await e.db.first('SELECT v FROM t WHERE k = ?', 'c')).toEqual({ v: 2 });
    expect(runs).toBe(3);
  });

  it('retries a deadlock, gives up on serialization failure after 3 runs, never retries others', async () => {
    const { db } = await make();
    let runs = 0;
    await db.tx(async (t) => {
      runs++;
      if (runs === 1) await t.run(raise('40P01'));
      await t.run(INSERT, 'd', 1);
    });
    expect(runs).toBe(2);

    runs = 0;
    await expect(
      db.tx(async (t) => {
        runs++;
        await t.run(raise('40001'));
      }),
    ).rejects.toMatchObject({ code: '40001' });
    expect(runs).toBe(3);

    runs = 0;
    await expect(
      db.tx(async (t) => {
        runs++;
        await t.run(INSERT, 'd', 2);
      }),
    ).rejects.toMatchObject({ code: '23505' });
    expect(runs).toBe(1);
  });

  it('a statement running at the deadline is cancelled, its session ends, and the next tx commits', async () => {
    const e = await make({ txTimeoutMs: 300 });
    let pid = 0;
    const started = Date.now();
    await expect(
      prompt(
        e.db.tx(async (t) => {
          pid = (await t.first<{ pid: number }>('SELECT pg_backend_pid() AS pid'))?.pid ?? 0;
          await t.run(INSERT, 'slow', 1);
          await t.all('SELECT pg_sleep(60)');
        }),
        3000,
      ),
    ).rejects.toBeInstanceOf(CatalogTxTimeoutError);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(pid).toBeGreaterThan(0);
    let alive = 1;
    for (let i = 0; i < 30 && alive; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const [row] = await e.admin.unsafe(
        'select count(*)::int as n from pg_stat_activity where pid = $1',
        [pid],
      );
      alive = (row as unknown as { n: number }).n;
    }
    expect(alive, 'backend still running 3 s after the deadline').toBe(0);
    expect(await count(e.admin, 't')).toBe(0);
    expect(await e.db.tx(async (t) => t.run(INSERT, 'next', 2))).toEqual({ changes: 1 });
  });

  it('a lost connection refuses the next write, persists nothing, and later transactions commit', async () => {
    const e = await make();
    const g = gate();
    let pid = 0;
    let late: unknown = 'not reached';
    const pidRead = gate();
    const doomed = e.db.tx(async (t) => {
      pid = (await t.first<{ pid: number }>('SELECT pg_backend_pid() AS pid'))?.pid ?? 0;
      await t.run(INSERT, 'a', 1);
      pidRead.open();
      await g.wait;
      try {
        await t.run(INSERT, 'b', 2);
        late = 'written';
      } catch (err) {
        late = err;
      }
    });
    await pidRead.wait;
    await e.admin.unsafe('select pg_terminate_backend($1)', [pid]);
    await new Promise((r) => setTimeout(r, 300));
    g.open();
    await expect(prompt(doomed, 3000)).rejects.toBeDefined();
    expect(late).toBeInstanceOf(Error);
    expect(await count(e.admin, 't')).toBe(0);
    const n = 6; // more than the default 5 transaction slots
    await Promise.all(
      Array.from({ length: n }, (_, i) => e.db.tx(async (t) => t.run(INSERT, `ok${i}`, i))),
    );
    expect(await count(e.admin, 't')).toBe(n);
  });

  it('a waiter whose deadline passes in the queue rejects without running, and no slot leaks', async () => {
    const e = await make({ txSlots: 1, txTimeoutMs: 300 });
    const ran: string[] = [];
    const g = gate();
    const holder = e.db.tx(async () => {
      ran.push('holder');
      await g.wait;
    });
    const w1 = e.db.tx(async () => {
      ran.push('w1');
    });
    const w2 = e.db.tx(async () => {
      ran.push('w2');
    });
    const results = await Promise.allSettled([holder, w1, w2]);
    g.open();
    expect(results[0]).toMatchObject({ status: 'rejected' });
    expect(results[0].status === 'rejected' && results[0].reason).toBeInstanceOf(
      CatalogTxTimeoutError,
    );
    const queuedOut = results
      .slice(1)
      .filter((r) => r.status === 'rejected' && r.reason instanceof CatalogTxTimeoutError);
    expect(queuedOut.length).toBeGreaterThan(0);
    expect(ran.length).toBe(1 + (2 - queuedOut.length));
    for (let i = 0; i < 3; i++) {
      expect(await prompt(e.db.tx(async (t) => t.run(INSERT, `after${i}`, i)))).toEqual({
        changes: 1,
      });
    }
  });

  it('close() lets the running transaction settle, rejects the queued one, and ends every session', async () => {
    const e = await make({ txSlots: 1 });
    await e.db.first('SELECT 1 AS one');
    const g = gate();
    const running = e.db.tx(async (t) => {
      await t.run(INSERT, 'r', 1);
      await g.wait;
    });
    await new Promise((r) => setTimeout(r, 50));
    const queued = e.db
      .tx(async (t) => t.run(INSERT, 'q', 2))
      .then(
        () => 'resolved',
        (err: unknown) => err,
      );
    const closing = e.db.close();
    g.open();
    await expect(prompt(running, 3000)).resolves.toBeUndefined();
    expect(await prompt(queued, 3000)).toBeInstanceOf(CatalogAdapterBrokenError);
    await prompt(closing, 5000);
    await expect(e.db.first('SELECT 1')).rejects.toBeInstanceOf(CatalogAdapterBrokenError);
    await expect(e.db.tx(async () => 1)).rejects.toBeInstanceOf(CatalogAdapterBrokenError);
    let sessions = 1;
    for (let i = 0; i < 20 && sessions; i++) {
      await new Promise((r) => setTimeout(r, 100));
      sessions = await appSessions(e);
    }
    expect(sessions).toBe(0);
    expect(await count(e.admin, 't')).toBe(1);
  });
});
