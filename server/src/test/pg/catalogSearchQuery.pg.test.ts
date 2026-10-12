// catalog-search design D5, D6, D8: `catalog.search` called as `catalog_user` with `app.user_id`
// set the way the app's transaction preamble sets it. Covers the groups, query syntax and
// normalisation, the access matrix, filters, limits, snippets, index use and the definer's
// search_path (catalog-search spec "Search covers names, session metadata and moments", "Search
// access matches the session lists", "Query syntax and normalisation", "Grouping, ranking and
// limits", "Snippets are plain text with sentinel highlights", "Filters and the timeout").

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../../test/pg/testDb';
import { type Actor, seedPolicyFixture, T, U, USERS } from './policyFixture';

const NOW = '2026-10-19T00:00:00.000Z';
const HL = '';
const HR = '';

const open: postgres.Sql[] = [];
function connect(o: TestDatabase['app']): postgres.Sql {
  const sql = postgres({ ...o, max: 1, onnotice: () => {} });
  open.push(sql);
  return sql;
}
afterAll(async () => {
  await Promise.all(open.splice(0).map((s) => s.end()));
});

interface Hit {
  id: string;
  [k: string]: unknown;
}
interface Moment {
  session_id: string;
  session_title: string;
  show_id: string;
  kind: 'transcript' | 'topic' | 'event';
  id: string;
  sec: number | null;
  speaker: string;
  snippet: string;
}
interface Result {
  q: string;
  studios: Hit[];
  shows: Hit[];
  sessions: Hit[];
  moments: Moment[];
}

interface SearchOpts {
  studio?: string | null;
  show?: string | null;
  limit?: number | null;
  /** Statements run as `catalog_user` in the same transaction, before the search. */
  before?: string[];
}

/** One search in one transaction, after the app's preamble (`postgresCatalogStore.ts` PREAMBLE):
 * role `catalog_user` and `app.user_id` = `uid` (`null` leaves `app.user_id` unset). */
async function search(
  sql: postgres.Sql,
  uid: string | null,
  q: string,
  opts: SearchOpts = {},
): Promise<Result> {
  return sql.begin(async (tx) => {
    await tx`select set_config('role', 'catalog_user', true),
                    set_config('app.user_id', ${uid ?? ''}, true)`;
    for (const stmt of opts.before ?? []) await tx.unsafe(stmt);
    const [r] = await tx`
      select catalog.search(${q}::text, ${opts.studio ?? null}::text, ${opts.show ?? null}::text,
                            ${opts.limit === undefined ? 5 : opts.limit}::int) as r`;
    return r?.r as Result;
  }) as Promise<Result>;
}

/** Words of `text`, one per space, at ordinals from `from`; timed from `sec` unless `untimed`. */
async function say(
  sys: postgres.Sql,
  sid: string,
  text: string,
  opts: { from?: number; sec?: number; untimed?: boolean; speaker?: string } = {},
) {
  const from = opts.from ?? 0;
  const sec = opts.sec ?? 1;
  const ws = text.split(' ').map((word, i) => ({
    id: `${sid}-w${from + i}`,
    speaker: opts.speaker ?? 'spk',
    word,
    start_sec: opts.untimed ? 0 : sec + i,
    end_sec: opts.untimed ? 0 : sec + i + 0.5,
    ordinal: from + i,
  }));
  await sys`
    insert into session_transcript_words
      (session_id, id, session_time, speaker, word, start_sec, end_sec, ordinal, created_at_utc)
    select ${sid}, r.id, '', r.speaker, r.word, r.start_sec, r.end_sec, r.ordinal, ${NOW}
    from json_to_recordset(${JSON.stringify(ws)}::text::json) as r(id text, speaker text,
      word text, start_sec double precision, end_sec double precision, ordinal bigint)`;
}

async function session(
  sys: postgres.Sql,
  id: string,
  show: string | null,
  f: { title?: string; episode?: string; notes?: string; started?: string; hidden?: boolean } = {},
) {
  await sys`insert into sessions (id, show_id, title, episode, notes, started_at_utc, ui_hidden)
            values (${id}, ${show}, ${f.title ?? ''}, ${f.episode ?? ''}, ${f.notes ?? ''},
                    ${f.started ?? NOW}, ${f.hidden ? 1 : 0})`;
}

