// catalog-policies design D1, D7, D10: the seven SECURITY DEFINER policy helpers and the settings
// backfill of `20261007000000_catalog_policies.sql`. Each helper returns exactly its set (or
// boolean) for each fixture actor, an unknown id and null, called as `catalog_user`; each is a
// definer function owned by `postgres` with a pinned `search_path` and `enable_seqscan = off`,
// executable by `catalog_user` only. The backfill gives every team without a settings row the
// server's default shape, with fresh category ids, and leaves stored rows alone.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defaultSettingsBlob, validateSettingsBlob } from '@autologger/domain';
import postgres from 'postgres';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type ConnOptions, createTestDatabase, type TestDatabase } from '../../../../test/pg/testDb';
import { seedPolicyFixture, T, U, V } from './policyFixture';

const MIGRATION = resolve(
  import.meta.dirname,
  '../../../../supabase/migrations/20261007000000_catalog_policies.sql',
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

const SET_HELPERS = [
  'member_studios',
  'manager_studios',
  'accessible_shows',
  'member_shows',
  'co_members',
] as const;
const HELPERS = [
  ...SET_HELPERS.map((h) => `catalog.${h}(text)`),
  'catalog.studio_exists(text)',
  'catalog.show_exists(text)',
];

const CO_T = ['admin', 'granted', 'owner', 'ungranted'];
/** The expected set per helper and caller (`null` is a call with a null id). */
const EXPECTED: Record<(typeof SET_HELPERS)[number], Record<string, string[]>> = {
  member_studios: {
    owner: [T, V],
    admin: [T],
    granted: [T],
    ungranted: [T],
    outsider: [U],
    unknown: [],
    null: [],
  },
  manager_studios: {
    owner: [T, V],
    admin: [T],
    granted: [],
    ungranted: [],
    outsider: [U],
    unknown: [],
    null: [],
  },
  accessible_shows: {
    owner: ['s1', 's2'],
    admin: ['s1', 's2'],
    granted: ['s1'],
    ungranted: [],
    outsider: ['su'],
    unknown: [],
    null: [],
  },
  member_shows: {
    owner: ['s1', 's2'],
    admin: ['s1', 's2'],
    granted: ['s1', 's2'],
    ungranted: ['s1', 's2'],
    outsider: ['su'],
    unknown: [],
    null: [],
  },
  co_members: {
    owner: CO_T,
    admin: CO_T,
    granted: CO_T,
    ungranted: CO_T,
    outsider: ['outsider'],
    unknown: [],
    null: [],
  },
};

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
  const sys = connect(db.system);
  await seedPolicyFixture(sys);
});

/** Run one statement as `catalog_user` in a transaction that rolls back. */
async function asUser<T>(uid: string | null, q: (sql: postgres.TransactionSql) => Promise<T>) {
  const sql = connect(db.app);
  let out!: T;
  await sql
    .begin(async (tx) => {
      await tx`select set_config('role', 'catalog_user', true),
                      set_config('app.user_id', ${uid ?? ''}, true)`;
      out = await q(tx);
      throw new Rollback();
    })
    .catch((e) => {
      if (!(e instanceof Rollback)) throw e;
    });
  return out;
}
class Rollback extends Error {}

