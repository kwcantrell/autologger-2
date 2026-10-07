// SessionCore — the shared substrate every SessionHub domain store builds on:
// the session SQL handle + helpers, the WebSocket fan-out, the session
// revision (catalog.sessions.revision), the catalog projection, the transport row,
// and meta key/value + alarm scheduling. Holds the two cross-domain reads
// (transportRow, projection) so the domain stores never depend on each other.
// Runtime-agnostic by design: it sees only the structural SessionRuntime seam
// (SessionHub is the sole substrate today; tests may supply their own runtime).
// Every statement names the runtime's session (`session_id`, session-tables
// design D4): the session tables hold every session's rows.

import type { TransportFields } from '@autologger/domain';
import type { Clock } from '@autologger/ports';
import { SessionTxMisuseError } from './asyncSessionSql';
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

/** An edit's expected version (session-row-versions design D4): the version the client last
 * read, and whether the edit deliberately overwrites a newer row (audited, D5). */
export interface VersionExpectation {
  version: number;
  overwrite: boolean;
}

/** The session tables whose rows carry a version (design D3). */
export type VersionedTable = 'session_events' | 'session_transcript_words' | 'session_topics';

/** A projection-changing write found no row to update (session-tables design D8): the session's
 * transport row is missing. The write fails as a whole. */
export class SessionProjectionError extends Error {
  override name = 'SessionProjectionError';
}

export class SessionCore {
  /** `sql` is the handle of the transaction or snapshot this core is bound to; the root core
   * (the hub's) has none. On a transaction-bound core it is the counting handle over `raw`
   * (session-row-versions design D2). */
  private sql: SessionSql | null;
  /** The transaction's own handle, for the core's statements that never count as a change: the
   * revision bump, the projection, the hub-open seed and the relink guard (design D2). */
  private raw: SessionSql | null;
  /** The caller of the transaction this core is bound to, when the hub names it (design D5). */
  private caller: SessionCaller | null = null;

  constructor(
    private ctx: SessionRuntime,
    sql: SessionSql | null = null,
  ) {
    this.sql = sql;
    this.raw = sql;
  }

  get db(): SessionSql {
    if (this.sql === null) {
      throw new Error('the root session core has no SQL handle; use a transaction or a snapshot');
    }
    return this.sql;
  }

