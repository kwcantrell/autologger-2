// Asynchronous catalog query layer over postgres.js (postgres-catalog-adapter design D1-D7; ADR 0021
// slice 4b). The catalog port's transaction contract, on a server that runs callers
// concurrently: each transaction holds one of a fixed set of single-connection clients, and each
// statement outside a transaction runs as a short READ COMMITTED transaction on one of a separate
// set of single-connection root clients (catalog-roles design D5). postgres.js's own `reserve()` and
// `begin()` crash the process when a statement reaches a connection whose socket has closed, and
// `release()` hands back a connection still inside a transaction (design A5-A7; catalog-roles A23),
// so the adapter never uses them: it tracks each client's connection itself, never sends a
// statement after it was lost, and hands a client to the next caller only after a confirmed COMMIT
// or ROLLBACK. Every transaction is SERIALIZABLE and re-runs its body on a serialization failure or
// deadlock, after a jittered backoff (catalog-retry-backoff), at most `maxTries` runs; one deadline
// bounds the whole call.
//
// Bindings (catalog-roles D4, ADR 0021 slice 6b-1): `bindUser(id)` and `bindSystem(reason)` hand
// out handles whose every transaction, and every run of it after a retry, starts with
// `set_config('role', …, true), set_config('app.user_id', …, true)`, pipelined with BEGIN (and at
// the root with the statement and COMMIT), so a binding adds no round trip. Nothing sets a role or
// setting beyond one transaction (design D6).
//
// Session storage (session-tables D2, ADR 0021 slice 7b-1): a bound handle also runs session write
// transactions (`sessionTx`: READ COMMITTED, the session's `catalog.sessions` row locked with
// BEGIN and the preamble, retried on deadlock only) and read snapshots (`snapshot`: REPEATABLE READ
// READ ONLY, never retried), on a third set of slots, the session slots, so session work never
// holds a connection the catalog needs. The deadline, statement rules and connection handling are
// the catalog transaction's.
//
// Session content policies (session-content-policies D4, ADR 0021 slice 7b-2): a session call binds
// its caller, so a user-bound session transaction's row lock and a user-bound snapshot run under the
// content policies. A refused lock (no row) asks `catalog.session_exists` on the same connection,
// inside the transaction, to tell no access (`SessionAccessDeniedError`) from no session
// (`SessionNotFoundError`); a user snapshot pipelines one probe with BEGIN and the preamble, which
// answers both. Either refusal rejects before the body runs and is never retried; system calls are
// unchanged.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { CatalogDb, CatalogRoot } from '@autologger/ports';
import postgres from 'postgres';
import {
  CatalogAdapterBrokenError,
  CatalogForbiddenError,
  CatalogTxMisuseError,
  CatalogTxTimeoutError,
  SessionAccessDeniedError,
  SessionNotFoundError,
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
  onclose?: (connId: number) => void;
}

export interface PostgresCatalogDbOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  /** Root connections: each carries one short root transaction at a time (catalog-roles D5). */
  rootMax?: number;
  /** Concurrent transactions; with `rootMax`, 8 of the app role's 20 connections. */
  txSlots?: number;
  /** Concurrent session transactions and snapshots (session-tables D2); opened on first use. */
  sessionSlots?: number;
  txTimeoutMs?: number;
  /** Client-side bound on a root statement, queueing included (default 5 000). */
  rootTimeoutMs?: number;
  /** After a root call timed out, how long the adapter waits for its replies before it retires the
   * client: the role's statement and idle-in-transaction timeouts plus a grace (default 46 000). */
  rootSettleMs?: number;
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

/** The adapter's default `connect`: one postgres.js client per slot. */
export function connectPostgres(opts: PgClientOptions): PgClient {
  return postgres({
    ...opts,
    types: { bigint: { to: 20, from: [20], parse: Number, serialize: String } },
    onnotice: () => {},
    // postgres.js never closes a connection on its own, so a close is always a real loss.
    max_lifetime: null,
    idle_timeout: 0,
    connect_timeout: 5,
    // The server ends a backend whose client went away even while it runs a statement (A10).
    // The image sets extra_float_digits = 0; 1 reads a double precision back exactly
    // (session-tables A10).
    connection: { client_connection_check_interval: '1s', extra_float_digits: 1 },
  }) as unknown as PgClient;
}

