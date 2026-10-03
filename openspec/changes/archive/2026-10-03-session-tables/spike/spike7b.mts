// session-tables (ADR 0021 slice 7b-1) spike: the assumptions in design.md, against the pinned
// supabase/postgres image with the real migrate.sh, the merged migrations and this spike's draft
// migration (spike/20261008000000_session_tables.sql). It emulates the adapter's protocol with
// postgres.js directly (single-connection clients, `unsafe(text, binds, { prepare: true })`, the
// bindings preamble, int8 parsed as a number), because the session adapter does not exist yet.
// Run from the repo root (needs a docker daemon):
//   npx tsx openspec/changes/session-tables/spike/spike7b.mts
import { randomBytes, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import postgres from 'postgres';
import { startTestPostgres } from '../../../../test/pg/globalSetup';

const repo = resolve(import.meta.dirname, '../../../..');
const here = import.meta.dirname;

// A scratch "repo root" whose supabase/migrations holds the merged files plus the draft.
const root = mkdtempSync(join(tmpdir(), 'spike7b-'));
mkdirSync(join(root, 'supabase/migrations'), { recursive: true });
mkdirSync(join(root, 'docker/supabase'), { recursive: true });
for (const f of readdirSync(join(repo, 'supabase/migrations'))) {
  copyFileSync(join(repo, 'supabase/migrations', f), join(root, 'supabase/migrations', f));
}
copyFileSync(
  join(here, '20261008000000_session_tables.sql'),
  join(root, 'supabase/migrations/20261008000000_session_tables.sql'),
);
copyFileSync(join(repo, 'docker/supabase/migrate.sh'), join(root, 'docker/supabase/migrate.sh'));

const { spawn } = await import('node:child_process');
const docker = (args: string[], env?: Record<string, string>) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
    const c = spawn('docker', args, { env: env ? { ...process.env, ...env } : process.env });
    let stdout = '';
    let stderr = '';
    c.stdout.on('data', (b) => (stdout += b));
    c.stderr.on('data', (b) => (stderr += b));
    c.on('close', (code) => done({ code: code ?? 1, stdout, stderr }));
  });
