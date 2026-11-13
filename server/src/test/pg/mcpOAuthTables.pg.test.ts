// custom session dashboards J2 (ADR 0035 decisions 5, 16, 17; design section 4.7): the MCP OAuth
// tables of `20261026000000_mcp_oauth.sql`. All five are system-only, like companion_devices:
// catalog_user is refused with 42501 before any policy, catalog_system reads and writes every
// row. `mcp_grants.expires_at_utc` (the 90-day cap) is not null and
// `mcp_refresh_tokens.successor_sealed` (the grace window's sealed successor) exists.

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import { type ConnOptions, connOptions, createTestDatabase } from '../../../../test/pg/testDb';
import { replayMigration } from './appRoleLimit';
import { holdRoleGuardLock } from './roleGuardLock';

const MIGRATIONS = resolve(import.meta.dirname, '../../../../supabase/migrations');
const MIGRATION = '20261026000000_mcp_oauth.sql';
const T = '2026-11-13T00:00:00.000Z';
const TABLES = [
  'mcp_clients',
  'mcp_grants',
  'mcp_access_tokens',
  'mcp_refresh_tokens',
  'mcp_rate_windows',
] as const;

const open: postgres.Sql[] = [];
function connect(o: ConnOptions): postgres.Sql {
  const sql = postgres({ ...o, max: 1, onnotice: () => {} });
  open.push(sql);
  return sql;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.end()));
});

const INSERT = {
  mcp_clients: `insert into mcp_clients (id, client_name, redirect_uris_json, registered_from, created_at_utc)
                values ('alc_2', 'Claude', '[]', '203.0.113.1', '${T}')`,
  mcp_grants: `insert into mcp_grants (id, user_id, client_id, scope, resource, created_at_utc, expires_at_utc)
               values ('g2', 'u1', 'alc_1', 'dashboards', 'https://example.com/mcp', '${T}', '${T}')`,
  mcp_access_tokens: `insert into mcp_access_tokens (token_hash, grant_id, expires_at_utc)
                      values ('a2', 'g1', '${T}')`,
  mcp_refresh_tokens: `insert into mcp_refresh_tokens (token_hash, grant_id, issued_at_utc, expires_at_utc)
                       values ('r2', 'g1', '${T}', '${T}')`,
  mcp_rate_windows: `insert into mcp_rate_windows (bucket, window_start_ms, count) values ('b2', 1, 1)`,
} as const;

async function seed(sys: postgres.Sql): Promise<void> {
  await sys`insert into users (id, google_sub, email, created_at_utc)
            values ('u1', 'u1-sub', 'u1@example.com', ${T})`;
  await sys.unsafe(`
    insert into mcp_clients (id, client_name, redirect_uris_json, registered_from, created_at_utc)
      values ('alc_1', 'Claude', '["https://claude.ai/api/mcp/auth_callback"]', '203.0.113.1', '${T}');
    insert into mcp_grants (id, user_id, client_id, scope, resource, created_at_utc, expires_at_utc)
      values ('g1', 'u1', 'alc_1', 'dashboards', 'https://example.com/mcp', '${T}', '${T}');
    insert into mcp_access_tokens (token_hash, grant_id, expires_at_utc) values ('a1', 'g1', '${T}');
    insert into mcp_refresh_tokens (token_hash, grant_id, issued_at_utc, expires_at_utc, successor_sealed)
      values ('r1', 'g1', '${T}', '${T}', 'sealed');
    insert into mcp_rate_windows (bucket, window_start_ms, count) values ('b1', 1, 1);`);
}

/** Runs `stmt` as catalog_user bound to `uid` in a transaction that rolls back; the error code or 'ok'. */
async function asUser(app: postgres.Sql, uid: string, stmt: string): Promise<string> {
  let out = 'ok';
  class Rollback extends Error {}
  await app
    .begin(async (tx) => {
      await tx`select set_config('role', 'catalog_user', true), set_config('app.user_id', ${uid}, true)`;
      try {
        await tx.unsafe(stmt);
      } catch (e) {
        out = String((e as { code?: unknown }).code);
      }
      throw new Rollback();
    })
    .catch((e) => {
      if (!(e instanceof Rollback)) throw e;
    });
  return out;
}

