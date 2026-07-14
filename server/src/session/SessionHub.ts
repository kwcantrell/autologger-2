// SessionHub — the in-process live spine. One hub per session, lazily
// instantiated by SessionHubRegistry, backed by a per-session better-sqlite3
// file (same schema; SessionCore.initSchema is idempotent).
//
// INVARIANT (spec): RPC bodies are SYNCHRONOUS — zero awaits. better-sqlite3
// and WS sends are sync; a synchronous body cannot interleave, which is the
// whole concurrency model. Anything async belongs in the router. Every mutating
// RPC runs in a transaction (multi-statement mutations must be atomic;
// autocommit per-statement would not be).

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { SqlShim } from '../node/sqlShim';
import { AudioStore } from './audioStore';
import { EventStore } from './eventStore';
import { LeaseStore } from './leaseStore';
import { SessionCore } from './sessionCore';
import type { AttachedSocket, SessionProjection, TimecodeCtx } from './sessionCore';
import { TopicStore } from './topicStore';
import { TranscriptStore } from './transcriptStore';
import { TransportStore } from './transportStore';

export type { SessionProjection, TransportState } from './sessionCore';
export type { AudioSegmentMeta } from './audioStore';
export type { TranscriptWord } from './transcriptStore';
export type { Topic } from './topicStore';

interface HubSocket extends AttachedSocket {
  raw: { send(data: string): void };
}

export class SessionHub {
  private db: Database.Database;
  private core: SessionCore;
  private events: EventStore;
  private transport: TransportStore;
  private audio: AudioStore;
  private lease: LeaseStore;
  private transcript: TranscriptStore;
  private topics: TopicStore;
  private socketSet = new Set<HubSocket>();
  // ReturnType<> (not NodeJS.Timeout): correct under any ambient setTimeout typing.
  private alarmTimer: ReturnType<typeof setTimeout> | null = null;
  lastTouchedMs = Date.now();

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON'); // spec: both catalog AND session DBs
    this.db.pragma('busy_timeout = 5000');
    // SqlShim's SqlValue (string | number | null | Buffer) is intentionally wider
    // than SessionCtx['sql']'s (string | number | null); the wider exec is
    // structurally assignable to the narrower seam, so this narrows on purpose.
    const sql = new SqlShim(this.db);
    this.core = new SessionCore({
      sql,
      sockets: () => this.socketSet,
      setAlarm: (atMs) => this.armAlarm(atMs),
    });
    this.core.initSchema();
    this.events = new EventStore(this.core);
    this.transport = new TransportStore(this.core);
    this.audio = new AudioStore(this.core);
    this.lease = new LeaseStore(this.core);
    this.transcript = new TranscriptStore(this.core);
    this.topics = new TopicStore(this.core);
    // A lease that went stale while the process was down: clean it up now and
    // re-arm the timer if it is still live (spec: expireIfStale on open).
    this.inTxn(() => this.lease.expireIfStale());
  }

  private inTxn<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /** Single alarm slot: arming replaces any pending timer. */
  private armAlarm(atMs: number): void {
    if (this.alarmTimer) clearTimeout(this.alarmTimer);
    this.alarmTimer = setTimeout(
      () => {
        this.alarmTimer = null;
        this.inTxn(() => this.lease.expireIfStale());
      },
      Math.max(0, atMs - Date.now()),
    );
    this.alarmTimer.unref?.();
  }

  get hasArmedAlarm(): boolean {
    return this.alarmTimer !== null;
  }

  get socketCount(): number {
    return this.socketSet.size;
  }

  close(): void {
    if (this.alarmTimer) clearTimeout(this.alarmTimer);
    this.alarmTimer = null;
    this.db.close();
  }

  // -- WebSocket fan-out ---------------------------------------------------

  attachSocket(ws: { send(data: string): void }, role: 'browser' | 'companion'): void {
    this.socketSet.add({ raw: ws, send: (d) => ws.send(d), role });
  }

  detachSocket(ws: { send(data: string): void }): void {
    for (const s of this.socketSet) if (s.raw === ws) this.socketSet.delete(s);
  }

  handleSocketMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
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

  presence(): { browsers: number; companions: number } {
    return this.core.presence();
  }

  broadcastCommand(command: string): void {
    this.core.broadcastCommand(command);
  }

  // -- RPC: lifecycle --------------------------------------------------------

  ensure(): SessionProjection {
    return this.core.projection();
  }

  // --- event delegates ---
  addEvent(input: Parameters<EventStore['addEvent']>[0]) {
    return this.inTxn(() => this.events.addEvent(input));
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
    return this.inTxn(() => this.events.updateEvent(input));
  }
  deleteEvent(eventId: string) {
    return this.inTxn(() => this.events.deleteEvent(eventId));
  }
  maybeRelinkOrphans(input: Parameters<EventStore['maybeRelinkOrphans']>[0]) {
    return this.inTxn(() => this.events.maybeRelinkOrphans(input));
  }

  // --- transport delegates ---
  transportSnapshot(ctx: TimecodeCtx) {
    return this.transport.transportSnapshot(ctx);
  }
  startTake(ctx: TimecodeCtx) {
    return this.inTxn(() => this.transport.startTake(ctx));
  }
  stopTake(ctx: TimecodeCtx) {
    return this.inTxn(() => this.transport.stopTake(ctx));
  }
  stopTakeWithDuration(input: Parameters<TransportStore['stopTakeWithDuration']>[0]) {
    return this.inTxn(() => this.transport.stopTakeWithDuration(input));
  }
  statusLive(ctx: TimecodeCtx) {
    return this.transport.statusLive(ctx);
  }

  // --- lease delegates ---
  claimLease(clientId: string) {
    return this.inTxn(() => this.lease.claimLease(clientId));
  }
  heartbeatLease(clientId: string) {
    return this.inTxn(() => this.lease.heartbeatLease(clientId));
  }
  releaseLease(clientId: string) {
    return this.inTxn(() => this.lease.releaseLease(clientId));
  }
  leaseStatus() {
    return this.lease.leaseStatus();
  }

  // --- audio delegates ---
  addAudioSegment(input: Parameters<AudioStore['addAudioSegment']>[0]) {
    return this.inTxn(() => this.audio.addAudioSegment(input));
  }
  listAudioSegments() {
    return this.audio.listAudioSegments();
  }
  deleteAudioSegment(segmentId: string) {
    return this.inTxn(() => this.audio.deleteAudioSegment(segmentId));
  }
  getAudioSegmentKey(segmentId: string) {
    return this.audio.getAudioSegmentKey(segmentId);
  }
  setAudioSegmentWaveform(input: Parameters<AudioStore['setAudioSegmentWaveform']>[0]) {
    return this.inTxn(() => this.audio.setAudioSegmentWaveform(input));
  }
  syncAudioFromBlobs(known: Parameters<AudioStore['syncAudioFromBlobs']>[0]) {
    return this.inTxn(() => this.audio.syncAudioFromBlobs(known));
  }

  // --- transcript delegates ---
  listTranscriptWords() {
    return this.transcript.listTranscriptWords();
  }
  insertTranscriptWord(data: Parameters<TranscriptStore['insertTranscriptWord']>[0]) {
    return this.inTxn(() => this.transcript.insertTranscriptWord(data));
  }
  updateTranscriptWord(
    wordId: string,
    patch: Parameters<TranscriptStore['updateTranscriptWord']>[1],
  ) {
    return this.inTxn(() => this.transcript.updateTranscriptWord(wordId, patch));
  }
  deleteTranscriptWord(wordId: string) {
    return this.inTxn(() => this.transcript.deleteTranscriptWord(wordId));
  }

  // --- topic delegates ---
  listTopics() {
    return this.topics.listTopics();
  }
  insertTopic(data: Parameters<TopicStore['insertTopic']>[0]) {
    return this.inTxn(() => this.topics.insertTopic(data));
  }
  updateTopic(topicId: string, patch: Parameters<TopicStore['updateTopic']>[1]) {
    return this.inTxn(() => this.topics.updateTopic(topicId, patch));
  }
  deleteTopic(topicId: string) {
    return this.inTxn(() => this.topics.deleteTopic(topicId));
  }
}

const SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;
const DEFAULT_IDLE_MS = 10 * 60_000;

export class SessionHubRegistry {
  private hubs = new Map<string, SessionHub>();
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(private sessionsDir: string) {
    mkdirSync(sessionsDir, { recursive: true });
  }

  get(sessionId: string): SessionHub {
    if (!SESSION_ID_RE.test(sessionId)) {
      throw new Error(`Invalid session id for hub storage: ${sessionId}`);
    }
    let hub = this.hubs.get(sessionId);
    if (!hub) {
      hub = new SessionHub(join(this.sessionsDir, `${sessionId}.db`));
      this.hubs.set(sessionId, hub);
    }
    hub.lastTouchedMs = Date.now();
    return hub;
  }

  /** Close hubs holding nothing live — fd hygiene, everything is on disk. */
  evictIdle(idleMs: number = DEFAULT_IDLE_MS): void {
    const now = Date.now();
    for (const [id, hub] of this.hubs) {
      if (hub.socketCount === 0 && !hub.hasArmedAlarm && now - hub.lastTouchedMs > idleMs) {
        hub.close();
        this.hubs.delete(id);
      }
    }
  }

  startSweeper(): void {
    this.sweeper = setInterval(() => this.evictIdle(), 60_000);
    this.sweeper.unref?.();
  }

  closeAll(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    for (const hub of this.hubs.values()) hub.close();
    this.hubs.clear();
  }
}
