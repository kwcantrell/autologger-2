// show-wiki-ai design D1 (catalog-database "Wiki suggestions table", "Wiki suggestions row-level
// security"): `catalog.wiki_suggestions` of `20261022000000_show_wiki_ai.sql`, its keys, checks and
// pending unique indexes, and the catalog_user privileges for the four fixture roles (owner,
// granted member, ungranted member, outsider).
//
// Fixture (policyFixture.ts): shows `s1`, `s2` in team T and `su` in team U; sessions `ss1` (s1),
// `ss2` (s2), `ssu` (su). `owner` accesses s1 and s2, `granted` s1 only, `ungranted` none,
// `outsider` su only. Rows seeded here as catalog_system:
// - pages (revision 1 each): `p1` "Café Noir" and `p1b` "Other" (s1), `p2` (s2), `pu` (su), and
//   `pq` (s2, no revision, so only its suggestion holds it);
// - suggestions: `g1` pending on p1, `g1n` pending new page "Nouveau Café", `g1a` accepted on p1b,
//   `g1d` dismissed new page "Gone", `g1s` superseded on p1 (all s1, session ss1); `g2` pending on
//   p2 and `gq` pending on pq (s2, ss2); `gu` pending on pu (su, ssu).

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../../test/pg/testDb';
import { seedPolicyFixture } from './policyFixture';

const NOW = '2026-10-22T00:00:00.000Z';

type Actor = 'owner' | 'granted' | 'ungranted' | 'outsider';
const ACTORS: Actor[] = ['owner', 'granted', 'ungranted', 'outsider'];
const ACCESSIBLE: Record<Actor, string[]> = {
  owner: ['s1', 's2'],
  granted: ['s1'],
  ungranted: [],
  outsider: ['su'],
};
const SESSION_OF_SHOW: Record<string, string> = { s1: 'ss1', s2: 'ss2', su: 'ssu' };
/** Each fixture suggestion's show. */
const SUGGESTION_SHOW: Record<string, string> = {
  g1: 's1',
  g1n: 's1',
  g1a: 's1',
  g1d: 's1',
  g1s: 's1',
  g2: 's2',
  gq: 's2',
  gu: 'su',
};
/** A pending suggestion of each show, for the update matrix. */
const PENDING_OF_SHOW: Record<string, string> = { s1: 'g1', s2: 'g2', su: 'gu' };

const q = (v: string | number | null) =>
  v === null ? 'null' : typeof v === 'number' ? String(v) : `'${v.replaceAll("'", "''")}'`;

const insertPage = (id: string, show: string, title: string) =>
  `insert into wiki_pages (id, show_id, kind, title, body_md, session_id, revision, created_by,
     created_by_name, created_at_utc, updated_by, updated_by_name, updated_at_utc)
   values (${q(id)}, ${q(show)}, 'topic', ${q(title)}, '', null, 1, 'owner', 'owner Fixture',
     '${NOW}', 'owner', 'owner Fixture', '${NOW}')`;
const insertRevision = (page: string) =>
  `insert into wiki_revisions (page_id, revision, title, kind, body_md, aliases_json,
     author_user_id, author_name, at_utc, note)
   values (${q(page)}, 1, 'T', 'topic', '', '[]'::jsonb, 'owner', 'A', '${NOW}', 'created')`;

