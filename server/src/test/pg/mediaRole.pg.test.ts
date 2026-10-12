// media-worker design D1, D2 (task S.2): the worker role `autologger_media` of
// `20261019000000_media_jobs.sql` — created NOLOGIN by the migration, given LOGIN and its password
// by migrate.sh's password phase (MEDIA_DB_PASSWORD; docker/supabase/test_migrate.sh covers the
// runner), its attributes, its exact privileges, its RLS policies, and the `media_jobs` guard
// trigger and result size check (catalog-database "The media worker connects as its own
// read-mostly role"). The role's connection limit is 4, so this file holds at most two of its
// connections at once.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ConnOptions,
  connOptions,
  createTestDatabase,
  type TestDatabase,
} from '../../../../test/pg/testDb';

const MIGRATION = resolve(
  import.meta.dirname,
  '../../../../supabase/migrations/20261019000000_media_jobs.sql',
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

const ALLOWED = [
  'status',
  'locked_by',
  'locked_until_ms',
  'attempts',
  'run_after_ms',
  'result_json',
  'error',
  'updated_at_ms',
];

interface Seed {
  id: string;
  status: string;
  lockedBy?: string | null;
  lockedUntilMs?: number | null;
  attempts?: number;
}

/** A database with session `se`, segment `seg` and its seam, and the given jobs (as postgres). */
async function seeded(jobs: Seed[] = []): Promise<{ db: TestDatabase; admin: postgres.Sql }> {
  const db = await createTestDatabase();
  const admin = connect(db.admin);
  await admin`insert into catalog.sessions (id) values ('se')`;
  await admin`insert into catalog.session_audio_segments (session_id, id, ordinal, mime_type,
                r2_key, created_at_utc, media_status)
              values ('se', 'seg', 1, 'audio/webm', 'audio/se/1_seg.webm', 't', 'pending')`;
  await admin`insert into catalog.session_audio_seams (session_id, recording_ordinal,
                started_at_utc, segment_id, source_key)
              values ('se', 1, '2026-10-19T00:00:00.000Z', 'seg', 'audio/se/1_seg.webm')`;
  for (const j of jobs) {
    await admin`insert into catalog.media_jobs (id, kind, session_id, target, status, attempts,
                  input_bytes, run_after_ms, locked_by, locked_until_ms, created_at_ms,
                  updated_at_ms)
                values (${j.id}, 'ingest', 'se', ${`t-${j.id}`}, ${j.status}, ${j.attempts ?? 0},
                  10, 0, ${j.lockedBy ?? null}, ${j.lockedUntilMs ?? null}, 1, 1)`;
  }
  return { db, admin };
}

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return String((e as { code?: unknown }).code);
  }
};

