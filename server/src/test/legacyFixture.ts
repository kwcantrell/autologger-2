// A legacy (pre-Supabase) DATA_DIR for the legacy import tests (OpenSpec change
// `supabase-11a-legacy-import`). The DDL is copied verbatim from the real files (`sqlite3 .schema`
// of server/data/catalog.db, built by packages/catalog migrations 0001-0006, and of a
// sessions/<id>.db), so the fixture has the real column order, types and defaults.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

export const LEGACY_CATALOG_DDL = `
CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at_utc TEXT NOT NULL);
CREATE TABLE users (
    id TEXT PRIMARY KEY,
    supabase_user_id TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL,
    given_name TEXT NOT NULL DEFAULT '',
    family_name TEXT NOT NULL DEFAULT '',
    picture_url TEXT NOT NULL DEFAULT '',
    created_at_utc TEXT NOT NULL,
    disabled_at_utc TEXT
, email_norm TEXT);
CREATE INDEX idx_users_email ON users(email);
CREATE TABLE user_studio_memberships (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    studio_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member',
    PRIMARY KEY (user_id, studio_id)
);
CREATE TABLE user_prefs (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    active_studio_id TEXT NOT NULL DEFAULT '',
    active_show_id TEXT NOT NULL DEFAULT ''
);
CREATE TABLE studio_definitions (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at_utc TEXT NOT NULL
);
CREATE TABLE shows (
    id TEXT PRIMARY KEY,
    studio_id TEXT NOT NULL,
    name TEXT NOT NULL,
    show_code TEXT NOT NULL,
    next_episode INTEGER NOT NULL DEFAULT 1,
    categories_json TEXT NOT NULL DEFAULT '[]',
    event_palette_json TEXT NOT NULL DEFAULT '[]',
    event_palette_preset TEXT NOT NULL DEFAULT 'custom',
    event_palette_custom_json TEXT NOT NULL DEFAULT '[]',
    created_at_utc TEXT NOT NULL
, title_suffix TEXT NOT NULL DEFAULT 'date');
CREATE TABLE app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    show_id TEXT REFERENCES shows(id),
    title TEXT NOT NULL DEFAULT '',
    archived INTEGER NOT NULL DEFAULT 0
, frame_rate REAL NOT NULL DEFAULT 24.0, start_offset_frames INTEGER NOT NULL DEFAULT 0, episode TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', started_at_utc TEXT NOT NULL DEFAULT '', created_at_utc TEXT NOT NULL DEFAULT '', episode_date TEXT, ui_hidden INTEGER NOT NULL DEFAULT 0, event_count INTEGER NOT NULL DEFAULT 0, max_timecode_total_frames INTEGER, is_rolling INTEGER NOT NULL DEFAULT 0, current_take INTEGER NOT NULL DEFAULT 0, transport_elapsed_frames INTEGER NOT NULL DEFAULT 0, roll_started_at_utc TEXT);
CREATE INDEX idx_sessions_show ON sessions(show_id);
CREATE TABLE kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER
);
CREATE TABLE team_invites (
    studio_id TEXT NOT NULL,
    email_norm TEXT NOT NULL,
    invited_by_user_id TEXT NOT NULL,
    invited_at_utc TEXT NOT NULL,
    PRIMARY KEY (studio_id, email_norm)
);
CREATE INDEX idx_users_email_norm ON users(email_norm);
`;