interface Sug {
  id: string;
  show: string;
  session?: string;
  page?: string | null;
  base?: number | null;
  kind?: string;
  title?: string;
  body?: string;
  aliases?: string;
  rationale?: string;
  status?: string;
  by?: string;
  resolvedBy?: string | null;
  resolvedAt?: string | null;
  resolvedRev?: number | null;
}
const insertSug = (s: Sug) => {
  const page = s.page ?? null;
  return `insert into wiki_suggestions (id, show_id, session_id, run_id, page_id, base_revision,
     kind, title, body_md, aliases_json, rationale, status, created_by, created_by_name,
     created_at_utc, resolved_by, resolved_by_name, resolved_at_utc, resolved_revision)
   values (${q(s.id)}, ${q(s.show)}, ${q(s.session ?? (SESSION_OF_SHOW[s.show] as string))}, 'run-1',
     ${q(page)}, ${q(s.base === undefined ? (page === null ? null : 1) : s.base)},
     ${q(s.kind ?? 'topic')}, ${q(s.title ?? 'Proposed')}, ${q(s.body ?? 'body')},
     ${q(s.aliases ?? '[]')}::jsonb, ${q(s.rationale ?? 'why')}, ${q(s.status ?? 'pending')},
     ${q(s.by ?? 'owner')}, 'Fixture Name', '${NOW}', ${q(s.resolvedBy ?? null)},
     ${q(s.resolvedBy ? 'Resolver Name' : null)}, ${q(s.resolvedAt ?? null)},
     ${q(s.resolvedRev ?? null)})`;
};
const accepted = (by: string): Partial<Sug> => ({
  status: 'accepted',
  resolvedBy: by,
  resolvedAt: NOW,
  resolvedRev: 2,
});
const dismissed = (by: string): Partial<Sug> => ({
  status: 'dismissed',
  resolvedBy: by,
  resolvedAt: NOW,
});

let db: TestDatabase;
let sys: postgres.Sql;
let app: postgres.Sql;
let admin: postgres.Sql;

beforeAll(async () => {
  db = await createTestDatabase();
  sys = postgres({ ...db.system, max: 1, onnotice: () => {} });
  app = postgres({ ...db.app, max: 1, onnotice: () => {} });
  admin = postgres({ ...db.admin, max: 1, onnotice: () => {} });
  await seedPolicyFixture(sys);
  for (const [id, show, title] of [
    ['p1', 's1', 'Café Noir'],
    ['p1b', 's1', 'Other'],
    ['p2', 's2', 'Person Two'],
    ['pq', 's2', 'Spare Two'],
    ['pu', 'su', 'Show U topic'],
  ] as const) {
    await sys.unsafe(insertPage(id, show, title));
    if (id !== 'pq') await sys.unsafe(insertRevision(id));
  }
  for (const s of [
    { id: 'g1', show: 's1', page: 'p1' },
    { id: 'g1n', show: 's1', title: 'Nouveau Café' },
    { id: 'g1a', show: 's1', page: 'p1b', ...accepted('owner') },
    { id: 'g1d', show: 's1', title: 'Gone', ...dismissed('granted') },
    { id: 'g1s', show: 's1', page: 'p1', status: 'superseded' },
    { id: 'g2', show: 's2', page: 'p2' },
    { id: 'gq', show: 's2', page: 'pq' },
    { id: 'gu', show: 'su', page: 'pu', by: 'outsider' },
  ] as Sug[]) {
    await sys.unsafe(insertSug(s));
  }
});
afterAll(async () => {
  await sys?.end();
  await app?.end();
  await admin?.end();
});

class Rollback extends Error {}
type Outcome = { rows: Record<string, unknown>[] } | { code: string };

/** Runs `stmts` in one transaction that rolls back, as catalog_user bound to `actor`, or as
 * catalog_system when `actor` is null: the last statement's rows, or the first error's code. */
async function asUser(actor: string | null, ...stmts: string[]): Promise<Outcome> {
  let out!: Outcome;
  await app
    .begin(async (tx) => {
      await tx`select set_config('role', ${actor === null ? 'catalog_system' : 'catalog_user'}, true),
                      set_config('app.user_id', ${actor ?? ''}, true)`;
      for (const s of stmts) {
        try {
          out = { rows: [...(await tx.unsafe(s))] };
        } catch (e) {
          out = { code: String((e as { code?: unknown }).code) };
          break;
        }
      }
      throw new Rollback();
    })
    .catch((e) => {
      if (!(e instanceof Rollback)) throw e;
    });
  return out;
}
const codeOf = (o: Outcome) => ('code' in o ? o.code : 'ok');
const keysOf = (o: Outcome) => ('code' in o ? o : { keys: o.rows.map((r) => String(r.k)).sort() });
const countOf = (o: Outcome) => ('code' in o ? o : { count: o.rows.length });

