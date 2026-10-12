// Startup hygiene for the KV store (async-session-callers D2): purge expired entries once, before
// the server listens (after the catalog readiness wait, catalog-on-postgres D2). A failure
// only warns: reads still treat expired entries as absent, so it must not block boot.
import { stat } from 'node:fs/promises';
import type {
  BlobStore,
  Clock,
  KvStore,
  LeaseDirectory,
  PresenceRegistry,
} from '@autologger/ports';
import type {
  MediaBlobStore,
  MediaJobsPort,
  MediaSql,
  MediaUploadsPort,
} from '@autologger/ports/media';
import {
  mergedSegmentId,
  type SessionHubRegistryFacade,
  systemCaller,
} from '@autologger/session-core';
import {
  MEDIA_MERGE_HOLDOFF_MS,
  MEDIA_MIN_FREE_BYTES,
  MEDIA_RECONCILE_AFTER_MS,
  MEDIA_TERMINAL_JOB_TTL_MS,
  MEDIA_TRASH_GRACE_MS,
} from '@autologger/storage/mediaLimits';

export async function purgeExpiredAtBoot(
  kv: KvStore,
  warn: (msg: string) => void = console.warn,
): Promise<void> {
  try {
    await kv.purgeExpired();
  } catch (e) {
    const kind = e instanceof Error ? e.name : 'error';
    warn(
      `autologger: startup KV purge failed (${kind}); expired entries are still ignored on read`,
    );
  }
}

/** Purge expired KV entries every 10 minutes while running, so rows such as sign-in states don't
 * pile up until a restart (catalog-concurrency-hazards D10). Unref'd, warn-only; main.ts clears it
 * on shutdown. */
export function startPeriodicPurge(
  kv: KvStore,
  warn: (msg: string) => void = console.warn,
  intervalMs = 10 * 60_000,
): NodeJS.Timeout {
  const timer = setInterval(() => {
    kv.purgeExpired().catch((e: unknown) => {
      const code = (e as { code?: unknown })?.code;
      warn(
        `autologger: periodic KV purge failed (${typeof code === 'string' ? code : e instanceof Error ? e.name : 'error'})`,
      );
    });
  }, intervalMs);
  timer.unref();
  return timer;
}

/** The sweeper's caller: freeing an expired recording lease is session-wide, not any user's
 * (run-status-and-sweeper D6; a reviewed reason in catalogSystem.repo.test.ts). */
const SWEEP_CALLER = systemCaller('session-lease-sweep');

const errorKind = (e: unknown): string => {
  const code = (e as { code?: unknown })?.code;
  return typeof code === 'string' ? code : e instanceof Error ? e.name : 'error';
};

export interface LeaseSweepDeps {
  leases: LeaseDirectory;
  /** Companion presence: rows older than PRESENCE_SWEEP_MS are deleted first (companion-devices D4). */
  presence: PresenceRegistry;
  sessions: SessionHubRegistryFacade;
  clock: Clock;
  warn?: (msg: string) => void;
  /** The most recording sessions freed per tick; the rest wait for later ticks. */
  batch?: number;
  /** media-worker D6, D20: the merge reconcile and the notification-queue check, run last on each
   * tick (warn-only). */
  reconcile?: () => Promise<unknown>;
}

/** Presence rows last updated longer ago than this are deleted by every sweeper tick. */
const PRESENCE_SWEEP_MS = 60_000;

/** One lease-sweeper tick (run-status-and-sweeper D6): delete presence rows older than 60 s
 * (companion-devices D4, first, so a failing listing below never skips it), delete the expired
 * run rows (silent), then
 * free each listed session's expired recording lease, one at a time, through the hub's write path
 * (revision bump, `lease.changed` to every process, alarm re-arm). Warn-only: a failed step or
 * session warns and the tick goes on. Idempotent across processes: a second sweep deletes nothing. */
export async function sweepLeasesOnce({
  leases,
  presence,
  sessions,
  clock,
  warn = console.warn,
  batch = 100,
  reconcile,
}: LeaseSweepDeps): Promise<void> {
  try {
    await sweepRecordingLeases({ leases, presence, sessions, clock, warn, batch });
  } finally {
    if (reconcile) {
      await reconcile().catch((e: unknown) =>
        warn(`autologger: media reconcile failed (${errorKind(e)})`),
      );
    }
  }
}

