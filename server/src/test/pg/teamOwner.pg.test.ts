// owner-bootstrap D1: the role check, at most one owner per team in the database, the two seed
// teams as studio_definitions rows, and no global active team or show settings.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import { connOptions, createTestDatabase } from '../../../../test/pg/testDb';

const MIGRATIONS = resolve(import.meta.dirname, '../../../../supabase/migrations');
const EARLIER = [
  '20261001000000_catalog_schema.sql',
  '20261002000000_catalog_team_indexes.sql',
  '20261003000000_drop_pre_gotrue_users.sql',
];
const TEAM_OWNER = '20261004000000_team_owner.sql';
const T = '2026-10-01T00:00:00.000Z';

const open: postgres.Sql[] = [];
function connect(o: postgres.Options<Record<string, never>>): postgres.Sql {
  const sql = postgres({ ...o, max: 1, onnotice: () => {} });
  open.push(sql);
  return sql;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.end()));
});

async function appWithUsers(ids: string[]): Promise<postgres.Sql> {
  const db = await createTestDatabase();
  const sql = connect(db.system);
  for (const id of ids) {
    await sql`insert into users (id, google_sub, email, created_at_utc)
              values (${id}, ${`g-${id}`}, ${`${id}@example.com`}, ${T})`;
  }
  return sql;
}

describe('one owner per team (owner-bootstrap D1)', () => {
  it('refuses a second owner in one team with 23505', async () => {
    const sql = await appWithUsers(['u1', 'u2']);
    await sql`insert into user_studio_memberships (user_id, studio_id, role) values ('u1', 'st', 'owner')`;
    await expect(
      sql`insert into user_studio_memberships (user_id, studio_id, role) values ('u2', 'st', 'owner')`,
    ).rejects.toMatchObject({ code: '23505' });
    const n = await sql`select count(*)::int as n from user_studio_memberships
                        where studio_id = 'st' and role = 'owner'`;
    expect(n[0]?.n).toBe(1);
  });

  it('refuses an unknown role with 23514', async () => {
    const sql = await appWithUsers(['u1']);
    await expect(
      sql`insert into user_studio_memberships (user_id, studio_id, role) values ('u1', 'st', 'superuser')`,
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('allows owners in two different teams', async () => {
    const sql = await appWithUsers(['u1', 'u2']);
    await sql`insert into user_studio_memberships (user_id, studio_id, role) values ('u1', 'a', 'owner')`;
    await sql`insert into user_studio_memberships (user_id, studio_id, role) values ('u2', 'b', 'owner')`;
    const n =
      await sql`select count(*)::int as n from user_studio_memberships where role = 'owner'`;
    expect(n[0]?.n).toBe(2);
  });
});

describe('the seed teams (owner-bootstrap D1)', () => {
  it('defines test-studios and test-studio-2 with no members, and the seed shows name them', async () => {
    const db = await createTestDatabase();
    const sql = connect(db.admin);
    const defs = await sql`select id, display_name, sort_order::int as sort_order
                           from catalog.studio_definitions order by sort_order, id`;
    expect(defs.map((r) => ({ ...r }))).toEqual([
      { id: 'test-studios', display_name: 'Test Studio', sort_order: 0 },
      { id: 'test-studio-2', display_name: 'Test Studio 2', sort_order: 1 },
    ]);
    const members = await sql`select count(*)::int as n from catalog.user_studio_memberships
                              where studio_id in ('test-studios', 'test-studio-2')`;
    expect(members[0]?.n).toBe(0);
    const orphans = await sql`select s.id from catalog.shows s
                              left join catalog.studio_definitions d on d.id = s.studio_id
                              where d.id is null`;
    expect(orphans.map((r) => r.id)).toEqual([]);
  });

  it('leaves no global active team or show setting', async () => {
    const db = await createTestDatabase();
    const sql = connect(db.admin);
    const rows = await sql`select key from catalog.app_settings
                           where key in ('active_studio_id', 'active_show_id')`;
    expect(rows.length).toBe(0);
  });

  it('deletes the global settings that existed before the migration ran', async () => {
    const name = `t_owner_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const root = connect(connOptions('postgres', 'postgres'));
    await root.unsafe(`create database ${name} template template0`);
    const sql = connect(connOptions('postgres', name));
    for (const f of EARLIER) {
      const text = readFileSync(resolve(MIGRATIONS, f), 'utf8');
      await sql.begin((tx) => tx.unsafe(text));
    }
    await sql.unsafe(`insert into catalog.app_settings (key, value)
                      values ('active_studio_id', 'test-studios'), ('active_show_id', 'show-autolog-test'),
                             ('other', 'kept')`);
    const text = readFileSync(resolve(MIGRATIONS, TEAM_OWNER), 'utf8');
    await sql.begin((tx) => tx.unsafe(text));
    const rows = await sql`select key from catalog.app_settings order by key`;
    expect(rows.map((r) => r.key)).toEqual(['other']);
    const defs = await sql`select id from catalog.studio_definitions order by sort_order, id`;
    expect(defs.map((r) => r.id)).toEqual(['test-studios', 'test-studio-2']);
  });
});
