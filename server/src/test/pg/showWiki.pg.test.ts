// show-wiki design D1, D2 (catalog-database "Wiki tables", "Wiki row-level security"): the three
// wiki tables of `20261021000000_show_wiki.sql`, their keys, checks and live-name indexes, the
// `sessions (id, show_id)` key the composite foreign keys point at, and the catalog_user access
// matrix for the four fixture roles (owner, granted member, ungranted member, outsider).
//
// Fixture (policyFixture.ts): shows `s1`, `s2` in team T and `su` in team U; sessions `ss1` (s1),
// `ss2` (s2), `ssu` (su). `owner` accesses s1 and s2, `granted` s1 only, `ungranted` none,
// `outsider` su only. Wiki rows seeded here as catalog_system:
// - pages: `p1` "Café Noir" (topic, s1), `p1b` "Other" (topic, s1), `pdel` "Spare" (bit, s1, no
//   aliases or revisions, so it can be deleted), `ps1` (session page of ss1, s1), `p2` (person, s2),
//   `pu` (topic, su);
// - aliases: `Noir` (p1), `Two` (p2), `You` (pu);
// - revisions: revision 1 of p1, p1b, ps1, p2 and pu.

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../../test/pg/testDb';
import { seedPolicyFixture } from './policyFixture';

const NOW = '2026-10-21T00:00:00.000Z';
const WIKI_TABLES = ['wiki_pages', 'wiki_aliases', 'wiki_revisions'] as const;

type Actor = 'owner' | 'granted' | 'ungranted' | 'outsider';
const ACTORS: Actor[] = ['owner', 'granted', 'ungranted', 'outsider'];
const ACCESSIBLE: Record<Actor, string[]> = {
  owner: ['s1', 's2'],
  granted: ['s1'],
  ungranted: [],
  outsider: ['su'],
};
/** Each fixture page's show. */
const PAGE_SHOW: Record<string, string> = {
  p1: 's1',
  p1b: 's1',
  pdel: 's1',
  ps1: 's1',
  p2: 's2',
  pu: 'su',
};
/** A page of each show, for alias and revision writes. */
const PAGE_OF_SHOW: Record<string, string> = { s1: 'p1', s2: 'p2', su: 'pu' };
const ALIASES: Record<string, string> = { Noir: 'p1', Two: 'p2', You: 'pu' };
const REVISIONS = ['p1', 'p1b', 'ps1', 'p2', 'pu'];

const q = (v: string | null) => (v === null ? 'null' : `'${v.replaceAll("'", "''")}'`);

interface PageRow {
  id: string;
  show: string;
  kind: string;
  title: string;
  session?: string | null;
  body?: string;
  merged?: string | null;
  deleted?: string | null;
}
const insertPage = (p: PageRow) =>
  `insert into wiki_pages (id, show_id, kind, title, body_md, session_id, revision, merged_into,
     deleted_at_utc, created_by, created_by_name, created_at_utc, updated_by, updated_by_name,
     updated_at_utc)
   values (${q(p.id)}, ${q(p.show)}, ${q(p.kind)}, ${q(p.title)}, ${q(p.body ?? '')},
     ${q(p.session ?? null)}, 1, ${q(p.merged ?? null)}, ${q(p.deleted ?? null)}, 'owner',
     'owner Fixture', '${NOW}', 'owner', 'owner Fixture', '${NOW}')`;
const insertAlias = (page: string, show: string, alias: string) =>
  `insert into wiki_aliases (page_id, show_id, alias) values (${q(page)}, ${q(show)}, ${q(alias)})`;
