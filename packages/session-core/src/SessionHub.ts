// SessionHub — the in-process live spine. One hub per session, opened lazily
// by SessionHubRegistry, over the session's storage (the session tables in
// Postgres, through the session adapter the composition root supplies;
// session-tables design D9). The hub owns no connection.
//
// Concurrency model (async-session-hub design D3-D7, session-tables D6-D7; ADR
// 0021 slices 7a, 7b-1): every storage call is async and runs through this
// hub's FIFO lock, reads included, one at a time per session in arrival order.
// A write is one storage transaction, which holds the session's row lock
// before its body runs, so writes from every connection and process serialize;
// its held broadcasts flush and its alarm is armed after COMMIT, before the
// lock is released. A read is one read-only snapshot, so its statements see
// one committed state and never an open write's rows. A body works only on
// stores bound to its transaction handle; a hub call from inside this hub's
// own transaction rejects with SessionTxMisuseError instead of deadlocking. A
// read-then-write sequence that must be atomic is ONE hub method
// (createAnchoredEvent, anchorImportedTake, updateEvent's merge,
// addImportedAudioSegment, toggleTake, replaceTranscriptWordsRemapped,
// addEventAtTotalFramesIfAbsent): a sequence spread over several calls can
// interleave with any concurrent request.

import { AsyncLocalStorage } from 'node:async_hooks';
import { type EventRpc, isoZ, parseUtcMs } from '@autologger/domain';
import type { Clock } from '@autologger/ports';
import { SessionHubClosedError, SessionTxMisuseError } from './asyncSessionSql';
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
import { FifoLock } from './fifoLock';
import { LeaseStore } from './leaseStore';
import type {
  AttachedSocket,
  SessionProjection,
  SessionStorage,
  TimecodeCtx,
  TransportState,
} from './sessionCore';
import { systemCaller } from './sessionCaller';
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

/** A transcript replace's input, as `replaceTranscriptWordsRemapped`'s `remap` returns it. */
export interface RemappedTranscript {
  words: Array<{
    session_time: string;
    speaker: string;
    word: string;
    start_sec: number;
    end_sec: number;
  }>;
  enrichment: TranscriptEnrichmentInput;
}

/**
 * Session hub RPC-surface facade (persistence-package-extraction design D3 /
 * spec "Persistence facades are consumed through package-exported
 * interfaces"). Membership is consumption-based, not the full public class
 * surface: every member here is reached, in `server/src`, through
 * `getSessionHub(...)`/`c.env.ports.sessions.get(...)` by at least one
 * production router or `aiV2/` call site — including `routers/logImport.ts`
 * (feature-service-packages task 5.1; `server/src/logImport/` no longer
 * exists), which passes the resulting `SessionHubFacade` on by injection into
 * `@autologger/log-import`'s `runSessionLogImport`/`timedTranscriptTokens` —
 * or by an established integration-test path via
 * `env.ports.sessions.get(...)` (enumerated exhaustively against live
 * `server/src` call sites — see `.apply/task-5.1-5.2-report.md`). A service
 * package receiving this facade by injection, as `@autologger/log-import`
 * does, carries no import edge of its own (feature-service-packages design
 * D1's stated residual). Excluded (design D3 minimum, plus two
 * more found by the same audit): `lastTouchedMs`, `close`, `hasArmedAlarm`,
 * `socketCount` (coordination internals only the registry touches), and
 * `presence`/`listDashboards`/`stopTakeWithDuration` (public on the class,
 * but exercised only by this package's own unit tests against the concrete
 * `SessionHub` — never through `Ports.sessions` by an outside consumer), and
 * `getEvent`/`addEventAtTotalFrames`, whose last outside consumers (the event PUT's merge and
 * the log import's insert) moved into `updateEvent` and `addEventAtTotalFramesIfAbsent`
 * (async-session-hub D5). `packageBoundaries.repo.test.ts` checks that every member here has an
 * outside consumer. Storage members return promises (async-session-hub design D5); the socket
 * members (`attachSocket`, `detachSocket`, `handleSocketMessage`,
 * `broadcastCommand`) touch no SQL and stay synchronous.
 * Property-style function types throughout, per D3: `strictFunctionTypes`
 * then checks every member contravariantly in its parameters, so a
 * concrete-method signature that drifts (e.g. a narrowed parameter type)
 * fails `tsc --noEmit` at the class's `implements` clause below.
 */
export interface SessionHubFacade {
  // -- WebSocket fan-out ---------------------------------------------------
  attachSocket: (ws: HubSocketLike, role: 'browser' | 'companion', userId?: string) => void;
  detachSocket: (ws: { send(data: string): void }) => void;
  handleSocketMessage: (raw: string) => void;
  broadcastCommand: (command: string) => void;

  // -- lifecycle -------------------------------------------------------------
  ensure: () => Promise<SessionProjection>;

  // --- event RPCs ---
  addEvent: (input: {
    category: string;
    message: string;
    metadataJson: string;
    markedAtUtc: string | null;
    ctx: TimecodeCtx;
    explicitAnchor?: { timecodeTotalFrames: number; wallTimeUtc: string };
    suppressBroadcast?: boolean;
  }) => Promise<{ event: EventRpc; projection: SessionProjection }>;
  /** One imported row (sheets-log-import "Duplicate skip"): inserts it unless a non-internal
   * event with the same `timecode_total_frames` and message exists, in one transaction (S10). */
  addEventAtTotalFramesIfAbsent: (input: {
    category: string;
    message: string;
    metadataJson: string;
    timecodeTotalFrames: number;
    ctx: TimecodeCtx;
  }) => Promise<
    { created: false } | { created: true; event: EventRpc; projection: SessionProjection }
  >;
  listEvents: (input: { limit: number; offset: number }) => Promise<{
    events: EventRpc[];
    total: number;
    loggedTotal: number;
    revision: number;
  }>;
  exportEvents: () => Promise<EventRpc[]>;
  /** `mergeMetadata` receives the stored `metadata_json` and returns the JSON to store; the read,
   * the merge and the write are one transaction (S3). Synchronous by type; keep it pure. */
  updateEvent: (input: {
    eventId: string;
    category: string;
    message: string;
    wallTimeUtc: string;
    timecodeTotalFrames: number;
    mergeMetadata: (storedMetadataJson: string) => string;
  }) => Promise<{ event: EventRpc; projection: SessionProjection } | null>;
  deleteEvent: (eventId: string) => Promise<{ ok: boolean; projection: SessionProjection }>;
  deleteEventsByIds: (ids: string[]) => Promise<number>;
  hasAutoGeneratedEvents: () => Promise<boolean>;
  maybeRelinkOrphans: (input: {
    validIds: string[];
    labelToIds: Record<string, string[]>;
  }) => Promise<number>;

