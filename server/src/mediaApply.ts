// The API applies worker results (OpenSpec change `media-worker`, design D3, D5, D7, D8;
// media-processing "The API applies worker results"). The worker only computes: it writes files
// under `BLOB_DIR/media/<job id>/` and a `result_json`. This loop, in the API process, turns each
// `done` job into catalog changes through the session hub as the reviewed system caller
// `media-apply`:
// - the result is validated first (peaks 8..4096 numbers in [0, 1], a positive integer
//   `duration_ms`, every file key `media/<job id>/<one plain name>`); an invalid one fails the job
//   `invalid-result` and changes nothing;
// - a worker file is adopted by handle and copied (`MediaBlobStore.adoptCopy`: `lstat` of the job
//   directory, `O_NOFOLLOW`, `fstat` of the handle, owner = the worker's uid, size cap) into a key
//   derived from the job (the FLAC keeps its segment's id; the merged segment's id is
//   `mergedSegmentId(job id)`), so an apply retried after a crash between the copy and the commit
//   finds the copy in place and does not repeat it;
// - the rows change in one hub transaction that also marks the job `applied` (a merge waits while a
//   transcript-generation or YouTube run lease is held, and is cancelled and re-enqueued when the
//   recording's segments changed);
// - replaced blobs are moved to the trash (`.trash/<date>/<key>`, swept after 7 days), taken from
//   the re-read rows, never from the result.
// Jobs that failed for good (worker failures and invalid results) set their segment's
// `media_status = 'failed'` once; `applied_at_ms` records that it was done. Polls every 10 s and runs
// at once on a wake-up (`media_jobs_done`).

import type {
  MediaBlobStore,
  MediaErrorCode,
  MediaIngestResult,
  MediaJob,
  MediaJobsPort,
  MediaMergeResult,
  MediaSql,
} from '@autologger/ports/media';
import {
  mergedSegmentId,
  type SessionHubFacade,
  type SessionHubRegistryFacade,
  segmentBlobKey,
  systemCaller,
} from '@autologger/session-core';
import { MediaAdoptError } from '@autologger/storage';
import { mediaJobFromRow } from '@autologger/storage/mediaJobs';
import { MEDIA_ADOPT_MAX_BYTES } from '@autologger/storage/mediaLimits';

/** The worker's uid (media-worker D4): the owner every adopted file must have. */
export const MEDIA_WORKER_UID = 10001;
/** The apply loop's poll interval (D3). */
export const MEDIA_APPLY_INTERVAL_MS = 10_000;

const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MERGE_MIMES = new Set(['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/flac', 'audio/wav']);

export interface MediaApplyDeps {
  /** A `catalog_system` binding (reason `media-apply`). */
  db: MediaSql;
  jobs: MediaJobsPort;
  sessions: SessionHubRegistryFacade;
  blobs: MediaBlobStore;
  clock: { now(): number };
  /** The owner adopted files must have; tests pass their own uid. */
  workerUid?: number;
  log?: (msg: string, err?: unknown) => void;
}

type Invalid = { ok: false };
const INVALID: Invalid = { ok: false };

function isInt(v: unknown, min: number): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= min;
}

function validPeaks(v: unknown): v is number[] {
  return (
    Array.isArray(v) &&
    v.length >= 8 &&
    v.length <= 4096 &&
    v.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1)
  );
}

/** A worker file key: exactly `media/<job id>/<one plain name>`. */
export function validMediaKey(jobId: string, key: unknown): key is string {
  if (typeof key !== 'string') return false;
  const parts = key.split('/');
  return (
    parts.length === 3 &&
    parts[0] === 'media' &&
    parts[1] === jobId &&
    PLAIN_NAME.test(parts[2] as string) &&
    !(parts[2] as string).includes('..')
  );
}