/** A session file without the three AI tables, as two real files are (older sessions). */
export const LEGACY_SESSION_DDL_BASE = `
CREATE TABLE events (
        id TEXT PRIMARY KEY,
        wall_time_utc TEXT NOT NULL,
        frame_rate REAL NOT NULL,
        timecode_total_frames INTEGER,
        category TEXT NOT NULL,
        message TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
CREATE INDEX idx_events_wall ON events(wall_time_utc, id);
CREATE TABLE session_transport (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        is_rolling INTEGER NOT NULL DEFAULT 0,
        current_take INTEGER NOT NULL DEFAULT 0,
        roll_started_at_utc TEXT,
        elapsed_frames INTEGER NOT NULL DEFAULT 0
      );
CREATE TABLE session_audio_segments (
        id TEXT PRIMARY KEY,
        ordinal INTEGER NOT NULL,
        started_at_utc TEXT,
        ended_at_utc TEXT,
        mime_type TEXT NOT NULL,
        r2_key TEXT NOT NULL,
        recording_ordinal INTEGER,
        waveform_peaks_json TEXT,
        waveform_db_floor REAL,
        created_at_utc TEXT NOT NULL
      );
CREATE INDEX idx_audio_ordinal ON session_audio_segments(ordinal);
CREATE TABLE session_transcript_words (
        id TEXT PRIMARY KEY,
        session_time TEXT NOT NULL DEFAULT '',
        speaker TEXT NOT NULL DEFAULT '',
        word TEXT NOT NULL DEFAULT '',
        start_sec REAL NOT NULL DEFAULT 0.0,
        end_sec REAL NOT NULL DEFAULT 0.0,
        ordinal INTEGER NOT NULL,
        created_at_utc TEXT NOT NULL
      );
CREATE INDEX idx_words_ordinal ON session_transcript_words(ordinal);
CREATE TABLE session_topics (
        id TEXT PRIMARY KEY,
        session_time TEXT NOT NULL DEFAULT '',
        duration_sec REAL NOT NULL DEFAULT 0,
        topic_level INTEGER NOT NULL DEFAULT 1,
        summary TEXT NOT NULL DEFAULT '',
        ordinal INTEGER NOT NULL,
        created_at_utc TEXT NOT NULL
      );
CREATE INDEX idx_topics_ordinal ON session_topics(ordinal);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export const LEGACY_SESSION_DDL_AI = `
CREATE TABLE session_transcript_paragraphs (
        id TEXT PRIMARY KEY,
        start_sec REAL,
        end_sec REAL,
        speaker TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL DEFAULT '',
        ordinal INTEGER NOT NULL,
        created_at_utc TEXT NOT NULL
      );
CREATE INDEX idx_paragraphs_ordinal ON session_transcript_paragraphs(ordinal);
CREATE TABLE session_transcript_sentiment (
        id TEXT PRIMARY KEY,
        start_sec REAL,
        end_sec REAL,
        sentiment TEXT NOT NULL DEFAULT '',
        sentiment_score REAL NOT NULL DEFAULT 0,
        text TEXT NOT NULL DEFAULT '',
        ordinal INTEGER NOT NULL,
        created_at_utc TEXT NOT NULL
      );
CREATE INDEX idx_sentiment_ordinal ON session_transcript_sentiment(ordinal);
CREATE TABLE session_dashboards (
        id TEXT PRIMARY KEY,
        config_json TEXT NOT NULL,
        created_by TEXT,
        created_by_turn_id TEXT,
        created_at_utc TEXT NOT NULL,
        updated_at_utc TEXT NOT NULL
      );
CREATE INDEX idx_dashboards_created ON session_dashboards(created_at_utc);
`;

export const MIGRATIONS = [
  '0001_init.sql',
  '0002_sessions_live_split.sql',
  '0003_kv.sql',
  '0004_team_roles_and_invites.sql',
  '0005_show_title_suffix.sql',
  '0006_supabase_identity.sql',
];

/** Values that a naive encoder gets wrong. */
export const NASTY = {
  quotes: `it's a "quote" '' \`tick\``,
  dollars: 'a $$ b $tag$ c $_$ $1',
  backslashes: 'C:\\path\\to\\n not a newline \\N not null \\. end \\',
  newlines: 'line1\nline2\r\nline3\ttabbed',
  copyEnd: '\\.',
  unicode: 'café ☕ 日本語 🎙️ \u200b zero-width, Ω',
  psqlVars: ':foo :"bar" :\'baz\' \\set x',
  sqlInjection: "'); DROP TABLE catalog.users; --",
  replacement: 'a real U+FFFD: \uFFFD',
};

export const IDS = {
  studio: 'ymhs',
  otherStudio: 'other-team',
  showA: 'd0dec848-be21-438f-b6d2-2750ef6604db',
  showB: '7ec5b7aa-7d73-4cb2-95d5-e19ff1288c23',
  otherShow: 'other-show',
  s1: '11111111-1111-4111-8111-111111111111',
  s2: '22222222-2222-4222-8222-222222222222',
  s3: '33333333-3333-4333-8333-333333333333',
  otherSession: '99999999-9999-4999-8999-999999999999',
};

const T0 = '2026-07-23T16:56:12.640Z';

export interface FixtureOptions {
  migrations?: string[];
}