async function sweepRecordingLeases({
  leases,
  presence,
  sessions,
  clock,
  warn,
  batch,
}: Required<Omit<LeaseSweepDeps, 'reconcile'>>): Promise<void> {
  try {
    await presence.deleteOlderThan(clock.now() - PRESENCE_SWEEP_MS);
  } catch (e) {
    warn(`autologger: lease sweep: presence delete failed (${errorKind(e)})`);
  }
  try {
    await leases.deleteExpiredRunLeases(clock.now());
  } catch (e) {
    warn(`autologger: lease sweep: run-lease delete failed (${errorKind(e)})`);
  }
  let ids: string[];
  try {
    ids = await leases.expiredRecordingSessions(clock.now(), batch);
  } catch (e) {
    warn(`autologger: lease sweep: listing expired recording leases failed (${errorKind(e)})`);
    return;
  }
  for (const id of ids) {
    try {
      await (await sessions.get(id)).as(SWEEP_CALLER).expireStaleLeases();
    } catch (e) {
      warn(`autologger: lease sweep: session ${id} failed (${errorKind(e)})`);
    }
  }
}

/** Every process sweeps expired session leases every minute, with no election (core-ports-
 * architecture "Expired leases are swept by every process"). No tick at start, so it never delays
 * `listen()`; ticks never overlap (a busy flag). Unref'd; main.ts clears it on shutdown. */
export function startLeaseSweeper(deps: LeaseSweepDeps & { intervalMs?: number }): NodeJS.Timeout {
  const { intervalMs = 60_000, warn = console.warn, ...rest } = deps;
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void sweepLeasesOnce({ ...rest, warn })
      .catch((e: unknown) => warn(`autologger: lease sweep failed (${errorKind(e)})`))
      .finally(() => {
        busy = false;
      });
  }, intervalMs);
  timer.unref();
  return timer;
}

// -- media-worker (design D2, D6, D8, D12, D20) ---------------------------------------------------

export interface MediaSweepDeps {
  /** A `catalog_system` binding (reason `media-sweep`) for the uploads and job rows. */
  db: MediaSql;
  jobs: MediaJobsPort;
  uploads: MediaUploadsPort;
  blobs: MediaBlobStore;
  clock: Clock;
  warn?: (msg: string) => void;
  info?: (msg: string) => void;
  /** Whether the last sweep left BLOB_DIR below the floor (the transition log's memory). */
  state?: { lowDisk: boolean };
}

/** One media sweep (D8, D12, D2): when `BLOB_DIR` is below `MEDIA_MIN_FREE_BYTES` purge the trash
 * oldest-first until the floor is met (logging entering and leaving low-disk mode once each), delete
 * trash days older than 7 days, expired uploads with their staging files, terminal jobs older than
 * 7 days, and `media/<job>/` directories whose job is gone or terminal. Warn-only per step. */
