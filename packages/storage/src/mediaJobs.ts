// The media job statements (OpenSpec change `media-worker`, design D2, D3, D6): the MediaJobsPort
// over `catalog.media_jobs`. One module for both sides, so the worker and the API run the same
// statements:
// - API side, on a `catalog_system` binding (or, for `enqueue`, the session transaction of the
//   segment row that causes the job, so the job commits with it);
// - worker side (`claim`, `renew`, `finish`, `fail`, `release`, `requeueExpired`), as
//   `autologger_media` through `postgresMediaSql`. Every statement after the claim is fenced on
//   `locked_by = <worker id> AND status = 'running'` and names the worker as `locked_by`, so a
//   worker whose lease was taken over changes nothing (0 rows) and the guard trigger
//   `media_jobs_worker_guard` accepts it.
// Wake-ups carry no payload: `NOTIFY media_jobs` after an enqueue (delivered on commit),
// `NOTIFY media_jobs_done` after a finish. Statements use unqualified names (the roles'
// search_path is `catalog`) and `?` placeholders.

import type {
  MediaErrorCode,
  MediaJob,
  MediaJobKind,
  MediaJobStatus,
  MediaJobsPort,
  MediaSql,
} from '@autologger/ports/media';
import type postgres from 'postgres';
import {
  MEDIA_JOB_BACKOFF_BASE_MS,
  MEDIA_JOB_BACKOFF_CAP_MS,
  MEDIA_JOB_LEASE_MS,
  MEDIA_JOB_MAX_ATTEMPTS,
} from './mediaLimits';
import { toPg } from './postgresCatalogStore';

const KINDS: readonly MediaJobKind[] = ['ingest', 'merge'];
const LIVE = `status IN ('queued', 'running', 'done')`;
const FENCE = `id = ? AND locked_by = ? AND status = 'running'`;
/** The run-after time of a re-queue after `attempts` failed attempts: `now + backoff` (D2). */
const BACKOFF = `?::bigint + LEAST(${MEDIA_JOB_BACKOFF_BASE_MS}::float8 * power(2, GREATEST(attempts - 1, 0)), ${MEDIA_JOB_BACKOFF_CAP_MS}::float8)::bigint`;

/** A postgres.js client as a `MediaSql` (the worker's connection; `?` → `$n`, outside quotes and
 * comments, like the catalog adapter). Int8 columns come back as strings unless the client parses
 * them; the row mappers here accept either. */
export function postgresMediaSql(sql: postgres.Sql): MediaSql {
  return {
    async all<T>(text: string, ...binds: (string | number | null)[]): Promise<T[]> {
      return [...(await sql.unsafe(toPg(text), binds))] as T[];
    },
    async run(text: string, ...binds: (string | number | null)[]) {
      const r = await sql.unsafe(toPg(text), binds);
      return { changes: r.count };
    },
  };
}

type Row = Record<string, unknown>;
const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export function mediaJobFromRow(r: Row): MediaJob {
  return {
    id: String(r.id),
    kind: String(r.kind) as MediaJobKind,
    sessionId: String(r.session_id),
    target: String(r.target),
    status: String(r.status) as MediaJobStatus,
    attempts: num(r.attempts),
    maxAttempts: num(r.max_attempts),
    inputBytes: num(r.input_bytes),
    runAfterMs: num(r.run_after_ms),
    lockedBy: strOrNull(r.locked_by),
    lockedUntilMs: numOrNull(r.locked_until_ms),
    resultJson: strOrNull(r.result_json),
    error: strOrNull(r.error),
    createdAtMs: num(r.created_at_ms),
    updatedAtMs: num(r.updated_at_ms),
    appliedAtMs: numOrNull(r.applied_at_ms),
  };
}

function kindsFilter(kinds: readonly MediaJobKind[] | undefined): string {
  const list = (kinds ?? KINDS).filter((k) => KINDS.includes(k));
  if (list.length === 0) return 'false';
  return `kind IN (${list.map((k) => `'${k}'`).join(', ')})`;
}

