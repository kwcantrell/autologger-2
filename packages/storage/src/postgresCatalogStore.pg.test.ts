// postgres-catalog-adapter tasks 3.1 (design D1-D8; core-ports-architecture "The Postgres catalog
// adapter"): the shared contract suite and the Postgres-only cases, against the pinned image as
// the app's least-privilege role, one cloned database per adapter.
import type { CatalogDb } from '@autologger/ports';
import postgres from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CatalogAdapterBrokenError,
  CatalogForbiddenError,
  CatalogTxTimeoutError,
} from './catalogErrors';
import {
  CatalogInvalidTextError,
  CatalogRootTimeoutError,
  type PgClient,
  type PgClientOptions,
  PostgresCatalogDb,
  type PostgresCatalogDbOptions,
} from './postgresCatalogStore';
import { describeCatalogDbContract, gate, prompt } from './test/catalogDbContract';
import { createTestDatabase, type TestDatabase } from './test/pgDb';

const TABLES = `
  create table catalog.t (k text collate "C" primary key, v bigint);
  create table catalog.p (id bigint primary key);
  create table catalog.c (pid bigint references catalog.p (id) deferrable initially deferred);`;

interface Env {
  tdb: TestDatabase;
  admin: postgres.Sql;
  root: PostgresCatalogDb;
  /** A `system:test` handle on `root` (catalog-roles D12). */
  db: CatalogDb;
}

