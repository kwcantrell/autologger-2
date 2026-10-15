// show-wiki-ai task 3.2 (design D2; show-wiki "AI suggestions", "Accepting a suggestion is a
// compare-and-set edit"): the suggestion methods and the wiki-tool read helpers on `catalog.wiki`,
// run as the signed-in user through the server's catalog adapter (`PostgresCatalogDb`, so the
// SERIALIZABLE retry loop applies) against the policy fixture (policyFixture.ts): shows `s1`, `s2`
// in team T and `su` in team U; sessions `ss1` (s1), `ss2` (s2), `ssu` (su). `owner` accesses s1
// and s2, `granted` s1, `ungranted` none, `outsider` su. This file adds, as catalog_system,
// sessions `sa`..`sf` of s1 and a show `scap` (the 500 cap) in team T with session `scs`. Each
// test uses its own titles and pages, so the tests share one database.

import {
  type CatalogFacade,
  createCatalog,
  WikiConflictError,
  WikiDeletedError,
  WikiInvalidError,
  WikiMergedError,
  type WikiProposal,
  WikiSessionTakenError,
  WikiSuggestionResolvedError,
  WikiTitleTakenError,
} from '@autologger/catalog';
import { parseWikiLinks } from '@autologger/contract/wikiLinks';
import { PostgresCatalogDb } from '@autologger/storage';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase } from '../../../../test/pg/testDb';
import { seedPolicyFixture, T } from './policyFixture';

const NOW = '2026-10-22T00:00:00.000Z';

let adapter: PostgresCatalogDb;
let sys: postgres.Sql;

