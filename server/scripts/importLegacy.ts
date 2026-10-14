// CLI: emit one studio's legacy pre-Supabase SQLite data as one Postgres transaction, plus a
// parity check and the list of audio files it references (OpenSpec change
// `supabase-11a-legacy-import`, ADR 0021 slice 11).
//
//   npx tsx server/scripts/importLegacy.ts <dataDir> --studio <id> [--out import.sql]
//     [--parity parity.sql] [--manifest manifest.txt] [--blob-sizes sizes.txt]
//     [--sha256 sha256.txt] [--blob-dir <dir>] [--replace | --replace-live]
//     [--allow-signed-in-users]
//
// Reads <dataDir>/catalog.db and <dataDir>/sessions/<id>.db read-only (`readonly`,
// `fileMustExist`, one read snapshot per file) and never writes under <dataDir>. The import file
// is fed to psql as `postgres` non-interactively (`psql -X -f import.sql`, or stdin from the file);
// the parity file afterwards. See docs/legacy-import.md for the runbook.
//
// Everything is read and checked before the closing COMMIT is written, so a run that fails never
// leaves a committable import stream (not even on stdout).
//
// What is imported (design D2): the studio_definitions row, its shows, `studio_config:<studio>`,
// every session of those shows (archived and hidden ones included) and all nine per-session tables.
// Never users, memberships, prefs, invites or KV (ADR 0021 slice 5a): the bootstrap owner claims
// the ownerless team at sign-in.
//
// Exit codes: 0 ok | 1 refused or failed (the reason is printed) | 2 usage error.

import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  openSync,
  rmSync,
  statSync,
  type WriteStream,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  ALL_TABLES,
  APP_SETTINGS,
  COPY_END,
  type Col,
  checkValue,
  collisionBlock,
  copyHeader,
  copyLine,
  EXPECTED_LEGACY_MIGRATIONS,
  EXPECTED_TABLE,
  importEpilogue,
  importPreamble,
  type CollisionMode,
  PARITY_EXPECTED,
  parityChecks,
  parityPreamble,
  SESSION_TABLES,
  SESSIONS,
  SHOWS,
  STUDIO_DEFINITIONS,
  sourceColumns,
  TableDigest,
  type TableSpec,
  type Value,
} from './legacyImportSql';

export const EXIT_OK = 0;
export const EXIT_FAIL = 1;
export const EXIT_USAGE = 2;

export class LegacyImportRefused extends Error {
  override name = 'LegacyImportRefused';
}

export interface ImportOptions {
  studio: string;
  /** Delete the studio's existing rows in the target first (same transaction); refuses at apply
   * time when the team holds live data (sessions, shows or audio not in the source, memberships,
   * invites, grants, leases, overwrite records). */
  replace?: boolean;
  /** `replace`, deleting the team's live data too. */
  replaceLive?: boolean;
  /** Where the legacy audio lives; default <dataDir>/blobs. */
  blobDir?: string;
  /** Parity: accept signed-in users (a re-check after the first sign-in). */
  allowSignedInUsers?: boolean;
  /** Hash every referenced blob for the sha256 list (slow: reads every byte). */
  sha256?: boolean;
}

export interface Sinks {
  importSql: Sink;
  paritySql?: Sink;
  manifest?: Sink;
  blobSizes?: Sink;
  sha256?: Sink;
}

export interface Sink {
  write(s: string): Promise<void>;
}

export interface ImportSummary {
  studio: string;
  rows: Record<string, number>;
  sessions: number;
  sessionsWithoutDb: string[];
  /** Per session file, the expected tables it does not have (read as empty). */
  missingTables: Record<string, string[]>;
  blobs: { referenced: number; present: number; bytes: number; missing: string[] };
  /** Sessions whose stored legacy projection differed from the recomputed one. */
  staleProjections: number;
  rollingSessions: string[];
}

// -- reading ------------------------------------------------------------------------------------

function openReadonly(path: string): Database.Database {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  db.defaultSafeIntegers(true);
  // One snapshot for every read of this file (a live writer cannot skew counts and rows).
  db.exec('BEGIN');
  db.prepare('SELECT count(*) FROM sqlite_master').get();
  return db;
}