const GRACE_MS = 1000;
/** What a transaction run is: a catalog transaction, a session write transaction holding the
 * session's row lock, or a read-only snapshot (session-tables D2). */
type TxMode =
  | { kind: 'catalog' }
  | { kind: 'session'; sessionId: string }
  | { kind: 'snapshot'; sessionId: string };
const CATALOG: TxMode = { kind: 'catalog' };

const RETRYABLE: Record<TxMode['kind'], ReadonlySet<string>> = {
  catalog: new Set(['40001', '40P01']),
  // READ COMMITTED cannot fail serialization; a read-only snapshot takes no row locks.
  session: new Set(['40P01']),
  snapshot: new Set(),
};

const BEGIN: Record<TxMode['kind'], string> = {
  catalog: 'BEGIN ISOLATION LEVEL SERIALIZABLE',
  session: 'BEGIN ISOLATION LEVEL READ COMMITTED',
  snapshot: 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
};

const LOCK_SESSION = 'select 1 as locked from sessions where id = $1 for update';
/** After a user-bound lock found no row: whether the session exists at all (session-content-policies
 * D4); sent on the refusal path only. */
const SESSION_EXISTS = 'select catalog.session_exists($1) as e';
/** A user-bound snapshot's read check, pipelined with BEGIN and the preamble: `ok` when the session's
 * show is accessible, and `e` whether the session exists (a read-only snapshot cannot lock, A3). */
const SNAPSHOT_PROBE =
  'select exists (select 1 from sessions s where s.id = $1 and s.show_id in ' +
  '(select catalog.accessible_shows(catalog.app_user_id()))) as ok, catalog.session_exists($1) as e';

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

/** Who a handle's statements run for (catalog-roles D4). */
type Binding = { kind: 'user'; userId: string } | { kind: 'system'; reason: string };

const PREAMBLE = "select set_config('role', $1, true), set_config('app.user_id', $2, true)";
const REASON = /^[a-z][a-z0-9-]*$/;

/** The role comes from the binding's kind, never from caller text. */
function preambleBinds(b: Binding): string[] {
  return b.kind === 'user' ? ['catalog_user', b.userId] : ['catalog_system', ''];
}

/** What a forbidden error names: the kind and reason, never the user id (design D8). */
function bindingLabel(b: Binding): string {
  return b.kind === 'user' ? 'user' : `system:${b.reason}`;
}

function mapForbidden(error: unknown, label: string): unknown {
  if (error instanceof postgres.PostgresError && error.code === '42501') {
    return new CatalogForbiddenError(label, error);
  }
  return error;
}

const connectionLost = (what: string) =>
  Object.assign(new Error(`catalog ${what} connection lost`), { code: 'CONNECTION_CLOSED' });

interface Waiter {
  grant(slot: Slot): void;
  reject(error: Error): void;
}

/** A set of single-connection clients with a FIFO wait queue: the transaction slots, or the root
 * slots (catalog-roles D5), so neither kind of call queues behind the other. */
interface Pool {
  slots: Slot[];
  free: Slot[];
  waiters: Waiter[];
  /** The error a waiter whose deadline passed in the queue rejects with. */
  expired(): Error;
}

interface Slot {
  client: PgClient;
  pool: Pool;
  holder: Attempt | null;
  /** Set while a root call holds the slot: its client's connection closed under it. */
  onLost: (() => void) | null;
}

