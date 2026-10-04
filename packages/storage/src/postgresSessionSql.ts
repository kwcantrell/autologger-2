// The Postgres session adapter (session-tables design D2, D3; ADR 0021 slice 7b-1): one session's
// storage over a bound catalog handle. `tx` is a session write transaction (the session's
// `catalog.sessions` row locked before the body runs), `snapshot` a read-only snapshot; both run on
// the catalog adapter's session slots. The handle a body receives has `all`, `run` and a joining
// `tx`. Storage does not import session-core (package-architecture: L1 packages are siblings), so
// it declares the seam's shape here; the composition root's assignment is the type check.
//
// session-content-policies D4 (ADR 0021 slice 7b-2): the adapter holds the catalog root and binds
// each call to its caller, a user (`bindUser`: the content policies apply, and a session the user
// cannot access is refused before the body runs) or a system task (`bindSystem`). A handle is a small
// object over the adapter's shared connections; binding per call allocates no connection.

import type { CatalogDb } from '@autologger/ports';
import type { PostgresBoundHandle, PostgresCatalogDb } from './postgresCatalogStore';

export type SessionSqlValue = string | number | null;
type Row = Record<string, SessionSqlValue>;

/** A body's handle, scoped to one transaction or snapshot. */
export interface SessionSqlHandle {
  all<T = Row>(sql: string, ...binds: SessionSqlValue[]): Promise<T[]>;
  run(sql: string, ...binds: SessionSqlValue[]): Promise<{ changes: number }>;
  /** Joins the enclosing transaction or snapshot. */
  tx<T>(fn: (t: SessionSqlHandle) => Promise<T>): Promise<T>;
}

/** Who a call runs for: session-core's `SessionCaller` without its brand (L1 siblings declare the
 * seam structurally; a branded caller is assignable to it). */
export type SessionCallerShape =
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: 'system'; readonly reason: string };

/** One session's storage: writes hold the session's row lock; reads run in one snapshot; each call
 * runs for its caller. */
export interface SessionStorage {
  tx<T>(caller: SessionCallerShape, fn: (t: SessionSqlHandle) => Promise<T>): Promise<T>;
  snapshot<T>(caller: SessionCallerShape, fn: (t: SessionSqlHandle) => Promise<T>): Promise<T>;
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
  /** `root` is the catalog adapter; each call binds its caller on it (session-content-policies D4). */
  constructor(private readonly root: PostgresCatalogDb) {}

  /** The caller's binding; a malformed caller throws `TypeError` (the adapter's checks). */
  private bind(caller: SessionCallerShape): PostgresBoundHandle {
    return caller.kind === 'user'
      ? this.root.bindUser(caller.userId)
      : this.root.bindSystem(caller.reason);
  }

  forSession(sessionId: string): SessionStorage {
    return {
      tx: async (caller, fn) =>
        this.bind(caller).sessionTx(sessionId, (t) => fn(sessionHandle(t))),
      snapshot: async (caller, fn) =>
        this.bind(caller).snapshot(sessionId, (t) => fn(sessionHandle(t))),
    };
  }
}
