// CLI: WAL-safe copy of every SQLite database under a DATA_DIR into a
// destination directory (task 7.3, containerize-split-images).
//
//   npx tsx server/scripts/copyDataDir.ts <srcDataDir> <dstDir> [--overwrite] [--dry-run]
//
// Runs from any AutoLogger checkout (including the old host's, for the final
// cutover copy): depends only on `better-sqlite3` and `node:` built-ins.
//
// What it does, per `*.db` (catalog.db, sessions/<id>.db, any other *.db found
// recursively; the top-level `blobs/` tree is never entered):
//   1. opens the SOURCE read-only (`readonly`, `fileMustExist`) and begins a
//      read transaction, so the DB (main file + -wal) is pinned to one snapshot;
//   2. counts rows in every table inside that snapshot;
//   3. runs better-sqlite3 `db.backup()` (SQLite online-backup API) into a
//      temp file beside the final path. The backup runs in ONE step (progress
//      returns a huge page count) inside the same snapshot, so a live writer
//      can neither restart it nor skew it: uncheckpointed -wal rows are
//      included, and the copy is exactly the snapshot the counts came from;
//   4. runs `PRAGMA integrity_check` on the copy and compares its per-table row
//      counts (and table set) with the snapshot counts;
//   5. only if all of that passes, removes the destination's stale -wal/-shm/
//      -journal, then atomically renames the temp file over the
//      final path. A failed copy never replaces an existing (seeded) copy.
// Because counts and backup share one snapshot, a count mismatch is ALWAYS a
// real error, even while the old server keeps writing (pre-seed); no
// "--quiesced" mode is needed. The source is never written: no -wal checkpoint
// (readonly connections do not checkpoint), nothing created under it. The only
// source-side side effect SQLite may have is the volatile `-shm` index.
//
// Blobs are NOT copied here; the exact `rsync -a --delete` command is printed.
//
// Exit codes: 0 ok | 1 copy/verification failure (integrity, counts, backup
// error, corrupt source db) | 2 usage error or refused unsafe invocation (incl.
// --overwrite onto a destination db that another process has open).

import Database from 'better-sqlite3';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXIT_OK = 0;
export const EXIT_VERIFY = 1;
export const EXIT_UNSAFE = 2;

export interface CopyOptions {
  /** Replace destination *.db files that already exist (cutover step). */
  overwrite?: boolean;
  /** Enumerate and validate only; write nothing. */
  dryRun?: boolean;
  log?: (line: string) => void;
  err?: (line: string) => void;
  /** Test seam: runs on the staged copy after backup, before verification. */
  afterBackup?: (tmpPath: string) => void;
}

export interface DbResult {
  rel: string;
  tables: number;
  rows: number;
  error?: string;
}

export interface CopyResult {
  exitCode: number;
  dbs: DbResult[];
}

const USAGE = `usage: npx tsx server/scripts/copyDataDir.ts <srcDataDir> <dstDir> [--overwrite] [--dry-run]

Copies every *.db under <srcDataDir> (catalog.db, sessions/*.db, ...) into <dstDir>
with the SQLite online-backup API, then verifies integrity_check and per-table row
counts. The source is opened read-only and never modified. Blobs are not copied.

  --overwrite  replace *.db files already present in <dstDir> (cutover step)
  --dry-run    list what would be copied and check the invocation; write nothing

exit codes: 0 ok | 1 copy or verification failure | 2 usage error / unsafe invocation`;

function realOrSelf(p: string): string {
  // Resolve symlinks through the nearest existing ancestor (dst may not exist yet).
  const abs = resolve(p);
  const tail: string[] = [];
  let cur = abs;
  while (!existsSync(cur)) {
    tail.unshift(basename(cur));
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return join(realpathSync(cur), ...tail);
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** All *.db files (relative paths) under `root`, skipping the top-level blobs/ tree
 * and symlinks. -wal/-shm/-journal files never match `.db`. */
function findDbs(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (dir === root && e.name === 'blobs') continue;
        walk(full);
      } else if (e.isFile() && e.name.endsWith('.db')) {
        out.push(relative(root, full));
      }
    }
  };
  walk(root);
  return out.sort();
}

