// The KV startup purge is an awaited boot step that never blocks boot (async-session-callers D2).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KvStore, LeaseDirectory, PresenceRegistry } from '@autologger/ports';
import type { SessionHubRegistryFacade } from '@autologger/session-core';
import { describe, expect, it, vi } from 'vitest';
import {
  purgeExpiredAtBoot,
  startLeaseSweeper,
  startPeriodicPurge,
  sweepLeasesOnce,
} from './startupPurge';

const kvWith = (purgeExpired: () => Promise<void>) => ({ purgeExpired }) as unknown as KvStore;

describe('purgeExpiredAtBoot', () => {
  it('awaits the purge', async () => {
    let done = false;
    const kv = kvWith(async () => {
      await new Promise((r) => setTimeout(r, 5));
      done = true;
    });
    await purgeExpiredAtBoot(kv, vi.fn());
    expect(done).toBe(true);
  });

  it('logs a warning and resolves when the purge fails', async () => {
    const warn = vi.fn();
    const kv = kvWith(async () => {
      throw Object.assign(new Error('database is locked'), { name: 'SqliteError' });
    });
    await expect(purgeExpiredAtBoot(kv, warn)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain('SqliteError');
  });

  it('main.ts awaits it before the server listens', () => {
    const main = readFileSync(join(__dirname, 'main.ts'), 'utf8');
    const purge = main.indexOf('await purgeExpiredAtBoot(');
    expect(purge).toBeGreaterThan(main.indexOf('createBindings(process.env)'));
    expect(purge).toBeLessThan(main.indexOf('serve('));
  });
});

// catalog-database "Expired key/value rows are purged periodically" (catalog-concurrency-hazards D10).
describe('startPeriodicPurge', () => {
  it('purges every 10 minutes without holding the process open, warns on failure, and stops', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const warn = vi.fn();
      const kv = kvWith(async () => {
        calls += 1;
        if (calls === 2) throw Object.assign(new Error('gone'), { code: 'CONNECTION_CLOSED' });
      });
      const timer = startPeriodicPurge(kv, warn);
      expect(timer.hasRef()).toBe(false);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(calls).toBe(2);
      expect(String(warn.mock.calls[0]?.[0])).toMatch(
        /periodic KV purge failed \(CONNECTION_CLOSED\)/,
      );
      clearInterval(timer);
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('main.ts starts it and clears it on shutdown', () => {
    const main = readFileSync(join(__dirname, 'main.ts'), 'utf8');
    expect(main).toMatch(/const purgeTimer = startPeriodicPurge\(/);
    expect(main).toMatch(/clearInterval\(purgeTimer\)/);
  });
});

// core-ports-architecture "Expired leases are swept by every process" (run-status-and-sweeper D6).
describe('startLeaseSweeper', () => {
  type Fakes = {
    leases: LeaseDirectory;
    presence: PresenceRegistry;
    /** Every step in call order: `presence:<cutoff>`, `runs`, `listing`. */
    steps: string[];
    sessions: SessionHubRegistryFacade;
    swept: string[];
    callers: unknown[];
    runDeletes: number[];
    recordingReads: Array<[number, number]>;
  };
  const fakes = (
    opts: {
      deleteRuns?: () => Promise<number>;
      expired?: () => Promise<string[]>;
      expire?: (id: string) => Promise<void>;
      deletePresence?: () => Promise<void>;
    } = {},
  ): Fakes => {
    const steps: string[] = [];
    const swept: string[] = [];
    const callers: unknown[] = [];
    const runDeletes: number[] = [];
    const recordingReads: Array<[number, number]> = [];
    const leases: LeaseDirectory = {
      earliestLiveRun: async () => null,
      deleteExpiredRunLeases: async (now) => {
        steps.push('runs');
        runDeletes.push(now);
        return opts.deleteRuns ? opts.deleteRuns() : 0;
      },
      expiredRecordingSessions: async (now, limit) => {
        steps.push('listing');
        recordingReads.push([now, limit]);
        return opts.expired ? opts.expired() : [];
      },
    };
    const sessions = {
      get: async (id: string) => ({
        as: (caller: unknown) => {
          callers.push(caller);
          return {
            expireStaleLeases: async () => {
              await opts.expire?.(id);
              swept.push(id);
            },
          };
        },
      }),
    } as unknown as SessionHubRegistryFacade;
    const presence = {
      deleteOlderThan: async (cutoff: number) => {
        steps.push(`presence:${cutoff}`);
        await opts.deletePresence?.();
      },
    } as unknown as PresenceRegistry;
    return { leases, presence, steps, sessions, swept, callers, runDeletes, recordingReads };
  };
  const clock = { now: () => 1_000_000 };

  const withFakeTimers = async (body: () => Promise<void>) => {
    vi.useFakeTimers();
    try {
      await body();
    } finally {
      vi.useRealTimers();
    }
  };

  it("ticks every 60 s, not at start, on an unref'd timer; deletes run rows, then sweeps each expired recording session as session-lease-sweep", () =>
    withFakeTimers(async () => {
      const f = fakes({ expired: async () => ['s1', 's2'] });
      const warn = vi.fn();
      const timer = startLeaseSweeper({
        leases: f.leases,
        presence: f.presence,
        sessions: f.sessions,
        clock,
        warn,
      });
      expect(timer.hasRef()).toBe(false);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(f.runDeletes).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.runDeletes).toEqual([1_000_000]);
      expect(f.recordingReads).toEqual([[1_000_000, 100]]);
      expect(f.swept).toEqual(['s1', 's2']);
      expect(f.callers).toEqual([
        { kind: 'system', reason: 'session-lease-sweep' },
        { kind: 'system', reason: 'session-lease-sweep' },
      ]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f.runDeletes).toHaveLength(2);
      expect(warn).not.toHaveBeenCalled();
      clearInterval(timer);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(f.runDeletes).toHaveLength(2);
    }));

  it('a slow tick blocks overlap: no second tick starts until the first finishes', () =>
    withFakeTimers(async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const f = fakes({ expired: async () => ['s1'], expire: () => gate });
      const timer = startLeaseSweeper({
        leases: f.leases,
        presence: f.presence,
        sessions: f.sessions,
        clock,
        warn: vi.fn(),
      });
      try {
        await vi.advanceTimersByTimeAsync(60_000);
        expect(f.runDeletes).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(3 * 60_000);
        expect(f.runDeletes).toHaveLength(1);
        release();
        await vi.advanceTimersByTimeAsync(0);
        expect(f.swept).toEqual(['s1']);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(f.runDeletes).toHaveLength(2);
      } finally {
        clearInterval(timer);
      }
    }));

  it('a failing run-row delete warns, and the tick still sweeps the recording rows', () =>
    withFakeTimers(async () => {
      const f = fakes({
        deleteRuns: async () => {
          throw Object.assign(new Error('gone'), { code: 'CONNECTION_CLOSED' });
        },
        expired: async () => ['s1'],
      });
      const warn = vi.fn();
      const timer = startLeaseSweeper({
        leases: f.leases,
        presence: f.presence,
        sessions: f.sessions,
        clock,
        warn,
      });
      try {
        await vi.advanceTimersByTimeAsync(60_000);
        expect(warn).toHaveBeenCalledOnce();
        expect(String(warn.mock.calls[0]?.[0])).toMatch(/lease sweep.*CONNECTION_CLOSED/);
        expect(f.swept).toEqual(['s1']);
      } finally {
        clearInterval(timer);
      }
    }));

  it('a failing listing warns once and the timer keeps ticking', () =>
    withFakeTimers(async () => {
      const f = fakes({
        expired: async () => {
          throw new TypeError('boom');
        },
      });
      const warn = vi.fn();
      const timer = startLeaseSweeper({
        leases: f.leases,
        presence: f.presence,
        sessions: f.sessions,
        clock,
        warn,
      });
      try {
        await vi.advanceTimersByTimeAsync(60_000);
        expect(warn).toHaveBeenCalledOnce();
        expect(String(warn.mock.calls[0]?.[0])).toMatch(/lease sweep.*TypeError/);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(f.runDeletes).toHaveLength(2);
      } finally {
        clearInterval(timer);
      }
    }));

  it('one failing session warns, naming it, and the others are still swept', () =>
    withFakeTimers(async () => {
      const f = fakes({
        expired: async () => ['bad', 'good'],
        expire: async (id) => {
          if (id === 'bad') throw Object.assign(new Error('x'), { name: 'SessionHubClosedError' });
        },
      });
      const warn = vi.fn();
      const timer = startLeaseSweeper({
        leases: f.leases,
        presence: f.presence,
        sessions: f.sessions,
        clock,
        warn,
        batch: 7,
      });
      try {
        await vi.advanceTimersByTimeAsync(60_000);
        expect(f.recordingReads).toEqual([[1_000_000, 7]]);
        expect(f.swept).toEqual(['good']);
        expect(warn).toHaveBeenCalledOnce();
        expect(String(warn.mock.calls[0]?.[0])).toMatch(/bad.*SessionHubClosedError/);
      } finally {
        clearInterval(timer);
      }
    }));

  // companion-devices D4: presence rows older than 60 s are deleted first, before the listing
  // whose failure ends the tick early.
  it('deletes presence older than 60 s as the first step of a tick', async () => {
    const f = fakes({ expired: async () => ['s1'] });
    const warn = vi.fn();
    await sweepLeasesOnce({
      leases: f.leases,
      presence: f.presence,
      sessions: f.sessions,
      clock,
      warn,
    });
    expect(f.steps).toEqual(['presence:940000', 'runs', 'listing']);
    expect(f.swept).toEqual(['s1']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a failing presence delete warns, and the tick goes on', async () => {
    const f = fakes({
      deletePresence: async () => {
        throw Object.assign(new Error('gone'), { code: 'CONNECTION_CLOSED' });
      },
      expired: async () => ['s1'],
    });
    const warn = vi.fn();
    await sweepLeasesOnce({
      leases: f.leases,
      presence: f.presence,
      sessions: f.sessions,
      clock,
      warn,
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toMatch(
      /lease sweep: presence delete failed \(CONNECTION_CLOSED\)/,
    );
    expect(f.steps).toEqual(['presence:940000', 'runs', 'listing']);
    expect(f.swept).toEqual(['s1']);
  });

  it('the presence step still runs when the recording listing fails', async () => {
    const f = fakes({
      expired: async () => {
        throw new TypeError('boom');
      },
    });
    const warn = vi.fn();
    await sweepLeasesOnce({
      leases: f.leases,
      presence: f.presence,
      sessions: f.sessions,
      clock,
      warn,
    });
    expect(f.steps).toEqual(['presence:940000', 'runs', 'listing']);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/listing expired recording leases failed/);
  });

  it('main.ts starts it after the periodic purge and clears it on shutdown', () => {
    const main = readFileSync(join(__dirname, 'main.ts'), 'utf8');
    const start = main.indexOf('const leaseSweepTimer = startLeaseSweeper(');
    expect(start).toBeGreaterThan(main.indexOf('const purgeTimer = startPeriodicPurge('));
    expect(main).toMatch(/clearInterval\(leaseSweepTimer\)/);
  });
});
