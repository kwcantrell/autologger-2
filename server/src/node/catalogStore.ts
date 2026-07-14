// Thin prepared-statement adapter over better-sqlite3 for the catalog stores. Only the
// surface src/db/ actually calls: prepare().bind().all()/first()/run() with
// run().meta.changes, plus atomic batch(). Methods are synchronous; the store
// code `await`s them, which is a no-op on plain values.

import type { Database } from 'better-sqlite3';

export interface CatalogStmt {
  bind(...values: unknown[]): CatalogStmt;
  all<T = Record<string, unknown>>(): { results: T[] };
  first<T = Record<string, unknown>>(): T | null;
  run(): { meta: { changes: number } };
}

class Stmt implements CatalogStmt {
  constructor(
    private db: Database,
    private sql: string,
    private values: unknown[] = [],
  ) {}

  bind(...values: unknown[]): CatalogStmt {
    return new Stmt(this.db, this.sql, values);
  }

  all<T = Record<string, unknown>>(): { results: T[] } {
    return { results: this.db.prepare(this.sql).all(...this.values) as T[] };
  }

  first<T = Record<string, unknown>>(): T | null {
    return (this.db.prepare(this.sql).get(...this.values) as T | undefined) ?? null;
  }

  run(): { meta: { changes: number } } {
    const info = this.db.prepare(this.sql).run(...this.values);
    return { meta: { changes: info.changes } };
  }
}

export class CatalogDb {
  constructor(private db: Database) {}

  prepare(sql: string): CatalogStmt {
    return new Stmt(this.db, sql);
  }

  /** batch() is a single implicit transaction: all statements commit atomically. */
  batch(stmts: CatalogStmt[]): Array<{ meta: { changes: number } }> {
    return this.db.transaction(() => stmts.map((s) => s.run()))();
  }
}