const yaml = (await import('node:fs')).readFileSync(join(repo, 'docker/supabase-db.yaml'), 'utf8');
const image = /^x-image: &image (\S+)$/m.exec(yaml)?.[1] as string;
const pg = await startTestPostgres({
  docker,
  pid: process.pid,
  hostname: hostname(),
  isAlive: () => true,
  randomHex: (n) => randomBytes(n).toString('hex'),
  image,
  repoRoot: root,
  probe: async (port, pw) => {
    const s = postgres({ host: '127.0.0.1', port, user: 'postgres', password: pw, database: 'postgres', max: 1, connect_timeout: 2, onnotice: () => {} });
    try {
      await s`select 1`;
      return true;
    } catch {
      return false;
    } finally {
      await s.end({ timeout: 1 }).catch(() => {});
    }
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
});

const out: string[] = [];
const log = (...a: unknown[]) => {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  out.push(line);
  console.log(line);
};
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

try {
  const db = `t_${randomBytes(6).toString('hex')}`;
  const sup = postgres({ host: pg.host, port: pg.port, user: 'postgres', password: pg.superPassword, database: 'postgres', max: 1, onnotice: () => {} });
  await sup.unsafe(`create database ${db} template autologger_template`);
  await sup.end();
  const conn = (user: 'postgres' | 'autologger_app') => ({
    host: pg.host,
    port: pg.port,
    user,
    password: user === 'postgres' ? pg.superPassword : pg.appPassword,
    database: db,
  });
  // As the adapter connects (postgres-catalog-adapter D1): one connection, int8 as a number.
  const client = () =>
    postgres({
      ...conn('autologger_app'),
      max: 1,
      onnotice: () => {},
      types: { bigint: { to: 20, from: [20], parse: Number, serialize: String } },
    });
  const admin = postgres({ ...conn('postgres'), max: 1, onnotice: () => {} });
  const PRE = "select set_config('role', $1, true), set_config('app.user_id', $2, true)";
  const sys = ['catalog_system', ''];

  // --- A1 version and migration -------------------------------------------------------------
  log('A1', (await admin`select version()`)[0]?.version.split(' on ')[0]);
  const tables = await admin`select c.relname, c.relrowsecurity from pg_class c
    where c.relnamespace = 'catalog'::regnamespace and c.relkind = 'r' and c.relname like 'session\\_%' order by 1`;
  log('A1 session tables', tables.map((t) => `${t.relname}:${t.relrowsecurity ? 'rls' : 'no-rls'}`).join(' '));

  // Two sessions to play with (written by the owner, which bypasses RLS).
  const t0 = '2026-10-08T00:00:00.000Z';
  await admin.unsafe(`
    insert into catalog.studio_definitions (id, display_name, created_at_utc) values ('st', 'S', '${t0}');
    insert into catalog.shows (id, studio_id, name, show_code, created_at_utc) values ('sh', 'st', 'N', 'C', '${t0}');
    insert into catalog.sessions (id, show_id, event_count, current_take) values ('s1', 'sh', 7, 3), ('s2', 'sh', 0, 0);`);

  // --- A2 JSON parity: SQLite (today) vs Postgres json / jsonb ------------------------------
  const lite = new Database(':memory:');
  const liteAuto = (m: string) =>
    lite.prepare(`SELECT CASE WHEN json_valid(?) THEN json_type(?, '$.auto_generated') = 'true' ELSE 0 END AS v`).get(m, m) as { v: number | null };
  const corpus = ['{"auto_generated":true}', '{"auto_generated":true,"auto_generate_run_id":"r1"}', '{"auto_generated":false}', '{"auto_generated":1}', '{"auto_generated":"true"}', '{}', '', '{"auto_generated":true', '[true]', 'null', '{"auto_generated":false,"auto_generated":true}', '{"auto_generated":true,"x":"\\u0000"}', ' {"auto_generated":true} '];
  const jsAuto = (m: string) => {
    try {
      const p = JSON.parse(m || '{}');
      return p !== null && typeof p === 'object' && !Array.isArray(p) && p.auto_generated === true;
    } catch {
      return false;
    }
  };
  const c0 = client();
  const pgJson = async (m: string) =>
    (await c0.unsafe(
      `select coalesce(case when pg_input_is_valid($1, 'json') then json_typeof($1::json -> 'auto_generated') = 'boolean' and ($1::json ->> 'auto_generated') = 'true' end, false) as v`,
      [m],
      { prepare: true },
    ).then((r) => r[0]?.v, (e) => `error ${e.code}`));
  const pgJsonb = async (m: string) =>
    (await c0.unsafe(
      `select coalesce(case when pg_input_is_valid($1, 'jsonb') then ($1::jsonb -> 'auto_generated') = 'true'::jsonb end, false) as v`,
      [m],
      { prepare: true },
    ).then((r) => r[0]?.v, (e) => `error ${e.code}`));
  for (const m of corpus) {
    log('A2', JSON.stringify(m), 'js', jsAuto(m), 'sqlite', Boolean(liteAuto(m).v), 'pg-json', await pgJson(m), 'pg-jsonb', await pgJsonb(m));
  }
  // The relink pre-check: json_extract(metadata_json, '$.<key>') IS NOT NULL.
  const relinkCorpus = ['{"al_category_label_snapshot":"A"}', '{"al_category_label_snapshot":null}', '{"al_category_label_snapshot":0}', '{}', '[1]', 'null', '{"al_category_label_snapshot":{"x":1}}'];
  for (const m of relinkCorpus) {
    const l = (lite.prepare('SELECT json_extract(?, ?) IS NOT NULL AS v').get(m, '$.al_category_label_snapshot') as { v: number }).v;
    const p = (await c0.unsafe(
      `select coalesce(case when pg_input_is_valid($1, 'jsonb') then jsonb_typeof($1::jsonb -> $2) <> 'null' end, false) as v`,
      [m, 'al_category_label_snapshot'],
      { prepare: true },
    ))[0]?.v;
    log('A2 relink', JSON.stringify(m), 'sqlite', Boolean(l), 'pg-jsonb', p);
  }
  let liteMalformed = 'no error';
  try {
    lite.prepare('SELECT json_extract(?, ?) AS v').get('{"a":', '$.a');
  } catch (e) {
    liteMalformed = (e as Error).message;
  }
  log('A2 relink sqlite on malformed json:', liteMalformed);

  // --- A3 lower/trim parity under COLLATE "C" --------------------------------------------------
  for (const v of ['internal', 'INTERNAL', ' Internal ', '\tinternal', 'ÍNTERNAL', 'İNTERNAL']) {
    const l = (lite.prepare("SELECT lower(trim(?)) != 'internal' AS v").get(v) as { v: number }).v;
    const p = (await c0.unsafe(`select lower(trim($1::text collate "C")) <> 'internal' as v`, [v], { prepare: true }))[0]?.v;
    log('A3', JSON.stringify(v), 'sqlite logged', Boolean(l), 'pg logged', p);
  }

  // --- A4 lock on a missing row; FK; seed; RLS --------------------------------------------------
  {
    const c = client();
    await c.unsafe('begin isolation level read committed');
    await c.unsafe(PRE, sys, { prepare: true });
    const r = await c.unsafe('select 1 as locked from sessions where id = $1 for update', ['nope'], { prepare: true });
    log('A4 lock rows for a missing session', r.length);
    try {
      await c.unsafe(`insert into session_meta (session_id, key, value) values ($1, 'events_stream_revision', '0')`, ['nope'], { prepare: true });
    } catch (e) {
      log('A4 content row for an unknown session', (e as { code: string }).code, (e as { constraint_name?: string }).constraint_name);
    }
    await c.unsafe('rollback');
    await c.unsafe('begin isolation level read committed');
    await c.unsafe(PRE, sys, { prepare: true });
    for (const sid of ['s1', 's2']) {
      await c.unsafe('insert into session_transport (session_id) values ($1) on conflict do nothing', [sid], { prepare: true });
      await c.unsafe(`insert into session_meta (session_id, key, value) values ($1, 'events_stream_revision', '0') on conflict do nothing`, [sid], { prepare: true });
      await c.unsafe('insert into session_transport (session_id) values ($1) on conflict do nothing', [sid], { prepare: true });
    }
    log('A4 seed twice, rows', (await c.unsafe('select count(*) as n from session_transport'))[0]?.n, (await c.unsafe('select count(*) as n from session_meta'))[0]?.n);
    await c.unsafe('commit');
    for (const [role, uid] of [['catalog_user', 'u1']] as const) {
      for (const stmt of ['select count(*) from session_events', `insert into session_meta (session_id, key, value) values ('s1', 'k', 'v')`, 'update session_transport set is_rolling = 0', 'delete from session_topics']) {
        await c.unsafe('begin');
        await c.unsafe(PRE, [role, uid], { prepare: true });
        try {
          await c.unsafe(stmt);
          log('A4', role, stmt.split(' ')[0], 'allowed');
        } catch (e) {
          log('A4', role, stmt.split(' ')[0], (e as { code: string }).code);
        }
        await c.unsafe('rollback');
      }
    }
    await c.unsafe('begin isolation level repeatable read read only');
    await c.unsafe(PRE, sys, { prepare: true });
    try {
      await c.unsafe("update session_meta set value = '1' where session_id = 's1'");
    } catch (e) {
      log('A4 write in a read-only snapshot', (e as { code: string }).code);
    }
    await c.unsafe('rollback');
    for (const [label, sqlText, binds] of [
      ['fractional into bigint', `update session_transport set elapsed_frames = $1 where session_id = 's1'`, [1.5]],
      ['bigint compared with a fractional bind', `select 1 from session_events where session_id = 's1' and timecode_total_frames = $1`, [1.5]],
      ['negative LIMIT', 'select 1 from session_events limit $1', [-1]],
      ['count is a number', "select count(*) as n from session_transport", []],
    ] as const) {
      await c.unsafe('begin');
      await c.unsafe(PRE, sys, { prepare: true });
      try {
        const r = await c.unsafe(sqlText, binds as unknown as postgres.ParameterOrJSON<never>[], { prepare: true });
        log('A4', label, 'ok', typeof r[0]?.n === 'number' ? `number ${r[0]?.n}` : r.length);
      } catch (e) {
        log('A4', label, (e as { code: string }).code);
      }
      await c.unsafe('rollback');
    }
    await c.end();
  }

  // --- A5 cross-connection serialization with the row lock first (READ COMMITTED) -------------
  {
    const a = client();
    const b = client();
    const toggle = async (c: postgres.Sql) => {
      await Promise.all([
        c.unsafe('begin isolation level read committed'),
        c.unsafe(PRE, sys, { prepare: true }),
        c.unsafe('select 1 as locked from sessions where id = $1 for update', ['s2'], { prepare: true }),
      ]);
      const tr = (await c.unsafe('select is_rolling, current_take from session_transport where session_id = $1', ['s2'], { prepare: true }))[0];
      await new Promise((r) => setImmediate(r));
      if (tr?.is_rolling) await c.unsafe('update session_transport set is_rolling = 0 where session_id = $1', ['s2'], { prepare: true });
      else await c.unsafe('update session_transport set is_rolling = 1, current_take = $2 where session_id = $1', ['s2', Number(tr?.current_take) + 1], { prepare: true });
      await c.unsafe('commit');
    };
    for (let i = 0; i < 200; i++) await Promise.all([toggle(a), toggle(b)]);
    const tr = (await admin.unsafe("select is_rolling, current_take from catalog.session_transport where session_id = 's2'"))[0];
    log('A5 400 concurrent toggles from two connections: is_rolling', tr?.is_rolling, 'current_take', tr?.current_take, '(serial: 0 and 200)');
    // The same without the lock: lost updates.
    await admin.unsafe("update catalog.session_transport set is_rolling = 0, current_take = 0 where session_id = 's2'");
    const toggleNoLock = async (c: postgres.Sql) => {
      await Promise.all([c.unsafe('begin isolation level read committed'), c.unsafe(PRE, sys, { prepare: true })]);
      const tr = (await c.unsafe('select is_rolling, current_take from session_transport where session_id = $1', ['s2'], { prepare: true }))[0];
      await new Promise((r) => setImmediate(r));
      if (tr?.is_rolling) await c.unsafe('update session_transport set is_rolling = 0 where session_id = $1', ['s2'], { prepare: true });
      else await c.unsafe('update session_transport set is_rolling = 1, current_take = $2 where session_id = $1', ['s2', Number(tr?.current_take) + 1], { prepare: true });
      await c.unsafe('commit');
    };
    for (let i = 0; i < 200; i++) await Promise.all([toggleNoLock(a), toggleNoLock(b)]);
    const tr2 = (await admin.unsafe("select is_rolling, current_take from catalog.session_transport where session_id = 's2'"))[0];
    log('A5 the same without the row lock: is_rolling', tr2?.is_rolling, 'current_take', tr2?.current_take);
    await admin.unsafe("update catalog.session_transport set is_rolling = 0, current_take = 0 where session_id = 's2'");

    // A6 a catalog SERIALIZABLE update of the sessions row against a session write's projection.
    await Promise.all([a.unsafe('begin isolation level read committed'), a.unsafe(PRE, sys, { prepare: true }), a.unsafe("select 1 from sessions where id = 's2' for update")]);
    await a.unsafe("update sessions set event_count = event_count + 1 where id = 's2'");
    await Promise.all([b.unsafe('begin isolation level serializable'), b.unsafe(PRE, sys, { prepare: true })]);
    const pending = b.unsafe("update sessions set title = 'renamed' where id = 's2'").then(
      () => 'ok',
      (e) => (e as { code: string }).code,
    );
    await new Promise((r) => setTimeout(r, 200));
    await a.unsafe('commit');
    log('A6 catalog SERIALIZABLE update waiting on a session write, after its commit:', await pending);
    await b.unsafe('rollback');
    await Promise.all([b.unsafe('begin isolation level serializable'), b.unsafe(PRE, sys, { prepare: true })]);
    log('A6 its retry:', await b.unsafe("update sessions set title = 'renamed' where id = 's2'").then(() => 'ok', (e) => e.code));
    await b.unsafe('commit');
    await a.end();
    await b.end();
  }

  // --- A0 one round trip (`select 1`), the unit every statement below pays ------------------
  {
    const c = client();
    await c.unsafe('select 1');
    const xs: number[] = [];
    for (let i = 0; i < 2000; i++) {
      const t = performance.now();
      await c.unsafe('select 1 as x', [], { prepare: true });
      xs.push((performance.now() - t) * 1000);
    }
    log(`A0 select 1 round trip us: median ${median(xs).toFixed(0)}`);
    await c.end();
  }

  // --- A7 latency: one addEvent transaction as the hub will run it, and one listEvents snapshot -
  {
    const c = client();
    const sid = 's1';
    const N = 2000;
    const RUNS = 3;
    const ctxFr = 24;
    const add: number[] = [];
    const addProj: number[] = [];
    const list: number[] = [];
    for (let run = 0; run < RUNS; run++) {
      await admin.unsafe(`delete from catalog.session_events where session_id = 's1'`);
      for (const withProjection of [false, true]) {
        let t = performance.now();
        for (let i = 0; i < N; i++) {
          // BEGIN, preamble and the row lock pipelined: one round trip (design D3).
          const [, , lock] = await Promise.all([
            c.unsafe('begin isolation level read committed'),
            c.unsafe(PRE, sys, { prepare: true }),
            c.unsafe('select 1 as locked from sessions where id = $1 for update', [sid], { prepare: true }),
          ]);
          if (lock.length !== 1) throw new Error('lock');
          await c.unsafe('select * from session_transport where session_id = $1', [sid], { prepare: true });
          const id = randomUUID();
          await c.unsafe(
            'insert into session_events (session_id, id, wall_time_utc, frame_rate, timecode_total_frames, category, message, metadata_json) values ($1, $2, $3, $4, $5, $6, $7, $8)',
            [sid, id, new Date().toISOString(), ctxFr, i * 24, 'c', `m${i}`, '{}'],
            { prepare: true },
          );
          await c.unsafe("update session_meta set value = (value::bigint + 1)::text where session_id = $1 and key = 'events_stream_revision'", [sid], { prepare: true });
          await c.unsafe("select value from session_meta where session_id = $1 and key = 'events_stream_revision'", [sid], { prepare: true });
          await c.unsafe('select * from session_events where session_id = $1 and id = $2', [sid, id], { prepare: true });
          await c.unsafe('select count(*) as n, max(timecode_total_frames) as mx from session_events where session_id = $1', [sid], { prepare: true });
          await c.unsafe('select * from session_transport where session_id = $1', [sid], { prepare: true });
          if (withProjection) {
            await c.unsafe(
              `update sessions s set event_count = e.n, max_timecode_total_frames = e.mx,
                 is_rolling = t.is_rolling, current_take = t.current_take,
                 transport_elapsed_frames = t.elapsed_frames, roll_started_at_utc = t.roll_started_at_utc
               from (select count(*) as n, max(timecode_total_frames) as mx from session_events where session_id = $1) e,
                    session_transport t
               where s.id = $1 and t.session_id = $1`,
              [sid],
              { prepare: true },
            );
          }
          await c.unsafe('commit');
        }
        (withProjection ? addProj : add).push(((performance.now() - t) * 1000) / N);
        t = performance.now();
        if (withProjection) {
          for (let i = 0; i < N; i++) {
            await Promise.all([c.unsafe('begin isolation level repeatable read read only'), c.unsafe(PRE, sys, { prepare: true })]);
            await c.unsafe('select * from session_events where session_id = $1 order by wall_time_utc asc, id asc limit $2 offset $3', [sid, 200, 0], { prepare: true });
            await c.unsafe('select count(*) as c from session_events where session_id = $1', [sid], { prepare: true });
            await c.unsafe("select count(*) as c from session_events where session_id = $1 and lower(trim(category)) <> 'internal'", [sid], { prepare: true });
            await c.unsafe("select value from session_meta where session_id = $1 and key = 'events_stream_revision'", [sid], { prepare: true });
            await c.unsafe('commit');
          }
          list.push(((performance.now() - t) * 1000) / N);
        }
      }
    }
    const proj = (await admin`select event_count, max_timecode_total_frames from catalog.sessions where id = 's1'`)[0];
    log(`A7 runs ${RUNS} N ${N} (events grow 0..${2 * N} per run)`);
    log(`A7 addEvent tx without projection us/call: ${add.map((x) => x.toFixed(0)).join(' ')} median ${median(add).toFixed(0)}`);
    log(`A7 addEvent tx with projection us/call: ${addProj.map((x) => x.toFixed(0)).join(' ')} median ${median(addProj).toFixed(0)}`);
    log(`A7 listEvents snapshot (200 rows) us/call: ${list.map((x) => x.toFixed(0)).join(' ')} median ${median(list).toFixed(0)}`);
    log('A7 projection after the last run', proj);

    // A7c what a commit costs: a one-row write transaction against a read-only one (WAL flush).
    for (const write of [false, true]) {
      const xs: number[] = [];
      for (let i = 0; i < N; i++) {
        const t = performance.now();
        await Promise.all([c.unsafe('begin isolation level read committed'), c.unsafe(PRE, sys, { prepare: true })]);
        if (write) await c.unsafe("update session_meta set value = value where session_id = $1 and key = 'events_stream_revision'", [sid], { prepare: true });
        else await c.unsafe("select value from session_meta where session_id = $1 and key = 'events_stream_revision'", [sid], { prepare: true });
        await c.unsafe('commit');
        xs.push((performance.now() - t) * 1000);
      }
      log(`A7c ${write ? 'one-row write' : 'one-row read'} transaction (3 round trips) us: median ${median(xs).toFixed(0)}`);
    }

    // --- A8 the largest real transcript: 31,621 words, replaced twice ------------------------
    const W = 31_621;
    const words = Array.from({ length: W }, (_, i) => ({
      id: randomUUID(),
      session_time: '00:00:01',
      speaker: 'Speaker 1',
      word: `word${i}`,
      start_sec: i * 0.31,
      end_sec: i * 0.31 + 0.2,
      ordinal: i,
    }));
    const begin = () =>
      Promise.all([
        c.unsafe('begin isolation level read committed'),
        c.unsafe(PRE, sys, { prepare: true }),
        c.unsafe('select 1 from sessions where id = $1 for update', [sid], { prepare: true }),
      ]);
    for (const mode of ['per-row', 'per-row', 'json batch', 'json batch']) {
      const t = performance.now();
      await begin();
      await c.unsafe('delete from session_transcript_words where session_id = $1', [sid], { prepare: true });
      const created = new Date().toISOString();
      if (mode === 'per-row') {
        for (const w of words) {
          await c.unsafe(
            'insert into session_transcript_words (session_id, id, session_time, speaker, word, start_sec, end_sec, ordinal, created_at_utc) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
            [sid, randomUUID(), w.session_time, w.speaker, w.word, w.start_sec, w.end_sec, w.ordinal, created],
            { prepare: true },
          );
        }
      } else {
        await c.unsafe(
          `insert into session_transcript_words (session_id, id, session_time, speaker, word, start_sec, end_sec, ordinal, created_at_utc)
           select $1, w.id, w.session_time, w.speaker, w.word, w.start_sec, w.end_sec, w.ordinal, $3
           from json_to_recordset($2::text::json) as w(id text, session_time text, speaker text, word text, start_sec double precision, end_sec double precision, ordinal bigint)`,
          [sid, JSON.stringify(words.map((w) => ({ ...w, id: randomUUID() }))), created],
          { prepare: true },
        );
      }
      await c.unsafe('commit');
      const ms = performance.now() - t;
      const back = await admin.unsafe('select count(*)::int as n, min(ordinal)::int as lo, max(ordinal)::int as hi from catalog.session_transcript_words where session_id = $1', [sid]);
      log(`A8 replace ${W} words (${mode}): ${ms.toFixed(0)} ms; rows`, back[0]);
    }
    const r0 = await admin.unsafe('select start_sec, end_sec from catalog.session_transcript_words where session_id = $1 and ordinal = 12345', [sid]);
    log('A8 float round trip ordinal 12345', r0[0], 'expected', { start_sec: words[12345]?.start_sec, end_sec: words[12345]?.end_sec });
    const r1 = await admin.unsafe('select count(*)::int as n from catalog.session_transcript_words where session_id = $1', ['s2']);
    log('A8 the other session is untouched, words', r1[0]?.n);
    await c.end();
  }
  await admin.end();
  await c0.end();
  lite.close();
} finally {
  await docker(['rm', '-f', pg.container]);
  rmSync(root, { recursive: true, force: true });
}
log(`node ${process.version}`);
