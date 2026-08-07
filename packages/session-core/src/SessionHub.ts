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
import type { EventRpc } from '@autologger/domain';
import type { Clock } from '@autologger/ports';
import Database from 'better-sqlite3';
import {
  AUDIO_SEAM_PARTS_META_KEY,
  type AudioSeamPart,
  appendSerializedAudioSeamParts,
  deserializeAudioSeamParts,
} from './audioSeamParts';
import type { AudioSegmentMeta } from './audioStore';
import { AudioStore } from './audioStore';
import type { StoredDashboard } from './dashboardStore';
import { DashboardStore } from './dashboardStore';
import { timecodeWallAnchors, wallTimeUtcForTimecode } from './eventAnchors';
import { EventStore } from './eventStore';
import { LeaseStore } from './leaseStore';
import type {
  AttachedSocket,
  Row,
  SessionProjection,
  SessionSql,
  SqlValue,
  TimecodeCtx,
  TransportState,
} from './sessionCore';
import { SessionCore } from './sessionCore';
import type { Topic } from './topicStore';
import { TopicStore } from './topicStore';
import type {
  TranscriptEnrichmentInput,
  TranscriptParagraph,
  TranscriptSentimentSegment,
  TranscriptWord,
} from './transcriptStore';
import { TranscriptStore } from './transcriptStore';
import { TransportStore } from './transportStore';

export type { AudioSegmentMeta } from './audioStore';
export type { StoredDashboard } from './dashboardStore';
export { DashboardBoundsError, DashboardValidationError } from './dashboardStore';
export type { SessionProjection, TransportState } from './sessionCore';
export type { Topic } from './topicStore';
export type { TranscriptWord } from './transcriptStore';

/**
 * Session hub RPC-surface facade (persistence-package-extraction design D3 /
 * spec "Persistence facades are consumed through package-exported
 * interfaces"). Membership is consumption-based, not the full public class
 * surface: every member here is reached, in `server/src`, through
 * `getSessionHub(...)`/`c.env.ports.sessions.get(...)` by at least one
 * production router, `aiV2/`, or `logImport/` call site, or by an
 * established integration-test path via `env.ports.sessions.get(...)`
 * (enumerated exhaustively against live `server/src` call sites — see
 * `.apply/task-5.1-5.2-report.md`). Excluded (design D3 minimum, plus two
 * more found by the same audit): `lastTouchedMs`, `close`, `hasArmedAlarm`,
 * `socketCount` (coordination internals only the registry touches), and
 * `presence`/`listDashboards`/`stopTakeWithDuration` (public on the class,
 * but exercised only by this package's own unit tests against the concrete
 * `SessionHub` — never through `Ports.sessions` by an outside consumer).
 * Property-style function types throughout, per D3: `strictFunctionTypes`
 * then checks every member contravariantly in its parameters, so a
 * concrete-method signature that drifts (e.g. a narrowed parameter type)
 * fails `tsc --noEmit` at the class's `implements` clause below.
 */
export interface SessionHubFacade {
  // -- WebSocket fan-out ---------------------------------------------------
  attachSocket: (ws: { send(data: string): void }, role: 'browser' | 'companion') => void;
  detachSocket: (ws: { send(data: string): void }) => void;
  handleSocketMessage: (raw: string) => void;
  broadcastCommand: (command: string) => void;

  // -- lifecycle -------------------------------------------------------------
  ensure: () => SessionProjection;

  // --- event RPCs ---
  addEvent: (input: {
    category: string;
    message: string;
    metadataJson: string;
    markedAtUtc: string | null;
    ctx: TimecodeCtx;
    explicitAnchor?: { timecodeTotalFrames: number; wallTimeUtc: string };
    suppressBroadcast?: boolean;
  }) => { event: EventRpc; projection: SessionProjection };
  addEventAtTotalFrames: (input: {
    category: string;
    message: string;
    metadataJson: string;
    timecodeTotalFrames: number;
    ctx: TimecodeCtx;
  }) => { event: EventRpc; projection: SessionProjection };
  listEvents: (input: { limit: number; offset: number }) => {
    events: EventRpc[];
    total: number;
    loggedTotal: number;
    revision: number;
  };
  getEvent: (eventId: string) => EventRpc | null;
  exportEvents: () => EventRpc[];
  updateEvent: (input: {
    eventId: string;
    category: string;
    message: string;
    wallTimeUtc: string;
    timecodeTotalFrames: number;
    metadataJson: string;
  }) => { event: EventRpc; projection: SessionProjection } | null;
  deleteEvent: (eventId: string) => { ok: boolean; projection: SessionProjection };
  deleteEventsByIds: (ids: string[]) => number;
  hasAutoGeneratedEvents: () => boolean;
  maybeRelinkOrphans: (input: {
    validIds: string[];
    labelToIds: Record<string, string[]>;
  }) => number;