export async function sweepMediaOnce(deps: MediaSweepDeps): Promise<void> {
  const { db, jobs, uploads, blobs, clock } = deps;
  const warn = deps.warn ?? console.warn;
  const info = deps.info ?? console.info;
  const state = deps.state ?? { lowDisk: false };
  const now = clock.now();
  try {
    let free = await blobs.freeBytes();
    if (free < MEDIA_MIN_FREE_BYTES) {
      await blobs.purgeTrashOldestFirst(MEDIA_MIN_FREE_BYTES - free);
      free = await blobs.freeBytes();
    }
    const low = free < MEDIA_MIN_FREE_BYTES;
    if (low !== state.lowDisk) {
      state.lowDisk = low;
      if (low) warn('autologger: media: BLOB_DIR is below its free-disk floor; low-disk mode on');
      else info('autologger: media: BLOB_DIR is above its free-disk floor; low-disk mode off');
    }
  } catch (e) {
    warn(`autologger: media sweep: free-space check failed (${errorKind(e)})`);
  }
  try {
    await blobs.sweepTrash(now, MEDIA_TRASH_GRACE_MS);
  } catch (e) {
    warn(`autologger: media sweep: trash sweep failed (${errorKind(e)})`);
  }
  try {
    for (const id of await uploads.deleteExpired(db, now)) await blobs.removeStaging(id);
  } catch (e) {
    warn(`autologger: media sweep: upload expiry failed (${errorKind(e)})`);
  }
  try {
    await jobs.deleteTerminalBefore(db, now - MEDIA_TERMINAL_JOB_TTL_MS);
  } catch (e) {
    warn(`autologger: media sweep: old job delete failed (${errorKind(e)})`);
  }
  try {
    for (const dir of await blobs.mediaJobDirs()) {
      const job = await jobs.get(db, dir.jobId);
      if (job === null || !['queued', 'running', 'done'].includes(job.status)) {
        await blobs.removeMediaJobDir(dir.jobId);
      }
    }
  } catch (e) {
    warn(`autologger: media sweep: job directory cleanup failed (${errorKind(e)})`);
  }
}

/** The 10-minute media sweep timer (D8). Unref'd, no overlap; main.ts clears it on shutdown. */
export function startMediaSweeper(deps: MediaSweepDeps & { intervalMs?: number }): NodeJS.Timeout {
  const { intervalMs = 10 * 60_000, ...rest } = deps;
  const state = rest.state ?? { lowDisk: false };
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void sweepMediaOnce({ ...rest, state })
      .catch((e: unknown) =>
        (rest.warn ?? console.warn)(`autologger: media sweep failed (${errorKind(e)})`),
      )
      .finally(() => {
        busy = false;
      });
  }, intervalMs);
  timer.unref();
  return timer;
}

export interface MergeReconcileDeps {
  /** A `catalog_system` binding (reason `media-reconcile`). */
  db: MediaSql;
  jobs: MediaJobsPort;
  clock: Clock;
  /** A stored blob's size (the merge job's `input_bytes`). */
  blobBytes(key: string): Promise<number>;
  warn?: (msg: string) => void;
  batch?: number;
}

/** The merge reconcile (D6), on the lease sweeper's tick: every recording with two or more
 * segments, all with a non-null `media_status` and a seam (rows chunked before media-worker are
 * never merged here, even after `enqueueMediaJobs.ts` gave them a status: they have no seam), whose newest `ended_at_utc` is over 30 minutes old, with no live merge job and no `failed`
 * or `cancelled` merge in the last 24 hours, gets a merge job. Also warns when the notification
 * queue is over half full (D20). Returns how many merges it enqueued. */
export async function reconcileMergesOnce(deps: MergeReconcileDeps): Promise<number> {
  const { db, jobs, clock } = deps;
  const warn = deps.warn ?? console.warn;
  const now = clock.now();
  try {
    const [q] = await db.all<{ u: number | string }>('SELECT pg_notification_queue_usage() AS u');
    if (Number(q?.u ?? 0) > 0.5) {
      warn(
        'autologger: the database notification queue is over half full (pg_notification_queue_usage)',
      );
    }
  } catch (e) {
    warn(`autologger: media reconcile: queue usage check failed (${errorKind(e)})`);
  }
  let rows: { session_id: string; recording_ordinal: number | string }[];
  try {
    rows = await db.all(
      `SELECT s.session_id, s.recording_ordinal FROM session_audio_segments s
        WHERE s.recording_ordinal IS NOT NULL
        GROUP BY s.session_id, s.recording_ordinal
       HAVING count(*) >= 2 AND bool_and(s.media_status IS NOT NULL)
          AND bool_and(EXISTS (SELECT 1 FROM session_audio_seams m
                                WHERE m.session_id = s.session_id AND m.segment_id = s.id))
          AND max(s.ended_at_utc) < ?
        ORDER BY session_id, recording_ordinal
        LIMIT ?::int`,
      new Date(now - MEDIA_RECONCILE_AFTER_MS).toISOString(),
      deps.batch ?? 100,
    );
  } catch (e) {
    warn(`autologger: media reconcile: listing recordings failed (${errorKind(e)})`);
    return 0;
  }
  let enqueued = 0;
  for (const r of rows) {
    const sessionId = String(r.session_id);
    const ordinal = Number(r.recording_ordinal);
    try {
      if (await jobs.liveJob(db, 'merge', sessionId, String(ordinal))) continue;
      if (await jobs.hasRecentTerminalMerge(db, sessionId, ordinal, now - MEDIA_MERGE_HOLDOFF_MS)) {
        continue;
      }
      let bytes = 0;
      for (const k of await db.all<{ r2_key: string }>(
        'SELECT r2_key FROM session_audio_segments WHERE session_id = ? AND recording_ordinal = ?',
        sessionId,
        ordinal,
      )) {
        bytes += await deps.blobBytes(String(k.r2_key));
      }
      const made = await jobs.enqueue(db, {
        id: crypto.randomUUID(),
        kind: 'merge',
        sessionId,
        target: String(ordinal),
        inputBytes: bytes,
        nowMs: now,
      });
      if (made) enqueued += 1;
    } catch (e) {
      warn(`autologger: media reconcile: session ${sessionId} failed (${errorKind(e)})`);
    }
  }
  return enqueued;
}