/** A fresh database with the fixture tables, an admin client and an app-role adapter. */
async function env(opts: Partial<PostgresCatalogDbOptions> = {}): Promise<Env> {
  const tdb = await createTestDatabase();
  const admin = postgres({ ...tdb.admin, max: 2, onnotice: () => {} });
  await admin.unsafe(TABLES);
  const root = new PostgresCatalogDb({ ...tdb.app, ...opts });
  return { tdb, admin, root, db: root.bindSystem('test') };
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

// catalog-roles D12: the contract holds on a user-bound and a system-bound handle (the adapter has
// no unbound methods since task 6.1).
for (const [label, bind] of [
  [' (bound to a user)', (db: PostgresCatalogDb): CatalogDb => db.bindUser('u-1')],
  [' (bound to the system)', (db: PostgresCatalogDb): CatalogDb => db.bindSystem('test')],
] as const) {
  describeCatalogDbContract(`PostgresCatalogDb${label}`, {
    uniqueViolation: '23505',
    foreignKeyViolation: '23503',
    shortTxTimeoutMs: 300,
    async make(opts) {
      const e = await env(opts);
      return {
        db: bind(e.root),
        count: (table, where) => count(e.admin, table, where),
        async close() {
          await e.root.close();
          await e.admin.end();
        },
      };
    },
  });
}

describe('PostgresCatalogDb: Postgres-only cases', () => {
  const open: Env[] = [];
  const make = async (opts?: { txTimeoutMs?: number; txSlots?: number }) => {
    const e = await env(opts);
    open.push(e);
    return e;
  };
  afterEach(async () => {
    for (const e of open.splice(0)) {
      await e.root.close().catch(() => {});
      await e.admin.end();
    }
  });

  const INSERT = 'INSERT INTO t (k, v) VALUES (?, ?)';
  const raise = (code: string) =>
    `DO $$ BEGIN RAISE EXCEPTION 'forced %', '${code}' USING ERRCODE = '${code}'; END $$`;

  it('a NUL bind inside a transaction is refused before sending, and the transaction writes nothing (catalog-on-postgres D5)', async () => {
    const e = await make();
    await expect(
      e.db.tx(async (t) => {
        await t.run(INSERT, 'ok', 1);
        await t.run(INSERT, 'a\u0000b', 2);
      }),
    ).rejects.toBeInstanceOf(CatalogInvalidTextError);
    expect(await count(e.admin, 't')).toBe(0);
    // The adapter keeps working afterwards.
    await e.db.run(INSERT, 'after', 3);
    expect(await count(e.admin, 't')).toBe(1);
  });

  it('int8 is a number, and a quoted ? is not a placeholder', async () => {
    const { db } = await make();
    await db.run(INSERT, 'a', 5);
    expect(await db.first('SELECT COUNT(*) AS n FROM t')).toEqual({ n: 1 });
    expect(await db.first('SELECT v FROM t WHERE k = ?', 'a')).toEqual({ v: 5 });
    expect(await db.first("SELECT '?' AS q, ?::bigint AS v", 5)).toEqual({ q: '?', v: 5 });
  });

  // session-tables A10: the image sets extra_float_digits = 0; the adapter's connections set 1.
  it('a catalog double precision reads back exactly', async () => {
    const { db } = await make();
    await db.run('INSERT INTO sessions (id, frame_rate) VALUES (?, ?)', 's-f', 29.969999999999995);
    expect(await db.first('SELECT frame_rate FROM sessions WHERE id = ?', 's-f')).toEqual({
      frame_rate: 29.969999999999995,
    });
  });

  it('two concurrent read-modify-write transactions both commit after one retry', async () => {
    const e = await make();
    await e.db.run(INSERT, 'c', 0);
    let runs = 0;
    let reads = 0;
    const both = gate();
    const body = async (t: CatalogDb) => {
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

  it('retries a deadlock, gives up on serialization failure after 5 runs, never retries others', async () => {
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
    expect(runs).toBe(5);

    runs = 0;
    await expect(
      db.tx(async (t) => {
        runs++;
        await t.run(INSERT, 'd', 2);
      }),
    ).rejects.toMatchObject({ code: '23505' });
    expect(runs).toBe(1);
  });

  // catalog-retry-backoff: contending writers back off instead of re-running in lockstep.
  it('8 contending read-modify-write transactions all commit', async () => {
    const e = await make();
    await e.db.run(INSERT, 'w', 0);
    const body = async (t: CatalogDb) => {
      const row = await t.first<{ v: number }>('SELECT v FROM t WHERE k = ?', 'w');
      await t.first('SELECT count(*) FROM t');
      await t.first('SELECT count(*) FROM t');
      await t.run('UPDATE t SET v = ? WHERE k = ?', (row?.v ?? 0) + 1, 'w');
    };
    const failures: string[] = [];
    for (let rep = 0; rep < 5; rep++) {
      const results = await Promise.allSettled(Array.from({ length: 8 }, () => e.db.tx(body)));
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed) failures.push(`repetition ${rep}: ${failed}/8 exhausted`);
    }
    expect(failures).toEqual([]);
    expect(await e.db.first('SELECT v FROM t WHERE k = ?', 'w')).toEqual({ v: 40 });
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
    const closing = e.root.close();
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

// catalog-roles tasks 3.3 (design D4-D6, D8): bindings against the real server.
describe('PostgresCatalogDb: bindings (catalog-roles)', () => {
  const open: Env[] = [];
  const make = async (opts: Partial<PostgresCatalogDbOptions> = {}) => {
    const e = await env(opts);
    open.push(e);
    return e;
  };
  afterEach(async () => {
    for (const e of open.splice(0)) {
      await e.root.close().catch(() => {});
      await e.admin.end();
    }
  });

  const INSERT = 'INSERT INTO t (k, v) VALUES (?, ?)';
  const WHO =
    "SELECT current_user AS u, catalog.app_user_id() AS id, current_setting('transaction_isolation') AS iso";
  const raise = (code: string) =>
    `DO $$ BEGIN RAISE EXCEPTION 'forced %', '${code}' USING ERRCODE = '${code}'; END $$`;

  /** A `connect` that records every client the adapter opens, and which of them it ended. */
  function recording() {
    const clients: { sql: postgres.Sql; ended: boolean }[] = [];
    const connect = (o: PgClientOptions): PgClient => {
      const sql = postgres({
        ...o,
        types: { bigint: { to: 20, from: [20], parse: Number, serialize: String } },
        onnotice: () => {},
        max_lifetime: null,
        idle_timeout: 0,
        connection: { client_connection_check_interval: '1s' },
      } as never) as unknown as postgres.Sql;
      const rec = { sql, ended: false };
      clients.push(rec);
      const end = sql.end.bind(sql);
      return Object.assign(sql, {
        end: (opts?: { timeout?: number }) => {
          rec.ended = true;
          return end(opts);
        },
      }) as unknown as PgClient;
    };
    /** Each live client, asked directly: who it is and its user id setting. */
    const inspect = async () =>
      Promise.all(
        clients
          .filter((c) => !c.ended)
          .map(async (c) => {
            const [r] = await c.sql.unsafe(
              "select current_user as u, current_setting('app.user_id', true) as id, " +
                'now() = statement_timestamp() as fresh',
            );
            return { ...r };
          }),
      );
    return { clients, connect, inspect };
  }

  const backendOf = async (e: Env, like: string): Promise<number> => {
    for (let i = 0; i < 50; i++) {
      const rows = await e.admin.unsafe(
        "select pid from pg_stat_activity where datname = $1 and usename = 'autologger_app' and query like $2",
        [e.tdb.name, like],
      );
      if (rows[0]) return (rows[0] as unknown as { pid: number }).pid;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`no backend running ${like}`);
  };

  const gone = async (e: Env, pid: number) => {
    for (let i = 0; i < 50; i++) {
      const [row] = await e.admin.unsafe(
        'select count(*)::int as n from pg_stat_activity where pid = $1',
        [pid],
      );
      if ((row as unknown as { n: number }).n === 0) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`backend ${pid} still running`);
  };

  it('a user-bound and a system-bound handle run as their role, at the root and in a transaction', async () => {
    const { root: db } = await make();
    const user = db.bindUser('u-1');
    const sys = db.bindSystem('test');
    expect(await user.first(WHO)).toEqual({ u: 'catalog_user', id: 'u-1', iso: 'read committed' });
    expect(await user.tx((t) => t.first(WHO))).toEqual({
      u: 'catalog_user',
      id: 'u-1',
      iso: 'serializable',
    });
    expect(await sys.first(WHO)).toEqual({ u: 'catalog_system', id: null, iso: 'read committed' });
    expect(await sys.tx((t) => t.first(WHO))).toEqual({
      u: 'catalog_system',
      id: null,
      iso: 'serializable',
    });
  });

  it('a retry after a serialization failure re-applies the role and user id', async () => {
    const { root: db } = await make();
    const seen: unknown[] = [];
    let runs = 0;
    await db.bindUser('u-1').tx(async (t) => {
      runs++;
      seen.push(await t.first('SELECT current_user AS u, catalog.app_user_id() AS id'));
      if (runs === 1) await t.run(raise('40001'));
    });
    expect(runs).toBe(2);
    expect(seen).toEqual([
      { u: 'catalog_user', id: 'u-1' },
      { u: 'catalog_user', id: 'u-1' },
    ]);
  });

  it('after a mixed workload every live client is autologger_app with no user id', async () => {
    const r = recording();
    const { root: db } = await make({ connect: r.connect, rootMax: 2, txSlots: 2 });
    const user = db.bindUser('u-1');
    const sys = db.bindSystem('test');
    await user.run(INSERT, 'a', 1);
    await sys.first('SELECT k FROM t WHERE k = ?', 'a');
    await user.tx(async (t) => t.run(INSERT, 'b', 2));
    await sys.tx(async (t) => t.run(INSERT, 'c', 3));
    await expect(
      user.tx(async (t) => {
        await t.run(INSERT, 'd', 4);
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');
    await expect(sys.run(INSERT, 'a', 9)).rejects.toMatchObject({ code: '23505' });
    await expect(sys.tx(async (t) => t.run(INSERT, 'a', 9))).rejects.toMatchObject({
      code: '23505',
    });
    let runs = 0;
    await user.tx(async (t) => {
      if (++runs === 1) await t.run(raise('40001'));
      await t.run(INSERT, 'e', 5);
    });
    await Promise.all([
      user.first('SELECT 1 AS one'),
      sys.all('SELECT k FROM t'),
      sys.run(INSERT, 'f', 6),
    ]);
    const live = await r.inspect();
    expect(live.length).toBeGreaterThanOrEqual(4);
    for (const c of live) {
      expect(c.u).toBe('autologger_app');
      expect(c.id === null || c.id === '').toBe(true);
    }
  });

  // session-tables core-ports-architecture "The connection count stays within the role's limit"
  // (design D2): with every root, transaction and session slot busy at the defaults, the adapter
  // holds at most 3 + 5 + 4 = 12 connections, under the app role's limit of 20.
  it('with every pool saturated at the defaults, the adapter holds at most 12 connections', async () => {
    const e = await make();
    const sys = e.root.bindSystem('test');
    const hold = gate();
    const busy = [
      ...Array.from({ length: 6 }, () => sys.all('SELECT pg_sleep(0.6)')),
      ...Array.from({ length: 8 }, () =>
        sys.tx(async (t) => {
          await t.all('SELECT 1 AS one');
          await hold.wait;
        }),
      ),
      ...Array.from({ length: 6 }, () =>
        e.root.bindSystem('session-hub').snapshot(async (t) => {
          await t.all('SELECT 1 AS one');
          await hold.wait;
        }),
      ),
    ];
    let most = 0;
    for (let i = 0; i < 10; i++) {
      most = Math.max(most, await appSessions(e));
      await new Promise((r) => setTimeout(r, 40));
    }
    hold.open();
    await Promise.all(busy);
    expect(most).toBeGreaterThanOrEqual(9); // the pools did fill
    expect(most).toBeLessThanOrEqual(12);
  });

  it('a root slot whose backend is killed mid-transaction rejects, the process survives, and a fresh client serves the next call', async () => {
    const uncaught: unknown[] = [];
    const trap = (e: unknown) => uncaught.push(e);
    process.on('uncaughtException', trap);
    process.on('unhandledRejection', trap);
    try {
      const r = recording();
      const e = await make({ connect: r.connect, rootMax: 1 });
      const user = e.root.bindUser('u-1');
      await user.first('SELECT 1 AS warm');
      const doomed = user.run('INSERT INTO t (k, v) SELECT ?, 1 FROM pg_sleep(10)', 'killed');
      doomed.catch(() => {});
      const pid = await backendOf(e, '%pg_sleep(10)%');
      await e.admin.unsafe('select pg_terminate_backend($1)', [pid]);
      await expect(prompt(doomed, 3000)).rejects.toBeDefined();
      expect(r.clients[0]?.ended).toBe(true);
      const next = await prompt(
        user.first<{ u: string; id: string; pid: number }>(
          'SELECT current_user AS u, catalog.app_user_id() AS id, pg_backend_pid() AS pid',
        ),
      );
      expect(next).toMatchObject({ u: 'catalog_user', id: 'u-1' });
      expect(next?.pid).not.toBe(pid);
      expect(await count(e.admin, 't')).toBe(0);
      const live = await r.inspect();
      for (const c of live) expect(c).toMatchObject({ u: 'autologger_app', fresh: true });
      await new Promise((res) => setTimeout(res, 50));
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', trap);
      process.off('unhandledRejection', trap);
    }
  });

  // `fresh`: a root call is its own short transaction, so it has no transaction id of its own
  // after a SELECT; inside the earlier, writing transaction it would.
  it('a root COMMIT that fails retires the client, and no later call runs in its transaction or role', async () => {
    const r = recording();
    const e = await make({ connect: r.connect, rootMax: 1 });
    await expect(
      e.root.bindUser('u-1').run('INSERT INTO c (pid) VALUES (?)', 42),
    ).rejects.toMatchObject({ code: '23503' });
    expect(r.clients[0]?.ended).toBe(true);
    expect(
      await e.db.first(
        "SELECT current_user AS u, current_setting('app.user_id', true) AS id, pg_current_xact_id_if_assigned() IS NULL AS fresh",
      ),
    ).toEqual({ u: 'catalog_system', id: '', fresh: true });
    expect(await count(e.admin, 'c')).toBe(0);
  });

  it('a root COMMIT stalled past the deadline: the caller times out, the client is retired at its bound, and nothing leaks', async () => {
    const r = recording();
    const e = await make({ connect: r.connect, rootMax: 1, rootTimeoutMs: 300, rootSettleMs: 800 });
    await e.admin.unsafe('insert into catalog.p (id) values (1)');
    // The deferred foreign key's check at COMMIT waits for this lock on the parent row.
    const locker = postgres({ ...e.tdb.admin, max: 1, onnotice: () => {} });
    try {
      const held = locker.begin(async (t) => {
        await t.unsafe('select id from catalog.p where id = 1 for update');
        await new Promise((res) => setTimeout(res, 3000));
      });
      held.catch(() => {});
      await new Promise((res) => setTimeout(res, 100));
      const err = (await e.root
        .bindUser('u-1')
        .run('INSERT INTO c (pid) VALUES (?)', 1)
        .catch((x: unknown) => x)) as CatalogRootTimeoutError;
      expect(err).toBeInstanceOf(CatalogRootTimeoutError);
      expect(err.message).toMatch(/may still apply/);
      const pid = await backendOf(e, 'COMMIT');
      await prompt(err.settled, 3000);
      expect(r.clients[0]?.ended).toBe(true);
      // The next root call runs on a fresh client: not inside the stalled transaction, not as its role.
      expect(
        await prompt(
          e.db.first(
            "SELECT current_user AS u, current_setting('app.user_id', true) AS id, pg_current_xact_id_if_assigned() IS NULL AS fresh",
          ),
        ),
      ).toEqual({ u: 'catalog_system', id: '', fresh: true });
      await gone(e, pid);
      await held;
    } finally {
      await locker.end();
    }
    expect(await count(e.admin, 'c')).toBe(0);
  });

  it('a bound statement on a table its role may not read is a CatalogForbiddenError', async () => {
    const e = await make();
    await e.admin.unsafe('revoke all on catalog.t from catalog_user');
    const err = await e.root
      .bindUser('u-1')
      .first('SELECT k FROM t')
      .catch((x: unknown) => x);
    expect(err).toBeInstanceOf(CatalogForbiddenError);
    expect(err).toMatchObject({ code: '42501', table_name: 't', binding: 'user' });
    let runs = 0;
    const inTx = await e.root
      .bindUser('u-1')
      .tx(async (t) => {
        runs++;
        await t.run(INSERT, 'x', 1);
      })
      .catch((x: unknown) => x);
    expect(inTx).toBeInstanceOf(CatalogForbiddenError);
    expect(runs).toBe(1);
    // The system role keeps its grant.
    expect(await e.root.bindSystem('test').first('SELECT count(*) AS n FROM t')).toEqual({ n: 0 });
  });
});
