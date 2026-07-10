// SqlStorage-shaped shim over better-sqlite3 — the seam SessionCore's stores
// already program against (exec(sql, ...binds) → { toArray(), rowsWritten }).
// Multi-statement SQL is supported only with zero binds (initSchema).

import type { Database } from 'better-sqlite3';

export type SqlValue = string | number | null | Buffer;

export interface SqlCursor<T> {
  toArray(): T[];
  rowsWritten: number;
}

export class SqlShim {
  constructor(private db: Database) {}

  exec<T = Record<string, SqlValue>>(sql: string, ...binds: SqlValue[]): SqlCursor<T> {
    let stmt;
    try {
      stmt = this.db.prepare(sql);
    } catch (e) {
      // Multi-statement input (initSchema). Only legal with zero binds.
      if (binds.length === 0 && /;/.test(sql)) {
        this.db.exec(sql);
        return { toArray: () => [], rowsWritten: 0 };
      }
      throw e;
    }
    if (stmt.reader) {
      const rows = stmt.all(...binds) as T[];
      return { toArray: () => rows, rowsWritten: 0 };
    }
    const info = stmt.run(...binds);
    return { toArray: () => [], rowsWritten: info.changes };
  }
}
