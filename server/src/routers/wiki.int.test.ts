// Wiki page routes (show-wiki task 4.2, design D3, D6; api-contract-freeze "Wiki page object",
// "Wiki page list and create endpoints", "Wiki page read, edit, delete and restore endpoints",
// "Wiki revision endpoints", "Wiki merge and split endpoints").
//
// Every request runs as a member of the show-access matrix (`seedAccessMatrix`): the granted
// member writes, the ungranted member and the outsider get the masked 404s. Success bodies are
// parsed with the contract's strict response schemas, so an extra or missing key fails here.

import {
  WIKI_DETAIL,
  wikiMergedConflictSchema,
  wikiMergeResponseSchema,
  wikiPageIdConflictSchema,
  wikiPageListResponseSchema,
  wikiPageSchema,
  wikiRevisionListResponseSchema,
  wikiRevisionSchema,
  wikiSplitResponseSchema,
  wikiVersionConflictSchema,
} from '@autologger/contract';
import { describe, expect, it } from 'vitest';
import { anonApp, app, env } from '../test/harness';
import {
  catalogFor,
  seedAccessMatrix,
  seedSession,
  seedShow,
  type TestCaller,
} from '../test/helpers';

type Json = Record<string, unknown>;

interface Sent {
  status: number;
  json: Json;
  res: Response;
}

async function send(who: TestCaller, method: string, path: string, body?: unknown): Promise<Sent> {
  const headers: Record<string, string> = { cookie: who.cookie };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await app.request(
    path,
    { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
    env,
  );
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : {}) as Json, res };
}

/** A show-access matrix plus a second show of the same team that the granted member also
 * reaches, with a session of its own (the "another show" cases). */
async function world() {
  const m = await seedAccessMatrix();
  const showB = await seedShow({ studioId: m.studioId, name: 'Other Show', code: 'OS' });
  const sessionB = await seedSession({ showId: showB });
  await catalogFor().auth.authGrantShow(m.granted.id, showB, m.owner.id, new Date().toISOString());
  const me = m.granted;
  const create = (body: unknown, showId = m.showId, who = me) =>
    send(who, 'POST', `/api/shows/${showId}/wiki/pages`, body);
  const page = async (body: Json, showId = m.showId) => {
    const r = await create(body, showId);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    return wikiPageSchema.parse(r.json);
  };
  const put = (id: string, body: unknown, who = me) =>
    send(who, 'PUT', `/api/wiki/pages/${id}`, body);
  /** Edits `id` until it reaches `revision`, each edit a new body line. */
  const bumpTo = async (id: string, revision: number) => {
    let cur = wikiPageSchema.parse((await send(me, 'GET', `/api/wiki/pages/${id}`)).json);
    while (cur.revision < revision) {
      const r = await put(id, {
        expected_revision: cur.revision,
        body_md: `${cur.body_md}line ${cur.revision}\n`,
      });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      cur = wikiPageSchema.parse(r.json);
    }
    return cur;
  };
  return { ...m, me, showB, sessionB, create, page, put, bumpTo };
}

function expectNoCookie(r: Sent) {
  expect(r.res.headers.get('set-cookie')).toBeNull();
}

// -- list and create -----------------------------------------------------------------------------

