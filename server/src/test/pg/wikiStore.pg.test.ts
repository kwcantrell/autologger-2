// show-wiki task 3.2 (design D1-D4): `catalog.wiki`, the wiki store, run as the signed-in user
// through the server's catalog adapter (`PostgresCatalogDb`, so the SERIALIZABLE retry loop
// applies) against the policy fixture (policyFixture.ts): shows `s1`, `s2` in team T and `su` in
// team U; sessions `ss1` (s1), `ss2` (s2), `ssu` (su). `owner` accesses s1 and s2, `granted` s1,
// `ungranted` none, `outsider` su. This file adds, as catalog_system:
// - users `leaver` (member of T with a grant on s1, removed later) and `noname` (admin of T, no
//   given or family name);
// - a hidden session `ssh`, and sessions `ssm` and `ssr`, of s1;
// - shows `sl` (list sort) and `scap` (the 2000 cap) in team T.
// Each test uses its own titles, so the tests share one database.

import {
  type CatalogFacade,
  createCatalog,
  WikiConflictError,
  WikiDeletedError,
  WikiInvalidError,
  WikiMergedError,
  WikiNotDeletedError,
  type WikiPage,
  WikiSessionTakenError,
  WikiTitleTakenError,
} from '@autologger/catalog';
import { parseWikiLinks } from '@autologger/contract/wikiLinks';
import { PostgresCatalogDb } from '@autologger/storage';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase } from '../../../../test/pg/testDb';
import { seedPolicyFixture, T } from './policyFixture';

const NOW = '2026-10-21T00:00:00.000Z';

let adapter: PostgresCatalogDb;
let sys: postgres.Sql;

beforeAll(async () => {
  const db = await createTestDatabase();
  sys = postgres({ ...db.system, max: 1, onnotice: () => {} });
  await seedPolicyFixture(sys);
  await sys`insert into users (id, google_sub, email, given_name, family_name, created_at_utc)
            values ('leaver', 'leaver-sub', 'leaver@example.com', 'Lee', 'Ver', ${NOW}),
                   ('noname', 'noname-sub', 'noname@example.com', '', '', ${NOW})`;
  await sys`insert into user_studio_memberships (user_id, studio_id, role)
            values ('leaver', ${T}, 'member'), ('noname', ${T}, 'admin')`;
  await sys`insert into show_grants (user_id, show_id, can_write, granted_by_user_id, granted_at_utc)
            values ('leaver', 's1', 1, 'owner', ${NOW})`;
  await sys`insert into sessions (id, show_id, title, ui_hidden) values ('ssh', 's1', 'Hidden', 1)`;
  await sys`insert into sessions (id, show_id, title) values ('ssm', 's1', 'For merge'), ('ssr', 's1', 'For restore')`;
  for (const id of ['sl', 'scap']) {
    await sys`insert into shows (id, studio_id, name, show_code, created_at_utc)
              values (${id}, ${T}, ${`Show ${id}`}, ${id.toUpperCase()}, ${NOW})`;
  }
  adapter = new PostgresCatalogDb(db.app);
});
afterAll(async () => {
  await sys?.end();
  await adapter?.close();
});

const as = (user: string): CatalogFacade =>
  createCatalog(adapter, { wikiLinks: parseWikiLinks }).forUser(user);
const owner = () => as('owner');

/** The rejection of `p`; fails the test if it resolves. */
async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected the call to reject');
}

async function topic(title: string, extra: Partial<{ aliases: string[]; bodyMd: string }> = {}) {
  return owner().wiki.createPage('s1', { kind: 'topic', title, ...extra });
}

async function revisionCount(pageId: string): Promise<number> {
  const [r] = await sys`select count(*)::int as n from wiki_revisions where page_id = ${pageId}`;
  return Number(r?.n);
}
async function aliasRows(pageId: string): Promise<string[]> {
  const rows = await sys`select alias from wiki_aliases where page_id = ${pageId} order by alias`;
  return rows.map((r) => String(r.alias));
}
async function pageCount(): Promise<number> {
  const [r] = await sys`select count(*)::int as n from wiki_pages`;
  return Number(r?.n);
}

