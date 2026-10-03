// The Postgres session adapter (session-tables design D2, D3; ADR 0021 slice 7b-1): one session's
// storage over a bound catalog handle. `tx` is a session write transaction (the session's
// `catalog.sessions` row locked before the body runs), `snapshot` a read-only snapshot; both run on
// the catalog adapter's session slots. The handle a body receives has `all`, `run` and a joining
// `tx`. Storage does not import session-core (package-architecture: L1 packages are siblings), so
// it declares the seam's shape here; the composition root's assignment is the type check.

import type { CatalogDb } from '@autologger/ports';
import type { PostgresBoundHandle } from './postgresCatalogStore';

export type SessionSqlValue = string | number | null;
type Row = Record<string, SessionSqlValue>;

/** A body's handle, scoped to one transaction or snapshot. */
export interface SessionSqlHandle {
  all<T = Row>(sql: string, ...binds: SessionSqlValue[]): Promise<T[]>;
  run(sql: string, ...binds: SessionSqlValue[]): Promise<{ changes: number }>;
  /** Joins the enclosing transaction or snapshot. */
  tx<T>(fn: (t: SessionSqlHandle) => Promise<T>): Promise<T>;
}

/** One session's storage: writes hold the session's row lock; reads run in one snapshot. */
export interface SessionStorage {
  tx<T>(fn: (t: SessionSqlHandle) => Promise<T>): Promise<T>;
  snapshot<T>(fn: (t: SessionSqlHandle) => Promise<T>): Promise<T>;
}

function sessionHandle(t: CatalogDb): SessionSqlHandle {
  const h: SessionSqlHandle = {
    all: <T = Row>(sql: string, ...binds: SessionSqlValue[]) => t.all<T>(sql, ...binds),
    run: (sql, ...binds) => t.run(sql, ...binds),
    tx: (fn) => t.tx(async () => fn(h)),
  };
  return h;
}

export class PostgresSessionDb {
  /** `handle` decides who the statements run for: `bindSystem('session-hub')` in slice 7b-1. */
  constructor(private readonly handle: PostgresBoundHandle) {}

  forSession(sessionId: string): SessionStorage {
    const handle = this.handle;
    return {
      tx: (fn) => handle.sessionTx(sessionId, (t) => fn(sessionHandle(t))),
      snapshot: (fn) => handle.snapshot((t) => fn(sessionHandle(t))),
    };
  }
}
