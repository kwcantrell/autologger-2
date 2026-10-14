// The legacy import's pure half (OpenSpec change `supabase-11a-legacy-import`, ADR 0021 slice 11):
// the table map from the pre-Supabase SQLite files to schema `catalog`, the COPY text encoding of
// every value, the canonical row hash shared by the TypeScript (expected) and SQL (actual) sides of
// the parity check, and the SQL text of both emitted files. No I/O here; importLegacy.ts reads the
// source and writes the files.
//
// Safety rule (design D3): no source value is ever written into SQL text. Every value travels as a
// COPY ... FROM STDIN data line in text format, whose escaping (`copyText`) maps backslash,
// newline, carriage return and tab to escapes, so a value cannot end its line, its field or the
// data block (`\.`), and psql never interpolates inside COPY data. The SQL statements themselves
// are fixed text built from the identifiers in this file.

import { createHash } from 'node:crypto';

/** The legacy catalog's `_migrations` set the import accepts (design D1; ADR 0021 slice 4e names
 * 0001-0005, and 0006 changes only `users`, which is never imported). */
export const EXPECTED_LEGACY_MIGRATIONS = [
  '0001_init.sql',
  '0002_sessions_live_split.sql',
  '0003_kv.sql',
  '0004_team_roles_and_invites.sql',
  '0005_show_title_suffix.sql',
  '0006_supabase_identity.sql',
] as const;

/** The newest `supabase/migrations` version this map was written against (design D6). The emitted
 * import refuses a target whose newest applied migration differs; a unit test pins it to the
 * newest file in the checkout, so a new migration makes this file be reviewed. */
export const TARGET_SCHEMA_VERSION = '20261022000000';

export type ColType = 'text' | 'int' | 'real';
export type Value = string | bigint | number | null;

export interface Col {
  name: string;
  type: ColType;
  nullable: boolean;
  /** Not read from the source: the importer computes it (design D4). */
  derived?: true;
}

export interface TableSpec {
  /** Target table in schema `catalog`. */
  target: string;
  /** Source table in the legacy file. */
  source: string;
  /** Target columns in COPY order. Session tables start with `session_id`, which is derived. */
  cols: Col[];
  /** Source columns that are read but not copied (session_transport's `id = 1`). */
  sourceOnly?: string[];
}

const t = (name: string, nullable = false): Col => ({ name, type: 'text', nullable });
const i = (name: string, nullable = false): Col => ({ name, type: 'int', nullable });
const r = (name: string, nullable = false): Col => ({ name, type: 'real', nullable });
const derived = (c: Col): Col => ({ ...c, derived: true });
const sid = derived(t('session_id'));

export const STUDIO_DEFINITIONS: TableSpec = {
  target: 'studio_definitions',
  source: 'studio_definitions',
  cols: [t('id'), t('display_name'), i('sort_order'), t('created_at_utc')],
};

export const SHOWS: TableSpec = {
  target: 'shows',
  source: 'shows',
  cols: [
    t('id'),
    t('studio_id'),
    t('name'),
    t('show_code'),
    i('next_episode'),
    t('categories_json'),
    t('event_palette_json'),
    t('event_palette_preset'),
    t('event_palette_custom_json'),
    t('created_at_utc'),
    t('title_suffix'),
  ],
};

export const APP_SETTINGS: TableSpec = {
  target: 'app_settings',
  source: 'app_settings',
  cols: [t('key'), t('value')],
};

/** The six live-projection columns and `revision` are derived (design D4); the stored legacy
 * values are read and only reported. */
