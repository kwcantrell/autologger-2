// Synchronous catalog query layer over better-sqlite3. The catalog is embedded
// and single-process (permanent invariant), so the seam is synchronous by
// design: reads return rows, writes return an affected-row count, and tx()
// wraps multi-statement writes in a single transaction. One named seam kept as
// the reversal point if a second backend ever became real.

import type { Database } from 'better-sqlite3';

export class CatalogDb {
  constructor(private db: Database) {}

  all<T = Record<string, unknown>>(sql: string, ...binds: unknown[]): T[] {
    return this.db.prepare(sql).all(...binds) as T[];
  }

  first<T = Record<string, unknown>>(sql: string, ...binds: unknown[]): T | null {
    return (this.db.prepare(sql).get(...binds) as T | undefined) ?? null;
  }

  run(sql: string, ...binds: unknown[]): { changes: number } {
    return { changes: this.db.prepare(sql).run(...binds).changes };
  }

  /** Atomic multi-statement writes: all-or-nothing via db.transaction()
   * (not raw BEGIN/COMMIT, which would throw on reentry). */
  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}