describe('create', () => {
  it('creates revision 1 noted `created` with the author name snapshotted, kept after the author leaves', async () => {
    const page = await as('leaver').wiki.createPage('s1', {
      kind: 'person',
      title: 'Christina Ramos',
      bodyMd: 'Host.',
      aliases: ['Tina'],
    });
    expect(page).toMatchObject({
      show_id: 's1',
      kind: 'person',
      title: 'Christina Ramos',
      body_md: 'Host.',
      aliases: ['Tina'],
      session_id: null,
      revision: 1,
      merged_into: null,
      deleted: false,
      created_by_name: 'Lee Ver',
      updated_by_name: 'Lee Ver',
    });
    expect(Object.keys(page).sort()).toEqual(
      [
        'id',
        'show_id',
        'kind',
        'title',
        'body_md',
        'aliases',
        'session_id',
        'revision',
        'merged_into',
        'deleted',
        'created_at_utc',
        'created_by_name',
        'updated_at_utc',
        'updated_by_name',
      ].sort(),
    );
    expect(page.created_at_utc).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/);
    const rev = await owner().wiki.getRevision(page.id, 1);
    expect(rev).toMatchObject({
      revision: 1,
      note: 'created',
      author_name: 'Lee Ver',
      aliases: ['Tina'],
    });

    await sys`delete from show_grants where user_id = 'leaver'`;
    await sys`delete from user_studio_memberships where user_id = 'leaver'`;
    const later = await owner().wiki.getPage(page.id);
    expect(later?.created_by_name).toBe('Lee Ver');
    expect(later?.updated_by_name).toBe('Lee Ver');
    expect((await owner().wiki.getRevision(page.id, 1))?.author_name).toBe('Lee Ver');
  });

  it('names are never an email: a user with no names records ""', async () => {
    const page = await as('noname').wiki.createPage('s1', { kind: 'topic', title: 'Nameless' });
    expect(page.created_by_name).toBe('');
    expect(page.updated_by_name).toBe('');
    expect((await owner().wiki.getRevision(page.id, 1))?.author_name).toBe('');
    const rows = await sys`select created_by_name, updated_by_name from wiki_pages
                           union all select author_name, author_name from wiki_revisions`;
    for (const r of rows) {
      expect(String(r.created_by_name)).not.toContain('@');
      expect(String(r.updated_by_name)).not.toContain('@');
    }
  });

  it('a catalog built without the link parser refuses a wiki create, writing nothing', async () => {
    const n = await pageCount();
    const bare = createCatalog(adapter).forUser('owner');
    const e = await rejection(bare.wiki.createPage('s1', { kind: 'topic', title: 'No parser' }));
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toBe('wiki link parser not configured');
    expect(await pageCount()).toBe(n);
    // A transaction-derived catalog carries the parser on.
    const page = await as('owner').tx((c) =>
      c.wiki.createPage('s1', { kind: 'topic', title: 'Via tx' }),
    );
    expect(page.revision).toBe(1);
  });

  it('out-of-schema input is refused as invalid, not a database error', async () => {
    const n = await pageCount();
    for (const input of [
      { title: 'Two\nlines' },
      { title: '   ' },
      { title: 'x'.repeat(201) },
      { title: 'Big body', bodyMd: 'b'.repeat(100_001) },
      { title: 'NUL body', bodyMd: 'a\u0000b' },
      { title: 'Many aliases', aliases: Array.from({ length: 51 }, (_, i) => `many ${i}`) },
      { title: 'Bad alias', aliases: ['tab\there'] },
    ]) {
      expect(await rejection(topic(input.title, input)), input.title).toBeInstanceOf(
        WikiInvalidError,
      );
    }
    expect(await pageCount()).toBe(n);
  });

  it('a page outside the caller’s shows reads as null', async () => {
    const page = await topic('Private topic');
    expect(await as('ungranted').wiki.getPage(page.id)).toBeNull();
    expect(await as('outsider').wiki.getPage(page.id)).toBeNull();
    expect((await as('ungranted').wiki.listPages('s1')).pages).toEqual([]);
    expect(
      await as('outsider').wiki.updatePage(page.id, { expectedRevision: 1, bodyMd: 'x' }),
    ).toBeNull();
    expect(await as('outsider').wiki.listRevisions(page.id, {})).toBeNull();
    expect(await as('outsider').wiki.getRevision(page.id, 1)).toBeNull();
  });
});