function tableColumns(db: Database.Database, table: string): string[] | null {
  const rows = db.prepare('SELECT name FROM pragma_table_info(?)').all(table) as { name: string }[];
  return rows.length === 0 ? null : rows.map((r) => r.name);
}

/** The source table's columns must be exactly the spec's (design D5); a missing table is null. */
function checkColumns(
  db: Database.Database,
  spec: TableSpec,
  file: string,
  extra: string[] = [],
): boolean {
  const have = tableColumns(db, spec.source);
  if (have === null) return false;
  const want = [...sourceColumns(spec), ...extra];
  const missing = want.filter((c) => !have.includes(c));
  const unknown = have.filter((c) => !want.includes(c));
  if (missing.length || unknown.length) {
    throw new LegacyImportRefused(
      `${file}: table ${spec.source} has unexpected columns (missing: ${missing.join(', ') || 'none'}; unknown: ${unknown.join(', ') || 'none'})`,
    );
  }
  return true;
}

const qid = (s: string): string => `"${s.replace(/"/g, '""')}"`;

/** Rows of `spec.source` as records, each text value checked for lossy UTF-8 decoding: a value
 * holding U+FFFD is compared with the stored bytes, and differing bytes refuse the import. */
function* readRows(
  db: Database.Database,
  spec: TableSpec,
  file: string,
  where = '',
  ...binds: unknown[]
): Generator<Record<string, unknown>> {
  const cols = sourceColumns(spec);
  const stmt = db.prepare(
    `SELECT rowid AS "__rowid", ${cols.map(qid).join(', ')} FROM ${qid(spec.source)} ${where} ORDER BY rowid`,
  );
  for (const row of stmt.iterate(...binds) as Iterable<Record<string, unknown>>) {
    for (const c of cols) {
      const v = row[c];
      if (typeof v === 'string' && v.includes('�')) {
        const raw = db
          .prepare(`SELECT CAST(${qid(c)} AS BLOB) AS b FROM ${qid(spec.source)} WHERE rowid = ?`)
          .get(row.__rowid) as { b: Buffer };
        if (!Buffer.from(v, 'utf8').equals(raw.b)) {
          throw new LegacyImportRefused(
            `${file}: ${spec.source}.${c} holds bytes that are not valid UTF-8`,
          );
        }
      }
    }
    yield row;
  }
}

function valuesFor(
  spec: TableSpec,
  row: Record<string, unknown>,
  where: string,
  derived: Record<string, Value>,
): Value[] {
  return spec.cols.map((c: Col) =>
    c.derived ? checkValue(derived[c.name], c, where) : checkValue(row[c.name], c, where),
  );
}

/** A segment's blob key must be `audio/<that segment's session id>/<file name>`: it is written to
 * the manifest (fed to rsync, stat and rm) and joined to the blob root, so no component may be
 * empty, start with `-`, hold `..`, a backslash or a control character. */
export function checkBlobKey(key: string, sessionId: string): void {
  const parts = key.split('/');
  const ok =
    parts.length === 3 &&
    parts[0] === 'audio' &&
    parts[1] === sessionId &&
    parts.every(
      (p) =>
        p !== '' &&
        !p.startsWith('-') &&
        !p.includes('..') &&
        // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
        !/[\u0000-\u001f\u007f\\]/.test(p),
    );
  if (!ok)
    throw new LegacyImportRefused(
      `audio segment key ${JSON.stringify(key)} is not audio/<session id>/<file name> for session ${JSON.stringify(sessionId)}`,
    );
}

const REVISION_RE = /^[0-9]{1,18}$/;

interface SessionSource {
  id: string;
  db: Database.Database | null;
  file: string;
  present: Set<string>;
}

// -- the run ------------------------------------------------------------------------------------