  // --- transport RPCs ---
  transportSnapshot: (ctx: TimecodeCtx) => Promise<TransportState>;
  startTake: (
    ctx: TimecodeCtx,
  ) => Promise<{ state: TransportState; projection: SessionProjection }>;
  stopTake: (ctx: TimecodeCtx) => Promise<{ state: TransportState; projection: SessionProjection }>;
  /** Starts the take if the transport is stopped, stops it if rolling, in one transaction (S6). */
  toggleTake: (
    ctx: TimecodeCtx,
  ) => Promise<{ state: TransportState; projection: SessionProjection }>;
  statusLive: (ctx: TimecodeCtx) => Promise<{
    is_rolling: boolean;
    current_take: number;
    event_count: number;
    logged_event_count: number;
    events_stream_revision: number;
    session_timecode: string;
    session_timecode_total_frames: number;
  }>;

  // --- composite RPCs ---
  anchorImportedTake: (input: {
    recordingOrdinal: number;
    durationS: number;
    ctx: TimecodeCtx;
    /** chunked-live-recording D9 — the take's segment `started_at_utc`
     * (already computed by the router before this call). Stamps the
     * synthesized `Recording N Started` event's wall time WITHOUT touching
     * its timecode anchoring (still the transport position at call time, per
     * the `youtube-audio-import` spec). Optional for callers that predate D9;
     * omitted falls back to the pre-D9 fresh-`now()` wall time. */
    startedAtUtc?: string;
  }) => Promise<{ started: EventRpc; stopped: EventRpc; projection: SessionProjection }>;
  createAnchoredEvent: (input: {
    category: string;
    message: string;
    metadataJson: string;
    timecodeTotalFrames: number;
    frameRate: number;
    startOffsetFrames: number;
    startedAtUtc: string;
    excludeEventIds?: Iterable<string>;
  }) => Promise<{ event: EventRpc; projection: SessionProjection }>;

  // --- lease RPCs ---
  claimLease: (clientId: string) => Promise<boolean>;
  heartbeatLease: (clientId: string) => Promise<boolean>;
  releaseLease: (clientId: string) => Promise<void>;
  leaseStatus: () => Promise<{
    holder_client_id: string | null;
    lease_alive: boolean;
    lease_age_sec: number | null;
  }>;

  // --- audio RPCs ---
  addAudioSegment: (input: {
    sessionId: string;
    mimeType: string;
    startedAtUtc: string | null;
    endedAtUtc: string | null;
    recordingOrdinal: number | null;
  }) => Promise<AudioSegmentMeta>;
  /** An imported take's segment: picks the next recording ordinal and inserts the segment with
   * it, in one transaction (S4). */
  addImportedAudioSegment: (input: {
    sessionId: string;
    mimeType: string;
    startedAtUtc: string | null;
    endedAtUtc: string | null;
  }) => Promise<{ segment: AudioSegmentMeta; recordingOrdinal: number }>;
  listAudioSegments: () => Promise<AudioSegmentMeta[]>;
  deleteAudioSegment: (segmentId: string) => Promise<void>;
  getAudioSegmentKey: (segmentId: string) => Promise<{ r2_key: string; mime_type: string } | null>;
  setAudioSegmentWaveform: (input: { segmentId: string; peaks: number[] }) => Promise<boolean>;
  syncAudioFromBlobs: (
    known: Array<{ r2_key: string; ordinal: number }>,
  ) => Promise<{ inserted: number }>;
  appendAudioSeamParts: (parts: AudioSeamPart[]) => Promise<void>;
  getAudioSeamParts: () => Promise<AudioSeamPart[] | null>;

  // --- transcript RPCs ---
  listTranscriptWords: () => Promise<TranscriptWord[]>;
  insertTranscriptWord: (data: {
    session_time: string;
    speaker: string;
    word: string;
  }) => Promise<TranscriptWord>;
  updateTranscriptWord: (
    wordId: string,
    patch: { session_time?: string; speaker?: string; word?: string },
  ) => Promise<TranscriptWord | null>;
  deleteTranscriptWord: (wordId: string) => Promise<boolean>;
  replaceTranscriptWords: (
    words: RemappedTranscript['words'],
    enrichment?: TranscriptEnrichmentInput,
  ) => Promise<TranscriptWord[]>;
  /** Reads the events, runs `remap` on them and replaces the transcript with its result, in one
   * transaction (S9). A `remap` that throws writes nothing. Synchronous by type; keep it pure. */
  replaceTranscriptWordsRemapped: (
    remap: (events: EventRpc[]) => RemappedTranscript,
  ) => Promise<TranscriptWord[]>;
  listTranscriptEnrichment: () => Promise<{
    paragraphs: TranscriptParagraph[];
    sentiment: TranscriptSentimentSegment[];
  }>;

  // --- topic RPCs ---
  listTopics: () => Promise<Topic[]>;
  insertTopic: (data: {
    session_time: string;
    duration_sec: number;
    topic_level: number;
    summary: string;
  }) => Promise<Topic>;
  updateTopic: (
    topicId: string,
    patch: { session_time?: string; duration_sec?: number; topic_level?: number; summary?: string },
  ) => Promise<Topic | null>;
  deleteTopic: (topicId: string) => Promise<boolean>;
  deleteTopics: (ids: string[]) => Promise<void>;