describe('compare-and-set edits', () => {
  it('two editors, one wins: the stale save changes nothing and carries the current page', async () => {
    const page = await topic('Two editors');
    const first = await as('granted').wiki.updatePage(page.id, {
      expectedRevision: 1,
      bodyMd: 'first',
    });
    expect(first?.revision).toBe(2);
    expect(first?.updated_by_name).toBe('granted Fixture');
    expect((await owner().wiki.getRevision(page.id, 2))?.author_name).toBe('granted Fixture');
    const e = await rejection(
      owner().wiki.updatePage(page.id, { expectedRevision: 1, bodyMd: 'second' }),
    );
    expect(e).toBeInstanceOf(WikiConflictError);
    expect((e as WikiConflictError).current).toMatchObject({
      id: page.id,
      revision: 2,
      body_md: 'first',
    });
    expect(await revisionCount(page.id)).toBe(2);
    expect((await owner().wiki.getPage(page.id))?.body_md).toBe('first');
  });

  it('a no-op edit appends no revision', async () => {
    const page = await topic('Steady', { aliases: ['Calm'], bodyMd: 'same' });
    const same = await owner().wiki.updatePage(page.id, {
      expectedRevision: 1,
      title: 'Steady',
      kind: 'topic',
      bodyMd: 'same',
      aliases: [' Calm ', 'calm'],
    });
    expect(same?.revision).toBe(1);
    expect(await revisionCount(page.id)).toBe(1);
  });

  it('a kind change to or from `session` is refused before any write', async () => {
    const page = await topic('Not a session');
    const e = await rejection(
      owner().wiki.updatePage(page.id, { expectedRevision: 1, kind: 'session' }),
    );
    expect(e).toBeInstanceOf(WikiInvalidError);
    const sp = await owner().wiki.createPage('s2', {
      kind: 'session',
      title: 'Session two',
      sessionId: 'ss2',
    });
    const e2 = await rejection(
      owner().wiki.updatePage(sp.id, { expectedRevision: 1, kind: 'topic' }),
    );
    expect(e2).toBeInstanceOf(WikiInvalidError);
    expect((await owner().wiki.getPage(page.id))?.kind).toBe('topic');
    expect((await owner().wiki.getPage(sp.id))?.kind).toBe('session');
    expect(await revisionCount(page.id)).toBe(1);
    expect(await revisionCount(sp.id)).toBe(1);
  });

  it('restoring a revision is an edit that appends `restored r<n>` and leaves history alone', async () => {
    const page = await topic('Restorable', { bodyMd: 'v1', aliases: ['R one'] });
    let cur = page;
    for (const [i, body] of ['v2', 'v3', 'v4'].entries()) {
      const next = await owner().wiki.updatePage(cur.id, {
        expectedRevision: i + 1,
        bodyMd: body,
        aliases: [`R ${body}`],
      });
      cur = next as WikiPage;
    }
    expect(cur.revision).toBe(4);
    const before = await Promise.all([1, 2, 3, 4].map((n) => owner().wiki.getRevision(page.id, n)));
    const r2 = before[1];
    const restored = await owner().wiki.updatePage(page.id, {
      expectedRevision: 4,
      title: r2?.title,
      kind: r2?.kind,
      bodyMd: r2?.body_md,
      aliases: r2?.aliases,
      restoredFrom: 2,
    });
    expect(restored).toMatchObject({ revision: 5, body_md: 'v2', aliases: ['R v2'] });
    expect((await owner().wiki.getRevision(page.id, 5))?.note).toBe('restored r2');
    const after = await Promise.all([1, 2, 3, 4].map((n) => owner().wiki.getRevision(page.id, n)));
    expect(after).toEqual(before);
  });
});

