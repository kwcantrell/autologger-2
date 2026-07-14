// src/node/migrate.ts
// Startup migrator for the catalog DB — filename-ordered .sql files, tracked in
// _migrations, each applied in a transaction. Applies the full ordered set on a
// fresh database (no prior data is carried over).

import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function openCatalogDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

export function applyMigrations(db: Database.Database, dir: string): string[] {
  db.exec(
    'CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at_utc TEXT NOT NULL)',
  );
  const done = new Set(
    (db.prepare('SELECT name FROM _migrations').all() as Array<{ name: string }>).map(
      (r) => r.name,
    ),
  );
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const applied: string[] = [];
  for (const name of files) {
    if (done.has(name)) continue;
    const sql = readFileSync(join(dir, name), 'utf-8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (name, applied_at_utc) VALUES (?, ?)').run(
        name,
        new Date().toISOString(),
      );
    })();
    applied.push(name);
  }
  return applied;
}