async function topic(sys: postgres.Sql, sid: string, id: string, summary: string) {
  await sys`insert into session_topics (session_id, id, summary, ordinal, created_at_utc)
            values (${sid}, ${id}, ${summary}, 0, ${NOW})`;
}

async function event(sys: postgres.Sql, sid: string, id: string, message: string) {
  await sys`insert into session_events (session_id, id, wall_time_utc, frame_rate, category, message)
            values (${sid}, ${id}, ${NOW}, 24, 'c', ${message})`;
}

async function show(sys: postgres.Sql, id: string, studio: string, name: string) {
  await sys`insert into shows (id, studio_id, name, show_code, created_at_utc)
            values (${id}, ${studio}, ${name}, ${id.toUpperCase()}, ${NOW})`;
}

/** The comparable outline of a result: ids per group, a session's `match` and whether it has a
 * snippet, a moment's session and kind (moments sorted, since equal ranks tie on kind and id). */
function outline(r: Result) {
  return {
    studios: r.studios.map((s) => s.id),
    shows: r.shows.map((s) => s.id),
    sessions: r.sessions.map((s) => `${s.id}:${s.match}:${s.snippet === null ? '-' : 'snippet'}`),
    moments: r.moments.map((m) => `${m.session_id}:${m.kind}`).sort(),
  };
}

const EMPTY = { studios: [], shows: [], sessions: [], moments: [] };

/** The D6 fixture: the policy fixture's teams and actors, with distinct words in the names, the
 * session metadata and the content of `ss1` (show s1), `ss2` (s2) and `ssu` (team U's show su):
 * - studios T and U are both "Kestrel Works"; shows "Harbor Lights" (s1), "Desert Radio" (s2),
 *   "Quokka Hour" (su);
 * - ss1: title "Osprey beacon recap", episode "tidepool", notes "pelican beacon", transcript
 *   "the walrus sang beacon", topic "glacier beacon", event "volcano beacon";
 * - ss2: notes "pelican", transcript "walrus";
 * - ssu: title "Quokka diaries", notes "pelican", transcript "walrus", topic "glacier", event
 *   "volcano". */
async function seedMatrix(sys: postgres.Sql) {
  await seedPolicyFixture(sys);
  await sys`update studio_definitions set display_name = 'Kestrel Works' where id in (${T}, ${U})`;
  await sys`update shows set name = 'Harbor Lights' where id = 's1'`;
  await sys`update shows set name = 'Desert Radio' where id = 's2'`;
  await sys`update shows set name = 'Quokka Hour' where id = 'su'`;
  await sys`update sessions set title = 'Osprey beacon recap', episode = 'tidepool',
              notes = 'pelican beacon', started_at_utc = '2026-10-01T00:00:00Z' where id = 'ss1'`;
  await sys`update sessions set title = 'Plain session', notes = 'pelican',
              started_at_utc = '2026-09-01T00:00:00Z' where id = 'ss2'`;
  await sys`update sessions set title = 'Quokka diaries', notes = 'pelican' where id = 'ssu'`;
  await sys`delete from session_transcript_words where session_id in ('ss1', 'ssu')`;
  await say(sys, 'ss1', 'the walrus sang beacon', { sec: 3.25 });
  await say(sys, 'ss2', 'walrus');
  await say(sys, 'ssu', 'walrus');
  await sys`update session_topics set summary = 'glacier beacon' where session_id = 'ss1'`;
  await sys`update session_events set message = 'volcano beacon' where session_id = 'ss1'`;
  await sys`update session_topics set summary = 'glacier' where session_id = 'ssu'`;
  await sys`update session_events set message = 'volcano' where session_id = 'ssu'`;
}