export const SESSIONS: TableSpec = {
  target: 'sessions',
  source: 'sessions',
  cols: [
    t('id'),
    t('show_id', true),
    t('title'),
    i('archived'),
    r('frame_rate'),
    i('start_offset_frames'),
    t('episode'),
    t('notes'),
    t('started_at_utc'),
    t('created_at_utc'),
    t('episode_date', true),
    i('ui_hidden'),
    derived(i('event_count')),
    derived(i('max_timecode_total_frames', true)),
    derived(i('is_rolling')),
    derived(i('current_take')),
    derived(i('transport_elapsed_frames')),
    derived(t('roll_started_at_utc', true)),
    derived(i('revision')),
  ],
  sourceOnly: [
    'event_count',
    'max_timecode_total_frames',
    'is_rolling',
    'current_take',
    'transport_elapsed_frames',
    'roll_started_at_utc',
  ],
};

export const SESSION_TABLES: TableSpec[] = [
  {
    target: 'session_events',
    source: 'events',
    cols: [
      sid,
      t('id'),
      t('wall_time_utc'),
      r('frame_rate'),
      i('timecode_total_frames', true),
      t('category'),
      t('message'),
      t('metadata_json'),
      derived(i('version')),
    ],
  },
  {
    target: 'session_transport',
    source: 'session_transport',
    cols: [
      sid,
      i('is_rolling'),
      i('current_take'),
      t('roll_started_at_utc', true),
      i('elapsed_frames'),
    ],
    sourceOnly: ['id'],
  },
  {
    target: 'session_audio_segments',
    source: 'session_audio_segments',
    cols: [
      sid,
      t('id'),
      i('ordinal'),
      t('started_at_utc', true),
      t('ended_at_utc', true),
      t('mime_type'),
      t('r2_key'),
      i('recording_ordinal', true),
      t('waveform_peaks_json', true),
      r('waveform_db_floor', true),
      t('created_at_utc'),
    ],
  },
  {
    target: 'session_transcript_words',
    source: 'session_transcript_words',
    cols: [
      sid,
      t('id'),
      t('session_time'),
      t('speaker'),
      t('word'),
      r('start_sec'),
      r('end_sec'),
      i('ordinal'),
      t('created_at_utc'),
      derived(i('version')),
    ],
  },
  {
    target: 'session_topics',
    source: 'session_topics',
    cols: [
      sid,
      t('id'),
      t('session_time'),
      r('duration_sec'),
      i('topic_level'),
      t('summary'),
      i('ordinal'),
      t('created_at_utc'),
      derived(i('version')),
    ],
  },
  {
    target: 'session_transcript_paragraphs',
    source: 'session_transcript_paragraphs',
    cols: [
      sid,
      t('id'),
      r('start_sec', true),
      r('end_sec', true),
      t('speaker'),
      t('text'),
      i('ordinal'),
      t('created_at_utc'),
    ],
  },
  {
    target: 'session_transcript_sentiment',
    source: 'session_transcript_sentiment',
    cols: [
      sid,
      t('id'),
      r('start_sec', true),
      r('end_sec', true),
      t('sentiment'),
      r('sentiment_score'),
      t('text'),
      i('ordinal'),
      t('created_at_utc'),
    ],
  },
  {
    target: 'session_dashboards',
    source: 'session_dashboards',
    cols: [
      sid,
      t('id'),
      t('config_json'),
      t('created_by', true),
      t('created_by_turn_id', true),
      t('created_at_utc'),
      t('updated_at_utc'),
    ],
  },
  { target: 'session_meta', source: 'meta', cols: [sid, t('key'), t('value')] },
];

export const CATALOG_TABLES: TableSpec[] = [STUDIO_DEFINITIONS, SHOWS, APP_SETTINGS, SESSIONS];
export const ALL_TABLES: TableSpec[] = [...CATALOG_TABLES, ...SESSION_TABLES];

/** Source columns of a spec: the non-derived target columns plus `sourceOnly`. */
export function sourceColumns(spec: TableSpec): string[] {
  return [...spec.cols.filter((c) => !c.derived).map((c) => c.name), ...(spec.sourceOnly ?? [])];
}

export class LegacyValueError extends Error {
  override name = 'LegacyValueError';
}