export async function importLegacy(
  dataDir: string,
  opts: ImportOptions,
  sinks: Sinks,
): Promise<ImportSummary> {
  const root = resolve(dataDir);
  const catalogPath = join(root, 'catalog.db');
  if (!existsSync(catalogPath)) throw new LegacyImportRefused(`no catalog.db in ${root}`);
  const blobRoot = resolve(opts.blobDir ?? join(root, 'blobs'));
  const open: Database.Database[] = [];
  try {
    const cat = openReadonly(catalogPath);
    open.push(cat);

    // Design D1: the legacy schema the map was written for.
    if (tableColumns(cat, '_migrations') === null) {
      throw new LegacyImportRefused('catalog.db has no _migrations table');
    }
    const applied = (
      cat.prepare('SELECT name FROM _migrations ORDER BY name').all() as { name: string }[]
    ).map((r) => r.name);
    const want = [...EXPECTED_LEGACY_MIGRATIONS];
    if (applied.length !== want.length || applied.some((n, k) => n !== want[k])) {
      throw new LegacyImportRefused(
        `catalog.db _migrations is [${applied.join(', ')}], expected exactly [${want.join(', ')}]`,
      );
    }
    for (const spec of [STUDIO_DEFINITIONS, SHOWS, APP_SETTINGS, SESSIONS]) {
      if (!checkColumns(cat, spec, 'catalog.db')) {
        throw new LegacyImportRefused(`catalog.db has no ${spec.source} table`);
      }
    }

    const studioRows = [
      ...readRows(cat, STUDIO_DEFINITIONS, 'catalog.db', 'WHERE id = ?', opts.studio),
    ];
    if (studioRows.length !== 1) {
      throw new LegacyImportRefused(
        `catalog.db has no studio_definitions row ${JSON.stringify(opts.studio)}`,
      );
    }
    const showRows = [...readRows(cat, SHOWS, 'catalog.db', 'WHERE studio_id = ?', opts.studio)];
    const settingKey = `studio_config:${opts.studio}`;
    const settingRows = [...readRows(cat, APP_SETTINGS, 'catalog.db', 'WHERE key = ?', settingKey)];
    const showIds = showRows.map((s) => s.id as string);
    const sessionRows = showIds.length
      ? [
          ...readRows(
            cat,
            SESSIONS,
            'catalog.db',
            `WHERE show_id IN (${showIds.map(() => '?').join(', ')})`,
            ...showIds,
          ),
        ]
      : [];

    // Open every session file once, each pinned to one snapshot.
    const sources: SessionSource[] = [];
    const summary: ImportSummary = {
      studio: opts.studio,
      rows: {},
      sessions: sessionRows.length,
      sessionsWithoutDb: [],
      missingTables: {},
      blobs: { referenced: 0, present: 0, bytes: 0, missing: [] },
      staleProjections: 0,
      rollingSessions: [],
    };
    for (const s of sessionRows) {
      const id = s.id as string;
      if (
        id.includes('/') ||
        id.includes('\\') ||
        id === '.' ||
        id === '..' ||
        id.includes('\u0000')
      ) {
        throw new LegacyImportRefused(`session id ${JSON.stringify(id)} is not a plain file name`);
      }
      const file = `sessions/${id}.db`;
      const path = join(root, 'sessions', `${id}.db`);
      if (!existsSync(path)) {
        summary.sessionsWithoutDb.push(id);
        sources.push({ id, db: null, file, present: new Set() });
        continue;
      }
      const db = openReadonly(path);
      open.push(db);
      const present = new Set<string>();
      for (const spec of SESSION_TABLES) {
        if (checkColumns(db, spec, file)) present.add(spec.source);
      }
      const missing = SESSION_TABLES.filter((t) => !present.has(t.source)).map((t) => t.source);
      if (missing.length) summary.missingTables[id] = missing;
      sources.push({ id, db, file, present });
    }

    // Derived session columns (design D4): the projection SessionCore writes, and the revision
    // migration 20261010000000 seeds from events_stream_revision.
    const derivedBySession = new Map<string, Record<string, Value>>();
    const seededTransport = new Set<string>();
    const audioKeys = new Set<string>();
    for (const src of sources) {
      let n = 0n;
      let mx: bigint | null = null;
      let tr = {
        is_rolling: 0n,
        current_take: 0n,
        roll_started_at_utc: null as string | null,
        elapsed_frames: 0n,
      };
      let revision = 0n;
      if (src.db) {
        if (src.present.has('events')) {
          const a = src.db
            .prepare('SELECT count(*) AS n, max(timecode_total_frames) AS mx FROM events')
            .get() as {
            n: bigint;
            mx: bigint | null;
          };
          n = a.n;
          mx = a.mx;
        }
        if (src.present.has('session_transport')) {
          const rows = src.db.prepare('SELECT * FROM session_transport').all() as Record<
            string,
            unknown
          >[];
          if (rows.length > 1 || (rows.length === 1 && rows[0].id !== 1n)) {
            throw new LegacyImportRefused(
              `${src.file}: session_transport must hold at most the row id = 1`,
            );
          }
          if (rows.length === 1) {
            const cols = SESSION_TABLES[1].cols;
            const v = valuesFor(SESSION_TABLES[1], rows[0], `${src.file}:session_transport`, {
              session_id: src.id,
            });
            tr = {
              is_rolling: v[cols.findIndex((c) => c.name === 'is_rolling')] as bigint,
              current_take: v[cols.findIndex((c) => c.name === 'current_take')] as bigint,
              roll_started_at_utc: v[cols.findIndex((c) => c.name === 'roll_started_at_utc')] as
                | string
                | null,
              elapsed_frames: v[cols.findIndex((c) => c.name === 'elapsed_frames')] as bigint,
            };
          } else seededTransport.add(src.id);
        } else seededTransport.add(src.id);
        if (src.present.has('session_audio_segments')) {
          for (const { k } of src.db
            .prepare('SELECT r2_key AS k FROM session_audio_segments ORDER BY rowid')
            .all() as { k: unknown }[]) {
            if (typeof k !== 'string') continue; // the row read below refuses it
            checkBlobKey(k, src.id);
            audioKeys.add(k);
          }
        }
        if (src.present.has('meta')) {
          const m = src.db
            .prepare("SELECT value FROM meta WHERE key = 'events_stream_revision'")
            .get() as { value: unknown } | undefined;
          if (m && typeof m.value === 'string' && REVISION_RE.test(m.value))
            revision = BigInt(m.value);
        }
      } else seededTransport.add(src.id);
      if (tr.is_rolling !== 0n) summary.rollingSessions.push(src.id);
      derivedBySession.set(src.id, {
        event_count: n,
        max_timecode_total_frames: mx,
        is_rolling: tr.is_rolling,
        current_take: tr.current_take,
        transport_elapsed_frames: tr.elapsed_frames,
        roll_started_at_utc: tr.roll_started_at_utc,
        revision,
      });
    }

    const digests = new Map<string, TableDigest>(
      ALL_TABLES.map((s) => [s.target, new TableDigest(s)]),
    );
    const out = sinks.importSql;
    const mode: CollisionMode = opts.replaceLive
      ? 'replace-live'
      : opts.replace
        ? 'replace'
        : 'refuse';
    const header = [
      `AutoLogger legacy import (OpenSpec supabase-11a-legacy-import), team ${JSON.stringify(opts.studio)}`,
      `source ${JSON.stringify(root)}, generated ${new Date().toISOString()}`,
      `mode: ${
        mode === 'replace-live'
          ? "--replace-live (the team's existing rows are deleted first, live data included)"
          : mode === 'replace'
            ? "--replace (the team's existing rows are deleted first; refuses if the team has live data)"
            : 'refuse on any existing id'
      }`,
      'Apply with psql as postgres, NON-INTERACTIVELY only: `psql -X -f import.sql` or',
      '`docker exec -i <db> psql -X -U postgres < import.sql`. Never paste it into an interactive psql.',
      'Then run the parity file the same way.',
    ];
    await out.write(importPreamble(header));
    // Scope ids (COPY, never SQL text).
    const idLines: string[] = [];
    const idRow = (kind: string, id: string) => copyLine([kind, id], SCOPE_COLS);
    idLines.push(idRow('studio', opts.studio));
    for (const id of showIds) idLines.push(idRow('show', id));
    for (const src of sources) idLines.push(idRow('session', src.id));
    idLines.push(idRow('setting', settingKey));
    for (const k of audioKeys) idLines.push(idRow('audio', k));
    await out.write(`${idLines.join('') + COPY_END}\n`);
    await out.write(collisionBlock(mode));

    const emitCatalog = async (
      spec: TableSpec,
      rows: Record<string, unknown>[],
      derive: (r: Record<string, unknown>) => Record<string, Value>,
    ) => {
      if (rows.length === 0) return;
      await out.write(copyHeader(spec.target, spec.cols));
      const d = digests.get(spec.target) as TableDigest;
      let buf = '';
      for (const row of rows) {
        const v = valuesFor(spec, row, `catalog.db:${spec.source}`, derive(row));
        d.add(v);
        buf += copyLine(v, spec.cols);
        if (buf.length > 1 << 20) {
          await out.write(buf);
          buf = '';
        }
      }
      await out.write(`${buf + COPY_END}\n`);
    };
    const none = () => ({});
    await emitCatalog(STUDIO_DEFINITIONS, studioRows, none);
    await emitCatalog(SHOWS, showRows, none);
    await emitCatalog(APP_SETTINGS, settingRows, none);
    await emitCatalog(SESSIONS, sessionRows, (row) => {
      const d = derivedBySession.get(row.id as string) as Record<string, Value>;
      const stale =
        row.event_count !== d.event_count ||
        row.max_timecode_total_frames !== d.max_timecode_total_frames ||
        row.is_rolling !== d.is_rolling ||
        row.current_take !== d.current_take ||
        row.transport_elapsed_frames !== d.transport_elapsed_frames ||
        row.roll_started_at_utc !== d.roll_started_at_utc;
      if (stale) summary.staleProjections += 1;
      return d;
    });

    const blobKeys: string[] = [];
    for (const spec of SESSION_TABLES) {
      const d = digests.get(spec.target) as TableDigest;
      let started = false;
      let buf = '';
      const flush = async (force: boolean) => {
        if (buf.length > 1 << 20 || (force && buf)) {
          if (!started) {
            await out.write(copyHeader(spec.target, spec.cols));
            started = true;
          }
          await out.write(buf);
          buf = '';
        }
      };
      for (const src of sources) {
        const where = `${src.file}:${spec.source}`;
        if (src.db && src.present.has(spec.source)) {
          for (const row of readRows(src.db, spec, src.file)) {
            const v = valuesFor(spec, row, where, { session_id: src.id, version: 1n });
            d.add(v);
            buf += copyLine(v, spec.cols);
            if (spec.target === 'session_audio_segments') {
              const key = row.r2_key as string;
              checkBlobKey(key, src.id);
              blobKeys.push(key);
            }
            await flush(false);
          }
        }
        if (spec.target === 'session_transport' && seededTransport.has(src.id)) {
          // The row SessionCore.seed() inserts when a hub opens (design D4).
          const v: Value[] = [src.id, 0n, 0n, null, 0n];
          d.add(v);
          buf += copyLine(v, spec.cols);
        }
      }
      await flush(true);
      if (started) await out.write(`${COPY_END}\n`);
    }

    // Expected counts, for the in-transaction count check.
    let exp = `COPY ${EXPECTED_TABLE} (tbl, n) FROM STDIN;\n`;
    for (const spec of ALL_TABLES) {
      const d = digests.get(spec.target) as TableDigest;
      summary.rows[spec.target] = d.count;
      exp += copyLine([spec.target, BigInt(d.count)], EXPECTED_COLS);
    }
    await out.write(`${exp + COPY_END}\n`);

    // Blobs (design D8).
    summary.blobs.referenced = blobKeys.length;
    for (const key of blobKeys) {
      const path = resolve(blobRoot, key);
      if (!path.startsWith(blobRoot + sep))
        throw new LegacyImportRefused(`audio key ${key} escapes the blob root`);
      let size: number | null = null;
      try {
        const st = statSync(path);
        if (st.isFile()) size = st.size;
      } catch {
        size = null;
      }
      if (sinks.manifest) await sinks.manifest.write(`${key}\n`);
      if (size === null) {
        summary.blobs.missing.push(key);
        continue;
      }
      summary.blobs.present += 1;
      summary.blobs.bytes += size;
      if (sinks.blobSizes) await sinks.blobSizes.write(`${size} ${key}\n`);
      if (sinks.sha256 && opts.sha256)
        await sinks.sha256.write(`${await sha256File(path)}  ${key}\n`);
    }

    // Parity.
    if (sinks.paritySql) {
      const p = sinks.paritySql;
      await p.write(
        parityPreamble([
          `AutoLogger legacy parity check, team ${JSON.stringify(opts.studio)}; run after the import, as postgres.`,
          `source ${JSON.stringify(root)}, generated ${new Date().toISOString()}`,
          'It changes nothing (ROLLBACK) and fails with "legacy parity FAILED: ..." on any difference.',
        ]),
      );
      await p.write(`${idRow('studio', opts.studio) + idRow('setting', settingKey) + COPY_END}\n`);
      let pe = `COPY ${PARITY_EXPECTED} (tbl, n, digest) FROM STDIN;\n`;
      for (const spec of ALL_TABLES) {
        const d = digests.get(spec.target) as TableDigest;
        pe += copyLine([spec.target, BigInt(d.count), d.digest()], PARITY_EXPECTED_COLS);
      }
      await p.write(`${pe + COPY_END}\n`);
      await p.write(parityChecks({ allowSignedInUsers: Boolean(opts.allowSignedInUsers) }));
    }

    // Last: only a run that got this far emits the COMMIT.
    await out.write(importEpilogue());
    return summary;
  } finally {
    for (const db of open) if (db.open) db.close();
  }
}

