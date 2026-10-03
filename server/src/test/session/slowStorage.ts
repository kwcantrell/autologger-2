// A test SessionStorage that yields to a timer before every statement (session-tables D12, after
// async-session-hub D12's slowSql), so hub calls on it really overlap, and that can hold or fail a
// call: hooks run before each transaction, snapshot or statement, and a transaction can be failed
// before its body runs or after its body returned (before COMMIT, so the adapter rolls it back and,
// for a `40P01`, runs the body again). It wraps the real Postgres session storage, so the
// transaction contract is the production one. Test infrastructure.

import type {
  Row,
  SessionSql,
  SessionStorage,
  SqlValue,
} from '@autologger/session-core/sessionCore';

export interface SlowStorageHooks {
  /** Before the `n`th transaction (from 1), outside the adapter's transaction. */
  beforeTx?(n: number): Promise<void> | void;
  /** Before the `n`th snapshot (from 1), outside the adapter's snapshot. */
  beforeSnapshot?(n: number): Promise<void> | void;
  /** Before every statement, inside its transaction or snapshot. */
  beforeStatement?(sql: string): Promise<void> | void;
}

export interface SlowStorage extends SessionStorage {
  readonly hooks: SlowStorageHooks;
  /** The next `count` transactions reject with `error` before their body runs. */
  failNextTx(count: number, error?: Error): void;
  /** The next `count` transaction runs fail with `error` after their body returned. */
  failAfterBody(count: number, error?: Error): void;
}

/** `delayMs` 0 yields a microtask instead of a timer. */
export function slowStorage(
  inner: SessionStorage,
  opts: { delayMs?: number; hooks?: SlowStorageHooks } = {},
): SlowStorage {
  const delayMs = opts.delayMs ?? 1;
  const hooks: SlowStorageHooks = opts.hooks ?? {};
  const yieldNow = (): Promise<void> =>
    delayMs > 0 ? new Promise((resolve) => setTimeout(resolve, delayMs)) : Promise.resolve();
  let before: { count: number; error: Error } = { count: 0, error: new Error('injected') };
  let after: { count: number; error: Error } = { count: 0, error: new Error('injected') };
  let txs = 0;
  let snapshots = 0;

  const statement = async (sql: string): Promise<void> => {
    await yieldNow();
    await hooks.beforeStatement?.(sql);
  };
  const wrap = (h: SessionSql): SessionSql => {
    const w: SessionSql = {
      all: async <T = Row>(sql: string, ...binds: SqlValue[]): Promise<T[]> => {
        await statement(sql);
        return h.all<T>(sql, ...binds);
      },
      run: async (sql: string, ...binds: SqlValue[]) => {
        await statement(sql);
        return h.run(sql, ...binds);
      },
      tx: <T>(fn: (t: SessionSql) => Promise<T>) => h.tx(() => fn(w)),
    };
    return w;
  };

  return {
    hooks,
    async tx<T>(fn: (t: SessionSql) => Promise<T>): Promise<T> {
      await yieldNow();
      await hooks.beforeTx?.(++txs);
      if (before.count > 0) {
        before = { ...before, count: before.count - 1 };
        throw before.error;
      }
      return inner.tx(async (t) => {
        const value = await fn(wrap(t));
        if (after.count > 0) {
          after = { ...after, count: after.count - 1 };
          throw after.error;
        }
        return value;
      });
    },
    async snapshot<T>(fn: (t: SessionSql) => Promise<T>): Promise<T> {
      await yieldNow();
      await hooks.beforeSnapshot?.(++snapshots);
      return inner.snapshot((t) => fn(wrap(t)));
    },
    failNextTx(count: number, error: Error = new Error('injected transaction failure')) {
      before = { count, error };
    },
    failAfterBody(count: number, error: Error = new Error('injected failure after the body')) {
      after = { count, error };
    },
  };
}

/** An error the adapter treats as a deadlock (`40P01`) and retries. */
export function deadlock(): Error {
  return Object.assign(new Error('injected deadlock'), { code: '40P01' });
}
