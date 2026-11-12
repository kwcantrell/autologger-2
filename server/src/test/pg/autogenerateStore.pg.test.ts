// batch-autogenerate task 2.4 (design D1-D3, D7, D13, D14): `catalog.autogenerate` run through the
// server's catalog adapter (`PostgresCatalogDb`) against the policy fixture (policyFixture.ts):
// team T (`owner`, `admin`, members `granted`, `ungranted`) with shows `s1`, `s2`; team V owned by
// `owner`. This file adds, as catalog_system, shows `so1`, `so2`, `so3` in T and their sessions.
// The creating calls run as T's admin (the start route's binding); the worker calls run under the
// reviewed system reason through `autogenerateWorkerCatalog`.

import { autogenerateWorkerCatalog, type CatalogFacade, createCatalog } from '@autologger/catalog';
import { parseWikiLinks } from '@autologger/contract/wikiLinks';
import { PostgresCatalogDb } from '@autologger/storage';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase } from '../../../../test/pg/testDb';
import { seedPolicyFixture, T, V } from './policyFixture';

const NOW = '2026-11-09T00:00:00.000Z';
let adapter: PostgresCatalogDb;
let sys: postgres.Sql;
let admin: postgres.Sql;

const root = () => createCatalog(adapter, { wikiLinks: parseWikiLinks });
const as = (user: string): CatalogFacade => root().forUser(user);
const worker = (): CatalogFacade => autogenerateWorkerCatalog(root());

async function session(
  id: string,
  show: string,
  o: { episode?: string | null; started?: string; created?: string; hidden?: 1; archived?: 1 } = {},
) {
  await sys`insert into sessions (id, show_id, title, episode_date, started_at_utc, created_at_utc,
              ui_hidden, archived)
            values (${id}, ${show}, ${`Title ${id}`}, ${o.episode ?? null}, ${o.started ?? ''},
              ${o.created ?? ''}, ${o.hidden ?? 0}, ${o.archived ?? 0})`;
}

beforeAll(async () => {
  const db = await createTestDatabase();
  sys = postgres({ ...db.system, max: 1, onnotice: () => {} });
  admin = postgres({ ...db.admin, max: 1, onnotice: () => {} });
  await seedPolicyFixture(sys);
  for (const show of ['so1', 'so2', 'so3']) {
    await sys`insert into shows (id, studio_id, name, show_code, created_at_utc)
              values (${show}, ${T}, ${`Show ${show}`}, ${show.toUpperCase()}, ${NOW})`;
  }
  // The spec's first ordering scenario (B, A, C), a deleted and an archived session, and an
  // undated one (last).
  await session('A', 'so1', { episode: '2024-03-01', started: '2024-05-01T10:00:00Z' });
  await session('B', 'so1', { started: '2024-02-10T18:00:00Z', created: '2024-02-10T17:00:00Z' });
  await session('C', 'so1', { created: '2025-01-01T00:00:00Z' });
  await session('D', 'so1', { episode: 'someday', started: 'not a date', created: '' });
  await session('X', 'so1', { episode: '2020-01-01', hidden: 1 });
  await session('R', 'so1', { episode: '2024-04-01', archived: 1 });
  // The second scenario: equal dates, `b` started before `a`.
  await session('a', 'so2', { episode: '2024-03-01', started: '2024-03-01T12:00:00Z' });
  await session('b', 'so2', { episode: '2024-03-01', started: '2024-03-01T09:00:00Z' });
  // so3: content for the preview counts.
  for (const id of ['p1', 'p2', 'p3']) await session(id, 'so3', { episode: '2024-01-0' + id[1] });
  await sys`insert into session_transcript_words (session_id, id, ordinal, created_at_utc)
            values ('p1', 'w1', 0, ${NOW})`;
  await sys`insert into session_events (session_id, id, wall_time_utc, frame_rate, category,
              message, metadata_json)
            values ('p1', 'e1', ${NOW}, 24, 'c', 'auto', '{"auto_generated":true}'),
                   ('p2', 'e2', ${NOW}, 24, 'c', 'manual', '{}')`;
  await sys`insert into session_topics (session_id, id, ordinal, created_at_utc)
            values ('p2', 't1', 0, ${NOW})`;
  adapter = new PostgresCatalogDb(db.app);
});
afterAll(async () => {
  await sys?.end();
  await admin?.end();
  await adapter?.close();
});

/** Ends every live job, so each test starts with no due job. */
beforeEach(async () => {
  await sys`update autogenerate_jobs set status = 'finished', finished_at_ms = 1
            where status in ('queued', 'running')`;
});

