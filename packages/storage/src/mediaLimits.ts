// Media limits (OpenSpec change `media-worker`, design D2, D3, D8, D12): compiled constants the API
// and the media worker both import, never environment variables, so the worker's environment stays
// the five connection literals plus BLOB_DIR (D15). Changing one is a reviewed code change.

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Free space on BLOB_DIR below which the API refuses uploads (`507`), the sweep purges trash
 * oldest-first and the worker claims no merge and no job whose inputs twice over exceed the
 * free space (D8). */
export const MEDIA_MIN_FREE_BYTES = 10 * GiB;

/** The small lane claims only jobs with `input_bytes` at most this (D2). */
export const MEDIA_SMALL_LANE_MAX_BYTES = 64 * MiB;
/** A claim's lease; the worker renews it every `MEDIA_JOB_RENEW_MS` while it works (D2). */
export const MEDIA_JOB_LEASE_MS = 10 * MINUTE_MS;
export const MEDIA_JOB_RENEW_MS = MINUTE_MS;
/** Attempts before a job is `failed` (D2; the column default). */
export const MEDIA_JOB_MAX_ATTEMPTS = 5;
/** Retry backoff: `min(base × 2^(attempts−1), cap)` (D2). */
export const MEDIA_JOB_BACKOFF_BASE_MS = 30_000;
export const MEDIA_JOB_BACKOFF_CAP_MS = HOUR_MS;
/** `result_json`'s size cap, also a check constraint on the column (D2). */
export const MEDIA_RESULT_MAX_BYTES = 256 * 1024;
/** Terminal jobs older than this are deleted by the API's sweep (D2). */
export const MEDIA_TERMINAL_JOB_TTL_MS = 7 * DAY_MS;
/** The worker's wall-clock limit per ffmpeg run (D4). */
export const MEDIA_FFMPEG_TIMEOUT_MS = 30 * MINUTE_MS;
/** The largest worker output the API adopts by handle (D3). */
export const MEDIA_ADOPT_MAX_BYTES = 1650 * MiB;

/** Trashed blobs are kept this long (D8). */
export const MEDIA_TRASH_GRACE_MS = 7 * DAY_MS;
/** The reconcile merges a recording whose newest chunk ended this long ago (D6)… */
export const MEDIA_RECONCILE_AFTER_MS = 30 * MINUTE_MS;
/** …unless a merge of it failed or was cancelled within this window (D6). */
export const MEDIA_MERGE_HOLDOFF_MS = DAY_MS;

/** Resumable uploads (D12): the part size, the largest upload, the per-user caps and the expiry
 * after the last part. */
export const UPLOAD_PART_BYTES = 32 * MiB;
export const UPLOAD_MAX_BYTES = 1500 * MiB;
export const UPLOAD_MAX_OPEN_PER_USER = 2;
export const UPLOAD_MAX_STAGED_BYTES_PER_USER = 3 * GiB;
export const UPLOAD_TTL_MS = DAY_MS;

/** The retry delay after the `attempts`-th failed attempt (D2): 30 s, 60 s, … capped at 1 h. */
export function mediaJobBackoffMs(attempts: number): number {
  const n = Math.max(1, Math.floor(attempts));
  return Math.min(MEDIA_JOB_BACKOFF_BASE_MS * 2 ** (n - 1), MEDIA_JOB_BACKOFF_CAP_MS);
}