const SCOPE_COLS: Col[] = [
  { name: 'kind', type: 'text', nullable: false },
  { name: 'id', type: 'text', nullable: false },
];
const EXPECTED_COLS: Col[] = [
  { name: 'tbl', type: 'text', nullable: false },
  { name: 'n', type: 'int', nullable: false },
];
const PARITY_EXPECTED_COLS: Col[] = [
  ...EXPECTED_COLS,
  { name: 'digest', type: 'text', nullable: false },
];

function sha256File(path: string): Promise<string> {
  return new Promise((done, fail) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (b) => h.update(b))
      .on('error', fail)
      .on('end', () => done(h.digest('hex')));
  });
}

// -- sinks and CLI ------------------------------------------------------------------------------

export function streamSink(stream: NodeJS.WritableStream): Sink {
  return {
    write: (s) =>
      new Promise((done, fail) => {
        const ok = stream.write(s, (err) => (err ? fail(err) : undefined));
        if (ok) done();
        else stream.once('drain', () => done());
      }),
  };
}

/** A file sink, closed (and flushed) by `close()`. */
export function fileSink(path: string): Sink & { close(): Promise<void> } {
  // Opened synchronously with O_EXCL: an existing file refuses here, before anything is written.
  const fd = openSync(path, 'wx', 0o600);
  const ws: WriteStream = createWriteStream('', { fd });
  const sink = streamSink(ws);
  return {
    write: sink.write,
    close: () =>
      new Promise((done, fail) => {
        ws.on('error', fail);
        ws.end(() => done());
      }),
  };
}