describe('the MCP OAuth tables are system-only (mcp-authorization "OAuth storage")', () => {
  it('catalog_user holds no privilege and no policy on any of them; catalog_system has the allow-all one', async () => {
    const db = await createTestDatabase();
    const admin = connect(db.admin);
    for (const table of TABLES) {
      for (const priv of [
        'select',
        'insert',
        'update',
        'delete',
        'truncate',
        'references',
        'trigger',
      ]) {
        const [r] =
          await admin`select has_table_privilege('catalog_user', ${`catalog.${table}`}, ${priv}) as p`;
        expect(r?.p, `${table} ${priv}`).toBe(false);
      }
      const [rls] = await admin`select relrowsecurity from pg_class
                                where oid = ${`catalog.${table}`}::regclass`;
      expect(rls?.relrowsecurity, table).toBe(true);
      const policies = await admin`select policyname, cmd, roles::text[] as roles, qual, with_check
                                   from pg_policies where schemaname = 'catalog' and tablename = ${table}`;
      expect(policies.map((p) => ({ ...p }))).toEqual([
        {
          policyname: `${table}_system_all`,
          cmd: 'ALL',
          roles: ['catalog_system'],
          qual: 'true',
          with_check: 'true',
        },
      ]);
    }
  });

  it('a catalog_user binding gets 42501 on select, insert, update and delete of each table, even for its own rows', async () => {
    const db = await createTestDatabase();
    const sys = connect(db.system);
    await seed(sys);
    const app = connect(db.app);
    const key: Record<(typeof TABLES)[number], string> = {
      mcp_clients: 'id',
      mcp_grants: 'id',
      mcp_access_tokens: 'token_hash',
      mcp_refresh_tokens: 'token_hash',
      mcp_rate_windows: 'bucket',
    };
    for (const table of TABLES) {
      for (const stmt of [
        `select count(*) from ${table}`,
        INSERT[table],
        `update ${table} set ${key[table]} = ${key[table]}`,
        `delete from ${table}`,
      ]) {
        expect(await asUser(app, 'u1', stmt), stmt).toBe('42501');
      }
    }
    for (const table of TABLES) {
      const [n] = await sys.unsafe(`select count(*)::int as n from ${table}`);
      expect(n?.n, table).toBe(1);
    }
  });

  it('catalog_system inserts, selects, updates and deletes every table', async () => {
    const db = await createTestDatabase();
    const sys = connect(db.system);
    await seed(sys);
    for (const table of TABLES) await sys.unsafe(INSERT[table]);
    expect(
      (await sys`update mcp_refresh_tokens set successor_sealed = null returning token_hash`)
        .length,
    ).toBe(2);
    expect((await sys`update mcp_grants set revoked_at_utc = ${T} returning id`).length).toBe(2);
    for (const table of [...TABLES].reverse()) {
      expect((await sys.unsafe(`delete from ${table} returning 1`)).length, table).toBe(2);
    }
  });
});