const create = (
  user: string,
  scope: { showIds: string[] } | { sessionIds: string[] },
  over: Partial<{ steps: ('transcript' | 'events' | 'topics' | 'wiki')[]; expected: number }> = {},
) =>
  as(user).autogenerate.createJob({
    teamId: T,
    initiatorId: user,
    initiatorName: `${user} Fixture`,
    scope,
    steps: over.steps ?? ['wiki', 'transcript'],
    wikiMode: 'accept',
    expectedSessions: over.expected ?? 0,
    nowMs: 1000,
  });

describe('create (design D13, D14)', () => {
  it('a show scope: deleted sessions excluded, archived included, ordered B, A, C, undated last', async () => {
    const r = await as('admin').autogenerate.resolveScope(T, { showIds: ['so1'] });
    expect(r).toEqual({
      ok: true,
      sessions: [
        { id: 'B', show_id: 'so1', effective_date: '2024-02-10' },
        { id: 'A', show_id: 'so1', effective_date: '2024-03-01' },
        { id: 'R', show_id: 'so1', effective_date: '2024-04-01' },
        { id: 'C', show_id: 'so1', effective_date: '2025-01-01' },
        { id: 'D', show_id: 'so1', effective_date: null },
      ],
    });
  });

  it('equal dates order by start time, then id: b before a', async () => {
    const r = await as('admin').autogenerate.resolveScope(T, { showIds: ['so2'] });
    expect(r.ok && r.sessions.map((s) => s.id)).toEqual(['b', 'a']);
  });

  it('a session scope dedupes and refuses a foreign, deleted or missing session', async () => {
    const r = await as('admin').autogenerate.resolveScope(T, { sessionIds: ['a', 'A', 'a'] });
    // Both dated 2024-03-01; `a` started first.
    expect(r.ok && r.sessions.map((s) => s.id)).toEqual(['a', 'A']);
    for (const bad of ['ssu', 'X', 'nope']) {
      expect(await as('admin').autogenerate.resolveScope(T, { sessionIds: ['A', bad] })).toEqual({
        ok: false,
        reason: 'session-not-found',
      });
    }
    expect(await as('admin').autogenerate.resolveScope(T, { showIds: ['so1', 'su'] })).toEqual({
      ok: false,
      reason: 'show-not-found',
    });
  });

  it('writes one item per session and step in (ordinal, step_order), steps in run order', async () => {
    const r = await create('admin', { showIds: ['so1'] }, { expected: 5 });
    expect(r.kind).toBe('created');
    const job = r.kind === 'created' ? r.job : null;
    expect(job).toMatchObject({
      status: 'queued',
      steps: ['transcript', 'wiki'],
      session_count: 5,
      initiator_user_id: 'admin',
      scope: 'shows',
      show_ids: ['so1'],
      counts: { pending: 10, running: 0, done: 0, skipped: 0, failed: 0, cancelled: 0 },
      current: null,
    });
    const items = await worker().autogenerate.items(job?.id ?? '');
    expect(items.map((i) => `${i.ordinal}:${i.session_id}:${i.step}`)).toEqual([
      '0:B:transcript',
      '0:B:wiki',
      '1:A:transcript',
      '1:A:wiki',
      '2:R:transcript',
      '2:R:wiki',
      '3:C:transcript',
      '3:C:wiki',
      '4:D:transcript',
      '4:D:wiki',
    ]);
    expect(items[0]).toMatchObject({
      effective_date: '2024-02-10',
      status: 'pending',
      attempts: 0,
    });
  });

  it('answers the live job, a changed count, no sessions; the job and items commit together', async () => {
    const first = await create('admin', { sessionIds: ['A'] }, { expected: 1 });
    expect(first.kind).toBe('created');
    const id = first.kind === 'created' ? first.job.id : '';
    expect(await create('owner', { sessionIds: ['B'] }, { expected: 1 })).toEqual({
      kind: 'live-job',
      jobId: id,
    });
    await sys`update autogenerate_jobs set status = 'finished', finished_at_ms = 1 where id = ${id}`;
    expect(await create('owner', { showIds: ['so2'] }, { expected: 3 })).toEqual({
      kind: 'sessions-changed',
      sessions: 2,
    });
    await sys`insert into shows (id, studio_id, name, show_code, created_at_utc)
              values ('empty', ${T}, 'Empty', 'EMPTY', ${NOW})`;
    expect(await create('owner', { showIds: ['empty'] })).toEqual({ kind: 'no-sessions' });
    // An item insert that fails rolls the job back too.
    await admin.unsafe(`
      create function catalog.test_boom() returns trigger language plpgsql as $$
        begin
          if new.session_id = 'b' then raise exception 'boom'; end if;
          return new;
        end $$;
      create trigger test_boom before insert on catalog.autogenerate_items
        for each row execute function catalog.test_boom();`);
    try {
      await expect(create('owner', { showIds: ['so2'] }, { expected: 2 })).rejects.toThrow();
      expect(await as('owner').autogenerate.liveJobId(T)).toBeNull();
      const [n] = await sys`select count(*)::int as n from autogenerate_items i
                            join autogenerate_jobs j on j.id = i.job_id
                            where j.status = 'queued'`;
      expect(n?.n).toBe(0);
    } finally {
      await admin.unsafe(
        'drop trigger test_boom on catalog.autogenerate_items; drop function catalog.test_boom();',
      );
    }
  });

  it('two concurrent starts create one job and answer the other live-job', async () => {
    const [x, y] = await Promise.all([
      create('owner', { sessionIds: ['A'] }, { expected: 1 }),
      create('admin', { sessionIds: ['B'] }, { expected: 1 }),
    ]);
    const kinds = [x.kind, y.kind].sort();
    expect(kinds).toEqual(['created', 'live-job']);
  });
});

