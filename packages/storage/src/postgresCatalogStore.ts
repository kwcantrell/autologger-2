// Asynchronous catalog query layer over postgres.js (postgres-catalog-adapter design D1-D7; ADR 0021
// slice 4b). The catalog port's transaction contract, on a server that runs callers
// concurrently: root statements use an ordinary pool, and each transaction holds one of a fixed set
// of single-connection clients. postgres.js's own `reserve()` and `begin()` crash the process when a
// statement reaches a connection whose socket has closed (design A5-A7), so the adapter tracks each
// transaction's connection itself and never sends a statement after it was lost. Every transaction
// is SERIALIZABLE and re-runs its body on a serialization failure or deadlock, after a jittered
// backoff (catalog-retry-backoff), at most `maxTries` runs; one deadline bounds the whole call.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { CatalogDb } from '@autologger/ports';
import postgres from 'postgres';
import {
  CatalogAdapterBrokenError,
  CatalogTxMisuseError,
  CatalogTxTimeoutError,
} from './catalogErrors';

/** The COMMIT was sent but no reply arrived: the transaction may or may not have committed. Never
 * retried, and no ROLLBACK follows it (design D4). */
export class CatalogCommitUnknownError extends Error {
  override name = 'CatalogCommitUnknownError';
}

/** A root (non-transaction) statement missed the adapter's root deadline (catalog-concurrency-hazards
 * D10). If it was never sent it was withdrawn; if it was sent it may still apply, so the outcome
 * is unknown and it is never retried. `settled` resolves once it can no longer apply. */
export class CatalogRootTimeoutError extends Error {
  override name = 'CatalogRootTimeoutError';
  constructor(
    message: string,
    readonly settled: Promise<void>,
  ) {
    super(message);
  }
}

/** A bind held a string with U+0000, which Postgres text can't store; refused before sending
 * (catalog-on-postgres D5). The server maps it to 400. */
export class CatalogInvalidTextError extends Error {
  override name = 'CatalogInvalidTextError';
}

function checkText(binds: unknown[]): void {
  if (binds.some((b) => typeof b === 'string' && b.includes('\u0000'))) {
    throw new CatalogInvalidTextError('Text must not contain NUL characters.');
  }
}

/** The slice of a postgres.js client the adapter uses; `connect` is the seam tests replace. */
export interface PgResult extends Array<Record<string, unknown>> {
  count: number;
  command: string;
}
export interface PgQuery extends Promise<PgResult> {
  /** Set by postgres.js once the query is handed to a connection (sent); null while queued. */
  state?: unknown;
  /** Sends a cancel request; postgres.js returns null, so nothing can be awaited (design A4). */
  cancel(): unknown;
}
export interface PgClient {
  unsafe(text: string, binds?: unknown[], opts?: { prepare: boolean }): PgQuery;
  end(opts?: { timeout?: number }): Promise<void>;
}
export interface PgClientOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  max: number;
  /** Queries a connection may have in flight at once; the root pool uses 1 (design D10). */
  max_pipeline?: number;
  onclose?: (connId: number) => void;
}

export interface PostgresCatalogDbOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  /** Root (autocommit) pool size. */
  rootMax?: number;
  /** Concurrent transactions; with `rootMax`, 8 of the app role's 20 connections. */
  txSlots?: number;
  txTimeoutMs?: number;
  /** Client-side bound on a root statement, queueing included (default 5 000). */
  rootTimeoutMs?: number;
  maxTries?: number;
  connect?: (opts: PgClientOptions) => PgClient;
  /** Backoff randomness and wait, for tests (catalog-retry-backoff D3). */
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** An unref'd timer: a backoff wait never keeps the process alive. */
const unrefSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

/** Full-jitter backoff before re-running after run `n`: below 20 x 2^(n-1) ms. */
const BACKOFF_BASE_MS = 20;

function connectPostgres(opts: PgClientOptions): PgClient {
  return postgres({
    ...opts,
    types: { bigint: { to: 20, from: [20], parse: Number, serialize: String } },
    onnotice: () => {},
    // postgres.js never closes a connection on its own, so a close is always a real loss.
    max_lifetime: null,
    idle_timeout: 0,
    connect_timeout: 5,
    // The server ends a backend whose client went away even while it runs a statement (A10).
    connection: { client_connection_check_interval: '1s' },
  }) as unknown as PgClient;
}