  // --- dashboard RPCs ---
  getDashboard: (id: string) => Promise<StoredDashboard | null>;
  saveDashboard: (input: {
    id: string;
    config: unknown;
    createdBy: string | null;
    createdByTurnId: string | null;
  }) => Promise<StoredDashboard>;
  deleteDashboard: (id: string) => Promise<boolean>;
}

/**
 * Session hub registry facade (persistence-package-extraction design D3 /
 * spec: "The registry facade surface is exactly `get(sessionId)` ...
 * `evictIdle`, and `startSweeper`"). `closeAll` and the hub map/sweeper
 * internals stay off — composition-root-only (`node/config.ts` calls
 * `closeAll` on the concrete `SessionHubRegistry`, which keeps compiling
 * since the composition root holds the concrete type, not this facade).
 * `get` resolves to the opened hub FACADE (async-session-hub design D5;
 * concurrent `get`s for one id share one opening), not the concrete `SessionHub` (no
 * passthrough — see D3 / the spec's "No passthrough on the facades"
 * scenario).
 */
export interface SessionHubRegistryFacade {
  get: (sessionId: string) => Promise<SessionHubFacade>;
  closeUserSockets: (
    userId: string,
    sessionIds: ReadonlySet<string> | 'all',
    code: number,
  ) => number;
  evictIdle: (idleMs?: number) => void;
  startSweeper: () => void;
}

/** A socket as the hub receives it: it sends, and (a real WebSocket) can be closed with a code
 * (show-grants D20). */
export interface HubSocketLike {
  send(data: string): void;
  close?(code?: number, reason?: string): void;
}

interface HubSocket extends AttachedSocket {
  raw: HubSocketLike;
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

/** `anchorImportedTake` found the transport rolling inside its transaction and wrote nothing
 * (session-tables design D7, owner decision 1): a take started after the import route's rolling
 * check. The import routes answer it as their own rolling refusal. */
export class ImportWhileRollingError extends Error {
  override name = 'ImportWhileRollingError';
}

/** The registry's construction (session-tables design D9): each session's storage, and the clock. */
export interface SessionHubRegistryOptions {
  storage: (sessionId: string) => SessionStorage;
  clock?: Clock;
}

/** What a hub body runs against (design D3): the stores over one core. A write body gets them
 * over a core bound to its transaction handle; `tx` joins that transaction (design D2). A read
 * body gets them over a core bound to its snapshot. */
interface HubStores {
  core: SessionCore;
  events: EventStore;
  transport: TransportStore;
  audio: AudioStore;
  lease: LeaseStore;
  transcript: TranscriptStore;
  topics: TopicStore;
  dashboards: DashboardStore;
  tx<T>(fn: (s: HubStores) => Promise<T>): Promise<T>;
}

function storesFor(core: SessionCore): HubStores {
  const stores: HubStores = {
    core,
    events: new EventStore(core),
    transport: new TransportStore(core),
    audio: new AudioStore(core),
    lease: new LeaseStore(core),
    transcript: new TranscriptStore(core),
    topics: new TopicStore(core),
    dashboards: new DashboardStore(core),
    tx: (fn) => core.db.tx(() => fn(stores)),
  };
  return stores;
}

/** The async context of an open hub transaction body; `parent` is an enclosing body on another
 * hub. Used only to detect misuse (design D4), never to reach the connection. */
interface TxContext {
  hub: SessionHub;
  open: boolean;
  parent: TxContext | undefined;
}

// design D12 (youtube-audio-import): `Recording N Started`/`Stopped` internal-event message
// shape — parsed back out to compute the next collision-proof recording ordinal.
const RECORDING_EVENT_RE = /^Recording (\d+) (?:Started|Stopped)$/;

/** design D12 (youtube-audio-import) — `N = max(existing recording_ordinal over segments,
 * existing "Recording k" event numbers) + 1`. Deliberately NOT `segments.length + 1` (the
 * client's convention): that collides after a segment deletion. Reads the FULL unpaged event set
 * so an ordinal used by an event whose segment was later deleted still can't be reused. The
 * event-message scan is restricted to `category === 'internal'` (Phase-9 fix-wave, finding 3) —
 * the real anchors `anchorImportedTake` writes — so a logged event that merely matches the
 * `Recording <n> Started/Stopped` text can't inflate N. Moved from the sessions router into the
 * hub's `addImportedAudioSegment` transaction (async-session-hub design D5, S4). */
async function nextRecordingOrdinal(s: HubStores): Promise<number> {
  let maxOrdinal = 0;
  for (const seg of await s.audio.listAudioSegments()) {
    if (seg.recording_ordinal !== null && seg.recording_ordinal > maxOrdinal) {
      maxOrdinal = seg.recording_ordinal;
    }
  }
  for (const ev of await s.events.exportEvents()) {
    if (String(ev.category).toLowerCase() !== 'internal') continue;
    const m = RECORDING_EVENT_RE.exec(ev.message);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > maxOrdinal) maxOrdinal = n;
    }
  }
  return maxOrdinal + 1;
}

/** Every hub storage call runs as this one internal system caller (session-content-policies commit
 * 3a: the caller passes through the seam with no behaviour change; commit 3b binds each call to its
 * own caller). */
const HUB_CALLER = systemCaller('session-hub');

export class SessionHub implements SessionHubFacade {
  /** Marks the async context of an open transaction body (design D4); the lease alarm is armed
   * outside it (design D6, spike A11). */
  private static readonly txContext = new AsyncLocalStorage<TxContext>();