const insertRevision = (page: string, revision: number, author: string) =>
  `insert into wiki_revisions (page_id, revision, title, kind, body_md, aliases_json,
     author_user_id, author_name, at_utc, note)
   values (${q(page)}, ${revision}, 'T', 'topic', '', '[]'::jsonb, ${q(author)}, 'A', '${NOW}',
     'created')`;

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
  for (const p of [
    { id: 'p1', show: 's1', kind: 'topic', title: 'Café Noir' },
    { id: 'p1b', show: 's1', kind: 'topic', title: 'Other' },
    { id: 'pdel', show: 's1', kind: 'bit', title: 'Spare' },
    { id: 'ps1', show: 's1', kind: 'session', title: 'Session ss1', session: 'ss1' },
    { id: 'p2', show: 's2', kind: 'person', title: 'Person Two' },
    { id: 'pu', show: 'su', kind: 'topic', title: 'Show U topic' },
  ]) {
    await sys.unsafe(insertPage(p));
  }
  for (const [alias, page] of Object.entries(ALIASES)) {
    await sys.unsafe(insertAlias(page, PAGE_SHOW[page] as string, alias));
  }
  for (const page of REVISIONS) await sys.unsafe(insertRevision(page, 1, 'owner'));
});
afterAll(async () => {
  await sys?.end();
  await app?.end();
  await admin?.end();
});

class Rollback extends Error {}
type Outcome = { rows: Record<string, unknown>[] } | { code: string };

/** Runs `stmts` in one transaction that rolls back: as catalog_user bound to `actor`, or as
 * catalog_system when `actor` is null. The last statement's rows, or the first error's code. */