const GRACE_MS = 1000;
const ROOT_EXPIRED = Symbol('root-expired');
const RETRYABLE = new Set(['40001', '40P01']);

const pgText = new Map<string, string>();

/** `?` placeholders to `$1…$n`, skipping quoted literals and identifiers and `--` comments. A
 * doubled quote inside a literal simply closes and reopens it, so it needs no special case. */
export function toPg(sql: string): string {
  const hit = pgText.get(sql);
  if (hit !== undefined) return hit;
  let out = '';
  let n = 0;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    let stop = -1;
    if (ch === "'" || ch === '"') {
      const close = sql.indexOf(ch, i + 1);
      stop = close === -1 ? sql.length : close + 1;
    } else if (ch === '-' && sql[i + 1] === '-') {
      const eol = sql.indexOf('\n', i);
      stop = eol === -1 ? sql.length : eol;
    }
    if (stop !== -1) {
      out += sql.slice(i, stop);
      i = stop - 1;
    } else {
      out += ch === '?' ? `$${++n}` : ch;
    }
  }
  pgText.set(sql, out);
  return out;
}

interface Slot {
  client: PgClient;
  holder: Attempt | null;
}

/** One transaction run's state on a real connection (design D4). */
interface Attempt {
  open: boolean;
  failed: boolean;
  error: unknown;
  joined: number;
  slot: Slot;
  /** The connection closed under the attempt; nothing more may be sent on it. */
  lost: boolean;
  /** Statements go out one at a time, so none can reach a reconnected socket (design D4). */
  chain: Promise<void>;
  inFlight: PgQuery | null;
  /** A cancel was sent; it could land on the connection's next statement (design A4). */
  cancelled: boolean;
}

const current = new AsyncLocalStorage<Attempt>();

function fail(a: Attempt, error: unknown): void {
  if (a.failed) return;
  a.failed = true;
  a.error = error;
}

function handled<T>(p: Promise<T>): Promise<T> {
  p.catch(() => {});
  return p;
}

class BoundExpired extends Error {}

