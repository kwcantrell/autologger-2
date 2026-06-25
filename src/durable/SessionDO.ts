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
import { isoZ } from '../timecode';
import { AudioStore } from './audioStore';
import { EventStore } from './eventStore';
import { LeaseStore } from './leaseStore';
import { SessionCore } from './sessionCore';
import type { Row, SessionProjection, TimecodeCtx } from './sessionCore';
import { TransportStore } from './transportStore';

export type { SessionProjection, TransportState } from './sessionCore';
export type { AudioSegmentMeta } from './audioStore';

export class SessionDO extends DurableObject<Env> {
  private core!: SessionCore;
  private events!: EventStore;
  private transport!: TransportStore;
  private audio!: AudioStore;
  private lease!: LeaseStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.core = new SessionCore(ctx);
    this.core.initSchema();
    this.events = new EventStore(this.core);
    this.transport = new TransportStore(this.core);
    this.audio = new AudioStore(this.core);
    this.lease = new LeaseStore(this.core);
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

  // --- transport delegates ---
  transportSnapshot(ctx: TimecodeCtx) {
    return this.transport.transportSnapshot(ctx);
  }
  startTake(ctx: TimecodeCtx) {
    return this.transport.startTake(ctx);
  }
  stopTake(ctx: TimecodeCtx) {
    return this.transport.stopTake(ctx);
  }
  stopTakeWithDuration(input: Parameters<TransportStore['stopTakeWithDuration']>[0]) {
    return this.transport.stopTakeWithDuration(input);
  }
  statusLive(ctx: TimecodeCtx) {
    return this.transport.statusLive(ctx);
  }

  override async alarm(): Promise<void> {
    this.lease.expireIfStale();
  }

  // --- lease delegates ---
  claimLease(clientId: string) {
    return this.lease.claimLease(clientId);
  }
  heartbeatLease(clientId: string) {
    return this.lease.heartbeatLease(clientId);
  }
  releaseLease(clientId: string) {
    return this.lease.releaseLease(clientId);
  }
  leaseStatus() {
    return this.lease.leaseStatus();
  }

  // --- audio delegates ---
  addAudioSegment(input: Parameters<AudioStore['addAudioSegment']>[0]) {
    return this.audio.addAudioSegment(input);
  }
  listAudioSegments() {
    return this.audio.listAudioSegments();
  }
  deleteAudioSegment(segmentId: string) {
    return this.audio.deleteAudioSegment(segmentId);
  }
  getAudioSegmentKey(segmentId: string) {
    return this.audio.getAudioSegmentKey(segmentId);
  }
  setAudioSegmentWaveform(input: Parameters<AudioStore['setAudioSegmentWaveform']>[0]) {
    return this.audio.setAudioSegmentWaveform(input);
  }
  syncAudioFromR2(known: Parameters<AudioStore['syncAudioFromR2']>[0]) {
    return this.audio.syncAudioFromR2(known);
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