describe('the policy helpers (catalog-policies D1)', () => {
  for (const helper of SET_HELPERS) {
    it(`${helper} returns exactly its set for each caller`, async () => {
      for (const [who, want] of Object.entries(EXPECTED[helper])) {
        const uid = who === 'null' ? null : who === 'unknown' ? 'no-such-user' : who;
        const rows = await asUser('owner', (tx) =>
          tx.unsafe(`select distinct x as id from catalog.${helper}($1) x order by 1`, [uid]),
        );
        expect(
          rows.map((r) => r.id),
          `${helper}(${who})`,
        ).toEqual([...want].sort());
      }
    });
  }

  it('studio_exists and show_exists see every row and nothing else', async () => {
    for (const [fn, id, want] of [
      ['studio_exists', T, true],
      ['studio_exists', U, true],
      ['studio_exists', 'no-such-team', false],
      ['show_exists', 's1', true],
      ['show_exists', 'su', true],
      ['show_exists', 'no-such-show', false],
    ] as const) {
      // Called by `outsider`, who is not a member of T: the answer is still the row's existence.
      const [r] = await asUser('outsider', (tx) =>
        tx.unsafe(`select catalog.${fn}($1) as e`, [id]),
      );
      expect(r?.e, `${fn}(${id})`).toBe(want);
    }
  });

  it('are SECURITY DEFINER, owned by postgres, with a pinned search_path and no seq scans', async () => {
    const sql = connect(db.admin);
    for (const f of HELPERS) {
      const [r] = await sql`select p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) as owner
                            from pg_proc p where p.oid = ${f}::regprocedure`;
      expect(r?.prosecdef, f).toBe(true);
      expect(r?.owner, f).toBe('postgres');
      expect(r?.proconfig, f).toEqual(
        expect.arrayContaining(['search_path=pg_catalog, pg_temp', 'enable_seqscan=off']),
      );
    }
  });

  it('are executable by catalog_user only', async () => {
    const sql = connect(db.admin);
    for (const f of HELPERS) {
      for (const [role, can] of [
        ['public', false],
        ['catalog_system', false],
        ['autologger_app', false],
        ['anon', false],
        ['authenticated', false],
        ['service_role', false],
        ['catalog_user', true],
      ] as const) {
        const [r] = await sql`select has_function_privilege(${role}, ${f}, 'execute') as x`;
        expect(r?.x, `${role} on ${f}`).toBe(can);
      }
    }
  });
});

/** The text between `-- backfill:begin` and `-- backfill:end` in the migration (design D7). */
function backfillBlock(): string {
  const block = /-- backfill:begin\n([\s\S]*?)-- backfill:end/.exec(
    readFileSync(MIGRATION, 'utf8'),
  )?.[1];
  if (!block) throw new Error('no backfill block in the migration');
  return block;
}

type Blob = { categories: { id: string }[] } & Record<string, unknown>;
const withoutIds = (b: Blob) => ({ ...b, categories: b.categories.map(({ id: _, ...c }) => c) });
const defaultBlob = () => defaultSettingsBlob('x') as unknown as Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('the settings backfill (catalog-policies D7)', () => {
  it("stores the server's default shape for the seed teams, with distinct fresh ids", async () => {
    const fresh = await createTestDatabase();
    const sql = connect(fresh.admin);
    const want = withoutIds(
      validateSettingsBlob(defaultBlob(), 'x', () => true) as unknown as Blob,
    );
    const ids: string[] = [];
    for (const team of ['test-studios', 'test-studio-2']) {
      const rows = await sql`select value from catalog.app_settings
                             where key = ${`studio_config:${team}`}`;
      expect(rows, team).toHaveLength(1);
      const blob = JSON.parse(String(rows[0]?.value)) as Blob;
      expect(withoutIds(blob), team).toEqual(want);
      for (const c of blob.categories) {
        expect(c.id).toMatch(UUID);
        ids.push(c.id);
      }
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('adds a row for a team without one and leaves a stored row unchanged', async () => {
    const fresh = await createTestDatabase();
    const sql = connect(fresh.admin);
    await sql`insert into catalog.studio_definitions (id, display_name, created_at_utc)
              values ('bf-none', 'No row', '2026-10-03'), ('bf-kept', 'Kept', '2026-10-03')`;
    await sql`insert into catalog.app_settings (key, value) values ('studio_config:bf-kept', '{"x":1}')`;
    await sql.unsafe(backfillBlock());
    const rows = await sql`select key, value from catalog.app_settings
                           where key in ('studio_config:bf-none', 'studio_config:bf-kept')
                           order by key`;
    expect(rows.map((r) => r.key)).toEqual(['studio_config:bf-kept', 'studio_config:bf-none']);
    expect(rows[0]?.value).toBe('{"x":1}');
    const blob = JSON.parse(String(rows[1]?.value)) as Blob;
    expect(withoutIds(blob)).toEqual(
      withoutIds(validateSettingsBlob(defaultBlob(), 'x', () => true) as unknown as Blob),
    );
  });
});