const USAGE = `usage: npx tsx server/scripts/importLegacy.ts <dataDir> --studio <id> [--out import.sql]
  [--parity parity.sql] [--manifest manifest.txt] [--blob-sizes sizes.txt] [--sha256 sha256.txt]
  [--blob-dir <dir>] [--replace | --replace-live] [--allow-signed-in-users]

Emits one transaction that imports one team's legacy SQLite data (catalog.db + sessions/*.db)
into schema catalog; feed it to psql as postgres non-interactively (psql -X -f, or stdin from
the file), never by pasting. Output files must not exist yet.
  --out           the import SQL (default: stdout)
  --parity        a read-only parity check to run after the import
  --manifest      every audio key the imported segments reference, one per line
  --blob-sizes    "<bytes> <key>" for each present blob (compare with stat -c '%s %n')
  --sha256        sha256sum -c list of the present blobs (reads every byte)
  --blob-dir      where the legacy audio lives (default <dataDir>/blobs)
  --replace       delete the team's existing rows in the target first, in the same transaction;
                  refuses at apply time if the team has live data (sessions, shows or audio not in
                  the source, memberships, invites, show grants, leases, overwrite records)
  --replace-live  --replace that deletes the live data too (their blobs are not removed)
  --allow-signed-in-users  parity accepts users and memberships (a re-check after sign-in)`;

