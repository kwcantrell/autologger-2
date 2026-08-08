// Unit tests for the log-import job store's creator field and lifecycle:
// terminal-TTL pruning, the size cap with terminal-first eviction, and the
// never-evict-a-live-job guarantee. Drives an injected fake Clock directly
// (feature-service-packages task 5.2) rather than vitest's real-timer mocks —
// `jobStore`'s three time-reading exports now take `Clock` as their leading
// parameter, so the tests control terminal-TTL pruning and cap eviction
// deterministically through `clock.tick()` instead of `vi.advanceTimersByTime`.
// The size-cap suite reads no time at all (eviction walks Map insertion
// order), so it does not touch the clock.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearLogImportJobs,
  createLogImportJob,
  getLogImportJob,
  setLogImportStatus,
} from './jobStore';
import { makeFakeClock } from './test/fakeClock';

const HOUR_MS = 60 * 60 * 1000;

let clock: ReturnType<typeof makeFakeClock>['clock'];
let tick: ReturnType<typeof makeFakeClock>['tick'];

beforeEach(() => {
  vi.useFakeTimers(); // tick() advances vitest's timer queue in lockstep (fakeClock.ts)
  ({ clock, tick } = makeFakeClock());
  clearLogImportJobs();
});

afterEach(() => {
  clearLogImportJobs();
  vi.useRealTimers();
});

describe('creator principal', () => {
  it('stores the creating user id on the job', () => {
    const job = createLogImportJob(clock, 'user-1');
    expect(job.createdByUserId).toBe('user-1');
    expect(getLogImportJob(clock, job.id)?.createdByUserId).toBe('user-1');
  });

  it('stores null for an anonymous creator', () => {
    const job = createLogImportJob(clock, null);
    expect(getLogImportJob(clock, job.id)?.createdByUserId).toBeNull();
  });
});

describe('terminal-TTL pruning', () => {
  it('prunes a completed job more than an hour after it finished', () => {
    const job = createLogImportJob(clock, null);
    setLogImportStatus(clock, job.id, 'completed');
    tick(HOUR_MS + 1);
    expect(getLogImportJob(clock, job.id)).toBeNull();
  });

  it('keeps a completed job within the TTL window', () => {
    const job = createLogImportJob(clock, null);
    setLogImportStatus(clock, job.id, 'completed');
    tick(HOUR_MS - 1);
    expect(getLogImportJob(clock, job.id)?.status).toBe('completed');
  });

  it('measures the TTL from finish time, not creation time', () => {
    const job = createLogImportJob(clock, null);
    setLogImportStatus(clock, job.id, 'running');
    tick(3 * HOUR_MS); // long-running import
    setLogImportStatus(clock, job.id, 'completed');
    tick(HOUR_MS - 1);
    expect(getLogImportJob(clock, job.id)?.status).toBe('completed');
    tick(2);
    expect(getLogImportJob(clock, job.id)).toBeNull();
  });

  it('prunes failed jobs the same way as completed ones', () => {
    const job = createLogImportJob(clock, null);
    setLogImportStatus(clock, job.id, 'failed', 'boom');
    tick(HOUR_MS + 1);
    expect(getLogImportJob(clock, job.id)).toBeNull();
  });

  it('never TTL-prunes a queued or running job, however old', () => {
    const queued = createLogImportJob(clock, null);
    const running = createLogImportJob(clock, null);
    setLogImportStatus(clock, running.id, 'running');
    tick(10 * HOUR_MS);
    expect(getLogImportJob(clock, queued.id)?.status).toBe('queued');
    expect(getLogImportJob(clock, running.id)?.status).toBe('running');
  });

  it('also prunes on insert, not just on lookup', () => {
    const stale = createLogImportJob(clock, null);
    setLogImportStatus(clock, stale.id, 'completed');
    tick(HOUR_MS + 1);
    const fresh = createLogImportJob(clock, null); // insert triggers the sweep
    // Read the map without another sweep dependency: the stale job is gone.
    expect(getLogImportJob(clock, stale.id)).toBeNull();
    expect(getLogImportJob(clock, fresh.id)).not.toBeNull();
  });
});

