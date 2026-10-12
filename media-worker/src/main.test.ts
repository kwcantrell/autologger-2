// The worker loop with a fake queue, fake statfs and fake jobs (media-worker design D2, D8).

import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MediaJob, MediaJobKind, MediaSql } from '@autologger/ports/media';
import {
  MEDIA_JOB_RENEW_MS,
  MEDIA_MIN_FREE_BYTES,
  MEDIA_SMALL_LANE_MAX_BYTES,
} from '@autologger/storage/mediaLimits';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JobOutcome } from './jobs/types';
import { MediaWorker, WORKER_DEFAULTS, type WorkerDeps } from './main';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

interface ClaimCall {
  lane: number;
  maxInputBytes: number;
  kinds: readonly MediaJobKind[] | undefined;
}

function mkJob(id: string, kind: MediaJobKind, inputBytes: number): MediaJob {
  return {
    id,
    kind,
    sessionId: 's1',
    target: kind === 'merge' ? '1' : `seg-${id}`,
    status: 'queued',
    attempts: 0,
    maxAttempts: 5,
    inputBytes,
    runAfterMs: 0,
    lockedBy: null,
    lockedUntilMs: null,
    resultJson: null,
    error: null,
    createdAtMs: 0,
    updatedAtMs: 0,
    appliedAtMs: null,
  };
}

/** An in-memory queue with the port's claim filter (lane size, kinds) and fenced statements. */
function fakeQueue() {
  const queued: MediaJob[] = [];
  const running = new Map<string, MediaJob>();
  const calls = {
    claims: [] as ClaimCall[],
    renew: [] as string[],
    finish: [] as { id: string; resultJson: string }[],
    fail: [] as { id: string; error: string; final: boolean }[],
    release: [] as { id: string; runAfterMs: number; error: string | null }[],
    requeue: 0,
  };
  let fence = true;
  const jobs: WorkerDeps['jobs'] = {
    async claim(_db, o) {
      calls.claims.push({ lane: -1, maxInputBytes: o.maxInputBytes, kinds: o.kinds });
      const i = queued.findIndex(
        (j) => j.inputBytes <= o.maxInputBytes && (!o.kinds || o.kinds.includes(j.kind)),
      );
      if (i < 0) return null;
      const [j] = queued.splice(i, 1);
      const claimed = {
        ...j,
        status: 'running' as const,
        lockedBy: o.workerId,
        attempts: j.attempts + 1,
      };
      running.set(j.id, claimed);
      return claimed;
    },
    async renew(_db, o) {
      calls.renew.push(o.id);
      return fence;
    },
    async finish(_db, o) {
      calls.finish.push({ id: o.id, resultJson: o.resultJson });
      running.delete(o.id);
      return fence;
    },
    async fail(_db, o) {
      calls.fail.push({ id: o.id, error: o.error, final: o.final ?? false });
      running.delete(o.id);
      return fence;
    },
    async release(_db, o) {
      calls.release.push({ id: o.id, runAfterMs: o.runAfterMs, error: o.error ?? null });
      running.delete(o.id);
      return fence;
    },
    async requeueExpired() {
      calls.requeue += 1;
      return 0;
    },
  };
  return {
    jobs,
    calls,
    push: (j: MediaJob) => queued.push(j),
    queued,
    loseLease: () => {
      fence = false;
    },
  };
}

const until = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
};

let blobDir: string;
let hbFile: string;
let worker: MediaWorker | null = null;
const logs: { event: string; fields: Record<string, unknown> }[] = [];

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'mw-main-'));
  blobDir = join(root, 'blobs');
  await mkdir(join(blobDir, 'media'), { recursive: true });
  hbFile = join(root, 'heartbeat');
  logs.length = 0;
});
afterEach(async () => {
  await worker?.stop(0);
  worker = null;
  await rm(join(blobDir, '..'), { recursive: true, force: true });
});

function make(
  q: ReturnType<typeof fakeQueue>,
  over: Partial<WorkerDeps> & {
    run?: (job: MediaJob, signal?: AbortSignal) => Promise<JobOutcome>;
  } = {},
) {
  const deps: WorkerDeps = {
    db: {} as MediaSql,
    jobs: q.jobs,
    reads: {
      segment: async () => null,
      recordingSegments: async () => [],
      recordingSeams: async () => [],
    },
    freeBytes: async () => 100 * GiB,
    now: () => Date.now(),
    runJob: async (ctx, job) =>
      over.run
        ? over.run(job, ctx.signal)
        : {
            kind: 'done',
            result: {
              duration_ms: 1,
              peaks: [0, 0, 0, 0, 0, 0, 0, 0],
              codec: 'opus',
              sample_rate: 48000,
              channels: 1,
              flac: null,
            },
          },
    workerId: 'w-test',
    blobDir,
    ffmpegPath: 'ffmpeg',
    heartbeatPath: hbFile,
    log: (event, fields = {}) => logs.push({ event, fields }),
    pollMs: 20,
    renewMs: 1000,
    heartbeatMs: 1000,
    ...over,
  };
  worker = new MediaWorker(deps);
  return worker;
}

