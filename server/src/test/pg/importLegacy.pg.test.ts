// The legacy import end to end (OpenSpec change `supabase-11a-legacy-import`): the emitted import
// and parity files are piped into psql as `postgres` inside the test Postgres, as an operator runs
// them (non-interactive `psql -X` with the file on stdin), against a database cloned from the fully migrated template.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, testPg } from '../../../../test/pg/testDb';
import { type ImportOptions, importLegacy, type Sink } from '../../../scripts/importLegacy';
import { buildLegacyDataDir, IDS, NASTY } from '../legacyFixture';

const T = '2026-10-11T00:00:00.000Z';

function memSink(): Sink & { text: () => string } {
  const parts: string[] = [];
  return { write: async (s) => void parts.push(s), text: () => parts.join('') };
}

async function emit(dir: string, opts: Partial<ImportOptions> = {}) {
  const importSql = memSink();
  const paritySql = memSink();
  await importLegacy(dir, { studio: IDS.studio, ...opts }, { importSql, paritySql });
  return { importSql: importSql.text(), paritySql: paritySql.text() };
}

/** psql as `postgres` inside the test container, reading the file from stdin. */
function psql(db: string, input: string): { code: number; out: string } {
  const r = spawnSync(
    'docker',
    ['exec', '-i', '-u', 'postgres', testPg().container, 'psql', '-X', '-q', '-d', db],
    { input, encoding: 'utf8', timeout: 60_000 },
  );
  return { code: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
}

let root: string;
const open: postgres.Sql[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'legacy-import-pg-'));
  buildLegacyDataDir(root);
});
afterEach(async () => {
  rmSync(root, { recursive: true, force: true });
  await Promise.all(open.splice(0).map((s) => s.end()));
});

async function freshDb() {
  const db = await createTestDatabase();
  // Shortest-exact float text (Postgres 12+'s default of 1; the connection may lower it).
  const sql = postgres({
    ...db.admin,
    max: 1,
    onnotice: () => {},
    connection: { extra_float_digits: 1 },
  });
  open.push(sql);
  return { name: db.name, sql };
}

async function counts(sql: postgres.Sql) {
  const [r] = await sql.unsafe(`select
    (select count(*) from catalog.studio_definitions)::int as studios,
    (select count(*) from catalog.shows)::int as shows,
    (select count(*) from catalog.sessions)::int as sessions,
    (select count(*) from catalog.session_events)::int as events,
    (select count(*) from catalog.session_transcript_words)::int as words,
    (select count(*) from catalog.app_settings)::int as settings`);
  return r;
}

