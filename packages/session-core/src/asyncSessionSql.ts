// The asynchronous session SQL seam and its SQLite adapter (async-session-hub design D2; ADR 0021
// slice 7a). `AsyncSessionSql` is a temporary name: it becomes `SessionSql` when the hub goes
// async. The transaction contract is the catalog's, so 7b's postgres.js adapter meets one shape:
// - `tx(fn)` hands its body a handle scoped to the transaction, and `tx` on that handle joins it
//   (no savepoints);
// - any error inside the transaction fails all of it, even one the body catches;
// - misuse rejects with `SessionTxMisuseError` instead of escaping the transaction.
// The adapter holds no lock: the hub's lock covers every call on the connection (design D3).
// Only this adapter wraps synchronous better-sqlite3 calls in promises.

import type Database from 'better-sqlite3';
import type { Row, SqlValue } from './sessionCore';

export interface AsyncSessionSql {
  all<T = Row>(sql: string, ...binds: SqlValue[]): Promise<T[]>;
  run(sql: string, ...binds: SqlValue[]): Promise<{ changes: number }>;
  /** Multi-statement DDL (initSchema); zero binds, no result. */
  exec(multiStatementSql: string): Promise<void>;
  /** All-or-nothing. `t` is scoped to this transaction; `t.tx` joins it. */
  tx<T>(fn: (t: AsyncSessionSql) => Promise<T>): Promise<T>;
}

/** The SQLite adapter's root handle. `rollbackFailed` turns true when a `ROLLBACK` failed and left
 * the connection inside the transaction; the hub then closes itself (design D2, D6). */
export interface SqliteAsyncSessionSql extends AsyncSessionSql {
  readonly rollbackFailed: boolean;
}

/** A transaction handle used after its transaction, a body that returned while a joined body
 * ran, a root statement while a transaction is open, or a hub call from inside its own hub's
 * transaction (design D2, D4). */
export class SessionTxMisuseError extends Error {
  override name = 'SessionTxMisuseError';
}

/** A call on a hub that is closing or closed (design D6). */
export class SessionHubClosedError extends Error {
  override name = 'SessionHubClosedError';
}

interface TxState {
  open: boolean;
  failed: boolean;
  error: unknown;
  /** Joined `tx` bodies still running. */
  joined: number;
}

/** Records the transaction's first error; later errors don't replace it. */
function fail(state: TxState, error: unknown): void {
  if (state.failed) return;
  state.failed = true;
  state.error = error;
}

/** Marks a promise a handle hands out as handled, so one a body drops can't crash the process;
 * an awaiting caller still sees the rejection, and the transaction carries the error. */
function handled<T>(p: Promise<T>): Promise<T> {
  p.catch(() => {});
  return p;
}

export function sqliteAsyncSessionSql(db: Database.Database): SqliteAsyncSessionSql {
  let active: TxState | null = null;
  let rollbackFailed = false;

  /** A root statement must not run while a transaction is open on the connection: SQLite would
   * run it inside that transaction (spike A2). */
  const guardRoot = (): void => {
    if (active !== null) {
      throw new SessionTxMisuseError(
        'session root handle used while a transaction is open; use the transaction handle',
      );
    }
    if (rollbackFailed || db.inTransaction) {
      throw new SessionTxMisuseError(
        'session connection is inside a transaction this adapter did not open or could not roll back',
      );
    }
  };

  const root = async <T>(work: () => T): Promise<T> => {
    guardRoot();
    return work();
  };

  /** Rolls back only a transaction SQLite still has open. A failed ROLLBACK leaves the first error
   * in place, attaches the rollback error as its `cause`, and sets `rollbackFailed`. */
  const rollback = (state: TxState): void => {
    if (!db.inTransaction) return;
    try {
      db.exec('ROLLBACK');
    } catch (rollbackError) {
      if (!db.inTransaction) return;
      rollbackFailed = true;
      const first = state.error;
      if (first instanceof Error && first.cause === undefined) {
        Object.defineProperty(first, 'cause', {
          value: rollbackError,
          writable: true,
          configurable: true,
          enumerable: false,
        });
      }
    }
  };

  return {
    get rollbackFailed() {
      return rollbackFailed;
    },
    all: <T = Row>(sql: string, ...binds: SqlValue[]) =>
      root(() => db.prepare(sql).all(...binds) as T[]),
    run: (sql: string, ...binds: SqlValue[]) =>
      root(() => ({ changes: db.prepare(sql).run(...binds).changes })),
    exec: (multiStatementSql: string) =>
      root(() => {
        db.exec(multiStatementSql);
      }),
    async tx<T>(fn: (t: AsyncSessionSql) => Promise<T>): Promise<T> {
      guardRoot();
      const state: TxState = { open: true, failed: false, error: undefined, joined: 0 };
      db.exec('BEGIN IMMEDIATE');
      active = state;
      try {
        let value: T | undefined;
        try {
          value = await fn(new TxHandle(db, state));
        } catch (error) {
          fail(state, error);
        }
        state.open = false;
        if (state.joined > 0) {
          fail(
            state,
            new SessionTxMisuseError(
              'transaction body returned while a joined tx() was still running',
            ),
          );
        }
        if (!state.failed) {
          try {
            db.exec('COMMIT');
          } catch (error) {
            fail(state, error);
          }
        }
        if (state.failed) {
          rollback(state);
          throw state.error;
        }
        return value as T;
      } finally {
        state.open = false;
        active = null;
      }
    },
  };
}

/** The handle a transaction body receives. Its statements run at call time: the hub's lock is
 * already held for the whole transaction. */
class TxHandle implements AsyncSessionSql {
  constructor(
    private readonly db: Database.Database,
    private readonly state: TxState,
  ) {}

  all<T = Row>(sql: string, ...binds: SqlValue[]): Promise<T[]> {
    return this.statement(() => this.db.prepare(sql).all(...binds) as T[]);
  }

  run(sql: string, ...binds: SqlValue[]): Promise<{ changes: number }> {
    return this.statement(() => ({ changes: this.db.prepare(sql).run(...binds).changes }));
  }

  exec(multiStatementSql: string): Promise<void> {
    return this.statement(() => {
      this.db.exec(multiStatementSql);
    });
  }

  /** Joins the enclosing transaction; its error fails the whole transaction. */
  tx<T>(fn: (t: AsyncSessionSql) => Promise<T>): Promise<T> {
    return handled(
      (async () => {
        this.checkUsable();
        this.state.joined++;
        try {
          return await fn(this);
        } catch (error) {
          fail(this.state, error);
          throw error;
        } finally {
          this.state.joined--;
        }
      })(),
    );
  }

  private statement<T>(work: () => T): Promise<T> {
    return handled(
      (async () => {
        this.checkUsable();
        if (!this.db.inTransaction) {
          const err = new SessionTxMisuseError('the transaction was rolled back by SQLite');
          fail(this.state, err);
          throw err;
        }
        try {
          return work();
        } catch (error) {
          fail(this.state, error);
          throw error;
        }
      })(),
    );
  }

  private checkUsable(): void {
    if (!this.state.open) {
      throw new SessionTxMisuseError('transaction handle used after its transaction ended', {
        cause: this.state.error,
      });
    }
    if (this.state.failed) {
      throw new SessionTxMisuseError('transaction already failed', { cause: this.state.error });
    }
  }
}
