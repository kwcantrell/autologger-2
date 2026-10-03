// SessionCore — the shared substrate every SessionHub domain store builds on:
// the session SQL handle + helpers, the WebSocket fan-out, the
// events_stream_revision counter, the catalog projection, the transport row,
// and meta key/value + alarm scheduling. Holds the two cross-domain reads
// (transportRow, projection) so the domain stores never depend on each other.
// Runtime-agnostic by design: it sees only the structural SessionRuntime seam
// (SessionHub is the sole substrate today; tests may supply their own runtime).
// Every statement names the runtime's session (`session_id`, session-tables
// design D4): the session tables hold every session's rows.

import type { TransportFields } from '@autologger/domain';
import type { Clock } from '@autologger/ports';
import type { SessionCaller } from './sessionCaller';

export type SqlValue = string | number | null;
export type Row = Record<string, SqlValue>;

export interface AttachedSocket {
  send(data: string): void;
  role: 'browser' | 'companion';
  /** The signed-in user the socket was attached for (show-grants D20); absent for test sockets. */
  userId?: string;
}

/** A body's handle, scoped to one transaction or snapshot (async-session-hub D2's contract,
 * session-tables design D3): reads resolve to rows, writes to the affected-row count, and `tx`
 * joins the enclosing transaction or snapshot. */
export interface SessionSql {
  all<T = Row>(sql: string, ...binds: SqlValue[]): Promise<T[]>;
  run(sql: string, ...binds: SqlValue[]): Promise<{ changes: number }>;
  /** Joins the enclosing transaction or snapshot. */
  tx<T>(fn: (t: SessionSql) => Promise<T>): Promise<T>;
}

/** One session's storage (session-tables design D3): every write is a transaction that holds the
 * session's row lock before its body runs (a missing session rejects before the body runs, and a
 * deadlock runs the body again, so a body has only database effects); every read is one read-only
 * snapshot. Each call runs for its `caller` (session-content-policies design D3): a user caller
 * under the database's content policies, refused before its body runs when the user has no access
 * to the session's show. The composition root supplies it (the Postgres session adapter). */
export interface SessionStorage {
  tx<T>(caller: SessionCaller, fn: (t: SessionSql) => Promise<T>): Promise<T>;
  snapshot<T>(caller: SessionCaller, fn: (t: SessionSql) => Promise<T>): Promise<T>;
}

/** Runtime substrate SessionCore runs on: the session's id, the hub's socket
 * set, and the alarm scheduler. An interface so tests can supply their own
 * runtime without touching SessionCore. The SQL handle is not part of it:
 * only a transaction- or snapshot-bound core has one. */
export interface SessionRuntime {
  readonly sessionId: string;
  readonly clock: Clock;
  sockets(): Iterable<AttachedSocket>;
  setAlarm(atMs: number): void;
}

/** Live fields copied onto the catalog sessions row for cheap listing, in the write transaction
 * that changes them (session-tables design D8). */
export interface SessionProjection {
  event_count: number;
  max_timecode_total_frames: number | null;
  is_rolling: boolean;
  current_take: number;
  transport_elapsed_frames: number;
  roll_started_at_utc: string | null;
}

export interface TimecodeCtx {
  frameRate: number;
  startOffsetFrames: number;
}

/** Concrete (RPC-serializable) transport snapshot; `started`/`stopped` flag a no-op vs change. */
export interface TransportState {
  is_rolling: boolean;
  current_take: number;
  roll_started_at_utc: string | null;
  elapsed_frames: number;
  timecode: string;
  timecode_total_frames: number;
  started?: boolean;
  stopped?: boolean;
}

/** A projection-changing write found no row to update (session-tables design D8): the session's
 * transport row is missing. The write fails as a whole. */
export class SessionProjectionError extends Error {
  override name = 'SessionProjectionError';
}

export class SessionCore {
  /** `sql` is the handle of the transaction or snapshot this core is bound to; the root core
   * (the hub's) has none. */
  constructor(
    private ctx: SessionRuntime,
    private readonly sql: SessionSql | null = null,
  ) {}