/** Builds a legacy DATA_DIR under `root`:
 * - team `ymhs` with two shows (one `title_suffix = 'episode'` over the 'date' default), its
 *   `studio_config:ymhs`, the global keys that must not be imported, users, a membership, prefs, an
 *   invite and KV rows that must not be imported;
 * - session s1: every table, nasty values, frame rates 29.97/23.976, a stale stored projection, a
 *   transport row, `events_stream_revision` 7;
 * - session s2 (archived, hidden): an old file without the three AI tables, no transport row;
 * - session s3: no .db file at all;
 * - another team with its own show and session (never imported);
 * - blobs for s1's first segment only (the second is missing). */
export function buildLegacyDataDir(root: string, opts: FixtureOptions = {}): void {
  mkdirSync(join(root, 'sessions'), { recursive: true });
  const cat = fixtureDb(join(root, 'catalog.db'));
  cat.transaction(() => fillCatalog(cat, opts))();
  cat.close();

  const s1 = fixtureDb(join(root, 'sessions', `${IDS.s1}.db`));
  s1.transaction(() => fillS1(s1))();
  s1.close();

  // s2: an old file (no AI tables), no transport row, a non-numeric revision.
  const s2 = fixtureDb(join(root, 'sessions', `${IDS.s2}.db`));
  s2.transaction(() => {
    s2.exec(LEGACY_SESSION_DDL_BASE);
    s2.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      'e1',
      T0,
      23.976,
      7,
      'Mark',
      'm',
      '{}',
    );
    s2.prepare('INSERT INTO meta VALUES (?, ?)').run('events_stream_revision', 'x1');
  })();
  s2.close();

  // The other team's session file (never read).
  const so = fixtureDb(join(root, 'sessions', `${IDS.otherSession}.db`));
  so.exec(LEGACY_SESSION_DDL_BASE + LEGACY_SESSION_DDL_AI);
  so.close();

  mkdirSync(join(root, 'blobs', 'audio', IDS.s1), { recursive: true });
  writeFileSync(join(root, 'blobs', 'audio', IDS.s1, '0001_a1.webm'), 'webm-bytes');
}

/** A throwaway file: no on-disk journal and no fsync (each autocommit insert with SQLite's
 * defaults costs an fsync, ~1.5 s per fixture on ext4), filled in one transaction by the caller. */
function fixtureDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = MEMORY');
  db.pragma('synchronous = OFF');
  return db;
}