describe('the MCP OAuth tables keep the cap, the seal column and their constraints (design 4.7)', () => {
  it('mcp_grants.expires_at_utc is not null and mcp_refresh_tokens.successor_sealed exists, nullable', async () => {
    const db = await createTestDatabase();
    const admin = connect(db.admin);
    const cols = await admin`select table_name, column_name, is_nullable, data_type
                             from information_schema.columns
                             where table_schema = 'catalog'
                               and ((table_name = 'mcp_grants' and column_name = 'expires_at_utc')
                                 or (table_name = 'mcp_refresh_tokens' and column_name = 'successor_sealed'))
                             order by table_name`;
    expect(cols.map((c) => ({ ...c }))).toEqual([
      {
        table_name: 'mcp_grants',
        column_name: 'expires_at_utc',
        is_nullable: 'NO',
        data_type: 'text',
      },
      {
        table_name: 'mcp_refresh_tokens',
        column_name: 'successor_sealed',
        is_nullable: 'YES',
        data_type: 'text',
      },
    ]);
    const sys = connect(db.system);
    await seed(sys);
    const code = (stmt: string) =>
      sys.unsafe(stmt).then(
        () => 'ok',
        (e: { code?: unknown }) => String(e.code),
      );
    expect(
      await code(`insert into mcp_grants (id, user_id, client_id, scope, resource, created_at_utc)
                  values ('g9', 'u1', 'alc_1', 'dashboards', 'r', '${T}')`),
    ).toBe('23502');
  });

  it('refuses a blank or long client name, unknown users, clients and grants', async () => {
    const db = await createTestDatabase();
    const sys = connect(db.system);
    await seed(sys);
    const code = (stmt: string) =>
      sys.unsafe(stmt).then(
        () => 'ok',
        (e: { code?: unknown }) => String(e.code),
      );
    const client = (id: string, name: string) =>
      `insert into mcp_clients (id, client_name, redirect_uris_json, registered_from, created_at_utc)
       values ('${id}', '${name}', '[]', 'x', '${T}')`;
    expect(await code(client('c1', ''))).toBe('23514');
    expect(await code(client('c2', 'n'.repeat(101)))).toBe('23514');
    expect(await code(client('c3', 'n'.repeat(100)))).toBe('ok');
    expect(await code(client('alc_1', 'dup'))).toBe('23505');
    expect(
      await code(`insert into mcp_grants (id, user_id, client_id, scope, resource, created_at_utc, expires_at_utc)
                  values ('g8', 'nobody', 'alc_1', 's', 'r', '${T}', '${T}')`),
    ).toBe('23503');
    expect(
      await code(`insert into mcp_grants (id, user_id, client_id, scope, resource, created_at_utc, expires_at_utc)
                  values ('g8', 'u1', 'alc_nobody', 's', 'r', '${T}', '${T}')`),
    ).toBe('23503');
    expect(
      await code(
        `insert into mcp_access_tokens (token_hash, grant_id, expires_at_utc) values ('a9', 'gx', '${T}')`,
      ),
    ).toBe('23503');
    expect(
      await code(
        `insert into mcp_rate_windows (bucket, window_start_ms, count) values ('b1', 1, 5)`,
      ),
    ).toBe('23505');
  });

  it('deleting a user or a client cascades its grants and their tokens', async () => {
    const db = await createTestDatabase();
    const sys = connect(db.system);
    await seed(sys);
    await sys`delete from users where id = 'u1'`;
    expect((await sys`select id from mcp_grants`).length).toBe(0);
    expect((await sys`select token_hash from mcp_access_tokens`).length).toBe(0);
    expect((await sys`select token_hash from mcp_refresh_tokens`).length).toBe(0);
    expect((await sys`select id from mcp_clients`).length).toBe(1);
    await sys`insert into users (id, google_sub, email, created_at_utc) values ('u1', 's', 'e', ${T})`;
    await sys.unsafe(INSERT.mcp_grants);
    await sys`delete from mcp_clients where id = 'alc_1'`;
    expect((await sys`select id from mcp_grants`).length).toBe(0);
  });
});

describe('the MCP OAuth migration (design 4.7)', () => {
  it('replays on the schema before it and creates the five tables empty', async () => {
    const name = `t_mcp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    // The replay runs the role guards, which a parallel scratch role would trip (roleGuardLock.ts).
    await holdRoleGuardLock(connect(connOptions('postgres', 'postgres')));
    const root = connect(connOptions('postgres', 'postgres'));
    await root.unsafe(`create database ${name} template template0`);
    const sql = connect(connOptions('postgres', name));
    const earlier = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql') && f < MIGRATION)
      .sort();
    expect(earlier.at(-1)).toBe('20261025000000_autogenerate_jobs.sql');
    for (const f of earlier)
      await replayMigration(sql, readFileSync(resolve(MIGRATIONS, f), 'utf8'));
    await replayMigration(sql, readFileSync(resolve(MIGRATIONS, MIGRATION), 'utf8'));
    for (const table of TABLES) {
      const [n] = await sql.unsafe(`select count(*)::int as n from catalog.${table}`);
      expect(n?.n, table).toBe(0);
    }
  });
});