// -- schema ---------------------------------------------------------------------------------------

describe('the suggestions table (catalog-database "Wiki suggestions table")', () => {
  it('has exactly the specified columns and primary key', async () => {
    const cols = await admin`
      select column_name || ' ' || data_type || case when is_nullable = 'NO' then ' not null'
               else '' end as c
      from information_schema.columns
      where table_schema = 'catalog' and table_name = 'wiki_suggestions'
      order by ordinal_position`;
    expect(cols.map((r) => r.c)).toEqual([
      'id text not null',
      'show_id text not null',
      'session_id text not null',
      'run_id text not null',
      'page_id text',
      'base_revision bigint',
      'kind text not null',
      'title text not null',
      'body_md text not null',
      'aliases_json jsonb not null',
      'rationale text not null',
      'status text not null',
      'created_by text not null',
      'created_by_name text not null',
      'created_at_utc text not null',
      'resolved_by text',
      'resolved_by_name text',
      'resolved_at_utc text',
      'resolved_revision bigint',
    ]);
    const [pk] = await admin`
      select array_agg(a.attname order by array_position(i.indkey, a.attnum))::text[] as cols
      from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
      where i.indrelid = 'catalog.wiki_suggestions'::regclass and i.indisprimary`;
    expect(pk?.cols).toEqual(['id']);
  });

  it('has the composite foreign keys, none of them cascading', async () => {
    const fks = await admin`
      select (select array_agg(a.attname order by k.ord)::text[] from unnest(c.conkey)
                with ordinality k(n, ord)
              join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.n) as cols,
             c.confrelid::regclass::text as ref,
             (select array_agg(a.attname order by k.ord)::text[] from unnest(c.confkey)
                with ordinality k(n, ord)
              join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.n) as ref_cols,
             c.confdeltype as on_delete
      from pg_constraint c
      where c.contype = 'f' and c.conrelid = 'catalog.wiki_suggestions'::regclass
      order by 1`;
    expect(
      fks.map(
        (r) =>
          `(${r.cols.join(', ')}) -> ${r.ref} (${r.ref_cols.join(', ')}) on delete ${r.on_delete}`,
      ),
    ).toEqual([
      '(page_id, show_id) -> catalog.wiki_pages (id, show_id) on delete a',
      '(session_id, show_id) -> catalog.sessions (id, show_id) on delete a',
      '(show_id) -> catalog.shows (id) on delete a',
    ]);
  });

  it('has the pending unique indexes', async () => {
    const idx = await admin`
      select pg_get_indexdef(i.indexrelid) as def, pg_get_expr(i.indpred, i.indrelid) as pred
      from pg_index i
      where i.indrelid = 'catalog.wiki_suggestions'::regclass and i.indisunique
        and not i.indisprimary
      order by def`;
    expect(idx).toHaveLength(2);
    const page = idx.find((r) => /\(show_id, page_id\)/.test(r.def));
    const title = idx.find((r) => /\(show_id, catalog\.search_norm\(title\)\)/.test(r.def));
    expect(page?.pred).toMatch(/status = 'pending'.*page_id IS NOT NULL/);
    expect(title?.pred).toMatch(/status = 'pending'.*page_id IS NULL/);
  });

  it('has row-level security and the column-level update grant', async () => {
    const [r] = await admin`
      select relrowsecurity from pg_class where oid = 'catalog.wiki_suggestions'::regclass`;
    expect(r?.relrowsecurity).toBe(true);
    const [t] = await admin`
      select has_table_privilege('catalog_user', 'catalog.wiki_suggestions', 'select') as s,
             has_table_privilege('catalog_user', 'catalog.wiki_suggestions', 'insert') as i,
             has_table_privilege('catalog_user', 'catalog.wiki_suggestions', 'update') as u,
             has_table_privilege('catalog_user', 'catalog.wiki_suggestions', 'delete') as d`;
    expect({ ...t }).toEqual({ s: true, i: true, u: false, d: false });
    const updatable = await admin`
      select column_name as c from information_schema.columns
      where table_schema = 'catalog' and table_name = 'wiki_suggestions'
        and has_column_privilege('catalog_user', 'catalog.wiki_suggestions', column_name, 'update')
      order by ordinal_position`;
    expect(updatable.map((x) => x.c)).toEqual([
      'status',
      'resolved_by',
      'resolved_by_name',
      'resolved_at_utc',
      'resolved_revision',
    ]);
  });

  it('has the four specified policies', async () => {
    const pol = await admin`
      select policyname as n, cmd, roles::text[] as roles from pg_policies
      where schemaname = 'catalog' and tablename = 'wiki_suggestions' order by 1`;
    expect(pol.map((p) => `${p.n} ${p.cmd} ${p.roles.join(',')}`)).toEqual([
      'wiki_suggestions_system_all ALL catalog_system',
      'wiki_suggestions_user_insert INSERT catalog_user',
      'wiki_suggestions_user_select SELECT catalog_user',
      'wiki_suggestions_user_update UPDATE catalog_user',
    ]);
  });
});