describe('finishedAtMs stamping', () => {
  it('is null while queued and stays null through running', () => {
    const job = createLogImportJob(clock, null);
    expect(job.finishedAtMs).toBeNull();
    setLogImportStatus(clock, job.id, 'running');
    expect(getLogImportJob(clock, job.id)?.finishedAtMs).toBeNull();
  });

  it('stamps the current time on completion', () => {
    const job = createLogImportJob(clock, null);
    tick(5 * 60 * 1000); // 5 minutes of "work"
    setLogImportStatus(clock, job.id, 'completed');
    expect(getLogImportJob(clock, job.id)?.finishedAtMs).toBe(clock.now());
    expect(getLogImportJob(clock, job.id)?.finishedAtMs).toBe(job.createdAtMs + 5 * 60 * 1000);
  });

  it('stamps the current time on failure, same as completion', () => {
    const job = createLogImportJob(clock, null);
    tick(1000);
    setLogImportStatus(clock, job.id, 'failed', 'boom');
    expect(getLogImportJob(clock, job.id)?.finishedAtMs).toBe(clock.now());
  });

  it('clears finishedAtMs if a terminal job is moved back to a non-terminal status', () => {
    const job = createLogImportJob(clock, null);
    setLogImportStatus(clock, job.id, 'completed');
    expect(getLogImportJob(clock, job.id)?.finishedAtMs).not.toBeNull();
    setLogImportStatus(clock, job.id, 'running');
    expect(getLogImportJob(clock, job.id)?.finishedAtMs).toBeNull();
  });

  it('re-stamps to the later time when a job transitions terminal twice', () => {
    const job = createLogImportJob(clock, null);
    setLogImportStatus(clock, job.id, 'completed');
    const firstStamp = getLogImportJob(clock, job.id)?.finishedAtMs;
    tick(30 * 1000);
    setLogImportStatus(clock, job.id, 'failed', 'boom');
    const secondStamp = getLogImportJob(clock, job.id)?.finishedAtMs;
    expect(secondStamp).toBe(clock.now());
    expect(secondStamp).not.toBe(firstStamp);
  });
});

// Size-cap eviction reads no time at all — it walks Map insertion order — so
// this suite never advances the clock; a single fixed reading exercises it
// (feature-service-packages spec scenario "Size-cap eviction is unchanged and
// reads no time").
describe('size cap (200), oldest-terminal-first eviction', () => {
  it('evicts the oldest terminal jobs once the map exceeds the cap', () => {
    const terminal: string[] = [];
    for (let i = 0; i < 200; i++) {
      const job = createLogImportJob(clock, null);
      // Half finish immediately (recently — inside the TTL window).
      if (i < 100) {
        setLogImportStatus(clock, job.id, 'completed');
        terminal.push(job.id);
      }
    }
    const extra = createLogImportJob(clock, null); // 201st insert triggers eviction
    expect(getLogImportJob(clock, extra.id)).not.toBeNull();
    // Exactly the single oldest terminal job was evicted to satisfy the cap.
    expect(getLogImportJob(clock, terminal[0] as string)).toBeNull();
    expect(getLogImportJob(clock, terminal[1] as string)).not.toBeNull();
  });

  it('never evicts queued/running jobs, even when the map exceeds the cap', () => {
    const live: string[] = [];
    for (let i = 0; i < 205; i++) {
      const job = createLogImportJob(clock, null);
      setLogImportStatus(clock, job.id, 'running');
      live.push(job.id);
    }
    // No terminal job to evict — every live job survives past the cap.
    for (const id of live) {
      expect(getLogImportJob(clock, id)?.status).toBe('running');
    }
  });

  it('evicts terminal jobs to make room while preserving live ones', () => {
    const first = createLogImportJob(clock, null);
    setLogImportStatus(clock, first.id, 'completed');
    const liveIds: string[] = [];
    for (let i = 0; i < 200; i++) {
      const job = createLogImportJob(clock, null);
      liveIds.push(job.id);
    }
    // The lone (oldest) terminal job was evicted; all 200 live jobs remain.
    expect(getLogImportJob(clock, first.id)).toBeNull();
    for (const id of liveIds) {
      expect(getLogImportJob(clock, id)?.status).toBe('queued');
    }
  });
});
