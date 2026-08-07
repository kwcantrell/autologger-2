// SessionHub — the in-process live spine. One hub per session, lazily
// instantiated by SessionHubRegistry, backed by a per-session better-sqlite3
// file (same schema; SessionCore.initSchema is idempotent).
//
// INVARIANT (spec): RPC bodies are SYNCHRONOUS — zero awaits. better-sqlite3
// and WS sends are sync; a synchronous body cannot interleave, which is the
// whole concurrency model. Anything async belongs in the router. Every mutating
// RPC runs in a transaction (multi-statement mutations must be atomic;
// autocommit per-statement would not be).

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Clock } from '../clock';
import { systemClock } from '../clock';
import {
  AUDIO_SEAM_PARTS_META_KEY,
  type AudioSeamPart,
  appendSerializedAudioSeamParts,
  deserializeAudioSeamParts,
} from './audioSeamParts';
import { AudioStore } from './audioStore';
import { DashboardStore } from './dashboardStore';
import { EventStore } from './eventStore';
import { LeaseStore } from './leaseStore';
import type {
  AttachedSocket,
  Row,
  SessionProjection,
  SessionSql,
  SqlValue,
  TimecodeCtx,
} from './sessionCore';
import { SessionCore } from './sessionCore';
import { TopicStore } from './topicStore';
import { TranscriptStore } from './transcriptStore';
import { TransportStore } from './transportStore';

export type { AudioSegmentMeta } from './audioStore';
export type { StoredDashboard } from './dashboardStore';
export { DashboardBoundsError, DashboardValidationError } from './dashboardStore';
export type { SessionProjection, TransportState } from './sessionCore';
export type { Topic } from './topicStore';
export type { TranscriptWord } from './transcriptStore';

interface HubSocket extends AttachedSocket {
  raw: { send(data: string): void };
}

/** The real SessionSql adapter: prepared statements over better-sqlite3.
 * Reads return rows, writes return the affected-row count, and exec() is the
 * distinct multi-statement DDL path (initSchema; zero binds). */
