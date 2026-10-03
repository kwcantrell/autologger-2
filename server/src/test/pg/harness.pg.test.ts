// catalog-pg-schema design D6: each test gets its own copy of the migrated template database.
import postgres from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../../test/pg/testDb';

const open: postgres.Sql[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.end()));
});

function connect(db: TestDatabase): postgres.Sql {
  const sql = postgres({ ...db.system, max: 1, onnotice: () => {} });
  open.push(sql);
  return sql;
}

describe('per-test databases', () => {
  let first: string | undefined;

  it('a row written in one test database…', async () => {
    const db = await createTestDatabase();
    first = db.name;
    const sql = connect(db);
    await sql`insert into users (id, google_sub, email, created_at_utc)
              values ('u1', 'sub-1', 'a@example.com', '2026-10-01T00:00:00.000Z')`;
    expect((await sql`select count(*)::int as n from users`)[0]?.n).toBe(1);
  });

  it('…is absent from another', async () => {
    const db = await createTestDatabase();
    expect(db.name).not.toBe(first);
    const sql = connect(db);
    expect((await sql`select count(*)::int as n from users`)[0]?.n).toBe(0);
  });
});
