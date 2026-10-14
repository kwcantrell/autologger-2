// media-worker design D2, D7, D12, D18 (task S.1): the media tables of
// `20261023000000_media_jobs.sql` — `catalog.media_jobs`, `catalog.media_uploads`,
// `catalog.session_audio_seams` — the three new `session_audio_segments` columns, row-level
// security, the `catalog_system` allow-all policies and the `catalog_user` rules (catalog-database
// "The media worker connects as its own read-mostly role"). The worker role's grants are
// mediaRole.pg.test.ts's.
import postgres from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import { type ConnOptions, createTestDatabase } from '../../../../test/pg/testDb';
import { seedPolicyFixture } from './policyFixture';

const open: postgres.Sql[] = [];
function connect(o: ConnOptions): postgres.Sql {
  const sql = postgres({ ...o, max: 1, onnotice: () => {} });
  open.push(sql);
  return sql;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.end()));
});

const MEDIA_TABLES = ['media_jobs', 'media_uploads', 'session_audio_seams'] as const;

async function columns(sql: postgres.Sql, table: string): Promise<string[]> {
  const rows = await sql`select column_name, data_type, is_nullable, column_default
                         from information_schema.columns
                         where table_schema = 'catalog' and table_name = ${table}
                         order by ordinal_position`;
  return rows.map(
    (c) =>
      `${c.column_name} ${c.data_type}${c.is_nullable === 'NO' ? ' not null' : ''}` +
      `${c.column_default === null ? '' : ` default ${c.column_default}`}`,
  );
}

