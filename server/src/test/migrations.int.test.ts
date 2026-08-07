// persistence-package-extraction task 3.5: integration pins for the
// "catalog package owns the catalog schema migrations" spec — fresh
// DATA_DIR migrates the full ordered set via the package path (same
// _migrations name set/order, same schema) and an already-migrated
// DATA_DIR is untouched by a second boot — exercised through the REAL
// composition root (`createBindings`), not a mock. Also recreates the
// migration-CONTENT coverage the pre-move `server/src/node/migrate.test.ts`
// carried for 0004/0005 (team-role admin backfill, show title_suffix
// backfill), which task 2.3 explicitly deferred here rather than dropping
// (phase-2 review) — those tests apply the REAL `@autologger/catalog`
// migrations directly via `@autologger/storage`'s migrator, since they need
// pre-migration-subset database states `createBindings` doesn't expose.

import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CATALOG_MIGRATIONS_DIR } from '@autologger/catalog';
import { applyMigrations, openCatalogDb } from '@autologger/storage';
import { afterEach, describe, expect, it } from 'vitest';
import { createBindings } from '../node/config';

const REAL_MIGRATION_NAMES = [
  '0001_init.sql',
  '0002_sessions_live_split.sql',
  '0003_kv.sql',
  '0004_team_roles_and_invites.sql',
  '0005_show_title_suffix.sql',
];

const scratchDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (scratchDirs.length) {
    rmSync(scratchDirs.pop() as string, { recursive: true, force: true });
  }
});

describe('catalog migrations via the real composition root (package-architecture spec)', () => {
  it('fresh DATA_DIR migrates the full ordered set via the package path, recording the same name set/order and producing the same schema', () => {
    const dir = tempDir('autologger-catmig-');
    const { bindings, close } = createBindings({ DATA_DIR: dir });
    try {
      const byName = bindings.ports.catalog
        .all<{ name: string }>('SELECT name FROM _migrations ORDER BY name')
        .map((r) => r.name);
      expect(byName).toEqual([...REAL_MIGRATION_NAMES].sort());

      // Application order: rowid reflects insertion order (the table has no
      // other ordering key), proving the set applied in filename order, not
      // just that the same five names eventually landed.
      const byRowid = bindings.ports.catalog
        .all<{ name: string }>('SELECT name FROM _migrations ORDER BY rowid')
        .map((r) => r.name);
      expect(byRowid).toEqual(REAL_MIGRATION_NAMES);

      // Resulting schema: one artifact from each migration is present.
      expect(() => bindings.ports.catalog.all('SELECT * FROM users LIMIT 1')).not.toThrow();
      expect(() => bindings.ports.catalog.all('SELECT * FROM kv LIMIT 1')).not.toThrow();
      expect(() => bindings.ports.catalog.all('SELECT * FROM team_invites LIMIT 1')).not.toThrow();
      const membershipCols = bindings.ports.catalog
        .all<{ name: string }>('PRAGMA table_info(user_studio_memberships)')
        .map((c) => c.name);
      expect(membershipCols).toContain('role');
      const showCols = bindings.ports.catalog
        .all<{ name: string }>('PRAGMA table_info(shows)')
        .map((c) => c.name);
      expect(showCols).toContain('title_suffix');
    } finally {
      close();
    }
  });

  it('already-migrated DATA_DIR is untouched by a second boot', () => {
    const dir = tempDir('autologger-catmig-');
    const first = createBindings({ DATA_DIR: dir });
    const firstRows = first.bindings.ports.catalog.all<{
      name: string;
      applied_at_utc: string;
    }>('SELECT name, applied_at_utc FROM _migrations ORDER BY name');
    expect(firstRows).toHaveLength(REAL_MIGRATION_NAMES.length);
    first.close();

    // Second boot against the SAME DATA_DIR: startup must proceed normally
    // (no throw), and no migration re-applies — same rows, same timestamps.
    const second = createBindings({ DATA_DIR: dir });
    try {
      const secondRows = second.bindings.ports.catalog.all<{
        name: string;
        applied_at_utc: string;
      }>('SELECT name, applied_at_utc FROM _migrations ORDER BY name');
      expect(secondRows).toEqual(firstRows);
    } finally {
      second.close();
    }
  });
});