beforeAll(async () => {
  const db = await createTestDatabase();
  sys = postgres({ ...db.system, max: 1, onnotice: () => {} });
  await seedPolicyFixture(sys);
  for (const id of ['sa', 'sb', 'sc', 'sd', 'se', 'sf']) {
    await sys`insert into sessions (id, show_id, title) values (${id}, 's1', ${`Session ${id}`})`;
  }
  await sys`insert into shows (id, studio_id, name, show_code, created_at_utc)
            values ('scap', ${T}, 'Show scap', 'SCAP', ${NOW})`;
  await sys`insert into sessions (id, show_id, title) values ('scs', 'scap', 'Cap session')`;
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

function edit(pageId: string, baseRevision: number, title: string, bodyMd: string): WikiProposal {
  return {
    target: { type: 'page', pageId, baseRevision },
    kind: 'topic',
    title,
    aliases: [],
    bodyMd,
    rationale: `Update ${title}.`,
  };
}

function fresh(title: string, extra: Partial<WikiProposal> = {}): WikiProposal {
  return {
    target: { type: 'new' },
    kind: 'person',
    title,
    aliases: [],
    bodyMd: `About ${title}.`,
    rationale: `New page ${title}.`,
    ...extra,
  };
}

async function statusOf(id: string): Promise<string> {
  const [r] = await sys`select status from wiki_suggestions where id = ${id}`;
  return String(r?.status);
}
async function suggestionCount(): Promise<number> {
  const [r] = await sys`select count(*)::int as n from wiki_suggestions`;
  return Number(r?.n);
}

describe('saveRun', () => {
  it('stores pending rows in proposal order with the creator name snapshot', async () => {
    const page = await topic('Order page', { bodyMd: 'Old.' });
    const saved = await as('granted').wiki.saveRun('s1', 'ss1', 'run-order', [
      fresh('Order Zed'),
      edit(page.id, 1, 'Order page', 'New.'),
      fresh('Order Alpha', { kind: 'bit', aliases: ['The alpha bit'] }),
    ]);
    expect(saved.map((s) => s.title)).toEqual(['Order Zed', 'Order page', 'Order Alpha']);
    expect(saved[0]).toMatchObject({
      show_id: 's1',
      session_id: 'ss1',
      status: 'pending',
      page_id: null,
      base_revision: null,
      kind: 'person',
      aliases: [],
      rationale: 'New page Order Zed.',
      page: null,
      stale: false,
      created_by_name: 'granted Fixture',
      resolved_at_utc: null,
      resolved_by_name: null,
      resolved_revision: null,
    });
    expect(Object.keys(saved[0] ?? {}).sort()).toEqual(
      [
        'id',
        'show_id',
        'session_id',
        'status',
        'page_id',
        'base_revision',
        'kind',
        'title',
        'aliases',
        'rationale',
        'page',
        'stale',
        'created_at_utc',
        'created_by_name',
        'resolved_at_utc',
        'resolved_by_name',
        'resolved_revision',
      ].sort(),
    );
    expect(saved[1]).toMatchObject({
      page_id: page.id,
      base_revision: 1,
      page: { title: 'Order page', revision: 1, state: 'live' },
      stale: false,
    });
    expect(saved[2]?.aliases).toEqual(['The alpha bit']);
    const rows = await sys`select run_id, created_by, created_by_name from wiki_suggestions
                           where run_id = 'run-order'`;
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.created_by).toBe('granted');
      expect(String(r.created_by_name)).not.toContain('@');
    }
    // The page is unchanged: a suggestion never changes a page by itself.
    expect((await owner().wiki.getPage(page.id))?.revision).toBe(1);
  });

  it('an empty run stores nothing and returns []', async () => {
    const n = await suggestionCount();
    expect(await owner().wiki.saveRun('s1', 'ss1', 'run-empty', [])).toEqual([]);
    expect(await suggestionCount()).toBe(n);
  });

  it('A newer run supersedes the older suggestion (page target)', async () => {
    const page = await topic('Supersede page', { bodyMd: 'v1' });
    const [older] = await owner().wiki.saveRun('s1', 'sa', 'run-s1', [
      edit(page.id, 1, 'Supersede page', 'from session a'),
    ]);
    const [newer] = await owner().wiki.saveRun('s1', 'sb', 'run-s2', [
      edit(page.id, 1, 'Supersede page', 'from session b'),
    ]);
    expect(await statusOf(older?.id as string)).toBe('superseded');
    expect(newer?.status).toBe('pending');
    expect(newer?.session_id).toBe('sb');
    const [r] = await sys`select resolved_by, resolved_at_utc from wiki_suggestions
                          where id = ${older?.id as string}`;
    expect(r).toEqual({ resolved_by: null, resolved_at_utc: null });
    expect((await owner().wiki.getPage(page.id))?.body_md).toBe('v1');
  });

  it('A newer run supersedes the older suggestion (new-page target, ignoring case and accents)', async () => {
    const [older] = await owner().wiki.saveRun('s1', 'sa', 'run-n1', [fresh('Café Supersédé')]);
    const [newer] = await owner().wiki.saveRun('s1', 'sb', 'run-n2', [fresh('cafe SUPERSEDE')]);
    expect(await statusOf(older?.id as string)).toBe('superseded');
    expect(newer?.status).toBe('pending');
    const listed = await owner().wiki.listSuggestions('s1', { status: 'superseded' });
    expect(listed.suggestions.map((s) => s.id)).toContain(older?.id);
  });

  it('a run with a bad link stores nothing and supersedes nothing', async () => {
    const page = await topic('Bad link page');
    const [kept] = await owner().wiki.saveRun('s1', 'sa', 'run-bl1', [
      edit(page.id, 1, 'Bad link page', 'first'),
    ]);
    const n = await suggestionCount();
    for (const body of ['[x](wiki:no-such-page)', '[x](cite:ss2@0)', '[x](cite:nope@)']) {
      const e = await rejection(
        owner().wiki.saveRun('s1', 'sb', 'run-bl2', [
          edit(page.id, 1, 'Bad link page', 'second'),
          fresh('Bad link new', { bodyMd: body }),
        ]),
      );
      expect(e, body).toBeInstanceOf(WikiInvalidError);
    }
    expect(await suggestionCount()).toBe(n);
    expect(await statusOf(kept?.id as string)).toBe('pending');
  });

  it('refuses out-of-shape proposals and two proposals for one target, storing nothing', async () => {
    const page = await topic('Shape page');
    const n = await suggestionCount();
    for (const [label, proposals] of [
      ['empty title', [fresh('  ')]],
      ['long title', [fresh('x'.repeat(201))]],
      ['body over 30,000', [fresh('Big', { bodyMd: 'b'.repeat(30_001) })]],
      ['empty rationale', [fresh('No why', { rationale: '' })]],
      ['long rationale', [fresh('Long why', { rationale: 'r'.repeat(501) })]],
      ['session with aliases', [fresh('Sess', { kind: 'session', aliases: ['x'] })]],
      ['bad kind', [fresh('Kind', { kind: 'nope' as 'topic' })]],
      ['51 aliases', [fresh('Many', { aliases: Array.from({ length: 51 }, (_, i) => `a${i}`) })]],
      [
        'same page twice',
        [edit(page.id, 1, 'Shape page', 'a'), edit(page.id, 1, 'Shape page', 'b')],
      ],
      ['same new title twice', [fresh('Twice Café'), fresh('twice cafe')]],
    ] as const) {
      const e = await rejection(owner().wiki.saveRun('s1', 'sa', 'run-shape', [...proposals]));
      expect(e, label).toBeInstanceOf(WikiInvalidError);
    }
    expect(await suggestionCount()).toBe(n);
  });

  it('an ungranted member can store nothing for the show', async () => {
    const n = await suggestionCount();
    expect(
      await rejection(as('ungranted').wiki.saveRun('s1', 'ss1', 'run-ug', [fresh('Ungranted')])),
    ).toBeInstanceOf(Error);
    expect(await suggestionCount()).toBe(n);
  });
});

