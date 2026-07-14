import { cpSync, mkdtempSync, rmSync } from 'node:fs';
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
    expect(applied).toEqual([
      '0001_init.sql',
      '0002_sessions_live_split.sql',
      '0003_kv.sql',
      '0004_team_roles_and_invites.sql',
    ]);
    const names = db.prepare('SELECT name FROM _migrations ORDER BY name').all();
    expect(names).toHaveLength(4);
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

  it('fresh DB: role column + team_invites land with 0004', () => {
    const db = freshDb();
    applyMigrations(db, MIGRATIONS_DIR);
    const cols = db.prepare('PRAGMA table_info(user_studio_memberships)').all() as Array<{
      name: string;
      notnull: number;
      dflt_value: unknown;
    }>;
    const role = cols.find((c) => c.name === 'role');
    expect(role).toBeDefined();
    expect(role?.notnull).toBe(1);
    expect(String(role?.dflt_value).replace(/'/g, '')).toBe('member');
    expect(() => db.prepare('SELECT * FROM team_invites LIMIT 1').all()).not.toThrow();
    const invCols = (db.prepare('PRAGMA table_info(team_invites)').all() as Array<{
      name: string;
    }>).map((c) => c.name);
    expect(invCols).toEqual([
      'studio_id',
      'email_norm',
      'invited_by_user_id',
      'invited_at_utc',
    ]);
  });

  it('backfills admin for pre-existing non-built-in memberships, leaves built-ins as member', () => {
    // Seed a DB at the pre-0004 revision (only 0001-0003 applied), insert
    // memberships for a built-in studio AND a non-built-in studio, then run
    // 0004 and assert the built-in-aware backfill.
    const preMigDir = mkdtempSync(join(tmpdir(), 'autologger-mig-subset-'));
    for (const name of ['0001_init.sql', '0002_sessions_live_split.sql', '0003_kv.sql']) {
      cpSync(join(MIGRATIONS_DIR, name), join(preMigDir, name));
    }
    const db = freshDb();
    applyMigrations(db, preMigDir);
    rmSync(preMigDir, { recursive: true, force: true });

    const now = new Date().toISOString();
    db.exec(`
      INSERT INTO users (id, google_sub, email, given_name, family_name, created_at_utc)
      VALUES ('u1', 'sub1', 'u1@example.com', 'U', 'One', '${now}');
    `);
    db.prepare(
      'INSERT INTO user_studio_memberships (user_id, studio_id) VALUES (?, ?)',
    ).run('u1', 'test-studios'); // built-in
    db.prepare(
      'INSERT INTO user_studio_memberships (user_id, studio_id) VALUES (?, ?)',
    ).run('u1', 'acme-crew'); // non-built-in

    const applied = applyMigrations(db, MIGRATIONS_DIR);
    expect(applied).toEqual(['0004_team_roles_and_invites.sql']);

    const rows = db
      .prepare('SELECT studio_id, role FROM user_studio_memberships ORDER BY studio_id')
      .all() as Array<{ studio_id: string; role: string }>;
    expect(rows).toEqual([
      { studio_id: 'acme-crew', role: 'admin' },
      { studio_id: 'test-studios', role: 'member' },
    ]);

    // Post-migration inserts default to member.
    db.prepare(
      'INSERT INTO user_studio_memberships (user_id, studio_id) VALUES (?, ?)',
    ).run('u1', 'another-crew');
    const fresh = db
      .prepare(
        "SELECT role FROM user_studio_memberships WHERE user_id = 'u1' AND studio_id = 'another-crew'",
      )
      .get() as { role: string };
    expect(fresh.role).toBe('member');
  });
});