  get db(): SessionSql {
    if (this.sql === null) {
      throw new Error('the root session core has no SQL handle; use a transaction or a snapshot');
    }
    return this.sql;
  }

  /** The session every statement is scoped to (session-tables design D4). */
  get sessionId(): string {
    return this.ctx.sessionId;
  }

  /** A core bound to transaction handle `t` (async-session-hub design D3, session-tables D7): the
   * same runtime, with its own broadcast queue, held from the start, and its own alarm request,
   * recorded rather than armed. The hub flushes and arms them after COMMIT
   * (`flushHeldBroadcasts`, `armHeldAlarm`) or drops them on failure (`discardHeldBroadcasts`,
   * `discardHeldAlarm`), once per attempt. Broadcasts through the root core are never held by it,
   * so a relayed Companion command is sent at once. */
  forTransaction(t: SessionSql): SessionCore {
    const bound = new SessionCore(this.ctx, t);
    bound.broadcastHoldDepth = 1;
    bound.holdsAlarm = true;
    return bound;
  }

  /** A core bound to snapshot handle `t` (session-tables design D6), for a read's statements. */
  forSnapshot(t: SessionSql): SessionCore {
    return new SessionCore(this.ctx, t);
  }

  /** Current time from the injected Clock — never Date.now() in domain code. */
  now(): number {
    return this.ctx.clock.now();
  }

  /** The session's seed rows (session-tables design D9): the transport row and the revision
   * counter, idempotent. The hub runs it when it opens, in a write transaction. */
  async seed(): Promise<void> {
    await this.db.run(
      'INSERT INTO session_transport (session_id) VALUES (?) ON CONFLICT DO NOTHING',
      this.sessionId,
    );
    await this.db.run(
      "INSERT INTO session_meta (session_id, key, value) VALUES (?, 'events_stream_revision', '0') ON CONFLICT DO NOTHING",
      this.sessionId,
    );
  }

  // -- small SQL helpers -------------------------------------------------------

  all(query: string, ...binds: SqlValue[]): Promise<Row[]> {
    return this.db.all<Row>(query, ...binds);
  }

  async first(query: string, ...binds: SqlValue[]): Promise<Row | null> {
    const rows = await this.all(query, ...binds);
    return rows.length ? rows[0] : null;
  }

  async transportRow(): Promise<TransportFields & { current_take: number }> {
    const r = await this.first(
      'SELECT * FROM session_transport WHERE session_id = ?',
      this.sessionId,
    );
    return {
      is_rolling: Boolean(Number(r?.is_rolling ?? 0)),
      current_take: Number(r?.current_take ?? 0),
      roll_started_at_utc: (r?.roll_started_at_utc as string | null) ?? null,
      elapsed_frames: Number(r?.elapsed_frames ?? 0),
    };
  }

  /** Single owner of the event-count SQL (code-health-tail D10): `total` is
   * every events row; `logged` excludes internal-category rows via
   * `lower(trim(category)) != 'internal'` (trim() strips spaces only, as
   * SQLite's did — a tab-prefixed 'internal' still counts as logged; pinned in
   * the store tests). Lives on the core, not a store, so
   * TransportStore.statusLive never reads the events table across the store
   * boundary. */
  async eventCounts(): Promise<{ total: number; logged: number }> {
    const total = Number(
      (await this.first('SELECT COUNT(*) AS c FROM session_events WHERE session_id = ?', this.sessionId))
        ?.c ?? 0,
    );
    const logged = Number(
      (
        await this.first(
          "SELECT COUNT(*) AS c FROM session_events WHERE session_id = ? AND lower(trim(category)) != 'internal'",
          this.sessionId,
        )
      )?.c ?? 0,
    );
    return { total, logged };
  }

  /** The value is only ever written by this statement and the seed, so the cast cannot fail.
   * Every events change bumps the revision, so it also marks the projection dirty (design D8). */
  async bumpRevision(): Promise<void> {
    this.markProjectionDirty();
    await this.db.run(
      "UPDATE session_meta SET value = (value::bigint + 1)::text WHERE session_id = ? AND key = 'events_stream_revision'",
      this.sessionId,
    );
  }

