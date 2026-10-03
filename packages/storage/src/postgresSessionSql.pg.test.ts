// session-tables task 3.1 (design D2, D3, D12): the session storage contract on the Postgres
// session adapter, against the pinned image as the app's least-privilege role, on a clone with one
// seeded session row. Faults go through the adapter's `connect` seam around its real client.
import postgres from 'postgres';
import {
  connectPostgres,
  type PgClient,
  type PgClientOptions,
  type PgQuery,
  PostgresCatalogDb,
} from './postgresCatalogStore';
import { PostgresSessionDb } from './postgresSessionSql';
import { gate } from './test/catalogDbContract';
import { createTestDatabase } from './test/pgDb';
import { describeSessionSqlContract, type SessionFault } from './test/sessionSqlContract';

const SESSION = 's-contract';

/** Wraps the adapter's own client: records ends, and injects `fault` once. */
function faulty(fault: SessionFault | undefined) {
  let ended = 0;
  let spent = false;
  const connect = (o: PgClientOptions): PgClient => {
    const real = connectPostgres(o);
    return {
      unsafe(text: string, binds?: unknown[], opts?: { prepare: boolean }): PgQuery {
        if (!spent && fault?.kind === 'deadlock' && binds?.includes(fault.bind)) {
          spent = true;
          return real.unsafe(
            "DO $$ BEGIN RAISE EXCEPTION 'injected deadlock' USING ERRCODE = '40P01'; END $$",
            [],
            opts,
          );
        }
        if (!spent && fault?.kind === 'rollback-unconfirmed' && text === 'ROLLBACK') {
          spent = true;
          const lost = Promise.reject(
            Object.assign(new Error('injected: no reply'), { code: 'CONNECTION_CLOSED' }),
          );
          return Object.assign(lost, { cancel: () => null }) as unknown as PgQuery;
        }
        return real.unsafe(text, binds, opts);
      },
      async end(opts?: { timeout?: number }) {
        ended++;
        await real.end(opts);
      },
    };
  };
  return { connect, ended: () => ended };
}

describeSessionSqlContract('PostgresSessionDb', {
  async make(opts) {
    const tdb = await createTestDatabase();
    const admin = postgres({ ...tdb.admin, max: 4, onnotice: () => {} });
    await admin`insert into catalog.sessions (id) values (${SESSION})`;
    const f = faulty(opts?.fault);
    const root = new PostgresCatalogDb({
      ...tdb.app,
      connect: f.connect,
      ...(opts?.txTimeoutMs ? { txTimeoutMs: opts.txTimeoutMs } : {}),
    });
    const sessions = new PostgresSessionDb(root.bindSystem('test'));
    const lockers: { release(): Promise<void> }[] = [];
    return {
      sessionId: SESSION,
      storage: (id = SESSION) => sessions.forSession(id),
      catalog: root.bindSystem('test'),
      async keys() {
        const rows = await admin`select key from catalog.session_meta
                                 where session_id = ${SESSION} order by key`;
        return rows.map((r) => r.key as string);
      },
      async insertElsewhere(key) {
        await admin`insert into catalog.session_meta (session_id, key, value)
                    values (${SESSION}, ${key}, 'x')`;
      },
      lockElsewhere() {
        const locked = gate();
        const release = gate();
        const done = admin.begin(async (t) => {
          await t`select 1 from catalog.sessions where id = ${SESSION} for update`;
          locked.open();
          await release.wait;
        });
        done.catch(() => {});
        const handle = {
          locked: locked.wait,
          async release() {
            release.open();
            await done;
          },
        };
        lockers.push(handle);
        return handle;
      },
      endedClients: f.ended,
      async close() {
        for (const l of lockers) await l.release().catch(() => {});
        await root.close();
        await admin.end();
      },
    };
  },
});