describe('legacy import into Postgres', () => {
  it('applies in one transaction, round-trips every value exactly, and parity passes', async () => {
    const { name, sql } = await freshDb();
    const { importSql, paritySql } = await emit(root);
    const imp = psql(name, importSql);
    expect(imp.out).toBe('');
    expect(imp.code).toBe(0);
    const par = psql(name, paritySql);
    expect(par.out).toMatch(/legacy parity OK: 13 tables match/);
    expect(par.code).toBe(0);

    // Exact values: text with quotes, $$, backslashes, newlines, unicode; reals to the bit; bigints.
    const [studio] =
      await sql`select display_name, sort_order from catalog.studio_definitions where id = ${IDS.studio}`;
    expect(studio).toEqual({ display_name: `YMH Studios ${NASTY.quotes}`, sort_order: '1000' });
    const shows =
      await sql`select id, name, title_suffix, next_episode from catalog.shows where studio_id = ${IDS.studio} order by id`;
    expect(shows).toEqual([
      { id: IDS.showB, name: NASTY.unicode, title_suffix: 'date', next_episode: '1' },
      { id: IDS.showA, name: NASTY.dollars, title_suffix: 'episode', next_episode: '15' },
    ]);
    const [setting] =
      await sql`select value from catalog.app_settings where key = ${`studio_config:${IDS.studio}`}`;
    expect(setting.value).toBe(`{"x":${JSON.stringify(NASTY.backslashes)}}`);
    const sessions = await sql`select id, title, notes, archived, ui_hidden, frame_rate::text as fr,
        float8send(frame_rate) as frb, episode_date, event_count, max_timecode_total_frames, is_rolling,
        current_take, transport_elapsed_frames, roll_started_at_utc, revision
      from catalog.sessions where show_id in (${IDS.showA}, ${IDS.showB}) order by id`;
    const bits = (v: number) => {
      const b = Buffer.alloc(8);
      b.writeDoubleBE(v);
      return b;
    };
    expect(
      sessions.map((s) => ({
        ...s,
        frb: Buffer.from(s.frb).equals(
          bits(s.id === IDS.s1 ? 29.97 : s.id === IDS.s2 ? 23.976 : 24),
        ),
      })),
    ).toEqual([
      // Projection recomputed from the session tables (the stored 99 is discarded), revision from meta.
      {
        id: IDS.s1,
        title: NASTY.sqlInjection,
        notes: NASTY.newlines,
        archived: '0',
        ui_hidden: '0',
        fr: '29.97',
        frb: true,
        episode_date: '2026-07-23',
        event_count: '4',
        max_timecode_total_frames: '9007199254740993',
        is_rolling: '0',
        current_take: '3',
        transport_elapsed_frames: '107105',
        roll_started_at_utc: null,
        revision: '7',
      },
      {
        id: IDS.s2,
        title: NASTY.psqlVars,
        notes: NASTY.copyEnd,
        archived: '1',
        ui_hidden: '1',
        fr: '23.976',
        frb: true,
        episode_date: null,
        event_count: '1',
        max_timecode_total_frames: '7',
        is_rolling: '0',
        current_take: '0',
        transport_elapsed_frames: '0',
        roll_started_at_utc: null,
        revision: '0',
      },
      {
        id: IDS.s3,
        title: 'no file',
        notes: '',
        archived: '0',
        ui_hidden: '1',
        fr: '24',
        frb: true,
        episode_date: null,
        event_count: '0',
        max_timecode_total_frames: null,
        is_rolling: '0',
        current_take: '0',
        transport_elapsed_frames: '0',
        roll_started_at_utc: null,
        revision: '0',
      },
    ]);
    const events =
      await sql`select id, message, metadata_json, timecode_total_frames, frame_rate::text as fr, version
      from catalog.session_events where session_id = ${IDS.s1} order by id`;
    expect(events).toEqual([
      {
        id: 'e1',
        message: NASTY.quotes,
        metadata_json: '{"auto_generated":true}',
        timecode_total_frames: '120',
        fr: '29.97',
        version: '1',
      },
      {
        id: 'e2',
        message: NASTY.backslashes,
        metadata_json: JSON.stringify({ m: NASTY.dollars }),
        timecode_total_frames: '1234567',
        fr: '29.97',
        version: '1',
      },
      {
        id: 'e3',
        message: NASTY.copyEnd,
        metadata_json: '{}',
        timecode_total_frames: null,
        fr: '23.976',
        version: '1',
      },
      {
        id: 'e4',
        message: NASTY.unicode,
        metadata_json: '{"u":"\\u0000"}',
        timecode_total_frames: '9007199254740993',
        fr: '0.30000000000000004',
        version: '1',
      },
    ]);
    const words =
      await sql`select id, word, start_sec::text as s, end_sec::text as e, version from catalog.session_transcript_words where session_id = ${IDS.s1} order by id`;
    expect(words).toEqual([
      { id: 'w1', word: NASTY.quotes, s: '1.04', e: '1.36', version: '1' },
      { id: 'w2', word: NASTY.replacement, s: '2.0000000000000004', e: '1e-07', version: '1' },
      // SQLite stores an integral REAL as an integer, so the fixture's -0 is read back as 0.
      { id: 'w3', word: NASTY.dollars, s: '0', e: '5e-324', version: '1' },
    ]);
    const transport =
      await sql`select session_id, is_rolling, current_take, elapsed_frames from catalog.session_transport order by session_id`;
    expect(transport.map((r) => r.session_id)).toEqual([IDS.s1, IDS.s2, IDS.s3]);

    // Nothing of the identity plane, nor another team, came across (ADR 0021 slice 5a).
    const [none] = await sql.unsafe(`select
      (select count(*) from catalog.users)::int as users,
      (select count(*) from catalog.user_studio_memberships)::int as memberships,
      (select count(*) from catalog.user_prefs)::int as prefs,
      (select count(*) from catalog.team_invites)::int as invites,
      (select count(*) from catalog.kv)::int as kv,
      (select count(*) from catalog.studio_definitions where id = '${IDS.otherStudio}')::int as other,
      (select count(*) from catalog.app_settings where key in ('active_studio_id', 'active_show_id'))::int as globals`);
    expect(none).toEqual({
      users: 0,
      memberships: 0,
      prefs: 0,
      invites: 0,
      kv: 0,
      other: 0,
      globals: 0,
    });

    // The bootstrap owner's claim (AuthStore.authClaimOwnerlessStudios) takes the imported team.
    await sql`insert into catalog.users (id, google_sub, email, created_at_utc) values ('owner', 'g', 'o@x.y', ${T})`;
    const claimed = await sql`insert into catalog.user_studio_memberships (user_id, studio_id, role)
       select 'owner', d.id, 'owner' from catalog.studio_definitions d
       where not exists (select 1 from catalog.user_studio_memberships m where m.studio_id = d.id and m.role = 'owner')
       on conflict (user_id, studio_id) do update set role = 'owner' returning studio_id`;
    expect(claimed.map((r) => r.studio_id)).toContain(IDS.studio);

    // Parity is strict about users by default, and relaxes with --allow-signed-in-users.
    expect(psql(name, paritySql).out).toMatch(/users: 1 row\(s\), expected none/);
    const relaxed = await emit(root, { allowSignedInUsers: true });
    expect(psql(name, relaxed.paritySql)).toMatchObject({ code: 0 });
  });

  it('refuses a second import of the same team and changes nothing', async () => {
    const { name, sql } = await freshDb();
    const { importSql } = await emit(root);
    expect(psql(name, importSql).code).toBe(0);
    const before = await counts(sql);
    const again = psql(name, importSql);
    expect(again.code).not.toBe(0);
    expect(again.out).toMatch(/legacy import refused: team ymhs already exists \(use --replace\)/);
    expect(await counts(sql)).toEqual(before);
  });

  it('refuses a colliding show or session id even when the team is new', async () => {
    const { name, sql } = await freshDb();
    await sql`insert into catalog.sessions (id, show_id) values (${IDS.s2}, 'show-autolog-test')`;
    const r = psql(name, (await emit(root)).importSql);
    expect(r.out).toMatch(/1 session id\(s\) already exist/);
    expect(
      (
        await sql`select count(*)::int as n from catalog.studio_definitions where id = ${IDS.studio}`
      )[0].n,
    ).toBe(0);
  });

  it('refuses a target whose newest migration is not the one the import was generated for', async () => {
    const { name, sql } = await freshDb();
    await sql`insert into supabase_migrations.schema_migrations (version, name) values ('29990101000000', 'future')`;
    const r = psql(name, (await emit(root)).importSql);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/newest migration is 29990101000000/);
  });

  it('parity detects a changed value, a one-ulp real, a missing row and an extra row', async () => {
    const { name, sql } = await freshDb();
    const { importSql, paritySql } = await emit(root);
    expect(psql(name, importSql).code).toBe(0);
    const tamper = async (stmt: string, undo: string, msg: RegExp) => {
      await sql.unsafe(stmt);
      const r = psql(name, paritySql);
      expect(r.code, stmt).not.toBe(0);
      expect(r.out, stmt).toMatch(msg);
      await sql.unsafe(undo);
      expect(psql(name, paritySql).code, undo).toBe(0);
    };
    await tamper(
      "update catalog.session_transcript_words set word = word || ' ' where id = 'w1'",
      "update catalog.session_transcript_words set word = rtrim(word, ' ') where id = 'w1'",
      /session_transcript_words: 3 row\(s\), content differs/,
    );
    await tamper(
      `update catalog.sessions set frame_rate = 29.970000000000002 where id = '${IDS.s1}'`,
      `update catalog.sessions set frame_rate = 29.97 where id = '${IDS.s1}'`,
      /sessions: 3 row\(s\), content differs/,
    );
    await tamper(
      "update catalog.session_events set version = 2 where id = 'e1'",
      "update catalog.session_events set version = 1 where id = 'e1'",
      /session_events: 5 row\(s\), content differs/,
    );
    await tamper(
      `insert into catalog.session_meta (session_id, key, value) values ('${IDS.s3}', 'k', 'v')`,
      `delete from catalog.session_meta where session_id = '${IDS.s3}' and key = 'k'`,
      /session_meta: expected 4 row\(s\), found 5/,
    );
    // revision against events_stream_revision, checked in SQL independently of the importer.
    await tamper(
      `update catalog.sessions set revision = 8 where id = '${IDS.s1}'`,
      `update catalog.sessions set revision = 7 where id = '${IDS.s1}'`,
      /1 session\(s\) whose revision differs from events_stream_revision/,
    );
    await tamper(
      `update catalog.session_meta set value = '8' where session_id = '${IDS.s1}' and key = 'events_stream_revision'`,
      `update catalog.session_meta set value = '7' where session_id = '${IDS.s1}' and key = 'events_stream_revision'`,
      /1 session\(s\) whose revision differs from events_stream_revision/,
    );
    await tamper(
      `update catalog.sessions set revision = 1 where id = '${IDS.s2}'`,
      `update catalog.sessions set revision = 0 where id = '${IDS.s2}'`,
      /1 session\(s\) whose revision differs from events_stream_revision/,
    );
    await tamper(
      `update catalog.sessions set event_count = 5 where id = '${IDS.s1}'`,
      `update catalog.sessions set event_count = 4 where id = '${IDS.s1}'`,
      /stale live projection/,
    );
  });

  it('--replace re-imports a team nobody used yet, in one transaction', async () => {
    const { name, sql } = await freshDb();
    expect(psql(name, (await emit(root)).importSql).code).toBe(0);
    const db = new Database(join(root, 'sessions', `${IDS.s1}.db`));
    db.exec("DELETE FROM events WHERE id = 'e4'");
    db.close();
    const replaced = await emit(root, { replace: true });
    const r = psql(name, replaced.importSql);
    expect(r.code, r.out).toBe(0);
    expect(psql(name, replaced.paritySql)).toMatchObject({ code: 0 });
    expect(
      (await sql`select event_count::int as n from catalog.sessions where id = ${IDS.s1}`)[0].n,
    ).toBe(3);
  });

  it('--replace refuses, changing nothing, when the team has live data (--replace-live overrides)', async () => {
    const { name, sql } = await freshDb();
    expect(psql(name, (await emit(root)).importSql).code).toBe(0);
    await sql`insert into catalog.users (id, google_sub, email, created_at_utc) values ('owner', 'g', 'o@x.y', ${T})`;
    const replace = (await emit(root, { replace: true })).importSql;
    const snapshot = async () =>
      (
        await sql.unsafe(`select
          (select count(*) from catalog.sessions)::int as sessions,
          (select count(*) from catalog.shows)::int as shows,
          (select count(*) from catalog.session_audio_segments)::int as segments,
          (select count(*) from catalog.user_studio_memberships)::int as memberships,
          (select count(*) from catalog.team_invites)::int as invites,
          (select count(*) from catalog.show_grants)::int as grants,
          (select count(*) from catalog.session_leases)::int as leases,
          (select count(*) from catalog.session_overwrites)::int as overwrites`)
      )[0];
    const cases: Array<[string, string, RegExp]> = [
      [
        `insert into catalog.sessions (id, show_id) values ('new-in-app', '${IDS.showA}')`,
        "delete from catalog.sessions where id = 'new-in-app'",
        /1 session\(s\) not in the source/,
      ],
      [
        `insert into catalog.shows (id, studio_id, name, show_code, created_at_utc) values ('show-in-app', '${IDS.studio}', 'n', 'N', '${T}')`,
        "delete from catalog.shows where id = 'show-in-app'",
        /1 show\(s\) not in the source/,
      ],
      [
        `insert into catalog.session_audio_segments (session_id, id, ordinal, mime_type, r2_key, created_at_utc)
           values ('${IDS.s1}', 'a9', 9, 'audio/webm', 'audio/${IDS.s1}/0009_a9.webm', '${T}')`,
        "delete from catalog.session_audio_segments where id = 'a9'",
        /1 audio segment\(s\) not in the source/,
      ],
      [
        `insert into catalog.user_studio_memberships values ('owner', '${IDS.studio}', 'owner')`,
        'delete from catalog.user_studio_memberships',
        /1 membership\(s\)/,
      ],
      [
        `insert into catalog.team_invites (studio_id, email_norm, invited_by_user_id, invited_at_utc) values ('${IDS.studio}', 'x@y.z', 'owner', '${T}')`,
        'delete from catalog.team_invites',
        /1 invite\(s\)/,
      ],
      [
        `insert into catalog.show_grants (user_id, show_id, granted_at_utc) values ('owner', '${IDS.showA}', '${T}')`,
        'delete from catalog.show_grants',
        /1 show grant\(s\)/,
      ],
      [
        `insert into catalog.session_leases (session_id, kind, holder_client_id, holder_user_id, heartbeat_at_ms, expires_at_ms)
           values ('${IDS.s1}', 'recording', 'c1', 'owner', 1, 2)`,
        'delete from catalog.session_leases',
        /1 session lease\(s\)/,
      ],
      [
        `insert into catalog.session_overwrites (session_id, id, table_name, row_id, user_id, at_utc, replaced_version, before_json)
           values ('${IDS.s1}', 'o1', 'session_events', 'e1', 'owner', '${T}', 1, '{}')`,
        'delete from catalog.session_overwrites',
        /1 overwrite record\(s\)/,
      ],
    ];
    for (const [setup, undo, msg] of cases) {
      await sql.unsafe(setup);
      const before = await snapshot();
      const r = psql(name, replace);
      expect(r.code, setup).not.toBe(0);
      expect(r.out, setup).toMatch(
        /legacy import refused: --replace would delete live data of team ymhs: /,
      );
      expect(r.out, setup).toMatch(msg);
      expect(r.out, setup).toMatch(/\(use --replace-live\)/);
      expect(await snapshot(), setup).toEqual(before);
      await sql.unsafe(undo);
    }
    expect(psql(name, replace).code).toBe(0);
  });

  it("--replace-live swaps the team in one transaction, keeps other teams, and never touches another team's ids", async () => {
    const { name, sql } = await freshDb();
    expect(psql(name, (await emit(root)).importSql).code).toBe(0);
    // The app ran in between: an owner claimed the team, a session was created, leases, grants,
    // an overwrite record and presence exist.
    await sql.unsafe(`
      insert into catalog.users (id, google_sub, email, created_at_utc) values ('owner', 'g', 'o@x.y', '${T}');
      insert into catalog.user_studio_memberships values ('owner', '${IDS.studio}', 'owner');
      insert into catalog.show_grants (user_id, show_id, granted_at_utc) values ('owner', '${IDS.showA}', '${T}');
      insert into catalog.sessions (id, show_id) values ('new-in-app', '${IDS.showA}');
      insert into catalog.session_transport (session_id) values ('new-in-app');
      insert into catalog.session_leases (session_id, kind, holder_client_id, holder_user_id, heartbeat_at_ms, expires_at_ms)
        values ('${IDS.s1}', 'recording', 'c1', 'owner', 1, 2);
      insert into catalog.session_overwrites (session_id, id, table_name, row_id, user_id, at_utc, replaced_version, before_json)
        values ('${IDS.s1}', 'o1', 'session_events', 'e1', 'owner', '${T}', 1, '{}');
      insert into catalog.companion_presence (client_id, user_id, session_id, visible, is_playing, updated_at_ms)
        values ('tab', 'owner', '${IDS.s1}', true, false, 1);`);
    // The source changed too: an event was deleted.
    const db = new Database(join(root, 'sessions', `${IDS.s1}.db`));
    db.exec("DELETE FROM events WHERE id = 'e4'");
    db.close();
    const plain = await emit(root);
    expect(psql(name, plain.importSql).out).toMatch(/already exists/);
    expect(psql(name, (await emit(root, { replace: true })).importSql).out).toMatch(
      /would delete live data of team ymhs: 1 session\(s\) not in the source; 1 membership\(s\); 1 show grant\(s\); 1 session lease\(s\); 1 overwrite record\(s\)/,
    );
    const replaced = await emit(root, { replaceLive: true, allowSignedInUsers: true });
    const r = psql(name, replaced.importSql);
    expect(r.code, r.out).toBe(0);
    expect(psql(name, replaced.paritySql)).toMatchObject({ code: 0 });
    const [after] = await sql.unsafe(`select
      (select count(*) from catalog.sessions where id = 'new-in-app')::int as app_session,
      (select count(*) from catalog.user_studio_memberships where studio_id = '${IDS.studio}')::int as memberships,
      (select count(*) from catalog.show_grants)::int as grants,
      (select count(*) from catalog.session_leases)::int as leases,
      (select count(*) from catalog.session_overwrites)::int as overwrites,
      (select session_id from catalog.companion_presence where client_id = 'tab') as presence,
      (select event_count from catalog.sessions where id = '${IDS.s1}')::int as events,
      (select count(*) from catalog.users)::int as users,
      (select count(*) from catalog.shows where id = 'show-autolog-test')::int as seed_show`);
    expect(after).toEqual({
      app_session: 0,
      memberships: 0,
      grants: 0,
      leases: 0,
      overwrites: 0,
      presence: null,
      events: 3,
      users: 1,
      seed_show: 1,
    });
  });

  it('--replace refuses an imported session id that belongs to another team', async () => {
    const { name, sql } = await freshDb();
    await sql`insert into catalog.sessions (id, show_id) values (${IDS.s1}, 'show-autolog-test')`;
    const r = psql(name, (await emit(root, { replace: true })).importSql);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/1 session id\(s\) belong to another team/);
    expect((await sql`select show_id from catalog.sessions where id = ${IDS.s1}`)[0].show_id).toBe(
      'show-autolog-test',
    );
  });
});
