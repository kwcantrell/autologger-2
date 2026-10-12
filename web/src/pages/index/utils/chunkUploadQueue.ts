/**
 * Recorder-owned chunk upload pipeline (chunked-live-recording, design D6; media-worker design
 * D6, D10, D11; spec: live-recording-chunks "Chunk uploads are single-flight and ordered",
 * "Upload failure is surfaced and recoverable", "Rescue and uploads are bound to their
 * recording's session and survive component lifecycle", "Finished chunks are persisted locally
 * until the server confirms them", "A stopped recording is finalized").
 *
 * Framework-free (no React import); every effect (upload, segments list, finalize, the parts
 * upload, storage, locks, the timer, the network) is an injected dependency, so tests drive it
 * with fakes. `getChunkUploadQueue()` builds the tab's singleton with the real ones.
 *
 * **Single-flight, in order.** Every trigger (a rollover, the final stop, Retry, the backoff
 * tick, `online`) calls `pump()`, the only place an attempt starts. A concurrent call while one
 * runs returns the SAME promise (fix-wave F1). Only the earliest eligible chunk in capture order
 * is attempted; a later chunk never starts while an earlier one's outcome is unknown.
 *
 * **Classification** (media-worker D11). Transient (network, 5xx, 408, 429) → stays `queued`
 * with a per-chunk exponential backoff (`uploadBackoff.ts`, 2 s → 5 min, jittered) persisted as
 * `nextAttemptAt`; a 1 s tick on a worker interval pumps when the head is due. `401`/`403` →
 * `blocked` (sign-in lost). Other 4xx → `permanent` (rescue-only, never blocks later chunks).
 * `413` → re-sent through the resumable parts upload in segment mode. Neither `blocked` nor
 * `permanent` chunks are retried automatically; **Retry** (`retryAll`, `retryChunk`) gives each
 * of them one attempt. While the browser is `offline` nothing is attempted and no attempt is
 * counted; `online` resets the delays and pumps at once.
 *
 * **Ambiguous-failure dedupe.** A failure with no status (the request may have reached the
 * server) and every recovered chunk start `ambiguous`: before the next attempt the segments list
 * is checked for the window `(recording_ordinal, started_at_utc)` (live rows and the seams of
 * merged rows), normalised exactly as the server's `parseOptionalMarkedAt` does. A match is that
 * chunk's success. The server's idempotent segment POST (D18) is the second guard.
 *
 * **Storage** (D10). A chunk may carry its bytes in memory (`blob`) or by reference into the
 * chunk store (`storeId`); the bytes are read back for each attempt and removed from storage on
 * confirmation, before the next chunk is attempted. Each attempt holds the chunk's Web Lock.
 * `recover(userId)` scans the store once per page load and enqueues every unlocked entry of
 * that user in capture order.
 *
 * **Finalize** (D6). `requestFinalize` records (and persists) a stopped recording's window list;
 * once no chunk of that recording remains in the queue (queued, blocked, permanent or in flight)
 * the queue sends `POST …/recordings/:ordinal/finalize` once. Any `2xx` (`queued`, `not-needed`,
 * `already-queued`, `waiting`) is done; a failure is retried on the backoff. Discarding a chunk
 * drops its window from the list. Finalize never changes the queue's `idle`.
 *
 * **Zero-byte chunks are rejected at `enqueue()`** (returns `false`). Nothing here auto-discards.
 */

import { apiFetch } from '../../../api/client';
import type {
  AudioSegment,
  AudioSegmentsResponse,
  RecordingFinalizeResponse,
} from '../../../api/types';
import { PartsUploadError, type PartsUploadOptions, uploadInParts } from '../../../api/uploads';
import { createWorkerInterval } from '../../../shared/utils/workerInterval';
import { type ChunkStore, getChunkStore } from './chunkStore';
import type { ChunkManifest } from './chunkStore/types';
import {
  browserLockManager,
  createRecorderLocks,
  HEARTBEAT_REFRESH_MS,
  type RecorderLocks,
} from './recorderLocks';
import { backoffDelayMs } from './uploadBackoff';

/** A clock the pipeline reads — never `Date.now()` directly, so tests inject a fake one. */
export interface Clock {
  now: () => number;
}

/** The outcome of one upload attempt, as the injected `upload` function reports it. */
export type UploadOutcome =
  | {
      ok: true;
      segment: { id: string; recording_ordinal: number | null; started_at_utc: string | null };
    }
  | { ok: false; status?: number; message: string };

/** A stored segment as the dedupe sees it: its window and, when merged, its seams' windows. */
export interface ExistingSegment {
  recording_ordinal: number | null;
  started_at_utc: string | null;
  seams?: ReadonlyArray<{ started_at_utc: string | null }> | null;
}

/** One chunk entering the queue. Bytes come either in memory (`blob`) or from the store. */
export interface ChunkInput {
  sessionId: string;
  recordingOrdinal: number;
  /** 0-based capture order within the recording. */
  chunkIndex: number;
  startedAtUtc: string;
  endedAtUtc: string;
  mimeType: string;
  /** In-memory bytes (a chunk the store could not persist, or tests). */
  blob?: Blob;
  /** The chunk store entry holding the bytes. */
  storeId?: string;
  /** The signed-in user owning `storeId`. */
  userId?: string;
  /** Byte count when `blob` is absent. */
  bytes?: number;
  /** Recovered from storage after a reload (the rescue surface groups these). */
  recovered?: boolean;
  /** Captured up to a crash, never finalized by its recorder. */
  partial?: boolean;
  /** Written by Safari (7-day eviction note). */
  safari?: boolean;
}

/** What an upload function receives: the chunk with its bytes. */
export type UploadChunk = Omit<ChunkInput, 'blob'> & { blob: Blob };