describe('MediaWorker', () => {
  it('defaults: two lanes (64 MiB and any), renew every MEDIA_JOB_RENEW_MS, 5 s poll', () => {
    expect(WORKER_DEFAULTS.lanes).toEqual([MEDIA_SMALL_LANE_MAX_BYTES, Number.MAX_SAFE_INTEGER]);
    expect(WORKER_DEFAULTS.renewMs).toBe(MEDIA_JOB_RENEW_MS);
    expect(WORKER_DEFAULTS.pollMs).toBe(5000);
  });

  it('claims on two lanes: the small lane filters input_bytes ≤ 64 MiB, so a big job never blocks a small one', async () => {
    const q = fakeQueue();
    let releaseBig: () => void = () => {};
    q.push(mkJob('big', 'ingest', 1500 * MiB));
    q.push(mkJob('small', 'ingest', 10 * MiB));
    const ran: string[] = [];
    make(q, {
      run: async (job) => {
        ran.push(job.id);
        if (job.id === 'big') await new Promise<void>((r) => (releaseBig = r));
        return { kind: 'fail', error: 'internal', final: false };
      },
    }).start();
    await until(() => ran.includes('small') && ran.includes('big'));
    expect(q.calls.claims.some((c) => c.maxInputBytes === MEDIA_SMALL_LANE_MAX_BYTES)).toBe(true);
    expect(q.calls.claims.some((c) => c.maxInputBytes > MEDIA_SMALL_LANE_MAX_BYTES)).toBe(true);
    releaseBig();
  });

  it('below MEDIA_MIN_FREE_BYTES: no merge and no job with input_bytes × 2 > free is claimed; claiming resumes when space returns', async () => {
    const q = fakeQueue();
    let free = 4 * GiB;
    q.push(mkJob('m', 'merge', 1 * MiB));
    q.push(mkJob('bigingest', 'ingest', 3 * GiB));
    make(q, { freeBytes: async () => free }).start();
    await until(() => q.calls.claims.length >= 6);
    for (const c of q.calls.claims) {
      expect(c.kinds).toEqual(['ingest']);
      expect(c.maxInputBytes * 2).toBeLessThanOrEqual(free);
    }
    expect(q.calls.finish).toEqual([]);
    expect(logs.filter((l) => l.event === 'low-disk-enter')).toHaveLength(1);
    free = MEDIA_MIN_FREE_BYTES + 10 * GiB;
    await until(() => q.calls.finish.length === 2);
    expect(logs.filter((l) => l.event === 'low-disk-leave')).toHaveLength(1);
  });

  it('claim → run → finish with the result JSON; sweeps expired leases', async () => {
    const q = fakeQueue();
    q.push(mkJob('a', 'ingest', 1000));
    make(q).start();
    await until(() => q.calls.finish.length === 1);
    expect(JSON.parse(q.calls.finish[0].resultJson)).toMatchObject({ duration_ms: 1, flac: null });
    expect(q.calls.requeue).toBeGreaterThan(0);
  });

  it('renews the lease while a long job runs', async () => {
    const q = fakeQueue();
    q.push(mkJob('long', 'ingest', 1000));
    make(q, {
      renewMs: 20,
      run: async () => {
        await new Promise((r) => setTimeout(r, 150));
        return { kind: 'fail', error: 'internal', final: false };
      },
    }).start();
    await until(() => q.calls.fail.length === 1);
    expect(q.calls.renew.filter((id) => id === 'long').length).toBeGreaterThanOrEqual(3);
  });

  it('a lost lease (renew → 0 rows) aborts the job and drops its result; a fenced finish that changes nothing is logged', async () => {
    const q = fakeQueue();
    q.push(mkJob('lost', 'ingest', 1000));
    let aborted = false;
    make(q, {
      renewMs: 20,
      run: async (_job, signal) => {
        await new Promise<void>((r) => signal?.addEventListener('abort', () => r()));
        aborted = true;
        return { kind: 'fail', error: 'internal', final: false };
      },
    });
    q.loseLease();
    worker?.start();
    await until(() => aborted);
    await until(() => logs.some((l) => l.event === 'lease-lost'));
    expect(q.calls.fail).toEqual([]);
    expect(q.calls.finish).toEqual([]);
  });

  it('a finish that affects 0 rows drops the result, removes media/<job>/ and logs', async () => {
    const q = fakeQueue();
    q.push(mkJob('j1', 'ingest', 1000));
    q.loseLease();
    make(q, {
      run: async (job) => {
        await mkdir(join(blobDir, 'media', job.id), { mode: 0o777 });
        return {
          kind: 'done',
          result: {
            duration_ms: 1,
            peaks: [0, 0, 0, 0, 0, 0, 0, 0],
            codec: 'opus',
            sample_rate: 48000,
            channels: 1,
            flac: null,
          },
        };
      },
    }).start();
    await until(() => logs.some((l) => l.event === 'lease-lost'));
    expect(await readdir(join(blobDir, 'media'))).toEqual([]);
  });

  it('a thrown job → fail internal (the queue applies the backoff); a final outcome is passed on', async () => {
    const q = fakeQueue();
    q.push(mkJob('t', 'ingest', 1000));
    q.push(mkJob('f', 'ingest', 1000));
    make(q, {
      run: async (job) => {
        if (job.id === 't') throw new Error('/blobs/audio/secret path');
        return { kind: 'fail', error: 'mixed-codecs', final: true };
      },
    }).start();
    await until(() => q.calls.fail.length === 2);
    expect(q.calls.fail).toEqual(
      expect.arrayContaining([
        { id: 't', error: 'internal', final: false },
        { id: 'f', error: 'mixed-codecs', final: true },
      ]),
    );
    expect(JSON.stringify(logs)).not.toContain('/blobs');
  });

  it('an oversize result (> 256 KiB) is never written: fail internal', async () => {
    const q = fakeQueue();
    q.push(mkJob('o', 'ingest', 1000));
    make(q, {
      run: async () => ({
        kind: 'done',
        result: {
          duration_ms: 1,
          peaks: new Array(40_000).fill(0.123456789),
          codec: 'x',
          sample_rate: 1,
          channels: 1,
          flac: null,
        },
      }),
    }).start();
    await until(() => q.calls.fail.length === 1);
    expect(q.calls.fail[0]).toMatchObject({ id: 'o', error: 'internal' });
    expect(q.calls.finish).toEqual([]);
  });

  it('a low-disk outcome releases the job (attempt given back) at its run-after time', async () => {
    const q = fakeQueue();
    q.push(mkJob('r', 'ingest', 1000));
    make(q, { run: async () => ({ kind: 'release', error: 'low-disk', runAfterMs: 123 }) }).start();
    await until(() => q.calls.release.length === 1);
    expect(q.calls.release[0]).toEqual({ id: 'r', runAfterMs: 123, error: 'low-disk' });
  });

  it('LISTEN wakes an idle lane before the poll interval', async () => {
    const q = fakeQueue();
    let wake: () => void = () => {};
    make(q, {
      pollMs: 60_000,
      listen: async (cb) => {
        wake = cb;
      },
    }).start();
    await until(() => q.calls.claims.length >= 2);
    const before = q.calls.claims.length;
    q.push(mkJob('n', 'ingest', 1000));
    wake();
    await until(() => q.calls.finish.length === 1, 1000);
    expect(q.calls.claims.length).toBeGreaterThan(before);
  });

  it('touches the heartbeat file each loop', async () => {
    const q = fakeQueue();
    make(q).start();
    await until(() => q.calls.claims.length >= 2);
    const first = (await stat(hbFile)).mtimeMs;
    await new Promise((r) => setTimeout(r, 60));
    expect((await stat(hbFile)).mtimeMs).toBeGreaterThan(first);
  });

  it('SIGTERM: the current job finishes within the grace window', async () => {
    const q = fakeQueue();
    q.push(mkJob('g', 'ingest', 1000));
    let started = false;
    const w = make(q, {
      run: async () => {
        started = true;
        await new Promise((r) => setTimeout(r, 50));
        return { kind: 'fail', error: 'decode-failed', final: false };
      },
    });
    w.start();
    await until(() => started);
    await w.stop(2000);
    expect(q.calls.fail).toEqual([{ id: 'g', error: 'decode-failed', final: false }]);
    expect(q.calls.release).toEqual([]);
  });

  it('SIGTERM: a job still running after the grace window is aborted and released', async () => {
    const q = fakeQueue();
    q.push(mkJob('h', 'ingest', 1000));
    let started = false;
    const w = make(q, {
      run: async (_job, signal) => {
        started = true;
        await new Promise<void>((r) => signal?.addEventListener('abort', () => r()));
        return { kind: 'fail', error: 'internal', final: false };
      },
    });
    w.start();
    await until(() => started);
    const n = q.calls.claims.length;
    await w.stop(50);
    expect(q.calls.release).toEqual([{ id: 'h', runAfterMs: expect.any(Number), error: null }]);
    expect(q.calls.fail).toEqual([]);
    await new Promise((r) => setTimeout(r, 60));
    expect(q.calls.claims.length).toBe(n);
  });
});