/** Checks a source value against its target column and normalises it (design D5): text is a
 * string without NUL (Postgres text cannot hold one), int is a bigint (the reader uses
 * `safeIntegers`), real is a number (an integer-valued REAL that SQLite returns as a bigint is
 * accepted when exactly representable). Anything else refuses the import. */
export function checkValue(v: unknown, col: Col, where: string): Value {
  if (v === null || v === undefined) {
    if (!col.nullable)
      throw new LegacyValueError(`${where}.${col.name}: NULL in a NOT NULL column`);
    return null;
  }
  switch (col.type) {
    case 'text':
      if (typeof v !== 'string') {
        throw new LegacyValueError(`${where}.${col.name}: expected text, got ${describe(v)}`);
      }
      if (v.includes('\u0000')) {
        throw new LegacyValueError(
          `${where}.${col.name}: text holds a NUL character, which Postgres text cannot store`,
        );
      }
      return v;
    case 'int':
      if (typeof v === 'bigint') return v;
      if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v);
      throw new LegacyValueError(`${where}.${col.name}: expected an integer, got ${describe(v)}`);
    case 'real':
      if (typeof v === 'number') return v;
      if (typeof v === 'bigint' && BigInt(Number(v)) === v) return Number(v);
      throw new LegacyValueError(`${where}.${col.name}: expected a real, got ${describe(v)}`);
  }
}

function describe(v: unknown): string {
  if (Buffer.isBuffer(v)) return 'a blob';
  return typeof v;
}

// -- COPY text format ---------------------------------------------------------------------------

const COPY_ESCAPES: Record<string, string> = {
  '\\': '\\\\',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
};

/** A text value as a COPY text-format field: backslash, newline, carriage return and tab become
 * escapes; every other character is literal (COPY reads it as is). NUL is refused. */
export function copyText(s: string): string {
  if (s.includes('\u0000')) throw new LegacyValueError('text holds a NUL character');
  return s.replace(/[\\\n\r\t]/g, (c) => COPY_ESCAPES[c]);
}

/** A double as text that Postgres's float8 input reads back to the same bits: the shortest
 * round-trip form (`String`), with `-0`, NaN and the infinities spelled explicitly. */
export function realText(v: number): string {
  if (Number.isNaN(v)) return 'NaN';
  if (v === Number.POSITIVE_INFINITY) return 'Infinity';
  if (v === Number.NEGATIVE_INFINITY) return '-Infinity';
  if (Object.is(v, -0)) return '-0';
  return String(v);
}

export function copyField(v: Value, type: ColType): string {
  if (v === null) return '\\N';
  switch (type) {
    case 'text':
      return copyText(v as string);
    case 'int':
      return (v as bigint).toString();
    case 'real':
      return realText(v as number);
  }
}

export function copyLine(values: Value[], cols: Col[]): string {
  return `${values.map((v, k) => copyField(v, cols[k].type)).join('\t')}\n`;
}

export function copyHeader(table: string, cols: Col[]): string {
  return `COPY catalog.${table} (${cols.map((c) => c.name).join(', ')}) FROM STDIN;\n`;
}

export const COPY_END = '\\.\n';

// -- canonical row hash (design D7) -------------------------------------------------------------

/** One field of the canonical row text: `N` for NULL, `T<utf8 bytes>:<text>`, `I<integer>`, or
 * `D<the 16 hex digits of the IEEE-754 big-endian bits>`. The SQL side (`canonicalFieldSql`)
 * builds the same text with `octet_length`, `::text` and `float8send`. */
export function canonicalField(v: Value, type: ColType): string {
  if (v === null) return 'N';
  switch (type) {
    case 'text': {
      const s = v as string;
      return `T${Buffer.byteLength(s, 'utf8')}:${s}`;
    }
    case 'int':
      return `I${(v as bigint).toString()}`;
    case 'real': {
      const b = Buffer.alloc(8);
      b.writeDoubleBE(v as number);
      return `D${b.toString('hex')}`;
    }
  }
}

export function md5(s: string): string {
  return createHash('md5').update(s, 'utf8').digest('hex');
}