describe('claim and lease (design D3)', () => {
  it('two concurrent claims with one due job return it once', async () => {
    const r = await create('admin', { sessionIds: ['A'] }, { expected: 1 });
    const id = r.kind === 'created' ? r.job.id : '';
    const [x, y] = await Promise.all([
      worker().autogenerate.claim('w1', 10_000, 60_000),
      worker().autogenerate.claim('w2', 10_000, 60_000),
    ]);
    const claimed = [x, y].filter((j) => j !== null);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ id, status: 'running', started_at_ms: 10_000 });
    expect(claimed[0]?.locked_until_ms).toBe(70_000);
  });

  it('a running job with a lapsed lease is claimable, a live one is not; fenced writes ignore other holders', async () => {
    const r = await create('admin', { sessionIds: ['A'] }, { expected: 1 });
    const id = r.kind === 'created' ? r.job.id : '';
    const w = worker().autogenerate;
    expect((await w.claim('w1', 10_000, 60_000))?.id).toBe(id);
    expect(await w.claim('w2', 69_999, 60_000)).toBeNull();
    expect(await w.renew(id, 'w2', 20_000, 60_000)).toBe('lost');
    expect(await w.renew(id, 'w1', 20_000, 60_000)).toBe('ok');
    const taken = await w.claim('w2', 80_001, 60_000);
    expect(taken).toMatchObject({ id, locked_by: 'w2', started_at_ms: 10_000 });
    // w1 lost the lease: every fenced write changes nothing.
    expect(await w.renew(id, 'w1', 80_002, 60_000)).toBe('lost');
    expect(await w.updateItem(id, 'w1', 'A', 'wiki', { status: 'running', attempts: 1 })).toBe(0);
    expect(await w.cancelRemaining(id, 'w1', 'cancelled', 1)).toBe(0);
    expect(await w.setFailureCounts(id, 'w1', 1, 1, 1)).toBe(0);
    expect(await w.endJob(id, 'w1', 'finished', null, 1)).toBe(0);
    expect(await w.updateItem(id, 'w2', 'A', 'wiki', { status: 'running', attempts: 1 })).toBe(1);
    expect((await w.readJob(id))?.status).toBe('running');
  });

  it('a renewal of a job whose row was deleted reports gone', async () => {
    const r = await create('admin', { sessionIds: ['A'] }, { expected: 1 });
    const id = r.kind === 'created' ? r.job.id : '';
    const w = worker().autogenerate;
    await w.claim('w1', 10_000, 60_000);
    await sys`delete from autogenerate_jobs where id = ${id}`;
    expect(await w.renew(id, 'w1', 20_000, 60_000)).toBe('gone');
  });
});