describe('titles and aliases are unique within a show', () => {
  it('title against title, ignoring case and accents, names the holder and writes nothing', async () => {
    const held = await topic('Café Noir');
    const n = await pageCount();
    const e = await rejection(topic('cafe noir'));
    expect(e).toBeInstanceOf(WikiTitleTakenError);
    expect((e as WikiTitleTakenError).pageId).toBe(held.id);
    expect(await pageCount()).toBe(n);
    // Another show may reuse the name.
    await expect(
      owner().wiki.createPage('s2', { kind: 'topic', title: 'Café Noir' }),
    ).resolves.toBeTruthy();
  });

  it('alias against alias', async () => {
    const held = await topic('Alias holder', { aliases: ['Shared Name'] });
    const e = await rejection(topic('Alias taker', { aliases: ['shared name'] }));
    expect(e).toBeInstanceOf(WikiTitleTakenError);
    expect((e as WikiTitleTakenError).pageId).toBe(held.id);
  });

  it('title against alias, both ways', async () => {
    const titled = await topic('chris t');
    const other = await topic('Other Chris');
    const e = await rejection(
      owner().wiki.updatePage(other.id, { expectedRevision: 1, aliases: ['Chris T'] }),
    );
    expect(e).toBeInstanceOf(WikiTitleTakenError);
    expect((e as WikiTitleTakenError).pageId).toBe(titled.id);
    expect((await owner().wiki.getPage(other.id))?.aliases).toEqual([]);
    expect(await aliasRows(other.id)).toEqual([]);

    const aliased = await topic('Aliased page', { aliases: ['Nick Name'] });
    const e2 = await rejection(topic('NICK NAME'));
    expect(e2).toBeInstanceOf(WikiTitleTakenError);
    expect((e2 as WikiTitleTakenError).pageId).toBe(aliased.id);
  });

  it('duplicate aliases in one request collapse, and the own title is dropped', async () => {
    const page = await topic('Christopher', {
      aliases: ['Chris', 'chris', ' christopher ', 'Chris '],
    });
    expect(page.aliases).toEqual(['Chris']);
    expect(await aliasRows(page.id)).toEqual(['Chris']);
    const edited = await owner().wiki.updatePage(page.id, {
      expectedRevision: 1,
      aliases: ['Kit', 'KIT', 'Christopher', 'Chris'],
    });
    expect(edited?.aliases).toEqual(['Kit', 'Chris']);
    expect(await aliasRows(page.id)).toEqual(['Chris', 'Kit']);
  });

  it('two concurrent creates whose title and alias clash: exactly one succeeds', async () => {
    for (const round of [1, 2, 3]) {
      const a = as('owner');
      const b = as('granted');
      const results = await Promise.allSettled([
        a.wiki.createPage('s1', {
          kind: 'topic',
          title: `Race ${round}`,
          aliases: [`Racer ${round}`],
        }),
        b.wiki.createPage('s1', {
          kind: 'bit',
          title: `racer ${round}`,
          aliases: [`race ${round}`],
        }),
      ]);
      const ok = results.filter((r) => r.status === 'fulfilled');
      const bad = results.filter((r) => r.status === 'rejected');
      expect(ok).toHaveLength(1);
      expect(bad).toHaveLength(1);
      const err = (bad[0] as PromiseRejectedResult).reason;
      expect(err).toBeInstanceOf(WikiTitleTakenError);
      expect((err as WikiTitleTakenError).pageId).toBe(
        (ok[0] as PromiseFulfilledResult<WikiPage>).value.id,
      );
    }
  });
});

describe('session pages', () => {
  it('a session has at most one live page', async () => {
    const page = await owner().wiki.createPage('s1', {
      kind: 'session',
      title: 'Session ss1',
      sessionId: 'ss1',
    });
    expect(page).toMatchObject({ kind: 'session', session_id: 'ss1', aliases: [] });
    const e = await rejection(
      owner().wiki.createPage('s1', { kind: 'session', title: 'Again', sessionId: 'ss1' }),
    );
    expect(e).toBeInstanceOf(WikiSessionTakenError);
    expect((e as WikiSessionTakenError).pageId).toBe(page.id);
    const listed = await owner().wiki.listPages('s1', { kind: 'session', sessionId: 'ss1' });
    expect(listed.pages.map((p) => p.id)).toEqual([page.id]);
  });

  it('two sessions may share a title', async () => {
    const page = await owner().wiki.createPage('s1', {
      kind: 'session',
      title: 'Session ss1',
      sessionId: 'ssh',
    });
    expect(page).toMatchObject({ revision: 1, session_id: 'ssh' });
  });

  it('a session from another show is refused and nothing is written', async () => {
    const n = await pageCount();
    for (const sessionId of ['ss2', 'ssu', 'nope']) {
      const e = await rejection(
        owner().wiki.createPage('s1', { kind: 'session', title: `Wrong ${sessionId}`, sessionId }),
      );
      expect(e).toBeInstanceOf(WikiInvalidError);
    }
    expect(await pageCount()).toBe(n);
  });
});

