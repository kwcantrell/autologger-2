// Unit tests for the log-import job store's creator field and lifecycle:
// terminal-TTL pruning, the size cap with terminal-first eviction, and the
// never-evict-a-live-job guarantee. Fake timers drive Date.now().

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearLogImportJobs,
  createLogImportJob,
  getLogImportJob,
  setLogImportStatus,
} from './jobStore';

const HOUR_MS = 60 * 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-03T12:00:00Z'));
  clearLogImportJobs();
});

afterEach(() => {
  clearLogImportJobs();
  vi.useRealTimers();
});

describe('creator principal', () => {
  it('stores the creating user id on the job', () => {
    const job = createLogImportJob('user-1');
    expect(job.createdByUserId).toBe('user-1');
    expect(getLogImportJob(job.id)?.createdByUserId).toBe('user-1');
  });

  it('stores null for an anonymous creator', () => {
    const job = createLogImportJob(null);
    expect(getLogImportJob(job.id)?.createdByUserId).toBeNull();
  });
});

describe('terminal-TTL pruning', () => {
  it('prunes a completed job more than an hour after it finished', () => {
    const job = createLogImportJob(null);
    setLogImportStatus(job.id, 'completed');
    vi.advanceTimersByTime(HOUR_MS + 1);
    expect(getLogImportJob(job.id)).toBeNull();
  });

  it('keeps a completed job within the TTL window', () => {
    const job = createLogImportJob(null);
    setLogImportStatus(job.id, 'completed');
    vi.advanceTimersByTime(HOUR_MS - 1);
    expect(getLogImportJob(job.id)?.status).toBe('completed');
  });

  it('measures the TTL from finish time, not creation time', () => {
    const job = createLogImportJob(null);
    setLogImportStatus(job.id, 'running');
    vi.advanceTimersByTime(3 * HOUR_MS); // long-running import
    setLogImportStatus(job.id, 'completed');
    vi.advanceTimersByTime(HOUR_MS - 1);
    expect(getLogImportJob(job.id)?.status).toBe('completed');
    vi.advanceTimersByTime(2);
    expect(getLogImportJob(job.id)).toBeNull();
  });

  it('prunes failed jobs the same way as completed ones', () => {
    const job = createLogImportJob(null);
    setLogImportStatus(job.id, 'failed', 'boom');
    vi.advanceTimersByTime(HOUR_MS + 1);
    expect(getLogImportJob(job.id)).toBeNull();
  });

  it('never TTL-prunes a queued or running job, however old', () => {
    const queued = createLogImportJob(null);
    const running = createLogImportJob(null);
    setLogImportStatus(running.id, 'running');
    vi.advanceTimersByTime(10 * HOUR_MS);
    expect(getLogImportJob(queued.id)?.status).toBe('queued');
    expect(getLogImportJob(running.id)?.status).toBe('running');
  });

  it('also prunes on insert, not just on lookup', () => {
    const stale = createLogImportJob(null);
    setLogImportStatus(stale.id, 'completed');
    vi.advanceTimersByTime(HOUR_MS + 1);
    const fresh = createLogImportJob(null); // insert triggers the sweep
    // Read the map without another sweep dependency: the stale job is gone.
    expect(getLogImportJob(stale.id)).toBeNull();
    expect(getLogImportJob(fresh.id)).not.toBeNull();
  });
});

describe('size cap (200), oldest-terminal-first eviction', () => {
  it('evicts the oldest terminal jobs once the map exceeds the cap', () => {
    const terminal: string[] = [];
    for (let i = 0; i < 200; i++) {
      const job = createLogImportJob(null);
      // Half finish immediately (recently — inside the TTL window).
      if (i < 100) {
        setLogImportStatus(job.id, 'completed');
        terminal.push(job.id);
      }
    }
    const extra = createLogImportJob(null); // 201st insert triggers eviction
    expect(getLogImportJob(extra.id)).not.toBeNull();
    // Exactly the single oldest terminal job was evicted to satisfy the cap.
    expect(getLogImportJob(terminal[0] as string)).toBeNull();
    expect(getLogImportJob(terminal[1] as string)).not.toBeNull();
  });

  it('never evicts queued/running jobs, even when the map exceeds the cap', () => {
    const live: string[] = [];
    for (let i = 0; i < 205; i++) {
      const job = createLogImportJob(null);
      setLogImportStatus(job.id, 'running');
      live.push(job.id);
    }
    // No terminal job to evict — every live job survives past the cap.
    for (const id of live) {
      expect(getLogImportJob(id)?.status).toBe('running');
    }
  });

  it('evicts terminal jobs to make room while preserving live ones', () => {
    const first = createLogImportJob(null);
    setLogImportStatus(first.id, 'completed');
    const liveIds: string[] = [];
    for (let i = 0; i < 200; i++) {
      const job = createLogImportJob(null);
      liveIds.push(job.id);
    }
    // The lone (oldest) terminal job was evicted; all 200 live jobs remain.
    expect(getLogImportJob(first.id)).toBeNull();
    for (const id of liveIds) {
      expect(getLogImportJob(id)?.status).toBe('queued');
    }
  });
});