async function run(actor: string | null, ...stmts: string[]): Promise<Outcome> {
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
/** 'ok' or the error code. */
const codeOf = (o: Outcome) => ('code' in o ? o.code : 'ok');
const keysOf = (o: Outcome) => ('code' in o ? o : { keys: o.rows.map((r) => String(r.k)).sort() });
const countOf = (o: Outcome) => ('code' in o ? o : { count: o.rows.length });

// -- schema ---------------------------------------------------------------------------------------

describe('the wiki tables (catalog-database "Wiki tables")', () => {
  it('have exactly the specified columns and primary keys', async () => {
    const columns = async (t: string) =>
      (
        await admin`select column_name || ' ' || data_type || case when is_nullable = 'NO'
                             then ' not null' else '' end as c
                    from information_schema.columns
                    where table_schema = 'catalog' and table_name = ${t} order by ordinal_position`
      ).map((r) => r.c);
    expect(await columns('wiki_pages')).toEqual([
      'id text not null',
      'show_id text not null',
      'kind text not null',
      'title text not null',
      'body_md text not null',
      'session_id text',
      'revision bigint not null',
      'merged_into text',
      'deleted_at_utc text',
      'created_by text not null',
      'created_by_name text not null',
      'created_at_utc text not null',
      'updated_by text not null',
      'updated_by_name text not null',
      'updated_at_utc text not null',
    ]);
    expect(await columns('wiki_aliases')).toEqual([
      'page_id text not null',
      'show_id text not null',
      'alias text not null',
    ]);
    expect(await columns('wiki_revisions')).toEqual([
      'page_id text not null',
      'revision bigint not null',
      'title text not null',
      'kind text not null',
      'body_md text not null',
      'aliases_json jsonb not null',
      'author_user_id text not null',
      'author_name text not null',
      'at_utc text not null',
      'note text',
    ]);
    const [pk] = await admin`
      select array_agg(a.attname order by array_position(i.indkey, a.attnum))::text[] as cols
      from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
      where i.indrelid = 'catalog.wiki_revisions'::regclass and i.indisprimary`;
    expect(pk?.cols).toEqual(['page_id', 'revision']);
  });

  it('have the composite keys and foreign keys, none of them cascading', async () => {
    const constraints = await admin`
      select c.conrelid::regclass::text as tbl, c.contype as type,
             (select array_agg(a.attname order by k.ord)::text[] from unnest(c.conkey)
                with ordinality k(n, ord)
              join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.n) as cols,
             c.confrelid::regclass::text as ref,
             (select array_agg(a.attname order by k.ord)::text[] from unnest(c.confkey)
                with ordinality k(n, ord)
              join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.n) as ref_cols,
             c.confdeltype as on_delete
      from pg_constraint c
      where c.contype in ('u', 'f')
        and c.conrelid in ('catalog.wiki_pages'::regclass, 'catalog.wiki_aliases'::regclass,
                           'catalog.wiki_revisions'::regclass, 'catalog.sessions'::regclass)
      order by 1, 2, 3`;
    expect(
      constraints.map((r) =>
        r.type === 'u'
          ? `${r.tbl} unique (${r.cols.join(', ')})`
          : `${r.tbl} (${r.cols.join(', ')}) -> ${r.ref} (${r.ref_cols.join(', ')}) on delete ${r.on_delete}`,
      ),
    ).toEqual([
      'catalog.sessions (show_id) -> catalog.shows (id) on delete a',
      'catalog.sessions unique (id, show_id)',
      'catalog.wiki_aliases (page_id, show_id) -> catalog.wiki_pages (id, show_id) on delete a',
      'catalog.wiki_pages (merged_into, show_id) -> catalog.wiki_pages (id, show_id) on delete a',
      'catalog.wiki_pages (session_id, show_id) -> catalog.sessions (id, show_id) on delete a',
      'catalog.wiki_pages (show_id) -> catalog.shows (id) on delete a',
      'catalog.wiki_pages unique (id, show_id)',
      'catalog.wiki_revisions (page_id) -> catalog.wiki_pages (id) on delete a',
    ]);
  });

  it('have the live-name unique indexes', async () => {
    const idx = await admin`
      select c.relname as tbl, pg_get_indexdef(i.indexrelid) as def,
             pg_get_expr(i.indpred, i.indrelid) as pred
      from pg_index i join pg_class c on c.oid = i.indrelid
      where c.relnamespace = 'catalog'::regnamespace and c.relname like 'wiki\\_%'
        and i.indisunique and not i.indisprimary
        and not exists (select 1 from pg_constraint k where k.conindid = i.indexrelid)
      order by def`;
    const live = /merged_into IS NULL.*deleted_at_utc IS NULL/;
    const byTable = (t: string) => idx.filter((r) => r.tbl === t);
    expect(
      byTable('wiki_aliases').map((r) => [
        /\(show_id, catalog\.search_norm\(alias\)\)/.test(r.def),
        r.pred,
      ]),
    ).toEqual([[true, null]]);
    const pages = byTable('wiki_pages');
    expect(pages).toHaveLength(2);
    expect(
      pages.every((r) => live.test(String(r.pred))),
      JSON.stringify(pages),
    ).toBe(true);
    expect(pages.some((r) => /\(show_id, session_id\)/.test(r.def))).toBe(true);
    expect(pages.some((r) => /\(show_id, catalog\.search_norm\(title\)\)/.test(r.def))).toBe(true);
  });

  it('have row-level security', async () => {
    for (const t of WIKI_TABLES) {
      const [r] =
        await admin`select relrowsecurity from pg_class where oid = ${`catalog.${t}`}::regclass`;
      expect(r?.relrowsecurity, t).toBe(true);
    }
  });
});

// -- the access matrix ----------------------------------------------------------------------------

describe('Ungranted member reads no wiki rows (catalog-database "Wiki row-level security")', () => {
  it('select: each actor sees exactly the rows of its accessible shows', async () => {
    for (const actor of ACTORS) {
      const shows = ACCESSIBLE[actor];
      const pages = Object.keys(PAGE_SHOW).filter((p) => shows.includes(PAGE_SHOW[p] as string));
      expect(keysOf(await run(actor, 'select id as k from wiki_pages')), `pages ${actor}`).toEqual({
        keys: [...pages].sort(),
      });
      expect(
        keysOf(await run(actor, 'select alias as k from wiki_aliases')),
        `aliases ${actor}`,
      ).toEqual({
        keys: Object.keys(ALIASES)
          .filter((a) => shows.includes(PAGE_SHOW[ALIASES[a] as string] as string))
          .sort(),
      });
      expect(
        keysOf(await run(actor, 'select page_id as k from wiki_revisions')),
        `revisions ${actor}`,
      ).toEqual({ keys: REVISIONS.filter((p) => pages.includes(p)).sort() });
    }
  });

  it('insert: allowed exactly into accessible shows, on all three tables', async () => {
    for (const actor of ACTORS) {
      for (const show of ['s1', 's2', 'su']) {
        const want = ACCESSIBLE[actor].includes(show) ? 'ok' : '42501';
        const page = PAGE_OF_SHOW[show] as string;
        const who = `${actor} into ${show}`;
        expect(
          codeOf(
            await run(
              actor,
              insertPage({ id: `new-${show}`, show, kind: 'topic', title: 'Brand new' }),
            ),
          ),
          `page ${who}`,
        ).toBe(want);
        expect(
          codeOf(await run(actor, insertAlias(page, show, 'Brand new alias'))),
          `alias ${who}`,
        ).toBe(want);
        expect(codeOf(await run(actor, insertRevision(page, 99, actor))), `revision ${who}`).toBe(
          want,
        );
      }
    }
  });

  it('update: pages and aliases of accessible shows only; revisions refused to everyone', async () => {
    for (const actor of ACTORS) {
      const canS1 = ACCESSIBLE[actor].includes('s1');
      expect(
        countOf(
          await run(actor, `update wiki_pages set title = title where id = 'p1' returning 1`),
        ),
        `pages ${actor}`,
      ).toEqual({ count: canS1 ? 1 : 0 });
      expect(
        countOf(
          await run(
            actor,
            `update wiki_aliases set alias = alias where page_id = 'p1' returning 1`,
          ),
        ),
        `aliases ${actor}`,
      ).toEqual({ count: canS1 ? 1 : 0 });
      expect(
        countOf(
          await run(
            actor,
            `update wiki_revisions set note = note where page_id = 'p1' returning 1`,
          ),
        ),
        `revisions ${actor}`,
      ).toEqual({ code: '42501' });
    }
  });

  it('update: a row can not be moved into an inaccessible show', async () => {
    // `granted` can access s1 only; moving pdel (no dependents) to s2 fails the policy check.
    expect(
      codeOf(await run('granted', `update wiki_pages set show_id = 's2' where id = 'pdel'`)),
    ).toBe('42501');
  });

  it('delete: pages and aliases of accessible shows only; revisions refused to everyone', async () => {
    for (const actor of ACTORS) {
      const canS1 = ACCESSIBLE[actor].includes('s1');
      expect(
        countOf(await run(actor, `delete from wiki_pages where id = 'pdel' returning 1`)),
        `pages ${actor}`,
      ).toEqual({ count: canS1 ? 1 : 0 });
      expect(
        countOf(await run(actor, `delete from wiki_aliases where page_id = 'p1' returning 1`)),
        `aliases ${actor}`,
      ).toEqual({ count: canS1 ? 1 : 0 });
      expect(
        countOf(await run(actor, `delete from wiki_revisions where page_id = 'p1' returning 1`)),
        `revisions ${actor}`,
      ).toEqual({ code: '42501' });
    }
  });

  it('catalog_system reads and writes every row', async () => {
    expect(countOf(await run(null, 'select 1 from wiki_pages'))).toEqual({ count: 6 });
    expect(countOf(await run(null, 'select 1 from wiki_aliases'))).toEqual({ count: 3 });
    expect(countOf(await run(null, 'select 1 from wiki_revisions'))).toEqual({ count: 5 });
    expect(countOf(await run(null, `update wiki_revisions set note = note returning 1`))).toEqual({
      count: 5,
    });
    expect(
      countOf(
        await run(
          null,
          'delete from wiki_revisions',
          'delete from wiki_aliases',
          'delete from wiki_pages returning 1',
        ),
      ),
    ).toEqual({ count: 6 });
  });
});

describe('Revisions are append-only for users', () => {
  it('update and delete as catalog_user give 42501, even for the owner', async () => {
    expect(codeOf(await run('owner', 'update wiki_revisions set note = null'))).toBe('42501');
    expect(codeOf(await run('owner', 'delete from wiki_revisions'))).toBe('42501');
    const [r] =
      await admin`select has_table_privilege('catalog_user', 'catalog.wiki_revisions', 'update') as u,
                                   has_table_privilege('catalog_user', 'catalog.wiki_revisions', 'delete') as d,
                                   has_table_privilege('catalog_user', 'catalog.wiki_revisions', 'insert') as i,
                                   has_table_privilege('catalog_user', 'catalog.wiki_revisions', 'select') as s`;
    expect({ ...r }).toEqual({ u: false, d: false, i: true, s: true });
  });
});

describe('Revisions carry their real author', () => {
  it('a revision naming another user as author is refused', async () => {
    expect(codeOf(await run('granted', insertRevision('p1', 2, 'owner')))).toBe('42501');
    expect(codeOf(await run('granted', insertRevision('p1', 2, 'granted')))).toBe('ok');
  });
});

// -- composite keys -------------------------------------------------------------------------------

describe('rows stay in one show (composite foreign keys)', () => {
  it('Session page in the wrong show: refused by the foreign key, for the system and for a user of both shows', async () => {
    const wrong = insertPage({ id: 'x', show: 's1', kind: 'session', title: 'X', session: 'ss2' });
    expect(codeOf(await run(null, wrong))).toBe('23503');
    expect(codeOf(await run('owner', wrong))).toBe('23503');
    // The same session in its own show is accepted.
    expect(
      codeOf(
        await run(
          'owner',
          insertPage({ id: 'x', show: 's2', kind: 'session', title: 'X', session: 'ss2' }),
        ),
      ),
    ).toBe('ok');
  });

  it('Alias in the wrong show: refused by the foreign key, for a user who can access both shows', async () => {
    expect(codeOf(await run('owner', insertAlias('p1', 's2', 'cross')))).toBe('23503');
    expect(codeOf(await run(null, insertAlias('p1', 's2', 'cross')))).toBe('23503');
    expect(
      codeOf(await run('owner', `update wiki_aliases set show_id = 's2' where page_id = 'p1'`)),
    ).toBe('23503');
  });

  it('merged_into a page of another show is refused by the foreign key', async () => {
    expect(
      codeOf(await run('owner', `update wiki_pages set merged_into = 'p2' where id = 'p1'`)),
    ).toBe('23503');
    expect(
      codeOf(
        await run(
          'owner',
          insertPage({ id: 'x', show: 's1', kind: 'topic', title: 'X', merged: 'p2' }),
        ),
      ),
    ).toBe('23503');
    expect(
      codeOf(await run('owner', `update wiki_pages set merged_into = 'p1b' where id = 'p1'`)),
    ).toBe('ok');
  });

  it('nothing cascades: a show, session or page with wiki rows can not be deleted', async () => {
    expect(codeOf(await run(null, `delete from wiki_pages where id = 'p1'`))).toBe('23503');
    // ss2 has no other rows, so only the wiki page of s2 holds the show.
    expect(
      codeOf(
        await run(
          null,
          `delete from sessions where id = 'ss2'`,
          `delete from shows where id = 's2'`,
        ),
      ),
    ).toBe('23503');
    expect(codeOf(await run(null, `delete from sessions where id = 'ss2'`))).toBe('ok');
    expect(
      codeOf(
        await run(
          null,
          insertPage({ id: 'x', show: 's2', kind: 'session', title: 'X', session: 'ss2' }),
          `delete from sessions where id = 'ss2'`,
        ),
      ),
    ).toBe('23503');
  });
});

// -- live names -----------------------------------------------------------------------------------

describe('live names are unique per show', () => {
  const page = (id: string, title: string, show = 's1', kind = 'topic') =>
    insertPage({ id, show, kind, title });

  it('a live title clashes ignoring case and accents, whatever the non-session kind', async () => {
    expect(codeOf(await run(null, page('x', 'cafe noir')))).toBe('23505');
    expect(codeOf(await run(null, page('x', 'CAFÉ NOIR')))).toBe('23505');
    expect(codeOf(await run(null, page('x', 'Cafe Noir', 's1', 'person')))).toBe('23505');
    // Another show, or a session page, is no clash.
    expect(codeOf(await run(null, page('x', 'cafe noir', 's2')))).toBe('ok');
    expect(
      codeOf(
        await run(
          null,
          insertPage({
            id: 'x',
            show: 's1',
            kind: 'session',
            title: 'Café Noir',
            session: 'ss1',
            deleted: NOW,
          }),
        ),
      ),
    ).toBe('ok');
  });

  it('a merged or deleted page frees its title', async () => {
    expect(
      codeOf(
        await run(
          null,
          `update wiki_pages set merged_into = 'p1b' where id = 'p1'`,
          page('x', 'cafe noir'),
        ),
      ),
    ).toBe('ok');
    expect(
      codeOf(
        await run(
          null,
          `update wiki_pages set deleted_at_utc = '${NOW}' where id = 'p1'`,
          page('x', 'cafe noir'),
        ),
      ),
    ).toBe('ok');
    expect(
      codeOf(
        await run(
          null,
          insertPage({ id: 'x', show: 's1', kind: 'topic', title: 'Café Noir', deleted: NOW }),
        ),
      ),
    ).toBe('ok');
  });

  it('a session has at most one live session page', async () => {
    const second = insertPage({
      id: 'x',
      show: 's1',
      kind: 'session',
      title: 'Again',
      session: 'ss1',
    });
    expect(codeOf(await run(null, second))).toBe('23505');
    expect(
      codeOf(
        await run(null, `update wiki_pages set deleted_at_utc = '${NOW}' where id = 'ps1'`, second),
      ),
    ).toBe('ok');
    expect(
      codeOf(await run(null, `update wiki_pages set merged_into = 'p1' where id = 'ps1'`, second)),
    ).toBe('ok');
  });

  it('an alias is unique per show, ignoring case and accents', async () => {
    expect(codeOf(await run(null, insertAlias('p1b', 's1', 'noir')))).toBe('23505');
    expect(codeOf(await run(null, insertAlias('p1b', 's1', 'NOÏR')))).toBe('23505');
    expect(codeOf(await run(null, insertAlias('p2', 's2', 'noir')))).toBe('ok');
  });
});

// -- checks ---------------------------------------------------------------------------------------

describe('checks', () => {
  const page = (o: Partial<PageRow>) =>
    insertPage({ id: 'x', show: 's2', kind: 'topic', title: 'Fresh', ...o });

  it('kind is one of person, topic, bit, session', async () => {
    for (const kind of ['person', 'topic', 'bit']) {
      expect(codeOf(await run(null, page({ kind }))), kind).toBe('ok');
    }
    expect(codeOf(await run(null, page({ kind: 'session', session: 'ss2' })))).toBe('ok');
    expect(codeOf(await run(null, page({ kind: 'villain' })))).toBe('23514');
  });

  it('session_id is set exactly for session pages', async () => {
    expect(codeOf(await run(null, page({ kind: 'session' })))).toBe('23514');
    expect(codeOf(await run(null, page({ kind: 'topic', session: 'ss2' })))).toBe('23514');
  });

  it('title is 1-200 characters after trimming', async () => {
    expect(codeOf(await run(null, page({ title: '' })))).toBe('23514');
    expect(codeOf(await run(null, page({ title: '   ' })))).toBe('23514');
    expect(codeOf(await run(null, page({ title: 'x'.repeat(201) })))).toBe('23514');
    expect(codeOf(await run(null, page({ title: 'é'.repeat(200) })))).toBe('ok');
    expect(codeOf(await run(null, page({ title: ` ${'x'.repeat(200)} ` })))).toBe('ok');
  });

  it('body is at most 100000 characters and holds no NUL', async () => {
    expect(codeOf(await run(null, page({ body: 'é'.repeat(100000) })))).toBe('ok');
    expect(codeOf(await run(null, page({ body: 'x'.repeat(100001) })))).toBe('23514');
    // Postgres text can't hold NUL at all (so the schema needs no check for it).
    await expect(sys`select ${'a\u0000b'}::text as t`).rejects.toMatchObject({ code: '22021' });
  });

  it('alias is 1-200 characters after trimming', async () => {
    expect(codeOf(await run(null, insertAlias('p2', 's2', '')))).toBe('23514');
    expect(codeOf(await run(null, insertAlias('p2', 's2', '  ')))).toBe('23514');
    expect(codeOf(await run(null, insertAlias('p2', 's2', 'x'.repeat(201))))).toBe('23514');
    expect(codeOf(await run(null, insertAlias('p2', 's2', 'x'.repeat(200))))).toBe('ok');
  });
});
