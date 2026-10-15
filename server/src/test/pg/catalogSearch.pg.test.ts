// catalog-search design D2-D4: the search extensions, the text-search configuration and the name
// normaliser, the generated search columns and their indexes, the function privileges, and the
// transcript chunks the database keeps in sync with the words (catalog-database "Search
// extensions, normaliser and indexes", "Transcript chunks").

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import { type ConnOptions, connOptions, createTestDatabase } from '../../../../test/pg/testDb';
import { seedPolicyFixture, T } from './policyFixture';
import { holdRoleGuardLock } from './roleGuardLock';

const MIGRATIONS = resolve(import.meta.dirname, '../../../../supabase/migrations');
const SEARCH_MIGRATION = '20261019000000_catalog_search.sql';
const NOW = '2026-10-19T00:00:00.000Z';

const open: postgres.Sql[] = [];
function connect(o: ConnOptions): postgres.Sql {
  const sql = postgres({ ...o, max: 1, onnotice: () => {} });
  open.push(sql);
  return sql;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.end()));
});

type Outcome = { count: number } | { code: string };

/** Runs `stmts` as `catalog_user` for `uid` in one transaction that rolls back; the outcome of each
 * statement (a statement error ends the run). */
async function asUser(sql: postgres.Sql, uid: string, ...stmts: string[]): Promise<Outcome[]> {
  class Rollback extends Error {}
  const out: Outcome[] = [];
  await sql
    .begin(async (tx) => {
      await tx`select set_config('role', 'catalog_user', true), set_config('app.user_id', ${uid}, true)`;
      for (const stmt of stmts) {
        try {
          out.push({ count: (await tx.unsafe(stmt)).count });
        } catch (e) {
          out.push({ code: String((e as { code?: unknown }).code) });
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

interface Word {
  id: string;
  speaker: string;
  word: string;
  start_sec: number;
  end_sec: number;
  ordinal: number;
}

/** The app's bulk replace (transcriptStore.replaceTranscriptWords, design A10): one DELETE, then
 * one INSERT … SELECT FROM json_to_recordset. */
async function bulkReplace(
  sql: postgres.Sql | postgres.TransactionSql,
  sid: string,
  words: Word[],
) {
  await sql`delete from session_transcript_words where session_id = ${sid}`;
  await sql`
    insert into session_transcript_words
      (session_id, id, session_time, speaker, word, start_sec, end_sec, ordinal, created_at_utc)
    select ${sid}, r.id, '', r.speaker, r.word, r.start_sec, r.end_sec, r.ordinal, ${NOW}
    from json_to_recordset(${JSON.stringify(words)}::text::json) as r(id text, speaker text,
      word text, start_sec double precision, end_sec double precision, ordinal bigint)`;
}

/** `n` words `w<i>` at 1 s each, speaker `s<i div 40>`, ordinals from 0. */
function words(n: number, prefix = 'w'): Word[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i}`,
    speaker: `s${Math.floor(i / 40)}`,
    word: `${prefix}${i}`,
    start_sec: i + 1,
    end_sec: i + 1.5,
    ordinal: i,
  }));
}

interface Chunk {
  session_id: string;
  bucket: number;
  start_sec: number | null;
  end_sec: number | null;
  speaker: string;
  text: string;
}

/** The chunk rule (design D4; catalog-database "Transcript chunks"), computed from words. */
function expectedChunks(sid: string, ws: Word[]): Chunk[] {
  const buckets = new Map<number, Word[]>();
  for (const w of ws) {
    if (w.word === '') continue;
    const b = Math.floor(w.ordinal / 40);
    buckets.set(b, [...(buckets.get(b) ?? []), w]);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([bucket, list]) => {
      const sorted = [...list].sort((a, b) => a.ordinal - b.ordinal || (a.id < b.id ? -1 : 1));
      const positive = sorted.map((w) => w.start_sec).filter((s) => s > 0);
      return {
        session_id: sid,
        bucket,
        start_sec: positive.length ? Math.min(...positive) : null,
        end_sec: Math.max(...sorted.map((w) => w.end_sec)),
        speaker: sorted[0]?.speaker ?? '',
        text: sorted.map((w) => w.word).join(' '),
      };
    });
}

async function chunks(sql: postgres.Sql, sid?: string): Promise<Chunk[]> {
  const rows = await sql`
    select session_id, bucket::int as bucket, start_sec, end_sec, speaker, text
    from catalog.session_transcript_chunks
    where ${sid === undefined ? sql`true` : sql`session_id = ${sid}`}
    order by session_id, bucket`;
  return rows.map((r) => ({ ...r }) as Chunk);
}

const NEW_FUNCTIONS = [
  'catalog.search_norm(text)',
  // catalog-search D11: the phrase normaliser, and the search with `p_session`.
  'catalog.search_phrase_norm(text)',
  'catalog.search(text,text,text,integer,text)',
  'catalog.refresh_transcript_chunks(text,bigint[])',
  'catalog.sync_transcript_chunks()',
];

describe('search extensions, normaliser and indexes (catalog-search D2, D3)', () => {
  it('search_norm folds accents and case, non-ASCII included, and is immutable', async () => {
    const db = await createTestDatabase();
    const sql = connect(db.admin);
    const [r] = await sql`select catalog.search_norm('Ångström CAFÉ Straße') as n`;
    expect(r?.n).toBe('angstrom cafe strasse');
    const [p] = await sql`select provolatile from pg_proc
                          where oid = 'catalog.search_norm(text)'::regprocedure`;
    expect(p?.provolatile).toBe('i');
  });

  it('search_phrase_norm: the phrase normaliser drops punctuation, whitespace separates words first, and is immutable (D11)', async () => {
    const db = await createTestDatabase();
    const sql = connect(db.admin);
    const [r] = await sql`
      select catalog.search_phrase_norm('I''m like, Why did he   DO that?') as a,
             catalog.search_phrase_norm(E'tab\there — now') as b,
             catalog.search_phrase_norm(E'  Ångström\n\nCAFÉ  ') as c,
             catalog.search_phrase_norm('50% of_the a\\b') as d,
             catalog.search_phrase_norm('привет, 中文!') as e,
             catalog.search_phrase_norm('—') as f`;
    expect(r).toEqual({
      a: 'im like why did he do that',
      b: 'tab here now',
      c: 'angstrom cafe',
      d: '50 ofthe ab',
      e: 'привет 中文',
      f: '',
    });
    const [p] = await sql`select provolatile from pg_proc
                          where oid = 'catalog.search_phrase_norm(text)'::regprocedure`;
    expect(p?.provolatile).toBe('i');
  });

  it('a 4-argument call resolves to the 5-argument search, the only one (D11)', async () => {
    const db = await createTestDatabase();
    await seedPolicyFixture(connect(db.system));
    const sql = connect(db.admin);
    const fns = await sql`select oid::regprocedure::text as f, pronargdefaults as d from pg_proc
                          where pronamespace = 'catalog'::regnamespace and proname = 'search'`;
    expect(fns.map((r) => ({ ...r }))).toEqual([
      { f: 'catalog.search(text,text,text,integer,text)', d: 1 },
    ]);
    const out = await asUser(
      connect(db.app),
      'owner',
      `select catalog.search('anything', null, null, 5)`,
      `select catalog.search('anything', null, null, 5, null)`,
    );
    expect(out).toEqual([{ count: 1 }, { count: 1 }]);
  });

  it('catalog.search_english stems and folds accents in vectors and queries', async () => {
    const db = await createTestDatabase();
    const sql = connect(db.admin);
    const [r] = await sql`
      select to_tsvector('catalog.search_english', 'We met at the Café Noir, they were Divorced')
             @@ websearch_to_tsquery('catalog.search_english', 'cafe divorce') as hit,
             to_tsvector('catalog.search_english', 'a cafe') @@
             websearch_to_tsquery('catalog.search_english', 'CAFÉ') as reverse`;
    expect(r).toEqual({ hit: true, reverse: true });
  });

  it('has the five generated search columns with GIN indexes, and the three trigram indexes', async () => {
    const db = await createTestDatabase();
    const sql = connect(db.admin);
    const cols = await sql`
      select c.relname || '.' || a.attname as col, a.attgenerated as g,
             format_type(a.atttypid, a.atttypmod) as type
      from pg_attribute a join pg_class c on c.oid = a.attrelid
      where c.relnamespace = 'catalog'::regnamespace and a.attnum > 0 and not a.attisdropped
        and a.atttypid = 'tsvector'::regtype
      order by col`;
    expect(cols.map((r) => `${r.col} ${r.type} ${r.g}`)).toEqual([
      'session_events.search_tsv tsvector s',
      'session_topics.search_tsv tsvector s',
      'session_transcript_chunks.search_tsv tsvector s',
      'sessions.search_meta tsvector s',
      'sessions.search_notes tsvector s',
    ]);
    const idx = await sql`
      select indexdef from pg_indexes where schemaname = 'catalog' and indexdef like '%USING gin%'
      order by indexdef`;
    const defs = idx.map((r) => String(r.indexdef));
    for (const [table, col] of [
      ['sessions', 'search_meta'],
      ['sessions', 'search_notes'],
      ['session_topics', 'search_tsv'],
      ['session_events', 'search_tsv'],
      ['session_transcript_chunks', 'search_tsv'],
    ]) {
      expect(
        defs.some((d) => d.includes(`ON catalog.${table} USING gin (${col})`)),
        `${table}.${col}`,
      ).toBe(true);
    }
    for (const [table, col] of [
      ['sessions', 'title'],
      ['shows', 'name'],
      ['studio_definitions', 'display_name'],
    ]) {
      expect(
        defs.some(
          (d) =>
            d.includes(`ON catalog.${table} USING gin (catalog.search_norm(${col})`) &&
            d.includes('gin_trgm_ops'),
        ),
        `${table}.${col} trigram`,
      ).toBe(true);
    }
    // catalog-search D11: the phrase trigram indexes.
    for (const [table, col] of [
      ['session_transcript_chunks', 'text'],
      ['session_topics', 'summary'],
      ['session_events', 'message'],
    ]) {
      expect(
        defs.some(
          (d) =>
            d.includes(`ON catalog.${table} USING gin (catalog.search_phrase_norm(${col})`) &&
            d.includes('gin_trgm_ops'),
        ),
        `${table}.${col} phrase trigram`,
      ).toBe(true);
    }
    expect(defs).toHaveLength(11);
    const ops = await sql`
      select distinct o.opcnamespace::regnamespace::text as ns from pg_index i
      join pg_class c on c.oid = i.indexrelid
      join pg_opclass o on o.oid = any(i.indclass::oid[])
      where c.relnamespace = 'catalog'::regnamespace and o.opcname = 'gin_trgm_ops'`;
    expect(ops.map((r) => r.ns)).toEqual(['extensions']);
  });

  it('a search column follows edits: a topic summary changed from budget talk to wedding plans', async () => {
    const db = await createTestDatabase();
    await seedPolicyFixture(connect(db.system));
    const sql = connect(db.system);
    const hits = async (word: string) =>
      (
        await sql`select count(*)::int as n from session_topics
                  where session_id = 'ss1' and id = 'c'
                    and search_tsv @@ websearch_to_tsquery('catalog.search_english', ${word})`
      )[0]?.n;
    await sql`update session_topics set summary = 'budget talk' where session_id = 'ss1' and id = 'c'`;
    expect([await hits('budget'), await hits('wedding')]).toEqual([1, 0]);
    await sql`update session_topics set summary = 'wedding plans' where session_id = 'ss1' and id = 'c'`;
    expect([await hits('budget'), await hits('wedding')]).toEqual([0, 1]);
  });

  it('Ordinary writes still succeed: an owner, as catalog_user, updates a session, a topic, an event, a show and a studio', async () => {
    const db = await createTestDatabase();
    await seedPolicyFixture(connect(db.system));
    const out = await asUser(
      connect(db.app),
      'owner',
      `update sessions set title = 'Café Ångström', notes = 'Straße notes' where id = 'ss1'`,
      `update session_topics set summary = 'Crème brûlée' where session_id = 'ss1' and id = 'c'`,
      `update session_events set message = 'Résumé' where session_id = 'ss1' and id = 'c'`,
      `update shows set name = 'Show Ünïcode' where id = 's1'`,
      `update studio_definitions set display_name = 'Team Ø' where id = '${T}'`,
    );
    expect(out).toEqual([{ count: 1 }, { count: 1 }, { count: 1 }, { count: 1 }, { count: 1 }]);
  });

  it('New functions are not public: exactly the designed execute grants', async () => {
    const db = await createTestDatabase();
    const sql = connect(db.admin);
    const can: Record<string, [boolean, boolean]> = {
      // [catalog_user, catalog_system]
      'catalog.search_norm(text)': [true, true],
      'catalog.search_phrase_norm(text)': [true, true],
      'catalog.search(text,text,text,integer,text)': [true, false],
      'catalog.refresh_transcript_chunks(text,bigint[])': [false, false],
      'catalog.sync_transcript_chunks()': [false, false],
    };
    for (const f of NEW_FUNCTIONS) {
      const [r] = await sql`
        select has_function_privilege('public', ${f}, 'execute') as pub,
               has_function_privilege('catalog_user', ${f}, 'execute') as usr,
               has_function_privilege('catalog_system', ${f}, 'execute') as sys,
               has_function_privilege('autologger_app', ${f}, 'execute') as app`;
      expect(r, f).toEqual({ pub: false, usr: can[f]?.[0], sys: can[f]?.[1], app: false });
    }
  });

  it('the definer functions pin search_path to pg_catalog, pg_temp; search sets the trigram threshold', async () => {
    const db = await createTestDatabase();
    const sql = connect(db.admin);
    for (const f of NEW_FUNCTIONS.slice(2)) {
      const [r] = await sql`select p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) as owner
                            from pg_proc p where p.oid = ${f}::regprocedure`;
      expect(r?.prosecdef, f).toBe(true);
      expect(r?.owner, f).toBe('postgres');
      expect(r?.proconfig, f).toEqual(expect.arrayContaining(['search_path=pg_catalog, pg_temp']));
    }
    const [s] = await sql`select proconfig, provolatile from pg_proc
                          where oid = 'catalog.search(text,text,text,integer,text)'::regprocedure`;
    expect(s?.proconfig).toEqual(expect.arrayContaining(['pg_trgm.word_similarity_threshold=0.5']));
    expect(s?.provolatile).toBe('s');
  });

  it('both catalog roles have USAGE on schema extensions, in the template and in postgres', async () => {
    const db = await createTestDatabase();
    for (const sql of [connect(db.admin), connect(connOptions('postgres', 'postgres'))]) {
      const rows = await sql`
        select r, has_schema_privilege(r, 'extensions', 'usage') as u
        from unnest(array['catalog_user', 'catalog_system']) as r order by r`;
      expect(rows.map((x) => ({ ...x }))).toEqual([
        { r: 'catalog_system', u: true },
        { r: 'catalog_user', u: true },
      ]);
    }
  });
});

describe('transcript chunks (catalog-search D4)', () => {
  it('Bulk replace rebuilds chunks: 90 words give 3 chunks with text, times and speaker', async () => {
    const db = await createTestDatabase();
    await seedPolicyFixture(connect(db.system));
    const sys = connect(db.system);
    const ws = words(90);
    // Word 0 is empty, so chunk 0 starts at word 1; word 80 is untimed, so chunk 2 starts at word 81.
    ws[0] = { ...ws[0], word: '' } as Word;
    ws[80] = { ...ws[80], start_sec: 0 } as Word;
    await sys.begin((tx) => bulkReplace(tx, 'ss1', ws));
    const got = await chunks(connect(db.admin), 'ss1');
    expect(got).toEqual(expectedChunks('ss1', ws));
    expect(got.map((c) => c.bucket)).toEqual([0, 1, 2]);
    expect(got[0]).toMatchObject({ start_sec: 2, end_sec: 40.5, speaker: 's0' });
    expect(got[0]?.text.split(' ')).toHaveLength(39);
    expect(got[2]).toMatchObject({ start_sec: 82, end_sec: 90.5, speaker: 's2' });
    expect(got[2]?.text).toBe(
      ws
        .slice(80)
        .map((w) => w.word)
        .join(' '),
    );
    // A second replace with fewer words leaves only its chunks.
    await sys.begin((tx) => bulkReplace(tx, 'ss1', words(10, 'v')));
    expect(await chunks(connect(db.admin), 'ss1')).toEqual(expectedChunks('ss1', words(10, 'v')));
  });

  it('A single-word edit rebuilds one chunk; the other rows are untouched', async () => {
    const db = await createTestDatabase();
    await seedPolicyFixture(connect(db.system));
    const sys = connect(db.system);
    const ws = words(90);
    ws[45] = { ...ws[45], word: 'cat' } as Word;
    await sys.begin((tx) => bulkReplace(tx, 'ss1', ws));
    const admin = connect(db.admin);
    const xmins = async () =>
      (
        await admin`select bucket::int as b, xmin::text as x from catalog.session_transcript_chunks
                    where session_id = 'ss1' order by bucket`
      ).map((r) => [r.b, r.x]);
    const before = await xmins();
    await sys`update session_transcript_words set word = 'dog', version = version + 1
              where session_id = 'ss1' and id = 'w45'`;
    const after = await xmins();
    expect(after[0]).toEqual(before[0]);
    expect(after[2]).toEqual(before[2]);
    expect(after[1]?.[1]).not.toBe(before[1]?.[1]);
    const [c1] = await admin`select text from catalog.session_transcript_chunks
                             where session_id = 'ss1' and bucket = 1`;
    expect(c1?.text).toContain(' dog ');
    expect(c1?.text).not.toContain('cat');
  });

  it('a manual insert appends into the last chunk; a delete that empties a chunk removes its row', async () => {
    const db = await createTestDatabase();
    await seedPolicyFixture(connect(db.system));
    const sys = connect(db.system);
    await sys.begin((tx) => bulkReplace(tx, 'ss1', words(90)));
    // transcriptStore.insertTranscriptWord: the next ordinal, no start_sec (0).
    await sys`insert into session_transcript_words
                (session_id, id, session_time, speaker, word, ordinal, created_at_utc)
              values ('ss1', 'm1', '', 's9', 'appended', 90, ${NOW})`;
    const admin = connect(db.admin);
    let [c2] = await chunks(admin, 'ss1').then((c) => c.filter((x) => x.bucket === 2));
    expect(c2?.text.endsWith(' w89 appended')).toBe(true);
    expect(c2?.start_sec).toBe(81);
    await sys`delete from session_transcript_words
              where session_id = 'ss1' and ordinal >= 80`;
    [c2] = await chunks(admin, 'ss1').then((c) => c.filter((x) => x.bucket === 2));
    expect(c2).toBeUndefined();
    expect((await chunks(admin, 'ss1')).map((c) => c.bucket)).toEqual([0, 1]);
  });

  it('a block of only empty words has no row; one of only untimed words has a null start', async () => {
    const db = await createTestDatabase();
    await seedPolicyFixture(connect(db.system));
    const sys = connect(db.system);
    const ws = words(80).map((w, i) =>
      i < 40 ? { ...w, word: '' } : { ...w, start_sec: 0, end_sec: 0 },
    );
    await sys.begin((tx) => bulkReplace(tx, 'ss1', ws));
    const got = await chunks(connect(db.admin), 'ss1');
    expect(got.map((c) => [c.bucket, c.start_sec])).toEqual([[1, null]]);
    // The fixture's one empty word in ssu (seedPolicyFixture) has no chunk either.
    expect(await chunks(connect(db.admin), 'ssu')).toEqual([]);
  });

  it('Chunks follow the content policy: owner and granted member see them, the ungranted member and outsider do not', async () => {
    const db = await createTestDatabase();
    await seedPolicyFixture(connect(db.system));
    await connect(db.system).begin((tx) => bulkReplace(tx, 'ss1', words(50)));
    const app = connect(db.app);
    const read = `select 1 from session_transcript_chunks where session_id = 'ss1'`;
    expect(await asUser(app, 'owner', read)).toEqual([{ count: 2 }]);
    expect(await asUser(app, 'granted', read)).toEqual([{ count: 2 }]);
    expect(await asUser(app, 'ungranted', read)).toEqual([{ count: 0 }]);
    expect(await asUser(app, 'outsider', read)).toEqual([{ count: 0 }]);
  });

  it("Users can't write chunks directly: insert, update and delete fail with 42501", async () => {
    const db = await createTestDatabase();
    await seedPolicyFixture(connect(db.system));
    await connect(db.system).begin((tx) => bulkReplace(tx, 'ss1', words(50)));
    const before = await chunks(connect(db.admin), 'ss1');
    const app = connect(db.app);
    for (const stmt of [
      `insert into session_transcript_chunks (session_id, bucket, text) values ('ss1', 7, 'x')`,
      `update session_transcript_chunks set text = 'x' where session_id = 'ss1'`,
      `delete from session_transcript_chunks where session_id = 'ss1'`,
    ]) {
      expect(await asUser(app, 'owner', stmt), stmt).toEqual([{ code: '42501' }]);
    }
    expect(await chunks(connect(db.admin), 'ss1')).toEqual(before);
  });

  it('a user word edit, as catalog_user, rebuilds the chunk through the definer trigger', async () => {
    const db = await createTestDatabase();
    await seedPolicyFixture(connect(db.system));
    await connect(db.system).begin((tx) => bulkReplace(tx, 'ss1', words(50)));
    const app = connect(db.app);
    await app.begin(async (tx) => {
      await tx`select set_config('role', 'catalog_user', true), set_config('app.user_id', 'owner', true)`;
      await tx`update session_transcript_words set word = 'edited', version = version + 1
               where session_id = 'ss1' and id = 'w42'`;
    });
    const [c1] = (await chunks(connect(db.admin), 'ss1')).filter((c) => c.bucket === 1);
    expect(c1?.text.split(' ')[2]).toBe('edited');
  });

  it('Concurrent edits in one block: two transactions update different words, both commit, and the chunk holds both', async () => {
    const db = await createTestDatabase();
    await seedPolicyFixture(connect(db.system));
    await connect(db.system).begin((tx) => bulkReplace(tx, 'ss1', words(40)));
    const a = connect(db.system);
    const b = connect(db.system);
    let releaseA!: () => void;
    const holdA = new Promise<void>((r) => {
      releaseA = r;
    });
    let aUpdated!: () => void;
    const aDone = new Promise<void>((r) => {
      aUpdated = r;
    });
    const txA = a.begin(async (tx) => {
      await tx`update session_transcript_words set word = 'alpha' where session_id = 'ss1' and id = 'w5'`;
      aUpdated();
      await holdA;
    });
    await aDone;
    // B's rebuild waits for A's per-session lock, then reads A's committed word.
    const txB = b.begin(async (tx) => {
      await tx`update session_transcript_words set word = 'beta' where session_id = 'ss1' and id = 'w6'`;
    });
    await new Promise((r) => setTimeout(r, 300));
    releaseA();
    await Promise.all([txA, txB]);
    const [c0] = await chunks(connect(db.admin), 'ss1');
    expect(c0?.text.split(' ').slice(5, 7)).toEqual(['alpha', 'beta']);
  });

  it('a 30k-word bulk replace stays under 5 s', async () => {
    const db = await createTestDatabase();
    await seedPolicyFixture(connect(db.system));
    const sys = connect(db.system);
    const ws = words(30_000);
    const t0 = performance.now();
    await sys.begin((tx) => bulkReplace(tx, 'ss1', ws));
    const ms = performance.now() - t0;
    const [r] = await connect(db.admin)`select count(*)::int as n
                                        from catalog.session_transcript_chunks where session_id = 'ss1'`;
    expect(r?.n).toBe(750);
    expect(ms).toBeLessThan(5000);
  });
});

describe('the catalog search migration backfill (catalog-search D4, task 2.4)', () => {
  it("The backfill matches the rule: each session's chunks equal the rule's output from its words", async () => {
    const name = `t_cs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    // The replay runs the role guards, which a parallel scratch role would trip (roleGuardLock.ts).
    await holdRoleGuardLock(connect(connOptions('postgres', 'postgres')));
    const root = connect(connOptions('postgres', 'postgres'));
    await root.unsafe(`create database ${name} template template0`);
    const sql = connect(connOptions('postgres', name));
    const earlier = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql') && f < SEARCH_MIGRATION)
      .sort();
    expect(earlier.at(-1)).toBe('20261018000000_claude_cli_provider.sql');
    for (const f of earlier) {
      const text = readFileSync(resolve(MIGRATIONS, f), 'utf8');
      await sql.begin((tx) => tx.unsafe(text));
    }
    await sql.unsafe(
      `insert into catalog.sessions (id, title) values ('a', 'A'), ('b', 'B'), ('c', 'C')`,
    );
    // a: 130 words with empty words, untimed words and an ordinal gap; b: one block of only empty
    // words; c: no words.
    const a = words(130, 'a').map((w, i) => ({
      ...w,
      ordinal: i < 100 ? i : i + 37,
      word: i % 17 === 3 ? '' : w.word,
      start_sec: i % 5 === 0 ? 0 : w.start_sec,
    }));
    const b = words(30, 'b').map((w) => ({ ...w, word: '' }));
    for (const [sid, ws] of [
      ['a', a],
      ['b', b],
    ] as const) {
      await sql`
        insert into catalog.session_transcript_words
          (session_id, id, speaker, word, start_sec, end_sec, ordinal, created_at_utc)
        select ${sid}, r.id, r.speaker, r.word, r.start_sec, r.end_sec, r.ordinal, ${NOW}
        from json_to_recordset(${JSON.stringify(ws)}::text::json) as r(id text, speaker text,
          word text, start_sec double precision, end_sec double precision, ordinal bigint)`;
    }
    const text = readFileSync(resolve(MIGRATIONS, SEARCH_MIGRATION), 'utf8');
    await sql.begin((tx) => tx.unsafe(text));
    const got = await chunks(sql);
    expect(got).toEqual(expectedChunks('a', a));
    expect(got.length).toBeGreaterThan(3);
  });
});
