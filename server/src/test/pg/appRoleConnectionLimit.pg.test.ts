// session-frame-bus D7 (ADR 0021 slice 9a): the app role's connection limit counts every server
// process together, so a migration raises it to 45 (three processes of 14 connections) and refuses
// a server whose `max_connections` is below 100.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import { type ConnOptions, connOptions, createTestDatabase } from '../../../../test/pg/testDb';
import {
  CONNECTION_LIMIT_MIGRATION,
  readAppRoleWithLimitMigration,
  replayMigration,
} from './appRoleLimit';
import { holdRoleGuardLock } from './roleGuardLock';

const CATALOG_SCHEMA_MIGRATION = resolve(
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

describe('the app role connection limit migration (session-frame-bus D7)', () => {
  it('sets the app role connection limit to 45', async () => {
    // Roles are cluster-wide and other files replay migrations in parallel, though none commits a
    // change to the limit (replayMigration puts it back): the migration runs and the role is read
    // in one rolled-back transaction, which sees its own update and leaves the role as it was (D8).
    const sql = connect((await createTestDatabase()).admin);
    const limit = await readAppRoleWithLimitMigration(sql, async (tx) =>
      Number(
        (await tx`select rolconnlimit from pg_roles where rolname = 'autologger_app'`)[0]
          ?.rolconnlimit,
      ),
    );
    expect(limit).toBe(45);
  });

  it('refuses a server whose max_connections is below 100', async () => {
    const sql = connect((await createTestDatabase()).admin);
    const text = readFileSync(CONNECTION_LIMIT_MIGRATION, 'utf8');
    // `max_connections` changes only with a restart, so a `current_setting` searched before
    // `pg_catalog` stands in for a smaller server (pg_catalog named in the path is searched in
    // its place). migrate.sh runs a file in one transaction, so the refusal changes nothing.
    await sql.unsafe(`create schema small_server;
      create function small_server.current_setting(text) returns text language sql
        as $$ select case when $1 = 'max_connections' then '99' else pg_catalog.current_setting($1) end $$`);
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe('set local search_path = small_server, pg_catalog');
        await tx.unsafe(text);
      }),
    ).rejects.toThrow(/max_connections/);
  });
});

describe('migration replays leave the app role connection limit alone (appRoleLimit.ts)', () => {
  it('a replay of the catalog schema migration, which sets 20, commits no change to the limit', async () => {
    // The replay runs the role guards, which a parallel scratch role would trip (roleGuardLock.ts).
    await holdRoleGuardLock(connect(connOptions('postgres', 'postgres')));
    const name = `t_rl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const root = connect(connOptions('postgres', 'postgres'));
    await root.unsafe(`create database ${name} template template0`);
    const limit = async () =>
      Number(
        (await root`select rolconnlimit from pg_roles where rolname = 'autologger_app'`)[0]
          ?.rolconnlimit,
      );
    const before = await limit();
    expect(before).toBe(45);
    const sql = connect(connOptions('postgres', name));
    await replayMigration(sql, readFileSync(CATALOG_SCHEMA_MIGRATION, 'utf8'));
    // The migration did run: its schema exists in the scratch database.
    const [s] = await sql`select count(*)::int as n from pg_namespace where nspname = 'catalog'`;
    expect(s?.n).toBe(1);
    expect(await limit()).toBe(before);
  });
});