export type ChunkClassification = 'queued' | 'blocked' | 'permanent';

/** A chunk's state as exposed in snapshots. */
export interface QueuedChunk {
  /** Stable identity within this queue (the store id when stored). */
  key: string;
  sessionId: string;
  recordingOrdinal: number;
  chunkIndex: number;
  /** In-memory bytes, or `null` when the bytes live in the store (`readChunk`). */
  blob: Blob | null;
  bytes: number;
  storeId: string | null;
  startedAtUtc: string;
  endedAtUtc: string;
  mimeType: string;
  /** `queued`: eligible (fresh or transient-failed); `blocked`: 401/403; `permanent`: other 4xx. */
  classification: ChunkClassification;
  lastError: string | null;
  attempts: number;
  /** Epoch ms of the next automatic attempt, `null` when not scheduled. */
  nextAttemptAt: number | null;
  recovered: boolean;
  partial: boolean;
  safari: boolean;
  /** The signed-in user who recorded it (`null`: unknown). */
  userId: string | null;
}

export interface PendingFinalizeRef {
  sessionId: string;
  recordingOrdinal: number;
}

/** Immutable snapshot of queue state — what the rescue surface and recorder read. */
export interface ChunkQueueSnapshot {
  chunks: QueuedChunk[];
  inFlight: boolean;
  /** True iff no chunk is held and no attempt is in flight (a pending finalize does not count). */
  idle: boolean;
  /** Distinct recording ordinals held by chunks in the queue. */
  pendingOrdinals: number[];
  offline: boolean;
  pendingFinalizes: PendingFinalizeRef[];
  /** The signed-in user the recorder reported (`undefined` until it did). */
  currentUser: string | null | undefined;
}

// The finalize answer is a client response type (api/types, checked against its capture).
export type { RecordingFinalizeMerge, RecordingFinalizeResponse } from '../../../api/types';

export type UploadFn = (chunk: UploadChunk) => Promise<UploadOutcome>;
export type ListSegmentsFn = (sessionId: string) => Promise<ExistingSegment[]>;
export type FinalizeFn = (
  sessionId: string,
  recordingOrdinal: number,
  windows: string[],
) => Promise<RecordingFinalizeResponse>;
export type QueueListener = (snapshot: ChunkQueueSnapshot) => void;

export interface NetworkStatus {
  isOnline(): boolean;
  /** Subscribe to `online`/`offline`; returns an unsubscribe. */
  subscribe(onOnline: () => void, onOffline: () => void): () => void;
}

export type QueueStore = Pick<
  ChunkStore,
  'read' | 'remove' | 'list' | 'saveFinalize' | 'removeFinalize' | 'touch'
>;

export interface ChunkUploadQueueDeps {
  upload: UploadFn;
  listSegments: ListSegmentsFn;
  clock: Clock;
  finalize?: FinalizeFn;
  /** The resumable parts upload in segment mode (the `413` fallback, D11/D12). */
  uploadSegmentParts?: UploadFn;
  store?: QueueStore;
  locks?: RecorderLocks;
  /** Starts the backoff tick (production: `createWorkerInterval`). No scheduler, no auto-retry. */
  scheduler?: (periodMs: number, onTick: () => void) => { stop(): void };
  network?: NetworkStatus;
  random?: () => number;
  /** Duration in seconds of recovered bytes (media element), `null`/non-finite when unknown. */
  probeDuration?: (blob: Blob) => Promise<number | null>;
  /** Called after a chunk is confirmed (segments query invalidation). */
  onConfirmed?: (sessionId: string) => void;
}

export interface RequestFinalizeInput {
  userId?: string | null;
  sessionId: string;
  recordingOrdinal: number;
  windows: string[];
}

/** The backoff tick's period (design D11). */
export const SCHEDULER_TICK_MS = 1_000;

interface InternalChunk extends QueuedChunk {
  /** Failures counted for the backoff (reset by `online`). */
  failures: number;
  ambiguous: boolean;
  /** One user-initiated attempt regardless of classification. */
  retryOnce: boolean;
  /** A `413` sent this chunk to the parts upload; later attempts go there directly. */
  viaParts: boolean;
  seq: number;
  /** Releases the chunk lock this queue holds while it owns the chunk (A.8). */
  releaseLock: (() => void) | null;
  /** A recovered partial chunk whose end is measured from its bytes before its first upload. */
  measure: ChunkManifest | null;
}

interface PendingFinalize {
  userId: string | null;
  sessionId: string;
  recordingOrdinal: number;
  windows: string[];
  failures: number;
  nextAttemptAt: number | null;
}

function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

/**
 * The server's window key: `parseOptionalMarkedAt` (`server/src/routers/_helpers.ts`), i.e.
 * `new Date(Date.parse(raw.trim().replace('+00:00', 'Z'))).toISOString()`.
 */
export function normaliseWindow(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const ms = Date.parse(trimmed.replace('+00:00', 'Z'));
  return Number.isNaN(ms) ? trimmed : new Date(ms).toISOString();
}

const finalizeKey = (sessionId: string, ordinal: number) => `${sessionId}\u0000${ordinal}`;

function compareCapture(a: InternalChunk, b: InternalChunk): number {
  const ta = Date.parse(a.startedAtUtc);
  const tb = Date.parse(b.startedAtUtc);
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
  if (a.sessionId === b.sessionId && a.recordingOrdinal !== b.recordingOrdinal) {
    return a.recordingOrdinal - b.recordingOrdinal;
  }
  if (a.chunkIndex !== b.chunkIndex) return a.chunkIndex - b.chunkIndex;
  return a.seq - b.seq;
}