  private get rawDb(): SessionSql {
    if (this.raw === null) {
      throw new Error('the root session core has no SQL handle; use a transaction or a snapshot');
    }
    return this.raw;
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
  forTransaction(t: SessionSql, caller: SessionCaller | null = null): SessionCore {
    const bound = new SessionCore(this.ctx, t);
    bound.sql = bound.countingHandle(t);
    bound.caller = caller;
    bound.broadcastHoldDepth = 1;
    bound.holdsAlarm = true;
    return bound;
  }

  /** The handle the stores write through on a transaction-bound core (session-row-versions design
   * D2): the first statement that changes a session row advances the session's revision, once per
   * transaction. A joined `tx` keeps counting through this handle. */
  private countingHandle(t: SessionSql): SessionSql {
    const handle: SessionSql = {
      all: (sql, ...binds) => t.all(sql, ...binds),
      run: async (sql, ...binds) => {
        const result = await t.run(sql, ...binds);
        if (result.changes > 0) await this.advanceRevision();
        return result;
      },
      tx: (fn) => t.tx(() => fn(handle)),
    };
    return handle;
  }

  /** A core bound to snapshot handle `t` (session-tables design D6), for a read's statements, run
   * for `caller` when the hub names it (session-leases D4 masks the lease holder by it). */
  forSnapshot(t: SessionSql, caller: SessionCaller | null = null): SessionCore {
    const bound = new SessionCore(this.ctx, t);
    bound.caller = caller;
    return bound;
  }

  /** The user this core's transaction or snapshot runs for (session-leases D3): the user caller's
   * id; null for a system caller, or when the hub names no caller. */
  get callerUserId(): string | null {
    return this.caller?.kind === 'user' ? this.caller.userId : null;
  }

  /** Current time from the injected Clock — never Date.now() in domain code. */
  now(): number {
    return this.ctx.clock.now();
  }

  /** The session's seed row (session-tables design D9): the transport row, idempotent. The hub
   * runs it when it opens, in a write transaction; it is not content, so it never advances the
   * revision (session-row-versions design D2). */
  async seed(): Promise<void> {
    await this.rawDb.run(
      'INSERT INTO session_transport (session_id) VALUES (?) ON CONFLICT DO NOTHING',
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
      (
        await this.first(
          'SELECT COUNT(*) AS c FROM session_events WHERE session_id = ?',
          this.sessionId,
        )
      )?.c ?? 0,
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

  /** This transaction's advance of the session revision, once started (design D2): held in a box
   * so concurrent first changes share one bump. */
  private revisionAdvance: { value: Promise<number> } | null = null;

  /** Advances `catalog.sessions.revision` by one, once per transaction-bound core; later calls
   * return the same value. */
  private advanceRevision(): Promise<number> {
    if (this.revisionAdvance === null) this.revisionAdvance = { value: this.bumpRevisionOnce() };
    return this.revisionAdvance.value;
  }

  /** The bump, sent on the raw handle so it does not count itself. */
  private async bumpRevisionOnce(): Promise<number> {
    const rows = await this.rawDb.all<{ revision: number }>(
      // The session's own catalog row, named as `session_id` like every session statement
      // (session-tables D4's scan).
      `WITH own (session_id) AS (VALUES (?::text))
       UPDATE sessions s SET revision = s.revision + 1 FROM own
       WHERE s.id = own.session_id RETURNING s.revision`,
      this.sessionId,
    );
    if (rows.length !== 1) {
      throw new SessionProjectionError(
        `the revision of session ${this.sessionId} changed ${rows.length} rows, not 1`,
      );
    }
    return Number(rows[0].revision);
  }

  /** The session revision (api-contract-freeze "The session revision advances once per session
   * write"): in a write transaction that has changed a row, the value it advanced to; otherwise
   * the committed value. */
  async revision(): Promise<number> {
    if (this.revisionAdvance !== null) return this.revisionAdvance.value;
    const r = await this.first(
      'SELECT s.revision FROM sessions s JOIN (VALUES (?::text)) AS own (session_id) ON s.id = own.session_id',
      this.sessionId,
    );
    return Number(r?.revision ?? 0);
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
    const { changes } = await this.rawDb.run(
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

  /** The hub, inside this transaction-bound core's transaction and after its body: take the held
   * frames, in enqueue order, to publish on the frame bus (session-frame-bus D3). */
  takeHeldBroadcasts(): string[] {
    return this.pendingBroadcasts.splice(0);
  }

  /** The hub, delivering a frame the frame bus received (session-frame-bus D1): send it to every
   * attached socket, as a flush does. */
  sendFrame(data: string): void {
    this.sendToSockets(data);
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

  /** Records one audited overwrite in this transaction (session-row-versions design D5): who, which
   * row, when, the version it replaced, and the row before and after (none after a delete), as the
   * hub's row shapes. Only a signed-in user overwrites; the hub refuses a system caller before the
   * transaction, and this refuses it again. */
  async recordOverwrite(input: {
    table: VersionedTable;
    rowId: string;
    replacedVersion: number;
    before: unknown;
    after: unknown;
  }): Promise<void> {
    if (this.caller?.kind !== 'user') {
      throw new SessionTxMisuseError('an overwrite is recorded only for a signed-in user');
    }
    await this.db.run(
      `INSERT INTO session_overwrites (session_id, id, table_name, row_id, user_id, at_utc,
         replaced_version, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      this.sessionId,
      crypto.randomUUID(),
      input.table,
      input.rowId,
      this.caller.userId,
      new Date(this.now()).toISOString(),
      input.replacedVersion,
      JSON.stringify(input.before),
      input.after === null ? null : JSON.stringify(input.after),
    );
  }

  /** `metaSet` for bookkeeping that is not content (the relink guard): it never advances the
   * revision (session-row-versions design D2). */
  async metaSetUncounted(key: string, value: string): Promise<void> {
    await this.rawDb.run(
      'INSERT INTO session_meta (session_id, key, value) VALUES (?, ?, ?) ON CONFLICT (session_id, key) DO UPDATE SET value = excluded.value',
      this.sessionId,
      key,
      value,
    );
  }

  /** The lease heartbeat (session-leases D3, D5): extends the lease of `kind` held by exactly
   * `clientId` and `userId` while it has not expired at `nowMs`, on the raw handle, so a heartbeat
   * never advances the revision (the `metaSetUncounted` precedent). True when it changed the row. */
  async heartbeatLeaseUncounted(
    kind: string,
    clientId: string,
    userId: string | null,
    nowMs: number,
    expiresAtMs: number,
  ): Promise<boolean> {
    const { changes } = await this.rawDb.run(
      `UPDATE session_leases SET heartbeat_at_ms = ?, expires_at_ms = ?
       WHERE session_id = ? AND kind = ? AND holder_client_id = ?
         AND holder_user_id IS NOT DISTINCT FROM ? AND expires_at_ms > ?`,
      nowMs,
      expiresAtMs,
      this.sessionId,
      kind,
      clientId,
      userId,
      nowMs,
    );
    return changes === 1;
  }

  /** The run-lease claim and renewal (session-run-leases D2): the recording claim's conditional
   * upsert, on the raw handle so it never advances the revision. It wins on a free or expired row
   * (at `nowMs`) or on the row of exactly `clientId` and `userId`. True when it changed the row.
   * `started_at_ms` is the run's start (run-status-and-sweeper D4): set to `nowMs` by a claim, kept
   * by a renewal of the same holder, and reset when another holder takes an expired row over. */
  async claimLeaseUncounted(
    kind: string,
    clientId: string,
    userId: string | null,
    nowMs: number,
    expiresAtMs: number,
  ): Promise<boolean> {
    const { changes } = await this.rawDb.run(
      `INSERT INTO session_leases
         (session_id, kind, holder_client_id, holder_user_id, heartbeat_at_ms, expires_at_ms,
          started_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (session_id, kind) DO UPDATE SET
         started_at_ms = CASE WHEN session_leases.holder_client_id = excluded.holder_client_id
                               AND session_leases.holder_user_id IS NOT DISTINCT FROM excluded.holder_user_id
                              THEN session_leases.started_at_ms ELSE excluded.started_at_ms END,
         holder_client_id = excluded.holder_client_id, holder_user_id = excluded.holder_user_id,
         heartbeat_at_ms = excluded.heartbeat_at_ms, expires_at_ms = excluded.expires_at_ms
       WHERE session_leases.expires_at_ms <= ?
          OR (session_leases.holder_client_id = excluded.holder_client_id
              AND session_leases.holder_user_id IS NOT DISTINCT FROM excluded.holder_user_id)`,
      this.sessionId,
      kind,
      clientId,
      userId,
      nowMs,
      expiresAtMs,
      nowMs,
      nowMs,
    );
    return changes === 1;
  }

  /** The run-lease release (session-run-leases D2): deletes the lease of `kind` held by exactly
   * `clientId` and `userId`, on the raw handle so it never advances the revision. */
  async releaseLeaseUncounted(
    kind: string,
    clientId: string,
    userId: string | null,
  ): Promise<void> {
    await this.rawDb.run(
      `DELETE FROM session_leases WHERE session_id = ? AND kind = ? AND holder_client_id = ?
         AND holder_user_id IS NOT DISTINCT FROM ?`,
      this.sessionId,
      kind,
      clientId,
      userId,
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