describe('listSuggestions and getSuggestion', () => {
  it('lists by status and page_id, newest first, with page state and stale', async () => {
    const a = await topic('List A');
    const b = await topic('List B');
    const [sa] = await owner().wiki.saveRun('s1', 'sc', 'run-l1', [edit(a.id, 1, 'List A', 'a1')]);
    await new Promise((r) => setTimeout(r, 5));
    const [sb] = await owner().wiki.saveRun('s1', 'sc', 'run-l2', [edit(b.id, 1, 'List B', 'b1')]);
    const pending = await owner().wiki.listSuggestions('s1');
    const ids = pending.suggestions.map((s) => s.id);
    expect(ids.indexOf(sb?.id as string)).toBeLessThan(ids.indexOf(sa?.id as string));
    expect(pending.truncated).toBe(false);
    expect(pending.suggestions.every((s) => s.status === 'pending')).toBe(true);

    const forA = await owner().wiki.listSuggestions('s1', { pageId: a.id });
    expect(forA.suggestions.map((s) => s.id)).toEqual([sa?.id]);

    await owner().wiki.updatePage(a.id, { expectedRevision: 1, bodyMd: 'edited by hand' });
    const [staleA] = (await owner().wiki.listSuggestions('s1', { pageId: a.id })).suggestions;
    expect(staleA).toMatchObject({ stale: true, page: { revision: 2, state: 'live' } });

    await owner().wiki.deletePage(b.id, 1);
    const [gone] = (await owner().wiki.listSuggestions('s1', { pageId: b.id })).suggestions;
    expect(gone?.page).toEqual({ title: 'List B', revision: 2, state: 'deleted' });

    await owner().wiki.dismissSuggestion(sa?.id as string);
    const dismissed = await owner().wiki.listSuggestions('s1', { status: 'dismissed' });
    expect(dismissed.suggestions.map((s) => s.id)).toContain(sa?.id);
    expect((await owner().wiki.listSuggestions('s1')).suggestions.map((s) => s.id)).not.toContain(
      sa?.id,
    );
  });

  it('a merged target reports state merged', async () => {
    const a = await topic('Merge src');
    const b = await topic('Merge dst');
    const [s] = await owner().wiki.saveRun('s1', 'sc', 'run-m', [edit(a.id, 1, 'Merge src', 'x')]);
    await owner().wiki.mergePage(a.id, b.id, 1, 1);
    const got = await owner().wiki.getSuggestion(s?.id as string);
    expect(got?.page?.state).toBe('merged');
  });

  it('caps the list at 500 with truncated', async () => {
    const rows = Array.from({ length: 501 }, (_, i) => ({
      id: `cap-${String(i).padStart(3, '0')}`,
      show_id: 'scap',
      session_id: 'scs',
      run_id: 'run-cap',
      kind: 'topic',
      title: `Cap ${i}`,
      body_md: '',
      aliases_json: sys.json([]),
      rationale: 'r',
      status: 'pending',
      created_by: 'owner',
      created_by_name: 'owner Fixture',
      created_at_utc: NOW,
    }));
    await sys`insert into wiki_suggestions ${sys(rows)}`;
    const list = await owner().wiki.listSuggestions('scap');
    expect(list.suggestions).toHaveLength(500);
    expect(list.truncated).toBe(true);
  });

  it('getSuggestion adds body_md; an inaccessible or missing one is null', async () => {
    const [s] = await owner().wiki.saveRun('s1', 'sc', 'run-g', [
      fresh('Get me', { bodyMd: 'The body.' }),
    ]);
    const got = await as('granted').wiki.getSuggestion(s?.id as string);
    expect(got).toMatchObject({ id: s?.id, body_md: 'The body.', title: 'Get me' });
    expect(await as('ungranted').wiki.getSuggestion(s?.id as string)).toBeNull();
    expect(await as('outsider').wiki.getSuggestion(s?.id as string)).toBeNull();
    expect(await owner().wiki.getSuggestion('no-such-suggestion')).toBeNull();
    expect((await as('ungranted').wiki.listSuggestions('s1')).suggestions).toEqual([]);
  });
});