  // --- transport RPCs ---
  transportSnapshot: (ctx: TimecodeCtx) => TransportState;
  startTake: (ctx: TimecodeCtx) => { state: TransportState; projection: SessionProjection };
  stopTake: (ctx: TimecodeCtx) => { state: TransportState; projection: SessionProjection };
  statusLive: (ctx: TimecodeCtx) => {
    is_rolling: boolean;
    current_take: number;
    event_count: number;
    logged_event_count: number;
    events_stream_revision: number;
    session_timecode: string;
    session_timecode_total_frames: number;
  };

  // --- composite RPCs ---
  anchorImportedTake: (input: {
    recordingOrdinal: number;
    durationS: number;
    ctx: TimecodeCtx;
  }) => { started: EventRpc; stopped: EventRpc; projection: SessionProjection };
  createAnchoredEvent: (input: {
    category: string;
    message: string;
    metadataJson: string;
    timecodeTotalFrames: number;
    frameRate: number;
    startOffsetFrames: number;
    startedAtUtc: string;
    excludeEventIds?: Iterable<string>;
  }) => { event: EventRpc; projection: SessionProjection };

  // --- lease RPCs ---
  claimLease: (clientId: string) => boolean;
  heartbeatLease: (clientId: string) => boolean;
  releaseLease: (clientId: string) => void;
  leaseStatus: () => {
    holder_client_id: string | null;
    lease_alive: boolean;
    lease_age_sec: number | null;
  };

  // --- audio RPCs ---
  addAudioSegment: (input: {
    sessionId: string;
    mimeType: string;
    startedAtUtc: string | null;
    endedAtUtc: string | null;
    recordingOrdinal: number | null;
  }) => AudioSegmentMeta;
  listAudioSegments: () => AudioSegmentMeta[];
  deleteAudioSegment: (segmentId: string) => void;
  getAudioSegmentKey: (segmentId: string) => { r2_key: string; mime_type: string } | null;
  setAudioSegmentWaveform: (input: { segmentId: string; peaks: number[] }) => boolean;
  syncAudioFromBlobs: (known: Array<{ r2_key: string; ordinal: number }>) => { inserted: number };
  appendAudioSeamParts: (parts: AudioSeamPart[]) => void;
  getAudioSeamParts: () => AudioSeamPart[] | null;

  // --- transcript RPCs ---
  listTranscriptWords: () => TranscriptWord[];
  insertTranscriptWord: (data: {
    session_time: string;
    speaker: string;
    word: string;
  }) => TranscriptWord;
  updateTranscriptWord: (
    wordId: string,
    patch: { session_time?: string; speaker?: string; word?: string },
  ) => TranscriptWord | null;
  deleteTranscriptWord: (wordId: string) => boolean;
  replaceTranscriptWords: (
    words: Array<{
      session_time: string;
      speaker: string;
      word: string;
      start_sec: number;
      end_sec: number;
    }>,
    enrichment?: TranscriptEnrichmentInput,
  ) => TranscriptWord[];
  listTranscriptEnrichment: () => {
    paragraphs: TranscriptParagraph[];
    sentiment: TranscriptSentimentSegment[];
  };

  // --- topic RPCs ---
  listTopics: () => Topic[];
  insertTopic: (data: {
    session_time: string;
    duration_sec: number;
    topic_level: number;
    summary: string;
  }) => Topic;
  updateTopic: (
    topicId: string,
    patch: { session_time?: string; duration_sec?: number; topic_level?: number; summary?: string },
  ) => Topic | null;
  deleteTopic: (topicId: string) => boolean;
  deleteTopics: (ids: string[]) => void;

  // --- dashboard RPCs ---
  getDashboard: (id: string) => StoredDashboard | null;
  saveDashboard: (input: {
    id: string;
    config: unknown;
    createdBy: string | null;
    createdByTurnId: string | null;
  }) => StoredDashboard;
  deleteDashboard: (id: string) => boolean;
}