describe('links', () => {
  it('a citation or page link outside the show is refused naming the link, in every link form', async () => {
    const page = await topic('Linking page');
    const s2page = await owner().wiki.createPage('s2', { kind: 'topic', title: 'Show two page' });
    const cases: Array<[string, string]> = [
      ['[q](cite:ss2@1)', 'cite:ss2@1'],
      ['[q](cite:ssu@754.5)', 'cite:ssu@754.5'],
      [`[x](wiki:${s2page.id})`, `wiki:${s2page.id}`],
      ['[x][r]\n\n[r]: cite:ss2@1', 'cite:ss2@1'],
      ['see <cite:ss2@1>', 'cite:ss2@1'],
      ['[x](<cite:ss2@2>)', 'cite:ss2@2'],
      ['[x](CITE:ss1@1)', 'CITE:ss1@1'],
      ['[x](cite:ss1)', 'cite:ss1'],
      ['[x](wiki:a/b)', 'wiki:a/b'],
    ];
    for (const [body, url] of cases) {
      const e = await rejection(
        owner().wiki.updatePage(page.id, { expectedRevision: 1, bodyMd: body }),
      );
      expect(e, body).toBeInstanceOf(WikiInvalidError);
      expect((e as Error).message, body).toContain(url);
    }
    const e = await rejection(topic('Bad create', { bodyMd: '[q](cite:ssu@1)' }));
    expect(e).toBeInstanceOf(WikiInvalidError);
    expect(await revisionCount(page.id)).toBe(1);
    expect((await owner().wiki.getPage(page.id))?.body_md).toBe('');
  });

  it('more than 500 links are refused', async () => {
    const page = await topic('Link heavy');
    const body = Array.from({ length: 501 }, () => '[a](cite:ss1@1)').join(' ');
    expect(
      await rejection(owner().wiki.updatePage(page.id, { expectedRevision: 1, bodyMd: body })),
    ).toBeInstanceOf(WikiInvalidError);
    const ok = Array.from({ length: 500 }, () => '[a](cite:ss1@1)').join(' ');
    expect(
      (await owner().wiki.updatePage(page.id, { expectedRevision: 1, bodyMd: ok }))?.revision,
    ).toBe(2);
  });

  it('a citation to a hidden session of the show, and links to deleted or merged pages, are accepted', async () => {
    const gone = await topic('Gone page');
    await owner().wiki.deletePage(gone.id, 1);
    const page = await topic('Cites hidden', {
      bodyMd: `[we start Monday](cite:ssh@754) and [x](cite:ss1@0.125) and [g](wiki:${gone.id})`,
    });
    expect(page.revision).toBe(1);
  });
});

describe('delete and restore', () => {
  it('deleted pages free their names; restore is blocked by the new holder, then brings aliases back', async () => {
    const old = await topic('Running Joke', { aliases: ['RJ', 'The Joke'] });
    const deleted = await owner().wiki.deletePage(old.id, 1);
    expect(deleted).toMatchObject({ revision: 2, deleted: true, aliases: ['RJ', 'The Joke'] });
    expect((await owner().wiki.getRevision(old.id, 2))?.note).toBe('deleted');
    expect(await aliasRows(old.id)).toEqual([]);
    expect((await owner().wiki.getPage(old.id))?.aliases).toEqual(['RJ', 'The Joke']);

    const live = await owner().wiki.listPages('s1');
    expect(live.pages.some((p) => p.id === old.id)).toBe(false);
    const dead = await owner().wiki.listPages('s1', { deleted: true });
    expect(dead.pages.find((p) => p.id === old.id)).toMatchObject({ aliases: ['RJ', 'The Joke'] });

    expect(
      await rejection(owner().wiki.updatePage(old.id, { expectedRevision: 2, bodyMd: 'x' })),
    ).toBeInstanceOf(WikiDeletedError);
    expect(await rejection(owner().wiki.deletePage(old.id, 2))).toBeInstanceOf(WikiDeletedError);

    const fresh = await topic('running joke');
    const e = await rejection(owner().wiki.restorePage(old.id, 2));
    expect(e).toBeInstanceOf(WikiTitleTakenError);
    expect((e as WikiTitleTakenError).pageId).toBe(fresh.id);
    expect(await revisionCount(old.id)).toBe(2);

    expect(await rejection(owner().wiki.restorePage(fresh.id, 1))).toBeInstanceOf(
      WikiNotDeletedError,
    );
    await owner().wiki.deletePage(fresh.id, 1);
    expect(await rejection(owner().wiki.restorePage(old.id, 1))).toBeInstanceOf(WikiConflictError);
    const back = await owner().wiki.restorePage(old.id, 2);
    expect(back).toMatchObject({ revision: 3, deleted: false, aliases: ['RJ', 'The Joke'] });
    expect((await owner().wiki.getRevision(old.id, 3))?.note).toBe('restored');
    expect(await aliasRows(old.id)).toEqual(['RJ', 'The Joke']);
  });

  it('restore of a session page is blocked while the session has another page', async () => {
    const sid = 'ssr';
    const first = await owner().wiki.createPage('s1', {
      kind: 'session',
      title: 'Restore page',
      sessionId: sid,
    });
    await owner().wiki.deletePage(first.id, 1);
    const second = await owner().wiki.createPage('s1', {
      kind: 'session',
      title: 'Restore page',
      sessionId: sid,
    });
    const e = await rejection(owner().wiki.restorePage(first.id, 2));
    expect(e).toBeInstanceOf(WikiSessionTakenError);
    expect((e as WikiSessionTakenError).pageId).toBe(second.id);
  });
});

