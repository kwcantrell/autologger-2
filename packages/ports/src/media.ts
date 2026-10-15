// Media ports (OpenSpec change `media-worker`, design D2, D3, D7, D12, D18): the shapes of
// `catalog.media_jobs`, `catalog.media_uploads` and `catalog.session_audio_seams`, the worker's
// `result_json`, and the three statement sets `@autologger/storage` implements over them
// (`mediaJobs.ts`, `mediaUploads.ts`, `audioSeams.ts`). Interface-only, like every port.
//
// Every method takes the executor it runs on as its first argument, so a caller decides the
// transaction and the role: session-core passes its session transaction's handle (a user or
// system caller, so the enqueue commits with the segment row that causes it, D2), the API's
// sweeps pass a `catalog_system` binding, and the worker passes its own `autologger_media`
// connection (`postgresMediaSql` in `@autologger/storage/mediaJobs`). `SessionSql` and `CatalogDb`
// both satisfy `MediaSql`. Placeholders are `?`, as in every catalog statement. Times are epoch
// milliseconds from the caller's Clock, like the leases.
//
// Import from `@autologger/ports/media` (the barrel does not re-export it).

/** The statement surface the media statements need: a subset of `SessionSql` and `CatalogDb`. */
export interface MediaSql {
  all<T = Record<string, unknown>>(sql: string, ...binds: (string | number | null)[]): Promise<T[]>;
  run(sql: string, ...binds: (string | number | null)[]): Promise<{ changes: number }>;
}

// -- media_jobs ---------------------------------------------------------------------------------

export type MediaJobKind = 'ingest' | 'merge';
/** `queued`, `running` and `done` are live (one per kind, session and target); the rest are
 * terminal. `done` = the worker's result is waiting for the API's apply step. */
export type MediaJobStatus = 'queued' | 'running' | 'done' | 'applied' | 'failed' | 'cancelled';
/** The classified error codes (D2); never a path or tool output. `inputs-changed` is the apply
 * step's cancel reason for a merge whose inputs moved (D7). */
export type MediaErrorCode =
  | 'decode-failed'
  | 'mixed-codecs'
  | 'verify-mismatch'
  | 'interleaved-input'
  | 'missing-blob'
  | 'timeout'
  | 'low-disk'
  | 'internal'
  | 'invalid-result'
  | 'inputs-changed';

/** One `catalog.media_jobs` row. `target` is the segment id (`ingest`) or the recording ordinal as
 * decimal text (`merge`). */
export interface MediaJob {
  id: string;
  kind: MediaJobKind;
  sessionId: string;
  target: string;
  status: MediaJobStatus;
  attempts: number;
  maxAttempts: number;
  /** Total size of the job's inputs, set at enqueue; the worker's lanes and low-disk rule use it. */
  inputBytes: number;
  runAfterMs: number;
  lockedBy: string | null;
  lockedUntilMs: number | null;
  /** The worker's `MediaJobResult` as JSON (at most 256 KiB, a check constraint). */
  resultJson: string | null;
  error: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  appliedAtMs: number | null;
}

export interface MediaJobEnqueue {
  /** A fresh uuid string. */
  id: string;
  kind: MediaJobKind;
  sessionId: string;
  target: string;
  inputBytes: number;
  nowMs: number;
  /** Defaults to 5 (D2). */
  maxAttempts?: number;
}

/** One seam of a merge result (D7): an input chunk's window and its media offset in the merged
 * file, with the original chunk's blob key. */
export interface MediaSeamResult {
  offset_ms: number;
  started_at_utc: string;
  ended_at_utc: string | null;
  source_key: string;
}

/** An `ingest` job's result (D5). `flac` is set only for a verified 16/24-bit WAV conversion;
 * its key is `media/<job id>/<name>`. */
export interface MediaIngestResult {
  duration_ms: number;
  peaks: number[];
  codec: string;
  sample_rate: number;
  channels: number;
  flac: { key: string; mime: 'audio/flac' } | null;
}

/** A `merge` job's result (D7). `key` is `media/<job id>/<name>`; `input_ids` the segment ids it
 * merged, in order. */
export interface MediaMergeResult {
  key: string;
  mime: string;
  duration_ms: number;
  peaks: number[];
  seams: MediaSeamResult[];
  input_ids: string[];
  verify: { merged_samples: number; expected_samples: number };
}

/** `result_json` parsed, by the job's kind. The apply step validates it before use (D3). */
export type MediaJobResult = MediaIngestResult | MediaMergeResult;

/** API-side statements (as `catalog_system`, or the session transaction's caller for `enqueue`)
 * and worker-side statements (as `autologger_media`; every one after the claim is fenced on
 * `locked_by = workerId AND status = 'running'`, so a lost lease changes nothing). */