export interface OrphanBlobDeps {
  /** A `catalog_system` binding (reason `media-sweep`). */
  db: MediaSql;
  /** The blob store: its listing and paths, and the media trash. */
  blobs: Pick<BlobStore, 'list' | 'resolveKeyPath'> & Pick<MediaBlobStore, 'trash'>;
  clock: Clock;
  /** Only blobs whose file is older than this are considered (a write in flight is newer). */
  minAgeMs?: number;
  warn?: (msg: string) => void;
}

/** Boot hygiene (media-worker, coordinator decision 2026-10-12): every create path writes its blob
 * before its row, so a crash between the two leaves a blob under `audio/` that no row names. Such a
 * blob older than `minAgeMs` (1 h) is moved to the trash (kept 7 days, never deleted here). The
 * copy of a `done` merge waiting for its apply (its id is the job's merged id) is kept. Returns how
 * many it moved. */
export async function trashOrphanBlobsOnce(deps: OrphanBlobDeps): Promise<number> {
  const { db, blobs, clock } = deps;
  const warn = deps.warn ?? console.warn;
  const now = clock.now();
  const minAge = deps.minAgeMs ?? 60 * 60_000;
  let moved = 0;
  try {
    const pending = new Set(
      (
        await db.all<{ id: string }>(
          "SELECT id FROM media_jobs WHERE kind = 'merge' AND status IN ('queued', 'running', 'done')",
        )
      ).map((r) => mergedSegmentId(String(r.id))),
    );
    const bySession = new Map<string, string[]>();
    let cursor: string | undefined;
    do {
      const listed = await blobs.list({ prefix: 'audio/', cursor });
      for (const o of listed.objects) {
        const sid = o.key.split('/')[1];
        if (!sid) continue;
        const list = bySession.get(sid) ?? [];
        list.push(o.key);
        bySession.set(sid, list);
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
    for (const [sid, keys] of bySession) {
      const named = new Set(
        (
          await db.all<{ r2_key: string }>(
            'SELECT r2_key FROM session_audio_segments WHERE session_id = ?',
            sid,
          )
        ).map((r) => String(r.r2_key)),
      );
      for (const key of keys) {
        if (named.has(key)) continue;
        const id = /_([0-9a-f-]{36})\.[a-z0-9]+$/i.exec(key)?.[1];
        if (id && pending.has(id)) continue;
        let mtimeMs: number;
        try {
          mtimeMs = (await stat(blobs.resolveKeyPath(key))).mtimeMs;
        } catch {
          continue;
        }
        if (now - mtimeMs < minAge) continue;
        if (await blobs.trash(key, now)) moved += 1;
      }
    }
  } catch (e) {
    warn(`autologger: orphan blob sweep failed (${errorKind(e)})`);
  }
  if (moved > 0) warn(`autologger: moved ${moved} blob(s) no segment names to the trash`);
  return moved;
}
