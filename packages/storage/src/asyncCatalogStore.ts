// Asynchronous catalog query layer over better-sqlite3 (async-catalog-adapter D2-D4; ADR 0021
// slice 3). One SQLite connection means an open transaction captures every statement issued on
// it, so each connection has one FIFO lock: a transaction holds it across its awaits and every
// root-handle statement waits for it. `tx` hands its body a handle scoped to the transaction;
// `tx` on that handle joins it. Any error inside a transaction fails the whole transaction (as
// in Postgres), and misuse rejects instead of deadlocking or leaking writes.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { CatalogDb } from '@autologger/ports';
import type { Database } from 'better-sqlite3';

/** The root handle used inside an open transaction, a handle used after its transaction ended,
 * a body that returned while a joined `tx` still ran, or a connection left inside a transaction
 * this adapter did not open. */
export class CatalogTxMisuseError extends Error {
  override name = 'CatalogTxMisuseError';
}

/** A transaction body ran past the adapter's deadline; the transaction was rolled back. */
export class CatalogTxTimeoutError extends Error {
  override name = 'CatalogTxTimeoutError';
}

/** A ROLLBACK failed and the connection is still inside the transaction; restart required. */
export class CatalogAdapterBrokenError extends Error {
  override name = 'CatalogAdapterBrokenError';
}

interface Connection {
  /** Settles when the last acquirer releases; never rejects. */
  tail: Promise<void>;
  broken: boolean;
  /** Called once when the connection is marked broken (async-catalog-stores D5). */
  onBroken?: () => void;
}

/** One lock per connection, shared by every adapter over it (design D2). */
const connections = new WeakMap<Database, Connection>();

interface TxState {
  open: boolean;
  failed: boolean;
  error: unknown;
  /** Joined `tx` bodies still running. */
  joined: number;
}

/** Carries the root transaction's state into its body's async context; used only to detect root
 * misuse (design D4). Handle validity lives on the handle's own state. */
const current = new AsyncLocalStorage<TxState>();

function fail(state: TxState, error: unknown): void {
  if (state.failed) return;
  state.failed = true;
  state.error = error;
}

/** Marks a promise the adapter hands out as handled, so one a body drops can't crash the
 * process; an awaiting caller still sees the rejection, and the transaction carries the error. */
function handled<T>(p: Promise<T>): Promise<T> {
  p.catch(() => {});
  return p;
}

const DEFAULT_TX_TIMEOUT_MS = 10_000;

export class AsyncSqliteCatalogDb implements CatalogDb {
  private readonly conn: Connection;
  private readonly txTimeoutMs: number;

  constructor(
    private readonly db: Database,
    opts: { txTimeoutMs?: number; onBroken?: () => void } = {},
  ) {
    let conn = connections.get(db);
    if (!conn) {
      conn = { tail: Promise.resolve(), broken: false };
      connections.set(db, conn);
    }
    if (opts.onBroken) conn.onBroken = opts.onBroken;
    this.conn = conn;
    this.txTimeoutMs = opts.txTimeoutMs ?? DEFAULT_TX_TIMEOUT_MS;
  }

  all<T = Record<string, unknown>>(sql: string, ...binds: unknown[]): Promise<T[]> {
    return this.root(() => this.db.prepare(sql).all(...binds) as T[]);
  }

  first<T = Record<string, unknown>>(sql: string, ...binds: unknown[]): Promise<T | null> {
    return this.root(() => (this.db.prepare(sql).get(...binds) as T | undefined) ?? null);
  }

  run(sql: string, ...binds: unknown[]): Promise<{ changes: number }> {
    return this.root(() => ({ changes: this.db.prepare(sql).run(...binds).changes }));
  }

  async tx<T>(fn: (t: CatalogDb) => Promise<T>): Promise<T> {
    this.guardRoot();
    const release = await this.acquire();
    try {
      this.checkConnection();
      return await this.transaction(fn);
    } finally {
      release();
    }
  }

  private async root<T>(work: () => T): Promise<T> {
    this.guardRoot();
    const release = await this.acquire();
    try {
      this.checkConnection();
      return work();
    } finally {
      release();
    }
  }

  /** Rejects root use from inside an open transaction (it would wait for its own lock) and from
   * work left over by a transaction that failed; work detached from a committed one may proceed. */
  private guardRoot(): void {
    const state = current.getStore();
    if (!state) return;
    if (state.open) {
      const err = new CatalogTxMisuseError(
        'catalog root handle used inside an open transaction; use the transaction handle',
      );
      fail(state, err);
      throw err;
    }
    if (state.failed) {
      throw new CatalogTxMisuseError('catalog call from a transaction that failed', {
        cause: state.error,
      });
    }
  }