function fillCatalog(cat: Database.Database, opts: FixtureOptions): void {
  cat.exec(LEGACY_CATALOG_DDL);
  const mig = cat.prepare('INSERT INTO _migrations (name, applied_at_utc) VALUES (?, ?)');
  for (const m of opts.migrations ?? MIGRATIONS) mig.run(m, T0);
  const sd = cat.prepare('INSERT INTO studio_definitions VALUES (?, ?, ?, ?)');
  sd.run(IDS.studio, `YMH Studios ${NASTY.quotes}`, 1000, T0);
  sd.run(IDS.otherStudio, 'Other', 1000, T0);
  const show = cat.prepare(
    `INSERT INTO shows (id, studio_id, name, show_code, next_episode, categories_json, event_palette_json,
       event_palette_preset, event_palette_custom_json, created_at_utc, title_suffix)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  show.run(
    IDS.showA,
    IDS.studio,
    NASTY.dollars,
    'VAH',
    15,
    '[{"name":"Scene"}]',
    '["#fff"]',
    'default',
    '[]',
    T0,
    'episode',
  );
  show.run(IDS.showB, IDS.studio, NASTY.unicode, 'MB', 1, '[]', '[]', 'custom', '[]', T0, 'date');
  show.run(
    IDS.otherShow,
    IDS.otherStudio,
    'Other show',
    'OS',
    1,
    '[]',
    '[]',
    'custom',
    '[]',
    T0,
    'date',
  );
  const setting = cat.prepare('INSERT INTO app_settings VALUES (?, ?)');
  setting.run(`studio_config:${IDS.studio}`, `{"x":${JSON.stringify(NASTY.backslashes)}}`);
  setting.run(`studio_config:${IDS.otherStudio}`, '{}');
  setting.run('active_studio_id', IDS.studio);
  setting.run('active_show_id', IDS.showA);
  cat
    .prepare("INSERT INTO users VALUES ('u1', 'sb1', 'a@b.c', '', '', '', ?, NULL, 'a@b.c')")
    .run(T0);
  cat.prepare("INSERT INTO user_studio_memberships VALUES ('u1', ?, 'admin')").run(IDS.studio);
  cat.prepare("INSERT INTO user_prefs VALUES ('u1', ?, ?)").run(IDS.studio, IDS.showA);
  cat.prepare("INSERT INTO team_invites VALUES (?, 'x@y.z', 'u1', ?)").run(IDS.studio, T0);
  cat.prepare("INSERT INTO kv VALUES ('session:abc', 'u1', NULL), ('other', 'v', 5)").run();
  const sess = cat.prepare(
    `INSERT INTO sessions (id, show_id, title, archived, frame_rate, start_offset_frames, episode, notes,
       started_at_utc, created_at_utc, episode_date, ui_hidden, event_count, max_timecode_total_frames,
       is_rolling, current_take, transport_elapsed_frames, roll_started_at_utc)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // s1: a stale stored projection (event_count 99), recomputed by the import.
  sess.run(
    IDS.s1,
    IDS.showA,
    NASTY.sqlInjection,
    0,
    29.97,
    108000,
    '871',
    NASTY.newlines,
    T0,
    T0,
    '2026-07-23',
    0,
    99,
    5,
    0,
    0,
    0,
    null,
  );
  sess.run(
    IDS.s2,
    IDS.showA,
    NASTY.psqlVars,
    1,
    23.976,
    0,
    '',
    NASTY.copyEnd,
    '',
    '',
    null,
    1,
    0,
    null,
    0,
    0,
    0,
    null,
  );
  sess.run(IDS.s3, IDS.showB, 'no file', 0, 24, 0, '', '', T0, T0, null, 1, 0, null, 0, 0, 0, null);
  sess.run(
    IDS.otherSession,
    IDS.otherShow,
    'other',
    0,
    24,
    0,
    '',
    '',
    T0,
    T0,
    null,
    0,
    0,
    null,
    0,
    0,
    0,
    null,
  );
}

/** s1: every table. */
function fillS1(s1: Database.Database): void {
  s1.exec(LEGACY_SESSION_DDL_BASE + LEGACY_SESSION_DDL_AI);
  const ev = s1.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?)');
  ev.run('e1', T0, 29.97, 120, 'Scene', NASTY.quotes, '{"auto_generated":true}');
  ev.run(
    'e2',
    T0,
    29.97,
    1234567,
    'internal',
    NASTY.backslashes,
    JSON.stringify({ m: NASTY.dollars }),
  );
  ev.run('e3', T0, 23.976, null, ' Internal', NASTY.copyEnd, '{}');
  ev.run('e4', T0, 0.1 + 0.2, 9007199254740993n, 'Note', NASTY.unicode, '{"u":"\\u0000"}');
  s1.prepare('INSERT INTO session_transport VALUES (1, 0, 3, NULL, 107105)').run();
  const seg = s1.prepare(
    'INSERT INTO session_audio_segments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  seg.run(
    'a1',
    1,
    T0,
    T0,
    'audio/webm',
    `audio/${IDS.s1}/0001_a1.webm`,
    1,
    '[0.1,0.25]',
    -60.5,
    T0,
  );
  seg.run('a2', 2, null, null, 'audio/mp4', `audio/${IDS.s1}/0002_a2.m4a`, null, null, null, T0);
  const w = s1.prepare('INSERT INTO session_transcript_words VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  w.run('w1', '00:00:01', 'Speaker 0', NASTY.quotes, 1.04, 1.36, 0, T0);
  w.run('w2', '00:00:02', 'Speaker 1', NASTY.replacement, 2.0000000000000004, 1e-7, 1, T0);
  w.run('w3', '', '', NASTY.dollars, -0, 5e-324, 2, T0);
  s1.prepare('INSERT INTO session_topics VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    't1',
    '00:01:00',
    61.5,
    2,
    NASTY.newlines,
    0,
    T0,
  );
  s1.prepare('INSERT INTO session_transcript_paragraphs VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'p1',
    null,
    3.25,
    'S0',
    NASTY.unicode,
    0,
    T0,
  );
  s1.prepare('INSERT INTO session_transcript_sentiment VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    'n1',
    0.5,
    null,
    'positive',
    0.987654321,
    NASTY.psqlVars,
    0,
    T0,
  );
  s1.prepare('INSERT INTO session_dashboards VALUES (?, ?, ?, ?, ?, ?)').run(
    'd1',
    NASTY.sqlInjection,
    null,
    'turn-1',
    T0,
    T0,
  );
  const meta = s1.prepare('INSERT INTO meta VALUES (?, ?)');
  meta.run('events_stream_revision', '7');
  meta.run('relink_checked_rev', '7');
  meta.run('audio_seam_parts_json', '[]');
}
