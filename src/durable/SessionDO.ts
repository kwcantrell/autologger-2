// SessionDO — one Durable Object per session holds the hot, single-writer live
// data: events + transport (phase 3), audio-segment metadata + recording lease
// (phase 4), and a hibernatable WebSocket fan-out (phase 5). Embedded SQLite via
// `ctx.storage.sql`. Tables are ported near-verbatim from storage/db.py; the
// per-row `session_id` column is dropped since the DO *is* the session.
//
// The Worker owns D1 (session index/metadata) and projects the few list-relevant
// live fields back to D1 after each mutation — so the DO never needs a DB binding
// and cross-session listing stays a pure D1 query. Every mutation therefore
// returns a `projection` block the Worker writes to the D1 sessions row.

import { DurableObject } from 'cloudflare:workers';
import { formatSmpte, isoZ, parseUtcMs, toTotalFrames, transportTimecode } from '../timecode';
import { EventStore } from './eventStore';
import { SessionCore } from './sessionCore';
import type { Row, SessionProjection, TimecodeCtx, TransportState } from './sessionCore';

export type { SessionProjection, TransportState } from './sessionCore';

export class SessionDO extends DurableObject<Env> {
  private core!: SessionCore;
  private events!: EventStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.core = new SessionCore(ctx);
    this.core.initSchema();
    this.events = new EventStore(this.core);
  }

  // --- substrate delegates (temporary shim; removed in Task 8) ---
  private get db(): SqlStorage {
    return this.core.db;
  }
  private all(query: string, ...binds: SqlStorageValue[]): Row[] {
    return this.core.all(query, ...binds);
  }
  private first(query: string, ...binds: SqlStorageValue[]): Row | null {
    return this.core.first(query, ...binds);
  }
  private transportRow() {
    return this.core.transportRow();
  }
  private revision(): number {
    return this.core.revision();
  }
  private projection(): SessionProjection {
    return this.core.projection();
  }
  private broadcast(msg: Record<string, unknown>): void {
    this.core.broadcast(msg);
  }
  private metaGet(key: string): string | null {
    return this.core.metaGet(key);
  }
  private metaSet(key: string, value: string): void {
    this.core.metaSet(key, value);
  }
  private metaDelete(key: string): void {
    this.core.metaDelete(key);
  }

  // Heartbeats older than this free the recording lease (AUDIO_RECORDING_LEASE_STALE_SEC).
  private static readonly LEASE_STALE_MS = 40_000;

  // -- WebSocket fan-out (hibernatable; replaces polling + CompanionHub) --------

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket upgrade.', { status: 426 });
    }
    const role =
      new URL(request.url).searchParams.get('role') === 'companion' ? 'companion' : 'browser';
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ role });
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Snapshot of attached sockets by role (presence; no TTL bookkeeping). */
  presence(): { browsers: number; companions: number } {
    return this.core.presence();
  }

  /** Relay a record/play command to all attached sockets (Companion → browser). */
  broadcastCommand(command: string): void {
    this.core.broadcastCommand(command);
  }

  override async webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }
    if (parsed && typeof parsed === 'object') {
      const p = parsed as Record<string, unknown>;
      if (p.type === 'command' && typeof p.command === 'string') {
        this.core.broadcastCommand(p.command);
      }
      // Bare `{type:'ping'}` keepalives are simply ignored.
    }
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code < 1000 || code > 4999 ? 1000 : code);
    } catch {
      // already closed
    }
  }

  override async webSocketError(): Promise<void> {
    // Hibernation drops the socket; nothing else to clean up.
  }

  // -- RPC: lifecycle ----------------------------------------------------------

  /** Touch the DO so its transport row exists; returns the current projection. */
  ensure(): SessionProjection {
    return this.core.projection();
  }

  // --- event delegates ---
  addEvent(input: Parameters<EventStore['addEvent']>[0]) {
    return this.events.addEvent(input);
  }
  listEvents(input: Parameters<EventStore['listEvents']>[0]) {
    return this.events.listEvents(input);
  }
  getEvent(eventId: string) {
    return this.events.getEvent(eventId);
  }
  exportEvents() {
    return this.events.exportEvents();
  }
  updateEvent(input: Parameters<EventStore['updateEvent']>[0]) {
    return this.events.updateEvent(input);
  }
  deleteEvent(eventId: string) {
    return this.events.deleteEvent(eventId);
  }
  maybeRelinkOrphans(input: Parameters<EventStore['maybeRelinkOrphans']>[0]) {
    return this.events.maybeRelinkOrphans(input);
  }

  // -- RPC: transport ----------------------------------------------------------

  private transportStateDict(ctx: TimecodeCtx): TransportState {
    const tr = this.transportRow();
    const tc = transportTimecode(ctx.frameRate, ctx.startOffsetFrames, tr, Date.now());
    return {
      is_rolling: tr.is_rolling,
      current_take: tr.current_take,
      roll_started_at_utc: tr.roll_started_at_utc,
      elapsed_frames: tr.elapsed_frames,
      timecode: formatSmpte(tc),
      timecode_total_frames: toTotalFrames(tc),
    };
  }

  transportSnapshot(ctx: TimecodeCtx): TransportState {
    return this.transportStateDict(ctx);
  }

  startTake(ctx: TimecodeCtx): { state: TransportState; projection: SessionProjection } {
    const tr = this.transportRow();
    if (tr.is_rolling) {
      return {
        state: { ...this.transportStateDict(ctx), started: false },
        projection: this.projection(),
      };
    }
    const nextTake = tr.current_take + 1;
    this.db.exec(
      'UPDATE session_transport SET is_rolling = 1, current_take = ?, roll_started_at_utc = ? WHERE id = 1',
      nextTake,
      isoZ(new Date()),
    );
    this.broadcast({ type: 'transport.changed', is_rolling: true, current_take: nextTake });
    const st = this.transportStateDict(ctx);
    return { state: { ...st, started: true }, projection: this.projection() };
  }

  stopTake(ctx: TimecodeCtx): { state: TransportState; projection: SessionProjection } {
    const tr = this.transportRow();
    if (!tr.is_rolling) {
      return {
        state: { ...this.transportStateDict(ctx), stopped: false },
        projection: this.projection(),
      };
    }
    let extra = 0;
    if (tr.roll_started_at_utc) {
      const started = parseUtcMs(tr.roll_started_at_utc);
      if (!Number.isNaN(started)) {
        extra = Math.max(0, Math.trunc(((Date.now() - started) / 1000) * ctx.frameRate));
      }
    }
    const totalElapsed = tr.elapsed_frames + extra;
    this.db.exec(
      'UPDATE session_transport SET is_rolling = 0, roll_started_at_utc = NULL, elapsed_frames = ? WHERE id = 1',
      totalElapsed,
    );
    this.broadcast({ type: 'transport.changed', is_rolling: false, current_take: tr.current_take });
    const st = this.transportStateDict(ctx);
    return { state: { ...st, stopped: true }, projection: this.projection() };
  }

  /** Finalize an in-progress take with an exact duration (YouTube import path). */
  stopTakeWithDuration(input: { durationS: number; ctx: TimecodeCtx }): SessionProjection {
    const tr = this.transportRow();
    const extra = Math.max(0, Math.trunc(input.durationS * input.ctx.frameRate));
    this.db.exec(
      'UPDATE session_transport SET is_rolling = 0, roll_started_at_utc = NULL, elapsed_frames = ? WHERE id = 1',
      tr.elapsed_frames + extra,
    );
    return this.projection();
  }

  // -- RPC: status (DO-owned parts; Worker composes the D1 metadata + lease) ----

  statusLive(ctx: TimecodeCtx): {
    is_rolling: boolean;
    current_take: number;
    event_count: number;
    logged_event_count: number;
    events_stream_revision: number;
    session_timecode: string;
    session_timecode_total_frames: number;
  } {
    const st = this.transportStateDict(ctx);
    const total = Number(this.first('SELECT COUNT(*) AS c FROM events')?.c ?? 0);
    const logged = Number(
      this.first("SELECT COUNT(*) AS c FROM events WHERE lower(trim(category)) != 'internal'")?.c ??
        0,
    );
    return {
      is_rolling: st.is_rolling,
      current_take: st.current_take,
      event_count: total,
      logged_event_count: logged,
      events_stream_revision: this.revision(),
      session_timecode: st.timecode,
      session_timecode_total_frames: st.timecode_total_frames,
    };
  }

  // -- RPC: audio-recording lease (in-DO state + alarm auto-expiry) -------------

  claimLease(clientId: string): boolean {
    const cid = clientId.trim();
    if (!cid) return false;
    const now = Date.now();
    const holder = this.metaGet('lease_holder');
    const seen = Number(this.metaGet('lease_seen_ms') ?? 0);
    if (holder === null || holder === cid || now - seen >= SessionDO.LEASE_STALE_MS) {
      this.metaSet('lease_holder', cid);
      this.metaSet('lease_seen_ms', String(now));
      this.core.setAlarm(now + SessionDO.LEASE_STALE_MS);
      this.broadcast({ type: 'lease.changed' });
      return true;
    }
    return false;
  }

  heartbeatLease(clientId: string): boolean {
    const cid = clientId.trim();
    if (!cid) return false;
    if (this.metaGet('lease_holder') !== cid) return false;
    const now = Date.now();
    this.metaSet('lease_seen_ms', String(now));
    this.core.setAlarm(now + SessionDO.LEASE_STALE_MS);
    return true;
  }

  releaseLease(clientId: string): void {
    const cid = clientId.trim();
    if (!cid) return;
    if (this.metaGet('lease_holder') !== cid) return;
    this.metaDelete('lease_holder');
    this.metaDelete('lease_seen_ms');
    this.broadcast({ type: 'lease.changed' });
  }

  leaseStatus(): {
    holder_client_id: string | null;
    lease_alive: boolean;
    lease_age_sec: number | null;
  } {
    const holder = this.metaGet('lease_holder');
    if (holder === null) return { holder_client_id: null, lease_alive: false, lease_age_sec: null };
    const seen = Number(this.metaGet('lease_seen_ms') ?? 0);
    const age = Math.max(0, (Date.now() - seen) / 1000);
    return {
      holder_client_id: holder,
      lease_alive: age < SessionDO.LEASE_STALE_MS / 1000,
      lease_age_sec: age,
    };
  }

  override async alarm(): Promise<void> {
    const holder = this.metaGet('lease_holder');
    if (holder === null) return;
    const seen = Number(this.metaGet('lease_seen_ms') ?? 0);
    if (Date.now() - seen >= SessionDO.LEASE_STALE_MS) {
      this.metaDelete('lease_holder');
      this.metaDelete('lease_seen_ms');
      this.broadcast({ type: 'lease.changed' });
    }
  }

  // -- RPC: audio segments (metadata only; bytes live in R2) --------------------

  addAudioSegment(input: {
    sessionId: string;
    mimeType: string;
    startedAtUtc: string | null;
    endedAtUtc: string | null;
    recordingOrdinal: number | null;
  }): AudioSegmentMeta {
    const segId = crypto.randomUUID();
    const mt = (input.mimeType || 'audio/webm').toLowerCase();
    let ext = 'webm';
    if (mt.includes('ogg')) ext = 'ogg';
    else if (mt.includes('wav')) ext = 'wav';
    else if (mt.includes('mp4') || mt.includes('m4a')) ext = 'm4a';
    const ordinal = Number(
      this.first('SELECT COALESCE(MAX(ordinal), 0) + 1 AS n FROM session_audio_segments')?.n ?? 1,
    );
    const r2Key = `audio/${input.sessionId}/${String(ordinal).padStart(4, '0')}_${segId}.${ext}`;
    let ro: number | null = null;
    if (input.recordingOrdinal !== null && Number.isFinite(input.recordingOrdinal)) {
      const ri = Math.trunc(input.recordingOrdinal);
      if (ri >= 1) ro = ri;
    }
    this.db.exec(
      `INSERT INTO session_audio_segments
         (id, ordinal, started_at_utc, ended_at_utc, mime_type, r2_key, recording_ordinal, created_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      segId,
      ordinal,
      input.startedAtUtc,
      input.endedAtUtc,
      input.mimeType || 'audio/webm',
      r2Key,
      ro,
      isoZ(new Date()),
    );
    this.broadcast({ type: 'audio.changed' });
    return {
      id: segId,
      ordinal,
      started_at_utc: input.startedAtUtc,
      ended_at_utc: input.endedAtUtc,
      mime_type: input.mimeType || 'audio/webm',
      r2_key: r2Key,
      recording_ordinal: ro,
      waveform_peaks: null,
      waveform_db_floor: null,
    };
  }

  listAudioSegments(): AudioSegmentMeta[] {
    const rows = this.all('SELECT * FROM session_audio_segments ORDER BY ordinal ASC');
    return rows.map((r) => this.audioRowToMeta(r));
  }

  private audioRowToMeta(r: Row): AudioSegmentMeta {
    let peaks: number[] | null = null;
    const wf = r.waveform_peaks_json;
    if (wf) {
      try {
        const parsed = JSON.parse(String(wf));
        if (Array.isArray(parsed) && parsed.length) peaks = parsed.map((x) => Number(x));
      } catch {
        peaks = null;
      }
    }
    const floor = r.waveform_db_floor;
    const ro = r.recording_ordinal;
    return {
      id: String(r.id),
      ordinal: Number(r.ordinal),
      started_at_utc: (r.started_at_utc as string | null) ?? null,
      ended_at_utc: (r.ended_at_utc as string | null) ?? null,
      mime_type: String(r.mime_type),
      r2_key: String(r.r2_key),
      recording_ordinal: ro === null || ro === undefined ? null : Number(ro),
      waveform_peaks: peaks,
      waveform_db_floor: floor === null || floor === undefined ? null : Number(floor),
    };
  }

  deleteAudioSegment(segmentId: string): void {
    this.db.exec('DELETE FROM session_audio_segments WHERE id = ?', segmentId);
  }

  getAudioSegmentKey(segmentId: string): { r2_key: string; mime_type: string } | null {
    const r = this.first(
      'SELECT r2_key, mime_type FROM session_audio_segments WHERE id = ?',
      segmentId,
    );
    return r ? { r2_key: String(r.r2_key), mime_type: String(r.mime_type) } : null;
  }

  setAudioSegmentWaveform(input: { segmentId: string; peaks: number[] }): boolean {
    const blob = JSON.stringify(input.peaks);
    const r = this.db.exec(
      'UPDATE session_audio_segments SET waveform_peaks_json = ?, waveform_db_floor = ? WHERE id = ?',
      blob,
      -48.0,
      input.segmentId,
    );
    if (r.rowsWritten > 0) this.broadcast({ type: 'audio.changed' });
    return r.rowsWritten > 0;
  }

  /** Reconcile metadata against the R2 keys the Worker found under the session prefix. */
  syncAudioFromR2(known: Array<{ r2_key: string; ordinal: number }>): {
    inserted: number;
  } {
    let inserted = 0;
    const now = isoZ(new Date());
    for (const k of known) {
      const exists = this.first(
        'SELECT 1 AS x FROM session_audio_segments WHERE r2_key = ?',
        k.r2_key,
      );
      if (exists !== null) continue;
      const m = /\/(\d{4})_([0-9a-f-]{36})\.(webm|ogg|wav|m4a)$/i.exec(k.r2_key);
      if (m === null) continue;
      const segId = m[2];
      const ext = m[3].toLowerCase();
      const mime =
        ext === 'ogg'
          ? 'audio/ogg'
          : ext === 'wav'
            ? 'audio/wav'
            : ext === 'm4a'
              ? 'audio/mp4'
              : 'audio/webm';
      this.db.exec(
        `INSERT INTO session_audio_segments
           (id, ordinal, started_at_utc, ended_at_utc, mime_type, r2_key, recording_ordinal, created_at_utc)
         VALUES (?, ?, NULL, NULL, ?, ?, NULL, ?)`,
        segId,
        k.ordinal,
        mime,
        k.r2_key,
        now,
      );
      inserted += 1;
    }
    return { inserted };
  }

  // -- RPC: transcript words (manual CRUD; generation is stubbed in the router) --

  listTranscriptWords(): TranscriptWord[] {
    return this.all('SELECT * FROM session_transcript_words ORDER BY ordinal').map(wordRow);
  }

  insertTranscriptWord(data: {
    session_time: string;
    speaker: string;
    word: string;
  }): TranscriptWord {
    const id = crypto.randomUUID();
    const ordinal = Number(
      this.first('SELECT COALESCE(MAX(ordinal), -1) + 1 AS n FROM session_transcript_words')?.n ??
        0,
    );
    this.db.exec(
      `INSERT INTO session_transcript_words (id, session_time, speaker, word, ordinal, created_at_utc)
       VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      data.session_time,
      data.speaker,
      data.word,
      ordinal,
      isoZ(new Date()),
    );
    return wordRow(this.first('SELECT * FROM session_transcript_words WHERE id = ?', id) as Row);
  }

  updateTranscriptWord(
    wordId: string,
    patch: { session_time?: string; speaker?: string; word?: string },
  ): TranscriptWord | null {
    const existing = this.first('SELECT * FROM session_transcript_words WHERE id = ?', wordId);
    if (existing === null) return null;
    const cols: string[] = [];
    const vals: SqlStorageValue[] = [];
    for (const key of ['session_time', 'speaker', 'word'] as const) {
      if (patch[key] !== undefined) {
        cols.push(`${key} = ?`);
        vals.push(patch[key] as string);
      }
    }
    if (cols.length) {
      this.db.exec(
        `UPDATE session_transcript_words SET ${cols.join(', ')} WHERE id = ?`,
        ...vals,
        wordId,
      );
    }
    return wordRow(
      this.first('SELECT * FROM session_transcript_words WHERE id = ?', wordId) as Row,
    );
  }

  deleteTranscriptWord(wordId: string): boolean {
    const r = this.db.exec('DELETE FROM session_transcript_words WHERE id = ?', wordId);
    return r.rowsWritten > 0;
  }

  // -- RPC: topics (manual CRUD) -----------------------------------------------

  listTopics(): Topic[] {
    return this.all('SELECT * FROM session_topics ORDER BY ordinal').map(topicRow);
  }

  insertTopic(data: {
    session_time: string;
    duration_sec: number;
    topic_level: number;
    summary: string;
  }): Topic {
    const id = crypto.randomUUID();
    const ordinal = Number(
      this.first('SELECT COALESCE(MAX(ordinal), -1) + 1 AS n FROM session_topics')?.n ?? 0,
    );
    this.db.exec(
      `INSERT INTO session_topics (id, session_time, duration_sec, topic_level, summary, ordinal, created_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      data.session_time,
      data.duration_sec,
      data.topic_level,
      data.summary,
      ordinal,
      isoZ(new Date()),
    );
    return topicRow(this.first('SELECT * FROM session_topics WHERE id = ?', id) as Row);
  }

  updateTopic(
    topicId: string,
    patch: { session_time?: string; duration_sec?: number; topic_level?: number; summary?: string },
  ): Topic | null {
    const existing = this.first('SELECT * FROM session_topics WHERE id = ?', topicId);
    if (existing === null) return null;
    const cols: string[] = [];
    const vals: SqlStorageValue[] = [];
    for (const key of ['session_time', 'duration_sec', 'topic_level', 'summary'] as const) {
      if (patch[key] !== undefined) {
        cols.push(`${key} = ?`);
        vals.push(patch[key] as SqlStorageValue);
      }
    }
    if (cols.length) {
      this.db.exec(`UPDATE session_topics SET ${cols.join(', ')} WHERE id = ?`, ...vals, topicId);
    }
    return topicRow(this.first('SELECT * FROM session_topics WHERE id = ?', topicId) as Row);
  }

  deleteTopic(topicId: string): boolean {
    const r = this.db.exec('DELETE FROM session_topics WHERE id = ?', topicId);
    return r.rowsWritten > 0;
  }
}

export interface TranscriptWord {
  id: string;
  session_time: string;
  speaker: string;
  word: string;
  start_sec: number;
  end_sec: number;
  ordinal: number;
  created_at_utc: string;
}

export interface Topic {
  id: string;
  session_time: string;
  duration_sec: number;
  topic_level: number;
  summary: string;
  ordinal: number;
  created_at_utc: string;
}

function wordRow(r: Row): TranscriptWord {
  return {
    id: String(r.id),
    session_time: String(r.session_time ?? ''),
    speaker: String(r.speaker ?? ''),
    word: String(r.word ?? ''),
    start_sec: Number(r.start_sec ?? 0),
    end_sec: Number(r.end_sec ?? 0),
    ordinal: Number(r.ordinal ?? 0),
    created_at_utc: String(r.created_at_utc ?? ''),
  };
}

function topicRow(r: Row): Topic {
  return {
    id: String(r.id),
    session_time: String(r.session_time ?? ''),
    duration_sec: Number(r.duration_sec ?? 0),
    topic_level: Number(r.topic_level ?? 1),
    summary: String(r.summary ?? ''),
    ordinal: Number(r.ordinal ?? 0),
    created_at_utc: String(r.created_at_utc ?? ''),
  };
}

export interface AudioSegmentMeta {
  id: string;
  ordinal: number;
  started_at_utc: string | null;
  ended_at_utc: string | null;
  mime_type: string;
  r2_key: string;
  recording_ordinal: number | null;
  waveform_peaks: number[] | null;
  waveform_db_floor: number | null;
}