  /** The root core: sockets, the alarm and the relayed command; no SQL handle. */
  private readonly core: SessionCore;
  /** Every storage call takes it, reads included (design D3). */
  private readonly lock = new FifoLock();
  private socketSet = new Set<HubSocket>();
  // ReturnType<> (not NodeJS.Timeout): correct under any ambient setTimeout typing.
  private alarmTimer: ReturnType<typeof setTimeout> | null = null;
  /** The last lease-alarm retry delay; 0 after a successful run (design D6). */
  private alarmBackoffMs = 0;
  private state: 'open' | 'closing' | 'closed' = 'open';
  /** Held in a wrapper, so the memo is tested as an object, never as a promise (design D9). */
  private closing: { promise: Promise<void> } | null = null;
  /** Calls admitted and not yet finished, queued ones included (design D6). */
  private inFlight = 0;
  private lockWaits = 0;
  lastTouchedMs: number;

  private constructor(
    sessionId: string,
    private readonly storage: SessionStorage,
    private readonly clock: Clock,
  ) {
    this.lastTouchedMs = clock.now();
    this.core = new SessionCore({
      sessionId,
      clock,
      sockets: () => this.socketSet,
      setAlarm: (atMs) => this.armAlarm(atMs),
    });
  }

  /** Opens session `sessionId`'s hub over `storage` (session-tables design D9): in one write
   * transaction, which locks the session's catalog row first, it seeds the session's rows and runs
   * the stale-lease cleanup, so no caller can use a hub whose session is not seeded. A session with
   * no catalog row rejects (the adapter's `SessionNotFoundError`). */
  static async open(
    sessionId: string,
    storage: SessionStorage,
    clock: Clock = DEFAULT_CLOCK,
  ): Promise<SessionHub> {
    const hub = new SessionHub(sessionId, storage, clock);
    try {
      // A lease that went stale while the process was down: clean it up now and
      // re-arm the timer if it is still live (spec: expireIfStale on open).
      await hub.inTxn(async (s) => {
        await s.core.seed();
        await s.lease.expireIfStale();
      });
      return hub;
    } catch (err) {
      hub.stopAlarm();
      throw err;
    }
  }

  /** The one entry point of every storage call (design D3). Rejects at once on a closed hub, or
   * from inside this hub's own open transaction (that call would wait for the lock its own
   * transaction holds). Otherwise the call counts as in flight, touches the hub, and runs under
   * the lock: a write as one transaction whose held broadcasts flush after COMMIT and before the
   * lock is released, a read as one snapshot (session-tables design D6). */
  private async call<T>(mode: 'read' | 'write', body: (s: HubStores) => Promise<T>): Promise<T> {
    if (this.state !== 'open') throw new SessionHubClosedError('the session hub is closed');
    if (this.insideOwnTransaction()) {
      throw new SessionTxMisuseError(
        "a session hub call from inside the same hub's transaction; use the transaction's stores",
      );
    }
    if (this.inFlight > 0) this.lockWaits += 1;
    this.inFlight += 1;
    this.lastTouchedMs = this.clock.now();
    try {
      const release = await this.lock.acquire();
      try {
        return mode === 'write'
          ? await this.transaction(body)
          : await this.storage.snapshot(HUB_CALLER, (t) =>
              body(storesFor(this.core.forSnapshot(t))),
            );
      } finally {
        release();
      }
    } finally {
      this.inFlight -= 1;
    }
  }

  private read<T>(body: (s: HubStores) => Promise<T>): Promise<T> {
    return this.call('read', body);
  }

  /** Every mutating RPC runs through here. Broadcast atomicity
   * (code-health-consolidation D1, async form per async-session-hub D3): the
   * body's stores sit on a core bound to the transaction, whose broadcasts are
   * held and flush — in enqueue order — only after the adapter commits; an
   * error anywhere in the transaction (including a failed COMMIT) rolls the
   * write back AND discards the queue, so clients never see `*.changed` for a
   * rolled-back write. A nested `tx` on the body's stores joins the
   * transaction and flushes with it. */
  private inTxn<T>(body: (s: HubStores) => Promise<T>): Promise<T> {
    return this.call('write', body);
  }

  /** The storage runs the body once per attempt (a deadlock runs it again, session-tables design
   * D2, D7): each attempt gets a fresh transaction-bound core, and the previous attempt's held
   * broadcasts and alarm are dropped, so only the committed attempt's are applied, after COMMIT.
   * The alarm is armed here, outside the storage call's async context. A body that changed the
   * events or the transport writes the catalog projection after it returns, before COMMIT
   * (session-tables design D8), so a failed projection fails the write. */
  private async transaction<T>(body: (s: HubStores) => Promise<T>): Promise<T> {
    const parent = SessionHub.txContext.getStore();
    const bound: { core: SessionCore | null } = { core: null };
    const drop = () => {
      bound.core?.discardHeldBroadcasts();
      bound.core?.discardHeldAlarm();
    };
    try {
      const value = await this.storage.tx(HUB_CALLER, (t) => {
        drop();
        const ctx: TxContext = { hub: this, open: true, parent };
        return SessionHub.txContext.run(ctx, async () => {
          try {
            bound.core = this.core.forTransaction(t);
            const result = await body(storesFor(bound.core));
            // The live projection commits with the write (session-tables design D8).
            await bound.core.writeProjectionIfDirty();
            return result;
          } finally {
            ctx.open = false;
          }
        });
      });
      bound.core?.flushHeldBroadcasts();
      bound.core?.armHeldAlarm();
      return value;
    } catch (err) {
      drop();
      throw err;
    }
  }

  private insideOwnTransaction(): boolean {
    for (let c = SessionHub.txContext.getStore(); c; c = c.parent) {
      if (c.hub === this && c.open) return true;
    }
    return false;
  }

  /** Single alarm slot: arming replaces any pending timer. The delay is
   * computed from the injected clock so the alarm and the lease-expiry reads
   * share one time base (no real-setTimeout-vs-fake-clock skew). */
  private armAlarm(atMs: number): void {
    this.scheduleAlarm(Math.max(0, atMs - this.clock.now()));
  }