// -- the access matrix ----------------------------------------------------------------------------

describe('Ungranted member reads no suggestions (catalog-database "Wiki suggestions row-level security")', () => {
  it('select: each actor sees exactly the rows of its accessible shows', async () => {
    for (const actor of ACTORS) {
      const want = Object.keys(SUGGESTION_SHOW)
        .filter((g) => ACCESSIBLE[actor].includes(SUGGESTION_SHOW[g] as string))
        .sort();
      expect(keysOf(await asUser(actor, 'select id as k from wiki_suggestions')), actor).toEqual({
        keys: want,
      });
    }
  });

  it('insert: allowed exactly into accessible shows', async () => {
    for (const actor of ACTORS) {
      for (const show of ['s1', 's2', 'su']) {
        const want = ACCESSIBLE[actor].includes(show) ? 'ok' : '42501';
        expect(
          codeOf(
            await asUser(actor, insertSug({ id: 'new', show, title: 'Brand new', by: actor })),
          ),
          `${actor} into ${show}`,
        ).toBe(want);
      }
    }
  });

  it('update: pending rows of accessible shows only', async () => {
    for (const actor of ACTORS) {
      for (const show of ['s1', 's2', 'su']) {
        const id = PENDING_OF_SHOW[show] as string;
        expect(
          countOf(
            await asUser(
              actor,
              `update wiki_suggestions set status = 'superseded' where id = '${id}' returning 1`,
            ),
          ),
          `${actor} on ${show}`,
        ).toEqual({ count: ACCESSIBLE[actor].includes(show) ? 1 : 0 });
      }
    }
  });

  it('catalog_system reads, rewrites and deletes every row', async () => {
    expect(countOf(await asUser(null, 'select 1 from wiki_suggestions'))).toEqual({ count: 8 });
    expect(
      countOf(await asUser(null, `update wiki_suggestions set body_md = 'x' returning 1`)),
    ).toEqual({ count: 8 });
    expect(countOf(await asUser(null, 'delete from wiki_suggestions returning 1'))).toEqual({
      count: 8,
    });
  });
});

describe('Suggestions are never deleted by users', () => {
  it('delete as catalog_user gives 42501, for every actor', async () => {
    for (const actor of ACTORS) {
      expect(
        codeOf(await asUser(actor, `delete from wiki_suggestions where id = 'g1'`)),
        actor,
      ).toBe('42501');
    }
  });
});