/** Parses and validates an ingest result (D3, D5). */
export function validateIngestResult(
  jobId: string,
  json: string | null,
): { ok: true; value: MediaIngestResult } | Invalid {
  let r: unknown;
  try {
    r = JSON.parse(json ?? '');
  } catch {
    return INVALID;
  }
  if (!r || typeof r !== 'object') return INVALID;
  const o = r as Record<string, unknown>;
  if (!isInt(o.duration_ms, 1) || !validPeaks(o.peaks)) return INVALID;
  let flac: MediaIngestResult['flac'] = null;
  if (o.flac !== null && o.flac !== undefined) {
    const f = o.flac as Record<string, unknown>;
    if (typeof f !== 'object' || !validMediaKey(jobId, f.key) || f.mime !== 'audio/flac') {
      return INVALID;
    }
    flac = { key: f.key, mime: 'audio/flac' };
  }
  return {
    ok: true,
    value: {
      duration_ms: o.duration_ms,
      peaks: o.peaks,
      codec: String(o.codec ?? ''),
      sample_rate: Number(o.sample_rate ?? 0),
      channels: Number(o.channels ?? 0),
      flac,
    },
  };
}

/** Parses and validates a merge result (D3, D7). */
export function validateMergeResult(
  jobId: string,
  json: string | null,
): { ok: true; value: MediaMergeResult } | Invalid {
  let r: unknown;
  try {
    r = JSON.parse(json ?? '');
  } catch {
    return INVALID;
  }
  if (!r || typeof r !== 'object') return INVALID;
  const o = r as Record<string, unknown>;
  if (!validMediaKey(jobId, o.key)) return INVALID;
  if (typeof o.mime !== 'string' || !MERGE_MIMES.has(o.mime)) return INVALID;
  if (!isInt(o.duration_ms, 1) || !validPeaks(o.peaks)) return INVALID;
  if (!Array.isArray(o.input_ids) || o.input_ids.length < 1) return INVALID;
  if (!o.input_ids.every((x) => typeof x === 'string' && x.length > 0)) return INVALID;
  if (!Array.isArray(o.seams) || o.seams.length < 1) return INVALID;
  const seen = new Set<string>();
  for (const s of o.seams as unknown[]) {
    const x = s as Record<string, unknown>;
    if (!x || typeof x !== 'object') return INVALID;
    if (!isInt(x.offset_ms, 0) || typeof x.started_at_utc !== 'string') return INVALID;
    if (x.ended_at_utc !== null && typeof x.ended_at_utc !== 'string') return INVALID;
    if (typeof x.source_key !== 'string') return INVALID;
    if (seen.has(x.started_at_utc)) return INVALID;
    seen.add(x.started_at_utc);
  }
  const verify = (o.verify ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    value: {
      key: o.key,
      mime: o.mime,
      duration_ms: o.duration_ms,
      peaks: o.peaks,
      seams: o.seams as MediaMergeResult['seams'],
      input_ids: o.input_ids as string[],
      verify: {
        merged_samples: Number(verify.merged_samples ?? 0),
        expected_samples: Number(verify.expected_samples ?? 0),
      },
    },
  };
}

export type ApplyOutcome = 'applied' | 'cancelled' | 'deferred' | 'failed' | 'stale' | 'error';

function log(deps: MediaApplyDeps, msg: string, err?: unknown): void {
  (deps.log ?? ((m: string, e?: unknown) => console.error(m, e ?? '')))(msg, err);
}

async function hubFor(deps: MediaApplyDeps, sessionId: string): Promise<SessionHubFacade | null> {
  try {
    return (await deps.sessions.get(sessionId)).as(systemCaller('media-apply'));
  } catch {
    return null;
  }
}

async function fail(deps: MediaApplyDeps, job: MediaJob, error: MediaErrorCode): Promise<'failed'> {
  await deps.jobs.markFailed(deps.db, job.id, error, deps.clock.now());
  await deps.blobs.removeMediaJobDir(job.id).catch(() => {});
  return 'failed';
}