describe('GET and POST /api/shows/:showId/wiki/pages', () => {
  it('Create then list: 201 with revision 1, then the page in ?kind=person with truncated false', async () => {
    const w = await world();
    const created = await w.create({ kind: 'person', title: 'Christina Ramos' });
    expect(created.status).toBe(201);
    expectNoCookie(created);
    const p = wikiPageSchema.parse(created.json);
    expect(p).toMatchObject({
      show_id: w.showId,
      kind: 'person',
      title: 'Christina Ramos',
      body_md: '',
      aliases: [],
      session_id: null,
      revision: 1,
      merged_into: null,
      deleted: false,
      created_by_name: 'Test User',
      updated_by_name: 'Test User',
    });
    expect(p.created_at_utc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);

    const listed = await send(w.me, 'GET', `/api/shows/${w.showId}/wiki/pages?kind=person`);
    expect(listed.status).toBe(200);
    expectNoCookie(listed);
    const list = wikiPageListResponseSchema.parse(listed.json);
    expect(list.truncated).toBe(false);
    expect(list.pages).toEqual([
      {
        id: p.id,
        kind: 'person',
        title: 'Christina Ramos',
        aliases: [],
        session_id: null,
        revision: 1,
        updated_at_utc: p.updated_at_utc,
        updated_by_name: 'Test User',
      },
    ]);
  });

  it('creates with a body and aliases in the order sent, and the owner sees the page too', async () => {
    const w = await world();
    const p = await w.page({
      kind: 'bit',
      title: 'The Ladder',
      body_md: 'A running bit.',
      aliases: ['Ladder Bit', 'Step Ladder'],
    });
    expect(p.aliases).toEqual(['Ladder Bit', 'Step Ladder']);
    expect(p.body_md).toBe('A running bit.');
    const asOwner = await send(w.owner, 'GET', `/api/wiki/pages/${p.id}`);
    expect(asOwner.status).toBe(200);
    expect(wikiPageSchema.parse(asOwner.json).id).toBe(p.id);
  });

  it('sorts by title ignoring case and accents, filters by kind, session and deleted, and ignores unknown parameters', async () => {
    const w = await world();
    const zed = await w.page({ kind: 'topic', title: 'zed' });
    const eclair = await w.page({ kind: 'person', title: 'Éclair' });
    const apple = await w.page({ kind: 'person', title: 'apple' });
    const sess = await w.page({ kind: 'session', title: 'Session one', session_id: w.sessionId });
    const gone = await w.page({ kind: 'topic', title: 'Gone' });
    const del = await send(w.me, 'DELETE', `/api/wiki/pages/${gone.id}?expected_revision=1`);
    expect(del.status).toBe(200);

    const all = wikiPageListResponseSchema.parse(
      (await send(w.me, 'GET', `/api/shows/${w.showId}/wiki/pages?q=x&foo=bar`)).json,
    );
    expect(all.pages.map((p) => p.id)).toEqual([apple.id, eclair.id, sess.id, zed.id]);
    expect(all.truncated).toBe(false);

    const people = wikiPageListResponseSchema.parse(
      (await send(w.me, 'GET', `/api/shows/${w.showId}/wiki/pages?kind=person`)).json,
    );
    expect(people.pages.map((p) => p.id)).toEqual([apple.id, eclair.id]);

    const ofSession = wikiPageListResponseSchema.parse(
      (await send(w.me, 'GET', `/api/shows/${w.showId}/wiki/pages?session_id=${w.sessionId}`)).json,
    );
    expect(ofSession.pages.map((p) => p.id)).toEqual([sess.id]);
    expect(ofSession.pages[0]?.session_id).toBe(w.sessionId);

    const deleted = wikiPageListResponseSchema.parse(
      (await send(w.me, 'GET', `/api/shows/${w.showId}/wiki/pages?deleted=1`)).json,
    );
    expect(deleted.pages.map((p) => p.id)).toEqual([gone.id]);
  });

  it('does not list merged pages', async () => {
    const w = await world();
    const a = await w.page({ kind: 'person', title: 'Alpha' });
    const b = await w.page({ kind: 'person', title: 'Beta' });
    const merged = await send(w.me, 'POST', `/api/wiki/pages/${a.id}/merge`, {
      into_page_id: b.id,
      expected_revision: 1,
      into_expected_revision: 1,
    });
    expect(merged.status).toBe(200);
    for (const qs of ['', '?deleted=1']) {
      const list = wikiPageListResponseSchema.parse(
        (await send(w.me, 'GET', `/api/shows/${w.showId}/wiki/pages${qs}`)).json,
      );
      expect(list.pages.map((p) => p.id)).not.toContain(a.id);
    }
  });

  it.each([
    ['kind not one of the four', '?kind=villain'],
    ['deleted not 1', '?deleted=true'],
  ])('answers 422 with zod issues for a list query with %s', async (_n, qs) => {
    const w = await world();
    const r = await send(w.me, 'GET', `/api/shows/${w.showId}/wiki/pages${qs}`);
    expect(r.status).toBe(422);
    expect(Array.isArray(r.json.detail)).toBe(true);
  });

  it.each([
    ['no title', { kind: 'person' }],
    ['an empty title', { kind: 'person', title: '   ' }],
    ['a title of 201 characters', { kind: 'person', title: 'x'.repeat(201) }],
    ['a control character in the title', { kind: 'person', title: 'a\nb' }],
    ['an unknown kind', { kind: 'villain', title: 'X' }],
    ['a session kind with no session_id', { kind: 'session', title: 'S' }],
    ['a session_id on a person', { kind: 'person', title: 'P', session_id: 'abc' }],
    [
      '51 aliases',
      { kind: 'person', title: 'P', aliases: Array.from({ length: 51 }, (_, i) => `a${i}`) },
    ],
    ['a body over 100000 characters', { kind: 'person', title: 'P', body_md: 'x'.repeat(100_001) }],
  ])('answers 422 with zod issues for a create with %s', async (_n, body) => {
    const w = await world();
    const r = await w.create(body);
    expect(r.status).toBe(422);
    expect(Array.isArray(r.json.detail)).toBe(true);
  });

  it('answers 422 with the link named for a bad cite: or wiki: link', async () => {
    const w = await world();
    const bad = await w.create({
      kind: 'topic',
      title: 'T',
      body_md: 'see [x](wiki:no-such-page)',
    });
    expect(bad.status).toBe(422);
    expect(bad.json).toEqual({ detail: expect.stringContaining('wiki:no-such-page') });
    const grammar = await w.create({ kind: 'topic', title: 'T', body_md: '[q](cite:S1@abc)' });
    expect(grammar.status).toBe(422);
    expect(grammar.json).toEqual({ detail: expect.stringContaining('cite:S1@abc') });
    const otherShow = await w.create({
      kind: 'topic',
      title: 'T',
      body_md: `[q](cite:${w.sessionB}@12)`,
    });
    expect(otherShow.status).toBe(422);
    expect(otherShow.json).toEqual({ detail: expect.stringContaining(`cite:${w.sessionB}@12`) });
    // A good citation of the page's own show is accepted.
    const ok = await w.create({
      kind: 'topic',
      title: 'T',
      body_md: `[q](cite:${w.sessionId}@12)`,
    });
    expect(ok.status).toBe(201);
  });

  it('answers 422 with a detail string for a session of another show', async () => {
    const w = await world();
    const r = await w.create({ kind: 'session', title: 'S', session_id: w.sessionB });
    expect(r.status).toBe(422);
    expect(typeof r.json.detail).toBe('string');
    const unknown = await w.create({ kind: 'session', title: 'S', session_id: 'no-such-session' });
    expect(unknown.status).toBe(422);
    expect(typeof unknown.json.detail).toBe('string');
  });

  it('answers 409 Title already used. with the holder, for a title or an alias clash ignoring case and accents', async () => {
    const w = await world();
    const holder = await w.page({ kind: 'person', title: 'Café Noir', aliases: ['The Cafe'] });
    for (const body of [
      { kind: 'topic', title: 'cafe noir' },
      { kind: 'topic', title: 'Other', aliases: ['the café'] },
      { kind: 'topic', title: 'THE CAFE' },
    ]) {
      const r = await w.create(body);
      expect(r.status).toBe(409);
      expect(wikiPageIdConflictSchema.parse(r.json)).toEqual({
        detail: 'Title already used.',
        page_id: holder.id,
      });
    }
  });

  it('answers 409 Session already has a page. with that page', async () => {
    const w = await world();
    const first = await w.page({ kind: 'session', title: 'S1', session_id: w.sessionId });
    const r = await w.create({ kind: 'session', title: 'S2', session_id: w.sessionId });
    expect(r.status).toBe(409);
    expect(wikiPageIdConflictSchema.parse(r.json)).toEqual({
      detail: 'Session already has a page.',
      page_id: first.id,
    });
  });

  it('masks the show as 404 Show not found. for an ungranted member, an outsider and a nonexistent show', async () => {
    const w = await world();
    const cases: Array<[TestCaller, string]> = [
      [w.ungranted, w.showId],
      [w.nonMember, w.showId],
      [w.me, 'no-such-show'],
    ];
    for (const [who, showId] of cases) {
      const list = await send(who, 'GET', `/api/shows/${showId}/wiki/pages`);
      expect(list.status).toBe(404);
      expect(list.json).toEqual({ detail: 'Show not found.' });
      const made = await w.create({ kind: 'person', title: 'Sneaky' }, showId, who);
      expect(made.status).toBe(404);
      expect(made.json).toEqual({ detail: 'Show not found.' });
    }
    const list = wikiPageListResponseSchema.parse(
      (await send(w.me, 'GET', `/api/shows/${w.showId}/wiki/pages`)).json,
    );
    expect(list.pages).toEqual([]);
  });
});