describe('acceptSuggestion', () => {
  it('Accept writes a revision authored by the reviewer', async () => {
    const page = await topic('Accept page', { bodyMd: 'r1' });
    await owner().wiki.updatePage(page.id, { expectedRevision: 1, bodyMd: 'r2' });
    const [s] = await owner().wiki.saveRun('s1', 'sd', 'run-a', [
      { ...edit(page.id, 2, 'Accept page', 'suggested'), aliases: ['Accepted alias'] },
    ]);
    const id = s?.id as string;
    const out = await as('granted').wiki.acceptSuggestion(id, { expectedRevision: 2 });
    expect(out?.created).toBe(false);
    expect(out?.page).toMatchObject({
      id: page.id,
      revision: 3,
      body_md: 'suggested',
      aliases: ['Accepted alias'],
      updated_by_name: 'granted Fixture',
    });
    expect(out?.suggestion).toMatchObject({
      id,
      status: 'accepted',
      resolved_by_name: 'granted Fixture',
      resolved_revision: 3,
    });
    expect(out?.suggestion.resolved_at_utc).toMatch(/^\d{4}-\d\d-\d\dT/);
    const rev = await owner().wiki.getRevision(page.id, 3);
    expect(rev).toMatchObject({
      author_name: 'granted Fixture',
      note: `accepted suggestion ${id}`,
    });
    const [r] = await sys`select resolved_by from wiki_suggestions where id = ${id}`;
    expect(r?.resolved_by).toBe('granted');
  });

  it('Edit, then accept notes the revision `(edited)` and writes the edited values', async () => {
    const page = await topic('Edit accept', { bodyMd: 'r1' });
    const [s] = await owner().wiki.saveRun('s1', 'sd', 'run-e', [
      edit(page.id, 1, 'Edit accept', 'suggested'),
    ]);
    const id = s?.id as string;
    const out = await owner().wiki.acceptSuggestion(id, {
      expectedRevision: 1,
      bodyMd: 'reviewer text',
    });
    expect(out?.page.body_md).toBe('reviewer text');
    expect((await owner().wiki.getRevision(page.id, 2))?.note).toBe(
      `accepted suggestion ${id} (edited)`,
    );
    // An override equal to the suggestion's own value is not an edit.
    const p2 = await topic('Same override', { bodyMd: 'r1' });
    const [s2] = await owner().wiki.saveRun('s1', 'sd', 'run-e2', [
      edit(p2.id, 1, 'Same override', 'same'),
    ]);
    await owner().wiki.acceptSuggestion(s2?.id as string, {
      expectedRevision: 1,
      bodyMd: 'same',
      title: 'Same override',
      aliases: [],
    });
    expect((await owner().wiki.getRevision(p2.id, 2))?.note).toBe(`accepted suggestion ${s2?.id}`);
  });

  it('a new-page accept creates revision 1 noted `created from suggestion <id>`', async () => {
    const [s] = await owner().wiki.saveRun('s1', 'sd', 'run-np', [
      fresh('New from AI', { kind: 'bit', aliases: ['AI bit'], bodyMd: 'A bit.' }),
    ]);
    const id = s?.id as string;
    const out = await as('granted').wiki.acceptSuggestion(id, {});
    expect(out?.created).toBe(true);
    expect(out?.page).toMatchObject({
      show_id: 's1',
      kind: 'bit',
      title: 'New from AI',
      aliases: ['AI bit'],
      body_md: 'A bit.',
      session_id: null,
      revision: 1,
      created_by_name: 'granted Fixture',
    });
    expect(out?.suggestion).toMatchObject({ status: 'accepted', resolved_revision: 1 });
    expect((await owner().wiki.getRevision(out?.page.id as string, 1))?.note).toBe(
      `created from suggestion ${id}`,
    );
  });

  it('a session-kind accept gets the suggestion’s session', async () => {
    const [s] = await owner().wiki.saveRun('s1', 'se', 'run-sess', [
      fresh('Session se notes', { kind: 'session' }),
    ]);
    const out = await owner().wiki.acceptSuggestion(s?.id as string, { expectedRevision: 99 });
    expect(out?.page).toMatchObject({ kind: 'session', session_id: 'se', revision: 1 });
  });

  it('A stale accept is refused with the current page, and the suggestion stays pending', async () => {
    const page = await topic('Stale accept', { bodyMd: 'r1' });
    const [s] = await owner().wiki.saveRun('s1', 'sd', 'run-st', [
      edit(page.id, 1, 'Stale accept', 'suggested'),
    ]);
    await owner().wiki.updatePage(page.id, { expectedRevision: 1, bodyMd: 'r2' });
    const e = await rejection(
      owner().wiki.acceptSuggestion(s?.id as string, { expectedRevision: 1 }),
    );
    expect(e).toBeInstanceOf(WikiConflictError);
    expect((e as WikiConflictError).current).toMatchObject({ id: page.id, revision: 2 });
    expect(await statusOf(s?.id as string)).toBe('pending');
    expect((await owner().wiki.getPage(page.id))?.revision).toBe(2);
    // Against the newer revision the reviewer saw, the accept succeeds.
    const out = await owner().wiki.acceptSuggestion(s?.id as string, { expectedRevision: 2 });
    expect(out?.page).toMatchObject({ revision: 3, body_md: 'suggested' });
    expect(out?.suggestion).toMatchObject({ status: 'accepted', resolved_revision: 3 });
  });

  it('a no-op accept marks the suggestion accepted at the current revision', async () => {
    const page = await topic('Noop accept', { bodyMd: 'same' });
    const [s] = await owner().wiki.saveRun('s1', 'sd', 'run-noop', [
      edit(page.id, 1, 'Noop accept', 'same'),
    ]);
    const out = await owner().wiki.acceptSuggestion(s?.id as string, { expectedRevision: 1 });
    expect(out?.page.revision).toBe(1);
    expect(out?.suggestion).toMatchObject({ status: 'accepted', resolved_revision: 1 });
  });

  it('accept errors leave the suggestion pending', async () => {
    // Title taken: a page with the suggested title appears after the run.
    const [taken] = await owner().wiki.saveRun('s1', 'sd', 'run-err1', [fresh('Taken later')]);
    const holder = await topic('Taken Later');
    const e1 = await rejection(owner().wiki.acceptSuggestion(taken?.id as string, {}));
    expect(e1).toBeInstanceOf(WikiTitleTakenError);
    expect((e1 as WikiTitleTakenError).pageId).toBe(holder.id);

    // The session already has a page.
    const [sess] = await owner().wiki.saveRun('s1', 'sf', 'run-err2', [
      fresh('Session sf AI', { kind: 'session' }),
    ]);
    const sp = await owner().wiki.createPage('s1', {
      kind: 'session',
      title: 'Session sf by hand',
      sessionId: 'sf',
    });
    const e2 = await rejection(owner().wiki.acceptSuggestion(sess?.id as string, {}));
    expect(e2).toBeInstanceOf(WikiSessionTakenError);
    expect((e2 as WikiSessionTakenError).pageId).toBe(sp.id);

    // A merged target.
    const a = await topic('Err merged A');
    const b = await topic('Err merged B');
    const [m] = await owner().wiki.saveRun('s1', 'sd', 'run-err3', [
      edit(a.id, 1, 'Err merged A', 'x'),
    ]);
    await owner().wiki.mergePage(a.id, b.id, 1, 1);
    const e3 = await rejection(
      owner().wiki.acceptSuggestion(m?.id as string, { expectedRevision: 1 }),
    );
    expect(e3).toBeInstanceOf(WikiMergedError);
    expect((e3 as WikiMergedError).mergedInto).toBe(b.id);

    // A deleted target.
    const d = await topic('Err deleted');
    const [del] = await owner().wiki.saveRun('s1', 'sd', 'run-err4', [
      edit(d.id, 1, 'Err deleted', 'x'),
    ]);
    await owner().wiki.deletePage(d.id, 1);
    const e4 = await rejection(
      owner().wiki.acceptSuggestion(del?.id as string, { expectedRevision: 2 }),
    );
    expect(e4).toBeInstanceOf(WikiDeletedError);

    // A missing expected_revision for an existing page.
    const q = await topic('Err no revision');
    const [nr] = await owner().wiki.saveRun('s1', 'sd', 'run-err5', [
      edit(q.id, 1, 'Err no revision', 'x'),
    ]);
    const e5 = await rejection(owner().wiki.acceptSuggestion(nr?.id as string, {}));
    expect(e5).toBeInstanceOf(WikiInvalidError);
    expect((e5 as Error).message).toBe('expected_revision is required.');

    for (const s of [taken, sess, m, del, nr])
      expect(await statusOf(s?.id as string)).toBe('pending');
    expect((await owner().wiki.getPage(q.id))?.revision).toBe(1);
  });

  it('Accept twice, and dismiss after accept, raise WikiSuggestionResolvedError', async () => {
    const page = await topic('Twice', { bodyMd: 'r1' });
    const [s] = await owner().wiki.saveRun('s1', 'sd', 'run-tw', [edit(page.id, 1, 'Twice', 'x')]);
    const id = s?.id as string;
    await owner().wiki.acceptSuggestion(id, { expectedRevision: 1 });
    const e1 = await rejection(as('granted').wiki.acceptSuggestion(id, { expectedRevision: 2 }));
    expect(e1).toBeInstanceOf(WikiSuggestionResolvedError);
    expect((e1 as WikiSuggestionResolvedError).status).toBe('accepted');
    expect((e1 as Error).message).toBe('Suggestion already resolved.');
    const e2 = await rejection(owner().wiki.dismissSuggestion(id));
    expect(e2).toBeInstanceOf(WikiSuggestionResolvedError);
    expect((e2 as WikiSuggestionResolvedError).status).toBe('accepted');
    expect((await owner().wiki.getPage(page.id))?.revision).toBe(2);
  });
});