  private scheduleAlarm(delayMs: number): void {
    this.stopAlarm();
    if (this.state !== 'open') return;
    // Armed outside any transaction's async context (design D6, spike A11): a timer keeps the
    // context it was created in. A transaction's alarm is armed after its COMMIT (session-tables
    // D7); a failed alarm run re-arms from the alarm's own context.
    const timer = SessionHub.txContext.exit(() =>
      setTimeout(() => {
        this.alarmTimer = null;
        void this.runAlarm();
      }, delayMs),
    );
    timer.unref?.();
    this.alarmTimer = timer;
  }

  private stopAlarm(): void {
    if (this.alarmTimer) clearTimeout(this.alarmTimer);
    this.alarmTimer = null;
  }

  /** The alarm body, through the lock like any write (design D6). A failed run logs and re-arms
   * after 1 s, doubling per consecutive failure up to the lease stale threshold; a successful run
   * resets the backoff, and `expireIfStale` re-arms the normal alarm itself. */
  private async runAlarm(): Promise<void> {
    if (this.state !== 'open') return;
    try {
      await this.inTxn((s) => s.lease.expireIfStale());
      this.alarmBackoffMs = 0;
    } catch (err) {
      if (this.state !== 'open') return;
      this.alarmBackoffMs = Math.min(
        this.alarmBackoffMs === 0 ? 1000 : this.alarmBackoffMs * 2,
        LeaseStore.LEASE_STALE_MS,
      );
      console.error(`[hub] lease expiry failed; retrying in ${this.alarmBackoffMs} ms`, err);
      this.scheduleAlarm(this.alarmBackoffMs);
    }
  }

  get hasArmedAlarm(): boolean {
    return this.alarmTimer !== null;
  }

  get socketCount(): number {
    return this.socketSet.size;
  }

  /** Storage calls admitted and not finished, queued ones included. */
  get inFlightCount(): number {
    return this.inFlight;
  }

  /** For tests (design D10): how many calls arrived while another call held or awaited the
   * lock. */
  get lockWaitCount(): number {
    return this.lockWaits;
  }

  /** Refuses new calls, clears the alarm and waits for the calls already admitted (design D6);
   * the hub holds no connection to close (session-tables D9). Idempotent: every call returns the
   * same promise. */
  close(): Promise<void> {
    if (this.closing) return this.closing.promise;
    this.state = 'closing';
    this.stopAlarm();
    this.closing = {
      promise: (async () => {
        await this.lock.run(() => undefined);
        this.state = 'closed';
      })(),
    };
    return this.closing.promise;
  }

  // -- WebSocket fan-out ---------------------------------------------------

  /** `userId` is the signed-in user the upgrade admitted (show-grants D20), so
   * `closeUserSockets` can find that user's sockets when they lose access. */
  attachSocket(ws: HubSocketLike, role: 'browser' | 'companion', userId?: string): void {
    this.socketSet.add({ raw: ws, send: (d) => ws.send(d), role, userId });
  }

  /** Close (with `code`) and detach every socket attached for `userId`; returns how many
   * (show-grants D20). Detaching here as well as from the socket's onClose stops broadcasts to
   * it at once; a second detach is a no-op. */
  closeUserSockets(userId: string, code: number): number {
    let closed = 0;
    for (const s of this.socketSet) {
      if (s.userId !== userId) continue;
      this.socketSet.delete(s);
      closed += 1;
      try {
        s.raw.close?.(code);
      } catch {
        // already closed
      }
    }
    return closed;
  }

  detachSocket(ws: { send(data: string): void }): void {
    for (const s of this.socketSet) if (s.raw === ws) this.socketSet.delete(s);
  }

  /** A relayed command goes out through the root core, so an open transaction never holds or
   * drops it (design D3). */
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

  ensure() {
    return this.read((s) => s.core.projection());
  }

  // --- event delegates ---
  addEvent(input: Parameters<EventStore['addEvent']>[0]) {
    return this.inTxn((s) => s.events.addEvent(input));
  }
  addEventAtTotalFrames(input: Parameters<EventStore['addEventAtTotalFrames']>[0]) {
    return this.inTxn((s) => s.events.addEventAtTotalFrames(input));
  }
  /** sheets-log-import "Duplicate skip", per row (async-session-hub design D5, S10): the check
   * and the insert are one transaction, so it also sees rows a concurrent import created. A row
   * is a duplicate when a non-internal event (category compared with JavaScript `toLowerCase()`)
   * has the same `timecode_total_frames` and message. */
  addEventAtTotalFramesIfAbsent(input: Parameters<EventStore['addEventAtTotalFrames']>[0]) {
    return this.inTxn(
      async (
        s,
      ): Promise<
        { created: false } | { created: true; event: EventRpc; projection: SessionProjection }
      > => {
        const same = await s.core.all(
          'SELECT category FROM session_events WHERE session_id = ? AND timecode_total_frames = ? AND message = ?',
          s.core.sessionId,
          input.timecodeTotalFrames,
          input.message,
        );
        if (same.some((r) => String(r.category).toLowerCase() !== 'internal')) {
          return { created: false };
        }
        const { event, projection } = await s.events.addEventAtTotalFrames(input);
        return { created: true, event, projection };
      },
    );
  }
  listEvents(input: Parameters<EventStore['listEvents']>[0]) {
    return this.read((s) => s.events.listEvents(input));
  }
  getEvent(eventId: string) {
    return this.read((s) => s.events.getEvent(eventId));
  }
  exportEvents() {
    return this.read((s) => s.events.exportEvents());
  }
  updateEvent(input: Parameters<EventStore['updateEvent']>[0]) {
    return this.inTxn((s) => s.events.updateEvent(input));
  }
  deleteEvent(eventId: string) {
    return this.inTxn((s) => s.events.deleteEvent(eventId));
  }
  deleteEventsByIds(ids: string[]) {
    return this.inTxn((s) => s.events.deleteEventsByIds(ids));
  }
  hasAutoGeneratedEvents() {
    return this.read((s) => s.events.hasAutoGeneratedEvents());
  }
  maybeRelinkOrphans(input: Parameters<EventStore['maybeRelinkOrphans']>[0]) {
    return this.inTxn((s) => s.events.maybeRelinkOrphans(input));
  }