describe('the media tables (media-worker D2, D7, D12)', () => {
  it('media_jobs has the D2 columns, the live-job unique index and the result size check', async () => {
    const db = await createTestDatabase();
    const sql = connect(db.admin);
    expect(await columns(sql, 'media_jobs')).toEqual([
      'id text not null',
      'kind text not null',
      'session_id text not null',
      'target text not null',
      "status text not null default 'queued'::text",
      'attempts integer not null default 0',
      'max_attempts integer not null default 5',
      'input_bytes bigint not null',
      'run_after_ms bigint not null',
      'locked_by text',
      'locked_until_ms bigint',
      'result_json text',
      'error text',
      'created_at_ms bigint not null',
      'updated_at_ms bigint not null',
      'applied_at_ms bigint',
    ]);
    const [idx] = await sql`select indexdef from pg_indexes
                            where schemaname = 'catalog' and indexname = 'idx_media_jobs_live'`;
    expect(idx?.indexdef).toBe(
      "CREATE UNIQUE INDEX idx_media_jobs_live ON catalog.media_jobs USING btree (kind, session_id, target) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text, 'done'::text]))",
    );
    const sys = connect(db.system);
    await sys`insert into sessions (id) values ('se')`;
    const job = (id: string, status: string, result: string | null = null) =>
      sys`insert into media_jobs (id, kind, session_id, target, status, input_bytes, run_after_ms,
            result_json, created_at_ms, updated_at_ms)
          values (${id}, 'ingest', 'se', 'seg-1', ${status}, 10, 1, ${result}, 1, 1)`;
    await job('j1', 'queued');
    // A second live job for the same target is refused; a terminal one is not.
    await expect(job('j2', 'running')).rejects.toMatchObject({ code: '23505' });
    await job('j3', 'failed');
    await job('j4', 'applied');
    // result_json: at most 256 KiB (262 144 bytes).
    await job('j5', 'cancelled', 'x'.repeat(262_144));
    await expect(job('j6', 'cancelled', 'x'.repeat(262_145))).rejects.toMatchObject({
      code: '23514',
    });
    // kind and status are closed sets.
    await expect(
      sys`insert into media_jobs (id, kind, session_id, target, input_bytes, run_after_ms,
            created_at_ms, updated_at_ms) values ('j7', 'transcode', 'se', 't', 1, 1, 1, 1)`,
    ).rejects.toMatchObject({ code: '23514' });
    await expect(job('j8', 'paused')).rejects.toMatchObject({ code: '23514' });
    // The session must exist.
    await expect(
      sys`insert into media_jobs (id, kind, session_id, target, input_bytes, run_after_ms,
            created_at_ms, updated_at_ms) values ('j9', 'merge', 'nope', '1', 1, 1, 1, 1)`,
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('media_uploads has the D12 columns', async () => {
    const db = await createTestDatabase();
    expect(await columns(connect(db.admin), 'media_uploads')).toEqual([
      'id text not null',
      'session_id text not null',
      'created_by_user_id text not null',
      'content_type text not null',
      'size_bytes bigint not null',
      'part_size bigint not null',
      'parts_total integer not null',
      'part_sha256_json text not null',
      "received_json text not null default '[]'::text",
      "status text not null default 'open'::text",
      'expires_at_ms bigint not null',
      'created_at_ms bigint not null',
    ]);
  });

  it('session_audio_seams is keyed by the recording window and points at a segment', async () => {
    const db = await createTestDatabase();
    const sql = connect(db.admin);
    expect(await columns(sql, 'session_audio_seams')).toEqual([
      'session_id text not null',
      'recording_ordinal bigint not null',
      'started_at_utc text not null',
      'ended_at_utc text',
      'segment_id text not null',
      'offset_ms bigint not null default 0',
      'source_key text not null',
    ]);
    const pk = await sql`select a.attname from pg_index i
      join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
      where i.indrelid = 'catalog.session_audio_seams'::regclass and i.indisprimary
      order by array_position(i.indkey, a.attnum)`;
    expect(pk.map((r) => r.attname)).toEqual(['session_id', 'recording_ordinal', 'started_at_utc']);
    const sys = connect(db.system);
    await sys`insert into sessions (id) values ('se')`;
    await sys`insert into session_audio_segments (session_id, id, ordinal, mime_type, r2_key,
                created_at_utc) values ('se', 'a', 1, 'audio/webm', 'audio/se/1_a.webm', 't')`;
    const seam = (start: string, seg = 'a') =>
      sys`insert into session_audio_seams (session_id, recording_ordinal, started_at_utc,
            ended_at_utc, segment_id, source_key)
          values ('se', 1, ${start}, null, ${seg}, 'audio/se/1_a.webm')`;
    await seam('2026-10-19T00:00:00.000Z');
    await expect(seam('2026-10-19T00:00:00.000Z')).rejects.toMatchObject({ code: '23505' });
    // A seam names an existing segment, and goes with it.
    await expect(seam('2026-10-19T00:10:00.000Z', 'missing')).rejects.toMatchObject({
      code: '23503',
    });
    await sys`delete from session_audio_segments where id = 'a'`;
    expect((await sys`select count(*)::int as n from session_audio_seams`)[0]?.n).toBe(0);
  });

  it('session_audio_segments gains duration_ms, media_status and media_error', async () => {
    const db = await createTestDatabase();
    const cols = await columns(connect(db.admin), 'session_audio_segments');
    expect(cols.slice(-3)).toEqual(['duration_ms bigint', 'media_status text', 'media_error text']);
    const sys = connect(db.system);
    await sys`insert into sessions (id) values ('se')`;
    const seg = (id: string, status: string | null) =>
      sys`insert into session_audio_segments (session_id, id, ordinal, mime_type, r2_key,
            created_at_utc, media_status) values ('se', ${id}, 1, 'audio/webm', 'k', 't', ${status})`;
    await seg('legacy', null);
    await seg('p', 'pending');
    await seg('d', 'done');
    await seg('f', 'failed');
    await expect(seg('x', 'queued')).rejects.toMatchObject({ code: '23514' });
    await expect(
      sys`update session_audio_segments set duration_ms = -1 where id = 'p'`,
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('row-level security on the media tables (catalog-database, media-worker D1, D2, D12)', () => {
  it('each has RLS, a catalog_system allow-all policy and catalog_user rules that are never true', async () => {
    const db = await createTestDatabase();
    const sql = connect(db.admin);
    for (const t of MEDIA_TABLES) {
      const [c] = await sql`select relrowsecurity from pg_class
                            where oid = ${`catalog.${t}`}::regclass`;
      expect(c?.relrowsecurity, t).toBe(true);
      const policies = await sql`select policyname, cmd, roles::text[] as roles, qual, with_check
                                 from pg_policies where schemaname = 'catalog' and tablename = ${t}
                                 order by policyname`;
      const sys = policies.find((p) => p.policyname === `${t}_system_all`);
      expect(sys, t).toMatchObject({ cmd: 'ALL', roles: ['catalog_system'], qual: 'true' });
      for (const p of policies.filter((x) => (x.roles as string[]).includes('catalog_user'))) {
        expect(p.qual, p.policyname).not.toBe('true');
        expect(p.with_check, p.policyname).not.toBe('true');
      }
    }
    const userCmds = async (t: string) =>
      (
        await sql`select cmd from pg_policies where schemaname = 'catalog' and tablename = ${t}
                  and 'catalog_user' = any(roles) order by cmd`
      ).map((r) => r.cmd);
    expect(await userCmds('media_jobs')).toEqual(['INSERT', 'SELECT']);
    expect(await userCmds('media_uploads')).toEqual(['ALL']);
    expect(await userCmds('session_audio_seams')).toEqual(['ALL']);
    const privs = async (t: string) => {
      const out: string[] = [];
      for (const p of ['select', 'insert', 'update', 'delete']) {
        const [r] =
          await sql`select has_table_privilege('catalog_user', ${`catalog.${t}`}, ${p}) as x`;
        if (r?.x) out.push(p);
      }
      return out;
    };
    expect(await privs('media_jobs')).toEqual(['select', 'insert']);
    expect(await privs('media_uploads')).toEqual(['select', 'insert', 'update', 'delete']);
    expect(await privs('session_audio_seams')).toEqual(['select', 'insert', 'update', 'delete']);
  });

  // Session ss1 belongs to show s1 of team T (owner `owner`; `granted` holds a grant on s1); ssu
  // to team U's show. Each case runs as catalog_user in a transaction that rolls back, after
  // `seed` as catalog_system.
  async function harness() {
    const db = await createTestDatabase();
    await seedPolicyFixture(connect(db.system));
    const sql = connect(db.app);
    class Rollback extends Error {}
    type Out = { count: number } | { code: string };
    const run = async (uid: string, seed: string[], ...stmts: string[]) => {
      const out: Out[] = [];
      await sql
        .begin(async (tx) => {
          await tx`select set_config('role', 'catalog_system', true), set_config('app.user_id', '', true)`;
          for (const s of seed) await tx.unsafe(s);
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
    };
    return run;
  }

  it('catalog_user enqueues and reads jobs only for accessible sessions, and cannot steer them', async () => {
    const run = await harness();
    const insert = (session: string, id: string) =>
      `insert into media_jobs (id, kind, session_id, target, input_bytes, run_after_ms,
         created_at_ms, updated_at_ms) values ('${id}', 'ingest', '${session}', 'c', 1, 1, 1, 1)`;
    const seed = [insert('ss1', 'sys-1'), insert('ssu', 'sys-u')];
    for (const [uid, access] of [
      ['owner', true],
      ['granted', true],
      ['ungranted', false],
      ['outsider', false],
    ] as const) {
      expect(await run(uid, [], insert('ss1', 'new')), `insert ${uid}`).toEqual([
        access ? { count: 1 } : { code: '42501' },
      ]);
      expect(
        await run(uid, seed, `select 1 from media_jobs where session_id = 'ss1'`),
        `select ${uid}`,
      ).toEqual([{ count: access ? 1 : 0 }]);
    }
    expect(await run('owner', [], insert('ssu', 'new'))).toEqual([{ code: '42501' }]);
    // ON CONFLICT DO NOTHING on the live index (the enqueue) works for a user binding.
    expect(
      await run(
        'owner',
        seed,
        `${insert('ss1', 'dup')} on conflict (kind, session_id, target)
           where status in ('queued', 'running', 'done') do nothing`,
      ),
    ).toEqual([{ count: 0 }]);
    // No update or delete: refused before any policy, so no row changes.
    for (const stmt of [
      `update media_jobs set status = 'applied'`,
      `update media_jobs set run_after_ms = 0 where id = 'sys-1'`,
      'delete from media_jobs',
    ]) {
      expect(await run('owner', seed, stmt), stmt).toEqual([{ code: '42501' }]);
    }
  });

  it('catalog_user sees and changes only the uploads it created on sessions it can access', async () => {
    const run = await harness();
    const insert = (session: string, id: string, by: string) =>
      `insert into media_uploads (id, session_id, created_by_user_id, content_type, size_bytes,
         part_size, parts_total, part_sha256_json, expires_at_ms, created_at_ms)
       values ('${id}', '${session}', '${by}', 'audio/wav', 10, 10, 1, '["${'0'.repeat(64)}"]', 9, 1)`;
    const seed = [insert('ss1', 'u-owner', 'owner'), insert('ss1', 'u-granted', 'granted')];
    expect(await run('owner', [], insert('ss1', 'n', 'owner'))).toEqual([{ count: 1 }]);
    expect(await run('granted', [], insert('ss1', 'n', 'granted'))).toEqual([{ count: 1 }]);
    // Not as another user, not on an inaccessible session.
    expect(await run('owner', [], insert('ss1', 'n', 'granted'))).toEqual([{ code: '42501' }]);
    expect(await run('ungranted', [], insert('ss1', 'n', 'ungranted'))).toEqual([
      { code: '42501' },
    ]);
    expect(await run('owner', [], insert('ssu', 'n', 'owner'))).toEqual([{ code: '42501' }]);
    for (const [uid, n] of [
      ['owner', 1],
      ['granted', 1],
      ['admin', 0],
      ['outsider', 0],
    ] as const) {
      expect(await run(uid, seed, 'select 1 from media_uploads'), `select ${uid}`).toEqual([
        { count: n },
      ]);
      expect(
        await run(uid, seed, `update media_uploads set received_json = '[1]'`),
        `update ${uid}`,
      ).toEqual([{ count: n }]);
      expect(await run(uid, seed, 'delete from media_uploads'), `delete ${uid}`).toEqual([
        { count: n },
      ]);
    }
    // A user cannot hand an upload to someone else.
    expect(
      await run('owner', seed, `update media_uploads set created_by_user_id = 'granted'`),
    ).toEqual([{ code: '42501' }]);
  });

  it('catalog_user reads and writes seams like the session tables', async () => {
    const run = await harness();
    const seg = (session: string) =>
      `insert into session_audio_segments (session_id, id, ordinal, mime_type, r2_key, created_at_utc)
       values ('${session}', 'seg', 1, 'audio/webm', 'k', 't')`;
    const seam = (session: string, start: string) =>
      `insert into session_audio_seams (session_id, recording_ordinal, started_at_utc, segment_id,
         source_key) values ('${session}', 1, '${start}', 'seg', 'k')`;
    const seed = [seg('ss1'), seg('ssu'), seam('ss1', 'a'), seam('ssu', 'a')];
    for (const [uid, access] of [
      ['owner', true],
      ['granted', true],
      ['ungranted', false],
      ['outsider', false],
    ] as const) {
      const n = access ? 1 : 0;
      expect(
        await run(uid, seed, `select 1 from session_audio_seams where session_id = 'ss1'`),
        uid,
      ).toEqual([{ count: n }]);
      expect(
        await run(
          uid,
          seed,
          `update session_audio_seams set offset_ms = 5 where session_id = 'ss1'`,
        ),
        uid,
      ).toEqual([{ count: n }]);
      expect(
        await run(uid, seed, `delete from session_audio_seams where session_id = 'ss1'`),
        uid,
      ).toEqual([{ count: n }]);
      expect(await run(uid, seed, seam('ss1', 'b')), uid).toEqual([
        access ? { count: 1 } : { code: '42501' },
      ]);
    }
  });
});