/** Duration (s) of `bytes` from the slice log's byte rate, or null. */
function durationFromSliceLog(m: ChunkManifest, bytes: number): number | null {
  const start = Date.parse(m.startedAtUtc);
  const last = m.sliceLog[m.sliceLog.length - 1];
  if (!last || !Number.isFinite(start)) return null;
  const logged = m.sliceLog.reduce((s, e) => s + e.bytes, 0);
  const spanSec = (last.at - start) / 1000;
  if (logged <= 0 || spanSec <= 0) return null;
  return bytes / (logged / spanSec);
}

export function createChunkUploadQueue(deps: ChunkUploadQueueDeps) {
  const { upload, listSegments, clock } = deps;
  const random = deps.random ?? Math.random;

  let chunks: InternalChunk[] = [];
  const finalizes = new Map<string, PendingFinalize>();
  let inFlight = false;
  /** The running pump's promise (fix-wave F1): a collapsed `pump()` returns it. */
  let current: Promise<void> | null = null;
  const listeners = new Set<QueueListener>();
  let seq = 0;
  let offline = deps.network ? !deps.network.isOnline() : false;
  let ticker: { stop(): void } | null = null;
  let lastHeartbeatAt = 0;
  const recoveries = new Map<string, Promise<{ recovered: number }>>();
  const recoveredUsers = new Set<string>();
  /** The signed-in user; `undefined` until told (then nothing is filtered). */
  let currentUser: string | null | undefined;

  function toSnapshot(): ChunkQueueSnapshot {
    const snapshotChunks: QueuedChunk[] = chunks.map((c) => ({
      key: c.key,
      sessionId: c.sessionId,
      recordingOrdinal: c.recordingOrdinal,
      chunkIndex: c.chunkIndex,
      blob: c.blob,
      bytes: c.bytes,
      storeId: c.storeId,
      startedAtUtc: c.startedAtUtc,
      endedAtUtc: c.endedAtUtc,
      mimeType: c.mimeType,
      classification: c.classification,
      lastError: c.lastError,
      attempts: c.attempts,
      userId: c.userId,
      nextAttemptAt: c.nextAttemptAt,
      recovered: c.recovered,
      partial: c.partial,
      safari: c.safari,
    }));
    const pendingOrdinals = Array.from(new Set(chunks.map((c) => c.recordingOrdinal))).sort(
      (a, b) => a - b,
    );
    return {
      chunks: snapshotChunks,
      inFlight,
      idle: !inFlight && chunks.length === 0,
      pendingOrdinals,
      offline,
      currentUser,
      pendingFinalizes: Array.from(finalizes.values(), (f) => ({
        sessionId: f.sessionId,
        recordingOrdinal: f.recordingOrdinal,
      })),
    };
  }

  /** Run the backoff tick only while something is pending. */
  function syncTicker(): void {
    const busy = chunks.length > 0 || finalizes.size > 0;
    if (busy && !ticker && deps.scheduler) {
      ticker = deps.scheduler(SCHEDULER_TICK_MS, onTick);
    } else if (!busy && ticker) {
      ticker.stop();
      ticker = null;
    }
  }

  function notify(): void {
    syncTicker();
    const snapshot = toSnapshot();
    for (const listener of listeners) listener(snapshot);
  }

  const due = (at: number | null) => at === null || at <= clock.now();
  const holdsOrdinal = (sessionId: string, ordinal: number) =>
    chunks.some((c) => c.sessionId === sessionId && c.recordingOrdinal === ordinal);

  function scheduleRetry(c: { failures: number; nextAttemptAt: number | null }): void {
    c.failures += 1;
    c.nextAttemptAt = clock.now() + backoffDelayMs(c.failures, random);
  }

  /** Pending chunk-lock acquisitions (`whenOwned`). */
  const owning = new Set<Promise<void>>();

  /**
   * Hold the chunk's Web Lock for as long as this queue owns the chunk — through backoff,
   * offline and blocked, not only during an attempt — so another tab's scan never recovers it
   * (A.8). When another tab already holds it, the chunk is checked against the server first.
   */
  function own(record: InternalChunk): void {
    const locks = deps.locks;
    if (locks?.mode !== 'locks' || !record.storeId) return;
    const p = locks.holdChunk(record.storeId).then((release) => {
      if (!release) {
        record.ambiguous = true;
        return;
      }
      if (chunks.includes(record)) record.releaseLock = release;
      else release();
    });
    owning.add(p);
    void p.finally(() => owning.delete(p));
  }

  function disown(record: InternalChunk): void {
    const release = record.releaseLock;
    record.releaseLock = null;
    release?.();
  }

  /** Settles once every chunk lock this queue is acquiring is held. */
  async function whenOwned(): Promise<void> {
    await Promise.all(Array.from(owning));
  }

  /** A chunk this tab may upload: never another user's (the request carries this user's cookie). */
  const mayUpload = (c: InternalChunk) =>
    currentUser === undefined || c.userId === null || c.userId === currentUser;

  function setCurrentUser(userId: string | null): void {
    currentUser = userId;
    notify();
  }

  /** Drop every chunk and pending finalize of `userId` (sign-out wipes their storage). */
  function discardUser(userId: string): void {
    for (const c of chunks.slice()) if (c.userId === userId) void discardChunk(c.key);
    for (const [k, f] of Array.from(finalizes)) if (f.userId === userId) finalizes.delete(k);
    notify();
  }

  function enqueueInternal(
    input: ChunkInput,
    flags: { ambiguous?: boolean; measure?: ChunkManifest; held?: () => void } = {},
  ): InternalChunk | null {
    const size = input.blob ? input.blob.size : (input.bytes ?? 0);
    if (size === 0) return null;
    seq += 1;
    const record: InternalChunk = {
      key:
        input.storeId ?? `${input.sessionId}:${input.recordingOrdinal}:${input.chunkIndex}:${seq}`,
      sessionId: input.sessionId,
      recordingOrdinal: input.recordingOrdinal,
      chunkIndex: input.chunkIndex,
      blob: input.blob ?? null,
      bytes: size,
      storeId: input.storeId ?? null,
      userId: input.userId ?? null,
      startedAtUtc: input.startedAtUtc,
      endedAtUtc: input.endedAtUtc,
      mimeType: input.mimeType,
      classification: 'queued',
      lastError: null,
      attempts: 0,
      nextAttemptAt: null,
      recovered: input.recovered === true,
      partial: input.partial === true,
      safari: input.safari === true,
      failures: 0,
      ambiguous: flags.ambiguous === true,
      retryOnce: false,
      viaParts: false,
      seq,
      measure: null,
      releaseLock: null,
    };
    record.measure = flags.measure ?? null;
    chunks.push(record);
    chunks.sort(compareCapture);
    if (record.storeId && !flags.held) own(record);
    else if (flags.held) record.releaseLock = flags.held;
    return record;
  }

  /** Enqueue a captured chunk. Zero-byte chunks are rejected (`false`). */
  function enqueue(input: ChunkInput): boolean {
    const record = enqueueInternal(input);
    if (!record) return false;
    notify();
    return true;
  }

  /** The earliest chunk eligible for an attempt: `queued`, or given one attempt by Retry. */
  function nextAttemptable(): InternalChunk | undefined {
    return chunks.find((c) => (c.classification === 'queued' || c.retryOnce) && mayUpload(c));
  }

  type DedupeResult = 'confirmed' | 'not-found' | 'lookup-failed' | 'blocked';

  async function resolveAmbiguous(chunk: InternalChunk): Promise<DedupeResult> {
    let existing: ExistingSegment[];
    try {
      existing = await listSegments(chunk.sessionId);
    } catch (err) {
      const status = extractStatus(err);
      // Signed out: retrying the lookup on its own can never succeed (A.8).
      return status === 401 || status === 403 ? 'blocked' : 'lookup-failed';
    }
    const want = normaliseWindow(chunk.startedAtUtc);
    const found = existing.some(
      (seg) =>
        seg.recording_ordinal === chunk.recordingOrdinal &&
        (normaliseWindow(seg.started_at_utc) === want ||
          (seg.seams ?? []).some((seam) => normaliseWindow(seam.started_at_utc) === want)),
    );
    return found ? 'confirmed' : 'not-found';
  }

  async function confirmChunk(chunk: InternalChunk): Promise<void> {
    if (chunk.storeId && deps.store && chunk.userId) {
      try {
        await deps.store.remove(chunk.userId, chunk.storeId);
      } catch {
        /* the 30-day cleanup removes a leftover; the dedupe stops a re-upload */
      }
    }
    chunks = chunks.filter((c) => c !== chunk);
    disown(chunk);
    deps.onConfirmed?.(chunk.sessionId);
    notify();
  }

  async function bytesOf(chunk: InternalChunk): Promise<Blob> {
    if (chunk.blob) return chunk.blob;
    if (!chunk.storeId || !chunk.userId || !deps.store) {
      throw new Error('This chunk has no bytes attached.');
    }
    return deps.store.read(chunk.userId, chunk.storeId);
  }

  type Step = 'continue' | 'stop';

  /** Classify a failed outcome that carried a status (or none, reported by the upload fn). */
  function onFailure(head: InternalChunk, status: number | undefined, message: string): Step {
    head.lastError = message;
    if (status === 401 || status === 403) {
      head.classification = 'blocked';
      head.nextAttemptAt = null;
      return 'continue';
    }
    if (status !== undefined && !isTransientStatus(status)) {
      head.classification = 'permanent';
      head.nextAttemptAt = null;
      return 'continue';
    }
    // Transient (5xx/408/429), or a status-less failure the upload fn reported itself.
    head.classification = 'queued';
    scheduleRetry(head);
    return 'stop';
  }

  /** One attempt for `head` under its chunk lock. */
  async function attempt(head: InternalChunk): Promise<Step> {
    head.retryOnce = false;
    if (head.ambiguous) {
      const result = await resolveAmbiguous(head);
      if (result === 'confirmed') {
        await confirmChunk(head);
        return 'continue';
      }
      if (result === 'blocked') {
        head.classification = 'blocked';
        head.lastError = 'Signed out: the server refused the upload check.';
        head.nextAttemptAt = null;
        return 'continue';
      }
      if (result === 'lookup-failed') {
        // Still unknown: never re-upload blind. The tick tries the lookup again.
        scheduleRetry(head);
        return 'stop';
      }
      head.ambiguous = false;
    }

    const run = async (): Promise<Step> => {
      let blob: Blob;
      try {
        blob = await bytesOf(head);
      } catch {
        // The bytes vanished: most likely another tab uploaded the chunk and removed it. Ask the
        // server before parking it (A.8).
        const result = await resolveAmbiguous(head);
        if (result === 'confirmed') {
          await confirmChunk(head);
          return 'continue';
        }
        if (result === 'lookup-failed') {
          head.ambiguous = true;
          scheduleRetry(head);
          return 'stop';
        }
        head.classification = result === 'blocked' ? 'blocked' : 'permanent';
        head.lastError = 'The locally stored audio for this chunk is no longer available.';
        return 'continue';
      }
      if (head.measure) {
        head.endedAtUtc = await measuredEnd(head.measure, blob);
        head.measure = null;
      }
      if (head.storeId && head.userId && deps.store && deps.locks?.mode === 'heartbeat') {
        await deps.store.touch(head.userId, head.storeId).catch(() => {});
      }
      const payload: UploadChunk = {
        sessionId: head.sessionId,
        recordingOrdinal: head.recordingOrdinal,
        chunkIndex: head.chunkIndex,
        startedAtUtc: head.startedAtUtc,
        endedAtUtc: head.endedAtUtc,
        mimeType: head.mimeType,
        blob,
        storeId: head.storeId ?? undefined,
        userId: head.userId ?? undefined,
        bytes: head.bytes,
        recovered: head.recovered,
        partial: head.partial,
        safari: head.safari,
      };
      head.attempts += 1;
      const send = async (fn: UploadFn): Promise<UploadOutcome | 'network'> => {
        try {
          return await fn(payload);
        } catch (err) {
          const status = extractStatus(err);
          if (status === undefined) {
            head.lastError = errorMessage(err);
            return 'network';
          }
          return { ok: false, status, message: errorMessage(err) };
        }
      };
      const parts = deps.uploadSegmentParts;
      let outcome = await send(head.viaParts && parts ? parts : upload);
      if (
        outcome !== 'network' &&
        !outcome.ok &&
        outcome.status === 413 &&
        !head.viaParts &&
        parts
      ) {
        head.viaParts = true;
        outcome = await send(parts);
      }
      if (outcome === 'network') {
        // Ambiguous: the request may have reached the server. Dedupe before the next attempt.
        head.ambiguous = true;
        head.classification = 'queued';
        scheduleRetry(head);
        return 'stop';
      }
      if (outcome.ok) {
        await confirmChunk(head);
        return 'continue';
      }
      return onFailure(head, outcome.status, outcome.message);
    };

    // The queue already holds this chunk's lock for its whole stay (locks are not re-entrant).
    if (!deps.locks || head.releaseLock) return run();
    const locked = await deps.locks.withChunkLock(head.storeId ?? head.key, run);
    if (locked.acquired) return locked.value;
    // Another tab is uploading this chunk: check the segments list later instead.
    head.ambiguous = true;
    head.lastError = 'Another tab is uploading this chunk.';
    scheduleRetry(head);
    return 'stop';
  }

  async function processFinalizes(auto: boolean): Promise<void> {
    const send = deps.finalize;
    if (!send) return;
    for (const [key, f] of Array.from(finalizes)) {
      if (offline) return;
      if (holdsOrdinal(f.sessionId, f.recordingOrdinal)) continue;
      if (currentUser !== undefined && f.userId !== null && f.userId !== currentUser) continue;
      if (auto && !due(f.nextAttemptAt)) continue;
      try {
        await send(f.sessionId, f.recordingOrdinal, [...f.windows]);
      } catch (err) {
        const status = extractStatus(err);
        const refused =
          status !== undefined && status !== 401 && status !== 403 && !isTransientStatus(status);
        if (!refused) {
          scheduleRetry(f);
          notify();
          continue;
        }
        // 400/404: the server refuses this recording; its reconcile is the fallback (D6).
        console.warn(
          `Recording ${f.recordingOrdinal} could not be finalized (${status}: ${errorMessage(err)}); the server will merge it later.`,
        );
      }
      finalizes.delete(key);
      if (deps.store && f.userId) {
        await deps.store.removeFinalize(f.userId, f.sessionId, f.recordingOrdinal).catch(() => {});
      }
      notify();
    }
  }

  /**
   * Pump the pipeline: attempt the head in a loop until the queue drains or the head needs a
   * later attempt; then send due finalizes. `auto` (the tick) only acts on due items; every
   * explicit trigger (rollover, stop, Retry) attempts the head now. Nothing runs while offline.
   */
  function pump(opts: { auto?: boolean } = {}): Promise<void> {
    if (inFlight) return current ?? Promise.resolve();
    if (offline) return Promise.resolve();
    const run = runPump(opts.auto === true);
    current = run;
    return run;
  }

  async function runPump(auto: boolean): Promise<void> {
    inFlight = true;
    try {
      notify();
      for (;;) {
        if (offline) break;
        const head = nextAttemptable();
        if (!head) break;
        if (auto && !head.retryOnce && !due(head.nextAttemptAt)) break;
        const step = await attempt(head);
        notify();
        if (step === 'stop') break;
      }
      await processFinalizes(auto);
    } finally {
      inFlight = false;
      current = null;
      notify();
    }
  }

  function onTick(): void {
    if (offline || inFlight) return;
    if (deps.locks?.mode === 'heartbeat' && deps.store) {
      const now = clock.now();
      if (now - lastHeartbeatAt >= HEARTBEAT_REFRESH_MS) {
        lastHeartbeatAt = now;
        for (const c of chunks) {
          if (c.storeId && c.userId) void deps.store.touch(c.userId, c.storeId).catch(() => {});
        }
      }
    }
    const head = nextAttemptable();
    const chunkDue = !!head && (head.retryOnce || due(head.nextAttemptAt));
    const finalizeDue = Array.from(finalizes.values()).some(
      (f) => due(f.nextAttemptAt) && !holdsOrdinal(f.sessionId, f.recordingOrdinal),
    );
    if (chunkDue || finalizeDue) void pump({ auto: true });
  }

  /** Retry: one attempt for every chunk, blocked and permanent included, in order. */
  function retryAll(): Promise<void> {
    for (const c of chunks) {
      if (c.classification === 'queued') c.nextAttemptAt = null;
      else c.retryOnce = true;
    }
    for (const f of finalizes.values()) f.nextAttemptAt = null;
    notify();
    return pump();
  }

  /** Retry one chunk (its row's button): one attempt regardless of classification. */
  function retryChunk(key: string): Promise<void> {
    const c = chunks.find((x) => x.key === key);
    if (c) {
      if (c.classification === 'queued') c.nextAttemptAt = null;
      else c.retryOnce = true;
      notify();
    }
    return pump();
  }

  function dropWindow(chunk: InternalChunk): void {
    const fk = finalizeKey(chunk.sessionId, chunk.recordingOrdinal);
    const f = finalizes.get(fk);
    if (!f) return;
    const gone = normaliseWindow(chunk.startedAtUtc);
    f.windows = f.windows.filter((w) => normaliseWindow(w) !== gone);
    const store = deps.store;
    if (f.windows.length > 0) {
      if (store && f.userId) {
        void store
          .saveFinalize(f.userId, {
            sessionId: f.sessionId,
            recordingOrdinal: f.recordingOrdinal,
            windows: f.windows,
          })
          .catch(() => {});
      }
      return;
    }
    finalizes.delete(fk);
    if (store && f.userId) {
      void store.removeFinalize(f.userId, f.sessionId, f.recordingOrdinal).catch(() => {});
    }
  }

  /** Explicit discard of one chunk (after the user confirmed): queue, storage and its window. */
  function discardChunk(key: string): Promise<void> {
    const chunk = chunks.find((c) => c.key === key);
    if (!chunk) return Promise.resolve();
    chunks = chunks.filter((c) => c !== chunk);
    disown(chunk);
    dropWindow(chunk);
    notify();
    // The remaining windows of that recording may now be complete.
    if (finalizes.size > 0) void pump();
    if (chunk.storeId && chunk.userId && deps.store) {
      return deps.store.remove(chunk.userId, chunk.storeId).catch(() => {});
    }
    return Promise.resolve();
  }

  /** Legacy addressing by recording ordinal + chunk index (first match). */
  function discard(recordingOrdinal: number, chunkIndex: number): void {
    const c = chunks.find(
      (x) => x.recordingOrdinal === recordingOrdinal && x.chunkIndex === chunkIndex,
    );
    if (c) void discardChunk(c.key);
  }

  /** Discard every chunk (the caller obtained a confirmation naming the amount). */
  function discardAll(): void {
    for (const c of chunks.slice()) void discardChunk(c.key);
  }

  /** The chunk's bytes (Download). */
  function readChunk(key: string): Promise<Blob> {
    const c = chunks.find((x) => x.key === key);
    if (!c) return Promise.reject(new Error('No such chunk in the queue.'));
    return bytesOf(c);
  }

  /** Record a stopped recording's windows; finalize once its last chunk is confirmed. */
  async function requestFinalize(input: RequestFinalizeInput): Promise<void> {
    const fk = finalizeKey(input.sessionId, input.recordingOrdinal);
    const existing = finalizes.get(fk);
    const windows = existing
      ? Array.from(new Set([...existing.windows, ...input.windows]))
      : [...input.windows];
    if (windows.length === 0) return;
    const record: PendingFinalize = existing ?? {
      userId: input.userId ?? null,
      sessionId: input.sessionId,
      recordingOrdinal: input.recordingOrdinal,
      windows,
      failures: 0,
      nextAttemptAt: null,
    };
    record.windows = windows;
    finalizes.set(fk, record);
    notify();
    if (deps.store && record.userId) {
      await deps.store
        .saveFinalize(record.userId, {
          sessionId: record.sessionId,
          recordingOrdinal: record.recordingOrdinal,
          windows: record.windows,
        })
        .catch(() => {});
    }
    void pump();
  }

  /**
   * A partial chunk's end (D10): its start plus the duration of its stored bytes — probed with a
   * media element, else the slice log's byte rate (Chromium's joined WebM has no duration) —
   * and the manifest's last write only as the fallback.
   */
  async function measuredEnd(m: ChunkManifest, blob: Blob): Promise<string> {
    const start = Date.parse(m.startedAtUtc);
    let sec: number | null = null;
    try {
      const probed = deps.probeDuration ? await deps.probeDuration(blob) : null;
      if (typeof probed === 'number' && Number.isFinite(probed) && probed > 0) sec = probed;
    } catch {
      /* fall back to the slice log */
    }
    if (sec === null) sec = durationFromSliceLog(m, blob.size);
    if (sec === null || !Number.isFinite(start)) return new Date(m.updatedAt).toISOString();
    return new Date(start + Math.round(sec * 1000)).toISOString();
  }

  async function runRecovery(userId: string): Promise<{ recovered: number }> {
    const store = deps.store;
    if (!store) return { recovered: 0 };
    let entries: ChunkManifest[];
    try {
      entries = await store.list(userId);
    } catch {
      return { recovered: 0 };
    }
    const known = new Set(chunks.map((c) => c.storeId).filter(Boolean));
    const recoverable = async (m: ChunkManifest) =>
      deps.locks ? deps.locks.isRecoverable(m) : true;

    // Persisted finalize records first, so chunk groups below merge into them.
    const records = new Map<string, ChunkManifest>();
    for (const m of entries) {
      if (m.kind !== 'finalize' || !(await recoverable(m))) continue;
      records.set(finalizeKey(m.sessionId, m.recordingOrdinal), m);
    }

    const chunkEntries = entries
      .filter((m) => m.kind === 'chunk' && !known.has(m.id))
      .sort((a, b) => {
        const d = Date.parse(a.startedAtUtc) - Date.parse(b.startedAtUtc);
        if (Number.isFinite(d) && d !== 0) return d;
        return a.recordingOrdinal - b.recordingOrdinal || a.chunkIndex - b.chunkIndex;
      });

    let recovered = 0;
    const groups = new Map<string, { latest: ChunkManifest; starts: string[]; empty: string[] }>();
    for (const m of chunkEntries) {
      if (!(await recoverable(m))) continue;
      const gk = finalizeKey(m.sessionId, m.recordingOrdinal);
      const g = groups.get(gk) ?? { latest: m, starts: [], empty: [] };
      if (m.chunkIndex >= g.latest.chunkIndex) g.latest = m;
      groups.set(gk, g);
      if (m.bytes <= 0) {
        g.empty.push(m.startedAtUtc);
        await store.remove(userId, m.id).catch(() => {});
        continue;
      }
      // Own it for its whole stay here; another tab that got there first keeps it.
      let held: (() => void) | undefined;
      if (deps.locks?.mode === 'locks') {
        const release = await deps.locks.holdChunk(m.id);
        if (!release) continue;
        held = release;
      }
      g.starts.push(m.startedAtUtc);
      const partial = !(m.finalized && m.endedAtUtc);
      const added = enqueueInternal(
        {
          sessionId: m.sessionId,
          recordingOrdinal: m.recordingOrdinal,
          chunkIndex: m.chunkIndex,
          startedAtUtc: m.startedAtUtc,
          // Measured from the bytes right before the first upload (never delays the scan).
          endedAtUtc: partial ? new Date(m.updatedAt).toISOString() : (m.endedAtUtc as string),
          mimeType: m.mimeType || 'audio/webm',
          storeId: m.id,
          userId,
          bytes: m.bytes,
          recovered: true,
          partial: !m.finalized,
          safari: m.safari,
        },
        partial ? { ambiguous: true, measure: m, held } : { ambiguous: true, held },
      );
      if (added) recovered += 1;
      else held?.();
    }

    // Every recovered recording is over (its tab is gone): finalize it with its windows.
    const keys = new Set([...records.keys(), ...groups.keys()]);
    for (const fk of keys) {
      if (finalizes.has(fk)) continue;
      const record = records.get(fk);
      const group = groups.get(fk);
      const empty = new Set((group?.empty ?? []).map(normaliseWindow));
      const base = record?.pendingFinalize ?? group?.latest.pendingFinalize ?? group?.starts ?? [];
      const windows = base.filter((w) => !empty.has(normaliseWindow(w)));
      const ref = record ?? group?.latest;
      if (!ref || windows.length === 0) {
        if (record) {
          await store
            .removeFinalize(userId, record.sessionId, record.recordingOrdinal)
            .catch(() => {});
        }
        continue;
      }
      finalizes.set(fk, {
        userId,
        sessionId: ref.sessionId,
        recordingOrdinal: ref.recordingOrdinal,
        windows,
        failures: 0,
        nextAttemptAt: null,
      });
      if (!record) {
        await store
          .saveFinalize(userId, {
            sessionId: ref.sessionId,
            recordingOrdinal: ref.recordingOrdinal,
            windows,
          })
          .catch(() => {});
      }
    }
    notify();
    void pump();
    return { recovered };
  }

  /** Scan the store once per user per page load and enqueue its unlocked entries. */
  function recover(userId: string): Promise<{ recovered: number }> {
    let p = recoveries.get(userId);
    if (!p) {
      p = runRecovery(userId).finally(() => {
        recoveredUsers.add(userId);
      });
      recoveries.set(userId, p);
    }
    return p;
  }

  /** True once this page load's scan for `userId` has completed. */
  function recoveryDone(userId: string): boolean {
    return recoveredUsers.has(userId);
  }

  function subscribe(listener: QueueListener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function getSnapshot(): ChunkQueueSnapshot {
    return toSnapshot();
  }

  function now(): number {
    return clock.now();
  }

  const unsubscribeNetwork = deps.network?.subscribe(
    () => {
      offline = false;
      for (const c of chunks) {
        c.failures = 0;
        if (c.classification === 'queued') c.nextAttemptAt = null;
      }
      for (const f of finalizes.values()) {
        f.failures = 0;
        f.nextAttemptAt = null;
      }
      notify();
      void pump();
    },
    () => {
      offline = true;
      notify();
    },
  );

  /** Stop the tick and the network subscription (tests; the singleton lives with the tab). */
  function dispose(): void {
    for (const c of chunks) disown(c);
    ticker?.stop();
    ticker = null;
    unsubscribeNetwork?.();
  }

  return {
    enqueue,
    pump,
    retryAll,
    retryChunk,
    discard,
    discardChunk,
    discardAll,
    readChunk,
    requestFinalize,
    recover,
    recoveryDone,
    whenOwned,
    setCurrentUser,
    discardUser,
    subscribe,
    getSnapshot,
    now,
    dispose,
  };
}

export type ChunkUploadQueue = ReturnType<typeof createChunkUploadQueue>;

function extractStatus(err: unknown): number | undefined {
  if (err && typeof err === 'object' && 'status' in err) {
    const s = (err as { status?: unknown }).status;
    if (typeof s === 'number') return s;
  }
  return undefined;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------------------------------------------------------------------------
// Production dependencies and the module-owned singleton.
// ---------------------------------------------------------------------------

/** Listeners told after any chunk is confirmed (the recorder invalidates the segments query). */
const confirmedListeners = new Set<(sessionId: string) => void>();

export function onChunkConfirmed(listener: (sessionId: string) => void): () => void {
  confirmedListeners.add(listener);
  return () => {
    confirmedListeners.delete(listener);
  };
}

/** Duration (s) of recorded bytes from a media element; `null` when not finite (Chromium WebM). */
export function probeMediaDuration(blob: Blob, timeoutMs = 3_000): Promise<number | null> {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const el = document.createElement('audio');
    let settled = false;
    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      el.removeAttribute('src');
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    el.preload = 'metadata';
    el.onloadedmetadata = () => finish(Number.isFinite(el.duration) ? el.duration : null);
    el.onerror = () => finish(null);
    el.src = url;
  });
}