// -- 401 for every route ---------------------------------------------------------------------------

describe('anonymous wiki requests', () => {
  it.each([
    ['GET', '/api/shows/s1/wiki/pages'],
    ['POST', '/api/shows/s1/wiki/pages'],
    ['GET', '/api/wiki/pages/p1'],
    ['PUT', '/api/wiki/pages/p1'],
    ['DELETE', '/api/wiki/pages/p1?expected_revision=1'],
    ['POST', '/api/wiki/pages/p1/restore'],
    ['GET', '/api/wiki/pages/p1/revisions'],
    ['GET', '/api/wiki/pages/p1/revisions/1'],
    ['POST', '/api/wiki/pages/p1/merge'],
    ['POST', '/api/wiki/pages/p1/split'],
  ])('answers 401 Login required. to %s %s', async (method, path) => {
    const res = await anonApp.request(
      path,
      {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'GET' || method === 'DELETE' ? undefined : '{}',
      },
      env,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ detail: 'Login required.' });
  });
});

// -- page-scoped masking ---------------------------------------------------------------------------

describe('page-scoped routes mask an inaccessible page', () => {
  it('answers 404 Page not found. to the ungranted member, the outsider and a nonexistent id, and changes nothing', async () => {
    const w = await world();
    const p = await w.page({ kind: 'person', title: 'Hidden', body_md: 'secret' });
    const target = await w.page({ kind: 'person', title: 'Target' });
    const routes = (id: string): Array<[string, string, unknown]> => [
      ['GET', `/api/wiki/pages/${id}`, undefined],
      ['PUT', `/api/wiki/pages/${id}`, { expected_revision: 1, title: 'Renamed' }],
      ['DELETE', `/api/wiki/pages/${id}?expected_revision=1`, undefined],
      ['POST', `/api/wiki/pages/${id}/restore`, { expected_revision: 1 }],
      ['GET', `/api/wiki/pages/${id}/revisions`, undefined],
      ['GET', `/api/wiki/pages/${id}/revisions/1`, undefined],
      [
        'POST',
        `/api/wiki/pages/${id}/merge`,
        { into_page_id: target.id, expected_revision: 1, into_expected_revision: 1 },
      ],
      [
        'POST',
        `/api/wiki/pages/${id}/split`,
        {
          expected_revision: 1,
          remaining_body_md: '',
          new_page: { kind: 'topic', title: 'Split off', body_md: 'secret' },
        },
      ],
    ];
    const cases: Array<[TestCaller, string]> = [
      [w.ungranted, p.id],
      [w.nonMember, p.id],
      [w.me, 'no-such-page'],
    ];
    for (const [who, id] of cases) {
      for (const [method, path, body] of routes(id)) {
        const r = await send(who, method, path, body);
        expect(r.status, `${method} ${path}`).toBe(404);
        expect(r.json, `${method} ${path}`).toEqual({ detail: 'Page not found.' });
      }
    }
    const after = wikiPageSchema.parse((await send(w.me, 'GET', `/api/wiki/pages/${p.id}`)).json);
    expect(after).toEqual(p);
    const t = wikiPageSchema.parse((await send(w.me, 'GET', `/api/wiki/pages/${target.id}`)).json);
    expect(t).toEqual(target);
  });
});

// -- read, edit, delete, restore -------------------------------------------------------------------