async function cancel(
  deps: MediaApplyDeps,
  job: MediaJob,
  error: MediaErrorCode,
): Promise<'cancelled'> {
  await deps.jobs.markCancelled(deps.db, job.id, error, deps.clock.now());
  await deps.blobs.removeMediaJobDir(job.id).catch(() => {});
  return 'cancelled';
}

async function adopt(deps: MediaApplyDeps, mediaKey: string, key: string): Promise<boolean> {
  try {
    await deps.blobs.adoptCopy(mediaKey, key, {
      maxBytes: MEDIA_ADOPT_MAX_BYTES,
      ownerUid: deps.workerUid ?? MEDIA_WORKER_UID,
    });
    return true;
  } catch (err) {
    if (err instanceof MediaAdoptError) return false;
    throw err;
  }
}

async function trash(deps: MediaApplyDeps, keys: readonly string[]): Promise<void> {
  for (const k of keys) {
    try {
      await deps.blobs.trash(k, deps.clock.now());
    } catch (err) {
      log(deps, '[media-apply] trashing a replaced blob failed', err);
    }
  }
}

/** Applies one `done` ingest job (D5). */
export async function applyIngestJob(deps: MediaApplyDeps, job: MediaJob): Promise<ApplyOutcome> {
  const parsed = validateIngestResult(job.id, job.resultJson);
  if (!parsed.ok) return fail(deps, job, 'invalid-result');
  const r = parsed.value;
  const hub = await hubFor(deps, job.sessionId);
  if (hub === null) return cancel(deps, job, 'inputs-changed');
  const seg = await hub.getAudioSegment(job.target);
  if (seg === null) return cancel(deps, job, 'inputs-changed');
  let flac: { key: string; mime: string } | null = null;
  if (r.flac) {
    const key = segmentBlobKey(job.sessionId, seg.ordinal, seg.id, 'audio/flac');
    // A retried apply whose swap already committed: the row names the FLAC already.
    if (seg.r2_key !== key && !(await adopt(deps, r.flac.key, key))) {
      return fail(deps, job, 'invalid-result');
    }
    flac = { key, mime: 'audio/flac' };
  }
  const out = await hub.applyMediaIngest(job.id, {
    segmentId: seg.id,
    durationMs: r.duration_ms,
    peaks: r.peaks,
    flac,
  });
  await deps.blobs.removeMediaJobDir(job.id).catch(() => {});
  if (out.kind === 'applied') {
    if (out.replacedKey) await trash(deps, [out.replacedKey]);
    return 'applied';
  }
  if (out.kind === 'cancelled' && flac) await trash(deps, [flac.key]);
  return out.kind;
}

/** Applies one `done` merge job (D7). */
export async function applyMergeJob(deps: MediaApplyDeps, job: MediaJob): Promise<ApplyOutcome> {
  const parsed = validateMergeResult(job.id, job.resultJson);
  if (!parsed.ok) return fail(deps, job, 'invalid-result');
  const r = parsed.value;
  const ordinal = Number(job.target);
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) return fail(deps, job, 'invalid-result');
  const hub = await hubFor(deps, job.sessionId);
  if (hub === null) return cancel(deps, job, 'inputs-changed');
  if (await hub.mediaRunLeaseHeld()) return 'deferred';
  const segs = await hub.segmentsOfRecording(ordinal);
  const mergedId = mergedSegmentId(job.id);
  const first = segs[0];
  const key = segmentBlobKey(job.sessionId, first ? first.ordinal : 1, mergedId, r.mime);
  const same =
    segs.length === r.input_ids.length &&
    [...segs.map((s) => s.id)].sort().join('\n') === [...r.input_ids].sort().join('\n');
  // Copy only when the swap can happen; the transaction re-checks everything.
  const copied = same ? await adopt(deps, r.key, key) : false;
  if (same && !copied) return fail(deps, job, 'invalid-result');
  const out = await hub.applyMediaMerge(job.id, {
    recordingOrdinal: ordinal,
    mergedId,
    key,
    mime: r.mime,
    durationMs: r.duration_ms,
    peaks: r.peaks,
    seams: r.seams.map((s) => ({
      offsetMs: s.offset_ms,
      startedAtUtc: s.started_at_utc,
      endedAtUtc: s.ended_at_utc,
      sourceKey: s.source_key,
    })),
    inputIds: r.input_ids,
  });
  if (out.kind === 'deferred') return 'deferred';
  await deps.blobs.removeMediaJobDir(job.id).catch(() => {});
  if (out.kind === 'applied') {
    await trash(deps, out.trashKeys);
    return 'applied';
  }
  // Cancelled or refused: the copy names no row, so it goes to the trash too.
  if (copied && (out.kind === 'cancelled' || out.kind === 'invalid')) await trash(deps, [key]);
  return out.kind === 'invalid' ? 'failed' : out.kind;
}

