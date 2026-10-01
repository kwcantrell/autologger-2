// catalog-pg-schema design D1-D4, D7: the Postgres catalog schema, the app role and its password.
// The SQLite side of the parity checks is today's catalog built by `applyMigrations`; this file
// goes with the SQLite catalog in slice 4e.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CATALOG_MIGRATIONS_DIR } from '@autologger/catalog';
import { applyMigrations, openCatalogDb } from '@autologger/storage';
import type Database from 'better-sqlite3';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  type ConnOptions,
  connOptions,
  createTestDatabase,
  testPg,
} from '../../../../test/pg/testDb';

const TABLES = [
  'users',
  'user_studio_memberships',
  'user_prefs',
  'studio_definitions',
  'shows',
  'app_settings',
  'sessions',
  'kv',
  'team_invites',
];
const KEY_COLUMN: Record<string, string> = {
  users: 'id',
  user_studio_memberships: 'user_id',
  user_prefs: 'user_id',
  studio_definitions: 'id',
  shows: 'id',
  app_settings: 'key',
  sessions: 'id',
  kv: 'key',
  team_invites: 'studio_id',
};
const PG_TYPE: Record<string, string> = {
  TEXT: 'text',
  INTEGER: 'bigint',
  REAL: 'double precision',
};
const MIGRATION = resolve(
  import.meta.dirname,
  '../../../../supabase/migrations/20261001000000_catalog_schema.sql',
);

const open: postgres.Sql[] = [];
function connect(o: ConnOptions): postgres.Sql {
  const sql = postgres({ ...o, max: 1, onnotice: () => {} });
  open.push(sql);
  return sql;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.end()));
});

let lite: Database.Database;
let liteDir: string;
beforeAll(() => {
  liteDir = mkdtempSync(join(tmpdir(), 'autologger-parity-'));
  lite = openCatalogDb(join(liteDir, 'catalog.db'));
  applyMigrations(lite, CATALOG_MIGRATIONS_DIR);
});
afterAll(() => {
  lite.close();
  rmSync(liteDir, { recursive: true, force: true });
});

type LiteCol = {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};

