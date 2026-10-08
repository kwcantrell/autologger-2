// companion-devices design D1 (ADR 0021 slice 9d): `catalog.companion_devices` and
// `catalog.companion_presence` from `20261015000000_companion_devices.sql`. Both are system-only,
// like kv: catalog_user is refused with 42501 before any policy, catalog_system reads and writes
// every row. Deleting a user takes their devices and presence; deleting a session clears a presence
// row's session. The migration drops the old deployment-wide `companion:last_command` kv entry.

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import { type ConnOptions, connOptions, createTestDatabase } from '../../../../test/pg/testDb';
import { holdRoleGuardLock } from './roleGuardLock';

const MIGRATIONS = resolve(import.meta.dirname, '../../../../supabase/migrations');
const MIGRATION = '20261015000000_companion_devices.sql';
const T = '2026-10-15T00:00:00.000Z';
const TABLES = ['companion_devices', 'companion_presence'] as const;

const open: postgres.Sql[] = [];
function connect(o: ConnOptions): postgres.Sql {
  const sql = postgres({ ...o, max: 1, onnotice: () => {} });
  open.push(sql);
  return sql;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.end()));
});

async function seedUser(sys: postgres.Sql, id: string): Promise<void> {
  await sys`insert into users (id, google_sub, email, created_at_utc)
            values (${id}, ${`${id}-sub`}, ${`${id}@example.com`}, ${T})`;
}
const insertDevice = (id: string, user: string, hash: string, name = 'Desk') =>
  `insert into companion_devices (id, user_id, name, token_hash, created_at_utc)
   values ('${id}', '${user}', '${name}', '${hash}', '${T}')`;
const insertPresence = (client: string, user: string, session: string | null) =>
  `insert into companion_presence (client_id, user_id, session_id, visible, is_playing, updated_at_ms)
   values ('${client}', '${user}', ${session === null ? 'null' : `'${session}'`}, true, false, 1000)`;

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