export const mediaJobs: MediaJobsPort = {
  async enqueue(db, job) {
    const { changes } = await db.run(
      `INSERT INTO media_jobs (id, kind, session_id, target, status, attempts, max_attempts,
         input_bytes, run_after_ms, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?)
       ON CONFLICT (kind, session_id, target) WHERE ${LIVE} DO NOTHING`,
      job.id,
      job.kind,
      job.sessionId,
      job.target,
      job.maxAttempts ?? MEDIA_JOB_MAX_ATTEMPTS,
      job.inputBytes,
      job.nowMs,
      job.nowMs,
      job.nowMs,
    );
    if (changes > 0) await db.all(`SELECT pg_notify('media_jobs', '')`);
    return changes > 0;
  },

  async get(db, id) {
    const [r] = await db.all<Row>('SELECT * FROM media_jobs WHERE id = ?', id);
    return r ? mediaJobFromRow(r) : null;
  },

  async liveJob(db, kind, sessionId, target) {
    const [r] = await db.all<Row>(
      `SELECT * FROM media_jobs WHERE kind = ? AND session_id = ? AND target = ? AND ${LIVE}`,
      kind,
      sessionId,
      target,
    );
    return r ? mediaJobFromRow(r) : null;
  },

  async doneJobs(db, limit) {
    const rows = await db.all<Row>(
      `SELECT * FROM media_jobs WHERE status = 'done' ORDER BY updated_at_ms, id LIMIT ?::int`,
      limit,
    );
    return rows.map(mediaJobFromRow);
  },

  async markApplied(db, id, nowMs) {
    const { changes } = await db.run(
      `UPDATE media_jobs SET status = 'applied', applied_at_ms = ?, updated_at_ms = ?
        WHERE id = ? AND status = 'done'`,
      nowMs,
      nowMs,
      id,
    );
    return changes > 0;
  },

  async markCancelled(db, id, error, nowMs) {
    const { changes } = await db.run(
      `UPDATE media_jobs SET status = 'cancelled', error = ?, updated_at_ms = ?
        WHERE id = ? AND ${LIVE}`,
      error,
      nowMs,
      id,
    );
    return changes > 0;
  },

  async markFailed(db, id, error, nowMs) {
    const { changes } = await db.run(
      `UPDATE media_jobs SET status = 'failed', error = ?, updated_at_ms = ?
        WHERE id = ? AND status = 'done'`,
      error,
      nowMs,
      id,
    );
    return changes > 0;
  },

  async deleteTerminalBefore(db, beforeMs) {
    const { changes } = await db.run(
      `DELETE FROM media_jobs
        WHERE status IN ('applied', 'failed', 'cancelled') AND updated_at_ms < ?`,
      beforeMs,
    );
    return changes;
  },

  async hasRecentTerminalMerge(db, sessionId, recordingOrdinal, sinceMs) {
    const rows = await db.all(
      `SELECT 1 FROM media_jobs
        WHERE kind = 'merge' AND session_id = ? AND target = ?
          AND status IN ('failed', 'cancelled') AND updated_at_ms >= ?
        LIMIT 1`,
      sessionId,
      String(recordingOrdinal),
      sinceMs,
    );
    return rows.length > 0;
  },

  async claim(db, { workerId, nowMs, maxInputBytes, kinds, leaseMs = MEDIA_JOB_LEASE_MS }) {
    const [r] = await db.all<Row>(
      `UPDATE media_jobs
          SET status = 'running', locked_by = ?, locked_until_ms = ?, attempts = attempts + 1,
              updated_at_ms = ?
        WHERE id = (
          SELECT id FROM media_jobs
           WHERE status = 'queued' AND run_after_ms <= ? AND input_bytes <= ?
             AND (locked_until_ms IS NULL OR locked_until_ms <= ?) AND ${kindsFilter(kinds)}
           ORDER BY run_after_ms, created_at_ms, id
           LIMIT 1
           FOR UPDATE SKIP LOCKED)
        RETURNING *`,
      workerId,
      nowMs + leaseMs,
      nowMs,
      nowMs,
      maxInputBytes,
      nowMs,
    );
    return r ? mediaJobFromRow(r) : null;
  },

  async renew(db, { id, workerId, nowMs, leaseMs = MEDIA_JOB_LEASE_MS }) {
    const { changes } = await db.run(
      `UPDATE media_jobs SET locked_by = ?, locked_until_ms = ?, updated_at_ms = ?
        WHERE ${FENCE}`,
      workerId,
      nowMs + leaseMs,
      nowMs,
      id,
      workerId,
    );
    return changes > 0;
  },

  async finish(db, { id, workerId, nowMs, resultJson }) {
    const { changes } = await db.run(
      `UPDATE media_jobs
          SET status = 'done', locked_by = ?, locked_until_ms = NULL, result_json = ?,
              error = NULL, updated_at_ms = ?
        WHERE ${FENCE}`,
      workerId,
      resultJson,
      nowMs,
      id,
      workerId,
    );
    if (changes > 0) await db.all(`SELECT pg_notify('media_jobs_done', '')`);
    return changes > 0;
  },

  async fail(db, { id, workerId, nowMs, error, final = false }) {
    const { changes } = await db.run(
      `UPDATE media_jobs
          SET status = CASE WHEN attempts >= max_attempts OR ?::int = 1 THEN 'failed' ELSE 'queued' END,
              run_after_ms = CASE WHEN attempts >= max_attempts OR ?::int = 1 THEN run_after_ms
                                  ELSE ${BACKOFF} END,
              locked_by = ?, locked_until_ms = NULL, error = ?, updated_at_ms = ?
        WHERE ${FENCE}`,
      final ? 1 : 0,
      final ? 1 : 0,
      nowMs,
      workerId,
      error,
      nowMs,
      id,
      workerId,
    );
    return changes > 0;
  },

  async release(db, { id, workerId, nowMs, runAfterMs, error = null }) {
    const { changes } = await db.run(
      `UPDATE media_jobs
          SET status = 'queued', attempts = GREATEST(attempts - 1, 0), run_after_ms = ?,
              locked_by = ?, locked_until_ms = NULL, error = ?, updated_at_ms = ?
        WHERE ${FENCE}`,
      runAfterMs,
      workerId,
      error,
      nowMs,
      id,
      workerId,
    );
    return changes > 0;
  },

  async requeueExpired(db, nowMs) {
    const { changes } = await db.run(
      `UPDATE media_jobs
          SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
              run_after_ms = CASE WHEN attempts >= max_attempts THEN run_after_ms
                                  ELSE ${BACKOFF} END,
              locked_until_ms = NULL, error = 'timeout', updated_at_ms = ?
        WHERE status = 'running' AND locked_until_ms <= ?`,
      nowMs,
      nowMs,
      nowMs,
    );
    return changes;
  },
};

/** The error codes a worker may store (D2), for validation at the edges. */
export const MEDIA_ERROR_CODES: readonly MediaErrorCode[] = [
  'decode-failed',
  'mixed-codecs',
  'verify-mismatch',
  'interleaved-input',
  'missing-blob',
  'timeout',
  'low-disk',
  'internal',
  'invalid-result',
  'inputs-changed',
];