describe('GET and PUT /api/wiki/pages/:pageId', () => {
  it('reads the page object', async () => {
    const w = await world();
    const p = await w.page({ kind: 'topic', title: 'Read me', body_md: 'hi', aliases: ['RM'] });
    const r = await send(w.me, 'GET', `/api/wiki/pages/${p.id}`);
    expect(r.status).toBe(200);
    expectNoCookie(r);
    expect(wikiPageSchema.parse(r.json)).toEqual(p);
  });

  it('edits only the fields sent, replaces aliases, and bumps the revision', async () => {
    const w = await world();
    const p = await w.page({ kind: 'person', title: 'Ann', body_md: 'one', aliases: ['A1', 'A2'] });
    const r = await w.put(p.id, { expected_revision: 1, aliases: ['A3'] });
    expect(r.status).toBe(200);
    expectNoCookie(r);
    const e = wikiPageSchema.parse(r.json);
    expect(e).toMatchObject({ title: 'Ann', body_md: 'one', aliases: ['A3'], revision: 2 });
    const r2 = await w.put(p.id, {
      expected_revision: 2,
      title: 'Ann B',
      kind: 'topic',
      body_md: 'two',
    });
    expect(wikiPageSchema.parse(r2.json)).toMatchObject({
      title: 'Ann B',
      kind: 'topic',
      body_md: 'two',
      aliases: ['A3'],
      revision: 3,
    });
  });

  it('answers 200 with the unchanged page for a PUT that changes nothing', async () => {
    const w = await world();
    const p = await w.page({ kind: 'person', title: 'Same', body_md: 'b' });
    const r = await w.put(p.id, { expected_revision: 1, title: 'Same', body_md: 'b' });
    expect(r.status).toBe(200);
    expect(wikiPageSchema.parse(r.json)).toEqual(p);
  });

  it('labels a restore of an earlier revision restored rN', async () => {
    const w = await world();
    const p = await w.page({ kind: 'person', title: 'R', body_md: 'first' });
    await w.put(p.id, { expected_revision: 1, body_md: 'second' });
    const r = await w.put(p.id, { expected_revision: 2, body_md: 'first', restored_from: 1 });
    expect(r.status).toBe(200);
    expect(wikiPageSchema.parse(r.json).revision).toBe(3);
    const revs = wikiRevisionListResponseSchema.parse(
      (await send(w.me, 'GET', `/api/wiki/pages/${p.id}/revisions`)).json,
    );
    expect(revs.revisions.map((x) => x.note)).toEqual(['restored r1', 'edited', 'created']);
  });

  it('Stale edit: 409 Version conflict. with current.revision 4', async () => {
    const w = await world();
    const p = await w.page({ kind: 'person', title: 'Stale' });
    await w.bumpTo(p.id, 4);
    const r = await w.put(p.id, { expected_revision: 3, body_md: 'late' });
    expect(r.status).toBe(409);
    expectNoCookie(r);
    const c = wikiVersionConflictSchema.parse(r.json);
    expect(c.detail).toBe('Version conflict.');
    expect(c.current.revision).toBe(4);
    expect(c.current.id).toBe(p.id);
  });

  it('answers 409 Title already used. for a rename onto another live title or alias', async () => {
    const w = await world();
    const holder = await w.page({ kind: 'person', title: 'Holder', aliases: ['Nick'] });
    const p = await w.page({ kind: 'person', title: 'Mover' });
    for (const body of [
      { expected_revision: 1, title: 'holder' },
      { expected_revision: 1, aliases: ['NICK'] },
    ]) {
      const r = await w.put(p.id, body);
      expect(r.status).toBe(409);
      expect(wikiPageIdConflictSchema.parse(r.json)).toEqual({
        detail: WIKI_DETAIL.titleUsed,
        page_id: holder.id,
      });
    }
  });

  it('answers 409 Page is deleted. to an edit of a deleted page', async () => {
    const w = await world();
    const p = await w.page({ kind: 'person', title: 'Del' });
    await send(w.me, 'DELETE', `/api/wiki/pages/${p.id}?expected_revision=1`);
    const r = await w.put(p.id, { expected_revision: 2, body_md: 'x' });
    expect(r.status).toBe(409);
    expect(r.json).toEqual({ detail: 'Page is deleted.' });
  });

  it('answers 409 Page was merged. with merged_into to an edit of a merged page', async () => {
    const w = await world();
    const a = await w.page({ kind: 'person', title: 'MA' });
    const b = await w.page({ kind: 'person', title: 'MB' });
    await send(w.me, 'POST', `/api/wiki/pages/${a.id}/merge`, {
      into_page_id: b.id,
      expected_revision: 1,
      into_expected_revision: 1,
    });
    const r = await w.put(a.id, { expected_revision: 2, body_md: 'x' });
    expect(r.status).toBe(409);
    expect(wikiMergedConflictSchema.parse(r.json)).toEqual({
      detail: 'Page was merged.',
      merged_into: b.id,
    });
  });

  it('answers 422 with a detail string for a kind change to or from session', async () => {
    const w = await world();
    const p = await w.page({ kind: 'person', title: 'K' });
    const to = await w.put(p.id, { expected_revision: 1, kind: 'session' });
    expect(to.status).toBe(422);
    expect(typeof to.json.detail).toBe('string');
    const s = await w.page({ kind: 'session', title: 'SP', session_id: w.sessionId });
    const from = await w.put(s.id, { expected_revision: 1, kind: 'topic' });
    expect(from.status).toBe(422);
    expect(typeof from.json.detail).toBe('string');
  });

  it('answers 422 naming the link for a bad link in an edit', async () => {
    const w = await world();
    const p = await w.page({ kind: 'person', title: 'L' });
    const r = await w.put(p.id, { expected_revision: 1, body_md: '[x](wiki:missing-page)' });
    expect(r.status).toBe(422);
    expect(r.json).toEqual({ detail: expect.stringContaining('wiki:missing-page') });
  });

  it.each([
    ['no expected_revision', { title: 'x' }],
    ['expected_revision 0', { expected_revision: 0 }],
    ['expected_revision 1.5', { expected_revision: 1.5 }],
    ['a control character in an alias', { expected_revision: 1, aliases: ['a\tb'] }],
  ])('answers 422 with zod issues for a PUT with %s', async (_n, body) => {
    const w = await world();
    const p = await w.page({ kind: 'person', title: 'Z' });
    const r = await w.put(p.id, body);
    expect(r.status).toBe(422);
    expect(Array.isArray(r.json.detail)).toBe(true);
  });
});