/** Sets the segment of each failed ingest job `failed` once (D5) and clears the job's directory;
 * `applied_at_ms` marks a failed job as reflected. */
export async function applyFailedJobs(deps: MediaApplyDeps, limit = 50): Promise<number> {
  const rows = await deps.db.all<Record<string, unknown>>(
    `SELECT * FROM media_jobs WHERE status = 'failed' AND applied_at_ms IS NULL
      ORDER BY updated_at_ms, id LIMIT ?::int`,
    limit,
  );
  let n = 0;
  for (const job of rows.map(mediaJobFromRow)) {
    try {
      if (job.kind === 'ingest') {
        const hub = await hubFor(deps, job.sessionId);
        await hub?.markMediaFailed(job.target, job.error ?? 'internal');
      }
      await deps.blobs.removeMediaJobDir(job.id).catch(() => {});
      await deps.db.run(
        `UPDATE media_jobs SET applied_at_ms = ? WHERE id = ? AND status = 'failed'`,
        deps.clock.now(),
        job.id,
      );
      n += 1;
    } catch (err) {
      log(deps, '[media-apply] reflecting a failed job failed', err);
    }
  }
  return n;
}

/** One pass: every `done` job (oldest result first), then the failed ones. A job whose apply throws
 * stays `done` for the next pass. */
export async function applyMediaJobsOnce(
  deps: MediaApplyDeps,
  limit = 20,
): Promise<Record<ApplyOutcome, number>> {
  const counts: Record<ApplyOutcome, number> = {
    applied: 0,
    cancelled: 0,
    deferred: 0,
    failed: 0,
    stale: 0,
    error: 0,
  };
  for (const job of await deps.jobs.doneJobs(deps.db, limit)) {
    try {
      const out =
        job.kind === 'merge' ? await applyMergeJob(deps, job) : await applyIngestJob(deps, job);
      counts[out] += 1;
    } catch (err) {
      counts.error += 1;
      log(deps, `[media-apply] applying ${job.kind} job ${job.id} failed; retried next tick`, err);
    }
  }
  await applyFailedJobs(deps);
  return counts;
}

/** The loop (D3): a pass every `intervalMs` and on each `wake()` (the `media_jobs_done`
 * notification); passes never overlap, a wake during a pass runs one more. */
export function startMediaApply(
  deps: MediaApplyDeps,
  opts: { intervalMs?: number } = {},
): { wake(): void; stop(): void; idle(): Promise<void> } {
  // Booleans decide, never a promise (promiseHygiene.repo.test.ts); `current` is only awaited.
  let busy = false;
  let again = false;
  let current: Promise<void> = Promise.resolve();
  const pass = (): void => {
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    current = (async () => {
      try {
        do {
          again = false;
          try {
            await applyMediaJobsOnce(deps);
          } catch (err) {
            log(deps, '[media-apply] pass failed', err);
          }
        } while (again);
      } finally {
        busy = false;
      }
    })();
  };
  const timer = setInterval(pass, opts.intervalMs ?? MEDIA_APPLY_INTERVAL_MS);
  timer.unref?.();
  return {
    wake: pass,
    stop: () => clearInterval(timer),
    idle: async () => {
      await current;
    },
  };
}