describe('catalog.search: access (design D6)', () => {
  let db: TestDatabase;
  let app: postgres.Sql;
  beforeAll(async () => {
    db = await createTestDatabase();
    await seedMatrix(connect(db.system));
    app = connect(db.app);
  });

  it('the D6 matrix: owner, admin, granted, ungranted and outsider across every group', async () => {
    const T_FULL = {
      kestrel: { ...EMPTY, studios: [T] },
      'harbor lights': { ...EMPTY, shows: ['s1'] },
      osprey: { ...EMPTY, sessions: ['ss1:title:-'] },
      tidepool: { ...EMPTY, sessions: ['ss1:title:-'] },
      pelican: { ...EMPTY, sessions: ['ss1:notes:snippet', 'ss2:notes:snippet'] },
      walrus: { ...EMPTY, moments: ['ss1:transcript', 'ss2:transcript'] },
      glacier: { ...EMPTY, moments: ['ss1:topic'] },
      volcano: { ...EMPTY, moments: ['ss1:event'] },
      beacon: {
        ...EMPTY,
        sessions: ['ss1:title:-'],
        moments: ['ss1:event', 'ss1:topic', 'ss1:transcript'],
      },
    };
    const expected: Record<Actor, Record<string, unknown>> = {
      owner: T_FULL,
      admin: T_FULL,
      // A grant on s1 only: s2's notes and moments stay out.
      granted: {
        ...T_FULL,
        pelican: { ...EMPTY, sessions: ['ss1:notes:snippet'] },
        walrus: { ...EMPTY, moments: ['ss1:transcript'] },
      },
      // Names, titles and episodes only.
      ungranted: {
        ...T_FULL,
        pelican: EMPTY,
        walrus: EMPTY,
        glacier: EMPTY,
        volcano: EMPTY,
        beacon: { ...EMPTY, sessions: ['ss1:title:-'] },
      },
      // Team U only: its own studio (same name), its own session's notes and moments.
      outsider: {
        kestrel: { ...EMPTY, studios: [U] },
        'harbor lights': EMPTY,
        osprey: EMPTY,
        tidepool: EMPTY,
        pelican: { ...EMPTY, sessions: ['ssu:notes:snippet'] },
        walrus: { ...EMPTY, moments: ['ssu:transcript'] },
        glacier: { ...EMPTY, moments: ['ssu:topic'] },
        volcano: { ...EMPTY, moments: ['ssu:event'] },
        beacon: EMPTY,
      },
    };
    for (const actor of USERS) {
      for (const [q, want] of Object.entries(expected[actor])) {
        expect(outline(await search(app, actor, q)), `${actor} ${q}`).toEqual(want);
      }
    }
  });

  it('snippets: notes and moments highlight the hit; names and title matches carry none', async () => {
    const notes = await search(app, 'granted', 'pelican');
    expect(notes.sessions[0]?.snippet).toBe(`${HL}pelican${HR} beacon`);
    const beacon = await search(app, 'owner', 'beacon');
    expect(beacon.sessions[0]).toEqual({
      id: 'ss1',
      title: 'Osprey beacon recap',
      episode: 'tidepool',
      show_id: 's1',
      studio_id: T,
      started_at_utc: '2026-10-01T00:00:00Z',
      archived: false,
      match: 'title',
      snippet: null,
    });
    const byKind = Object.fromEntries(beacon.moments.map((m) => [m.kind, m]));
    expect(byKind.transcript).toMatchObject({
      session_id: 'ss1',
      session_title: 'Osprey beacon recap',
      show_id: 's1',
      id: '0',
      speaker: 'spk',
      // ts_headline drops the leading stop word.
      snippet: `walrus sang ${HL}beacon${HR}`,
    });
    expect(byKind.topic?.snippet).toBe(`glacier ${HL}beacon${HR}`);
    expect(byKind.event?.snippet).toBe(`volcano ${HL}beacon${HR}`);
    const names = await search(app, 'owner', 'harbor lights');
    expect(names.shows).toEqual([{ id: 's1', name: 'Harbor Lights', studio_id: T }]);
    const studios = await search(app, 'owner', 'kestrel');
    expect(studios.studios).toEqual([{ id: T, name: 'Kestrel Works' }]);
  });

  it('An ungranted member matches titles only: a word in title, notes and transcript', async () => {
    const r = await search(app, 'ungranted', 'beacon');
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0]).toMatchObject({ id: 'ss1', match: 'title', snippet: null });
    expect(r.moments).toEqual([]);
    expect(JSON.stringify(r)).not.toContain('pelican');
  });

  it('Other teams are invisible: the exact title of a session in another team', async () => {
    for (const q of ['Quokka diaries', 'Quokka Hour', 'quokka']) {
      const r = await search(app, 'owner', q);
      expect(outline(r), q).toEqual(EMPTY);
    }
    // The outsider, whose team it is, finds it.
    expect(outline(await search(app, 'outsider', 'Quokka diaries')).sessions).toEqual([
      'ssu:title:-',
    ]);
    expect(outline(await search(app, 'outsider', 'Quokka Hour')).shows).toEqual(['su']);
  });

  it('filters narrow every group; a foreign or unknown id gives identical empty groups', async () => {
    const queries = ['kestrel', 'harbor lights', 'osprey', 'pelican', 'walrus', 'beacon'];
    for (const q of queries) {
      const foreignShow = await search(app, 'owner', q, { show: 'su' });
      const unknownShow = await search(app, 'owner', q, { show: 'no-such-show' });
      const foreignStudio = await search(app, 'owner', q, { studio: U });
      const unknownStudio = await search(app, 'owner', q, { studio: 'no-such-studio' });
      expect(foreignShow, q).toEqual({ q, ...EMPTY });
      for (const r of [unknownShow, foreignStudio, unknownStudio])
        expect(r, q).toEqual(foreignShow);
      // A team the caller does belong to, but with no matching show (team V is empty).
      expect(outline(await search(app, 'owner', q, { studio: 'team-v' })), q).toEqual(EMPTY);
    }
    // To show s1: every result belongs to s1, and the studio group holds only s1's studio.
    for (const q of ['pelican', 'walrus', 'beacon', 'harbor lights', 'desert radio']) {
      const r = await search(app, 'owner', q, { show: 's1' });
      for (const s of r.shows) expect(s.id, q).toBe('s1');
      for (const s of r.sessions) expect(s.show_id, q).toBe('s1');
      for (const m of r.moments) expect(m.show_id, q).toBe('s1');
    }
    expect(outline(await search(app, 'owner', 'pelican', { show: 's1' })).sessions).toEqual([
      'ss1:notes:snippet',
    ]);
    expect(outline(await search(app, 'owner', 'desert radio', { show: 's1' })).shows).toEqual([]);
    expect(outline(await search(app, 'owner', 'kestrel', { show: 's1' })).studios).toEqual([T]);
    expect(outline(await search(app, 'owner', 'kestrel', { show: 'su' })).studios).toEqual([]);
    // To studio T.
    const inT = await search(app, 'owner', 'walrus', { studio: T });
    expect(outline(inT).moments).toEqual(['ss1:transcript', 'ss2:transcript']);
    // The outsider filtering by T sees nothing.
    expect(outline(await search(app, 'outsider', 'kestrel', { studio: T }))).toEqual(EMPTY);
  });

  it('a null app.user_id returns empty groups', async () => {
    expect(await search(app, null, 'beacon')).toEqual({ q: 'beacon', ...EMPTY });
    const unset = await app.begin(async (tx) => {
      await tx`select set_config('role', 'catalog_user', true)`;
      const [r] = await tx`select catalog.search('kestrel', null, null, 5) as r`;
      return r?.r as Result;
    });
    expect(unset).toEqual({ q: 'kestrel', ...EMPTY });
  });

  it("a temp table named sessions created by catalog_user doesn't change the results", async () => {
    const baseline = await search(app, 'ungranted', 'beacon');
    const shadowed = await search(app, 'ungranted', 'beacon', {
      before: [
        `create temp table sessions (id text, show_id text, title text, episode text, notes text,
           started_at_utc text, archived bigint, ui_hidden bigint, search_meta tsvector,
           search_notes tsvector) on commit drop`,
        `insert into sessions values ('evil', 's1', 'beacon', '', 'beacon', '', 0, 0,
           to_tsvector('beacon'), to_tsvector('beacon'))`,
        `create temp table shows (id text, studio_id text, name text) on commit drop`,
        `insert into shows values ('s1', 'evil-studio', 'beacon')`,
        `create temp table session_transcript_chunks (session_id text, bucket bigint,
           start_sec float8, speaker text, text text, search_tsv tsvector) on commit drop`,
        `insert into session_transcript_chunks values ('ss1', 9, 0, '', 'beacon', to_tsvector('beacon'))`,
      ],
    });
    expect(shadowed).toEqual(baseline);
    expect(outline(baseline).sessions).toEqual(['ss1:title:-']);
  });
});