describe('the Companion tables are system-only (catalog-database "Companion devices and presence are stored in the catalog")', () => {
  it('catalog_user holds no privilege and no policy on either table; catalog_system has the allow-all one', async () => {
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

  it('a catalog_user binding gets 42501 on select, insert, update and delete of both tables, even for its own rows', async () => {
    const db = await createTestDatabase();
    const sys = connect(db.system);
    await seedUser(sys, 'u1');
    await sys`insert into sessions (id) values ('s1')`;
    await sys.unsafe(insertDevice('d1', 'u1', 'h1'));
    await sys.unsafe(insertPresence('tab-1', 'u1', 's1'));
    const app = connect(db.app);
    for (const stmt of [
      'select count(*) from companion_devices',
      insertDevice('d2', 'u1', 'h2'),
      `update companion_devices set name = name where user_id = 'u1'`,
      `delete from companion_devices where user_id = 'u1'`,
      'select count(*) from companion_presence',
      insertPresence('tab-2', 'u1', 's1'),
      `update companion_presence set visible = visible where user_id = 'u1'`,
      `delete from companion_presence where user_id = 'u1'`,
    ]) {
      expect(await asUser(app, 'u1', stmt), stmt).toBe('42501');
    }
    // The rows are untouched.
    expect((await sys`select id from companion_devices`).map((r) => r.id)).toEqual(['d1']);
    expect((await sys`select client_id from companion_presence`).map((r) => r.client_id)).toEqual([
      'tab-1',
    ]);
  });

  it('catalog_system inserts, selects, updates and deletes rows of any user', async () => {
    const db = await createTestDatabase();
    const sys = connect(db.system);
    await seedUser(sys, 'u1');
    await seedUser(sys, 'u2');
    await sys`insert into sessions (id) values ('s1')`;
    await sys.unsafe(insertDevice('d1', 'u1', 'h1'));
    await sys.unsafe(insertDevice('d2', 'u2', 'h2'));
    await sys.unsafe(insertPresence('tab-1', 'u1', 's1'));
    await sys.unsafe(insertPresence('tab-2', 'u2', null));
    expect(
      (await sys`update companion_devices set last_used_at_utc = ${T} returning id`)
        .map((r) => r.id)
        .sort(),
    ).toEqual(['d1', 'd2']);
    expect(
      (await sys`update companion_presence set updated_at_ms = 2000 returning client_id`)
        .map((r) => r.client_id)
        .sort(),
    ).toEqual(['tab-1', 'tab-2']);
    const [p] = await sys`select session_id, visible, is_playing, updated_at_ms
                          from companion_presence where client_id = 'tab-2'`;
    expect({ ...p, updated_at_ms: Number(p?.updated_at_ms) }).toEqual({
      session_id: null,
      visible: true,
      is_playing: false,
      updated_at_ms: 2000,
    });
    expect((await sys`delete from companion_devices returning id`).length).toBe(2);
    expect((await sys`delete from companion_presence returning client_id`).length).toBe(2);
  });
});

describe('the Companion tables keep their constraints (design D1)', () => {
  it('a deleted user takes their devices and presence; other users keep theirs', async () => {
    const db = await createTestDatabase();
    const sys = connect(db.system);
    await seedUser(sys, 'u1');
    await seedUser(sys, 'u2');
    await sys.unsafe(insertDevice('d1', 'u1', 'h1'));
    await sys.unsafe(insertDevice('d2', 'u1', 'h2'));
    await sys.unsafe(insertDevice('d3', 'u2', 'h3'));
    await sys.unsafe(insertPresence('tab-1', 'u1', null));
    await sys.unsafe(insertPresence('tab-2', 'u2', null));
    await sys`delete from users where id = 'u1'`;
    expect((await sys`select id from companion_devices`).map((r) => r.id)).toEqual(['d3']);
    expect((await sys`select client_id from companion_presence`).map((r) => r.client_id)).toEqual([
      'tab-2',
    ]);
  });

  it('a deleted session clears the presence row’s session and keeps the row', async () => {
    const db = await createTestDatabase();
    const sys = connect(db.system);
    await seedUser(sys, 'u1');
    await sys`insert into sessions (id) values ('s1'), ('s2')`;
    await sys.unsafe(insertPresence('tab-1', 'u1', 's1'));
    await sys.unsafe(insertPresence('tab-2', 'u1', 's2'));
    await sys`delete from sessions where id = 's1'`;
    const rows = await sys`select client_id, session_id from companion_presence order by client_id`;
    expect(rows.map((r) => ({ ...r }))).toEqual([
      { client_id: 'tab-1', session_id: null },
      { client_id: 'tab-2', session_id: 's2' },
    ]);
  });

  it('refuses a duplicate token hash, an unknown user or session, a blank or long name and client id', async () => {
    const db = await createTestDatabase();
    const sys = connect(db.system);
    await seedUser(sys, 'u1');
    await sys.unsafe(insertDevice('d1', 'u1', 'h1'));
    const code = (stmt: string) =>
      sys.unsafe(stmt).then(
        () => 'ok',
        (e: { code?: unknown }) => String(e.code),
      );
    expect(await code(insertDevice('d2', 'u1', 'h1'))).toBe('23505');
    expect(await code(insertDevice('d3', 'nobody', 'h3'))).toBe('23503');
    expect(await code(insertDevice('d4', 'u1', 'h4', ''))).toBe('23514');
    expect(await code(insertDevice('d5', 'u1', 'h5', 'n'.repeat(81)))).toBe('23514');
    expect(await code(insertDevice('d6', 'u1', 'h6', 'n'.repeat(80)))).toBe('ok');
    expect(await code(insertPresence('', 'u1', null))).toBe('23514');
    expect(await code(insertPresence('c'.repeat(257), 'u1', null))).toBe('23514');
    expect(await code(insertPresence('c'.repeat(256), 'u1', null))).toBe('ok');
    expect(await code(insertPresence('tab-x', 'nobody', null))).toBe('23503');
    expect(await code(insertPresence('tab-y', 'u1', 'no-such-session'))).toBe('23503');
  });
});

describe('the companion devices migration (design D1, D3)', () => {
  it('creates both tables empty and deletes only the old global last-command kv entry', async () => {
    const name = `t_cd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    // The replay runs the role guards, which a parallel scratch role would trip (roleGuardLock.ts).
    await holdRoleGuardLock(connect(connOptions('postgres', 'postgres')));
    const root = connect(connOptions('postgres', 'postgres'));
    await root.unsafe(`create database ${name} template template0`);
    const sql = connect(connOptions('postgres', name));
    const earlier = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql') && f < MIGRATION)
      .sort();
    expect(earlier).toContain('20261014000000_session_lease_started_at.sql');
    for (const f of earlier) {
      const text = readFileSync(resolve(MIGRATIONS, f), 'utf8');
      await sql.begin((tx) => tx.unsafe(text));
    }
    await sql.unsafe(`
      insert into catalog.kv (key, value) values
        ('companion:last_command', '{"id":"c1","type":"record-start"}'),
        ('companion:last_command:d1', 'kept'),
        ('other', 'kept');`);
    const text = readFileSync(resolve(MIGRATIONS, MIGRATION), 'utf8');
    await sql.begin((tx) => tx.unsafe(text));
    const kv = await sql`select key from catalog.kv order by key`;
    expect(kv.map((r) => r.key)).toEqual(['companion:last_command:d1', 'other']);
    for (const table of TABLES) {
      const [n] = await sql.unsafe(`select count(*)::int as n from catalog.${table}`);
      expect(n?.n, table).toBe(0);
    }
  });
});