describe('the media worker role (media-worker D1)', () => {
  it('logs in after the runner, with the designed attributes, limits and settings and no membership', async () => {
    const sql = connect(connOptions('postgres', 'postgres'));
    const [r] = await sql`select rolsuper, rolcreatedb, rolcreaterole, rolreplication,
                                 rolbypassrls, rolcanlogin, rolconnlimit, rolconfig
                          from pg_roles where rolname = 'autologger_media'`;
    expect(r).toMatchObject({
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
      rolbypassrls: false,
      rolcanlogin: true,
      rolconnlimit: 4,
    });
    expect([...(r?.rolconfig ?? [])].sort()).toEqual([
      'idle_in_transaction_session_timeout=15s',
      'search_path=catalog',
      'statement_timeout=30s',
    ]);
    const m = await sql`select count(*)::int as n from pg_auth_members
                        where member = 'autologger_media'::regrole`;
    expect(m[0]?.n).toBe(0);
    // The catalog roles keep exactly their two members (catalogRoles.pg.test.ts's rule).
    for (const role of ['catalog_user', 'catalog_system']) {
      const [x] = await sql`select pg_has_role('autologger_media', ${role}, 'USAGE') as u,
                                   pg_has_role('autologger_media', ${role}, 'SET') as s`;
      expect(x, role).toEqual({ u: false, s: false });
    }
    const db = await createTestDatabase();
    const media = connect(db.media);
    expect((await media`select current_user as u, current_setting('search_path') as p`)[0]).toEqual(
      {
        u: 'autologger_media',
        p: 'catalog',
      },
    );
  });

  it('is created NOLOGIN by the migration, which holds no password', () => {
    const text = readFileSync(MIGRATION, 'utf8');
    const sqlOnly = text
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('--'))
      .join('\n');
    expect(sqlOnly).toMatch(/create role autologger_media nologin;/);
    // The only LOGIN-related words are NOLOGIN; no password of any kind.
    expect(sqlOnly.match(/\b(no)?login\b/gi)?.every((w) => w.toLowerCase() === 'nologin')).toBe(
      true,
    );
    expect(sqlOnly).not.toMatch(/password/i);
  });

  it('holds exactly its grants: select and eight updatable columns on media_jobs, select on segments and seams', async () => {
    const { admin } = await seeded();
    const tables =
      await admin`select table_name, privilege_type from information_schema.role_table_grants
                               where grantee = 'autologger_media' order by 1, 2`;
    expect(tables.map((r) => `${r.table_name} ${r.privilege_type}`)).toEqual([
      'media_jobs SELECT',
      'session_audio_seams SELECT',
      'session_audio_segments SELECT',
    ]);
    const cols = await admin`select column_name from information_schema.column_privileges
                             where grantee = 'autologger_media' and table_name = 'media_jobs'
                               and privilege_type = 'UPDATE' order by 1`;
    expect(cols.map((r) => r.column_name)).toEqual([...ALLOWED].sort());
    const [u] =
      await admin`select has_schema_privilege('autologger_media', 'catalog', 'usage') as u,
                                   has_schema_privilege('autologger_media', 'catalog', 'create') as c`;
    expect(u).toEqual({ u: true, c: false });
    const policies = await admin`select tablename, cmd from pg_policies
                                 where schemaname = 'catalog' and 'autologger_media' = any(roles)
                                 order by 1, 2`;
    expect(policies.map((p) => `${p.tablename} ${p.cmd}`)).toEqual([
      'media_jobs SELECT',
      'media_jobs UPDATE',
      'session_audio_seams SELECT',
      'session_audio_segments SELECT',
    ]);
  });

  it('reads jobs, segments and seams and updates allowed job columns; everything else is 42501', async () => {
    const now = Date.now();
    const { db } = await seeded([{ id: 'q', status: 'queued' }]);
    const w = connect(db.media);
    expect((await w`select id from media_jobs`).map((r) => r.id)).toEqual(['q']);
    expect((await w`select id from session_audio_segments`).map((r) => r.id)).toEqual(['seg']);
    expect((await w`select segment_id from session_audio_seams`).map((r) => r.segment_id)).toEqual([
      'seg',
    ]);
    // A claim writes every allowed column but result_json and error, then finish writes those.
    const claim = await w`update media_jobs set status = 'running', locked_by = 'w1',
                            locked_until_ms = ${now + 600_000}, attempts = attempts + 1,
                            run_after_ms = run_after_ms, updated_at_ms = ${now}
                          where id = 'q' returning id`;
    expect(claim.count).toBe(1);
    const done = await w`update media_jobs set status = 'done', locked_by = 'w1',
                           result_json = '{}', error = null, updated_at_ms = ${now}
                         where id = 'q' and locked_by = 'w1' and status = 'running'`;
    expect(done.count).toBe(1);
    for (const stmt of [
      `update media_jobs set kind = 'merge'`,
      `update media_jobs set session_id = 'se'`,
      `update media_jobs set target = 'x'`,
      `update media_jobs set applied_at_ms = 1`,
      `update media_jobs set max_attempts = 99`,
      `update media_jobs set input_bytes = 0`,
      `insert into media_jobs (id, kind, session_id, target, input_bytes, run_after_ms,
         created_at_ms, updated_at_ms) values ('n', 'ingest', 'se', 'n', 1, 1, 1, 1)`,
      'delete from media_jobs',
      `update session_audio_segments set media_status = 'done'`,
      `insert into session_audio_segments (session_id, id, ordinal, mime_type, r2_key,
         created_at_utc) values ('se', 'x', 2, 'audio/webm', 'k', 't')`,
      'delete from session_audio_segments',
      `update session_audio_seams set offset_ms = 1`,
      'delete from session_audio_seams',
      'select 1 from sessions',
      'select 1 from session_events',
      'select 1 from kv',
      'select 1 from users',
      'select 1 from media_uploads',
      'select 1 from session_leases',
      'set role catalog_system',
      'set role catalog_user',
      'create table catalog.x (i int)',
    ]) {
      expect(await code(w.unsafe(stmt)), stmt).toBe('42501');
    }
  });
});