describe("A checked suggestion can't be rewritten", () => {
  it('updating a proposal or author column as catalog_user gives 42501', async () => {
    for (const set of [
      `body_md = 'forged'`,
      `title = 'forged'`,
      `aliases_json = '["forged"]'::jsonb`,
      `page_id = 'p1b'`,
      `base_revision = 2`,
      `rationale = 'forged'`,
      `created_by = 'granted'`,
    ]) {
      expect(
        codeOf(await asUser('granted', `update wiki_suggestions set ${set} where id = 'g1'`)),
        set,
      ).toBe('42501');
    }
    const [r] = await sys`select body_md from wiki_suggestions where id = 'g1'`;
    expect(r?.body_md).toBe('body');
  });
});

describe("A resolved suggestion can't be reopened", () => {
  it('setting an accepted, dismissed or superseded row to pending or another status updates no row', async () => {
    for (const id of ['g1a', 'g1d', 'g1s']) {
      for (const set of [
        `status = 'pending', resolved_by = null, resolved_by_name = null, resolved_at_utc = null,
           resolved_revision = null`,
        `status = 'superseded', resolved_by = null, resolved_by_name = null,
           resolved_at_utc = null, resolved_revision = null`,
        `status = 'dismissed', resolved_by = 'owner', resolved_at_utc = '${NOW}',
           resolved_revision = null`,
        `status = 'accepted', resolved_by = 'owner', resolved_at_utc = '${NOW}',
           resolved_revision = 3`,
      ]) {
        expect(
          countOf(
            await asUser(
              'owner',
              `update wiki_suggestions set ${set} where id = '${id}' returning 1`,
            ),
          ),
          `${id}: ${set}`,
        ).toEqual({ count: 0 });
      }
    }
  });

  it('a pending row can not be updated to pending', async () => {
    expect(
      codeOf(
        await asUser('owner', `update wiki_suggestions set status = 'pending' where id = 'g1'`),
      ),
    ).toBe('42501');
  });
});

describe('Suggestions carry their real author', () => {
  const resolve = (actor: string, set: string) =>
    asUser(actor, `update wiki_suggestions set ${set} where id = 'g1' returning 1`);

  it("an insert with another user's created_by is refused", async () => {
    expect(
      codeOf(await asUser('granted', insertSug({ id: 'x', show: 's1', title: 'N', by: 'owner' }))),
    ).toBe('42501');
    expect(
      codeOf(
        await asUser('granted', insertSug({ id: 'x', show: 's1', title: 'N', by: 'granted' })),
      ),
    ).toBe('ok');
  });

  it("an insert that isn't pending is refused", async () => {
    for (const extra of [accepted('granted'), dismissed('granted'), { status: 'superseded' }]) {
      expect(
        codeOf(
          await asUser(
            'granted',
            insertSug({ id: 'x', show: 's1', page: 'p1b', by: 'granted', ...extra }),
          ),
        ),
        String(extra.status),
      ).toBe('42501');
    }
  });

  it("an accept or dismiss with another user's resolved_by is refused; with one's own it is allowed", async () => {
    const acc = (by: string) =>
      `status = 'accepted', resolved_by = '${by}', resolved_by_name = 'N',
         resolved_at_utc = '${NOW}', resolved_revision = 2`;
    const dis = (by: string) =>
      `status = 'dismissed', resolved_by = '${by}', resolved_by_name = 'N',
         resolved_at_utc = '${NOW}'`;
    expect(codeOf(await resolve('granted', acc('owner')))).toBe('42501');
    expect(codeOf(await resolve('granted', dis('owner')))).toBe('42501');
    expect(countOf(await resolve('granted', acc('granted')))).toEqual({ count: 1 });
    expect(countOf(await resolve('granted', dis('granted')))).toEqual({ count: 1 });
  });

  it('superseded with no resolver is allowed', async () => {
    expect(countOf(await resolve('granted', `status = 'superseded'`))).toEqual({ count: 1 });
  });
});

// -- composite keys -------------------------------------------------------------------------------

