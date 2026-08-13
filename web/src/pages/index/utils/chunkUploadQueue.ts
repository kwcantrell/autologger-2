/**
 * Recorder-owned chunk upload pipeline (chunked-live-recording, design D6;
 * spec: live-recording-chunks "Chunk uploads are single-flight and ordered",
 * "Upload failure is surfaced and recoverable", "Rescue and uploads are
 * bound to their recording's session and survive component lifecycle").
 *
 * Pure sequencing/queue/ordering logic — framework-free (no React import),
 * clock and upload injected. `MediaRecorder` wiring stays in
 * `AudioRecorder.tsx` (task 4.2 consumes this module; it does not construct
 * one).
 *
 * **Single-flight, in order.** All triggers — a rollover boundary, the
 * user's Retry, the final stop — call `pump()`, which is the only place an
 * upload attempt starts. `pump()` is re-entrancy-guarded (`inFlight`): a
 * concurrent call while an attempt is already running does not start a
 * second one — it returns the SAME promise as the in-flight attempt (fix-
 * wave F1), so a caller that awaits a collapsed call still observes the
 * real drain outcome rather than a false-immediate resolution. Only the
 * head of the queue (lowest capture index among chunks still eligible for
 * upload — queued or retry-eligible permanent-but-not-yet-classified) is
 * ever attempted; a later chunk is never attempted while an earlier one's
 * outcome is unknown.
 *
 * **Failure classification.** `ApiError` (thrown by `apiFetch`, see
 * `web/src/api/client.ts`) carries an HTTP status: 5xx, 408, and 429 are
 * transient (re-attempted on the next pump); any other 4xx is permanent
 * (set aside as rescue-only, never blocks later chunks). Anything else
 * (a raw network-level `TypeError`, an aborted fetch, or any rejection
 * without a numeric `status`) is treated as **ambiguous** — the request may
 * have reached the server — and is handled via the dedupe hook below rather
 * than assumed transient outright.
 *
 * **Ambiguous-failure dedupe.** Before re-attempting a chunk that
 * previously failed ambiguously, the pipeline calls the injected
 * `listSegments()` and looks for an existing segment sharing the chunk's
 * `recordingOrdinal` and `startedAtUtc`. A match is treated as that chunk's
 * success (no re-upload); no match re-attempts the upload as transient.
 *
 * **Zero-byte chunks are rejected at `enqueue()`** (documented choice, task
 * 4.1): `enqueue()` returns `false` and never adds the chunk to the queue,
 * rather than silently accepting and later skipping it — this keeps "what
 * is in the queue" answerable without a hidden skip rule, and lets the
 * caller (task 4.2) decide what, if anything, to log.
 *
 * **Leaving the queue.** A chunk is removed from the queue only on
 * confirmed success (including dedupe-confirmed success) or an explicit
 * `discard`/`discardAll` call. Nothing in this module auto-discards —
 * permanent classification sets a chunk aside as rescue-only; it does not
 * remove it.
 */

/** A clock the pipeline reads for chunk bookkeeping — never `Date.now()` directly, so tests inject a fake one. */
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

/** A previously-uploaded segment, as returned by the injected `listSegments()` — the shape `useAudioSegments` already exposes, narrowed to the fields dedupe needs. */
export interface ExistingSegment {
  recording_ordinal: number | null;
  started_at_utc: string | null;
}

/** One chunk as captured by the recorder, before it enters the queue. */
export interface ChunkInput {
  sessionId: string;
  recordingOrdinal: number;
  /** 0-based capture order within the recording — the single-flight ordering key. */
  chunkIndex: number;
  blob: Blob;
  startedAtUtc: string;
  endedAtUtc: string;
  mimeType: string;
}

export type ChunkClassification = 'queued' | 'permanent';

