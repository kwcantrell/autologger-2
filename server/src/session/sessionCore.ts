// SessionCore — the shared substrate every SessionHub domain store builds on:
// the embedded-SQLite handle + helpers, the WebSocket fan-out, the
// events_stream_revision counter, the catalog projection, the transport row,
// and meta key/value + alarm scheduling. Holds the two cross-domain reads
// (transportRow, projection) so the domain stores never depend on each other.
// Runtime-agnostic by design: it sees only the structural SessionRuntime seam
// (SessionHub is the sole substrate today; tests may supply a fake).

import type { Clock } from '../clock';
import { type TransportFields } from '../timecode';

export type SqlValue = string | number | null;
export type Row = Record<string, SqlValue>;

export interface AttachedSocket {
  send(data: string): void;
  role: 'browser' | 'companion';
}

/** The SQL seam the session domain programs against: reads return rows,
 * writes return an affected-row count, and a distinct void multi-statement
 * path serves schema init (zero binds only). */
export interface SessionSql {
  all<T = Row>(sql: string, ...binds: SqlValue[]): T[];
  run(sql: string, ...binds: SqlValue[]): { changes: number };
  /** Multi-statement DDL (initSchema); zero binds, no result. */
  exec(multiStatementSql: string): void;
}

/** Runtime substrate SessionCore runs on: the embedded SQL seam, the hub's
 * socket set, and the alarm scheduler. An interface so tests can supply a
 * fake runtime without touching SessionCore. */
export interface SessionRuntime {
  readonly sql: SessionSql;
  readonly clock: Clock;
  sockets(): Iterable<AttachedSocket>;
  setAlarm(atMs: number): void;
}

/** Live fields mirrored onto the catalog sessions row for cheap listing. */
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

export class SessionCore {
  constructor(private ctx: SessionRuntime) {}

  get db(): SessionSql {
    return this.ctx.sql;
  }

  /** Current time from the injected Clock — never Date.now() in domain code. */
  now(): number {
    return this.ctx.clock.now();
  }

  initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        wall_time_utc TEXT NOT NULL,
        frame_rate REAL NOT NULL,
        timecode_total_frames INTEGER,
        category TEXT NOT NULL,
        message TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_events_wall ON events(wall_time_utc, id);
      CREATE TABLE IF NOT EXISTS session_transport (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        is_rolling INTEGER NOT NULL DEFAULT 0,
        current_take INTEGER NOT NULL DEFAULT 0,
        roll_started_at_utc TEXT,
        elapsed_frames INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO session_transport (id) VALUES (1);
      CREATE TABLE IF NOT EXISTS session_audio_segments (
        id TEXT PRIMARY KEY,
        ordinal INTEGER NOT NULL,
        started_at_utc TEXT,
        ended_at_utc TEXT,
        mime_type TEXT NOT NULL,
        r2_key TEXT NOT NULL,
        recording_ordinal INTEGER,
        waveform_peaks_json TEXT,
        waveform_db_floor REAL,
        created_at_utc TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audio_ordinal ON session_audio_segments(ordinal);
      CREATE TABLE IF NOT EXISTS session_transcript_words (
        id TEXT PRIMARY KEY,
        session_time TEXT NOT NULL DEFAULT '',
        speaker TEXT NOT NULL DEFAULT '',
        word TEXT NOT NULL DEFAULT '',
        start_sec REAL NOT NULL DEFAULT 0.0,
        end_sec REAL NOT NULL DEFAULT 0.0,
        ordinal INTEGER NOT NULL,
        created_at_utc TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_words_ordinal ON session_transcript_words(ordinal);
      CREATE TABLE IF NOT EXISTS session_topics (
        id TEXT PRIMARY KEY,
        session_time TEXT NOT NULL DEFAULT '',
        duration_sec REAL NOT NULL DEFAULT 0,
        topic_level INTEGER NOT NULL DEFAULT 1,
        summary TEXT NOT NULL DEFAULT '',
        ordinal INTEGER NOT NULL,
        created_at_utc TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_topics_ordinal ON session_topics(ordinal);
      CREATE TABLE IF NOT EXISTS session_transcript_paragraphs (
        id TEXT PRIMARY KEY,
        start_sec REAL,
        end_sec REAL,
        speaker TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL DEFAULT '',
        ordinal INTEGER NOT NULL,
        created_at_utc TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_paragraphs_ordinal ON session_transcript_paragraphs(ordinal);
      CREATE TABLE IF NOT EXISTS session_transcript_sentiment (
        id TEXT PRIMARY KEY,
        start_sec REAL,
        end_sec REAL,
        sentiment TEXT NOT NULL DEFAULT '',
        sentiment_score REAL NOT NULL DEFAULT 0,
        text TEXT NOT NULL DEFAULT '',
        ordinal INTEGER NOT NULL,
        created_at_utc TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sentiment_ordinal ON session_transcript_sentiment(ordinal);
      CREATE TABLE IF NOT EXISTS session_dashboards (
        id TEXT PRIMARY KEY,
        config_json TEXT NOT NULL,
        created_by TEXT,
        created_by_turn_id TEXT,
        created_at_utc TEXT NOT NULL,
        updated_at_utc TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_dashboards_created ON session_dashboards(created_at_utc);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO meta (key, value) VALUES ('events_stream_revision', '0');
    `);
  }

  // -- small SQL helpers -------------------------------------------------------

  all(query: string, ...binds: SqlValue[]): Row[] {
    return this.db.all<Row>(query, ...binds);
  }

  first(query: string, ...binds: SqlValue[]): Row | null {
    const rows = this.all(query, ...binds);
    return rows.length ? rows[0] : null;
  }

  transportRow(): TransportFields & { current_take: number } {
    const r = this.first('SELECT * FROM session_transport WHERE id = 1');
    return {
      is_rolling: Boolean(Number(r?.is_rolling ?? 0)),
      current_take: Number(r?.current_take ?? 0),
      roll_started_at_utc: (r?.roll_started_at_utc as string | null) ?? null,
      elapsed_frames: Number(r?.elapsed_frames ?? 0),
    };
  }

  bumpRevision(): void {
    this.db.run(
      "UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'events_stream_revision'",
    );
  }

  revision(): number {
    const r = this.first("SELECT value FROM meta WHERE key = 'events_stream_revision'");
    return Number(r?.value ?? 0);
  }

  projection(): SessionProjection {
    const agg = this.first('SELECT COUNT(*) AS n, MAX(timecode_total_frames) AS mx FROM events');
    const tr = this.transportRow();
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

  // -- WebSocket fan-out (hibernatable; replaces polling + CompanionHub) --------

  /** Post-commit broadcast queue (code-health-consolidation D1, delta
   * "Broadcast atomicity with the owning transaction"): while a hold scope is
   * open (SessionHub.inTxn wraps every mutating transaction in one),
   * `broadcast` enqueues the already-serialized frame instead of sending, so a
   * transaction that fails at or before commit never emits `*.changed` for a
   * rolled-back write. Serialization happens at enqueue time, so the flushed
   * bytes are exactly what an immediate send would have produced. */
  private pendingBroadcasts: string[] = [];
  private broadcastHoldDepth = 0;

  /** Send a JSON message to every attached socket (browser tabs + Companion).
   * Inside a hold scope (i.e. inside a mutating transaction) the frame is
   * queued and flushed only after the outermost scope commits; outside any
   * scope it is sent immediately (composite post-commit pairs,
   * broadcastCommand, presence-path callers are unchanged). */
  broadcast(msg: Record<string, unknown>): void {
    const data = JSON.stringify(msg);
    if (this.broadcastHoldDepth > 0) {
      this.pendingBroadcasts.push(data);
      return;
    }
    this.sendToSockets(data);
  }

  /** Run `fn` with broadcasts held (D1): flush the queue in enqueue order when
   * the OUTERMOST scope exits successfully — the caller (SessionHub.inTxn)
   * places the better-sqlite3 commit inside `fn`, so the flush runs strictly
   * after commit — and discard the whole queue on an escaping throw (the
   * transaction rolled back, so nothing may be announced). Nested scopes map
   * to better-sqlite3 savepoints: flush at outermost commit only;
   * inner-catch-and-continue (an inner savepoint rollback the outer
   * transaction survives) is UNSUPPORTED and outside this contract.
   * Synchronous throughout — zero awaits (SessionHub invariant). */
  withBroadcastsHeld<T>(fn: () => T): T {
    this.broadcastHoldDepth += 1;
    try {
      const result = fn();
      this.broadcastHoldDepth -= 1;
      if (this.broadcastHoldDepth === 0) this.flushPendingBroadcasts();
      return result;
    } catch (err) {
      this.broadcastHoldDepth -= 1;
      if (this.broadcastHoldDepth === 0) this.pendingBroadcasts.length = 0;
      throw err;
    }
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

  metaGet(key: string): string | null {
    const r = this.first('SELECT value FROM meta WHERE key = ?', key);
    return r ? String(r.value) : null;
  }

  metaSet(key: string, value: string): void {
    this.db.run(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      value,
    );
  }

  metaDelete(key: string): void {
    this.db.run('DELETE FROM meta WHERE key = ?', key);
  }

  /** Single alarm slot — setAlarm REPLACES any pending alarm. The recording
   * lease is the sole consumer today. */
  setAlarm(atMs: number): void {
    this.ctx.setAlarm(atMs);
  }
}