  /** FIFO: each acquirer waits for its predecessor's release. */
  private acquire(): Promise<() => void> {
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const prev = this.conn.tail;
    this.conn.tail = prev.then(() => held);
    return prev.then(() => release);
  }

  /** Runs after the lock is held: before that, another adapter transaction legitimately has the
   * connection inside a transaction. */
  private checkConnection(): void {
    if (this.conn.broken) {
      throw new CatalogAdapterBrokenError(
        'catalog connection is stuck inside a transaction after a failed ROLLBACK',
      );
    }
    if (this.db.inTransaction) {
      throw new CatalogTxMisuseError(
        'catalog connection is inside a transaction this adapter did not open',
      );
    }
  }

  private async transaction<T>(fn: (t: CatalogDb) => Promise<T>): Promise<T> {
    const state: TxState = { open: true, failed: false, error: undefined, joined: 0 };
    let timer: NodeJS.Timeout | undefined;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const handle = new TxHandle(this.db, state);
      const body = current
        .run(state, async () => fn(handle))
        .then(
          (value) => ({ value }),
          (error: unknown) => {
            fail(state, error);
            return null;
          },
        );
      const deadline = new Promise<'timeout'>((res) => {
        timer = setTimeout(() => res('timeout'), this.txTimeoutMs);
        timer.unref();
      });
      // The end protocol runs once, on whichever settles first; a later body is ignored.
      const outcome = await Promise.race([body, deadline]);
      state.open = false;
      if (outcome === 'timeout') {
        fail(
          state,
          new CatalogTxTimeoutError(`catalog transaction exceeded ${this.txTimeoutMs} ms`),
        );
      } else if (state.joined > 0) {
        fail(
          state,
          new CatalogTxMisuseError(
            'transaction body returned while a joined tx() was still running',
          ),
        );
      }
      if (!state.failed) {
        try {
          this.db.exec('COMMIT');
        } catch (error) {
          fail(state, error);
        }
      }
      if (state.failed) {
        this.rollback();
        throw state.error;
      }
      return (outcome as { value: T }).value;
    } finally {
      state.open = false;
      clearTimeout(timer);
    }
  }

  /** Rolls back only a transaction SQLite still has open; if that fails, the connection is
   * marked broken so no later caller writes into it. Never replaces the transaction's error. */
  private rollback(): void {
    if (!this.db.inTransaction) return;
    try {
      this.db.exec('ROLLBACK');
    } catch {
      // checked below
    }
    if (this.db.inTransaction && !this.conn.broken) {
      this.conn.broken = true;
      const onBroken = this.conn.onBroken;
      // Deferred and contained: the failing call rejects with its own error first, and a
      // throwing callback can never reach this rollback path.
      if (onBroken) {
        setImmediate(() => {
          try {
            onBroken();
          } catch (error) {
            console.error('[catalog] onBroken callback failed', error);
          }
        });
      }
    }
  }
}

/** The handle a transaction body receives. Its statements run at call time: the transaction
 * already holds the lock. */
class TxHandle implements CatalogDb {
  constructor(
    private readonly db: Database,
    private readonly state: TxState,
  ) {}

  all<T = Record<string, unknown>>(sql: string, ...binds: unknown[]): Promise<T[]> {
    return this.statement(() => this.db.prepare(sql).all(...binds) as T[]);
  }

  first<T = Record<string, unknown>>(sql: string, ...binds: unknown[]): Promise<T | null> {
    return this.statement(() => (this.db.prepare(sql).get(...binds) as T | undefined) ?? null);
  }

  run(sql: string, ...binds: unknown[]): Promise<{ changes: number }> {
    return this.statement(() => ({ changes: this.db.prepare(sql).run(...binds).changes }));
  }

  /** Joins the enclosing transaction; its error fails the whole transaction. */
  tx<T>(fn: (t: CatalogDb) => Promise<T>): Promise<T> {
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
          const err = new CatalogTxMisuseError('the transaction was rolled back by SQLite');
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
      throw new CatalogTxMisuseError('transaction handle used after its transaction ended', {
        cause: this.state.error,
      });
    }
    if (this.state.failed) {
      throw new CatalogTxMisuseError('transaction already failed', { cause: this.state.error });
    }
  }
}