export function sqliteSessionSql(db: Database.Database): SessionSql {
  return {
    all: <T = Row>(sql: string, ...binds: SqlValue[]) => db.prepare(sql).all(...binds) as T[],
    run: (sql: string, ...binds: SqlValue[]) => ({
      changes: db.prepare(sql).run(...binds).changes,
    }),
    exec: (multiStatementSql: string) => {
      db.exec(multiStatementSql);
    },
  };
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
  private dashboards: DashboardStore;
  private socketSet = new Set<HubSocket>();
  // ReturnType<> (not NodeJS.Timeout): correct under any ambient setTimeout typing.
  private alarmTimer: ReturnType<typeof setTimeout> | null = null;
  lastTouchedMs: number;

  constructor(
    dbPath: string,
    private clock: Clock = systemClock,
  ) {
    this.lastTouchedMs = clock.now();
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON'); // spec: both catalog AND session DBs
    this.db.pragma('busy_timeout = 5000');
    this.core = new SessionCore({
      sql: sqliteSessionSql(this.db),
      clock: this.clock,
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
    this.dashboards = new DashboardStore(this.core);
    // A lease that went stale while the process was down: clean it up now and
    // re-arm the timer if it is still live (spec: expireIfStale on open).
    this.inTxn(() => this.lease.expireIfStale());
  }

  /** Every mutating RPC runs through here. Broadcast atomicity
   * (code-health-consolidation D1): the transaction runs inside a
   * `withBroadcastsHeld` scope, so store-level `core.broadcast` calls enqueue
   * while the transaction is open and flush — in enqueue order — only after
   * better-sqlite3 commits (the `db.transaction(fn)()` call returning). An
   * escaping throw (including a commit-time failure such as SQLITE_FULL)
   * rolls the write back AND discards the queue, so clients never see
   * `*.changed` for a rolled-back write. Nested calls become savepoints and
   * flush at the outermost commit only. Synchronous — zero awaits. */
  private inTxn<T>(fn: () => T): T {
    return this.core.withBroadcastsHeld(() => this.db.transaction(fn)());
  }

  /** Single alarm slot: arming replaces any pending timer. The delay is
   * computed from the injected clock so the alarm and the lease-expiry reads
   * share one time base (no real-setTimeout-vs-fake-clock skew). */
  private armAlarm(atMs: number): void {
    if (this.alarmTimer) clearTimeout(this.alarmTimer);
    this.alarmTimer = setTimeout(
      () => {
        this.alarmTimer = null;
        this.inTxn(() => this.lease.expireIfStale());
      },
      Math.max(0, atMs - this.clock.now()),
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
  addEventAtTotalFrames(input: Parameters<EventStore['addEventAtTotalFrames']>[0]) {
    return this.inTxn(() => this.events.addEventAtTotalFrames(input));
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
  deleteAutoGeneratedEvents() {
    return this.inTxn(() => this.events.deleteAutoGeneratedEvents());
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

  // --- composite RPCs ---
  /** youtube-audio-import design D10/D11: synthesizes a recorded-take shape around
   * imported audio — `Recording N Started` at the current transport position, advance
   * the transport by `durationS`, `Recording N Stopped`. One `inTxn` around all three
   * writes (calling the *store* methods directly rather than the self-transactional
   * delegates above, so nothing is nested) — a mid-transaction throw (e.g. a disk-full
   * on the second insert) rolls back the Started event AND the transport advance, never
   * leaving a dangling `Recording N Started` with no `Stopped`.
   *
   * Phase-9 fix-wave (finding 1), rationale updated by code-health-consolidation D1:
   * atomicity and suppression are two different jobs, split across two mechanisms.
   * The post-commit broadcast queue (`inTxn` + `SessionCore.withBroadcastsHeld`) now
   * owns ATOMICITY for every store — no frame for a rolled-back write, on this path
   * and all others. The `suppressBroadcast: true` flags on the three store calls are
   * RETAINED because they own this composite's FRAME-COUNT/PAYLOAD contract: without
   * them the queue would faithfully flush THREE frames post-commit (two
   * `event.changed` — including an intermediate revision no client has ever
   * observed — plus stopTakeWithDuration's `transport.changed`) instead of the
   * published two. So the flags suppress the intermediate store-level frames, and
   * the composite broadcasts ONCE, here, after `inTxn` returns successfully —
   * outside any transaction, hence an immediate send, never reached on a throw. */
  anchorImportedTake(input: { recordingOrdinal: number; durationS: number; ctx: TimecodeCtx }) {
    const { started, stopped, projection } = this.inTxn(() => {
      const { event: started } = this.events.addEvent({
        category: 'internal',
        message: `Recording ${input.recordingOrdinal} Started`,
        metadataJson: '{}',
        markedAtUtc: null,
        ctx: input.ctx,
        suppressBroadcast: true,
      });
      this.transport.stopTakeWithDuration({
        durationS: input.durationS,
        ctx: input.ctx,
        suppressBroadcast: true,
      });
      const { event: stopped, projection } = this.events.addEvent({
        category: 'internal',
        message: `Recording ${input.recordingOrdinal} Stopped`,
        metadataJson: '{}',
        markedAtUtc: null,
        ctx: input.ctx,
        suppressBroadcast: true,
      });
      return { started, stopped, projection };
    });
    // Post-commit, once each — reusing the exact existing shapes (event.changed's
    // `{type, revision}`; transport.changed's recorded-take shape `{type,
    // is_rolling:false, current_take}`, same as stopTake's).
    this.core.broadcast({ type: 'event.changed', revision: this.core.revision() });
    this.core.broadcast({
      type: 'transport.changed',
      is_rolling: false,
      current_take: projection.current_take,
    });
    return { started, stopped, projection };
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
  /** Append this import's seam parts to the session's stored list (PR-3
   * review fix): the meta key describes the session's FULL audio timeline
   * across all imported takes, in take order — the log-import sync consumer
   * (`seamPartsForSession` → `syncLogRowsToSeams`) maps part windows to
   * cumulative session time, so a repeated import (take 2, 3, …) must extend,
   * never replace, the prior takes' parts. Read-modify-write stays inside the
   * one transaction. */
  appendAudioSeamParts(parts: AudioSeamPart[]) {
    return this.inTxn(() => {
      this.core.metaSet(
        AUDIO_SEAM_PARTS_META_KEY,
        appendSerializedAudioSeamParts(this.core.metaGet(AUDIO_SEAM_PARTS_META_KEY), parts),
      );
    });
  }
  getAudioSeamParts(): AudioSeamPart[] | null {
    return deserializeAudioSeamParts(this.core.metaGet(AUDIO_SEAM_PARTS_META_KEY));
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
  /** Replace the entire transcript-words set **and its persisted
   * enrichment** atomically (design D4/D10): synchronous body, ONE
   * transaction covering words + paragraphs + sentiment (delete-then-insert
   * on all three), contiguous ordinals from 0 by array position. `enrichment`
   * defaults to empty, so a call with words only (the pre-enrichment call
   * shape) still compiles and clears any prior enrichment. This is the
   * **only** writer for enrichment — never a second RPC/transaction. */
  replaceTranscriptWords(
    words: Parameters<TranscriptStore['replaceTranscriptWords']>[0],
    enrichment?: Parameters<TranscriptStore['replaceTranscriptWords']>[1],
  ) {
    return this.inTxn(() => this.transcript.replaceTranscriptWords(words, enrichment));
  }

  /** Synchronous read of the last generation run's persisted enrichment
   * (design D5). In-process only — no HTTP route. */
  listTranscriptEnrichment() {
    return this.transcript.listTranscriptEnrichment();
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
  /** Bulk delete by id, one transaction (topic-generation design D3's
   * crash-safe swap primitive — NOT clear-all/restore). In-process only, no
   * HTTP route: consumed by the topics/generate handler (phase 3). */
  deleteTopics(ids: string[]) {
    return this.inTxn(() => this.topics.deleteTopics(ids));
  }

  // --- dashboard delegates (ai-v2-dashboards task 5.1/5.2, design D5) ---
  /** Synchronous read — never wrapped in `inTxn` (matches listTopics/
   * listTranscriptWords: reads don't need transactional isolation here). */
  getDashboard(id: string) {
    return this.dashboards.getDashboard(id);
  }
  listDashboards() {
    return this.dashboards.listDashboards();
  }
  /** Whole-config validated + bounds-checked (design D5a/D5b) inside the
   * transaction — throws DashboardValidationError/DashboardBoundsError,
   * which the router maps to 422; nothing is written on a throw
   * (better-sqlite3's `db.transaction()` rolls back on an exception). */
  saveDashboard(input: Parameters<DashboardStore['saveDashboard']>[0]) {
    return this.inTxn(() => this.dashboards.saveDashboard(input));
  }
  deleteDashboard(id: string) {
    return this.inTxn(() => this.dashboards.deleteDashboard(id));
  }
}

const SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;
const DEFAULT_IDLE_MS = 10 * 60_000;

export class SessionHubRegistry {
  private hubs = new Map<string, SessionHub>();
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(
    private sessionsDir: string,
    private clock: Clock = systemClock,
  ) {
    mkdirSync(sessionsDir, { recursive: true });
  }

  get(sessionId: string): SessionHub {
    if (!SESSION_ID_RE.test(sessionId)) {
      throw new Error(`Invalid session id for hub storage: ${sessionId}`);
    }
    let hub = this.hubs.get(sessionId);
    if (!hub) {
      hub = new SessionHub(join(this.sessionsDir, `${sessionId}.db`), this.clock);
      this.hubs.set(sessionId, hub);
    }
    hub.lastTouchedMs = this.clock.now();
    return hub;
  }

  /** Close hubs holding nothing live — fd hygiene, everything is on disk. */
  evictIdle(idleMs: number = DEFAULT_IDLE_MS): void {
    const now = this.clock.now();
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
