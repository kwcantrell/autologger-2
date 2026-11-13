// catalog-concurrency-hazards D12: per-team statements need an index led by studio_id, so under
// SERIALIZABLE they lock only the rows they touch (a sequential scan, or a walk of an index led
// by another column, takes the whole table or index), and writes in different teams don't
// conflict.
import postgres from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDatabase } from '../../../../test/pg/testDb';

const open: postgres.Sql[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.end()));
});

describe('team-scoped indexes', () => {
  it.each(['user_studio_memberships', 'shows', 'team_invites'])(
    'catalog.%s has an index whose first column is studio_id',
    async (table) => {
      const db = await createTestDatabase();
      const sql = postgres({ ...db.admin, max: 1, onnotice: () => {} });
      open.push(sql);
      const rows = await sql`
        select i.indexrelid::regclass::text as name
          from pg_index i
          join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
         where i.indrelid = ${`catalog.${table}`}::regclass and a.attname = 'studio_id'`;
      expect(rows.length, `indexes led by studio_id on ${table}`).toBeGreaterThan(0);
    },
  );
});
