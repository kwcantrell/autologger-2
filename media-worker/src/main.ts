// The media worker (OpenSpec change `media-worker`, design D1-D8, D14): a loop of two lanes that
// claim `catalog.media_jobs` rows under a lease (lane A only jobs whose inputs are ≤ 64 MiB, lane
// B any job, so a big import never delays a live chunk's waveform), run them (ingest, merge),
// and finish, fail or release them with statements fenced on the lease. Woken by `LISTEN
// media_jobs` and a 5 s poll. Below the free-disk floor it claims no merge and no job whose
// inputs twice over exceed the free space. A heartbeat file in /tmp feeds the container
// healthcheck. Configured only by the five PG* variables and BLOB_DIR; every limit is compiled
// (@autologger/storage/mediaLimits). Logs are one JSON line per event with ids and codes, never
// a path or tool output.

import { randomBytes } from 'node:crypto';
import { statfs, utimes, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { pathToFileURL } from 'node:url';
import type { MediaJob, MediaJobsPort, MediaSql } from '@autologger/ports/media';
import { mediaJobs } from '@autologger/storage/mediaJobs';
import {
  MEDIA_FFMPEG_TIMEOUT_MS,
  MEDIA_JOB_RENEW_MS,
  MEDIA_MIN_FREE_BYTES,
  MEDIA_RESULT_MAX_BYTES,
  MEDIA_SMALL_LANE_MAX_BYTES,
} from '@autologger/storage/mediaLimits';
import { runIngest } from './jobs/ingest';
import { runMerge } from './jobs/merge';
import type { JobCtx, JobOutcome, WorkerReads } from './jobs/types';
import { removeAttemptFiles } from './output';

export const HEARTBEAT_PATH = '/tmp/media-worker.heartbeat';

export const WORKER_DEFAULTS = {
  lanes: [MEDIA_SMALL_LANE_MAX_BYTES, Number.MAX_SAFE_INTEGER] as const,
  renewMs: MEDIA_JOB_RENEW_MS,
  pollMs: 5000,
  heartbeatMs: 10_000,
  /** SIGTERM: current jobs get this long to finish before they are aborted and released (under
   * docker's default 10 s stop timeout). */
  stopGraceMs: 8000,
};

export type WorkerJobs = Pick<
  MediaJobsPort,
  'claim' | 'renew' | 'finish' | 'fail' | 'release' | 'requeueExpired'
>;

export interface WorkerDeps {
  db: MediaSql;
  jobs: WorkerJobs;
  reads: WorkerReads;
  freeBytes(): Promise<number>;
  now(): number;
  runJob(ctx: JobCtx, job: MediaJob): Promise<JobOutcome>;
  workerId: string;
  blobDir: string;
  ffmpegPath: string;
  heartbeatPath: string;
  log(event: string, fields?: Record<string, string | number | boolean>): void;
  listen?(onWake: () => void): Promise<void>;
  lanes?: readonly number[];
  pollMs?: number;
  renewMs?: number;
  heartbeatMs?: number;
}

interface Running {
  job: MediaJob;
  ac: AbortController;
  shutdown: boolean;
}

export function dispatchJob(ctx: JobCtx, job: MediaJob): Promise<JobOutcome> {
  return job.kind === 'merge' ? runMerge(ctx, job) : runIngest(ctx, job);
}

export class MediaWorker {
  private stopping = false;
  private readonly wakers = new Set<() => void>();
  private readonly running = new Set<Running>();
  private loops: Promise<void>[] = [];
  private hbTimer: NodeJS.Timeout | null = null;
  private lowDisk = false;
  private readonly lanes: readonly number[];
  private readonly pollMs: number;
  private readonly renewMs: number;

  constructor(private readonly d: WorkerDeps) {
    this.lanes = d.lanes ?? WORKER_DEFAULTS.lanes;
    this.pollMs = d.pollMs ?? WORKER_DEFAULTS.pollMs;
    this.renewMs = d.renewMs ?? WORKER_DEFAULTS.renewMs;
  }

  start(): void {
    void this.d.listen?.(() => this.wake()).catch(() => this.d.log('listen-failed'));
    this.hbTimer = setInterval(
      () => void this.heartbeat(),
      this.d.heartbeatMs ?? WORKER_DEFAULTS.heartbeatMs,
    );
    this.loops = this.lanes.map((max, i) => this.lane(i, max));
    this.d.log('started', { lanes: this.lanes.length });
  }

  /** Stops claiming; waits up to `graceMs` for current jobs, then aborts and releases them. */
  async stop(graceMs = WORKER_DEFAULTS.stopGraceMs): Promise<void> {
    this.stopping = true;
    this.wake();
    if (this.hbTimer) clearInterval(this.hbTimer);
    const all = Promise.all(this.loops);
    const timedOut = await Promise.race([
      all.then(() => false),
      new Promise<boolean>((r) => setTimeout(() => r(true), graceMs)),
    ]);
    if (timedOut) {
      for (const r of this.running) {
        r.shutdown = true;
        r.ac.abort();
      }
      await all;
    }
    this.d.log('stopped');
  }

  wake(): void {
    for (const w of [...this.wakers]) w();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        this.wakers.delete(done);
        resolve();
      };
      const t = setTimeout(done, ms);
      this.wakers.add(done);
    });
  }

  private async heartbeat(): Promise<void> {
    const now = new Date();
    try {
      await utimes(this.d.heartbeatPath, now, now);
    } catch {
      await writeFile(this.d.heartbeatPath, '').catch(() => {});
    }
  }

  private async lane(index: number, laneMax: number): Promise<void> {
    while (!this.stopping) {
      await this.heartbeat();
      let job: MediaJob | null = null;
      try {
        await this.d.jobs.requeueExpired(this.d.db, this.d.now());
        const free = await this.d.freeBytes();
        const low = free < MEDIA_MIN_FREE_BYTES;
        if (low !== this.lowDisk) {
          this.lowDisk = low;
          this.d.log(low ? 'low-disk-enter' : 'low-disk-leave');
        }
        const maxInputBytes = Math.min(laneMax, Math.floor(free / 2));
        if (maxInputBytes > 0 && !this.stopping) {
          job = await this.d.jobs.claim(this.d.db, {
            workerId: this.d.workerId,
            nowMs: this.d.now(),
            maxInputBytes,
            kinds: low ? ['ingest'] : undefined,
          });
        }
      } catch {
        this.d.log('db-error', { lane: index });
      }
      if (!job) {
        await this.sleep(this.pollMs);
        continue;
      }
      await this.process(index, job);
    }
  }

  private async process(lane: number, job: MediaJob): Promise<void> {
    const r: Running = { job, ac: new AbortController(), shutdown: false };
    this.running.add(r);
    let lost = false;
    const renew = setInterval(() => {
      void this.d.jobs
        .renew(this.d.db, { id: job.id, workerId: this.d.workerId, nowMs: this.d.now() })
        .then((ok) => {
          if (!ok && !lost) {
            lost = true;
            r.ac.abort();
          }
        })
        .catch(() => this.d.log('db-error', { lane, job: job.id }));
    }, this.renewMs);
    const t0 = Date.now();
    this.d.log('job-start', { lane, job: job.id, kind: job.kind, attempt: job.attempts });
    let outcome: JobOutcome;
    try {
      outcome = await this.d.runJob(
        {
          blobDir: this.d.blobDir,
          ffmpegPath: this.d.ffmpegPath,
          timeoutMs: MEDIA_FFMPEG_TIMEOUT_MS,
          signal: r.ac.signal,
          freeBytes: this.d.freeBytes,
          now: this.d.now,
          reads: this.d.reads,
        },
        job,
      );
    } catch {
      outcome = { kind: 'fail', error: 'internal', final: false };
    } finally {
      clearInterval(renew);
      this.running.delete(r);
    }
    const fence = { id: job.id, workerId: this.d.workerId, nowMs: this.d.now() };
    const ms = Date.now() - t0;
    try {
      if (lost) {
        this.d.log('lease-lost', { job: job.id });
        await removeAttemptFiles(this.d.blobDir, job.id, job.attempts).catch(() => {});
        return;
      }
      if (r.shutdown) {
        await removeAttemptFiles(this.d.blobDir, job.id, job.attempts).catch(() => {});
        const ok = await this.d.jobs.release(this.d.db, {
          ...fence,
          runAfterMs: fence.nowMs,
          error: null,
        });
        this.d.log(ok ? 'job-released' : 'lease-lost', { job: job.id });
        return;
      }
      let ok: boolean;
      if (outcome.kind === 'done') {
        const resultJson = JSON.stringify(outcome.result);
        if (Buffer.byteLength(resultJson) > MEDIA_RESULT_MAX_BYTES) {
          await removeAttemptFiles(this.d.blobDir, job.id, job.attempts).catch(() => {});
          ok = await this.d.jobs.fail(this.d.db, { ...fence, error: 'internal', final: true });
          this.d.log('job-failed', { job: job.id, error: 'internal', ms });
        } else {
          ok = await this.d.jobs.finish(this.d.db, { ...fence, resultJson });
          if (ok) this.d.log('job-done', { job: job.id, kind: job.kind, ms });
        }
      } else if (outcome.kind === 'release') {
        await removeAttemptFiles(this.d.blobDir, job.id, job.attempts).catch(() => {});
        ok = await this.d.jobs.release(this.d.db, {
          ...fence,
          runAfterMs: outcome.runAfterMs,
          error: outcome.error,
        });
        if (ok) this.d.log('job-released', { job: job.id, error: outcome.error });
      } else {
        await removeAttemptFiles(this.d.blobDir, job.id, job.attempts).catch(() => {});
        ok = await this.d.jobs.fail(this.d.db, {
          ...fence,
          error: outcome.error,
          final: outcome.final,
        });
        if (ok)
          this.d.log('job-failed', { job: job.id, error: outcome.error, final: outcome.final, ms });
      }
      if (!ok) {
        this.d.log('lease-lost', { job: job.id });
        await removeAttemptFiles(this.d.blobDir, job.id, job.attempts).catch(() => {});
      }
    } catch {
      this.d.log('db-error', { lane, job: job.id });
    }
  }
}

