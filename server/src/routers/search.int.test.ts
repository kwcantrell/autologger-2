// GET /api/search (catalog-search task 4.2, design D5, D7; api-contract-freeze "Search endpoint";
// catalog-search "Concurrency" and "Searches can't starve the app"). The route parses the query,
// runs one `catalog.search` under the caller's binding and answers the strict result body, or a
// 503 when the search timed out or no search slot freed within 1 s.
//
// Faults are injected below the store, at the catalog adapter (`envWith({}, {catalog})`), so the
// real `SearchStore` maps them: a `57014` from the search statement, or a `CatalogTxTimeoutError`.
// Slow searches are held with a `GatedCatalog`: a held search keeps its transaction open, as a slow
// one would.

import {
  SEARCH_BUSY_DETAIL,
  SEARCH_TIMEOUT_DETAIL,
  searchResponseSchema,
} from '@autologger/contract';
import type { CatalogDb, CatalogRoot } from '@autologger/ports';
import { CatalogTxTimeoutError } from '@autologger/storage';
import { describe, expect, it } from 'vitest';
import { GatedCatalog } from '../test/gatedCatalog';
import { anonApp, app, env, envWith } from '../test/harness';
import {
  catalogFor,
  loginCookie,
  seedMemberStudio,
  seedShow,
  seedStudio,
  seedUser,
  testDb,
} from '../test/helpers';