/** Races a server call against a time bound; the call's own late rejection is absorbed. */
function bounded<T>(p: Promise<T>, ms: number): Promise<T> {
  p.catch(() => {});
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new BoundExpired('server call exceeded its bound')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function drain(a: Attempt): Promise<void> {
  let tail: Promise<void>;
  do {
    tail = a.chain;
    await tail;
  } while (tail !== a.chain);
}

function checkUsable(a: Attempt): void {
  if (!a.open) {
    throw new CatalogTxMisuseError('transaction handle used after its transaction ended', {
      cause: a.error,
    });
  }
  if (a.failed) {
    throw new CatalogTxMisuseError('transaction already failed', { cause: a.error });
  }
}

const closedError = () => new CatalogAdapterBrokenError('catalog adapter is closed');

export class PostgresCatalogDb implements CatalogDb {
  private readonly root: PgClient;
  private readonly slots: Slot[] = [];
  private readonly free: Slot[] = [];
  private readonly waiters: { grant(slot: Slot): void; reject(error: Error): void }[] = [];
  private readonly retired = new WeakSet<PgClient>();
  private readonly ending = new Set<Promise<void>>();
  private readonly running = new Set<Promise<unknown>>();
  private readonly connect: (opts: PgClientOptions) => PgClient;
  private readonly conn: Omit<PgClientOptions, 'max' | 'onclose'>;
  private readonly txTimeoutMs: number;
  private readonly rootTimeoutMs: number;
  private readonly maxTries: number;
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private closed = false;

  constructor(opts: PostgresCatalogDbOptions) {
    const {
      rootMax = 3,
      txSlots = 5,
      txTimeoutMs = 10_000,
      rootTimeoutMs = 5_000,
      maxTries = 5,
      connect,
      random = Math.random,
      sleep = unrefSleep,
      ...conn
    } = opts;
    this.random = random;
    this.sleep = sleep;
    this.rootTimeoutMs = rootTimeoutMs;
    this.connect = connect ?? connectPostgres;
    this.conn = conn;
    this.txTimeoutMs = txTimeoutMs;
    this.maxTries = maxTries;
    // One statement per root connection, so a query still queued can be withdrawn at its deadline
    // instead of riding behind a stalled statement (design D10).
    this.root = this.connect({ ...conn, max: rootMax, max_pipeline: 1 });
    for (let i = 0; i < txSlots; i++) {
      const slot: Slot = { client: this.root, holder: null };
      slot.client = this.slotClient(slot);
      this.slots.push(slot);
      this.free.push(slot);
    }
  }

  all<T = Record<string, unknown>>(sql: string, ...binds: unknown[]): Promise<T[]> {
    return this.rootQuery(sql, binds, (r) => [...r] as T[]);
  }

  first<T = Record<string, unknown>>(sql: string, ...binds: unknown[]): Promise<T | null> {
    return this.rootQuery(sql, binds, (r) => (r[0] as T | undefined) ?? null);
  }

  run(sql: string, ...binds: unknown[]): Promise<{ changes: number }> {
    return this.rootQuery(sql, binds, (r) => ({ changes: r.count }));
  }

  async tx<T>(fn: (t: CatalogDb) => Promise<T>): Promise<T> {
    this.guardRoot();
    if (this.closed) throw closedError();
    const deadlineAt = Date.now() + this.txTimeoutMs;
    const run = (async () => {
      for (let n = 1; ; n++) {
        try {
          return await this.attempt(fn, deadlineAt);
        } catch (error) {
          const code = (error as { code?: unknown } | null)?.code;
          if (n >= this.maxTries || this.closed || !RETRYABLE.has(code as string)) throw error;
          // catalog-retry-backoff D1/D2: contenders back off instead of re-running in lockstep.
          // attempt() has already released its slot, so the wait holds no connection.
          const left = deadlineAt - Date.now();
          if (left > 0) {
            await this.sleep(Math.min(this.random() * BACKOFF_BASE_MS * 2 ** (n - 1), left));
          }
          if (this.closed) throw error;
          // A re-run past the deadline would still take a slot and send BEGIN; refuse it here.
          if (Date.now() >= deadlineAt) {
            throw new CatalogTxTimeoutError(`catalog transaction exceeded ${this.txTimeoutMs} ms`);
          }
        }
      }
    })();
    this.running.add(run);
    try {
      return await run;
    } finally {
      this.running.delete(run);
    }
  }

  /** Rejects waiting and new calls, lets running transactions settle on their own bounds, then
   * ends every connection (design D7). */
  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      for (const w of this.waiters.splice(0)) w.reject(closedError());
    }
    await Promise.allSettled([...this.running]);
    for (const slot of this.slots) {
      if (!this.retired.has(slot.client)) this.retire(slot.client);
    }
    if (!this.retired.has(this.root)) {
      this.retired.add(this.root);
      this.ending.add(this.root.end({ timeout: 5 }).catch(() => {}));
    }
    await Promise.all([...this.ending]);
  }

  private async rootQuery<T>(sql: string, binds: unknown[], map: (r: PgResult) => T): Promise<T> {
    this.guardRoot();
    if (this.closed) throw closedError();
    checkText(binds);
    const q = this.root.unsafe(toPg(sql), binds, { prepare: true });
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<typeof ROOT_EXPIRED>((r) => {
      timer = setTimeout(() => r(ROOT_EXPIRED), this.rootTimeoutMs);
    });
    let res: PgResult | typeof ROOT_EXPIRED;
    try {
      res = await Promise.race([q, expired]);
    } finally {
      clearTimeout(timer);
    }
    if (res !== ROOT_EXPIRED) return map(res);
    // Not sent yet: withdraw it (postgres.js only dequeues; nothing reaches the server). Sent: never
    // cancel, since a late cancel could hit the next statement on the pooled connection (A4).
    if (q.state === null || q.state === undefined) {
      try {
        q.cancel();
      } catch {}
      q.catch(() => {});
      throw new CatalogRootTimeoutError(
        'catalog statement timed out before it was sent',
        Promise.resolve(),
      );
    }
    throw new CatalogRootTimeoutError(
      'catalog statement timed out; it may still apply',
      q.then(
        () => {},
        () => {},
      ),
    );
  }

  /** The transaction contract: the root handle inside an open transaction would escape it, and
   * work left over from a failed transaction must not run (design D4). */
  private guardRoot(): void {
    const a = current.getStore();
    if (!a) return;
    if (a.open) {
      const err = new CatalogTxMisuseError(
        'catalog root handle used inside an open transaction; use the transaction handle',
      );
      fail(a, err);
      throw err;
    }
    if (a.failed) {
      throw new CatalogTxMisuseError('catalog call from a transaction that failed', {
        cause: a.error,
      });
    }
  }

  private async attempt<T>(fn: (t: CatalogDb) => Promise<T>, deadlineAt: number): Promise<T> {
    const slot = await this.acquire(deadlineAt);
    const a: Attempt = {
      open: true,
      failed: false,
      error: undefined,
      joined: 0,
      slot,
      lost: false,
      chain: Promise.resolve(),
      inFlight: null,
      cancelled: false,
    };
    slot.holder = a;
    let timer: NodeJS.Timeout | undefined;
    let confirmed = false; // the server confirmed the transaction ended
    try {
      try {
        await bounded(
          slot.client.unsafe('BEGIN ISOLATION LEVEL SERIALIZABLE'),
          deadlineAt - Date.now(),
        );
      } catch (error) {
        if (!(error instanceof BoundExpired)) throw error;
        throw new CatalogTxTimeoutError(`catalog transaction exceeded ${this.txTimeoutMs} ms`);
      }
      const settle = () => {
        a.open = false;
        if (a.joined > 0) {
          fail(
            a,
            new CatalogTxMisuseError(
              'transaction body returned while a joined tx() was still running',
            ),
          );
        }
      };
      const body = current
        .run(a, async () => fn(new TxHandle(a)))
        .then(
          async (value) => {
            settle();
            // A statement the body started without awaiting still decides the outcome (A11).
            await drain(a);
            return { value };
          },
          (error: unknown) => {
            fail(a, error);
            settle();
            return null;
          },
        );
      const deadline = new Promise<'timeout'>((res) => {
        timer = setTimeout(() => res('timeout'), Math.max(0, deadlineAt - Date.now()));
      });
      const outcome = await Promise.race([body, deadline]);
      a.open = false;
      if (outcome === 'timeout') {
        fail(a, new CatalogTxTimeoutError(`catalog transaction exceeded ${this.txTimeoutMs} ms`));
        if (a.inFlight) {
          a.cancelled = true;
          try {
            a.inFlight.cancel();
          } catch {
            // best effort; the connection is retired either way
          }
        }
      }
      if (!a.failed) {
        let reply: PgResult;
        try {
          reply = await bounded(slot.client.unsafe('COMMIT'), deadlineAt - Date.now() + GRACE_MS);
        } catch (error) {
          if (!(error instanceof postgres.PostgresError)) {
            throw new CatalogCommitUnknownError('catalog COMMIT sent, outcome unknown', {
              cause: error,
            });
          }
          confirmed = true; // a failed COMMIT ends the transaction on the server
          fail(a, error);
          throw a.error;
        }
        confirmed = true;
        if (reply.command !== 'COMMIT') {
          fail(a, new CatalogTxMisuseError(`COMMIT was answered with ${reply.command}`));
          throw a.error;
        }
        return (outcome as { value: T }).value;
      }
      if (!a.lost && !a.cancelled) {
        try {
          await bounded(slot.client.unsafe('ROLLBACK'), GRACE_MS);
          confirmed = true;
        } catch {
          // unconfirmed: the connection is retired below
        }
      }
      throw a.error;
    } finally {
      a.open = false;
      clearTimeout(timer);
      slot.holder = null;
      if (confirmed && !a.lost && !a.cancelled) this.release(slot);
      else this.recycle(slot);
    }
  }

  /** FIFO; a waiter whose deadline passes leaves the queue, so no slot is granted to it. */
  private acquire(deadlineAt: number): Promise<Slot> {
    if (this.closed) return Promise.reject(closedError());
    const slot = this.free.shift();
    if (slot) return Promise.resolve(slot);
    return new Promise<Slot>((resolve, reject) => {
      const waiter = {
        grant(s: Slot) {
          clearTimeout(timer);
          resolve(s);
        },
        reject(error: Error) {
          clearTimeout(timer);
          reject(error);
        },
      };
      const timer = setTimeout(
        () => {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          reject(
            new CatalogTxTimeoutError('catalog transaction timed out waiting for a connection'),
          );
        },
        Math.max(0, deadlineAt - Date.now()),
      );
      this.waiters.push(waiter);
    });
  }

  private release(slot: Slot): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter.grant(slot);
    else this.free.push(slot);
  }

  /** Never hands out a connection whose transaction may still be open: ends it (the server rolls
   * back) and puts a fresh client in the slot. */
  private recycle(slot: Slot): void {
    this.retire(slot.client);
    if (this.closed) return;
    slot.client = this.slotClient(slot);
    this.release(slot);
  }

  private retire(client: PgClient): void {
    this.retired.add(client);
    const ended = client.end({ timeout: 0 }).catch(() => {});
    this.ending.add(ended);
    void ended.then(() => this.ending.delete(ended));
  }

  /** `onclose` acts only for the slot's current client and a close the adapter didn't start: it
   * also fires, late, for the adapter's own `end()` (design A9). */
  private slotClient(slot: Slot): PgClient {
    const client: PgClient = this.connect({
      ...this.conn,
      max: 1,
      onclose: () => {
        if (this.retired.has(client) || slot.client !== client) return;
        const a = slot.holder;
        if (a && !a.lost) {
          a.lost = true;
          fail(
            a,
            Object.assign(new Error('catalog transaction connection lost'), {
              code: 'CONNECTION_CLOSED',
            }),
          );
        }
      },
    });
    return client;
  }
}