describe('DELETE /api/wiki/pages/:pageId and POST …/restore', () => {
  it('soft-deletes and restores, each answering the page object', async () => {
    const w = await world();
    const p = await w.page({ kind: 'person', title: 'Bye', aliases: ['B1'] });
    const d = await send(w.me, 'DELETE', `/api/wiki/pages/${p.id}?expected_revision=1&x=y`);
    expect(d.status).toBe(200);
    expectNoCookie(d);
    expect(wikiPageSchema.parse(d.json)).toMatchObject({ deleted: true, revision: 2 });
    const r = await send(w.me, 'POST', `/api/wiki/pages/${p.id}/restore`, { expected_revision: 2 });
    expect(r.status).toBe(200);
    expectNoCookie(r);
    expect(wikiPageSchema.parse(r.json)).toMatchObject({
      deleted: false,
      revision: 3,
      aliases: ['B1'],
    });
  });

  it.each([
    ['no expected_revision', ''],
    ['expected_revision 0', '?expected_revision=0'],
    ['expected_revision not a number', '?expected_revision=abc'],
  ])('answers 422 with zod issues for a DELETE with %s', async (_n, qs) => {
    const w = await world();
    const p = await w.page({ kind: 'person', title: 'D' });
    const r = await send(w.me, 'DELETE', `/api/wiki/pages/${p.id}${qs}`);
    expect(r.status).toBe(422);
    expect(Array.isArray(r.json.detail)).toBe(true);
  });

  it('answers 409 Version conflict. to a stale delete or restore', async () => {
    const w = await world();
    const p = await w.page({ kind: 'person', title: 'S' });
    await w.bumpTo(p.id, 2);
    const d = await send(w.me, 'DELETE', `/api/wiki/pages/${p.id}?expected_revision=1`);
    expect(d.status).toBe(409);
    expect(wikiVersionConflictSchema.parse(d.json).current.revision).toBe(2);
    await send(w.me, 'DELETE', `/api/wiki/pages/${p.id}?expected_revision=2`);
    const r = await send(w.me, 'POST', `/api/wiki/pages/${p.id}/restore`, { expected_revision: 2 });
    expect(r.status).toBe(409);
    expect(wikiVersionConflictSchema.parse(r.json).current).toMatchObject({
      revision: 3,
      deleted: true,
    });
  });

  it('answers 409 Page is deleted. to a delete of a deleted page', async () => {
    const w = await world();
    const p = await w.page({ kind: 'person', title: 'Twice' });
    await send(w.me, 'DELETE', `/api/wiki/pages/${p.id}?expected_revision=1`);
    const r = await send(w.me, 'DELETE', `/api/wiki/pages/${p.id}?expected_revision=2`);
    expect(r.status).toBe(409);
    expect(r.json).toEqual({ detail: 'Page is deleted.' });
  });

  it('answers 409 Page is not deleted. to a restore of a live page', async () => {
    const w = await world();
    const p = await w.page({ kind: 'person', title: 'Live' });
    const r = await send(w.me, 'POST', `/api/wiki/pages/${p.id}/restore`, { expected_revision: 1 });
    expect(r.status).toBe(409);
    expect(r.json).toEqual({ detail: 'Page is not deleted.' });
  });

  it('answers 409 Page was merged. to a delete or restore of a merged page', async () => {
    const w = await world();
    const a = await w.page({ kind: 'person', title: 'A' });
    const b = await w.page({ kind: 'person', title: 'B' });
    await send(w.me, 'POST', `/api/wiki/pages/${a.id}/merge`, {
      into_page_id: b.id,
      expected_revision: 1,
      into_expected_revision: 1,
    });
    const d = await send(w.me, 'DELETE', `/api/wiki/pages/${a.id}?expected_revision=2`);
    expect(d.status).toBe(409);
    expect(d.json).toEqual({ detail: 'Page was merged.', merged_into: b.id });
    const r = await send(w.me, 'POST', `/api/wiki/pages/${a.id}/restore`, { expected_revision: 2 });
    expect(r.status).toBe(409);
    expect(r.json).toEqual({ detail: 'Page was merged.', merged_into: b.id });
  });

  it('answers 409 Title already used. to a restore whose title was taken meanwhile', async () => {
    const w = await world();
    const p = await w.page({ kind: 'person', title: 'Taken' });
    await send(w.me, 'DELETE', `/api/wiki/pages/${p.id}?expected_revision=1`);
    const holder = await w.page({ kind: 'topic', title: 'taken' });
    const r = await send(w.me, 'POST', `/api/wiki/pages/${p.id}/restore`, { expected_revision: 2 });
    expect(r.status).toBe(409);
    expect(r.json).toEqual({ detail: 'Title already used.', page_id: holder.id });
  });

  it('answers 409 Session already has a page. to a restore when the session has another page', async () => {
    const w = await world();
    const first = await w.page({ kind: 'session', title: 'S1', session_id: w.sessionId });
    await send(w.me, 'DELETE', `/api/wiki/pages/${first.id}?expected_revision=1`);
    const second = await w.page({ kind: 'session', title: 'S2', session_id: w.sessionId });
    const r = await send(w.me, 'POST', `/api/wiki/pages/${first.id}/restore`, {
      expected_revision: 2,
    });
    expect(r.status).toBe(409);
    expect(r.json).toEqual({ detail: 'Session already has a page.', page_id: second.id });
  });

  it('answers 422 with zod issues for a restore with no expected_revision', async () => {
    const w = await world();
    const p = await w.page({ kind: 'person', title: 'NR' });
    const r = await send(w.me, 'POST', `/api/wiki/pages/${p.id}/restore`, {});
    expect(r.status).toBe(422);
    expect(Array.isArray(r.json.detail)).toBe(true);
  });

  it('GET of a deleted page and of a merged page returns the aliases of its newest revision', async () => {
    const w = await world();
    const del = await w.page({ kind: 'person', title: 'Deleted One', aliases: ['D1', 'D2'] });
    await send(w.me, 'DELETE', `/api/wiki/pages/${del.id}?expected_revision=1`);
    const gd = wikiPageSchema.parse((await send(w.me, 'GET', `/api/wiki/pages/${del.id}`)).json);
    expect(gd).toMatchObject({ deleted: true, aliases: ['D1', 'D2'], revision: 2 });

    const a = await w.page({ kind: 'person', title: 'Merged One', aliases: ['M1', 'M2'] });
    const b = await w.page({ kind: 'person', title: 'Survivor' });
    await send(w.me, 'POST', `/api/wiki/pages/${a.id}/merge`, {
      into_page_id: b.id,
      expected_revision: 1,
      into_expected_revision: 1,
    });
    const ga = wikiPageSchema.parse((await send(w.me, 'GET', `/api/wiki/pages/${a.id}`)).json);
    expect(ga).toMatchObject({ merged_into: b.id, deleted: false, aliases: ['M1', 'M2'] });
  });
});

