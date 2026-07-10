import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations, openCatalogDb } from './migrate';

const MIGRATIONS_DIR = join(process.cwd(), 'src/db/migrations');
let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function freshDb() {
  dir = mkdtempSync(join(tmpdir(), 'autologger-mig-'));
  return openCatalogDb(join(dir, 'catalog.db'));
}

describe('migrator', () => {
  it('applies all migrations in filename order and records them', () => {
    const db = freshDb();
    const applied = applyMigrations(db, MIGRATIONS_DIR);
    expect(applied).toEqual(['0001_init.sql', '0002_sessions_live_split.sql', '0003_kv.sql']);
    const names = db.prepare('SELECT name FROM _migrations ORDER BY name').all();
    expect(names).toHaveLength(3);
    // Schema landed: catalog tables + kv exist.
    expect(() => db.prepare('SELECT * FROM users LIMIT 1').all()).not.toThrow();
    expect(() => db.prepare('SELECT * FROM kv LIMIT 1').all()).not.toThrow();
  });

  it('is idempotent — second run applies nothing', () => {
    const db = freshDb();
    applyMigrations(db, MIGRATIONS_DIR);
    expect(applyMigrations(db, MIGRATIONS_DIR)).toEqual([]);
  });

  it('openCatalogDb enforces the pragmas', () => {
    const db = freshDb();
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('synchronous', { simple: true })).toBe(1); // NORMAL
  });
});