export function rowHash(values: Value[], cols: Col[]): string {
  return md5(values.map((v, k) => canonicalField(v, cols[k].type)).join('|'));
}

/** Per-table expectation: the row count and the md5 of the sorted, concatenated row hashes (the
 * order of rows never matters, so no collation question arises). */
export class TableDigest {
  count = 0;
  private hashes: string[] = [];
  constructor(readonly spec: TableSpec) {}
  add(values: Value[]): void {
    this.count += 1;
    this.hashes.push(rowHash(values, this.spec.cols));
  }
  digest(): string {
    return md5([...this.hashes].sort().join(''));
  }
}

const qi = (name: string): string => `"${name}"`;

export function canonicalFieldSql(col: Col): string {
  const c = qi(col.name);
  switch (col.type) {
    case 'text':
      return `case when ${c} is null then 'N' else 'T' || octet_length(${c}) || ':' || ${c} end`;
    case 'int':
      return `case when ${c} is null then 'N' else 'I' || ${c}::text end`;
    case 'real':
      return `case when ${c} is null then 'N' else 'D' || encode(float8send(${c}), 'hex') end`;
  }
}

export function rowHashSql(cols: Col[]): string {
  return `md5(${cols.map(canonicalFieldSql).join(" || '|' || ")})`;
}

// -- the import file ----------------------------------------------------------------------------

/** The scope temp table: one `(kind, id)` row per imported key, COPY-loaded, so no id is ever
 * written into SQL text. Kinds: studio, show, session, setting, audio (an imported segment's
 * r2_key). */
export const IDS_TABLE = 'legacy_import_ids';
export const EXPECTED_TABLE = 'legacy_import_expected';

const SCOPE_SESSIONS = `(select x.id from catalog.sessions x join catalog.shows sh on sh.id = x.show_id
         where sh.studio_id = (select id from ${IDS_TABLE} where kind = 'studio'))`;

/** Header comments: printable ASCII only, and no backslash (psql meta-commands start with one). */
export function commentLines(lines: string[]): string[] {
  return lines.map((l) => `-- ${l.replace(/[^\x20-\x5b\x5d-\x7e]/g, '?')}`);
}

/** The opening of the import transaction, up to and including the scope COPY header. */
export function importPreamble(header: string[]): string {
  return `${[
    ...commentLines(header),
    '\\set ON_ERROR_STOP on',
    'BEGIN;',
    "SET LOCAL client_encoding = 'UTF8';",
    'SET LOCAL standard_conforming_strings = on;',
    'SET LOCAL search_path = pg_catalog, pg_temp;',
    '',
    '-- The target schema is the one this import was generated for.',
    'DO $guard$',
    'DECLARE v text;',
    'BEGIN',
    '  SELECT max(version) INTO v FROM supabase_migrations.schema_migrations;',
    `  IF v IS DISTINCT FROM '${TARGET_SCHEMA_VERSION}' THEN`,
    `    RAISE EXCEPTION 'legacy import refused: the target''s newest migration is %, this import was generated for ${TARGET_SCHEMA_VERSION}', v;`,
    '  END IF;',
    'END',
    '$guard$;',
    '',
    `CREATE TEMP TABLE ${IDS_TABLE} (kind text collate "C" NOT NULL, id text collate "C" NOT NULL) ON COMMIT DROP;`,
    `CREATE TEMP TABLE ${EXPECTED_TABLE} (tbl text collate "C" NOT NULL, n bigint NOT NULL) ON COMMIT DROP;`,
    '',
    '-- Nothing else creates or changes a team, show or session while the import decides and writes.',
    'LOCK TABLE catalog.studio_definitions, catalog.shows, catalog.sessions, catalog.app_settings IN SHARE ROW EXCLUSIVE MODE;',
    '',
    `COPY ${IDS_TABLE} (kind, id) FROM STDIN;`,
  ].join('\n')}\n`;
}

const SESSION_CHILD_TABLES = [
  'session_overwrites',
  'session_leases',
  ...SESSION_TABLES.map((s) => s.target),
];