// -- revisions ----------------------------------------------------------------------------------

describe('GET /api/wiki/pages/:pageId/revisions[/:rev]', () => {
  it('lists revisions newest first with next_before null when none are left', async () => {
    const w = await world();
    const p = await w.page({ kind: 'person', title: 'Rev' });
    await w.put(p.id, { expected_revision: 1, title: 'Rev 2' });
    const r = await send(w.me, 'GET', `/api/wiki/pages/${p.id}/revisions`);
    expect(r.status).toBe(200);
    expectNoCookie(r);
    const list = wikiRevisionListResponseSchema.parse(r.json);
    expect(list.next_before).toBeNull();
    expect(list.revisions.map((x) => [x.revision, x.title, x.note, x.author_name])).toEqual([
      [2, 'Rev 2', 'edited', 'Test User'],
      [1, 'Rev', 'created', 'Test User'],
    ]);
  });

  it('Read an old revision: revision 1 of a page at revision 3 has its title, body and note created', async () => {
    const w = await world();
    const p = await w.page({ kind: 'person', title: 'Old', body_md: 'old body', aliases: ['O'] });
    await w.put(p.id, { expected_revision: 1, title: 'Newer', body_md: 'newer body' });
    await w.put(p.id, { expected_revision: 2, body_md: 'newest body' });
    const r = await send(w.me, 'GET', `/api/wiki/pages/${p.id}/revisions/1`);
    expect(r.status).toBe(200);
    expectNoCookie(r);
    const rev = wikiRevisionSchema.parse(r.json);
    expect(rev).toMatchObject({
      revision: 1,
      title: 'Old',
      kind: 'person',
      body_md: 'old body',
      aliases: ['O'],
      note: 'created',
      author_name: 'Test User',
    });
  });

  it('answers 404 Revision not found. for a revision that does not exist', async () => {
    const w = await world();
    const p = await w.page({ kind: 'person', title: 'One rev' });
    for (const rev of ['2', '0', 'abc', '99999999999999999999']) {
      const r = await send(w.me, 'GET', `/api/wiki/pages/${p.id}/revisions/${rev}`);
      expect(r.status, rev).toBe(404);
      expect(r.json).toEqual({ detail: 'Revision not found.' });
    }
  });

  it('Revisions page backwards: 120–71 with next_before 71, then 70–21', async () => {
    const w = await world();
    const p = await w.page({ kind: 'person', title: 'Long history' });
    await w.bumpTo(p.id, 120);
    const first = wikiRevisionListResponseSchema.parse(
      (await send(w.me, 'GET', `/api/wiki/pages/${p.id}/revisions?limit=50`)).json,
    );
    expect(first.revisions.map((x) => x.revision)).toEqual(
      Array.from({ length: 50 }, (_, i) => 120 - i),
    );
    expect(first.next_before).toBe(71);
    const second = wikiRevisionListResponseSchema.parse(
      (
        await send(
          w.me,
          'GET',
          `/api/wiki/pages/${p.id}/revisions?limit=50&before=${first.next_before}`,
        )
      ).json,
    );
    expect(second.revisions.map((x) => x.revision)).toEqual(
      Array.from({ length: 50 }, (_, i) => 70 - i),
    );
    expect(second.next_before).toBe(21);
    const dflt = wikiRevisionListResponseSchema.parse(
      (await send(w.me, 'GET', `/api/wiki/pages/${p.id}/revisions`)).json,
    );
    expect(dflt.revisions).toHaveLength(50);
  }, 60_000);

  it.each([
    ['limit 0', '?limit=0'],
    ['limit 101', '?limit=101'],
    ['limit not a number', '?limit=all'],
    ['before 0', '?before=0'],
  ])('answers 422 with zod issues for %s', async (_n, qs) => {
    const w = await world();
    const p = await w.page({ kind: 'person', title: 'Q' });
    const r = await send(w.me, 'GET', `/api/wiki/pages/${p.id}/revisions${qs}`);
    expect(r.status).toBe(422);
    expect(Array.isArray(r.json.detail)).toBe(true);
  });
});