describe('dismissSuggestion', () => {
  it('records the reviewer and changes no page; a superseded one is resolved', async () => {
    const page = await topic('Dismiss me', { bodyMd: 'r1' });
    const [s] = await owner().wiki.saveRun('s1', 'sd', 'run-d', [
      edit(page.id, 1, 'Dismiss me', 'x'),
    ]);
    const out = await as('granted').wiki.dismissSuggestion(s?.id as string);
    expect(out).toMatchObject({
      status: 'dismissed',
      resolved_by_name: 'granted Fixture',
      resolved_revision: null,
    });
    expect(out?.resolved_at_utc).toMatch(/^\d{4}-\d\d-\d\dT/);
    const [r] = await sys`select resolved_by from wiki_suggestions where id = ${s?.id as string}`;
    expect(r?.resolved_by).toBe('granted');
    expect((await owner().wiki.getPage(page.id))?.revision).toBe(1);

    const [o] = await owner().wiki.saveRun('s1', 'sa', 'run-d2', [fresh('Dismiss superseded')]);
    await owner().wiki.saveRun('s1', 'sb', 'run-d3', [fresh('Dismiss superseded')]);
    const e = await rejection(owner().wiki.dismissSuggestion(o?.id as string));
    expect((e as WikiSuggestionResolvedError).status).toBe('superseded');
  });

  it('an ungranted member’s accept and dismiss see no suggestion', async () => {
    const [s] = await owner().wiki.saveRun('s1', 'sd', 'run-ug2', [fresh('Hidden from ungranted')]);
    const id = s?.id as string;
    expect(await as('ungranted').wiki.acceptSuggestion(id, {})).toBeNull();
    expect(await as('ungranted').wiki.dismissSuggestion(id)).toBeNull();
    expect(await as('outsider').wiki.dismissSuggestion(id)).toBeNull();
    expect(await statusOf(id)).toBe('pending');
  });
});