export type CollisionMode = 'refuse' | 'replace' | 'replace-live';

/** The team's live data that `--replace` refuses to delete (only `--replace-live` does): what the
 * app or its users added after an import, which the source cannot bring back. Each entry is a
 * label and the count query (`st` is the team id). */
const LIVE_DATA: Array<[string, string]> = [
  [
    'session(s) not in the source',
    `SELECT count(*) FROM catalog.sessions x JOIN catalog.shows sh ON sh.id = x.show_id WHERE sh.studio_id = st AND x.id NOT IN (SELECT id FROM ${IDS_TABLE} WHERE kind = 'session')`,
  ],
  [
    'show(s) not in the source',
    `SELECT count(*) FROM catalog.shows WHERE studio_id = st AND id NOT IN (SELECT id FROM ${IDS_TABLE} WHERE kind = 'show')`,
  ],
  [
    'audio segment(s) not in the source',
    `SELECT count(*) FROM catalog.session_audio_segments a WHERE a.session_id IN (SELECT id FROM legacy_replace_sessions) AND a.r2_key NOT IN (SELECT id FROM ${IDS_TABLE} WHERE kind = 'audio')`,
  ],
  ['membership(s)', 'SELECT count(*) FROM catalog.user_studio_memberships WHERE studio_id = st'],
  ['invite(s)', 'SELECT count(*) FROM catalog.team_invites WHERE studio_id = st'],
  [
    'show grant(s)',
    'SELECT count(*) FROM catalog.show_grants WHERE show_id IN (SELECT id FROM catalog.shows WHERE studio_id = st)',
  ],
  [
    'session lease(s)',
    'SELECT count(*) FROM catalog.session_leases WHERE session_id IN (SELECT id FROM legacy_replace_sessions)',
  ],
  [
    'overwrite record(s)',
    'SELECT count(*) FROM catalog.session_overwrites WHERE session_id IN (SELECT id FROM legacy_replace_sessions)',
  ],
];

/** After the scope COPY: refuse any collision, or (`replace`) delete the studio's rows first.
 * Plain `replace` refuses when the team holds live data (LIVE_DATA); `replace-live` deletes it. */
