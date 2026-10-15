// media-worker B.5 (design D2, D6, D8, D12, D20): the media sweep and the reconcile hook on the
// lease sweeper, over fakes. The reconcile's SQL runs over Postgres in
// startupPurge.media.int.test.ts.
import type {
  MediaBlobStore,
  MediaJob,
  MediaJobsPort,
  MediaUploadsPort,
} from '@autologger/ports/media';
import { MEDIA_MIN_FREE_BYTES } from '@autologger/storage/mediaLimits';
import { describe, expect, it, vi } from 'vitest';
import { type MediaSweepDeps, sweepLeasesOnce, sweepMediaOnce } from './startupPurge';

const GiB = 1024 ** 3;
const NOW = Date.UTC(2026, 9, 12);

function fakes(
  over: { free?: number[]; dirs?: string[]; jobs?: Record<string, Partial<MediaJob> | null> } = {},
) {
  const free = [...(over.free ?? [MEDIA_MIN_FREE_BYTES + GiB])];
  const calls: string[] = [];
  const blobs = {
    freeBytes: vi.fn(async () =>
      free.length > 1 ? (free.shift() as number) : (free[0] as number),
    ),
    purgeTrashOldestFirst: vi.fn(async (n: number) => {
      calls.push(`purge ${n}`);
      return n;
    }),
    sweepTrash: vi.fn(async (_now: number, grace?: number) => {
      calls.push(`sweepTrash ${grace}`);
      return 0;
    }),
    removeStaging: vi.fn(async (id: string) => {
      calls.push(`removeStaging ${id}`);
    }),
    mediaJobDirs: vi.fn(async () => (over.dirs ?? []).map((jobId) => ({ jobId, mtimeMs: 0 }))),
    removeMediaJobDir: vi.fn(async (id: string) => {
      calls.push(`rmdir ${id}`);
    }),
  } as unknown as MediaBlobStore;
  const jobs = {
    deleteTerminalBefore: vi.fn(async (_db: unknown, before: number) => {
      calls.push(`deleteTerminalBefore ${NOW - before}`);
      return 0;
    }),
    get: vi.fn(async (_db: unknown, id: string) => {
      const j = over.jobs?.[id];
      return j === undefined || j === null ? null : (j as MediaJob);
    }),
  } as unknown as MediaJobsPort;
  const uploads = {
    deleteExpired: vi.fn(async () => ['u1', 'u2']),
  } as unknown as MediaUploadsPort;
  const warn = vi.fn();
  const info = vi.fn();
  const deps: MediaSweepDeps = {
    db: { all: async () => [], run: async () => ({ changes: 0 }) },
    jobs,
    uploads,
    blobs,
    clock: { now: () => NOW },
    warn,
    info,
    state: { lowDisk: false },
  };
  return { deps, calls, warn, info };
}

describe('sweepMediaOnce (D8, D12, D2)', () => {
  it('sweeps 7-day trash, expired uploads with their staging and terminal jobs older than 7 days', async () => {
    const { deps, calls } = fakes();
    await sweepMediaOnce(deps);
    const DAY = 86_400_000;
    expect(calls).toEqual([
      `sweepTrash ${7 * DAY}`,
      'removeStaging u1',
      'removeStaging u2',
      `deleteTerminalBefore ${7 * DAY}`,
    ]);
  });

  it('removes media/<job>/ directories whose job is gone or terminal, keeps live ones', async () => {
    const { deps, calls } = fakes({
      dirs: ['gone', 'applied', 'running', 'done'],
      jobs: {
        gone: null,
        applied: { status: 'applied' },
        running: { status: 'running' },
        done: { status: 'done' },
      },
    });
    await sweepMediaOnce(deps);
    expect(calls.filter((c) => c.startsWith('rmdir'))).toEqual(['rmdir gone', 'rmdir applied']);
  });

  it('below the floor it purges trash oldest-first by the shortfall and logs each transition once', async () => {
    const short = 3 * GiB;
    const { deps, calls, warn, info } = fakes({
      free: [MEDIA_MIN_FREE_BYTES - short, MEDIA_MIN_FREE_BYTES - GiB],
    });
    await sweepMediaOnce(deps);
    expect(calls[0]).toBe(`purge ${short}`);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/low-disk mode on/);
    await sweepMediaOnce(deps); // still low: no second log
    expect(warn).toHaveBeenCalledTimes(1);
    (deps.blobs.freeBytes as ReturnType<typeof vi.fn>).mockImplementation(
      async () => MEDIA_MIN_FREE_BYTES + 1,
    );
    await sweepMediaOnce(deps);
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0]?.[0])).toMatch(/low-disk mode off/);
  });

  it('a failing step warns and the others still run', async () => {
    const { deps, calls, warn } = fakes();
    (deps.blobs.sweepTrash as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error('x'), { code: 'EIO' }),
    );
    await sweepMediaOnce(deps);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('trash sweep failed (EIO)'));
    expect(calls).toContain('removeStaging u1');
  });
});

describe('the lease sweeper runs the media reconcile on each tick (D6)', () => {
  it('after the lease steps, even when the listing fails; a reconcile failure only warns', async () => {
    const order: string[] = [];
    const warn = vi.fn();
    await sweepLeasesOnce({
      leases: {
        deleteExpiredRunLeases: async () => {
          order.push('runs');
        },
        expiredRecordingSessions: async () => {
          throw new Error('down');
        },
      } as never,
      presence: { deleteOlderThan: async () => order.push('presence') } as never,
      sessions: {} as never,
      clock: { now: () => NOW },
      warn,
      reconcile: async () => {
        order.push('reconcile');
        throw new Error('boom');
      },
    });
    expect(order).toEqual(['presence', 'runs', 'reconcile']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('media reconcile failed'));
  });
});