describe('catalog.search: ranking and query syntax', () => {
  let db: TestDatabase;
  let app: postgres.Sql;
  let sys: postgres.Sql;
  beforeAll(async () => {
    db = await createTestDatabase();
    sys = connect(db.system);
    await seedPolicyFixture(sys);
    // Two s2 sessions with the same title; the ungranted member has no access to s2.
    await session(sys, 'hA', 's2', {
      title: 'Budget review',
      notes: 'zebra zebra zebra budget',
      started: '2026-09-01T00:00:00Z',
    });
    await session(sys, 'hB', 's2', {
      title: 'Budget review',
      notes: 'yak yak yak budget',
      started: '2026-09-02T00:00:00Z',
    });
    // Stemming and accents; phrases; exclusion.
    await session(sys, 'st', 's1', { title: 'Stemming' });
    await say(sys, 'st', 'they were divorced at the café');
    await session(sys, 'ph', 's1', { title: 'Phrases' });
    await say(sys, 'ph', 'the red balloon floated away');
    await say(sys, 'ph', 'a balloon that was red', { from: 40 });
    await session(sys, 'ex', 's1', { title: 'Exclusion' });
    await say(sys, 'ex', 'budget talks about the wedding');
    await say(sys, 'ex', 'budget only here', { from: 40 });
    // Names: a misspelling, accents, a stop-word show name.
    await show(sys, 'cr', T, 'Christina Ramos Live');
    await show(sys, 'cs', T, 'Café Society');
    await show(sys, 'ob', T, 'Out of the Box');
    await session(sys, 'ci', 'cr', { title: 'Christina interview' });
    await say(sys, 'ci', 'out of the box thinking');
    await sys`update studio_definitions set display_name = 'Ångström Labs' where id = ${T}`;
    // Hidden and showless sessions, with every field matching.
    for (const [id, showId, hidden] of [
      ['hz', 's1', true],
      ['nz', null, false],
    ] as const) {
      await session(sys, id, showId, {
        title: 'Zeppelin flight',
        episode: 'zeppelin',
        notes: 'zeppelin',
        hidden,
      });
      await say(sys, id, 'the zeppelin rose');
      await topic(sys, id, 't', 'zeppelin topic');
      await event(sys, id, 'e', 'zeppelin event');
    }
    app = connect(db.app);
  });

  it("Hidden notes don't affect ranking: an ungranted member's order is the same whichever note word is added", async () => {
    const a = await search(app, 'ungranted', 'budget or zebra');
    const b = await search(app, 'ungranted', 'budget or yak');
    expect(outline(a).sessions).toEqual(['hB:title:-', 'hA:title:-']);
    expect(outline(b).sessions).toEqual(outline(a).sessions);
    expect(JSON.stringify([a.sessions, b.sessions])).not.toMatch(/zebra|yak/u);
    // The note words alone find nothing for the ungranted member, and both for the owner.
    expect(outline(await search(app, 'ungranted', 'zebra')).sessions).toEqual([]);
    expect(outline(await search(app, 'owner', 'zebra')).sessions).toEqual(['hA:notes:snippet']);
  });

  it('stemming and accents: divorce cafe finds "they were divorced at the café"', async () => {
    for (const q of ['divorce cafe', 'DIVORCING Café', 'cafe']) {
      const r = await search(app, 'owner', q);
      expect(
        r.moments.map((m) => `${m.session_id}:${m.id}`),
        q,
      ).toEqual(['st:0']);
    }
    expect((await search(app, 'owner', 'divorce cafe')).moments[0]?.snippet).toBe(
      `they were ${HL}divorced${HR} at the ${HL}café${HR}`,
    );
    expect(outline(await search(app, 'owner', 'cafe society')).shows).toEqual(['cs']);
    expect(outline(await search(app, 'owner', 'CAFE')).shows).toEqual(['cs']);
    expect(outline(await search(app, 'owner', 'angstrom')).studios).toEqual([T]);
  });

  it('phrases, -exclusion and or', async () => {
    const ids = async (q: string) =>
      (await search(app, 'owner', q, { limit: 25 })).moments
        .map((m) => `${m.session_id}:${m.id}`)
        .sort();
    expect(await ids('"red balloon"')).toEqual(['ph:0']);
    expect(await ids('red balloon')).toEqual(['ph:0', 'ph:1']);
    expect(await ids('budget -wedding')).toEqual(['ex:1']);
    expect(await ids('budget')).toEqual(['ex:0', 'ex:1']);
    expect(await ids('wedding or floated')).toEqual(['ex:0', 'ph:0']);
  });

  it('a misspelled or partial name: christna finds the show, the session title and the studio', async () => {
    const r = await search(app, 'owner', 'christna');
    expect(outline(r).shows).toEqual(['cr']);
    expect(outline(r).sessions).toEqual(['ci:title:-']);
    expect(outline(await search(app, 'owner', 'ramos')).shows).toEqual(['cr']);
    expect(outline(await search(app, 'owner', 'angstrm')).studios).toEqual([T]);
  });

  it('a stop-words-only query still runs name matching and does not fail', async () => {
    const r = await search(app, 'owner', 'of the');
    expect(outline(r).shows).toEqual(['ob']);
    // The transcript "out of the box thinking" is not a moment: the full-text query is empty.
    expect(r.moments).toEqual([]);
    expect(outline(await search(app, 'owner', 'the')).moments).toEqual([]);
  });

  it('hidden and showless sessions never match, in any group', async () => {
    for (const actor of ['owner', 'admin', 'granted'] as const) {
      expect(outline(await search(app, actor, 'zeppelin', { limit: 25 })), actor).toEqual(EMPTY);
      expect(outline(await search(app, actor, 'Zeppelin flight', { limit: 25 })), actor).toEqual(
        EMPTY,
      );
    }
    // Unhidden, the same session matches in every group it has content for (runs last here).
    await sys`update sessions set ui_hidden = 0 where id = 'hz'`;
    const r = outline(await search(app, 'owner', 'zeppelin', { limit: 25 }));
    expect(r.sessions).toEqual(['hz:title:-']);
    expect(r.moments).toEqual(['hz:event', 'hz:topic', 'hz:transcript']);
  });
});