function browserNetwork(): NetworkStatus | undefined {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return undefined;
  return {
    isOnline: () => navigator.onLine !== false,
    subscribe(onOnline, onOffline) {
      window.addEventListener('online', onOnline);
      window.addEventListener('offline', onOffline);
      return () => {
        window.removeEventListener('online', onOnline);
        window.removeEventListener('offline', onOffline);
      };
    },
  };
}

/** A failure carrying an HTTP-like status the queue classifies (parts upload, A.8). */
export class ChunkUploadError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ChunkUploadError';
  }
}

/**
 * The `413` fallback (D11/D12): one live chunk through the resumable parts upload in segment
 * mode. The upload is remembered per chunk (`resumeKey`), so a retry resumes it instead of
 * opening another (the server allows 2 open uploads per user). A `PartsUploadError` becomes a
 * status the queue classifies: capacity 429 and low disk 507 retry on the backoff, an interrupted
 * resumable upload retries as 503, and a non-resumable failure is terminal (400) and visible.
 */
export async function uploadChunkViaParts(
  chunk: UploadChunk,
  uploader: (opts: PartsUploadOptions) => Promise<{ segmentId: string }> = uploadInParts,
): Promise<UploadOutcome> {
  try {
    const { segmentId } = await uploader({
      sessionId: chunk.sessionId,
      blob: chunk.blob,
      contentType: chunk.mimeType || chunk.blob.type || 'audio/webm',
      completion: {
        mode: 'segment',
        recordingOrdinal: chunk.recordingOrdinal,
        startedAtUtc: chunk.startedAtUtc,
        endedAtUtc: chunk.endedAtUtc,
      },
      resumeKey: `live-chunk:${chunk.storeId ?? `${chunk.sessionId}:${chunk.recordingOrdinal}:${chunk.startedAtUtc}`}`,
    });
    return {
      ok: true,
      segment: {
        id: segmentId,
        recording_ordinal: chunk.recordingOrdinal,
        started_at_utc: chunk.startedAtUtc,
      },
    };
  } catch (err) {
    if (err instanceof PartsUploadError) {
      const status =
        err.kind === 'capacity'
          ? 429
          : err.kind === 'disk'
            ? 507
            : err.kind === 'rejected'
              ? (err.status ?? 400)
              : err.resumable
                ? 503
                : 400;
      throw new ChunkUploadError(status, `Large-chunk upload: ${err.message}`);
    }
    throw err;
  }
}