  async revision(): Promise<number> {
    const r = await this.first(
      "SELECT value FROM session_meta WHERE session_id = ? AND key = 'events_stream_revision'",
      this.sessionId,
    );
    return Number(r?.value ?? 0);
  }

  async projection(): Promise<SessionProjection> {
    const agg = await this.first(
      'SELECT COUNT(*) AS n, MAX(timecode_total_frames) AS mx FROM session_events WHERE session_id = ?',
      this.sessionId,
    );
    const tr = await this.transportRow();
    const mx = agg?.mx;
    return {
      event_count: Number(agg?.n ?? 0),
      max_timecode_total_frames: mx === null || mx === undefined ? null : Number(mx),
      is_rolling: tr.is_rolling,
      current_take: tr.current_take,
      transport_elapsed_frames: tr.elapsed_frames,
      roll_started_at_utc: tr.roll_started_at_utc,
    };
  }

  // -- the live projection in the write transaction (session-tables design D8) --

  private projectionDirty = false;

  /** This transaction changed the events or the transport: the hub writes the catalog
   * projection before COMMIT. */
  markProjectionDirty(): void {
    this.projectionDirty = true;
  }

  /** The hub, after the body and before COMMIT: when this transaction changed the events or the
   * transport, set the six projection columns of the session's `catalog.sessions` row in one
   * statement, to exactly `projection()`'s values. It must change exactly one row; otherwise the
   * write fails (`SessionProjectionError`). */
  async writeProjectionIfDirty(): Promise<void> {
    if (!this.projectionDirty) return;
    const { changes } = await this.db.run(
      `UPDATE sessions s SET event_count = e.n, max_timecode_total_frames = e.mx,
         is_rolling = t.is_rolling, current_take = t.current_take,
         transport_elapsed_frames = t.elapsed_frames, roll_started_at_utc = t.roll_started_at_utc
       FROM (SELECT count(*) AS n, max(timecode_total_frames) AS mx
               FROM session_events WHERE session_id = ?) e, session_transport t
       WHERE s.id = ? AND t.session_id = ?`,
      this.sessionId,
      this.sessionId,
      this.sessionId,
    );
    if (changes !== 1) {
      throw new SessionProjectionError(
        `the live projection of session ${this.sessionId} changed ${changes} rows, not 1`,
      );
    }
    this.projectionDirty = false;
  }

  // -- WebSocket fan-out (hibernatable; replaces polling + CompanionHub) --------

  /** Post-commit broadcast queue (code-health-consolidation D1, delta
   * "Broadcast atomicity with the owning transaction"), owned by the
   * transaction since async-session-hub D3: a core bound to a transaction
   * (`forTransaction`) holds every `broadcast` from the start, so a
   * transaction that fails at or before commit never emits `*.changed` for a
   * rolled-back write. Serialization happens at enqueue time, so the flushed
   * bytes are exactly what an immediate send would have produced. */
  private pendingBroadcasts: string[] = [];
  private broadcastHoldDepth = 0;

  /** Send a JSON message to every attached socket (browser tabs + Companion).
   * On a transaction-bound core (or inside a `withBroadcastsHeld` scope) the
   * frame is queued and flushed only after the transaction commits; on the
   * root core it is sent immediately (broadcastCommand, a relayed command). */
  broadcast(msg: Record<string, unknown>): void {
    const data = JSON.stringify(msg);
    if (this.broadcastHoldDepth > 0) {
      this.pendingBroadcasts.push(data);
      return;
    }
    this.sendToSockets(data);
  }

  /** Run `fn` with broadcasts held (D1, the async form): flush the queue in
   * enqueue order when the OUTERMOST scope settles successfully, discard it
   * when a rejection escapes the outermost scope. On a transaction-bound core
   * the transaction itself is the outermost scope, so nested scopes never
   * flush; the hub flushes after COMMIT. A joined `t.tx` is one transaction,
   * so its frames flush with the outer commit; inner-catch-and-continue is
   * UNSUPPORTED (any error fails the whole transaction, design D2). */
  async withBroadcastsHeld<T>(fn: () => Promise<T>): Promise<T> {
    this.broadcastHoldDepth += 1;
    try {
      const result = await fn();
      this.broadcastHoldDepth -= 1;
      if (this.broadcastHoldDepth === 0) this.flushPendingBroadcasts();
      return result;
    } catch (err) {
      this.broadcastHoldDepth -= 1;
      if (this.broadcastHoldDepth === 0) this.pendingBroadcasts.length = 0;
      throw err;
    }
  }