export function collisionBlock(mode: CollisionMode): string {
  const studio = `(SELECT id FROM ${IDS_TABLE} WHERE kind = 'studio')`;
  const common = [
    'DO $collide$',
    'DECLARE n bigint; st text; live text[] := ARRAY[]::text[];',
    'BEGIN',
    `  SELECT id INTO st FROM ${IDS_TABLE} WHERE kind = 'studio';`,
  ];
  if (mode === 'refuse') {
    return [
      ...common,
      `  SELECT count(*) INTO n FROM catalog.studio_definitions d WHERE d.id = st;`,
      `  IF n > 0 THEN RAISE EXCEPTION 'legacy import refused: team % already exists (use --replace)', st; END IF;`,
      `  SELECT count(*) INTO n FROM catalog.shows s JOIN ${IDS_TABLE} i ON i.kind = 'show' AND i.id = s.id;`,
      `  IF n > 0 THEN RAISE EXCEPTION 'legacy import refused: % show id(s) already exist (use --replace)', n; END IF;`,
      `  SELECT count(*) INTO n FROM catalog.sessions s JOIN ${IDS_TABLE} i ON i.kind = 'session' AND i.id = s.id;`,
      `  IF n > 0 THEN RAISE EXCEPTION 'legacy import refused: % session id(s) already exist (use --replace)', n; END IF;`,
      `  SELECT count(*) INTO n FROM catalog.app_settings a JOIN ${IDS_TABLE} i ON i.kind = 'setting' AND i.id = a.key;`,
      `  IF n > 0 THEN RAISE EXCEPTION 'legacy import refused: the team''s settings already exist (use --replace)'; END IF;`,
      'END',
      '$collide$;',
      '',
    ].join('\n');
  }
  const liveGuard =
    mode === 'replace'
      ? [
          '  -- Plain --replace only swaps a team nobody has used: anything the source cannot bring back',
          '  -- refuses (--replace-live deletes it; the blobs of deleted segments stay in the volume).',
          ...LIVE_DATA.map(
            ([label, q]) =>
              `  ${q} INTO n; IF n > 0 THEN live := array_append(live, format('%s ${label}', n)); END IF;`,
          ),
          '  IF cardinality(live) > 0 THEN',
          "    RAISE EXCEPTION 'legacy import refused: --replace would delete live data of team %: % (use --replace-live)', st, array_to_string(live, '; ');",
          '  END IF;',
        ]
      : [];
  return [
    ...common,
    '  -- --replace never touches another team: an imported show or session id that belongs elsewhere refuses.',
    `  SELECT count(*) INTO n FROM catalog.shows s JOIN ${IDS_TABLE} i ON i.kind = 'show' AND i.id = s.id WHERE s.studio_id <> st;`,
    `  IF n > 0 THEN RAISE EXCEPTION 'legacy import refused: % show id(s) belong to another team', n; END IF;`,
    `  SELECT count(*) INTO n FROM catalog.sessions s JOIN ${IDS_TABLE} i ON i.kind = 'session' AND i.id = s.id`,
    `    WHERE s.show_id IS NULL OR s.show_id NOT IN (SELECT id FROM catalog.shows WHERE studio_id = st);`,
    `  IF n > 0 THEN RAISE EXCEPTION 'legacy import refused: % session id(s) belong to another team', n; END IF;`,
    `  CREATE TEMP TABLE legacy_replace_sessions ON COMMIT DROP AS ${SCOPE_SESSIONS.replace(/\n\s+/g, ' ')};`,
    ...liveGuard,
    ...SESSION_CHILD_TABLES.map(
      (tb) =>
        `  DELETE FROM catalog.${tb} WHERE session_id IN (SELECT id FROM legacy_replace_sessions);`,
    ),
    '  DELETE FROM catalog.sessions WHERE id IN (SELECT id FROM legacy_replace_sessions);',
    '  DELETE FROM catalog.show_grants WHERE show_id IN (SELECT id FROM catalog.shows WHERE studio_id = st);',
    '  DELETE FROM catalog.shows WHERE studio_id = st;',
    `  DELETE FROM catalog.app_settings WHERE key IN (SELECT id FROM ${IDS_TABLE} WHERE kind = 'setting');`,
    '  DELETE FROM catalog.user_studio_memberships WHERE studio_id = st;',
    '  DELETE FROM catalog.team_invites WHERE studio_id = st;',
    '  DELETE FROM catalog.studio_definitions WHERE id = st;',
    `  RAISE NOTICE 'legacy import: ${mode === 'replace' ? '--replace' : '--replace-live'} removed team % and its rows', ${studio};`,
    'END',
    '$collide$;',
    '',
  ].join('\n');
}

/** After the data: the inserted counts match the expectation (parity checks content). */
export function importEpilogue(): string {
  const counts = ALL_TABLES.map((s) => {
    const where =
      s.target === 'studio_definitions'
        ? `id = (SELECT id FROM ${IDS_TABLE} WHERE kind = 'studio')`
        : s.target === 'shows'
          ? `studio_id = (SELECT id FROM ${IDS_TABLE} WHERE kind = 'studio')`
          : s.target === 'app_settings'
            ? `key IN (SELECT id FROM ${IDS_TABLE} WHERE kind = 'setting')`
            : s.target === 'sessions'
              ? `id IN ${SCOPE_SESSIONS}`
              : `session_id IN ${SCOPE_SESSIONS}`;
    return `    SELECT '${s.target}'::text AS tbl, count(*) AS n FROM catalog.${s.target} WHERE ${where}`;
  });
  return [
    'DO $counts$',
    'DECLARE bad text;',
    'BEGIN',
    "  SELECT string_agg(format('%s: expected %s, found %s', e.tbl, e.n, coalesce(a.n, 0)), '; ') INTO bad",
    `  FROM ${EXPECTED_TABLE} e LEFT JOIN (`,
    counts.join('\n    UNION ALL\n'),
    '  ) a ON a.tbl = e.tbl WHERE e.n IS DISTINCT FROM coalesce(a.n, 0);',
    "  IF bad IS NOT NULL THEN RAISE EXCEPTION 'legacy import: row counts differ: %', bad; END IF;",
    'END',
    '$counts$;',
    '',
    'COMMIT;',
    '',
  ].join('\n');
}