describe('read helpers for the wiki tools', () => {
  it('checkLinks gives the same answers as a manual save', async () => {
    const gone = await topic('Helper gone');
    await owner().wiki.deletePage(gone.id, 1);
    const ma = await topic('Helper merged A');
    const mb = await topic('Helper merged B');
    await owner().wiki.mergePage(ma.id, mb.id, 1, 1);
    const fine = `[a](wiki:${gone.id}) [b](wiki:${ma.id}) [c](cite:ss1@12)`;
    expect(await owner().wiki.checkLinks('s1', fine)).toEqual([]);
    expect(await owner().wiki.checkLinks('s1', 'no links at all')).toEqual([]);
    for (const body of [
      '[x](cite:ss2@0)',
      '[x](cite:ssu@0)',
      '[x](wiki:no-such-page)',
      '[x](cite:ss1@abc)',
    ]) {
      const manual = await rejection(topic(`Helper manual ${body}`, { bodyMd: body }));
      expect(manual).toBeInstanceOf(WikiInvalidError);
      expect(await owner().wiki.checkLinks('s1', body), body).toEqual([(manual as Error).message]);
    }
  });

  it('normalize folds case, accents and ß like the unique index, in order', async () => {
    const texts = ['Café NOIR', 'Straße', 'İstanbul', 'rock’n’roll', ''];
    const got = await owner().wiki.normalize(texts);
    const db = [];
    for (const t of texts) {
      const [r] = await sys`select catalog.search_norm(${t}) as n`;
      db.push(String(r?.n));
    }
    expect(got).toEqual(db);
    expect(got[0]).toBe('cafe noir');
    expect(got[1]).toBe((await owner().wiki.normalize(['STRASSE']))[0]);
    expect(await owner().wiki.normalize([])).toEqual([]);
  });

  it('nameHolder finds a live title or alias, not a deleted page', async () => {
    const p = await topic('Holder Title', { aliases: ['Holder Alias'] });
    expect(await owner().wiki.nameHolder('s1', ['holder title'])).toBe(p.id);
    expect(await owner().wiki.nameHolder('s1', ['nothing', 'HOLDER ÁLIAS'])).toBe(p.id);
    expect(await owner().wiki.nameHolder('s1', ['nothing here'])).toBeNull();
    expect(await owner().wiki.nameHolder('s2', ['Holder Title'])).toBeNull();
    await owner().wiki.deletePage(p.id, 1);
    expect(await owner().wiki.nameHolder('s1', ['Holder Title', 'Holder Alias'])).toBeNull();
  });

  it('pendingFor and pendingNewPages find the pending suggestions', async () => {
    const page = await topic('Pending helper', { bodyMd: 'base' });
    const [ps, ns] = await owner().wiki.saveRun('s1', 'sc', 'run-ph', [
      edit(page.id, 1, 'Pending helper', 'pending body'),
      fresh('Pending Nouvelle', { bodyMd: 'new body' }),
    ]);
    expect(await owner().wiki.pendingFor('s1', { pageId: page.id })).toMatchObject({
      id: ps?.id,
      body_md: 'pending body',
    });
    expect(await owner().wiki.pendingFor('s1', { normTitle: 'pending nouvelle' })).toMatchObject({
      id: ns?.id,
      body_md: 'new body',
    });
    expect(await owner().wiki.pendingFor('s1', { normTitle: 'no such title' })).toBeNull();
    expect(await owner().wiki.pendingFor('s2', { pageId: page.id })).toBeNull();
    expect(await as('ungranted').wiki.pendingFor('s1', { pageId: page.id })).toBeNull();
    const news = await owner().wiki.pendingNewPages('s1');
    expect(news.map((s) => s.id)).toContain(ns?.id);
    expect(news.every((s) => s.page_id === null && s.status === 'pending')).toBe(true);
    await owner().wiki.dismissSuggestion(ns?.id as string);
    expect((await owner().wiki.pendingNewPages('s1')).map((s) => s.id)).not.toContain(ns?.id);
    expect(await owner().wiki.pendingFor('s1', { pageId: 'no-such-page' })).toBeNull();
  });

  it('sessionPageId finds the live session page', async () => {
    expect(await owner().wiki.sessionPageId('s1', 'sc')).toBeNull();
    const sp = await owner().wiki.createPage('s1', {
      kind: 'session',
      title: 'Session sc page',
      sessionId: 'sc',
    });
    expect(await owner().wiki.sessionPageId('s1', 'sc')).toBe(sp.id);
    expect(await as('ungranted').wiki.sessionPageId('s1', 'sc')).toBeNull();
    await owner().wiki.deletePage(sp.id, 1);
    expect(await owner().wiki.sessionPageId('s1', 'sc')).toBeNull();
  });
});