describe('revisions', () => {
  it('page backwards with limit and before', async () => {
    const page = await topic('Many revisions');
    for (let r = 1; r < 13; r++) {
      await owner().wiki.updatePage(page.id, { expectedRevision: r, bodyMd: `body ${r}` });
    }
    const p1 = await owner().wiki.listRevisions(page.id, { limit: 5 });
    expect(p1?.revisions.map((r) => r.revision)).toEqual([13, 12, 11, 10, 9]);
    expect(p1?.nextBefore).toBe(9);
    expect(Object.keys(p1?.revisions[0] ?? {}).sort()).toEqual(
      ['revision', 'title', 'kind', 'author_name', 'at_utc', 'note'].sort(),
    );
    const p2 = await owner().wiki.listRevisions(page.id, { limit: 5, before: 9 });
    expect(p2?.revisions.map((r) => r.revision)).toEqual([8, 7, 6, 5, 4]);
    expect(p2?.nextBefore).toBe(4);
    const p3 = await owner().wiki.listRevisions(page.id, { limit: 5, before: 4 });
    expect(p3?.revisions.map((r) => r.revision)).toEqual([3, 2, 1]);
    expect(p3?.nextBefore).toBeNull();
    expect((await owner().wiki.listRevisions(page.id, {}))?.revisions).toHaveLength(13);
    const r1 = await owner().wiki.getRevision(page.id, 1);
    expect(r1).toMatchObject({
      revision: 1,
      title: 'Many revisions',
      body_md: '',
      note: 'created',
      aliases: [],
    });
    expect(await owner().wiki.getRevision(page.id, 99)).toBeNull();
  });
});