describe('schema parity with the SQLite catalog (design D1)', () => {
  it('has exactly the catalog tables, in schema catalog', async () => {
    const db = await createTestDatabase();
    const sql = connect(db.admin);
    const rows = await sql`select table_name from information_schema.tables
                           where table_schema = 'catalog' order by table_name`;
    expect(rows.map((r) => r.table_name)).toEqual([...TABLES].sort());
    const pub = await sql`select count(*)::int as n from information_schema.tables
                          where table_schema = 'public' and table_name = any(${TABLES})`;
    expect(pub[0]?.n).toBe(0);
  });

  it('columns, types, collation, nullability and defaults match', async () => {
    const db = await createTestDatabase();
    const sql = connect(db.admin);
    for (const table of TABLES) {
      const liteCols = lite.prepare(`PRAGMA table_info(${table})`).all() as LiteCol[];
      const pgCols = await sql`
        select column_name, data_type, collation_name, is_nullable, column_default
        from information_schema.columns
        where table_schema = 'catalog' and table_name = ${table}
        order by ordinal_position`;
      expect(
        pgCols.map((c) => c.column_name),
        table,
      ).toEqual(liteCols.map((c) => c.name));
      for (const [i, lc] of liteCols.entries()) {
        const pc = pgCols[i];
        const where = `${table}.${lc.name}`;
        expect(pc?.data_type, where).toBe(PG_TYPE[lc.type]);
        expect(pc?.collation_name, where).toBe(lc.type === 'TEXT' ? 'C' : null);
        // Postgres primary-key columns are NOT NULL; SQLite text PKs are nullable but never null.
        expect(pc?.is_nullable, where).toBe(lc.notnull || lc.pk ? 'NO' : 'YES');
        // Defaults compared by value: each engine evaluates its own default expression.
        if (lc.dflt_value === null) {
          expect(pc?.column_default, where).toBeNull();
        } else {
          const liteVal = (lite.prepare(`SELECT ${lc.dflt_value} AS v`).get() as { v: unknown }).v;
          const pgVal = await sql.unsafe(`select (${pc?.column_default})::text as v`);
          const num = (v: unknown) =>
            typeof v === 'number' ? v : Number.isNaN(Number(v)) ? v : Number(v);
          expect(typeof liteVal === 'number' ? num(pgVal[0]?.v) : pgVal[0]?.v, where).toBe(liteVal);
        }
      }
    }
  });

  it('primary keys, the unique constraint, foreign keys and named indexes match', async () => {
    const db = await createTestDatabase();
    const sql = connect(db.admin);
    for (const table of TABLES) {
      const liteCols = lite.prepare(`PRAGMA table_info(${table})`).all() as LiteCol[];
      const litePk = liteCols
        .filter((c) => c.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => c.name);
      const pgPk = await sql`
        select a.attname from pg_index i
        join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
        where i.indrelid = ${`catalog.${table}`}::regclass and i.indisprimary
        order by array_position(i.indkey, a.attnum)`;
      expect(
        pgPk.map((r) => r.attname),
        table,
      ).toEqual(litePk);

      const liteFks = (
        lite.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
          table: string;
          from: string;
          to: string;
          on_delete: string;
        }>
      ).map((f) => `${f.from}->${f.table}.${f.to} ${f.on_delete}`);
      const pgFks = await sql`
        select a.attname || '->' || rc.relname || '.' || ra.attname || ' ' ||
          case c.confdeltype when 'c' then 'CASCADE' when 'a' then 'NO ACTION'
            when 'r' then 'RESTRICT' when 'n' then 'SET NULL' else 'SET DEFAULT' end as fk
        from pg_constraint c
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
        join pg_class rc on rc.oid = c.confrelid
        join pg_attribute ra on ra.attrelid = c.confrelid and ra.attnum = c.confkey[1]
        where c.conrelid = ${`catalog.${table}`}::regclass and c.contype = 'f'`;
      expect(pgFks.map((r) => r.fk).sort(), table).toEqual(liteFks.sort());
    }
    const uniques = await sql`
      select conrelid::regclass::text as t, array_to_string(array(
        select attname from pg_attribute where attrelid = conrelid and attnum = any(conkey)), ',') as cols
      from pg_constraint where contype = 'u' and connamespace = 'catalog'::regnamespace`;
    expect(uniques.map((r) => `${r.t}(${r.cols})`)).toEqual(['catalog.users(google_sub)']);
    const liteIdx = lite
      .prepare(
        "SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name",
      )
      .all() as Array<{ name: string; tbl_name: string }>;
    const pgIdx = await sql`
      select indexname as name, tablename as tbl_name from pg_indexes
      where schemaname = 'catalog' and indexname like 'idx\\_%' order by indexname`;
    expect(pgIdx.map((r) => ({ ...r }))).toEqual(liteIdx);
  });

  it('seeds the two shows with the values SQLite has after 0005', async () => {
    const db = await createTestDatabase();
    const sql = connect(db.admin);
    const pgShows = await sql`select row_to_json(s) as r from catalog.shows s order by id`;
    const liteShows = lite.prepare('SELECT * FROM shows ORDER BY id').all();
    expect(pgShows.map((r) => r.r)).toEqual(liteShows);
    expect(liteShows).toHaveLength(2);
  });

  it('orders text bytewise, as SQLite does', async () => {
    const db = await createTestDatabase();
    const sql = connect(db.app);
    for (const [id, name] of [
      ['s-a', 'a'],
      ['s-b', 'B'],
    ]) {
      await sql`insert into shows (id, studio_id, name, show_code, created_at_utc)
                values (${id}, 'st', ${name}, 'X', '2026-10-01T00:00:00.000Z')`;
    }
    const rows = await sql`select name from shows where studio_id = 'st' order by name`;
    expect(rows.map((r) => r.name)).toEqual(['B', 'a']);
  });

  it('round-trips epoch milliseconds, frame counts past int4 and fractional frame rates', async () => {
    const db = await createTestDatabase();
    const sql = connect(db.app);
    const expires = Date.now() + 86_400_000;
    await sql`insert into kv (key, value, expires_at) values ('k', 'v', ${expires})`;
    await sql`insert into sessions (id, start_offset_frames, frame_rate)
              values ('sess', ${3_000_000_000}, ${29.97})`;
    const kv = await sql`select expires_at from kv where key = 'k'`;
    const s = await sql`select start_offset_frames, frame_rate from sessions where id = 'sess'`;
    // postgres.js returns int8 as a string; slice 4b's adapter owns that parser (design A23).
    expect(Number(kv[0]?.expires_at)).toBe(expires);
    expect(Number(s[0]?.start_offset_frames)).toBe(3_000_000_000);
    expect(s[0]?.frame_rate).toBe(29.97);
  });
});