// -- the parity file ----------------------------------------------------------------------------

export const PARITY_SCOPE = 'legacy_parity_scope';
export const PARITY_EXPECTED = 'legacy_parity_expected';

function scopeWhere(spec: TableSpec): string {
  const studio = `(SELECT id FROM ${PARITY_SCOPE} WHERE kind = 'studio')`;
  const sessions = `(SELECT x.id FROM catalog.sessions x JOIN catalog.shows sh ON sh.id = x.show_id WHERE sh.studio_id = ${studio})`;
  switch (spec.target) {
    case 'studio_definitions':
      return `id = ${studio}`;
    case 'shows':
      return `studio_id = ${studio}`;
    case 'app_settings':
      return `key IN (SELECT id FROM ${PARITY_SCOPE} WHERE kind = 'setting')`;
    case 'sessions':
      return `id IN ${sessions}`;
    default:
      return `session_id IN ${sessions}`;
  }
}

export interface ParityOptions {
  /** Skip the check that users, memberships, prefs, invites and login sessions are empty (a
   * check after someone signed in, e.g. on prod or after the bootstrap owner's claim). */
  allowSignedInUsers: boolean;
}

/** The parity file's opening, up to and including the scope COPY header. */
export function parityPreamble(header: string[]): string {
  return `${[
    ...commentLines(header),
    '\\set ON_ERROR_STOP on',
    'BEGIN ISOLATION LEVEL REPEATABLE READ;',
    "SET LOCAL client_encoding = 'UTF8';",
    'SET LOCAL search_path = pg_catalog, pg_temp;',
    `CREATE TEMP TABLE ${PARITY_SCOPE} (kind text collate "C" NOT NULL, id text collate "C" NOT NULL) ON COMMIT DROP;`,
    `CREATE TEMP TABLE ${PARITY_EXPECTED} (tbl text collate "C" NOT NULL, n bigint NOT NULL, digest text collate "C" NOT NULL) ON COMMIT DROP;`,
    `COPY ${PARITY_SCOPE} (kind, id) FROM STDIN;`,
  ].join('\n')}\n`;
}

/** After the two COPY blocks: compare every table's count and digest, then the invariants. The
 * transaction is rolled back: parity never changes the database. */
