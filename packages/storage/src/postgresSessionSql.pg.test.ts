// session-tables task 3.1 (design D2, D3, D12): the session storage contract on the Postgres
// session adapter, against the pinned image as the app's least-privilege role, on a clone with one
// seeded session row. Faults go through the adapter's `connect` seam around its real client.
// session-content-policies task 3.1 (design D4, D12): the session belongs to a show of a team with
// an owner, a member granted the show and a member without a grant; the seam also records, per
// statement, how many replies its connection had received when it was sent (the round trips).
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

/** Wraps the adapter's own client: records ends and sent statements, and injects `fault` once. */
function faulty(fault: SessionFault | undefined) {
  let ended = 0;
  let spent = false;
  let clients = 0;
  /** Per statement: its connection and that connection's replies received when it was sent. */
  const sent: { client: number; replied: number }[] = [];
  const connect = (o: PgClientOptions): PgClient => {
    const real = connectPostgres(o);
    const client = clients++;
    let replied = 0;
    const record = (q: PgQuery): PgQuery => {
      sent.push({ client, replied });
      q.then(
        () => {
          replied++;
        },
        () => {
          replied++;
        },
      );
      return q;
    };
    const send = (text: string, binds?: unknown[], opts?: { prepare: boolean }): PgQuery => {
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
    };
    return {
      unsafe(text: string, binds?: unknown[], opts?: { prepare: boolean }): PgQuery {
        return record(send(text, binds, opts));
      },
      async end(opts?: { timeout?: number }) {
        ended++;
        await real.end(opts);
      },
    };
  };
  return { connect, ended: () => ended, sent };
}

const NOW = '2026-10-09T00:00:00.000Z';

describeSessionSqlContract('PostgresSessionDb', {
  async make(opts) {
    const tdb = await createTestDatabase();
    const admin = postgres({ ...tdb.admin, max: 4, onnotice: () => {} });
    await admin.unsafe(`
      insert into catalog.users (id, google_sub, email, created_at_utc) values
        ('c-owner', 'c-owner', 'c-owner@example.com', '${NOW}'),
        ('c-granted', 'c-granted', 'c-granted@example.com', '${NOW}'),
        ('c-ungranted', 'c-ungranted', 'c-ungranted@example.com', '${NOW}');
      insert into catalog.studio_definitions (id, display_name, created_at_utc)
        values ('c-team', 'Contract team', '${NOW}');
      insert into catalog.user_studio_memberships (user_id, studio_id, role) values
        ('c-owner', 'c-team', 'owner'), ('c-granted', 'c-team', 'member'),
        ('c-ungranted', 'c-team', 'member');
      insert into catalog.shows (id, studio_id, name, show_code, created_at_utc)
        values ('c-show', 'c-team', 'Contract show', 'CS', '${NOW}');
      insert into catalog.show_grants (user_id, show_id, can_write, granted_by_user_id, granted_at_utc)
        values ('c-granted', 'c-show', 1, 'c-owner', '${NOW}');
    `);
    await admin`insert into catalog.sessions (id, show_id) values (${SESSION}, 'c-show')`;
    const f = faulty(opts?.fault);
    const root = new PostgresCatalogDb({
      ...tdb.app,
      connect: f.connect,
      ...(opts?.txTimeoutMs ? { txTimeoutMs: opts.txTimeoutMs } : {}),
    });
    const sessions = new PostgresSessionDb(root);
    const lockers: { release(): Promise<void> }[] = [];
    return {
      sessionId: SESSION,
      users: {
        owner: { kind: 'user', userId: 'c-owner' },
        granted: { kind: 'user', userId: 'c-granted' },
        ungranted: { kind: 'user', userId: 'c-ungranted' },
      },
      async roundTrips(fn) {
        const mark = f.sent.length;
        await fn();
        return new Set(f.sent.slice(mark).map((e) => `${e.client}:${e.replied}`)).size;
      },
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