describe('the media_jobs guard trigger (media-worker D2)', () => {
  const later = () => Date.now() + 600_000;
  const earlier = () => Date.now() - 1_000;
  const claimAs = (w: postgres.Sql, id: string, worker: string) =>
    code(w`update media_jobs set status = 'running', locked_by = ${worker},
             locked_until_ms = ${later()}, attempts = attempts + 1, updated_at_ms = 2
           where id = ${id}`);

  it('allows claiming a queued job whose lease is free or expired, and refuses a held one', async () => {
    const { db, admin } = await seeded([
      { id: 'free', status: 'queued' },
      { id: 'expired', status: 'queued', lockedBy: 'w0', lockedUntilMs: earlier() },
      { id: 'released', status: 'queued', lockedBy: 'w0', lockedUntilMs: null },
      { id: 'held', status: 'queued', lockedBy: 'w0', lockedUntilMs: later() },
      { id: 'running', status: 'running', lockedBy: 'w0', lockedUntilMs: later(), attempts: 1 },
    ]);
    const w = connect(db.media);
    expect(await claimAs(w, 'free', 'w1')).toBe('ok');
    expect(await claimAs(w, 'expired', 'w1')).toBe('ok');
    expect(await claimAs(w, 'released', 'w1')).toBe('ok');
    expect(await claimAs(w, 'held', 'w1')).toBe('42501');
    expect(await claimAs(w, 'running', 'w1')).toBe('42501');
    // A claim counts exactly one attempt.
    expect(
      await code(w`update media_jobs set status = 'running', locked_by = 'w1',
                     locked_until_ms = ${later()}, attempts = 0 where id = 'free'`),
    ).toBe('42501');
    const rows = await admin`select id, status, locked_by from catalog.media_jobs order by id`;
    expect(rows.map((r) => `${r.id} ${r.status} ${r.locked_by}`)).toEqual([
      'expired running w1',
      'free running w1',
      'held queued w0',
      'released running w1',
      'running running w0',
    ]);
  });

  it('lets the holder renew, finish, fail or re-queue its job and refuses another holder', async () => {
    const { db, admin } = await seeded(
      ['a', 'b', 'c', 'd', 'e'].map((id) => ({
        id,
        status: 'running',
        lockedBy: 'w1',
        lockedUntilMs: later(),
        attempts: 1,
      })),
    );
    const w = connect(db.media);
    // Another holder: refused for every transition.
    for (const status of ['done', 'failed', 'queued', 'running']) {
      expect(
        await code(w`update media_jobs set status = ${status}, locked_by = 'w2' where id = 'a'`),
        status,
      ).toBe('42501');
    }
    // A lease holder cannot clear its id (which would free the job for a takeover).
    expect(
      await code(w`update media_jobs set status = 'queued', locked_by = null where id = 'a'`),
    ).toBe('42501');
    expect(
      await code(w`update media_jobs set locked_until_ms = ${later() + 60_000}, locked_by = 'w1'
                   where id = 'a'`),
    ).toBe('ok');
    expect(
      await code(w`update media_jobs set status = 'done', locked_by = 'w1', result_json = '{}'
                   where id = 'b'`),
    ).toBe('ok');
    expect(
      await code(w`update media_jobs set status = 'failed', locked_by = 'w1', error = 'internal'
                   where id = 'c'`),
    ).toBe('ok');
    expect(
      await code(w`update media_jobs set status = 'queued', locked_by = 'w1',
                     locked_until_ms = null, run_after_ms = 5 where id = 'd'`),
    ).toBe('ok');
    const rows = await admin`select id, status from catalog.media_jobs order by id`;
    expect(rows.map((r) => `${r.id} ${r.status}`)).toEqual([
      'a running',
      'b done',
      'c failed',
      'd queued',
      'e running',
    ]);
  });

  it('refuses every other transition, and a result over 256 KiB', async () => {
    const { db } = await seeded([
      { id: 'q', status: 'queued' },
      { id: 'r', status: 'running', lockedBy: 'w1', lockedUntilMs: later(), attempts: 1 },
      { id: 'd', status: 'done', lockedBy: 'w1', lockedUntilMs: later(), attempts: 1 },
      { id: 'f', status: 'failed', lockedBy: 'w1', attempts: 5 },
    ]);
    const w = connect(db.media);
    for (const [id, status] of [
      ['q', 'applied'],
      ['q', 'done'],
      ['q', 'failed'],
      ['q', 'cancelled'],
      ['r', 'applied'],
      ['r', 'cancelled'],
      ['d', 'queued'],
      ['d', 'running'],
      ['d', 'applied'],
      ['f', 'queued'],
    ] as const) {
      expect(
        await code(w`update media_jobs set status = ${status}, locked_by = 'w1' where id = ${id}`),
        `${id} → ${status}`,
      ).toBe('42501');
    }
    // A queued job's columns cannot be changed without claiming it (no rescheduling by hand).
    expect(await code(w`update media_jobs set run_after_ms = 0 where id = 'q'`)).toBe('42501');
    expect(
      await code(w`update media_jobs set status = 'done', locked_by = 'w1',
                     result_json = ${'x'.repeat(300 * 1024)} where id = 'r'`),
    ).toBe('23514');
  });

  // All workers share one role, so the trigger cannot tell them apart: a worker's own statements
  // are fenced on `locked_by = <its id>` (mediaJobs.ts), and the trigger only forbids moving a job
  // to another holder outside a claim of a free or expired lease.
  it('lets a sweep re-queue or fail an expired running job, keeping the holder', async () => {
    const { db, admin } = await seeded([
      { id: 'x', status: 'running', lockedBy: 'w1', lockedUntilMs: earlier(), attempts: 1 },
      { id: 'y', status: 'running', lockedBy: 'w1', lockedUntilMs: earlier(), attempts: 5 },
    ]);
    const w = connect(db.media);
    const sweep = (id: string, status: string) =>
      code(w`update media_jobs set status = ${status}, locked_until_ms = null, run_after_ms = 9
             where id = ${id}`);
    expect(await sweep('x', 'queued')).toBe('ok');
    expect(await sweep('y', 'failed')).toBe('ok');
    const rows = await admin`select id, status, locked_by from catalog.media_jobs order by id`;
    expect(rows.map((r) => `${r.id} ${r.status} ${r.locked_by}`)).toEqual([
      'x queued w1',
      'y failed w1',
    ]);
  });

  it('does not bind catalog_system or postgres', async () => {
    const { db, admin } = await seeded([{ id: 'd', status: 'done', lockedBy: 'w1' }]);
    const sys = connect(db.system);
    await sys`update media_jobs set status = 'applied', applied_at_ms = 3 where id = 'd'`;
    await admin`update catalog.media_jobs set status = 'queued', locked_by = null where id = 'd'`;
    expect((await admin`select status from catalog.media_jobs`)[0]?.status).toBe('queued');
  });
});