/** The handle a transaction body receives (design D4). */
class TxHandle implements CatalogDb {
  constructor(private readonly a: Attempt) {}

  all<T = Record<string, unknown>>(sql: string, ...binds: unknown[]): Promise<T[]> {
    return this.statement(sql, binds, (r) => [...r] as T[]);
  }

  first<T = Record<string, unknown>>(sql: string, ...binds: unknown[]): Promise<T | null> {
    return this.statement(sql, binds, (r) => (r[0] as T | undefined) ?? null);
  }

  run(sql: string, ...binds: unknown[]): Promise<{ changes: number }> {
    return this.statement(sql, binds, (r) => ({ changes: r.count }));
  }

  /** Joins the enclosing transaction; its error fails the whole transaction. */
  tx<T>(fn: (t: CatalogDb) => Promise<T>): Promise<T> {
    const a = this.a;
    return handled(
      (async () => {
        checkUsable(a);
        a.joined++;
        try {
          return await fn(this);
        } catch (error) {
          fail(a, error);
          throw error;
        } finally {
          a.joined--;
        }
      })(),
    );
  }

  /** Checked at call time, queued behind the attempt's earlier statements, and refused once the
   * attempt failed or lost its connection. */
  private statement<T>(sql: string, binds: unknown[], map: (r: PgResult) => T): Promise<T> {
    const a = this.a;
    return handled(
      (async () => {
        checkUsable(a);
        try {
          checkText(binds);
        } catch (error) {
          fail(a, error);
          throw error;
        }
        const prev = a.chain;
        let done!: () => void;
        a.chain = new Promise<void>((r) => {
          done = r;
        });
        try {
          await prev;
          if (a.failed) {
            throw new CatalogTxMisuseError('transaction already failed', { cause: a.error });
          }
          const query = a.slot.client.unsafe(toPg(sql), binds, { prepare: true });
          a.inFlight = query;
          try {
            return map(await query);
          } catch (error) {
            // Anything but a server reply means the connection can't be trusted (A8).
            if (!(error instanceof postgres.PostgresError)) a.lost = true;
            fail(a, error);
            throw error;
          } finally {
            if (a.inFlight === query) a.inFlight = null;
          }
        } finally {
          done();
        }
      })(),
    );
  }
}
