// gotrue-sign-in D8: existing users are dropped (ADR 0021), because their ids are not Supabase Auth
// ids. The migration removes users (cascading to memberships and prefs), pending invites and login
// sessions, and nothing else.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDatabase } from '../../../../test/pg/testDb';

const MIGRATION = resolve(
  import.meta.dirname,
  '../../../../supabase/migrations/20261003000000_drop_pre_gotrue_users.sql',
);

const open: postgres.Sql[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.end()));
});

describe('drop pre-GoTrue users migration', () => {
  it('removes users, memberships, prefs, invites and login sessions, and nothing else', async () => {
    const db = await createTestDatabase();
    const sql = postgres({ ...db.admin, max: 1, onnotice: () => {} });
    open.push(sql);
    const t = '2026-10-01T00:00:00.000Z';
    await sql.unsafe(`
      set search_path = catalog;
      insert into users (id, google_sub, email, created_at_utc) values ('u1', 'g1', 'a@b.c', '${t}');
      insert into user_studio_memberships (user_id, studio_id, role) values ('u1', 'st', 'admin');
      insert into user_prefs (user_id) values ('u1');
      insert into team_invites (studio_id, email_norm, invited_by_user_id, invited_at_utc)
        values ('st', 'x@y.z', 'u1', '${t}');
      insert into studio_definitions (id, display_name, created_at_utc) values ('st', 'S', '${t}');
      insert into shows (id, studio_id, name, show_code, created_at_utc)
        values ('sh', 'st', 'N', 'C', '${t}');
      insert into kv (key, value) values ('session:abc', 'u1'), ('csrf:xyz', '1');`);
    const counts = async () => {
      const [r] = await sql.unsafe(`
        select (select count(*) from catalog.users)::int as users,
               (select count(*) from catalog.user_studio_memberships)::int as memberships,
               (select count(*) from catalog.user_prefs)::int as prefs,
               (select count(*) from catalog.team_invites)::int as invites,
               (select count(*) from catalog.kv where key like 'session:%')::int as sessions,
               (select count(*) from catalog.kv where key = 'csrf:xyz')::int as csrf,
               (select count(*) from catalog.studio_definitions where id = 'st')::int as studios,
               (select count(*) from catalog.shows where id = 'sh')::int as shows`);
      return r;
    };
    const migration = readFileSync(MIGRATION, 'utf8');
    const kept = { users: 0, memberships: 0, prefs: 0, invites: 0, sessions: 0, csrf: 1, studios: 1, shows: 1 };
    for (let run = 0; run < 2; run++) {
      await sql.begin((tx) => tx.unsafe(migration));
      expect(await counts(), `run ${run + 1}`).toEqual(kept);
    }
  });
});