  /** The hub, after this transaction-bound core's transaction committed:
   * send the held frames in enqueue order. */
  flushHeldBroadcasts(): void {
    this.flushPendingBroadcasts();
  }

  /** The hub, after this transaction-bound core's transaction failed: drop
   * the held frames, so nothing is announced for a rolled-back write. */
  discardHeldBroadcasts(): void {
    this.pendingBroadcasts.length = 0;
  }

  private flushPendingBroadcasts(): void {
    // Drain before sending so the queue can never be re-entered mid-flush.
    const pending = this.pendingBroadcasts.splice(0);
    for (const data of pending) this.sendToSockets(data);
  }

  /** Per-socket fan-out with per-socket try/catch isolation: one bad socket
   * must not abort delivery to the remaining healthy sockets — this holds for
   * immediate sends and for every queued frame during a post-commit flush. */
  private sendToSockets(data: string): void {
    for (const ws of this.ctx.sockets()) {
      try {
        ws.send(data);
      } catch {
        // socket is going away; owner cleanup drops it.
      }
    }
  }

  /** Snapshot of attached sockets by role (presence; no TTL bookkeeping). */
  presence(): { browsers: number; companions: number } {
    let browsers = 0;
    let companions = 0;
    for (const ws of this.ctx.sockets()) {
      if (ws.role === 'companion') companions += 1;
      else browsers += 1;
    }
    return { browsers, companions };
  }

  /** Relay a record/play command to all attached sockets (Companion → browser). */
  broadcastCommand(command: string): void {
    this.broadcast({ type: 'command', command });
  }

  // -- meta helpers ------------------------------------------------------------

  async metaGet(key: string): Promise<string | null> {
    const r = await this.first(
      'SELECT value FROM session_meta WHERE session_id = ? AND key = ?',
      this.sessionId,
      key,
    );
    return r ? String(r.value) : null;
  }

  async metaSet(key: string, value: string): Promise<void> {
    await this.db.run(
      'INSERT INTO session_meta (session_id, key, value) VALUES (?, ?, ?) ON CONFLICT (session_id, key) DO UPDATE SET value = excluded.value',
      this.sessionId,
      key,
      value,
    );
  }

  async metaDelete(key: string): Promise<void> {
    await this.db.run(
      'DELETE FROM session_meta WHERE session_id = ? AND key = ?',
      this.sessionId,
      key,
    );
  }

  // -- alarm -------------------------------------------------------------------

  /** A transaction-bound core's alarm request, armed after COMMIT (session-tables design D7). */
  private holdsAlarm = false;
  private heldAlarmAtMs: number | null = null;

  /** Single alarm slot — setAlarm REPLACES any pending alarm. The recording
   * lease is the sole consumer today. On a transaction-bound core the request
   * is recorded (the last one wins) and the hub arms it after COMMIT, so a
   * rolled-back or retried body never leaves an alarm armed, and the timer is
   * created outside the storage call's async context (session-tables D7). */
  setAlarm(atMs: number): void {
    if (this.holdsAlarm) {
      this.heldAlarmAtMs = atMs;
      return;
    }
    this.ctx.setAlarm(atMs);
  }

  /** The hub, after this transaction-bound core's transaction committed: arm the recorded alarm. */
  armHeldAlarm(): void {
    const atMs = this.heldAlarmAtMs;
    this.heldAlarmAtMs = null;
    if (atMs !== null) this.ctx.setAlarm(atMs);
  }

  /** The hub, after this transaction-bound core's attempt failed: drop the recorded alarm. */
  discardHeldAlarm(): void {
    this.heldAlarmAtMs = null;
  }
}
