// SessionCore — the shared substrate every SessionDO domain store builds on:
// the embedded-SQLite handle + helpers, the hibernatable WebSocket fan-out,
// the events_stream_revision counter, the D1 projection, the transport row,
// and meta key/value + alarm scheduling. Holds the two cross-domain reads
// (transportRow, projection) so the domain stores never depend on each other.
// Never imports `cloudflare:workers` — only SessionDO.ts does.

import { type TransportFields } from '../timecode';

export type SqlValue = string | number | null;
export type Row = Record<string, SqlValue>;

export interface AttachedSocket {
  send(data: string): void;
  role: 'browser' | 'companion';
}

/** Runtime substrate SessionCore runs on. On Workers this wrapped
 * DurableObjectState; on Node it wraps better-sqlite3 + the hub's socket set. */
export interface SessionCtx {
  readonly sql: {
    exec<T = Row>(sql: string, ...binds: SqlValue[]): { toArray(): T[]; rowsWritten: number };
  };
  sockets(): Iterable<AttachedSocket>;
  setAlarm(atMs: number): void;
}

/** Live fields the Worker mirrors onto the D1 sessions row for cheap listing. */
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
  constructor(private ctx: SessionCtx) {}

  get db(): SessionCtx['sql'] {
    return this.ctx.sql;
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
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO meta (key, value) VALUES ('events_stream_revision', '0');
    `);
  }

  // -- small SQL helpers -------------------------------------------------------

  all(query: string, ...binds: SqlValue[]): Row[] {
    return this.db.exec<Row>(query, ...binds).toArray();
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
    this.db.exec(
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

  /** Send a JSON message to every attached socket (browser tabs + Companion). */
  broadcast(msg: Record<string, unknown>): void {
    const data = JSON.stringify(msg);
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
    this.db.exec(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      value,
    );
  }

  metaDelete(key: string): void {
    this.db.exec('DELETE FROM meta WHERE key = ?', key);
  }

  /** Single alarm slot — setAlarm REPLACES any pending alarm. The recording
   * lease is the sole consumer today. */
  setAlarm(atMs: number): void {
    this.ctx.setAlarm(atMs);
  }
}