export interface MediaJobsPort {
  /** Inserts a `queued` job unless a live job for the same kind, session and target exists (the
   * live unique index; `ON CONFLICT DO NOTHING`), and `NOTIFY media_jobs` (delivered on commit).
   * True when a row was inserted. */
  enqueue(db: MediaSql, job: MediaJobEnqueue): Promise<boolean>;
  /** The job by id, or null. */
  get(db: MediaSql, id: string): Promise<MediaJob | null>;
  /** The live job of this kind, session and target, or null. */
  liveJob(
    db: MediaSql,
    kind: MediaJobKind,
    sessionId: string,
    target: string,
  ): Promise<MediaJob | null>;
  /** `done` jobs, oldest result first, at most `limit` (the apply loop's read). */
  doneJobs(db: MediaSql, limit: number): Promise<MediaJob[]>;
  /** `done` → `applied`; false when the job was not `done`. */
  markApplied(db: MediaSql, id: string, nowMs: number): Promise<boolean>;
  /** A live job → `cancelled` with `error`; false when it was not live. */
  markCancelled(db: MediaSql, id: string, error: MediaErrorCode, nowMs: number): Promise<boolean>;
  /** `done` → `failed` with `error` (the apply step's `invalid-result`); false when not `done`. */
  markFailed(db: MediaSql, id: string, error: MediaErrorCode, nowMs: number): Promise<boolean>;
  /** Deletes `applied`, `failed` and `cancelled` rows last updated before `beforeMs`. */
  deleteTerminalBefore(db: MediaSql, beforeMs: number): Promise<number>;
  /** Whether a `failed` or `cancelled` merge of this recording was updated at or after
   * `sinceMs` (the reconcile's 24 h hold-off, D6). */
  hasRecentTerminalMerge(
    db: MediaSql,
    sessionId: string,
    recordingOrdinal: number,
    sinceMs: number,
  ): Promise<boolean>;

  // Worker side.
  /** Claims the due `queued` job with the earliest `run_after_ms`, then creation, whose
   * `input_bytes <= maxInputBytes` (a lane; `kinds` narrows it, e.g. no `merge` in low-disk
   * mode), with `FOR UPDATE SKIP LOCKED`: `running`, lease `nowMs + leaseMs`, attempts + 1. */
  claim(
    db: MediaSql,
    opts: {
      workerId: string;
      nowMs: number;
      maxInputBytes: number;
      kinds?: readonly MediaJobKind[];
      leaseMs?: number;
    },
  ): Promise<MediaJob | null>;
  /** Extends the lease to `nowMs + leaseMs`; false when the lease was lost. */
  renew(
    db: MediaSql,
    opts: { id: string; workerId: string; nowMs: number; leaseMs?: number },
  ): Promise<boolean>;
  /** `running` → `done` with the result JSON (≤ 256 KiB); false when the lease was lost. */
  finish(
    db: MediaSql,
    opts: { id: string; workerId: string; nowMs: number; resultJson: string },
  ): Promise<boolean>;
  /** `running` → `queued` with backoff `min(30 s × 2^(attempts−1), 1 h)`, or `failed` once
   * `attempts >= max_attempts` (or `final`); false when the lease was lost. */
  fail(
    db: MediaSql,
    opts: {
      id: string;
      workerId: string;
      nowMs: number;
      error: MediaErrorCode;
      final?: boolean;
    },
  ): Promise<boolean>;
  /** Puts a claimed job back without counting the attempt (`low-disk`, shutdown): `queued` at
   * `runAfterMs`; false when the lease was lost. */
  release(
    db: MediaSql,
    opts: {
      id: string;
      workerId: string;
      nowMs: number;
      runAfterMs: number;
      error?: MediaErrorCode | null;
    },
  ): Promise<boolean>;
  /** Every `running` job whose lease expired → `queued` with backoff, or `failed` (`timeout`)
   * once its attempts are spent. Returns how many it changed. */
  requeueExpired(db: MediaSql, nowMs: number): Promise<number>;
}

// -- media_uploads ------------------------------------------------------------------------------

export type MediaUploadStatus = 'open' | 'complete';

/** One `catalog.media_uploads` row (D12). Parts are 1-based. */
export interface MediaUpload {
  id: string;
  sessionId: string;
  createdByUserId: string;
  contentType: string;
  sizeBytes: number;
  partSize: number;
  partsTotal: number;
  /** One 64-hex sha256 per part, in order. */
  partSha256: string[];
  /** Received part numbers, ascending. */
  received: number[];
  status: MediaUploadStatus;
  expiresAtMs: number;
  createdAtMs: number;
}

export interface MediaUploadCreate {
  id: string;
  sessionId: string;
  createdByUserId: string;
  contentType: string;
  sizeBytes: number;
  partSize: number;
  partSha256: string[];
  nowMs: number;
}