describe('catalog migration content: 0004 team-role backfill + invites (recreated per phase-2 review)', () => {
  it('fresh DB: role column + team_invites land with 0004', () => {
    const dir = tempDir('autologger-catmig-content-');
    const db = openCatalogDb(join(dir, 'catalog.db'));
    applyMigrations(db, CATALOG_MIGRATIONS_DIR);
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
    const invCols = (
      db.prepare('PRAGMA table_info(team_invites)').all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(invCols).toEqual(['studio_id', 'email_norm', 'invited_by_user_id', 'invited_at_utc']);
    db.close();
  });

  it('backfills admin for pre-existing non-built-in memberships, leaves built-ins as member', () => {
    // Seed a DB at the pre-0004 revision (only 0001-0003 applied), insert
    // memberships for a built-in studio AND a non-built-in studio, then run
    // the real 0004/0005 and assert the built-in-aware backfill.
    const dir = tempDir('autologger-catmig-content-');
    const preMigDir = tempDir('autologger-catmig-subset-');
    for (const name of ['0001_init.sql', '0002_sessions_live_split.sql', '0003_kv.sql']) {
      cpSync(join(CATALOG_MIGRATIONS_DIR, name), join(preMigDir, name));
    }
    const db = openCatalogDb(join(dir, 'catalog.db'));
    applyMigrations(db, preMigDir);

    const now = new Date().toISOString();
    db.exec(`
      INSERT INTO users (id, google_sub, email, given_name, family_name, created_at_utc)
      VALUES ('u1', 'sub1', 'u1@example.com', 'U', 'One', '${now}');
    `);
    db.prepare('INSERT INTO user_studio_memberships (user_id, studio_id) VALUES (?, ?)').run(
      'u1',
      'test-studios',
    ); // built-in
    db.prepare('INSERT INTO user_studio_memberships (user_id, studio_id) VALUES (?, ?)').run(
      'u1',
      'acme-crew',
    ); // non-built-in

    const applied = applyMigrations(db, CATALOG_MIGRATIONS_DIR);
    expect(applied).toEqual(['0004_team_roles_and_invites.sql', '0005_show_title_suffix.sql']);

    const rows = db
      .prepare('SELECT studio_id, role FROM user_studio_memberships ORDER BY studio_id')
      .all() as Array<{ studio_id: string; role: string }>;
    expect(rows).toEqual([
      { studio_id: 'acme-crew', role: 'admin' },
      { studio_id: 'test-studios', role: 'member' },
    ]);

    // Post-migration inserts default to member.
    db.prepare('INSERT INTO user_studio_memberships (user_id, studio_id) VALUES (?, ?)').run(
      'u1',
      'another-crew',
    );
    const fresh = db
      .prepare(
        "SELECT role FROM user_studio_memberships WHERE user_id = 'u1' AND studio_id = 'another-crew'",
      )
      .get() as { role: string };
    expect(fresh.role).toBe('member');
    db.close();
  });
});

describe('catalog migration content: 0005 show title_suffix backfill (recreated per phase-2 review)', () => {
  it('backfills pre-existing shows to episode, defaults new shows to date (D7)', () => {
    // Seed a DB at the pre-0005 revision, insert a show the way 0001's own
    // seed does (matching column list), then run the real 0005 and assert
    // the populated-DB backfill split named in session-title-suffix task 3.1.
    const dir = tempDir('autologger-catmig-content-');
    const preMigDir = tempDir('autologger-catmig-subset-');
    for (const name of [
      '0001_init.sql',
      '0002_sessions_live_split.sql',
      '0003_kv.sql',
      '0004_team_roles_and_invites.sql',
    ]) {
      cpSync(join(CATALOG_MIGRATIONS_DIR, name), join(preMigDir, name));
    }
    const db = openCatalogDb(join(dir, 'catalog.db'));
    applyMigrations(db, preMigDir);

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO shows (id, studio_id, name, show_code, next_episode, created_at_utc)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('show-pre', 'studio-1', 'Pre-existing Show', 'PRE', 1, now);

    const applied = applyMigrations(db, CATALOG_MIGRATIONS_DIR);
    expect(applied).toEqual(['0005_show_title_suffix.sql']);

    const preRow = db.prepare('SELECT title_suffix FROM shows WHERE id = ?').get('show-pre') as {
      title_suffix: string;
    };
    expect(preRow.title_suffix).toBe('episode');

    // A show already seeded by 0001_init.sql's own INSERT OR IGNORE is ALSO
    // pre-existing relative to 0005, so it backfills to 'episode' too.
    const seeded = db
      .prepare("SELECT title_suffix FROM shows WHERE id = 'show-autolog-test'")
      .get() as { title_suffix: string };
    expect(seeded.title_suffix).toBe('episode');

    // Post-migration inserts (omitting title_suffix) default to 'date'.
    db.prepare(
      `INSERT INTO shows (id, studio_id, name, show_code, next_episode, created_at_utc)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('show-post', 'studio-1', 'New Show', 'NEW', 1, now);
    const postRow = db.prepare('SELECT title_suffix FROM shows WHERE id = ?').get('show-post') as {
      title_suffix: string;
    };
    expect(postRow.title_suffix).toBe('date');

    const cols = db.prepare('PRAGMA table_info(shows)').all() as Array<{
      name: string;
      notnull: number;
      dflt_value: unknown;
    }>;
    const col = cols.find((c) => c.name === 'title_suffix');
    expect(col).toBeDefined();
    expect(col?.notnull).toBe(1);
    expect(String(col?.dflt_value).replace(/'/g, '')).toBe('date');
    db.close();
  });
});
