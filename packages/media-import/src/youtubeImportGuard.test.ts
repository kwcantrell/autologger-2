// youtube-audio-import (design D8, task 5.2) — unit tests for the import
// guard: per-session single-flight, released (idempotently) on `release()`.
// run-status-and-sweeper D2 removed the global ceiling.

import { beforeEach, describe, expect, it } from 'vitest';
import { youtubeImportGuard } from './youtubeImportGuard';

beforeEach(() => {
  youtubeImportGuard.reset();
});

describe('youtubeImportGuard — per-session single-flight', () => {
  it('a second concurrent acquire for the SAME session is rejected while the first is held', () => {
    const first = youtubeImportGuard.tryAcquire('session-a');
    expect(first).not.toBeNull();
    expect(youtubeImportGuard.isSessionInFlight('session-a')).toBe(true);

    const second = youtubeImportGuard.tryAcquire('session-a');
    expect(second).toBeNull();
    // global count reflects only the one genuinely-held slot, not a phantom second claim
    expect(youtubeImportGuard.activeCount).toBe(1);

    first?.release();
  });

  it('release frees the per-session slot so a later acquire for the same session succeeds', () => {
    const first = youtubeImportGuard.tryAcquire('session-a');
    first?.release();
    expect(youtubeImportGuard.isSessionInFlight('session-a')).toBe(false);

    const again = youtubeImportGuard.tryAcquire('session-a');
    expect(again).not.toBeNull();
    again?.release();
  });

  it('double-release is safe and does not underflow the global count', () => {
    const lease = youtubeImportGuard.tryAcquire('session-a');
    expect(youtubeImportGuard.activeCount).toBe(1);

    lease?.release();
    expect(youtubeImportGuard.activeCount).toBe(0);

    // second release on the same lease must be a no-op, not -1
    lease?.release();
    expect(youtubeImportGuard.activeCount).toBe(0);
    expect(youtubeImportGuard.isSessionInFlight('session-a')).toBe(false);
  });
});

describe('youtubeImportGuard — no ceiling (run-status-and-sweeper D2)', () => {
  it('three different sessions all acquire at once', () => {
    const leases = ['session-a', 'session-b', 'session-c'].map((id) =>
      youtubeImportGuard.tryAcquire(id),
    );
    for (const lease of leases) expect(lease).not.toBeNull();
    expect(youtubeImportGuard.activeCount).toBe(3);
    for (const lease of leases) lease?.release();
    expect(youtubeImportGuard.activeCount).toBe(0);
  });
});