export interface MediaUploadsPort {
  /** Inserts an `open` upload expiring `UPLOAD_TTL_MS` after `nowMs`; `parts_total` is the hash
   * list's length. */
  create(db: MediaSql, u: MediaUploadCreate): Promise<MediaUpload>;
  /** The upload by id (any status, expired or not), or null. */
  get(db: MediaSql, id: string): Promise<MediaUpload | null>;
  /** Adds part `n` to `received` (idempotent, atomic under concurrent parts) and pushes the expiry
   * to `nowMs + UPLOAD_TTL_MS`; false when the upload is not open or has expired. */
  recordPart(db: MediaSql, id: string, n: number, nowMs: number): Promise<boolean>;
  /** `open` → `complete`; false when it was not open. */
  markComplete(db: MediaSql, id: string, nowMs: number): Promise<boolean>;
  /** Deletes the row (DELETE route, aborted completion); false when absent. */
  remove(db: MediaSql, id: string): Promise<boolean>;
  /** Deletes every upload whose expiry is at or before `nowMs` (open or complete); returns their
   * ids so the caller removes the staging files. */
  deleteExpired(db: MediaSql, nowMs: number): Promise<string[]>;
  /** The user's `open`, unexpired uploads: their count and declared bytes (the per-user caps). */
  openUsage(db: MediaSql, userId: string, nowMs: number): Promise<{ count: number; bytes: number }>;
}

// -- session_audio_seams ------------------------------------------------------------------------

/** One accepted chunk window (D7, D18): the segment that now holds its audio and the window's
 * media offset in it (0 until a merge), plus the original chunk's blob key. */
export interface AudioSeam {
  sessionId: string;
  recordingOrdinal: number;
  startedAtUtc: string;
  endedAtUtc: string | null;
  segmentId: string;
  offsetMs: number;
  sourceKey: string;
}

export interface AudioSeamsPort {
  /** Inserts the window; a duplicate `(session, recording_ordinal, started_at_utc)` rejects with
   * the database's `23505` (the caller maps it to the existing-segment answer, D18). */
  insert(db: MediaSql, seam: AudioSeam): Promise<void>;
  /** The window's seam, i.e. the segment holding it and the offset, or null. */
  findWindow(
    db: MediaSql,
    sessionId: string,
    recordingOrdinal: number,
    startedAtUtc: string,
  ): Promise<AudioSeam | null>;
  /** Every seam of a recording, by `started_at_utc`. */
  windowsOf(db: MediaSql, sessionId: string, recordingOrdinal: number): Promise<AudioSeam[]>;
  /** The seams pointing at one segment, by `offset_ms`. */
  seamsOfSegment(db: MediaSql, sessionId: string, segmentId: string): Promise<AudioSeam[]>;
  /** Repoints each listed window at `segmentId` with its new offset (the merge apply); returns
   * how many rows moved. */
  repoint(
    db: MediaSql,
    sessionId: string,
    recordingOrdinal: number,
    segmentId: string,
    windows: readonly { startedAtUtc: string; offsetMs: number }[],
  ): Promise<number>;
}

// -- blob store additions -----------------------------------------------------------------------

/** The blob store's media additions (D3, D8, D12), implemented by `@autologger/storage`'s
 * `BlobStore` next to the `BlobStore` port. Keys are blob keys (`audio/<sid>/…`); `mediaPath` is a
 * worker result path `media/<job id>/<name>`. Refusals of a worker file throw the storage
 * package's `MediaAdoptError`; an oversize part throws its `PartTooLargeError`. */
export interface MediaBlobStore {
  /** Creates `media/` mode 1777 (boot). */
  ensureMediaDir(): Promise<void>;
  /** Copies a worker file into `key` by handle (O_NOFOLLOW, fstat: regular, ≤ `maxBytes`, owner
   * `ownerUid` when given), via the store's own put temp file, then removes `media/<job>/`.
   * `copied: false` when `key` already existed (a retried apply). */
  adoptCopy(
    mediaPath: string,
    key: string,
    opts?: { maxBytes?: number; ownerUid?: number },
  ): Promise<{ copied: boolean; bytes: number }>;
  removeMediaJobDir(jobId: string): Promise<void>;
  mediaJobDirs(): Promise<{ jobId: string; mtimeMs: number }[]>;
  /** Moves `key` to `.trash/<yyyy-mm-dd>/<key>`; false when missing. */
  trash(key: string, nowMs: number): Promise<boolean>;
  /** Deletes trash day directories at least `graceMs` (default 7 days) old; returns the count. */
  sweepTrash(nowMs: number, graceMs?: number): Promise<number>;
  /** Deletes trash oldest-first until `bytes` are freed; returns the bytes freed. */
  purgeTrashOldestFirst(bytes: number): Promise<number>;
  /** `statfs` free bytes of the blob root. */
  freeBytes(): Promise<number>;
  /** Creates or reopens `.tmp/upload-<id>`, sparse, `size` bytes. */
  openStaging(id: string, size: number): Promise<void>;
  /** Writes a part at `offset` while hashing it; returns its size and hex sha256. */
  writePart(
    id: string,
    offset: number,
    body: Uint8Array | AsyncIterable<Uint8Array>,
    opts?: { maxBytes?: number },
  ): Promise<{ bytes: number; sha256: string }>;
  /** The staging file's size and per-part sha256 list. */
  rehashParts(id: string, partSize: number): Promise<{ size: number; sha256: string[] }>;
  /** fsync + rename the staging file into `key`. */
  adoptStaging(id: string, key: string): Promise<void>;
  removeStaging(id: string): Promise<void>;
}