/** A chunk's state as tracked by the queue — the shape exposed in snapshots. */
export interface QueuedChunk {
  sessionId: string;
  recordingOrdinal: number;
  chunkIndex: number;
  blob: Blob;
  startedAtUtc: string;
  endedAtUtc: string;
  mimeType: string;
  /** 'queued': eligible for the next pump (fresh, or transient-failed). 'permanent': rescue-only, never auto-retried by pump. */
  classification: ChunkClassification;
  /** Present once at least one attempt has failed; cleared on a fresh enqueue (never happens post-classification, but kept honest). */
  lastError: string | null;
  attempts: number;
}

/** Immutable snapshot of queue state — what the rescue surface and recorder read. */
export interface ChunkQueueSnapshot {
  chunks: QueuedChunk[];
  inFlight: boolean;
  /** True iff there is nothing queued, nothing permanent, and no attempt in flight. */
  idle: boolean;
  /** Distinct recording ordinals held by chunks still in the queue (queued or permanent) — a general snapshot facet for callers that need to know which recordings still have unresolved chunks. Does NOT feed design D8's next-ordinal derivation: `AudioRecorder.tsx` derives that directly from the queue's own `chunks` (session-filtered), not from this field. */
  pendingOrdinals: number[];
}

export type UploadFn = (chunk: ChunkInput) => Promise<UploadOutcome>;
export type ListSegmentsFn = (sessionId: string) => Promise<ExistingSegment[]>;
export type QueueListener = (snapshot: ChunkQueueSnapshot) => void;

export interface ChunkUploadQueueDeps {
  upload: UploadFn;
  listSegments: ListSegmentsFn;
  clock: Clock;
}

/** Internal per-chunk record — carries fields a `QueuedChunk` snapshot copy omits (ambiguous-failure state). */
interface InternalChunk extends QueuedChunk {
  /** Set when the most recent attempt failed ambiguously (no usable status) — the head-of-queue check re-checks via `listSegments()` before re-attempting instead of retrying blind. */
  ambiguous: boolean;
}

function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

/**
 * Construct a chunk upload queue instance. Framework-free: callers own
 * lifetime and identity — see `getChunkUploadQueue` below for the module-
 * scope singleton this repo's coordination modules use (`coordination/
 * registry.ts`, `departureWatcher.ts`), which is what task 4.2's component
 * wiring is expected to consume.
 */