/** Free bytes for an unprivileged writer on the blob volume. */
export async function blobFreeBytes(blobDir: string): Promise<number> {
  const s = await statfs(blobDir);
  return Number(s.bavail) * Number(s.bsize);
}

const ALLOWED_ENV = ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'BLOB_DIR'];

/** The process entry: refuses a missing BLOB_DIR or PG variable, then runs until SIGTERM. */
export async function main(): Promise<void> {
  const missing = ALLOWED_ENV.filter((k) => !process.env[k]);
  if (missing.length) {
    process.stderr.write(`${JSON.stringify({ event: 'refused', missing })}\n`);
    process.exit(2);
  }
  const blobDir = process.env.BLOB_DIR as string;
  const { connectWorkerDb, workerReads } = await import('./db');
  const wdb = connectWorkerDb();
  const log: WorkerDeps['log'] = (event, fields = {}) =>
    process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), event, ...fields })}\n`);
  const worker = new MediaWorker({
    db: wdb.db,
    jobs: mediaJobs,
    reads: workerReads(wdb.db),
    freeBytes: () => blobFreeBytes(blobDir),
    now: () => Date.now(),
    runJob: dispatchJob,
    workerId: `${hostname()}-${process.pid}-${randomBytes(4).toString('hex')}`,
    blobDir,
    ffmpegPath: 'ffmpeg',
    heartbeatPath: HEARTBEAT_PATH,
    log,
    listen: (cb) => wdb.listen(cb),
  });
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    void worker
      .stop()
      .then(() => wdb.close())
      .finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  worker.start();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