describe('the app role (design D3)', () => {
  it('reads and writes every catalog table by unqualified name', async () => {
    const db = await createTestDatabase();
    const sql = connect(db.app);
    const t = '2026-10-01T00:00:00.000Z';
    await sql`insert into users (id, google_sub, email, created_at_utc) values ('u', 'g', 'e', ${t})`;
    await sql`insert into user_studio_memberships (user_id, studio_id) values ('u', 'st')`;
    await sql`insert into user_prefs (user_id) values ('u')`;
    await sql`insert into studio_definitions (id, display_name, created_at_utc) values ('st', 'S', ${t})`;
    await sql`insert into shows (id, studio_id, name, show_code, created_at_utc)
              values ('sh', 'st', 'N', 'C', ${t})`;
    await sql`insert into app_settings (key, value) values ('k', 'v')`;
    await sql`insert into sessions (id, show_id) values ('se', 'sh')`;
    await sql`insert into kv (key, value) values ('k', 'v')`;
    await sql`insert into team_invites (studio_id, email_norm, invited_by_user_id, invited_at_utc)
              values ('st', 'e', 'u', ${t})`;
    for (const table of TABLES) {
      const n = await sql.unsafe(`select count(*)::int as n from ${table}`);
      expect(n[0]?.n, table).toBeGreaterThan(0);
      const target = KEY_COLUMN[table];
      await sql.unsafe(`update ${table} set ${target} = ${target}`);
    }
    for (const table of [...TABLES].reverse()) await sql.unsafe(`delete from ${table}`);
  });

  it('cannot change the schema, switch roles or read other schemas', async () => {
    const db = await createTestDatabase();
    const sql = connect(db.app);
    for (const stmt of [
      'create table catalog.x (i int)',
      'create table public.x (i int)',
      'truncate kv',
      'drop table kv',
      'set role postgres',
    ]) {
      await expect(sql.unsafe(stmt), stmt).rejects.toMatchObject({ code: '42501' });
    }
    const onPostgres = connect(connOptions('autologger_app', 'postgres'));
    await expect(onPostgres`select id from auth.users limit 1`).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('has only the designed attributes, limits and settings, and no memberships', async () => {
    const db = await createTestDatabase();
    const sql = connect(db.admin);
    const [r] = await sql`
      select rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolcanlogin,
             rolconnlimit, rolconfig
      from pg_roles where rolname = 'autologger_app'`;
    expect(r).toMatchObject({
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
      rolbypassrls: false,
      rolcanlogin: true,
      rolconnlimit: 20,
    });
    expect([...(r?.rolconfig ?? [])].sort()).toEqual([
      'idle_in_transaction_session_timeout=15s',
      'search_path=catalog',
      'statement_timeout=30s',
    ]);
    const m = await sql`select count(*)::int as n from pg_auth_members
                        where member = 'autologger_app'::regrole`;
    expect(m[0]?.n).toBe(0);
  });

  it('re-running the role block keeps the role as designed', async () => {
    const text = readFileSync(MIGRATION, 'utf8');
    const block = /-- role:begin\n([\s\S]*?)-- role:end/.exec(text)?.[1];
    expect(block).toBeTruthy();
    const db = await createTestDatabase();
    const sql = connect(db.admin);
    await sql.unsafe(block ?? '');
    const [r] = await sql`select rolsuper, rolbypassrls, rolconnlimit from pg_roles
                          where rolname = 'autologger_app'`;
    expect(r).toMatchObject({ rolsuper: false, rolbypassrls: false, rolconnlimit: 20 });
  });
});

describe('no exposure through the Supabase API roles (design D2)', () => {
  it('anon, authenticated, service_role and public hold no catalog privilege', async () => {
    const sql = connect(connOptions('postgres', 'postgres'));
    for (const role of ['anon', 'authenticated', 'service_role', 'public']) {
      const s = await sql`select has_schema_privilege(${role}, 'catalog', 'usage') as u,
                                 has_schema_privilege(${role}, 'catalog', 'create') as c`;
      expect(s[0], role).toEqual({ u: false, c: false });
      for (const table of TABLES) {
        const p =
          await sql`select bool_or(has_table_privilege(${role}, ${`catalog.${table}`}, priv)) as any
                            from unnest(array['select','insert','update','delete','truncate',
                                              'references','trigger']) as priv`;
        expect(p[0]?.any, `${role} ${table}`).toBe(false);
      }
    }
  });

  it('a session as anon cannot read catalog.users', async () => {
    const sql = connect(connOptions('postgres', 'postgres'));
    await expect(
      sql.begin(async (t) => {
        await t`set local role anon`;
        await t`select id from catalog.users limit 1`;
      }),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe("the app role's password (design D4)", () => {
  it('logs in over TCP with the run password, and refuses a wrong one', async () => {
    const ok = connect(connOptions('autologger_app', 'postgres'));
    expect((await ok`select current_user as u`)[0]?.u).toBe('autologger_app');
    const bad = connect({ ...connOptions('autologger_app', 'postgres'), password: 'f'.repeat(32) });
    await expect(bad`select 1`).rejects.toMatchObject({ code: '28P01' });
  });

  it('leaves the password in neither pg_stat_statements nor the database log', async () => {
    const pw = testPg().appPassword;
    const sql = connect(connOptions('postgres', 'postgres'));
    const total = await sql`select count(*)::int as n from extensions.pg_stat_statements`;
    expect(total[0]?.n).toBeGreaterThan(0);
    const hits = await sql`select count(*)::int as n from extensions.pg_stat_statements
                           where strpos(query, ${pw}) > 0`;
    expect(hits[0]?.n).toBe(0);
    const logs = spawnSync('docker', ['logs', testPg().container], { encoding: 'utf8' });
    expect(logs.status).toBe(0);
    expect(`${logs.stdout}${logs.stderr}`).not.toContain(pw);
  });
});