  // --- transport delegates ---
  transportSnapshot(ctx: TimecodeCtx) {
    return this.read((s) => s.transport.transportSnapshot(ctx));
  }
  startTake(ctx: TimecodeCtx) {
    return this.inTxn((s) => s.transport.startTake(ctx));
  }
  stopTake(ctx: TimecodeCtx) {
    return this.inTxn((s) => s.transport.stopTake(ctx));
  }
  /** The Companion transport toggle (async-session-hub design D5, S6): reads the transport and
   * starts or stops the take in one transaction, with exactly the frames `startTake` or
   * `stopTake` emits. */
  toggleTake(ctx: TimecodeCtx) {
    return this.inTxn(async (s) =>
      (await s.core.transportRow()).is_rolling
        ? s.transport.stopTake(ctx)
        : s.transport.startTake(ctx),
    );
  }
  stopTakeWithDuration(input: Parameters<TransportStore['stopTakeWithDuration']>[0]) {
    return this.inTxn((s) => s.transport.stopTakeWithDuration(input));
  }
  statusLive(ctx: TimecodeCtx) {
    return this.read((s) => s.transport.statusLive(ctx));
  }

  // --- composite RPCs ---
  /** youtube-audio-import design D10/D11: synthesizes a recorded-take shape around
   * imported audio — `Recording N Started` at the current transport position, advance
   * the transport by `durationS`, `Recording N Stopped`. One transaction around all three
   * writes (calling the *store* methods, never the hub's own delegates) — a
   * mid-transaction throw (e.g. a disk-full on the second insert) rolls back the Started
   * event AND the transport advance, never leaving a dangling `Recording N Started` with
   * no `Stopped`.
   *
   * Phase-9 fix-wave (finding 1), rationale updated by code-health-consolidation D1 and
   * async-session-hub D3: atomicity and suppression are two different jobs. The
   * transaction's held broadcast queue owns ATOMICITY for every store — no frame for a
   * rolled-back write. The `suppressBroadcast: true` flags on the three store calls own
   * this composite's FRAME-COUNT/PAYLOAD contract: without them the queue would flush
   * THREE frames (two `event.changed` — including an intermediate revision no client has
   * ever observed — plus stopTakeWithDuration's `transport.changed`) instead of the
   * published two. So the body suppresses the intermediate store-level frames and ends by
   * queueing the composite's two frames itself; they flush after COMMIT, never on a
   * rollback.
   *
   * session-tables design D7 (owner decision 1, S4/S5): the transport is read first, under the
   * session's row lock, and a rolling transport (a take started after the import route's rolling
   * check) rejects with ImportWhileRollingError before anything is written, so the anchor never
   * clobbers a live take. */
  anchorImportedTake(input: {
    recordingOrdinal: number;
    durationS: number;
    ctx: TimecodeCtx;
    startedAtUtc?: string;
  }) {
    // chunked-live-recording D9 — when the caller threads the take's own
    // `startedAtUtc` (the value already stored on the segment), the Stopped
    // event's wall time is derived coherently from it as
    // `startedAtUtc + durationS` rather than a second independent fresh
    // `now()` read: `buildRecordingIntervalsFromInternalEvents` (web) sorts
    // Started/Stopped purely by wall time to pair intervals, and the interval
    // ordering invariant (Started wall < Stopped wall) must hold for a
    // same-take pair regardless of how long the anchor RPC itself takes to
    // run (blob put + rolling recheck can take real wall-clock time). The
    // Stopped event's wall time is NOT consumed by the E-A delta formula
    // (only the Started anchor's wall time is — resolveAnchors/D5) — this is
    // purely an ordering/coherence choice, not an identity requirement.
    const stoppedAtUtc = input.startedAtUtc
      ? isoZ(new Date(parseUtcMs(input.startedAtUtc) + input.durationS * 1000))
      : undefined;
    return this.inTxn(async (s) => {
      if ((await s.core.transportRow()).is_rolling) {
        throw new ImportWhileRollingError('the transport started rolling before the import was anchored');
      }
      const { event: started } = await s.events.addEvent({
        category: 'internal',
        message: `Recording ${input.recordingOrdinal} Started`,
        metadataJson: '{}',
        markedAtUtc: null,
        ctx: input.ctx,
        suppressBroadcast: true,
        storedWallTimeUtc: input.startedAtUtc,
      });
      await s.transport.stopTakeWithDuration({
        durationS: input.durationS,
        ctx: input.ctx,
        suppressBroadcast: true,
      });
      const { event: stopped, projection } = await s.events.addEvent({
        category: 'internal',
        message: `Recording ${input.recordingOrdinal} Stopped`,
        metadataJson: '{}',
        markedAtUtc: null,
        ctx: input.ctx,
        suppressBroadcast: true,
        storedWallTimeUtc: stoppedAtUtc,
      });
      // Once each, flushed after COMMIT — reusing the exact existing shapes
      // (event.changed's `{type, revision}` with the revision after the last
      // bump; transport.changed's recorded-take shape `{type,
      // is_rolling:false, current_take}`, same as stopTake's).
      s.core.broadcast({ type: 'event.changed', revision: await s.core.revision() });
      s.core.broadcast({
        type: 'transport.changed',
        is_rolling: false,
        current_take: projection.current_take,
      });
      return { started, stopped, projection };
    });
  }