export async function main(argv: string[], log = console.error): Promise<number> {
  const pos: string[] = [];
  const flags: Record<string, string> = {};
  const bools = new Set<string>();
  const valued = [
    '--studio',
    '--out',
    '--parity',
    '--manifest',
    '--blob-sizes',
    '--sha256',
    '--blob-dir',
  ];
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    if (a === '--help' || a === '-h') {
      log(USAGE);
      return EXIT_OK;
    }
    if (valued.includes(a)) {
      const v = argv[k + 1];
      if (v === undefined || v.startsWith('--')) {
        log(`${a} needs a value\n${USAGE}`);
        return EXIT_USAGE;
      }
      flags[a] = v;
      k++;
    } else if (a === '--replace' || a === '--replace-live' || a === '--allow-signed-in-users')
      bools.add(a);
    else if (a.startsWith('--')) {
      log(`unknown flag ${a}\n${USAGE}`);
      return EXIT_USAGE;
    } else pos.push(a);
  }
  if (pos.length !== 1 || !flags['--studio']) {
    log(USAGE);
    return EXIT_USAGE;
  }
  const files: Array<Sink & { close(): Promise<void> }> = [];
  const createdByRun = new Set<string>();
  const file = (flag: string) => {
    if (!flags[flag]) return undefined;
    const s = fileSink(flags[flag]);
    createdByRun.add(flags[flag]);
    files.push(s);
    return s;
  };
  try {
    const sinks: Sinks = {
      importSql: file('--out') ?? streamSink(process.stdout),
      paritySql: file('--parity'),
      manifest: file('--manifest'),
      blobSizes: file('--blob-sizes'),
      sha256: file('--sha256'),
    };
    const s = await importLegacy(
      pos[0],
      {
        studio: flags['--studio'],
        replace: bools.has('--replace'),
        replaceLive: bools.has('--replace-live'),
        blobDir: flags['--blob-dir'],
        allowSignedInUsers: bools.has('--allow-signed-in-users'),
        sha256: Boolean(flags['--sha256']),
      },
      sinks,
    );
    await Promise.all(files.map((f) => f.close()));
    log(`team ${s.studio}: ${s.sessions} session(s)`);
    for (const [tb, n] of Object.entries(s.rows)) log(`  ${tb.padEnd(30)} ${n}`);
    log(
      `audio: ${s.blobs.referenced} referenced, ${s.blobs.present} present (${s.blobs.bytes} bytes), ${s.blobs.missing.length} missing`,
    );
    for (const k of s.blobs.missing) log(`  missing: ${k}`);
    if (s.sessionsWithoutDb.length)
      log(`sessions without a .db file (imported empty): ${s.sessionsWithoutDb.join(', ')}`);
    for (const [id, tbs] of Object.entries(s.missingTables))
      log(`session ${id} lacks ${tbs.join(', ')} (read as empty)`);
    log(
      `legacy live projections recomputed; ${s.staleProjections} differed from the stored values`,
    );
    if (s.rollingSessions.length)
      log(`WARNING: rolling in the source: ${s.rollingSessions.join(', ')}`);
    return EXIT_OK;
  } catch (e) {
    await Promise.allSettled(files.map((f) => f.close()));
    // A partial output must never be applied: remove what this run created.
    for (const flag of ['--out', '--parity', '--manifest', '--blob-sizes', '--sha256']) {
      if (flags[flag] && createdByRun.has(flags[flag])) rmSync(flags[flag], { force: true });
    }
    log(`legacy import: ${e instanceof Error ? e.message : String(e)}`);
    return EXIT_FAIL;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(EXIT_FAIL);
    },
  );
}
