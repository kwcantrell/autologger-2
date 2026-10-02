// show-grants D1: catalog.show_grants, keyed (user_id, show_id), cascading from users and shows.
import postgres from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDatabase } from '../../../../test/pg/testDb';

const T = '2026-10-05T00:00:00.000Z';

const open: postgres.Sql[] = [];
function connect(o: postgres.Options<Record<string, never>>): postgres.Sql {
  const sql = postgres({ ...o, max: 1, onnotice: () => {} });
  open.push(sql);
  return sql;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.end()));
});

/** An app-role connection with users U and V and shows A and B in team `st`. */
async function seeded(): Promise<postgres.Sql> {
  const db = await createTestDatabase();
  const sql = connect(db.app);
  for (const id of ['U', 'V']) {
    await sql`insert into users (id, google_sub, email, created_at_utc)
              values (${id}, ${`g-${id}`}, ${`${id}@example.com`}, ${T})`;
  }
  for (const id of ['A', 'B']) {
    await sql`insert into shows (id, studio_id, name, show_code, created_at_utc)
              values (${id}, 'st', ${id}, ${id}, ${T})`;
  }
  return sql;
}

async function grants(sql: postgres.Sql): Promise<string[]> {
  const rows = await sql`select user_id, show_id from show_grants order by user_id, show_id`;
  return rows.map((r) => `${r.user_id}:${r.show_id}`);
}

describe('catalog.show_grants (show-grants D1)', () => {
  it('inserts a grant with can_write = 1 by default', async () => {
    const sql = await seeded();
    await sql`insert into show_grants (user_id, show_id, granted_by_user_id, granted_at_utc)
              values ('U', 'A', 'V', ${T})`;
    const rows = await sql`select can_write::int as w, granted_by_user_id, granted_at_utc
                           from show_grants where user_id = 'U' and show_id = 'A'`;
    expect(rows.map((r) => ({ ...r }))).toEqual([
      { w: 1, granted_by_user_id: 'V', granted_at_utc: T },
    ]);
  });

  it('refuses a second grant for the same (user, show) with 23505', async () => {
    const sql = await seeded();
    await sql`insert into show_grants (user_id, show_id, granted_at_utc) values ('U', 'A', ${T})`;
    await expect(
      sql`insert into show_grants (user_id, show_id, granted_at_utc) values ('U', 'A', ${T})`,
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('refuses a grant naming a missing user or a missing show with 23503', async () => {
    const sql = await seeded();
    await expect(
      sql`insert into show_grants (user_id, show_id, granted_at_utc) values ('nobody', 'A', ${T})`,
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      sql`insert into show_grants (user_id, show_id, granted_at_utc) values ('U', 'nope', ${T})`,
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('cascades a show delete to its grants only, and a user delete to the rest', async () => {
    const sql = await seeded();
    for (const [u, s] of [
      ['U', 'A'],
      ['U', 'B'],
      ['V', 'A'],
    ]) {
      await sql`insert into show_grants (user_id, show_id, granted_at_utc) values (${u}, ${s}, ${T})`;
    }
    await sql`delete from shows where id = 'A'`;
    expect(await grants(sql)).toEqual(['U:B']);
    await sql`delete from users where id = 'U'`;
    expect(await grants(sql)).toEqual([]);
  });
});