/** The real dependencies: the segment POST, the segments list, finalize, parts, store, locks. */
export function createDefaultChunkUploadQueueDeps(): ChunkUploadQueueDeps {
  return {
    upload: async (chunk) => {
      const params = new URLSearchParams({
        started_at_utc: chunk.startedAtUtc,
        ended_at_utc: chunk.endedAtUtc,
        recording_ordinal: String(chunk.recordingOrdinal),
      });
      const seg = await apiFetch<AudioSegment>(
        `sessions/${chunk.sessionId}/audio/segments?${params.toString()}`,
        {
          method: 'POST',
          headers: { 'Content-Type': chunk.mimeType || 'audio/webm' },
          body: chunk.blob,
        },
      );
      return {
        ok: true as const,
        segment: {
          id: seg.id,
          recording_ordinal: seg.recording_ordinal,
          started_at_utc: seg.started_at_utc,
        },
      };
    },
    uploadSegmentParts: (chunk) => uploadChunkViaParts(chunk),
    listSegments: async (sessionId: string) =>
      (await apiFetch<AudioSegmentsResponse>(`sessions/${sessionId}/audio/segments`)).segments,
    finalize: (sessionId, recordingOrdinal, windows) =>
      apiFetch<RecordingFinalizeResponse>(
        `sessions/${sessionId}/audio/recordings/${recordingOrdinal}/finalize`,
        { method: 'POST', body: JSON.stringify({ chunks: windows }) },
      ),
    clock: { now: () => Date.now() },
    store: getChunkStore(),
    locks: createRecorderLocks({ locks: browserLockManager(), now: () => Date.now() }),
    scheduler: (period, onTick) => createWorkerInterval(period, onTick),
    network: browserNetwork(),
    probeDuration: (blob) => probeMediaDuration(blob),
    onConfirmed: (sessionId) => {
      for (const l of confirmedListeners) l(sessionId);
    },
  };
}