describe('write-ahead and recorded partial output (design D7)', () => {
  it('appends are fenced and report 0 rows for a holder that lost the lease', async () => {
    const r = await create(
      'admin',
      { sessionIds: ['A'] },
      { expected: 1, steps: ['events', 'topics'] },
    );
    const id = r.kind === 'created' ? r.job.id : '';
    const w = worker().autogenerate;
    await w.claim('w1', 10_000, 60_000);
    expect(await w.appendRunId(id, 'w1', 'A', 'events', 'run-1')).toBe(1);
    expect(await w.appendRunId(id, 'w1', 'A', 'events', 'run-2')).toBe(1);
    expect(await w.appendTopicId(id, 'w1', 'A', 'topics', 'top-1')).toBe(1);
    expect(await w.appendTopicId(id, 'w2', 'A', 'topics', 'top-x')).toBe(0);
    await w.claim('w2', 80_000, 60_000);
    expect(await w.appendRunId(id, 'w1', 'A', 'events', 'run-3')).toBe(0);
    expect(await w.appendTopicId(id, 'w1', 'A', 'topics', 'top-2')).toBe(0);
    const items = await w.items(id);
    expect(items.find((i) => i.step === 'events')?.run_ids).toEqual(['run-1', 'run-2']);
    expect(items.find((i) => i.step === 'topics')?.own_topic_ids).toEqual(['top-1']);
  });

  it('returns the run and topic ids on non-done items of every job for the session and step', async () => {
    const w = worker().autogenerate;
    const one = await create(
      'admin',
      { sessionIds: ['B'] },
      { expected: 1, steps: ['events', 'topics'] },
    );
    const j1 = one.kind === 'created' ? one.job.id : '';
    await w.claim('w1', 10_000, 60_000);
    await w.appendRunId(j1, 'w1', 'B', 'events', 'r-a');
    await w.appendTopicId(j1, 'w1', 'B', 'topics', 't-a');
    await w.updateItem(j1, 'w1', 'B', 'events', { status: 'failed', outcome: 'interrupted' });
    await w.endJob(j1, 'w1', 'finished', null, 20_000);
    const two = await create(
      'owner',
      { sessionIds: ['B'] },
      { expected: 1, steps: ['events', 'topics'] },
    );
    const j2 = two.kind === 'created' ? two.job.id : '';
    await w.claim('w1', 30_000, 60_000);
    await w.appendRunId(j2, 'w1', 'B', 'events', 'r-b');
    await w.appendTopicId(j2, 'w1', 'B', 'topics', 't-b');
    await w.appendTopicId(j2, 'w1', 'B', 'topics', 't-c');
    await w.updateItem(j2, 'w1', 'B', 'topics', { status: 'done' });
    const ev = await w.recordedPartialOutput('B', 'events');
    expect(ev.runIds.sort()).toEqual(['r-a', 'r-b']);
    // j1's topics item is pending (not done): t-a counts; j2's is done: its ids don't.
    expect(await w.recordedPartialOutput('B', 'topics')).toEqual({ runIds: [], topicIds: ['t-a'] });
    expect(await w.recordedPartialOutput('C', 'events')).toEqual({ runIds: [], topicIds: [] });
  });
});

describe('list, detail and preview (design D14)', () => {
  it('lists the newest 20 of the team, newest first', async () => {
    for (let i = 0; i < 22; i++) {
      await sys`insert into autogenerate_jobs (id, team_id, initiator_user_id, initiator_name,
                  scope, steps, wiki_mode, status, session_count, created_at_ms, finished_at_ms,
                  updated_at_ms)
                values (${`v${String(i).padStart(2, '0')}`}, ${V}, 'owner', 'O', 'shows', 'wiki',
                  'accept', 'finished', 1, ${100 + i}, 1, 1)`;
    }
    const jobs = await as('owner').autogenerate.listJobs(V);
    expect(jobs).toHaveLength(20);
    expect(jobs[0]?.id).toBe('v21');
    expect(jobs[19]?.id).toBe('v02');
    // admin manages T, not V.
    expect(await as('admin').autogenerate.listJobs(V)).toEqual([]);
  });

  it('details items in order with current titles, "" for a vanished session', async () => {
    await session('gone', 'so2', { episode: '2023-01-01' });
    const r = await create(
      'admin',
      { sessionIds: ['a', 'gone'] },
      { expected: 2, steps: ['wiki'] },
    );
    const id = r.kind === 'created' ? r.job.id : '';
    await admin`delete from catalog.sessions where id = 'gone'`;
    await sys`update sessions set title = 'Renamed a' where id = 'a'`;
    const items = await as('admin').autogenerate.detailItems(id);
    expect(items.map((i) => [i.session_id, i.title, i.show_id, i.ordinal])).toEqual([
      ['gone', '', '', 0],
      ['a', 'Renamed a', 'so2', 1],
    ]);
    expect(await as('granted').autogenerate.getJob(T, id)).toBeNull();
  });

  it('preview counts missing transcript, auto-generated events and topics', async () => {
    expect(await as('admin').autogenerate.previewMissing(['p1', 'p2', 'p3'])).toEqual({
      transcript: 2,
      events: 2,
      topics: 2,
    });
  });
});