/** One transaction run's state on a real connection (design D4). */
interface Attempt {
  open: boolean;
  failed: boolean;
  error: unknown;
  joined: number;
  slot: Slot;
  /** Who the transaction runs for, as a forbidden error names it. */
  label: string;
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

type RootOutcome =
  | { ok: true; value: PgResult; confirmed: true }
  | { ok: false; error: unknown; confirmed: boolean };

/** Reads a short root transaction's replies (BEGIN, preamble, statement, COMMIT). The client is
 * reused only when the server confirmed the end: a COMMIT answered COMMIT, or ROLLBACK after an
 * earlier error. A failed COMMIT, a failed BEGIN or anything but a server reply retires it
 * (catalog-roles D5, D6). */
function rootOutcome(results: PromiseSettledResult<PgResult>[]): RootOutcome {
  const untrusted = results.find(
    (r) => r.status === 'rejected' && !(r.reason instanceof postgres.PostgresError),
  );
  if (untrusted?.status === 'rejected')
    return { ok: false, error: untrusted.reason, confirmed: false };
  const begin = results[0];
  const stmt = results[results.length - 2];
  const commit = results[results.length - 1];
  if (begin?.status === 'rejected') return { ok: false, error: begin.reason, confirmed: false };
  const earlier = results.slice(0, -1).find((r) => r.status === 'rejected');
  const earlierError = earlier?.status === 'rejected' ? earlier.reason : undefined;
  if (commit?.status !== 'fulfilled') {
    return {
      ok: false,
      error: earlierError ?? (commit as PromiseRejectedResult | undefined)?.reason,
      confirmed: false,
    };
  }
  const command = commit.value.command;
  if (command === 'COMMIT' && earlier === undefined && stmt?.status === 'fulfilled') {
    return { ok: true, value: stmt.value, confirmed: true };
  }
  if (command === 'ROLLBACK') {
    return {
      ok: false,
      error: earlierError ?? new CatalogTxMisuseError('COMMIT was answered with ROLLBACK'),
      confirmed: true,
    };
  }
  return {
    ok: false,
    error: earlierError ?? new CatalogTxMisuseError(`COMMIT was answered with ${command}`),
    confirmed: false,
  };
}

/** What a bound handle calls on its adapter. */
interface HandleOps {
  root<T>(b: Binding, sql: string, binds: unknown[], map: (r: PgResult) => T): Promise<T>;
  tx<T>(fn: (t: CatalogDb) => Promise<T>, b: Binding, mode: TxMode): Promise<T>;
}

/** The adapter is a `CatalogRoot` only: it has no statement or transaction method of its own, so an
 * unbound statement cannot be written against it (catalog-roles D4, task 6.1). */
export class PostgresCatalogDb implements CatalogRoot {
  private readonly txPool: Pool;
  private readonly rootPool: Pool;
  private sessionPoolOrNull: Pool | null = null;
  private readonly sessionSlots: number;
  private readonly retired = new WeakSet<PgClient>();
  private readonly ending = new Set<Promise<void>>();
  private readonly running = new Set<Promise<unknown>>();
  private readonly connect: (opts: PgClientOptions) => PgClient;
  private readonly conn: Omit<PgClientOptions, 'max' | 'onclose'>;
  private readonly txTimeoutMs: number;
  private readonly rootTimeoutMs: number;
  private readonly rootSettleMs: number;
  private readonly maxTries: number;
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly ops: HandleOps;
  private closed = false;

  constructor(opts: PostgresCatalogDbOptions) {
    const {
      rootMax = 3,
      txSlots = 5,
      sessionSlots = 4,
      txTimeoutMs = 10_000,
      rootTimeoutMs = 5_000,
      rootSettleMs = 30_000 + 15_000 + GRACE_MS,
      maxTries = 5,
      connect,
      random = Math.random,
      sleep = unrefSleep,
      ...conn
    } = opts;
    this.random = random;
    this.sleep = sleep;
    this.rootTimeoutMs = rootTimeoutMs;
    this.rootSettleMs = rootSettleMs;
    this.connect = connect ?? connectPostgres;
    this.conn = conn;
    this.txTimeoutMs = txTimeoutMs;
    this.maxTries = maxTries;
    this.sessionSlots = sessionSlots;
    this.ops = {
      root: (b, sql, binds, map) => this.rootQuery(b, sql, binds, map),
      tx: (fn, b, mode) => this.runTx(fn, b, mode),
    };
    // Root slots first, then transaction slots; each is a `max: 1` client (catalog-roles D5).
    this.rootPool = this.pool(
      rootMax,
      () =>
        new CatalogRootTimeoutError(
          'catalog statement timed out before it was sent',
          Promise.resolve(),
        ),
    );
    this.txPool = this.pool(
      txSlots,
      () => new CatalogTxTimeoutError('catalog transaction timed out waiting for a connection'),
    );
  }

  /** A handle whose statements run as `catalog_user` with this user's id (catalog-roles D4); it also
   * runs session transactions and snapshots under the content policies (session-content-policies
   * D4). */
  bindUser(userId: string): PostgresBoundHandle {
    if (typeof userId !== 'string' || userId === '') {
      throw new TypeError('bindUser needs a non-empty user id');
    }
    return new PostgresBoundHandle(this.ops, { kind: 'user', userId });
  }