describe('suggestions stay in one show (composite foreign keys)', () => {
  it('Suggestion for a page in another show: refused by the foreign key, for the system and for a user of both shows', async () => {
    const wrong = insertSug({ id: 'x', show: 's2', page: 'p1' });
    expect(codeOf(await asUser('owner', wrong))).toBe('23503');
    expect(codeOf(await asUser(null, wrong))).toBe('23503');
    expect(codeOf(await asUser('owner', insertSug({ id: 'x', show: 's1', page: 'p1b' })))).toBe(
      'ok',
    );
  });

  it('a session from another show is refused by the foreign key', async () => {
    const wrong = insertSug({ id: 'x', show: 's2', session: 'ss1', title: 'N' });
    expect(codeOf(await asUser('owner', wrong))).toBe('23503');
    expect(codeOf(await asUser(null, wrong))).toBe('23503');
  });

  it('nothing cascades: a show, session or page with suggestions can not be deleted', async () => {
    expect(codeOf(await asUser(null, `delete from wiki_pages where id = 'pq'`))).toBe('23503');
    expect(
      codeOf(
        await asUser(
          null,
          `delete from wiki_suggestions where id = 'gq'`,
          `delete from wiki_pages where id = 'pq'`,
        ),
      ),
    ).toBe('ok');
    expect(
      codeOf(
        await asUser(
          null,
          `delete from wiki_suggestions where id = 'g2'`,
          `delete from wiki_revisions where page_id = 'p2'`,
          `delete from wiki_pages where id = 'p2'`,
          `delete from sessions where id = 'ss2'`,
        ),
      ),
    ).toBe('23503');
    expect(
      codeOf(
        await asUser(
          null,
          `delete from wiki_suggestions where show_id = 's2'`,
          `delete from sessions where id = 'ss2'`,
        ),
      ),
    ).toBe('ok');
  });
});

// -- pending uniqueness ---------------------------------------------------------------------------

describe('one pending suggestion per target', () => {
  it('Two pending suggestions for one page: refused by the unique index', async () => {
    expect(codeOf(await asUser('owner', insertSug({ id: 'x', show: 's1', page: 'p1' })))).toBe(
      '23505',
    );
    expect(codeOf(await asUser(null, insertSug({ id: 'x', show: 's1', page: 'p1' })))).toBe(
      '23505',
    );
  });

  it('two pending new-page suggestions whose titles match ignoring case and accents: refused', async () => {
    for (const title of ['nouveau cafe', 'NOUVEAU CAFÉ', 'Nouveau Café']) {
      expect(codeOf(await asUser('owner', insertSug({ id: 'x', show: 's1', title }))), title).toBe(
        '23505',
      );
    }
    // Another show, or a different title, is no clash.
    expect(
      codeOf(await asUser('owner', insertSug({ id: 'x', show: 's2', title: 'nouveau cafe' }))),
    ).toBe('ok');
    expect(
      codeOf(await asUser('owner', insertSug({ id: 'x', show: 's1', title: 'Cafe Neuf' }))),
    ).toBe('ok');
  });

  it('a pending plus a superseded one is allowed; superseding frees the target', async () => {
    // g1s (superseded) already sits beside g1 (pending) on p1.
    expect(
      codeOf(
        await asUser(null, insertSug({ id: 'x', show: 's1', page: 'p1', status: 'superseded' })),
      ),
    ).toBe('ok');
    expect(
      codeOf(
        await asUser(
          'owner',
          `update wiki_suggestions set status = 'superseded' where id = 'g1'`,
          insertSug({ id: 'x', show: 's1', page: 'p1' }),
        ),
      ),
    ).toBe('ok');
    expect(
      codeOf(
        await asUser(
          'owner',
          `update wiki_suggestions set status = 'superseded' where id = 'g1n'`,
          insertSug({ id: 'x', show: 's1', title: 'nouveau cafe' }),
        ),
      ),
    ).toBe('ok');
    // A resolved new-page suggestion holds no title either.
    expect(codeOf(await asUser('owner', insertSug({ id: 'x', show: 's1', title: 'gone' })))).toBe(
      'ok',
    );
  });
});

