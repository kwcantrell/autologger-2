// catalog-pg-schema design D1-D4, D7: the Postgres catalog schema, the app role and its password.
// The schema is checked against a recorded expectation (retire-sqlite-catalog D3).

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
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
  'show_grants',
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
  show_grants: 'user_id',
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

/** Per table: columns, primary key, foreign keys; plus `$unique`, `$checks` and `$indexes`. */
type SchemaRecord = Record<string, unknown>;

/** The catalog schema as text, for comparison with the recorded expectation (retire-sqlite-catalog D3). */
async function readSchema(sql: postgres.Sql): Promise<SchemaRecord> {
  const out: SchemaRecord = {};
  for (const table of TABLES) {
    const cols = await sql`
      select column_name, data_type, collation_name, is_nullable, column_default
      from information_schema.columns
      where table_schema = 'catalog' and table_name = ${table}
      order by ordinal_position`;
    const pk = await sql`
      select a.attname from pg_index i
      join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
      where i.indrelid = ${`catalog.${table}`}::regclass and i.indisprimary
      order by array_position(i.indkey, a.attnum)`;
    const fks = await sql`
      select pg_get_constraintdef(c.oid) as def from pg_constraint c
      where c.conrelid = ${`catalog.${table}`}::regclass and c.contype = 'f'
      order by def`;
    out[table] = {
      columns: cols.map(
        (c) =>
          `${c.column_name} ${c.data_type}${c.collation_name ? ` collate ${c.collation_name}` : ''}` +
          `${c.is_nullable === 'NO' ? ' not null' : ''}` +
          `${c.column_default === null ? '' : ` default ${c.column_default}`}`,
      ),
      primaryKey: pk.map((r) => r.attname),
      foreignKeys: fks.map((r) => r.def),
    };
  }
  const uniques = await sql`
    select conrelid::regclass::text || ' ' || pg_get_constraintdef(oid) as u from pg_constraint
    where contype = 'u' and connamespace = 'catalog'::regnamespace order by u`;
  const checks = await sql`
    select conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid) as c
    from pg_constraint
    where contype = 'c' and connamespace = 'catalog'::regnamespace order by c`;
  const idx = await sql`
    select indexdef from pg_indexes
    where schemaname = 'catalog' and indexname like 'idx\\_%' order by indexname`;
  out.$unique = uniques.map((r) => r.u);
  out.$checks = checks.map((r) => r.c);
  out.$indexes = idx.map((r) => r.indexdef);
  return out;
}

