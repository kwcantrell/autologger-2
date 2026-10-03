// A test SessionSql that yields to a timer before every statement (async-session-hub design D1,
// D12), so hub calls on it really overlap, as every call will once 7b's statements do I/O. It wraps
// the real SQLite adapter, so the transaction contract is the production one, and it can inject
// two failures the real adapter only reaches in rare states: a transaction that rejects before its
// body runs, and a failed ROLLBACK (reported through `rollbackFailed`, design D2, D6). Test
// infrastructure, moved here from @autologger/session-core with the DB-backed session tests
// (session-tables D12).

import type { SqliteSessionSql } from '@autologger/session-core/asyncSessionSql';
import type { Row, SessionSql, SqlValue } from '@autologger/session-core/sessionCore';

export interface SlowSql extends SqliteSessionSql {
  /** The next `count` root transactions reject with `error` before their body runs. */
  failNextTx(count: number, error?: Error): void;
  /** The next root transaction that fails reports a failed ROLLBACK through `rollbackFailed`. */
  failNextRollback(): void;
}

/** `delayMs` 0 yields a microtask instead of a timer, for tests on fake timers. */
export function slowSql(inner: SqliteSessionSql, opts: { delayMs?: number } = {}): SlowSql {
  const delayMs = opts.delayMs ?? 1;
  const yieldNow = (): Promise<void> =>
    delayMs > 0 ? new Promise((resolve) => setTimeout(resolve, delayMs)) : Promise.resolve();
  let txFailures: { count: number; error: Error } = { count: 0, error: new Error('injected') };
  let rollbackArmed = false;
  let rollbackFailed = false;

  const wrap = (h: SessionSql): SessionSql => ({
    all: async <T = Row>(sql: string, ...binds: SqlValue[]): Promise<T[]> => {
      await yieldNow();
      return h.all<T>(sql, ...binds);
    },
    run: async (sql: string, ...binds: SqlValue[]) => {
      await yieldNow();
      return h.run(sql, ...binds);
    },
    exec: async (multiStatementSql: string) => {
      await yieldNow();
      return h.exec(multiStatementSql);
    },
    tx: <T>(fn: (t: SessionSql) => Promise<T>) => h.tx((t) => fn(wrap(t))),
  });
  const root = wrap(inner);

  return {
    get rollbackFailed() {
      return rollbackFailed || inner.rollbackFailed;
    },
    all: root.all,
    run: root.run,
    exec: root.exec,
    async tx<T>(fn: (t: SessionSql) => Promise<T>): Promise<T> {
      await yieldNow();
      if (txFailures.count > 0) {
        txFailures = { ...txFailures, count: txFailures.count - 1 };
        throw txFailures.error;
      }
      try {
        return await root.tx(fn);
      } catch (error) {
        if (rollbackArmed) {
          rollbackArmed = false;
          rollbackFailed = true;
        }
        throw error;
      }
    },
    failNextTx(count: number, error: Error = new Error('injected transaction failure')) {
      txFailures = { count, error };
    },
    failNextRollback() {
      rollbackArmed = true;
    },
  };
}