// -- checks ---------------------------------------------------------------------------------------

describe('checks', () => {
  const sug = (o: Partial<Sug>) => insertSug({ id: 'x', show: 's2', title: 'Fresh', ...o });

  it('page_id and base_revision are both null or both set', async () => {
    expect(codeOf(await asUser(null, sug({ page: 'pq', base: null })))).toBe('23514');
    expect(codeOf(await asUser(null, sug({ page: null, base: 1 })))).toBe('23514');
    expect(codeOf(await asUser(null, sug({ page: null, base: null })))).toBe('ok');
    expect(codeOf(await asUser(null, sug({ page: 'p2', base: 1, status: 'superseded' })))).toBe(
      'ok',
    );
  });

  it('status is one of pending, accepted, dismissed, superseded', async () => {
    expect(codeOf(await asUser(null, sug({ status: 'pending' })))).toBe('ok');
    expect(codeOf(await asUser(null, sug({ status: 'superseded' })))).toBe('ok');
    expect(codeOf(await asUser(null, sug(accepted('owner'))))).toBe('ok');
    expect(codeOf(await asUser(null, sug(dismissed('owner'))))).toBe('ok');
    expect(codeOf(await asUser(null, sug({ status: 'rejected' })))).toBe('23514');
  });

  it('kind is one of person, topic, bit, session', async () => {
    for (const kind of ['person', 'topic', 'bit', 'session']) {
      expect(codeOf(await asUser(null, sug({ kind }))), kind).toBe('ok');
    }
    expect(codeOf(await asUser(null, sug({ kind: 'villain' })))).toBe('23514');
  });

  it('title is 1-200 characters after trimming; body at most 100000; rationale at most 500', async () => {
    expect(codeOf(await asUser(null, sug({ title: '' })))).toBe('23514');
    expect(codeOf(await asUser(null, sug({ title: '   ' })))).toBe('23514');
    expect(codeOf(await asUser(null, sug({ title: 'x'.repeat(201) })))).toBe('23514');
    expect(codeOf(await asUser(null, sug({ title: 'é'.repeat(200) })))).toBe('ok');
    expect(codeOf(await asUser(null, sug({ title: ` ${'x'.repeat(200)} ` })))).toBe('ok');
    expect(codeOf(await asUser(null, sug({ body: 'é'.repeat(100000) })))).toBe('ok');
    expect(codeOf(await asUser(null, sug({ body: 'x'.repeat(100001) })))).toBe('23514');
    expect(codeOf(await asUser(null, sug({ rationale: 'é'.repeat(500) })))).toBe('ok');
    expect(codeOf(await asUser(null, sug({ rationale: 'x'.repeat(501) })))).toBe('23514');
  });

  it('resolved_by and resolved_at_utc are set exactly when accepted or dismissed; resolved_revision exactly when accepted', async () => {
    for (const [what, o] of [
      ['pending with a resolver', { resolvedBy: 'owner', resolvedAt: NOW }],
      [
        'superseded with a resolver',
        { status: 'superseded', resolvedBy: 'owner', resolvedAt: NOW },
      ],
      ['pending with a revision', { resolvedRev: 2 }],
      ['accepted without resolved_by', { ...accepted('owner'), resolvedBy: null }],
      ['accepted without resolved_at_utc', { ...accepted('owner'), resolvedAt: null }],
      ['accepted without resolved_revision', { ...accepted('owner'), resolvedRev: null }],
      ['dismissed without resolved_by', { ...dismissed('owner'), resolvedBy: null }],
      ['dismissed without resolved_at_utc', { ...dismissed('owner'), resolvedAt: null }],
      ['dismissed with a revision', { ...dismissed('owner'), resolvedRev: 2 }],
    ] as [string, Partial<Sug>][]) {
      expect(codeOf(await asUser(null, sug(o))), what).toBe('23514');
    }
  });
});