describe('catalog.search: limits, sec and snippets', () => {
  let db: TestDatabase;
  let app: postgres.Sql;
  let sys: postgres.Sql;
  beforeAll(async () => {
    db = await createTestDatabase();
    sys = connect(db.system);
    await seedPolicyFixture(sys);
    for (let i = 0; i < 30; i++) await show(sys, `nb${i}`, T, `Nebula ${i}`);
    // 10 matching passages in mA (newer), one in mB (older).
    await session(sys, 'mA', 's1', { title: 'A', started: '2026-10-02T00:00:00Z' });
    await session(sys, 'mB', 's1', { title: 'B', started: '2026-10-01T00:00:00Z' });
    for (let b = 0; b < 10; b++) await say(sys, 'mA', 'the mongoose ran', { from: b * 40 });
    await say(sys, 'mB', 'the mongoose ran');
    // sec: a timed passage, an untimed one, a topic and an event.
    await session(sys, 'sc', 's1', { title: 'Sec' });
    await say(sys, 'sc', 'an ocelot appears', { sec: 12.5, speaker: 'Ana' });
    await say(sys, 'sc', 'another ocelot appears', { from: 40, untimed: true, speaker: 'Bo' });
    await session(sys, 'sd', 's1', { title: 'Sec two' });
    await topic(sys, 'sd', 't1', 'ocelot topic');
    await event(sys, 'sd', 'e1', 'ocelot event');
    // An accented hit at word 35 of a 40-word passage.
    await session(sys, 'ac', 's1', { title: 'Accent' });
    const forty = Array.from({ length: 40 }, (_, i) => (i === 34 ? 'Café' : `filler${i}`));
    await say(sys, 'ac', forty.join(' '));
    // Forged sentinels in an event, a passage and notes, around a word that doesn't match.
    await session(sys, 'fg', 's1', {
      title: 'Forged',
      notes: `${HL}decoy${HR} then falcon`,
    });
    await event(sys, 'fg', 'e1', `${HL}decoy${HR} and the falcon`);
    await say(sys, 'fg', `${HL}decoy${HR} near a falcon`);
    // Markup in a passage is plain text in the snippet.
    await session(sys, 'mk', 's1', { title: 'Markup' });
    await say(sys, 'mk', '<img src=x onerror=alert(1)> heron');
    app = connect(db.app);
  });

  it('limits: default 5, at most 25, at least 1', async () => {
    expect((await search(app, 'owner', 'nebula', { limit: null })).shows).toHaveLength(5);
    expect((await search(app, 'owner', 'nebula')).shows).toHaveLength(5);
    expect((await search(app, 'owner', 'nebula', { limit: 25 })).shows).toHaveLength(25);
    expect((await search(app, 'owner', 'nebula', { limit: 100 })).shows).toHaveLength(25);
    expect((await search(app, 'owner', 'nebula', { limit: 0 })).shows).toHaveLength(1);
    expect((await search(app, 'owner', 'nebula', { limit: -3 })).shows).toHaveLength(1);
    expect((await search(app, 'owner', 'nebula', { limit: 7 })).shows).toHaveLength(7);
  });

  it("One long session can't fill the moments group: at most 3 per session", async () => {
    const r = await search(app, 'owner', 'mongoose', { limit: 5 });
    expect(r.moments.map((m) => m.session_id)).toEqual(['mA', 'mA', 'mA', 'mB']);
    const all = await search(app, 'owner', 'mongoose', { limit: 25 });
    expect(all.moments.map((m) => m.session_id)).toEqual(['mA', 'mA', 'mA', 'mB']);
  });

  it('sec: a passage start time, null when untimed, and null for topics and events', async () => {
    const r = await search(app, 'owner', 'ocelot', { limit: 25 });
    const got = r.moments
      .map((m) => ({ s: m.session_id, kind: m.kind, id: m.id, sec: m.sec, speaker: m.speaker }))
      .sort((a, b) => `${a.s}${a.kind}${a.id}`.localeCompare(`${b.s}${b.kind}${b.id}`));
    expect(got).toEqual([
      { s: 'sc', kind: 'transcript', id: '0', sec: 12.5, speaker: 'Ana' },
      { s: 'sc', kind: 'transcript', id: '1', sec: null, speaker: 'Bo' },
      { s: 'sd', kind: 'event', id: 'e1', sec: null, speaker: '' },
      { s: 'sd', kind: 'topic', id: 't1', sec: null, speaker: '' },
    ]);
  });

  it('An accented hit is highlighted: Café at word 35, searched as cafe', async () => {
    const r = await search(app, 'owner', 'cafe');
    expect(r.moments).toHaveLength(1);
    expect(r.moments[0]?.snippet).toContain(`${HL}Café${HR}`);
  });

  it('Forged sentinels are stripped: only the real hit is highlighted', async () => {
    const r = await search(app, 'owner', 'falcon', { limit: 25 });
    const snippets = [
      ...r.sessions.map((s) => String(s.snippet)),
      ...r.moments.map((m) => m.snippet),
    ];
    expect(outline(r).sessions).toEqual(['fg:notes:snippet']);
    expect(outline(r).moments).toEqual(['fg:event', 'fg:transcript']);
    expect(snippets.sort()).toEqual(
      [
        `decoy then ${HL}falcon${HR}`,
        `decoy and the ${HL}falcon${HR}`,
        `decoy near a ${HL}falcon${HR}`,
      ].sort(),
    );
  });

  it('markup in a passage passes through as plain, unescaped text (the web renders it literally)', async () => {
    const r = await search(app, 'owner', 'heron');
    const snippet = r.moments[0]?.snippet ?? '';
    expect(snippet).toContain(`onerror=alert(1)> ${HL}heron${HR}`);
    expect(snippet).not.toContain('&lt;');
  });
});