// Recorded from the Postgres catalog while it still matched the retired SQLite catalog (migrations
// 0001-0006) in that catalog's parity tests, in one run (retire-sqlite-catalog D3). A migration that
// changes the catalog schema updates this record in the same change.
const EXPECTED_SCHEMA: SchemaRecord = {
  users: {
    columns: [
      'id text collate C not null',
      'google_sub text collate C not null',
      'email text collate C not null',
      "given_name text collate C not null default ''::text",
      "family_name text collate C not null default ''::text",
      "picture_url text collate C not null default ''::text",
      'created_at_utc text collate C not null',
      'disabled_at_utc text collate C',
    ],
    primaryKey: ['id'],
    foreignKeys: [],
  },
  user_studio_memberships: {
    columns: [
      'user_id text collate C not null',
      'studio_id text collate C not null',
      "role text collate C not null default 'member'::text",
    ],
    primaryKey: ['user_id', 'studio_id'],
    foreignKeys: ['FOREIGN KEY (user_id) REFERENCES catalog.users(id) ON DELETE CASCADE'],
  },
  user_prefs: {
    columns: [
      'user_id text collate C not null',
      "active_studio_id text collate C not null default ''::text",
      "active_show_id text collate C not null default ''::text",
    ],
    primaryKey: ['user_id'],
    foreignKeys: ['FOREIGN KEY (user_id) REFERENCES catalog.users(id) ON DELETE CASCADE'],
  },
  studio_definitions: {
    columns: [
      'id text collate C not null',
      'display_name text collate C not null',
      'sort_order bigint not null default 0',
      'created_at_utc text collate C not null',
    ],
    primaryKey: ['id'],
    foreignKeys: [],
  },
  shows: {
    columns: [
      'id text collate C not null',
      'studio_id text collate C not null',
      'name text collate C not null',
      'show_code text collate C not null',
      'next_episode bigint not null default 1',
      "categories_json text collate C not null default '[]'::text",
      "event_palette_json text collate C not null default '[]'::text",
      "event_palette_preset text collate C not null default 'custom'::text",
      "event_palette_custom_json text collate C not null default '[]'::text",
      'created_at_utc text collate C not null',
      "title_suffix text collate C not null default 'date'::text",
    ],
    primaryKey: ['id'],
    foreignKeys: [],
  },
  app_settings: {
    columns: ['key text collate C not null', 'value text collate C not null'],
    primaryKey: ['key'],
    foreignKeys: [],
  },
  sessions: {
    columns: [
      'id text collate C not null',
      'show_id text collate C',
      "title text collate C not null default ''::text",
      'archived bigint not null default 0',
      'frame_rate double precision not null default 24.0',
      'start_offset_frames bigint not null default 0',
      "episode text collate C not null default ''::text",
      "notes text collate C not null default ''::text",
      "started_at_utc text collate C not null default ''::text",
      "created_at_utc text collate C not null default ''::text",
      'episode_date text collate C',
      'ui_hidden bigint not null default 0',
      'event_count bigint not null default 0',
      'max_timecode_total_frames bigint',
      'is_rolling bigint not null default 0',
      'current_take bigint not null default 0',
      'transport_elapsed_frames bigint not null default 0',
      'roll_started_at_utc text collate C',
    ],
    primaryKey: ['id'],
    foreignKeys: ['FOREIGN KEY (show_id) REFERENCES catalog.shows(id)'],
  },
  kv: {
    columns: ['key text collate C not null', 'value text collate C not null', 'expires_at bigint'],
    primaryKey: ['key'],
    foreignKeys: [],
  },
  team_invites: {
    columns: [
      'studio_id text collate C not null',
      'email_norm text collate C not null',
      'invited_by_user_id text collate C not null',
      'invited_at_utc text collate C not null',
    ],
    primaryKey: ['studio_id', 'email_norm'],
    foreignKeys: [],
  },
  // show-grants D1.
  show_grants: {
    columns: [
      'user_id text collate C not null',
      'show_id text collate C not null',
      'can_write bigint not null default 1',
      'granted_by_user_id text collate C',
      'granted_at_utc text collate C not null',
    ],
    primaryKey: ['user_id', 'show_id'],
    foreignKeys: [
      'FOREIGN KEY (show_id) REFERENCES catalog.shows(id) ON DELETE CASCADE',
      'FOREIGN KEY (user_id) REFERENCES catalog.users(id) ON DELETE CASCADE',
    ],
  },
  $unique: ['catalog.users UNIQUE (google_sub)'],
  // owner-bootstrap D1: the role check and at most one owner per team.
  $checks: [
    "catalog.user_studio_memberships user_studio_memberships_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text])))",
  ],
  $indexes: [
    'CREATE INDEX idx_sessions_show ON catalog.sessions USING btree (show_id)',
    'CREATE INDEX idx_show_grants_show ON catalog.show_grants USING btree (show_id)',
    'CREATE INDEX idx_shows_studio ON catalog.shows USING btree (studio_id)',
    "CREATE UNIQUE INDEX idx_user_studio_memberships_one_owner ON catalog.user_studio_memberships USING btree (studio_id) WHERE (role = 'owner'::text)",
    'CREATE INDEX idx_user_studio_memberships_studio ON catalog.user_studio_memberships USING btree (studio_id)',
    'CREATE INDEX idx_users_email ON catalog.users USING btree (email)',
  ],
};
const EXPECTED_SHOWS: unknown[] = [
  {
    id: 'show-autolog-test',
    studio_id: 'test-studios',
    name: 'Autolog Test Show',
    show_code: 'ATS',
    next_episode: 1,
    categories_json:
      '[{"id":"a1000000-0000-4000-8000-000000000001","name":"Scene","color":"#4a9fd4","type":"BUTTON","dropdown_options":[],"on_label":"","off_label":""},{"id":"a1000000-0000-4000-8000-000000000002","name":"Audio issue","color":"#a86bdc","type":"DROPDOWN","dropdown_options":[{"label":"Lav","needs_context":false},{"label":"Boom","needs_context":false}],"on_label":"","off_label":""},{"id":"a1000000-0000-4000-8000-000000000003","name":"Note","color":"#6bcf7a","type":"TEXT","dropdown_options":[],"on_label":"","off_label":""}]',
    event_palette_json:
      '["#4a9fd4","#a86bdc","#6bcf7a","#64748b","#64748b","#64748b","#64748b","#64748b","#64748b"]',
    event_palette_preset: 'custom',
    event_palette_custom_json:
      '["#4a9fd4","#a86bdc","#6bcf7a","#64748b","#64748b","#64748b","#64748b","#64748b","#64748b"]',
    created_at_utc: '2024-01-01T00:00:00Z',
    title_suffix: 'episode',
  },
  {
    id: 'show-the-something-podcast',
    studio_id: 'test-studio-2',
    name: 'The Something Podcast',
    show_code: 'TSP',
    next_episode: 1,
    categories_json:
      '[{"id":"b2000000-0000-4000-8000-000000000001","name":"Note","color":"#7cb7ff","type":"TEXT","dropdown_options":[],"on_label":"","off_label":""},{"id":"b2000000-0000-4000-8000-000000000002","name":"Mark","color":"#f4a82e","type":"BUTTON","dropdown_options":[],"on_label":"","off_label":""}]',
    event_palette_json:
      '["#7cb7ff","#f4a82e","#64748b","#64748b","#64748b","#64748b","#64748b","#64748b","#64748b"]',
    event_palette_preset: 'custom',
    event_palette_custom_json:
      '["#7cb7ff","#f4a82e","#64748b","#64748b","#64748b","#64748b","#64748b","#64748b","#64748b"]',
    created_at_utc: '2024-01-01T00:00:00Z',
    title_suffix: 'episode',
  },
];