export function parityChecks(opts: ParityOptions): string {
  const actual = ALL_TABLES.map(
    (s) =>
      `    SELECT '${s.target}'::text AS tbl, count(*) AS n, md5(coalesce(string_agg(h, '' ORDER BY h COLLATE "C"), '')) AS digest\n` +
      `      FROM (SELECT ${rowHashSql(s.cols)} AS h FROM catalog.${s.target} WHERE ${scopeWhere(s)}) r`,
  );
  const studio = `(SELECT id FROM ${PARITY_SCOPE} WHERE kind = 'studio')`;
  const sessions = `(SELECT x.id FROM catalog.sessions x JOIN catalog.shows sh ON sh.id = x.show_id WHERE sh.studio_id = ${studio})`;
  const strictLines = opts.allowSignedInUsers
    ? []
    : [
        '  -- ADR 0021 slice 5a: the import brings back no users, memberships, prefs, invites or login',
        '  -- sessions; before the first sign-in these tables are empty (--allow-signed-in-users relaxes it).',
        ...[
          ['users', 'catalog.users'],
          ['user_studio_memberships', 'catalog.user_studio_memberships'],
          ['user_prefs', 'catalog.user_prefs'],
          ['team_invites', 'catalog.team_invites'],
          ['kv login sessions', "catalog.kv WHERE key LIKE 'session:%'"],
        ].map(
          ([label, from]) =>
            `  SELECT count(*) INTO n FROM ${from}; IF n > 0 THEN bad := array_append(bad, format('${label}: %s row(s), expected none', n)); END IF;`,
        ),
      ];
  return [
    'DO $parity$',
    'DECLARE bad text[] := ARRAY[]::text[]; rec record; n bigint;',
    'BEGIN',
    '  FOR rec IN',
    `    SELECT e.tbl, e.n AS en, e.digest AS ed, a.n AS an, a.digest AS ad FROM ${PARITY_EXPECTED} e LEFT JOIN (`,
    actual.join('\n    UNION ALL\n'),
    '    ) a ON a.tbl = e.tbl',
    '  LOOP',
    '    IF rec.an IS DISTINCT FROM rec.en THEN',
    "      bad := array_append(bad, format('%s: expected %s row(s), found %s', rec.tbl, rec.en, coalesce(rec.an, 0)));",
    '    ELSIF rec.ad IS DISTINCT FROM rec.ed THEN',
    "      bad := array_append(bad, format('%s: %s row(s), content differs', rec.tbl, rec.en));",
    '    END IF;',
    '  END LOOP;',
    '',
    "  -- The live projection equals the app's own (SessionCore.writeProjectionIfDirty).",
    '  SELECT count(*) INTO n FROM catalog.sessions s',
    '    LEFT JOIN catalog.session_transport t ON t.session_id = s.id',
    '    LEFT JOIN (SELECT session_id, count(*) AS c, max(timecode_total_frames) AS mx FROM catalog.session_events GROUP BY session_id) e',
    '      ON e.session_id = s.id',
    `   WHERE s.id IN ${sessions}`,
    '     AND (t.session_id IS NULL OR s.event_count <> coalesce(e.c, 0)',
    '          OR s.max_timecode_total_frames IS DISTINCT FROM e.mx OR s.is_rolling <> t.is_rolling',
    '          OR s.current_take <> t.current_take OR s.transport_elapsed_frames <> t.elapsed_frames',
    '          OR s.roll_started_at_utc IS DISTINCT FROM t.roll_started_at_utc);',
    "  IF n > 0 THEN bad := array_append(bad, format('%s session(s) without a transport row or with a stale live projection', n)); END IF;",
    '',
    '  -- revision against the imported events_stream_revision, independently of the importer (as',
    '  -- migration 20261010000000 seeds it: the value when it is a plain integer, else 0).',
    '  SELECT count(*) INTO n FROM catalog.sessions s',
    "    LEFT JOIN catalog.session_meta m ON m.session_id = s.id AND m.key = 'events_stream_revision'",
    `   WHERE s.id IN ${sessions}`,
    "     AND s.revision IS DISTINCT FROM coalesce(CASE WHEN m.value ~ '^[0-9]{1,18}$' THEN m.value::bigint END, 0);",
    "  IF n > 0 THEN bad := array_append(bad, format('%s session(s) whose revision differs from events_stream_revision', n)); END IF;",
    '',
    `  SELECT count(*) INTO n FROM catalog.session_leases WHERE session_id IN ${sessions};`,
    "  IF n > 0 THEN RAISE NOTICE 'legacy parity: % session lease(s) are held on imported sessions', n; END IF;",
    ...strictLines,
    '',
    '  IF cardinality(bad) > 0 THEN',
    "    RAISE EXCEPTION 'legacy parity FAILED: %', array_to_string(bad, '; ');",
    '  END IF;',
    `  RAISE NOTICE 'legacy parity OK: % tables match', (SELECT count(*) FROM ${PARITY_EXPECTED});`,
    'END',
    '$parity$;',
    'ROLLBACK;',
    '',
  ].join('\n');
}