export function createChunkUploadQueue(deps: ChunkUploadQueueDeps) {
  const { upload, listSegments, clock } = deps;

  let chunks: InternalChunk[] = [];
  let inFlight = false;
  /**
   * The currently-running pump's completion promise (fix-wave F1). A
   * collapsed `pump()` call (re-entrancy guard below) returns THIS promise
   * rather than resolving immediately with no signal — callers that need to
   * know when the queue has actually finished draining (e.g. the final-stop
   * drain in `AudioRecorder.tsx`) can `await` a collapsed call and get a
   * real completion signal instead of a false "done" the instant the guard
   * trips.
   */
  let current: Promise<void> | null = null;
  const listeners = new Set<QueueListener>();

  function toSnapshot(): ChunkQueueSnapshot {
    const snapshotChunks: QueuedChunk[] = chunks.map((c) => ({
      sessionId: c.sessionId,
      recordingOrdinal: c.recordingOrdinal,
      chunkIndex: c.chunkIndex,
      blob: c.blob,
      startedAtUtc: c.startedAtUtc,
      endedAtUtc: c.endedAtUtc,
      mimeType: c.mimeType,
      classification: c.classification,
      lastError: c.lastError,
      attempts: c.attempts,
    }));
    const pendingOrdinals = Array.from(new Set(chunks.map((c) => c.recordingOrdinal))).sort(
      (a, b) => a - b,
    );
    return {
      chunks: snapshotChunks,
      inFlight,
      idle: !inFlight && chunks.length === 0,
      pendingOrdinals,
    };
  }

  function notify(): void {
    const snapshot = toSnapshot();
    for (const listener of listeners) listener(snapshot);
  }

  /**
   * Enqueue a captured chunk. Zero-byte blobs are rejected outright (never
   * added to the queue) — returns `false`. Returns `true` on successful
   * enqueue. Chunks are kept sorted by `chunkIndex` so the head is always
   * the earliest un-resolved chunk in capture order.
   */
  function enqueue(input: ChunkInput): boolean {
    if (input.blob.size === 0) return false;
    const record: InternalChunk = {
      sessionId: input.sessionId,
      recordingOrdinal: input.recordingOrdinal,
      chunkIndex: input.chunkIndex,
      blob: input.blob,
      startedAtUtc: input.startedAtUtc,
      endedAtUtc: input.endedAtUtc,
      mimeType: input.mimeType,
      classification: 'queued',
      lastError: null,
      attempts: 0,
      ambiguous: false,
    };
    chunks.push(record);
    chunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
    notify();
    return true;
  }

  /** The earliest chunk still eligible for an upload attempt: 'queued' classification, in capture order. Permanent chunks are skipped — they never block or get auto-retried by pump. */
  function nextAttemptable(): InternalChunk | undefined {
    return chunks.find((c) => c.classification === 'queued');
  }

  /** 'confirmed': a matching segment exists — success. 'not-found': the lookup ran cleanly and found no match — safe to re-attempt now. 'lookup-failed': the lookup itself errored — still unknown, must not re-attempt blind. */
  type DedupeResult = 'confirmed' | 'not-found' | 'lookup-failed';

  async function resolveAmbiguous(chunk: InternalChunk): Promise<DedupeResult> {
    let existing: ExistingSegment[];
    try {
      existing = await listSegments(chunk.sessionId);
    } catch {
      return 'lookup-failed';
    }
    const found = existing.some(
      (seg) =>
        seg.recording_ordinal === chunk.recordingOrdinal &&
        seg.started_at_utc === chunk.startedAtUtc,
    );
    return found ? 'confirmed' : 'not-found';
  }

  /**
   * Pump the pipeline: attempt the queue head, in a loop, until the queue
   * drains or the head is left in a state that requires a fresh pump call
   * (ambiguous-then-still-ambiguous, or all remaining chunks are
   * permanent). Re-entrancy-guarded — concurrent callers (boundary, Retry,
   * final stop) collapse onto whichever call is already running; a second
   * call while `inFlight` is true returns the SAME promise as the running
   * attempt (fix-wave F1) rather than resolving immediately with no
   * signal, so a caller that awaits a collapsed call still observes the
   * real drain outcome.
   */
  function pump(): Promise<void> {
    if (inFlight) return current ?? Promise.resolve();
    const run = runPump();
    current = run;
    return run;
  }

  async function runPump(): Promise<void> {
    inFlight = true;
    try {
      notify();
      // Loop rather than one-attempt-per-call so a single pump() (e.g. the
      // final-stop trigger) drains everything currently attemptable without
      // requiring the caller to re-invoke pump() per chunk.
      for (;;) {
        const head = nextAttemptable();
        if (!head) break;

        if (head.ambiguous) {
          const result = await resolveAmbiguous(head);
          if (result === 'confirmed') {
            chunks = chunks.filter((c) => c !== head);
            notify();
            continue;
          }
          if (result === 'lookup-failed') {
            // The dedupe lookup itself is unreliable right now — stay
            // ambiguous and stop this pump's loop rather than risk a
            // duplicate upload on an unconfirmed chunk. A later pump tries
            // the lookup again.
            notify();
            break;
          }
          // 'not-found': cleanly confirmed as not-yet-uploaded — safe to
          // re-attempt the upload itself below.
          head.ambiguous = false;
        }

        head.attempts += 1;
        let outcome: UploadOutcome;
        try {
          outcome = await upload({
            sessionId: head.sessionId,
            recordingOrdinal: head.recordingOrdinal,
            chunkIndex: head.chunkIndex,
            blob: head.blob,
            startedAtUtc: head.startedAtUtc,
            endedAtUtc: head.endedAtUtc,
            mimeType: head.mimeType,
          });
        } catch (err) {
          const status = extractStatus(err);
          if (status === undefined) {
            // Network-level failure — ambiguous: the request may have
            // reached the server. Stay queued; mark for dedupe-check on the
            // next attempt instead of blind retry.
            head.ambiguous = true;
            head.lastError = errorMessage(err);
            notify();
            break;
          }
          outcome = { ok: false, status, message: errorMessage(err) };
        }

        if (outcome.ok) {
          chunks = chunks.filter((c) => c !== head);
          notify();
          continue;
        }

        if (outcome.status !== undefined && !isTransientStatus(outcome.status)) {
          head.classification = 'permanent';
          head.lastError = outcome.message;
          notify();
          continue;
        }

        // Transient (5xx/408/429) or status-less non-network failure the
        // upload fn reported directly: stay queued, re-attempted on the
        // next pump — but stop this pump's loop so it doesn't spin forever
        // against a live failure.
        head.lastError = outcome.message;
        notify();
        break;
      }
    } finally {
      inFlight = false;
      current = null;
      notify();
    }
  }

  /** Explicit per-chunk discard — the only way (besides confirmed success) a chunk leaves the queue. Identifies the chunk by recordingOrdinal + chunkIndex. */
  function discard(recordingOrdinal: number, chunkIndex: number): void {
    chunks = chunks.filter(
      (c) => !(c.recordingOrdinal === recordingOrdinal && c.chunkIndex === chunkIndex),
    );
    notify();
  }

  /** Explicit discard-all — requires the caller to have already obtained confirmation naming the amount discarded (the confirmation UI lives in the rescue surface, task 5.1; this module never auto-discards). */
  function discardAll(): void {
    chunks = [];
    notify();
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

  // Exposed for tests / advanced callers that need to reason about "now"
  // consistently with this queue's injected clock, without reaching back
  // into deps themselves.
  function now(): number {
    return clock.now();
  }

  return {
    enqueue,
    pump,
    discard,
    discardAll,
    subscribe,
    getSnapshot,
    now,
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
// Module-owned singleton registry — survives AudioRecorder unmount/remount
// and session switches (design D6, spec "Rescue and uploads are bound to
// their recording's session and survive component lifecycle"). Follows the
// same convention as `coordination/registry.ts` and `departureWatcher.ts`:
// plain module-scope state, never a `window` global. One queue instance per
// browser tab (not per session) — chunks already carry `sessionId` bound at
// their recording's start (D3/spec), so a single queue instance uploading
// to multiple sessions' worth of stragglers is correct by construction; the
// recorder does not need a fresh instance per session switch.
// ---------------------------------------------------------------------------

let singleton: ChunkUploadQueue | null = null;

/**
 * Get (lazily creating) the process-wide chunk upload queue. `deps` is only
 * consulted on first call — later calls return the existing instance
 * regardless of `deps` (mirrors `SessionHubRegistry#get()`-style lazy
 * singleton lifecycles elsewhere in the repo). Production call sites pass
 * the same `deps` shape every time (bound `upload`/`listSegments` close over
 * the current session id at recording start per chunk, not per queue
 * instance — see `ChunkInput.sessionId`), so this is not observable outside
 * tests.
 */
export function getChunkUploadQueue(deps: ChunkUploadQueueDeps): ChunkUploadQueue {
  if (!singleton) {
    singleton = createChunkUploadQueue(deps);
  }
  return singleton;
}

/**
 * Read the singleton WITHOUT constructing it (never calls `createChunkUploadQueue`,
 * never touches `deps`). `null` when nothing has called `getChunkUploadQueue()`
 * yet in this tab — i.e. no recording has ever started, so there is nothing to
 * warn about. Callers that must not risk winning the first-construction race
 * (task 5.1's `beforeunload` leave-warning, which must work even if it happens
 * to evaluate before `AudioRecorder` does) use this instead of `getChunkUploadQueue`.
 */
export function peekChunkUploadQueue(): ChunkUploadQueue | null {
  return singleton;
}

/** Test seam: drop the singleton so the next `getChunkUploadQueue()` call constructs a fresh instance against fresh deps. Production code never calls this. */
export function resetChunkUploadQueueForTesting(): void {
  singleton = null;
}