/**
 * Session hub registry facade (persistence-package-extraction design D3 /
 * spec: "The registry facade surface is exactly `get(sessionId)` ...
 * `evictIdle`, and `startSweeper`"). `closeAll` and the hub map/sweeper
 * internals stay off — composition-root-only (`node/config.ts` calls
 * `closeAll` on the concrete `SessionHubRegistry`, which keeps compiling
 * since the composition root holds the concrete type, not this facade).
 * `get` returns the hub FACADE type, not the concrete `SessionHub` (no
 * passthrough — see D3 / the spec's "No passthrough on the facades"
 * scenario).
 */
export interface SessionHubRegistryFacade {
  get: (sessionId: string) => SessionHubFacade;
  evictIdle: (idleMs?: number) => void;
  startSweeper: () => void;
}

interface HubSocket extends AttachedSocket {
  raw: { send(data: string): void };
}

// Constructor default only — the composition root (node/config.ts) always
// passes a Clock explicitly, so this fallback exists purely for callers
// (mostly tests) that don't care about time semantics. Deliberately NOT
// `systemClock`: that adapter lives in `server/src/node/`, and importing it
// here would give `session/` an edge into `node/` while `node/config.ts`
// already imports `session/SessionHub` — recreating, in a new place, the
// kind of directory cycle this change (package-split-foundation, design D3)
// exists to remove.
const DEFAULT_CLOCK: Clock = { now: () => Date.now() };

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

export class SessionHub implements SessionHubFacade {
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
    private clock: Clock = DEFAULT_CLOCK,
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
  deleteEventsByIds(ids: string[]) {
    return this.inTxn(() => this.events.deleteEventsByIds(ids));
  }
  hasAutoGeneratedEvents() {
    return this.events.hasAutoGeneratedEvents();
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

  /** package-split-foundation D6 — `create_event`'s read-filter-anchor-insert
   * sequence as ONE transactional RPC, upgrading a comment-enforced
   * interleaving invariant ("one synchronous block, never held across an
   * await") into an actual `inTxn` transaction. Synchronous, zero awaits, one
   * `inTxn` block: the live-event read (`exportEvents`) → exclude
   * `excludeEventIds` (event-generate-hardening D3's regenerate
   * snapshot-id exclusion, so a regenerate run's doomed pre-spawn rows never
   * steer the replacement rows' placement) → `timecodeWallAnchors` →
   * `wallTimeUtcForTimecode` → the STORE-level `this.events.addEvent` — NOT
   * the self-transactional `addEvent` delegate above, following
   * `anchorImportedTake`'s precedent above: nesting a self-transactional
   * delegate inside `inTxn` would be behavior-preserving today (better-sqlite3
   * savepoints nest fine) but `withBroadcastsHeld` documents
   * inner-catch-and-continue as unsupported, so this avoids creating that
   * trap. The store's one `event.changed` broadcast is deliberately NOT
   * suppressed — manual-insert semantics, byte-identical to the pre-reshape
   * tool body's `hub.addEvent` call. */
  createAnchoredEvent(input: {
    category: string;
    message: string;
    metadataJson: string;
    timecodeTotalFrames: number;
    frameRate: number;
    startOffsetFrames: number;
    startedAtUtc: string;
    /** event-generate-hardening D3 — a regenerate run's pre-spawn snapshot
     * ids, excluded from the anchor-basis read only (never from the insert).
     * Absent on non-regenerate runs — anchor behavior is then byte-identical
     * to a run with no exclusion. Iterable so the caller's `ReadonlySet`
     * needs no conversion before calling. */
    excludeEventIds?: Iterable<string>;
  }) {
    return this.inTxn(() => {
      const liveEvents = this.events.exportEvents();
      const exclude = input.excludeEventIds ? new Set(input.excludeEventIds) : undefined;
      const anchorEvents =
        exclude !== undefined ? liveEvents.filter((e) => !exclude.has(e.event_id)) : liveEvents;
      const anchors = timecodeWallAnchors(anchorEvents);
      const wallTimeUtc = wallTimeUtcForTimecode(input.timecodeTotalFrames, anchors, {
        frameRate: input.frameRate,
        startOffsetFrames: input.startOffsetFrames,
        startedAtUtc: input.startedAtUtc,
      });
      return this.events.addEvent({
        category: input.category,
        message: input.message,
        metadataJson: input.metadataJson,
        markedAtUtc: null,
        ctx: { frameRate: input.frameRate, startOffsetFrames: input.startOffsetFrames },
        explicitAnchor: { timecodeTotalFrames: input.timecodeTotalFrames, wallTimeUtc },
      });
    });
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

export class SessionHubRegistry implements SessionHubRegistryFacade {
  private hubs = new Map<string, SessionHub>();
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(
    private sessionsDir: string,
    private clock: Clock = DEFAULT_CLOCK,
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