const q = (id: string): string => `"${id.replaceAll('"', '""')}"`;

function tableCounts(db: Database.Database): Map<string, number> {
  const names = (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
  const m = new Map<string, number>();
  for (const n of names) {
    m.set(n, (db.prepare(`SELECT count(*) AS n FROM ${q(n)}`).get() as { n: number }).n);
  }
  return m;
}

/** True when another connection/process holds `path` open. Under an exclusive
 * locking_mode a WAL db cannot be read while any other connection has it open
 * (the -shm locks are held), so this fails fast with SQLITE_BUSY. Any other
 * error (e.g. not a database) is not "in use": the file is about to be replaced. */
function isInUse(path: string): boolean {
  let probe: Database.Database | undefined;
  try {
    probe = new Database(path, { fileMustExist: true, timeout: 250 });
    probe.pragma('locking_mode = EXCLUSIVE');
    probe.exec('BEGIN EXCLUSIVE');
    probe.exec('ROLLBACK');
    return false;
  } catch (e) {
    const code = (e as { code?: string }).code ?? '';
    return code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED');
  } finally {
    try {
      probe?.close();
    } catch {}
  }
}

function removeIfExists(p: string): void {
  rmSync(p, { force: true });
}

async function copyOne(
  srcPath: string,
  dstPath: string,
  rel: string,
  opts: CopyOptions,
): Promise<DbResult> {
  const tmp = join(dirname(dstPath), `.${basename(dstPath)}.copying`);
  const result: DbResult = { rel, tables: 0, rows: 0 };
  let src: Database.Database | undefined;
  try {
    mkdirSync(dirname(dstPath), { recursive: true });
    for (const s of ['', '-wal', '-shm', '-journal']) removeIfExists(tmp + s);
    src = new Database(srcPath, { readonly: true, fileMustExist: true });
    src.exec('BEGIN'); // pin one snapshot for the counts AND the backup
    const expected = tableCounts(src);
    await src.backup(tmp, { progress: () => 0x7fffffff });
    src.exec('COMMIT');
    src.close();
    src = undefined;

    opts.afterBackup?.(tmp);

    const copy = new Database(tmp, { fileMustExist: true });
    try {
      const ic = copy.pragma('integrity_check', { simple: true });
      if (ic !== 'ok') throw new Error(`integrity_check failed: ${String(ic)}`);
      const got = tableCounts(copy);
      const problems: string[] = [];
      for (const [t, n] of expected) {
        if (!got.has(t)) problems.push(`table ${t} missing in copy`);
        else if (got.get(t) !== n) problems.push(`table ${t}: source ${n} rows, copy ${got.get(t)}`);
      }
      for (const t of got.keys()) if (!expected.has(t)) problems.push(`table ${t} not in source`);
      if (problems.length > 0) throw new Error(`row count mismatch: ${problems.join('; ')}`);
      result.tables = expected.size;
      result.rows = [...expected.values()].reduce((a, b) => a + b, 0);
      copy.pragma('journal_mode = DELETE'); // fold any -wal into the file; leave one plain file
    } finally {
      copy.close();
    }
    for (const s of ['-wal', '-shm', '-journal']) {
      if (existsSync(tmp + s)) throw new Error(`stray ${basename(tmp)}${s} after verification`);
    }
    // The temp copy is fully verified. Only now drop the destination's stale
    // -wal/-shm/-journal (left by an earlier api run): if they survived the
    // rename, SQLite could replay that old WAL onto the new file and silently
    // corrupt it. Then swap in atomically. (Never touches the source.)
    for (const s of ['-wal', '-shm', '-journal']) removeIfExists(dstPath + s);
    renameSync(tmp, dstPath);
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    try {
      if (src?.open) src.close();
    } catch {}
    for (const s of ['', '-wal', '-shm', '-journal']) removeIfExists(tmp + s);
  }
  return result;
}

export async function copyDataDir(
  srcArg: string,
  dstArg: string,
  opts: CopyOptions = {},
): Promise<CopyResult> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const err = opts.err ?? ((l: string) => console.error(l));
  const refuse = (msg: string): CopyResult => {
    err(`refused: ${msg}`);
    return { exitCode: EXIT_UNSAFE, dbs: [] };
  };

  if (!existsSync(srcArg) || !statSync(srcArg).isDirectory()) {
    return refuse(`source ${srcArg} does not exist or is not a directory`);
  }
  const src = realpathSync(srcArg);
  const dst = realOrSelf(dstArg);
  if (src === dst) return refuse('destination is the same directory as the source');
  if (isInside(dst, src)) return refuse('destination is inside the source directory');
  if (isInside(src, dst)) return refuse('source is inside the destination directory');
  if (existsSync(dst) && !statSync(dst).isDirectory()) {
    return refuse(`destination ${dstArg} exists and is not a directory`);
  }

  const dbs = findDbs(src);
  if (dbs.length === 0) return refuse(`no *.db files found under ${src}`);
  const clashes = dbs.filter((rel) => existsSync(join(dst, rel)));
  if (clashes.length > 0 && !opts.overwrite) {
    return refuse(
      `${clashes.length} destination db file(s) already exist (e.g. ${clashes[0]}); pass --overwrite to replace them`,
    );
  }

  if (opts.overwrite && !opts.dryRun) {
    const busy = clashes.filter((rel) => isInUse(join(dst, rel)));
    if (busy.length > 0) {
      return refuse(
        `destination db in use by another process (e.g. ${busy[0]}); stop the api (docker compose stop api) before replacing DB files`,
      );
    }
  }

  log(`source:      ${src}`);
  log(`destination: ${dst}`);
  log(`databases:   ${dbs.length}${opts.dryRun ? ' (dry run, nothing written)' : ''}`);
  const results: DbResult[] = [];
  if (!opts.dryRun) {
    for (const rel of dbs) {
      const r = await copyOne(join(src, rel), join(dst, rel), rel, opts);
      results.push(r);
      if (r.error) err(`FAIL ${rel}: ${r.error}`);
      else log(`ok   ${rel}  (${r.tables} tables, ${r.rows} rows, integrity ok)`);
    }
  }
  const failed = results.filter((r) => r.error);
  if (failed.length > 0) {
    err(`${failed.length} of ${dbs.length} database(s) failed verification`);
  } else if (!opts.dryRun) {
    log(`all ${dbs.length} database(s) copied and verified`);
  }
  log('');
  log('blobs are not copied by this script; mirror them (including deletions) with:');
  log(`  rsync -a --delete ${src}/blobs/ ${dst}/blobs/`);
  log('(swap in user@host:path for either side when the copy crosses machines)');
  return { exitCode: failed.length > 0 ? EXIT_VERIFY : EXIT_OK, dbs: results };
}

async function main(argv: string[]): Promise<number> {
  const pos: string[] = [];
  const opts: CopyOptions = {};
  for (const a of argv) {
    if (a === '--overwrite') opts.overwrite = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--help' || a === '-h') {
      console.log(USAGE);
      return EXIT_OK;
    } else if (a.startsWith('--')) {
      console.error(`unknown flag ${a}\n${USAGE}`);
      return EXIT_UNSAFE;
    } else pos.push(a);
  }
  if (pos.length !== 2) {
    console.error(USAGE);
    return EXIT_UNSAFE;
  }
  return (await copyDataDir(pos[0], pos[1], opts)).exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(EXIT_VERIFY);
    },
  );
}