// ---------------------------------------------------------------------------
// Module-owned singleton registry — survives AudioRecorder unmount/remount and session switches
// (chunked-live-recording D6). One queue per tab; chunks carry their own session id.
// ---------------------------------------------------------------------------

let singleton: ChunkUploadQueue | null = null;

/**
 * Listeners notified the moment the singleton comes into existence, so a module that must NOT
 * construct the queue itself (`chunkLeaveWarning.ts`, which keeps the page bfcache-eligible until
 * a recording exists) still observes it from its first moment.
 */
const creationListeners = new Set<(queue: ChunkUploadQueue) => void>();

/** Subscribe to singleton construction; a late registrant is called back at once. */
export function onChunkUploadQueueCreated(cb: (queue: ChunkUploadQueue) => void): () => void {
  if (singleton) cb(singleton);
  creationListeners.add(cb);
  return () => {
    creationListeners.delete(cb);
  };
}

/**
 * Get (lazily creating) the tab's chunk upload queue. With no `deps` it is built with the real
 * dependencies (media-worker A.3: there is no placeholder that throws, so whichever component
 * renders first builds a working queue). `deps` is a test seam and only counts on construction.
 */
export function getChunkUploadQueue(deps?: ChunkUploadQueueDeps): ChunkUploadQueue {
  if (!singleton) {
    singleton = createChunkUploadQueue(deps ?? createDefaultChunkUploadQueueDeps());
    for (const listener of creationListeners) listener(singleton);
  }
  return singleton;
}

/** Read the singleton WITHOUT constructing it (`null` before any recording in this tab). */
export function peekChunkUploadQueue(): ChunkUploadQueue | null {
  return singleton;
}

/** Test seam: drop the singleton so the next `getChunkUploadQueue()` builds a fresh one. */
export function resetChunkUploadQueueForTesting(): void {
  singleton?.dispose();
  singleton = null;
}