const NOW = '2026-10-12T10:00:00.000Z';
const SEARCH_SQL = /catalog\.search\(/;

async function get(path: string, init: RequestInit = {}, e = env) {
  const res = await app.request(path, init, e);
  return { status: res.status, json: (await res.json()) as Record<string, unknown>, res };
}

/** A studio the default caller administers, holding the word `beacon` in every searchable place:
 * the studio and show names, a session's title and notes, a transcript word, a topic and an event. */
async function seedBeacon() {
  const studioId = await seedMemberStudio({ name: 'Beacon Studio' });
  const showId = await seedShow({ studioId, name: 'Beacon Show', code: 'BS' });
  const sessionId = await catalogFor().sessions.createSessionIndex({
    showId,
    title: 'Beacon session',
    frameRate: 24,
    startOffsetFrames: 0,
    episode: '007',
    notes: 'notes about the beacon',
    startedAtUtc: NOW,
    createdAtUtc: NOW,
  });
  const db = testDb();
  const words = ['we', 'lit', 'the', 'beacon', 'tonight'];
  for (const [i, word] of words.entries()) {
    await db.run(
      `INSERT INTO session_transcript_words
         (session_id, id, session_time, speaker, word, start_sec, end_sec, ordinal, created_at_utc)
       VALUES (?, ?, '', 'Ann', ?, ?, ?, ?, ?)`,
      sessionId,
      `w${i}`,
      word,
      12 + i,
      12.5 + i,
      i,
      NOW,
    );
  }
  await db.run(
    `INSERT INTO session_topics (session_id, id, summary, ordinal, created_at_utc)
     VALUES (?, 'topic-1', 'Talk about the beacon', 0, ?)`,
    sessionId,
    NOW,
  );
  await db.run(
    `INSERT INTO session_events (session_id, id, wall_time_utc, frame_rate, category, message)
     VALUES (?, 'event-1', ?, 24, 'cam', 'beacon on camera')`,
    sessionId,
    NOW,
  );
  return { studioId, showId, sessionId };
}

/** A catalog adapter whose search statement fails with `fault()`; everything else passes through. */
class FaultyHandle implements CatalogDb {
  constructor(
    private readonly inner: CatalogDb,
    private readonly fault: () => Error,
  ) {}
  all<T = Record<string, unknown>>(sql: string, ...binds: unknown[]): Promise<T[]> {
    return this.inner.all<T>(sql, ...binds);
  }
  first<T = Record<string, unknown>>(sql: string, ...binds: unknown[]): Promise<T | null> {
    if (SEARCH_SQL.test(sql)) return Promise.reject(this.fault());
    return this.inner.first<T>(sql, ...binds);
  }
  run(sql: string, ...binds: unknown[]): Promise<{ changes: number }> {
    return this.inner.run(sql, ...binds);
  }
  tx<T>(fn: (t: CatalogDb) => Promise<T>): Promise<T> {
    return this.inner.tx((t) => fn(new FaultyHandle(t, this.fault)));
  }
}

function faultyCatalog(fault: () => Error): CatalogRoot {
  const root = env.ports.catalog;
  return {
    bindUser: (id) => new FaultyHandle(root.bindUser(id), fault),
    bindSystem: (reason) => new FaultyHandle(root.bindSystem(reason), fault),
    close: () => root.close(),
  };
}

/** Every catalog table's row count, and each session's revision. */
async function snapshot(): Promise<{ counts: Record<string, number>; revisions: unknown[] }> {
  const db = testDb();
  const tables = await db.all<{ t: string }>(
    `SELECT table_name AS t FROM information_schema.tables
     WHERE table_schema = 'catalog' AND table_type = 'BASE TABLE' ORDER BY table_name`,
  );
  const counts: Record<string, number> = {};
  for (const { t } of tables) {
    const row = await db.first<{ n: number }>(`SELECT COUNT(*)::int AS n FROM catalog.${t}`);
    counts[t] = Number(row?.n);
  }
  const revisions = await db.all('SELECT id, revision FROM sessions ORDER BY id');
  return { counts, revisions };
}

describe('GET /api/search', () => {
  it('answers 200 with the full shape: every group, snippets, sec and match', async () => {
    const { studioId, showId, sessionId } = await seedBeacon();
    const { status, json, res } = await get('/api/search?q=%20%20beacon%20');
    expect(status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = searchResponseSchema.parse(json);
    expect(body.q).toBe('beacon');
    expect(body.studios).toEqual([{ id: studioId, name: 'Beacon Studio' }]);
    expect(body.shows).toEqual([{ id: showId, name: 'Beacon Show', studio_id: studioId }]);
    expect(body.sessions).toEqual([
      {
        id: sessionId,
        title: 'Beacon session',
        episode: '007',
        show_id: showId,
        studio_id: studioId,
        started_at_utc: NOW,
        archived: false,
        match: 'title',
        snippet: null,
      },
    ]);
    const byKind = Object.fromEntries(body.moments.map((m) => [m.kind, m]));
    expect(Object.keys(byKind).sort()).toEqual(['event', 'topic', 'transcript']);
    expect(byKind.transcript).toMatchObject({
      session_id: sessionId,
      session_title: 'Beacon session',
      show_id: showId,
      id: '0',
      sec: 12,
      speaker: 'Ann',
    });
    expect(byKind.transcript.snippet).toContain('beacon');
    expect(byKind.topic).toMatchObject({ id: 'topic-1', sec: null, speaker: '' });
    expect(byKind.topic.snippet).toContain('beacon');
    expect(byKind.event).toMatchObject({ id: 'event-1', sec: null, speaker: '' });
  });

  it('honours limit per group', async () => {
    const { showId } = await seedBeacon();
    for (const t of ['Beacon two', 'Beacon three']) {
      await catalogFor().sessions.createSessionIndex({
        showId,
        title: t,
        frameRate: 24,
        startOffsetFrames: 0,
        episode: '',
        notes: '',
        startedAtUtc: NOW,
        createdAtUtc: NOW,
      });
    }
    const all = searchResponseSchema.parse((await get('/api/search?q=beacon')).json);
    expect(all.sessions).toHaveLength(3);
    const one = searchResponseSchema.parse((await get('/api/search?q=beacon&limit=1')).json);
    expect(one.sessions).toHaveLength(1);
    expect(one.moments).toHaveLength(1);
  });

  it('answers 401 to an anonymous caller', async () => {
    const res = await anonApp.request('/api/search?q=beacon', {}, env);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ detail: 'Login required.' });
  });

  it.each([
    ['q missing', ''],
    ['q of 1 character', 'q=a'],
    ['q of 1 character after trimming', 'q=%20a%20%20'],
    ['q of 201 characters', `q=${'a'.repeat(201)}`],
    ['limit 0', 'q=beacon&limit=0'],
    ['limit 26', 'q=beacon&limit=26'],
    ['limit not a decimal integer', 'q=beacon&limit=2.5'],
    ['limit not a number', 'q=beacon&limit=all'],
  ])('answers 422 for %s', async (_name, qs) => {
    const { status, json } = await get(`/api/search?${qs}`);
    expect(status).toBe(422);
    expect(Array.isArray(json.detail)).toBe(true);
  });

  it('accepts q of 2 and 200 characters, and limit 25', async () => {
    expect((await get('/api/search?q=ab')).status).toBe(200);
    expect((await get(`/api/search?q=${'a'.repeat(200)}`)).status).toBe(200);
    expect((await get('/api/search?q=ab&limit=25')).status).toBe(200);
  });

  it('masks a foreign filter: identical to an unknown id apart from q', async () => {
    await seedBeacon();
    const foreignStudio = await seedStudio({ name: 'Beacon Foreign' });
    const foreignShow = await seedShow({ studioId: foreignStudio, name: 'Beacon Elsewhere' });
    // An outsider never sees the foreign team, filtered or not.
    const open = searchResponseSchema.parse((await get('/api/search?q=beacon')).json);
    expect(JSON.stringify(open)).not.toMatch(/Foreign|Elsewhere/);

    for (const param of ['show_id', 'studio_id']) {
      const id = param === 'show_id' ? foreignShow : foreignStudio;
      const foreign = await get(`/api/search?q=beacon&${param}=${id}`);
      const unknown = await get(`/api/search?q=beaco&${param}=no-such-id`);
      expect(foreign.status).toBe(200);
      expect(unknown.status).toBe(200);
      expect({ ...foreign.json, q: '' }).toEqual({ ...unknown.json, q: '' });
      expect(foreign.json).toEqual({
        q: 'beacon',
        studios: [],
        shows: [],
        sessions: [],
        moments: [],
      });
    }
  });

  it('narrows to a visible show filter', async () => {
    const { showId } = await seedBeacon();
    const other = await seedShow({ studioId: await seedMemberStudio(), name: 'Beacon Two' });
    const body = searchResponseSchema.parse(
      (await get(`/api/search?q=beacon&show_id=${showId}`)).json,
    );
    expect(body.shows.map((s) => s.id)).toEqual([showId]);
    expect(body.shows.map((s) => s.id)).not.toContain(other);
  });

  it('ignores unknown query parameters', async () => {
    await seedBeacon();
    const plain = await get('/api/search?q=beacon');
    const extra = await get('/api/search?q=beacon&page=2&sort=asc&q2=x&limit_x=99');
    expect(extra.status).toBe(200);
    expect(extra.json).toEqual(plain.json);
  });

  it('makes no writes and sets no cookie', async () => {
    await seedBeacon();
    const cookie = await loginCookie(await seedUser());
    await get('/api/search?q=warmup', { headers: { cookie } });
    const before = await snapshot();
    const { status, res } = await get('/api/search?q=beacon', { headers: { cookie } });
    expect(status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
    const { res: ownerRes } = await get('/api/search?q=beacon');
    expect(ownerRes.headers.get('set-cookie')).toBeNull();
    expect(await snapshot()).toEqual(before);
  });

  it('answers 503 timeout when the search statement is cancelled (57014)', async () => {
    const e = envWith(
      {},
      {
        catalog: faultyCatalog(() =>
          Object.assign(new Error('canceling statement due to statement timeout'), {
            code: '57014',
          }),
        ),
      },
    );
    const { status, json } = await get('/api/search?q=beacon', {}, e);
    expect(status).toBe(503);
    expect(json).toEqual({ detail: SEARCH_TIMEOUT_DETAIL });
    expect(SEARCH_TIMEOUT_DETAIL).toBe('Search timed out; try a more specific query.');
  });

  it('answers 503 timeout on a CatalogTxTimeoutError', async () => {
    const e = envWith(
      {},
      { catalog: faultyCatalog(() => new CatalogTxTimeoutError('catalog transaction exceeded')) },
    );
    const { status, json } = await get('/api/search?q=beacon', {}, e);
    expect(status).toBe(503);
    expect(json).toEqual({ detail: 'Search timed out; try a more specific query.' });
  });

  it('answers 503 busy when 2 searches hold the slots for over a second', async () => {
    await seedBeacon();
    const gated = new GatedCatalog(env.ports.catalog);
    const holds = [gated.hold(SEARCH_SQL), gated.hold(SEARCH_SQL)];
    const e = envWith({}, { catalog: gated });
    const running = [get('/api/search?q=beacon', {}, e), get('/api/search?q=beacon', {}, e)];
    await Promise.all(holds.map((h) => h.reached));
    const t0 = Date.now();
    const third = await get('/api/search?q=beacon', {}, e);
    expect(third.status).toBe(503);
    expect(third.json).toEqual({ detail: SEARCH_BUSY_DETAIL });
    expect(SEARCH_BUSY_DETAIL).toBe('Search is busy; try again.');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(950);
    for (const h of holds) h.release();
    for (const r of await Promise.all(running)) expect(r.status).toBe(200);
  });

  it("Searches can't starve the app: with 6 slow searches in flight, GET /api/profile completes", async () => {
    await seedBeacon();
    const gated = new GatedCatalog(env.ports.catalog);
    const holds = Array.from({ length: 6 }, () => gated.hold(SEARCH_SQL));
    const e = envWith({}, { catalog: gated });
    const searches = Array.from({ length: 6 }, () => get('/api/search?q=beacon', {}, e));
    await Promise.all(holds.slice(0, 2).map((h) => h.reached));
    // Two searches hold their transactions open; four wait for a search slot, holding none.
    const t0 = Date.now();
    const profile = await get('/api/profile');
    expect(profile.status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(gated.count(SEARCH_SQL)).toBe(2);
    // The four waiters give up after 1 s; then the two held searches finish.
    const settled: number[] = [];
    for (const s of searches) void s.then((r) => settled.push(r.status));
    await new Promise((r) => setTimeout(r, 1300));
    expect(settled.sort()).toEqual([503, 503, 503, 503]);
    for (const h of holds) h.release();
    const statuses = (await Promise.all(searches)).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 200, 503, 503, 503, 503]);
  });
});
