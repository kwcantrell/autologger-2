// Synthetic-fixture migrator tests (persistence-package-extraction task 2.3;
// design D2). The old server/src/node/migrate.test.ts resolved the REAL
// catalog migrations via `process.cwd()` and asserted the five real
// filenames — both break once this module lives in a package (no `cwd`
// contract, and no dependency on the catalog package's `.sql` files, which
// would mint the storage->catalog L1-sibling edge design D7/D1 forbids).
// This suite instead proves the migrator's own generic contract — filename
// ordering, `_migrations` bookkeeping, idempotency, and per-file
// transactional interrupted-run semantics — against migrations synthesized
// at test time, written to a fresh temp directory per test (hermetic, no
// fixture files committed to the package).
//
// What this suite deliberately does NOT cover: the real catalog migration
// files' own business logic (e.g. 0004's team-role backfill, 0005's
// title_suffix backfill) — that content-specific coverage is owned by the
// catalog package once it owns migrations/*.sql (design D2 "the real
// ordered set applies is owned by the fresh-DATA_DIR integration scenario
// (catalog side)"; tasks.md 3.5).

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations, openCatalogDb } from './migrate';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshMigrationsDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'autologger-storage-mig-'));
  tmpDirs.push(dir);
  for (const [name, sql] of Object.entries(files)) {
    writeFileSync(join(dir, name), sql, 'utf-8');
  }
  return dir;
}

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'autologger-storage-db-'));
  tmpDirs.push(dir);
  return openCatalogDb(join(dir, 'catalog.db'));
}

describe('migrator (synthetic fixtures)', () => {
  it('applies every .sql file in filename order and records each in _migrations', () => {
    const db = freshDb();
    // 0002 and 0003 each depend on the previous file's table via a foreign
    // key — applying out of filename order would fail loud, so a passing
    // run is itself proof the ordering is correct, not just plausible.
    const dir = freshMigrationsDir({
      '0001_widgets.sql': `
        CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
        INSERT INTO widgets (id, name) VALUES (1, 'seed');
      `,
      '0002_parts.sql': `
        CREATE TABLE parts (id INTEGER PRIMARY KEY, widget_id INTEGER NOT NULL REFERENCES widgets(id));
      `,
      '0003_labels.sql': `
        CREATE TABLE labels (id INTEGER PRIMARY KEY, part_id INTEGER NOT NULL REFERENCES parts(id));
      `,
    });

    const applied = applyMigrations(db, dir);
    expect(applied).toEqual(['0001_widgets.sql', '0002_parts.sql', '0003_labels.sql']);

    const names = (
      db.prepare('SELECT name FROM _migrations ORDER BY name').all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(names).toEqual(['0001_widgets.sql', '0002_parts.sql', '0003_labels.sql']);

    expect(() => db.prepare('SELECT * FROM widgets').all()).not.toThrow();
    expect(() => db.prepare('SELECT * FROM parts').all()).not.toThrow();
    expect(() => db.prepare('SELECT * FROM labels').all()).not.toThrow();
  });

  it('is idempotent — a second run against the same directory applies nothing', () => {
    const db = freshDb();
    const dir = freshMigrationsDir({
      '0001_a.sql': 'CREATE TABLE a (id INTEGER PRIMARY KEY);',
    });
    applyMigrations(db, dir);
    expect(applyMigrations(db, dir)).toEqual([]);
    const count = db.prepare('SELECT COUNT(*) AS n FROM _migrations').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('openCatalogDb enforces WAL/foreign_keys/synchronous/busy_timeout pragmas', () => {
    const db = freshDb();
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('synchronous', { simple: true })).toBe(1); // NORMAL
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
  });

  it('interrupted run: a failing file rolls back its own statements, does not record itself, and halts before later files', () => {
    const db = freshDb();
    const dir = freshMigrationsDir({
      '0001_ok.sql': 'CREATE TABLE ok_table (id INTEGER PRIMARY KEY);',
      // Two statements in one file, wrapped in db.transaction() by
      // applyMigrations: the CREATE TABLE succeeds, then the INSERT against
      // a nonexistent table throws — proving the whole file's transaction
      // (not just the failing statement) rolls back.
      '0002_bad.sql': `
        CREATE TABLE bad_table (id INTEGER PRIMARY KEY);
        INSERT INTO does_not_exist (id) VALUES (1);
      `,
      '0003_never.sql': 'CREATE TABLE never_table (id INTEGER PRIMARY KEY);',
    });

    expect(() => applyMigrations(db, dir)).toThrow();

    // 0001 committed (per-file transaction, not one mega-transaction for the run).
    expect(() => db.prepare('SELECT * FROM ok_table').all()).not.toThrow();
    const names = (db.prepare('SELECT name FROM _migrations').all() as Array<{ name: string }>).map(
      (r) => r.name,
    );
    expect(names).toEqual(['0001_ok.sql']);

    // 0002's CREATE TABLE rolled back with the rest of its failed transaction.
    expect(() => db.prepare('SELECT * FROM bad_table').all()).toThrow();
    // The synchronous loop halts on the first failure — 0003 is never attempted.
    expect(() => db.prepare('SELECT * FROM never_table').all()).toThrow();
  });

  it('restart-safe: fixing the failing file on disk and re-running resumes from where it stopped', () => {
    const db = freshDb();
    const dir = freshMigrationsDir({
      '0001_ok.sql': 'CREATE TABLE ok_table (id INTEGER PRIMARY KEY);',
      '0002_bad.sql': `
        CREATE TABLE bad_table (id INTEGER PRIMARY KEY);
        INSERT INTO does_not_exist (id) VALUES (1);
      `,
      '0003_never.sql': 'CREATE TABLE never_table (id INTEGER PRIMARY KEY);',
    });
    expect(() => applyMigrations(db, dir)).toThrow();

    // Same filename, corrected content — simulates an operator fixing a
    // broken migration file and restarting the server against the same DB.
    writeFileSync(join(dir, '0002_bad.sql'), 'CREATE TABLE bad_table (id INTEGER PRIMARY KEY);');

    const applied = applyMigrations(db, dir);
    expect(applied).toEqual(['0002_bad.sql', '0003_never.sql']);

    expect(() => db.prepare('SELECT * FROM bad_table').all()).not.toThrow();
    expect(() => db.prepare('SELECT * FROM never_table').all()).not.toThrow();
    const names = (
      db.prepare('SELECT name FROM _migrations ORDER BY name').all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(names).toEqual(['0001_ok.sql', '0002_bad.sql', '0003_never.sql']);
  });
});