describe('the recorded catalog schema (retire-sqlite-catalog D3)', () => {
  it('matches the recorded catalog schema', async () => {
    const db = await createTestDatabase();
    const actual = await readSchema(connect(db.admin));
    expect(actual).toEqual(EXPECTED_SCHEMA);
  });

  it('seeds the recorded shows', async () => {
    const db = await createTestDatabase();
    const rows = await connect(
      db.admin,
    )`select row_to_json(s) as r from catalog.shows s order by id`;
    expect(rows.map((r) => r.r)).toEqual(EXPECTED_SHOWS);
  });
});

describe('catalog schema (design D1)', () => {
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

  it('orders text bytewise', async () => {
    const db = await createTestDatabase();
    const sql = connect(db.system);
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
    const sql = connect(db.system);
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
  it.each([
    'user',
    'system',
  ] as const)('as catalog_%s, reads and writes every catalog table by unqualified name (catalog-roles D12)', async (role) => {
    const db = await createTestDatabase();
    const sql = connect(db[role]);
    expect((await sql`select current_user as u`)[0]?.u).toBe(`catalog_${role}`);
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
    await sql`insert into show_grants (user_id, show_id, granted_at_utc) values ('u', 'sh', ${t})`;
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

  it('has only the designed attributes, limits and settings, and exactly the two memberships', async () => {
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
    // catalog-roles D1/D3: set only, no inherit, no admin option.
    const m = await sql`select r.rolname, m.inherit_option, m.set_option, m.admin_option
                        from pg_auth_members m join pg_roles r on r.oid = m.roleid
                        where m.member = 'autologger_app'::regrole order by r.rolname`;
    expect(m.map((x) => ({ ...x }))).toEqual([
      { rolname: 'catalog_system', inherit_option: false, set_option: true, admin_option: false },
      { rolname: 'catalog_user', inherit_option: false, set_option: true, admin_option: false },
    ]);
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

describe('row-level security on every catalog table (catalog-roles D1, D2)', () => {
  it('every catalog table has row-level security and a policy for each catalog role', async () => {
    const db = await createTestDatabase();
    const sql = connect(db.admin);
    const tables = await sql`select c.relname, c.relrowsecurity from pg_class c
                             where c.relnamespace = 'catalog'::regnamespace and c.relkind = 'r'
                             order by c.relname`;
    expect(tables.map((t) => t.relname)).toEqual([...TABLES].sort());
    for (const t of tables) {
      expect(t.relrowsecurity, t.relname).toBe(true);
      const policies = await sql`select policyname, roles::text[] as roles from pg_policies
                                 where schemaname = 'catalog' and tablename = ${t.relname}`;
      const byName = Object.fromEntries(policies.map((p) => [p.policyname, p.roles]));
      expect(byName[`${t.relname}_user_all`], t.relname).toEqual(['catalog_user']);
      expect(byName[`${t.relname}_system_all`], t.relname).toEqual(['catalog_system']);
    }
  });

  it.each([
    'user',
    'system',
  ] as const)('as catalog_%s, the allow-all policies change nothing on rows naming another user', async (role) => {
    const db = await createTestDatabase();
    const admin = connect(db.admin);
    const t = '2026-10-06T00:00:00.000Z';
    // Rows naming `other`, written by the table owner (which bypasses RLS).
    await admin.unsafe(`
        insert into catalog.users (id, google_sub, email, created_at_utc) values ('other', 'g-o', 'o@example.com', '${t}');
        insert into catalog.user_studio_memberships (user_id, studio_id) values ('other', 'st-o');
        insert into catalog.user_prefs (user_id) values ('other');
        insert into catalog.studio_definitions (id, display_name, created_at_utc) values ('st-o', 'O', '${t}');
        insert into catalog.shows (id, studio_id, name, show_code, created_at_utc) values ('sh-o', 'st-o', 'N', 'C', '${t}');
        insert into catalog.app_settings (key, value) values ('k-o', 'v');
        insert into catalog.sessions (id, show_id) values ('se-o', 'sh-o');
        insert into catalog.kv (key, value) values ('k-o', 'v');
        insert into catalog.team_invites (studio_id, email_norm, invited_by_user_id, invited_at_utc) values ('st-o', 'e', 'other', '${t}');
        insert into catalog.show_grants (user_id, show_id, granted_at_utc) values ('other', 'sh-o', '${t}');
      `);
    const counts: Record<string, number> = {};
    for (const table of TABLES) {
      const n = await admin.unsafe(`select count(*)::int as n from catalog.${table}`);
      counts[table] = n[0]?.n as number;
    }
    const sql = connect(db.app);
    await sql.begin(async (tx) => {
      await tx`select set_config('role', ${`catalog_${role}`}, true),
                        set_config('app.user_id', ${role === 'user' ? 'u-1' : ''}, true)`;
      expect((await tx`select current_user as u`)[0]?.u).toBe(`catalog_${role}`);
      for (const table of TABLES) {
        const sel = await tx.unsafe(`select count(*)::int as n from ${table}`);
        expect(sel[0]?.n, `select ${table}`).toBe(counts[table]);
        const key = KEY_COLUMN[table];
        const upd = await tx.unsafe(`update ${table} set ${key} = ${key}`);
        expect(upd.count, `update ${table}`).toBe(counts[table]);
      }
      await tx`insert into users (id, google_sub, email, created_at_utc)
                 values ('u-1', 'g-1', 'u1@example.com', ${t})`;
      await tx`insert into show_grants (user_id, show_id, granted_at_utc) values ('u-1', 'sh-o', ${t})`;
      expect((await tx`select count(*)::int as n from users`)[0]?.n).toBe(counts.users + 1);
      for (const table of [...TABLES].reverse()) {
        const del = await tx.unsafe(`delete from ${table}`);
        const extra = table === 'users' || table === 'show_grants' ? 1 : 0;
        expect(del.count, `delete ${table}`).toBe(counts[table] + extra);
      }
    });
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