  /** A handle whose statements run as `catalog_system` for the named task (catalog-roles D4); it
   * also runs session transactions and snapshots (session-tables D2). */
  bindSystem(reason: string): PostgresBoundHandle {
    if (typeof reason !== 'string' || !REASON.test(reason)) {
      throw new TypeError('bindSystem needs a reason matching [a-z][a-z0-9-]*');
    }
    return new PostgresBoundHandle(this.ops, { kind: 'system', reason });
  }

  /** Rejects waiting and new calls, lets running calls settle on their own bounds, then ends every
   * connection (design D7). */
  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      for (const pool of this.pools()) {
        for (const w of pool.waiters.splice(0)) w.reject(closedError());
      }
    }
    await Promise.allSettled([...this.running]);
    for (const slot of this.pools().flatMap((p) => p.slots)) {
      if (!this.retired.has(slot.client)) this.retire(slot.client);
    }
    await Promise.all([...this.ending]);
  }

  private pools(): Pool[] {
    return [this.rootPool, this.txPool, ...(this.sessionPoolOrNull ? [this.sessionPoolOrNull] : [])];
  }

  /** The session slots, opened on the first session call: a process that runs no session work
   * holds no session connection. */
  private get sessionPool(): Pool {
    this.sessionPoolOrNull ??= this.pool(
      this.sessionSlots,
      () => new CatalogTxTimeoutError('session transaction timed out waiting for a connection'),
    );
    return this.sessionPoolOrNull;
  }

  private pool(size: number, expired: () => Error): Pool {
    const pool: Pool = { slots: [], free: [], waiters: [], expired };
    for (let i = 0; i < size; i++) {
      const slot = { pool, holder: null, onLost: null } as unknown as Slot;
      slot.client = this.slotClient(slot);
      pool.slots.push(slot);
      pool.free.push(slot);
    }
    return pool;
  }

  private async runTx<T>(
    fn: (t: CatalogDb) => Promise<T>,
    binding: Binding,
    mode: TxMode,
  ): Promise<T> {
    this.guardRoot();
    if (this.closed) throw closedError();
    const deadlineAt = Date.now() + this.txTimeoutMs;
    const run = (async () => {
      for (let n = 1; ; n++) {
        try {
          return await this.attempt(fn, deadlineAt, binding, mode);
        } catch (error) {
          const code = (error as { code?: unknown } | null)?.code;
          if (n >= this.maxTries || this.closed || !RETRYABLE[mode.kind].has(code as string)) {
            throw error;
          }
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

  private async rootQuery<T>(
    binding: Binding,
    sql: string,
    binds: unknown[],
    map: (r: PgResult) => T,
  ): Promise<T> {
    this.guardRoot();
    if (this.closed) throw closedError();
    checkText(binds);
    const call = this.rootCall(binding, sql, binds, Date.now() + this.rootTimeoutMs);
    this.running.add(call);
    try {
      return map(await call);
    } finally {
      this.running.delete(call);
    }
  }

  /** One short root transaction (catalog-roles D5): take a root slot within the deadline (or
   * leave the queue, never sent), issue BEGIN, the preamble, the statement and COMMIT without
   * waiting in between, and resolve only once the COMMIT is confirmed. Past the deadline the
   * caller gets the may-still-apply timeout and the replies are awaited in the background; no
   * cancel and no retry. */
  private async rootCall(
    binding: Binding,
    sql: string,
    binds: unknown[],
    deadlineAt: number,
  ): Promise<PgResult> {
    const slot = await this.acquire(this.rootPool, deadlineAt);
    const client = slot.client;
    const qs: Promise<PgResult>[] = [
      handled(client.unsafe('BEGIN ISOLATION LEVEL READ COMMITTED')),
    ];
    qs.push(handled(client.unsafe(PREAMBLE, preambleBinds(binding), { prepare: true })));
    qs.push(handled(client.unsafe(toPg(sql), binds, { prepare: true })));
    qs.push(handled(client.unsafe('COMMIT')));
    let markLost!: () => void;
    const lost = new Promise<'lost'>((r) => {
      markLost = () => r('lost');
    });
    slot.onLost = markLost;
    const replies = Promise.allSettled(qs);
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<'expired'>((r) => {
      timer = setTimeout(() => r('expired'), Math.max(0, deadlineAt - Date.now()));
    });
    const first = await Promise.race([replies, lost, expired]).finally(() => clearTimeout(timer));
    if (first === 'lost') {
      this.endRoot(slot, false);
      throw connectionLost('root');
    }
    if (first === 'expired') {
      throw new CatalogRootTimeoutError(
        'catalog statement timed out; it may still apply',
        this.settleRoot(slot, replies, lost),
      );
    }
    const outcome = rootOutcome(first);
    this.endRoot(slot, outcome.confirmed);
    if (outcome.ok) return outcome.value;
    throw mapForbidden(outcome.error, bindingLabel(binding));
  }

  /** After a root timeout: wait for the replies, bounded by the role's timeouts plus a grace, then
   * release the slot on a confirmed end or retire the client. Resolves once either happened. */
  private async settleRoot(
    slot: Slot,
    replies: Promise<PromiseSettledResult<PgResult>[]>,
    lost: Promise<'lost'>,
  ): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<'bound'>((r) => {
      timer = setTimeout(() => r('bound'), this.rootSettleMs);
      timer.unref();
    });
    const end = await Promise.race([replies, lost, bound]).finally(() => clearTimeout(timer));
    this.endRoot(slot, typeof end === 'object' && rootOutcome(end).confirmed);
  }

  private endRoot(slot: Slot, confirmed: boolean): void {
    if (slot.onLost === null) return;
    slot.onLost = null;
    if (confirmed) this.release(slot);
    else this.recycle(slot);
  }

  /** The transaction contract: the root handle inside an open transaction would escape it, and
   * work left over from a failed transaction must not run (design D4). This also refuses a handle
   * of another binding inside an open transaction (catalog-roles "One binding per transaction"). */
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

  private async attempt<T>(
    fn: (t: CatalogDb) => Promise<T>,
    deadlineAt: number,
    binding: Binding,
    mode: TxMode,
  ): Promise<T> {
    const slot = await this.acquire(
      mode.kind === 'catalog' ? this.txPool : this.sessionPool,
      deadlineAt,
    );
    const label = bindingLabel(binding);
    const a: Attempt = {
      open: true,
      failed: false,
      error: undefined,
      joined: 0,
      slot,
      label,
      lost: false,
      chain: Promise.resolve(),
      inFlight: null,
      cancelled: false,
    };
    slot.holder = a;
    let timer: NodeJS.Timeout | undefined;
    let confirmed = false; // the server confirmed the transaction ended
    const sessionId = mode.kind === 'session' ? mode.sessionId : null;
    // A user snapshot probes its session's access with BEGIN (session-content-policies D4).
    const probeId = mode.kind === 'snapshot' && binding.kind === 'user' ? mode.sessionId : null;
    let refused: Error | null = null; // the lock or the probe refused the session
    try {
      try {
        // BEGIN and the preamble go out together: one round trip, as BEGIN alone was
        // (catalog-roles D4). On a retry this runs again, so the role is re-applied. A session
        // transaction sends its row lock with them (session-tables D2); its wait is inside the
        // deadline.
        const begin = handled(slot.client.unsafe(BEGIN[mode.kind]));
        const pre = handled(
          slot.client.unsafe(PREAMBLE, preambleBinds(binding), { prepare: true }),
        );
        const check =
          sessionId !== null
            ? handled(slot.client.unsafe(LOCK_SESSION, [sessionId], { prepare: true }))
            : probeId !== null
              ? handled(slot.client.unsafe(SNAPSHOT_PROBE, [probeId], { prepare: true }))
              : null;
        const replies = await bounded(
          Promise.all(check ? [begin, pre, check] : [begin, pre]),
          deadlineAt - Date.now(),
        );
        if (sessionId !== null && replies[2]?.length === 0) {
          // No row locked: under a system binding the session does not exist; under a user binding
          // ask whether it does, on this connection, before the rollback (session-content-policies
          // D4). The extra round trip is on the refusal path only.
          let exists = false;
          if (binding.kind === 'user') {
            const r = await bounded(
              handled(slot.client.unsafe(SESSION_EXISTS, [sessionId], { prepare: true })),
              deadlineAt - Date.now(),
            );
            exists = r[0]?.e === true;
          }
          refused = exists
            ? new SessionAccessDeniedError(sessionId)
            : new SessionNotFoundError(sessionId);
        } else if (probeId !== null && replies[2]?.[0]?.ok !== true) {
          refused =
            replies[2]?.[0]?.e === true
              ? new SessionAccessDeniedError(probeId)
              : new SessionNotFoundError(probeId);
        }
      } catch (error) {
        if (!(error instanceof BoundExpired)) throw mapForbidden(error, label);
        throw new CatalogTxTimeoutError(`catalog transaction exceeded ${this.txTimeoutMs} ms`);
      }
      if (refused) {
        a.open = false;
        fail(a, refused);
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
      const body = refused
        ? Promise.resolve(null)
        : current.run(a, async () => fn(new TxHandle(a))).then(
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
          // A failed COMMIT ends the transaction on the server, but the client is retired rather
          // than reused (catalog-roles D6).
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
  private acquire(pool: Pool, deadlineAt: number): Promise<Slot> {
    if (this.closed) return Promise.reject(closedError());
    const slot = pool.free.shift();
    if (slot) return Promise.resolve(slot);
    return new Promise<Slot>((resolve, reject) => {
      const waiter: Waiter = {
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
          pool.waiters.splice(pool.waiters.indexOf(waiter), 1);
          reject(pool.expired());
        },
        Math.max(0, deadlineAt - Date.now()),
      );
      pool.waiters.push(waiter);
    });
  }

  private release(slot: Slot): void {
    const waiter = slot.pool.waiters.shift();
    if (waiter) waiter.grant(slot);
    else slot.pool.free.push(slot);
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
    if (this.retired.has(client)) return;
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
        slot.onLost?.();
        const a = slot.holder;
        if (a && !a.lost) {
          a.lost = true;
          fail(a, connectionLost('transaction'));
        }
      },
    });
    return client;
  }
}

/** A handle bound to a user or a system task (catalog-roles D4): its root statements and
 * transactions run under its binding, on the adapter's connections. `sessionTx` and `snapshot` are
 * off the catalog port: the session adapter's (session-tables D2). */
export class PostgresBoundHandle implements CatalogDb {
  constructor(
    private readonly ops: HandleOps,
    private readonly binding: Binding,
  ) {}

  all<T = Record<string, unknown>>(sql: string, ...binds: unknown[]): Promise<T[]> {
    return this.ops.root(this.binding, sql, binds, (r) => [...r] as T[]);
  }

  first<T = Record<string, unknown>>(sql: string, ...binds: unknown[]): Promise<T | null> {
    return this.ops.root(this.binding, sql, binds, (r) => (r[0] as T | undefined) ?? null);
  }

  run(sql: string, ...binds: unknown[]): Promise<{ changes: number }> {
    return this.ops.root(this.binding, sql, binds, (r) => ({ changes: r.count }));
  }

  tx<T>(fn: (t: CatalogDb) => Promise<T>): Promise<T> {
    return this.ops.tx(fn, this.binding, CATALOG);
  }

  /** A session write transaction: the body runs once `catalog.sessions` row `sessionId` is locked,
   * and a missing row rejects with `SessionNotFoundError` before it runs (under a user binding, a
   * row the policies refuse rejects with `SessionAccessDeniedError`). Deadlocks re-run it. */
  sessionTx<T>(sessionId: string, fn: (t: CatalogDb) => Promise<T>): Promise<T> {
    return this.ops.tx(fn, this.binding, { kind: 'session', sessionId });
  }

  /** A read-only snapshot of session `sessionId`: every statement in the body sees one committed
   * state. Under a user binding a probe sent with BEGIN refuses a session the user cannot access
   * (`SessionAccessDeniedError`) or that does not exist (`SessionNotFoundError`) before the body
   * runs (session-content-policies D4); a system snapshot sends no probe. */
  snapshot<T>(sessionId: string, fn: (t: CatalogDb) => Promise<T>): Promise<T> {
    return this.ops.tx(fn, this.binding, { kind: 'snapshot', sessionId });
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
            const mapped = mapForbidden(error, a.label);
            fail(a, mapped);
            throw mapped;
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