// -- merge and split -----------------------------------------------------------------------------

describe('POST /api/wiki/pages/:pageId/merge', () => {
  const merge = (w: Awaited<ReturnType<typeof world>>, id: string, body: unknown) =>
    send(w.me, 'POST', `/api/wiki/pages/${id}/merge`, body);

  it('Merge answers the target: page.id B, page.revision 6, A’s title among page.aliases', async () => {
    const w = await world();
    const a = await w.page({ kind: 'person', title: 'Page A', body_md: 'a body' });
    const b = await w.page({ kind: 'person', title: 'Page B', body_md: 'b body' });
    await w.bumpTo(a.id, 2);
    await w.bumpTo(b.id, 5);
    const r = await merge(w, a.id, {
      into_page_id: b.id,
      expected_revision: 2,
      into_expected_revision: 5,
    });
    expect(r.status).toBe(200);
    expectNoCookie(r);
    const { page } = wikiMergeResponseSchema.parse(r.json);
    expect(page.id).toBe(b.id);
    expect(page.revision).toBe(6);
    expect(page.aliases).toContain('Page A');
    expect(page.body_md).toContain('a body');
    const ga = wikiPageSchema.parse((await send(w.me, 'GET', `/api/wiki/pages/${a.id}`)).json);
    expect(ga).toMatchObject({ merged_into: b.id, revision: 3 });
  });

  it('answers 409 Version conflict. with the stale page as current, for either side', async () => {
    const w = await world();
    const a = await w.page({ kind: 'person', title: 'SA' });
    const b = await w.page({ kind: 'person', title: 'SB' });
    await w.bumpTo(a.id, 2);
    await w.bumpTo(b.id, 3);
    const staleA = await merge(w, a.id, {
      into_page_id: b.id,
      expected_revision: 1,
      into_expected_revision: 3,
    });
    expect(staleA.status).toBe(409);
    expect(wikiVersionConflictSchema.parse(staleA.json).current).toMatchObject({
      id: a.id,
      revision: 2,
    });
    const staleB = await merge(w, a.id, {
      into_page_id: b.id,
      expected_revision: 2,
      into_expected_revision: 2,
    });
    expect(staleB.status).toBe(409);
    expect(wikiVersionConflictSchema.parse(staleB.json).current).toMatchObject({
      id: b.id,
      revision: 3,
    });
  });

  it('answers 404 Page not found. for a target that is missing, in another show, or not accessible', async () => {
    const w = await world();
    const a = await w.page({ kind: 'person', title: 'Here' });
    const elsewhere = await w.page({ kind: 'person', title: 'There' }, w.showB);
    // A page of a show the granted member can't reach: another team's show, created by its owner.
    const foreign = await seedAccessMatrix();
    const hidden = await send(foreign.owner, 'POST', `/api/shows/${foreign.showId}/wiki/pages`, {
      kind: 'person',
      title: 'Hidden target',
    });
    expect(hidden.status).toBe(201);
    const hiddenId = String(hidden.json.id);
    for (const into of ['no-such-page', elsewhere.id, hiddenId]) {
      const r = await merge(w, a.id, {
        into_page_id: into,
        expected_revision: 1,
        into_expected_revision: 1,
      });
      expect(r.status, into).toBe(404);
      expect(r.json).toEqual({ detail: 'Page not found.' });
    }
  });

  it('answers 422 with a detail string for a merge into itself or involving a session page', async () => {
    const w = await world();
    const a = await w.page({ kind: 'person', title: 'Self' });
    const self = await merge(w, a.id, {
      into_page_id: a.id,
      expected_revision: 1,
      into_expected_revision: 1,
    });
    expect(self.status).toBe(422);
    expect(typeof self.json.detail).toBe('string');
    const s = await w.page({ kind: 'session', title: 'Sess', session_id: w.sessionId });
    for (const [from, into] of [
      [a.id, s.id],
      [s.id, a.id],
    ] as const) {
      const r = await merge(w, from, {
        into_page_id: into,
        expected_revision: 1,
        into_expected_revision: 1,
      });
      expect(r.status).toBe(422);
      expect(typeof r.json.detail).toBe('string');
    }
  });

  it('answers 422 with a detail string when the merged body or aliases would exceed the limits', async () => {
    const w = await world();
    const a = await w.page({ kind: 'person', title: 'Big A', body_md: 'a'.repeat(60_000) });
    const b = await w.page({ kind: 'person', title: 'Big B', body_md: 'b'.repeat(60_000) });
    const body = await merge(w, a.id, {
      into_page_id: b.id,
      expected_revision: 1,
      into_expected_revision: 1,
    });
    expect(body.status).toBe(422);
    expect(typeof body.json.detail).toBe('string');

    const many = (p: string) => Array.from({ length: 30 }, (_, i) => `${p} alias ${i}`);
    const c = await w.page({ kind: 'person', title: 'Many C', aliases: many('c') });
    const d = await w.page({ kind: 'person', title: 'Many D', aliases: many('d') });
    const aliases = await merge(w, c.id, {
      into_page_id: d.id,
      expected_revision: 1,
      into_expected_revision: 1,
    });
    expect(aliases.status).toBe(422);
    expect(typeof aliases.json.detail).toBe('string');
  });

  it('answers 409 as for PUT when the target was deleted or merged', async () => {
    const w = await world();
    const a = await w.page({ kind: 'person', title: 'Src' });
    const gone = await w.page({ kind: 'person', title: 'Gone target' });
    await send(w.me, 'DELETE', `/api/wiki/pages/${gone.id}?expected_revision=1`);
    const del = await merge(w, a.id, {
      into_page_id: gone.id,
      expected_revision: 1,
      into_expected_revision: 2,
    });
    expect(del.status).toBe(409);
    expect(del.json).toEqual({ detail: 'Page is deleted.' });

    const x = await w.page({ kind: 'person', title: 'X' });
    const y = await w.page({ kind: 'person', title: 'Y' });
    await merge(w, x.id, { into_page_id: y.id, expected_revision: 1, into_expected_revision: 1 });
    const merged = await merge(w, a.id, {
      into_page_id: x.id,
      expected_revision: 1,
      into_expected_revision: 2,
    });
    expect(merged.status).toBe(409);
    expect(merged.json).toEqual({ detail: 'Page was merged.', merged_into: y.id });
  });

  it.each([
    ['no into_page_id', { expected_revision: 1, into_expected_revision: 1 }],
    ['no into_expected_revision', { into_page_id: 'x', expected_revision: 1 }],
  ])('answers 422 with zod issues for a merge with %s', async (_n, body) => {
    const w = await world();
    const a = await w.page({ kind: 'person', title: 'ZM' });
    const r = await merge(w, a.id, body);
    expect(r.status).toBe(422);
    expect(Array.isArray(r.json.detail)).toBe(true);
  });
});