describe('catalog.search: index use (design D5)', () => {
  it('with 5,000 chunks, sessions and shows, one call scans the chunks, search_meta and show-name trigram indexes', async () => {
    const db = await createTestDatabase();
    const sys = connect(db.system);
    await seedPolicyFixture(sys);
    await sys`insert into shows (id, studio_id, name, show_code, created_at_utc)
              select 'ix' || g, ${T}, md5(g::text), 'IX' || g, ${NOW}
              from generate_series(1, 5000) g`;
    await sys`insert into sessions (id, show_id, title, notes, started_at_utc)
              select 'ixs' || g, 'ix' || g, md5(g::text), md5((g + 1)::text), ${NOW}
              from generate_series(1, 5000) g`;
    await sys`insert into session_transcript_words
                (session_id, id, word, start_sec, end_sec, ordinal, created_at_utc)
              select 'ixs' || g, 'w',
                     -- One "word" of 40 hashes: each chunk holds transcript-sized text.
                     (select string_agg(md5((g * 40 + k)::text), ' ') from generate_series(1, 40) k),
                     1, 2, 0, ${NOW}
              from generate_series(1, 5000) g`;
    await show(sys, 'cr', T, 'Christina Ramos Live');
    const admin = connect(db.admin);
    const [n] =
      await admin`select (select count(*) from catalog.session_transcript_chunks)::int as c,
                                   (select count(*) from catalog.sessions)::int as s,
                                   (select count(*) from catalog.shows)::int as sh`;
    expect(n?.c).toBeGreaterThanOrEqual(5000);
    expect(n?.s).toBeGreaterThanOrEqual(5000);
    expect(n?.sh).toBeGreaterThanOrEqual(5000);
    // VACUUM as well as ANALYZE: rows inserted after the GIN indexes were built sit in the
    // indexes' pending lists, which the planner costs as a full scan until a vacuum (autovacuum,
    // outside tests) merges them. Plain ANALYZE leaves them, and the trigram scans lose to a seq
    // scan at this size.
    await admin`vacuum analyze catalog.sessions, catalog.shows, catalog.session_transcript_chunks,
                        catalog.session_topics, catalog.session_events, catalog.studio_definitions`;

    const INDEXES = [
      'idx_session_chunks_search',
      'idx_sessions_search_meta',
      'idx_shows_name_trgm',
    ];
    const scans = async () => {
      const rows = await admin`select indexrelname as name, idx_scan::int as n
                               from pg_stat_user_indexes
                               where schemaname = 'catalog' and indexrelname in ${admin(INDEXES)}`;
      return Object.fromEntries(rows.map((r) => [String(r.name), Number(r.n)]));
    };
    const before = await scans();
    expect(Object.keys(before).sort()).toEqual([...INDEXES].sort());

    const app = connect(db.app);
    const r = await search(app, 'owner', 'christna');
    expect(outline(r).shows).toEqual(['cr']);
    await app`select pg_stat_force_next_flush()`;
    // The flush happens as the connection goes idle; give it a moment to land.
    let after = await scans();
    for (let i = 0; i < 50 && INDEXES.some((x) => (after[x] ?? 0) <= (before[x] ?? 0)); i++) {
      await new Promise((res) => setTimeout(res, 100));
      after = await scans();
    }
    for (const x of INDEXES) expect(after[x], x).toBeGreaterThan(before[x] ?? 0);
  });
});