describe('merge', () => {
  it('leaves a redirect, moves the body under an escaped heading and adds the names', async () => {
    const a = await topic('Chris R.', { aliases: ['CR'], bodyMd: 'From A.' });
    const b = await topic('Christina Ramos Merge', { aliases: ['Chrissy'], bodyMd: 'From B.' });
    const merged = await owner().wiki.mergePage(a.id, b.id, 1, 1);
    expect(merged).toMatchObject({ id: b.id, revision: 2, aliases: ['Chrissy', 'Chris R.', 'CR'] });
    expect(merged?.body_md).toBe('From B.\n\n## Merged from Chris R\\.\n\nFrom A.');
    expect(await aliasRows(b.id)).toEqual(['CR', 'Chris R.', 'Chrissy'].sort());
    const redirect = await owner().wiki.getPage(a.id);
    expect(redirect).toMatchObject({
      merged_into: b.id,
      revision: 2,
      body_md: 'From A.',
      aliases: ['CR'],
      deleted: false,
    });
    expect(await aliasRows(a.id)).toEqual([]);
    expect((await owner().wiki.getRevision(a.id, 2))?.note).toBe(`merged into ${b.id}`);
    expect((await owner().wiki.getRevision(b.id, 2))?.note).toBe(`merged from ${a.id}`);
    expect((await owner().wiki.listPages('s1')).pages.some((p) => p.id === a.id)).toBe(false);
    expect(
      (await owner().wiki.listPages('s1', { deleted: true })).pages.some((p) => p.id === a.id),
    ).toBe(false);
    const e = await rejection(topic('chris r.'));
    expect((e as WikiTitleTakenError).pageId).toBe(b.id);

    // Merged pages can't be written or merged again; a merged target is refused too.
    const e2 = await rejection(owner().wiki.updatePage(a.id, { expectedRevision: 2, bodyMd: 'x' }));
    expect(e2).toBeInstanceOf(WikiMergedError);
    expect((e2 as WikiMergedError).mergedInto).toBe(b.id);
    const c = await topic('Third merge page');
    expect(await rejection(owner().wiki.mergePage(a.id, c.id, 2, 1))).toBeInstanceOf(
      WikiMergedError,
    );
    expect(await rejection(owner().wiki.mergePage(c.id, a.id, 1, 2))).toBeInstanceOf(
      WikiMergedError,
    );
    expect(await rejection(owner().wiki.deletePage(a.id, 2))).toBeInstanceOf(WikiMergedError);
  });

  it('escapes the merged title so it adds no link or structure', async () => {
    const a = await topic('[x](wiki:abc) # *y*', { bodyMd: 'A body' });
    const b = await topic('Escape target');
    const merged = await owner().wiki.mergePage(a.id, b.id, 1, 1);
    expect(merged?.body_md).toBe('## Merged from \\[x\\]\\(wiki\\:abc\\) \\# \\*y\\*\n\nA body');
    expect(parseWikiLinks(merged?.body_md ?? '').links).toEqual([]);
  });

  it('stale on either side changes nothing', async () => {
    const a = await topic('Stale A');
    const b = await topic('Stale B');
    const ea = await rejection(owner().wiki.mergePage(a.id, b.id, 2, 1));
    expect(ea).toBeInstanceOf(WikiConflictError);
    expect((ea as WikiConflictError).current.id).toBe(a.id);
    const eb = await rejection(owner().wiki.mergePage(a.id, b.id, 1, 3));
    expect(eb).toBeInstanceOf(WikiConflictError);
    expect((eb as WikiConflictError).current.id).toBe(b.id);
    expect(await revisionCount(a.id)).toBe(1);
    expect(await revisionCount(b.id)).toBe(1);
    expect((await owner().wiki.getPage(a.id))?.merged_into).toBeNull();
  });

  it('a merge that would overflow the body or the 50 aliases is refused and changes nothing', async () => {
    const a = await topic('Big A', { bodyMd: 'a'.repeat(60_000) });
    const b = await topic('Big B', { bodyMd: 'b'.repeat(45_000) });
    expect(await rejection(owner().wiki.mergePage(a.id, b.id, 1, 1))).toBeInstanceOf(
      WikiInvalidError,
    );
    const many = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p} alias ${i}`);
    const c = await topic('Aliases C', { aliases: many('C', 25) });
    const d = await topic('Aliases D', { aliases: many('D', 30) });
    expect(await rejection(owner().wiki.mergePage(c.id, d.id, 1, 1))).toBeInstanceOf(
      WikiInvalidError,
    );
    for (const p of [a, b, c, d]) {
      expect(await revisionCount(p.id)).toBe(1);
      expect((await owner().wiki.getPage(p.id))?.merged_into).toBeNull();
    }
    expect(await aliasRows(c.id)).toHaveLength(25);
    expect(await aliasRows(d.id)).toHaveLength(30);
  });

  it('refuses a merge into itself, or involving a session page; a deleted side is refused', async () => {
    const a = await topic('Self merge');
    expect(await rejection(owner().wiki.mergePage(a.id, a.id, 1, 1))).toBeInstanceOf(
      WikiInvalidError,
    );
    const sp = await owner().wiki.createPage('s1', {
      kind: 'session',
      title: 'Merge session',
      sessionId: 'ssm',
    });
    const spRev = 1;
    expect(await rejection(owner().wiki.mergePage(a.id, sp.id, 1, spRev))).toBeInstanceOf(
      WikiInvalidError,
    );
    expect(await rejection(owner().wiki.mergePage(sp.id, a.id, spRev, 1))).toBeInstanceOf(
      WikiInvalidError,
    );
    const del = await topic('Deleted merge side');
    await owner().wiki.deletePage(del.id, 1);
    expect(await rejection(owner().wiki.mergePage(del.id, a.id, 2, 1))).toBeInstanceOf(
      WikiDeletedError,
    );
    expect(await rejection(owner().wiki.mergePage(a.id, del.id, 1, 2))).toBeInstanceOf(
      WikiDeletedError,
    );
    const other = await owner().wiki.createPage('s2', {
      kind: 'topic',
      title: 'Other show target',
    });
    expect(await owner().wiki.mergePage(a.id, other.id, 1, 1)).toBeNull();
    expect(await revisionCount(a.id)).toBe(1);
  });
});

describe('split', () => {
  it('moves text atomically', async () => {
    const src = await topic('Big topic', { bodyMd: 'keep\n\nmove' });
    const taken = await topic('Taken bit title');
    const n = await pageCount();
    const e = await rejection(
      owner().wiki.splitPage(src.id, {
        expectedRevision: 1,
        remainingBodyMd: 'keep',
        newPage: { kind: 'bit', title: 'taken bit title', bodyMd: 'move' },
      }),
    );
    expect(e).toBeInstanceOf(WikiTitleTakenError);
    expect((e as WikiTitleTakenError).pageId).toBe(taken.id);
    expect(await pageCount()).toBe(n);
    expect(await owner().wiki.getPage(src.id)).toMatchObject({
      revision: 1,
      body_md: 'keep\n\nmove',
    });

    expect(
      await rejection(
        owner().wiki.splitPage(src.id, {
          expectedRevision: 1,
          remainingBodyMd: 'keep',
          newPage: { kind: 'session', title: 'Split session', bodyMd: 'move' },
        }),
      ),
    ).toBeInstanceOf(WikiInvalidError);
    expect(
      await rejection(
        owner().wiki.splitPage(src.id, {
          expectedRevision: 1,
          remainingBodyMd: 'keep',
          newPage: { kind: 'bit', title: 'Split bad link', bodyMd: '[q](cite:ssu@1)' },
        }),
      ),
    ).toBeInstanceOf(WikiInvalidError);
    expect(
      await rejection(
        owner().wiki.splitPage(src.id, {
          expectedRevision: 2,
          remainingBodyMd: 'keep',
          newPage: { kind: 'bit', title: 'Split stale', bodyMd: 'move' },
        }),
      ),
    ).toBeInstanceOf(WikiConflictError);
    expect(await pageCount()).toBe(n);

    const out = await owner().wiki.splitPage(src.id, {
      expectedRevision: 1,
      remainingBodyMd: 'keep',
      newPage: { kind: 'bit', title: 'Moved bit', bodyMd: 'move', aliases: ['MB'] },
    });
    expect(out?.page).toMatchObject({ id: src.id, revision: 2, body_md: 'keep' });
    expect(out?.newPage).toMatchObject({
      show_id: 's1',
      kind: 'bit',
      title: 'Moved bit',
      body_md: 'move',
      aliases: ['MB'],
      revision: 1,
    });
    expect((await owner().wiki.getRevision(src.id, 2))?.note).toBe(`split to ${out?.newPage.id}`);
    expect((await owner().wiki.getRevision(out?.newPage.id ?? '', 1))?.note).toBe(
      `split from ${src.id}`,
    );
    expect(await aliasRows(out?.newPage.id ?? '')).toEqual(['MB']);
  });
});

describe('list', () => {
  it('sorts by normalised title and filters by kind and session', async () => {
    const c = owner();
    for (const [kind, title] of [
      ['topic', 'Zed'],
      ['person', 'éclair'],
      ['topic', 'Apple'],
      ['bit', 'banana'],
      ['person', 'Eclairs'],
    ] as const) {
      await c.wiki.createPage('sl', {
        kind,
        title,
        aliases: kind === 'person' ? [`${title} alias`] : [],
      });
    }
    const all = await c.wiki.listPages('sl');
    expect(all.truncated).toBe(false);
    expect(all.pages.map((p) => p.title)).toEqual(['Apple', 'banana', 'éclair', 'Eclairs', 'Zed']);
    expect(Object.keys(all.pages[0] ?? {}).sort()).toEqual(
      [
        'id',
        'kind',
        'title',
        'aliases',
        'session_id',
        'revision',
        'updated_at_utc',
        'updated_by_name',
      ].sort(),
    );
    const people = await c.wiki.listPages('sl', { kind: 'person' });
    expect(people.pages.map((p) => [p.title, p.aliases])).toEqual([
      ['éclair', ['éclair alias']],
      ['Eclairs', ['Eclairs alias']],
    ]);
  });

  it('returns at most 2000 pages and says when more matched', async () => {
    const bulk = (from: number, to: number) => sys`
      with n as (select g from generate_series(${from}::int, ${to}::int) g)
      , p as (
        insert into wiki_pages (id, show_id, kind, title, body_md, session_id, revision, merged_into,
          deleted_at_utc, created_by, created_by_name, created_at_utc, updated_by, updated_by_name,
          updated_at_utc)
        select 'cap-' || g, 'scap', 'topic', 'Cap ' || lpad(g::text, 5, '0'), '', null, 1, null, null,
          'owner', 'owner Fixture', ${NOW}, 'owner', 'owner Fixture', ${NOW} from n
        returning id, title)
      insert into wiki_revisions (page_id, revision, title, kind, body_md, aliases_json,
        author_user_id, author_name, at_utc, note)
      select id, 1, title, 'topic', '', '[]'::jsonb, 'owner', 'owner Fixture', ${NOW}, 'created' from p`;
    await bulk(1, 2000);
    const exact = await owner().wiki.listPages('scap');
    expect(exact.pages).toHaveLength(2000);
    expect(exact.truncated).toBe(false);
    await bulk(2001, 2001);
    const over = await owner().wiki.listPages('scap');
    expect(over.pages).toHaveLength(2000);
    expect(over.truncated).toBe(true);
    expect(over.pages[0]?.title).toBe('Cap 00001');
    expect(over.pages[1999]?.title).toBe('Cap 02000');
  });
});