describe('POST /api/wiki/pages/:pageId/split', () => {
  const split = (w: Awaited<ReturnType<typeof world>>, id: string, body: unknown) =>
    send(w.me, 'POST', `/api/wiki/pages/${id}/split`, body);

  it('answers 201 with the source page and the new page', async () => {
    const w = await world();
    const p = await w.page({ kind: 'topic', title: 'Whole', body_md: 'keep\n\nmove' });
    const r = await split(w, p.id, {
      expected_revision: 1,
      remaining_body_md: 'keep',
      new_page: { kind: 'bit', title: 'Moved', body_md: 'move', aliases: ['Mv'] },
    });
    expect(r.status).toBe(201);
    expectNoCookie(r);
    const out = wikiSplitResponseSchema.parse(r.json);
    expect(out.page).toMatchObject({ id: p.id, body_md: 'keep', revision: 2 });
    expect(out.new_page).toMatchObject({
      kind: 'bit',
      title: 'Moved',
      body_md: 'move',
      aliases: ['Mv'],
      revision: 1,
      show_id: w.showId,
    });
  });

  it('answers 422 for a session kind in the new page', async () => {
    const w = await world();
    const p = await w.page({ kind: 'topic', title: 'NoSess' });
    const r = await split(w, p.id, {
      expected_revision: 1,
      remaining_body_md: '',
      new_page: { kind: 'session', title: 'S', body_md: '' },
    });
    // api-contract-freeze delta: a `session` kind in a split is a rule 422 with a message.
    expect(r.status).toBe(422);
    expect(typeof r.json.detail).toBe('string');
  });

  it('answers 409 as for PUT: stale, deleted, merged and title clash', async () => {
    const w = await world();
    const holder = await w.page({ kind: 'person', title: 'Holder' });
    const p = await w.page({ kind: 'topic', title: 'Splittable' });
    await w.bumpTo(p.id, 2);
    const np = { kind: 'topic', title: 'Fresh', body_md: '' };
    const stale = await split(w, p.id, {
      expected_revision: 1,
      remaining_body_md: '',
      new_page: np,
    });
    expect(stale.status).toBe(409);
    expect(wikiVersionConflictSchema.parse(stale.json).current.revision).toBe(2);

    const clash = await split(w, p.id, {
      expected_revision: 2,
      remaining_body_md: '',
      new_page: { ...np, title: 'HOLDER' },
    });
    expect(clash.status).toBe(409);
    expect(clash.json).toEqual({ detail: 'Title already used.', page_id: holder.id });

    await send(w.me, 'DELETE', `/api/wiki/pages/${p.id}?expected_revision=2`);
    const del = await split(w, p.id, { expected_revision: 3, remaining_body_md: '', new_page: np });
    expect(del.status).toBe(409);
    expect(del.json).toEqual({ detail: 'Page is deleted.' });

    const a = await w.page({ kind: 'person', title: 'MA2' });
    await send(w.me, 'POST', `/api/wiki/pages/${a.id}/merge`, {
      into_page_id: holder.id,
      expected_revision: 1,
      into_expected_revision: 1,
    });
    const merged = await split(w, a.id, {
      expected_revision: 2,
      remaining_body_md: '',
      new_page: np,
    });
    expect(merged.status).toBe(409);
    expect(merged.json).toEqual({ detail: 'Page was merged.', merged_into: holder.id });
  });

  it('answers 422 with zod issues for a split with no new_page', async () => {
    const w = await world();
    const p = await w.page({ kind: 'topic', title: 'NoNew' });
    const r = await split(w, p.id, { expected_revision: 1, remaining_body_md: '' });
    expect(r.status).toBe(422);
    expect(Array.isArray(r.json.detail)).toBe(true);
  });

  it('answers 422 naming the link for a bad link in the new page', async () => {
    const w = await world();
    const p = await w.page({ kind: 'topic', title: 'LinkSplit' });
    const r = await split(w, p.id, {
      expected_revision: 1,
      remaining_body_md: '',
      new_page: { kind: 'topic', title: 'L2', body_md: '[x](wiki:nope)' },
    });
    expect(r.status).toBe(422);
    expect(r.json).toEqual({ detail: expect.stringContaining('wiki:nope') });
  });
});