  /** package-split-foundation D6 — `create_event`'s read-filter-anchor-insert
   * sequence as ONE transactional RPC: the live-event read (`exportEvents`) →
   * exclude `excludeEventIds` (event-generate-hardening D3's regenerate
   * snapshot-id exclusion, so a regenerate run's doomed pre-spawn rows never
   * steer the replacement rows' placement) → `timecodeWallAnchors` →
   * `wallTimeUtcForTimecode` → the STORE-level `addEvent` on the transaction's
   * stores, never the hub's own `addEvent` delegate (that would be a call from
   * inside this hub's transaction, design D4). The store's one `event.changed`
   * broadcast is deliberately NOT suppressed — manual-insert semantics,
   * byte-identical to the pre-reshape tool body's `hub.addEvent` call. */
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
    return this.inTxn(async (s) => {
      const liveEvents = await s.events.exportEvents();
      const exclude = input.excludeEventIds ? new Set(input.excludeEventIds) : undefined;
      const anchorEvents =
        exclude !== undefined ? liveEvents.filter((e) => !exclude.has(e.event_id)) : liveEvents;
      const anchors = timecodeWallAnchors(anchorEvents);
      const wallTimeUtc = wallTimeUtcForTimecode(input.timecodeTotalFrames, anchors, {
        frameRate: input.frameRate,
        startOffsetFrames: input.startOffsetFrames,
        startedAtUtc: input.startedAtUtc,
      });
      return s.events.addEvent({
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
    return this.inTxn((s) => s.lease.claimLease(clientId));
  }
  heartbeatLease(clientId: string) {
    return this.inTxn((s) => s.lease.heartbeatLease(clientId));
  }
  releaseLease(clientId: string) {
    return this.inTxn((s) => s.lease.releaseLease(clientId));
  }
  leaseStatus() {
    return this.read((s) => s.lease.leaseStatus());
  }

  // --- audio delegates ---
  addAudioSegment(input: Parameters<AudioStore['addAudioSegment']>[0]) {
    return this.inTxn((s) => s.audio.addAudioSegment(input));
  }
  /** An imported take's segment (async-session-hub design D5, S4): the next recording ordinal
   * (`nextRecordingOrdinal`) and the segment that carries it are one transaction, so two
   * concurrent imports never share an ordinal. */
  addImportedAudioSegment(input: {
    sessionId: string;
    mimeType: string;
    startedAtUtc: string | null;
    endedAtUtc: string | null;
  }) {
    return this.inTxn(async (s) => {
      const recordingOrdinal = await nextRecordingOrdinal(s);
      const segment = await s.audio.addAudioSegment({ ...input, recordingOrdinal });
      return { segment, recordingOrdinal };
    });
  }
  listAudioSegments() {
    return this.read((s) => s.audio.listAudioSegments());
  }
  deleteAudioSegment(segmentId: string) {
    return this.inTxn((s) => s.audio.deleteAudioSegment(segmentId));
  }
  getAudioSegmentKey(segmentId: string) {
    return this.read((s) => s.audio.getAudioSegmentKey(segmentId));
  }
  setAudioSegmentWaveform(input: Parameters<AudioStore['setAudioSegmentWaveform']>[0]) {
    return this.inTxn((s) => s.audio.setAudioSegmentWaveform(input));
  }
  syncAudioFromBlobs(known: Parameters<AudioStore['syncAudioFromBlobs']>[0]) {
    return this.inTxn((s) => s.audio.syncAudioFromBlobs(known));
  }
  /** Append this import's seam parts to the session's stored list (PR-3
   * review fix): the meta key describes the session's FULL audio timeline
   * across all imported takes, in take order — the log-import sync consumer
   * (`seamPartsForSession` → `syncLogRowsToSeams`) maps part windows to
   * cumulative session time, so a repeated import (take 2, 3, …) must extend,
   * never replace, the prior takes' parts. Read-modify-write stays inside the
   * one transaction. */
  appendAudioSeamParts(parts: AudioSeamPart[]) {
    return this.inTxn(async (s) => {
      await s.core.metaSet(
        AUDIO_SEAM_PARTS_META_KEY,
        appendSerializedAudioSeamParts(await s.core.metaGet(AUDIO_SEAM_PARTS_META_KEY), parts),
      );
    });
  }
  getAudioSeamParts() {
    return this.read(async (s) =>
      deserializeAudioSeamParts(await s.core.metaGet(AUDIO_SEAM_PARTS_META_KEY)),
    );
  }

  // --- transcript delegates ---
  listTranscriptWords() {
    return this.read((s) => s.transcript.listTranscriptWords());
  }
  insertTranscriptWord(data: Parameters<TranscriptStore['insertTranscriptWord']>[0]) {
    return this.inTxn((s) => s.transcript.insertTranscriptWord(data));
  }
  updateTranscriptWord(
    wordId: string,
    patch: Parameters<TranscriptStore['updateTranscriptWord']>[1],
  ) {
    return this.inTxn((s) => s.transcript.updateTranscriptWord(wordId, patch));
  }
  deleteTranscriptWord(wordId: string) {
    return this.inTxn((s) => s.transcript.deleteTranscriptWord(wordId));
  }
  /** Replace the entire transcript-words set **and its persisted
   * enrichment** atomically (design D4/D10): ONE transaction covering words +
   * paragraphs + sentiment (delete-then-insert on all three), contiguous
   * ordinals from 0 by array position. `enrichment` defaults to empty, so a
   * call with words only (the pre-enrichment call shape) still compiles and
   * clears any prior enrichment. This and `replaceTranscriptWordsRemapped` are
   * the **only** writers for enrichment — never a second transaction. */
  replaceTranscriptWords(
    words: Parameters<TranscriptStore['replaceTranscriptWords']>[0],
    enrichment?: Parameters<TranscriptStore['replaceTranscriptWords']>[1],
  ) {
    return this.inTxn((s) => s.transcript.replaceTranscriptWords(words, enrichment));
  }
  /** Transcript generation's replace (async-session-hub design D5, S9): the events are read,
   * `remap` turns them into the words and enrichment to store, and the replace runs, all in one
   * transaction, so the remap and the replace see one set of recording anchors. A `remap` that
   * throws (the zero-word guard's `no_speech`) rolls back and writes nothing. */
  replaceTranscriptWordsRemapped(remap: (events: EventRpc[]) => RemappedTranscript) {
    return this.inTxn(async (s) => {
      const { words, enrichment } = remap(await s.events.exportEvents());
      return s.transcript.replaceTranscriptWords(words, enrichment);
    });
  }

  /** Read of the last generation run's persisted enrichment (design D5).
   * In-process only — no HTTP route. */
  listTranscriptEnrichment() {
    return this.read((s) => s.transcript.listTranscriptEnrichment());
  }

  // --- topic delegates ---
  listTopics() {
    return this.read((s) => s.topics.listTopics());
  }
  insertTopic(data: Parameters<TopicStore['insertTopic']>[0]) {
    return this.inTxn((s) => s.topics.insertTopic(data));
  }
  updateTopic(topicId: string, patch: Parameters<TopicStore['updateTopic']>[1]) {
    return this.inTxn((s) => s.topics.updateTopic(topicId, patch));
  }
  deleteTopic(topicId: string) {
    return this.inTxn((s) => s.topics.deleteTopic(topicId));
  }
  /** Bulk delete by id, one transaction (topic-generation design D3's
   * crash-safe swap primitive — NOT clear-all/restore). In-process only, no
   * HTTP route: consumed by the topics/generate handler (phase 3). */
  deleteTopics(ids: string[]) {
    return this.inTxn((s) => s.topics.deleteTopics(ids));
  }

  // --- dashboard delegates (ai-v2-dashboards task 5.1/5.2, design D5) ---
  /** A read: one snapshot under the lock (matches listTopics/listTranscriptWords). */
  getDashboard(id: string) {
    return this.read((s) => s.dashboards.getDashboard(id));
  }
  listDashboards() {
    return this.read((s) => s.dashboards.listDashboards());
  }
  /** Whole-config validated + bounds-checked (design D5a/D5b) inside the
   * transaction — rejects with DashboardValidationError/DashboardBoundsError,
   * which the router maps to 422; nothing is written on a rejection (the
   * transaction rolls back). */
  saveDashboard(input: Parameters<DashboardStore['saveDashboard']>[0]) {
    return this.inTxn((s) => s.dashboards.saveDashboard(input));
  }
  deleteDashboard(id: string) {
    return this.inTxn((s) => s.dashboards.deleteDashboard(id));
  }
}

const SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;
const DEFAULT_IDLE_MS = 10 * 60_000;

export class SessionHubRegistry implements SessionHubRegistryFacade {
  private hubs = new Map<string, SessionHub>();
  /** Hubs being opened, so concurrent `get`s for one id share one opening (design D5); wrapped
   * so the memo is tested as an object, never as a promise (design D9). */
  private opening = new Map<string, { promise: Promise<SessionHub> }>();
  private sweeper: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  private readonly storage: (sessionId: string) => SessionStorage;
  private readonly clock: Clock;

  /** session-tables design D9: each hub runs over `storage(sessionId)`; the registry owns no
   * connection and creates nothing. */
  constructor(options: SessionHubRegistryOptions) {
    this.storage = options.storage;
    this.clock = options.clock ?? DEFAULT_CLOCK;
  }

  /** An open hub is touched and returned; otherwise the hub is opened, and joins the map only
   * once it is open, so a failed open leaves nothing behind (design D5): a session with no
   * catalog row rejects and is not kept (session-tables D9). Rejects after `closeAll` started. */
  async get(sessionId: string): Promise<SessionHub> {
    if (!SESSION_ID_RE.test(sessionId)) {
      throw new Error(`Invalid session id for hub storage: ${sessionId}`);
    }
    if (this.closed) throw new SessionHubClosedError('the session hub registry is closed');
    const hub = this.hubs.get(sessionId);
    if (hub) {
      hub.lastTouchedMs = this.clock.now();
      return hub;
    }
    let pending = this.opening.get(sessionId);
    if (!pending) {
      pending = { promise: this.openHub(sessionId) };
      this.opening.set(sessionId, pending);
    }
    return pending.promise;
  }

  private async openHub(sessionId: string): Promise<SessionHub> {
    try {
      const hub = await SessionHub.open(sessionId, this.storage(sessionId), this.clock);
      this.hubs.set(sessionId, hub);
      return hub;
    } finally {
      this.opening.delete(sessionId);
    }
  }

  /** Close `userId`'s sockets on the named sessions with `code` (show-grants D20: `4403` when the
   * user lost access to them). Walks only the hubs already live in this process and never
   * instantiates one: a session with no live hub has no socket to close. `'all'` closes the
   * user's sockets on every live hub (the fail-closed path). Returns how many. */
  closeUserSockets(userId: string, sessionIds: ReadonlySet<string> | 'all', code: number): number {
    let closed = 0;
    for (const id of sessionIds === 'all' ? [...this.hubs.keys()] : sessionIds) {
      const hub = this.hubs.get(id);
      if (hub) closed += hub.closeUserSockets(userId, code);
    }
    return closed;
  }

  /** Close hubs holding nothing live — memory hygiene (sockets, the alarm, the lock), everything
   * is in the database. A hub with a call in flight or queued is never idle (design D6). An idle
   * hub has nothing to drain, so its close is not awaited. */
  evictIdle(idleMs: number = DEFAULT_IDLE_MS): void {
    const now = this.clock.now();
    for (const [id, hub] of this.hubs) {
      if (
        hub.socketCount === 0 &&
        !hub.hasArmedAlarm &&
        hub.inFlightCount === 0 &&
        now - hub.lastTouchedMs > idleMs
      ) {
        this.hubs.delete(id);
        void hub.close();
      }
    }
  }

  startSweeper(): void {
    this.sweeper = setInterval(() => this.evictIdle(), 60_000);
    this.sweeper.unref?.();
  }

  /** Shutdown (design D6): `get` rejects from now on; hubs still opening finish first, then every
   * hub closes once its admitted calls are done. */
  async closeAll(): Promise<void> {
    this.closed = true;
    if (this.sweeper) clearInterval(this.sweeper);
    await Promise.allSettled([...this.opening.values()].map((p) => p.promise));
    const hubs = [...this.hubs.values()];
    this.hubs.clear();
    await Promise.all(hubs.map((hub) => hub.close()));
  }
}
