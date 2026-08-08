// youtube-audio-import (design D8, task 5.2) — unit tests for the two-axis
// concurrency guard: per-session single-flight AND a global concurrency
// ceiling, both released (idempotently) on `release()`.

import { beforeEach, describe, expect, it } from 'vitest';
import { YOUTUBE_IMPORT_MAX_CONCURRENT, youtubeImportGuard } from './youtubeImportGuard';

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

describe('youtubeImportGuard — global concurrency ceiling', () => {
  it('different sessions acquire concurrently up to the ceiling', () => {
    const leases = [];
    for (let i = 0; i < YOUTUBE_IMPORT_MAX_CONCURRENT; i++) {
      const lease = youtubeImportGuard.tryAcquire(`session-${i}`);
      expect(lease).not.toBeNull();
      leases.push(lease);
    }
    expect(youtubeImportGuard.activeCount).toBe(YOUTUBE_IMPORT_MAX_CONCURRENT);

    for (const lease of leases) lease?.release();
  });

  it('a DISTINCT session is rejected once the global ceiling is reached, even though its own session slot is free', () => {
    const held = [];
    for (let i = 0; i < YOUTUBE_IMPORT_MAX_CONCURRENT; i++) {
      held.push(youtubeImportGuard.tryAcquire(`session-${i}`));
    }
    expect(youtubeImportGuard.activeCount).toBe(YOUTUBE_IMPORT_MAX_CONCURRENT);

    // a brand-new session id — never seen before, so the per-session Set
    // would not reject it on its own — is still rejected by the ceiling
    const overflow = youtubeImportGuard.tryAcquire('session-overflow');
    expect(overflow).toBeNull();
    expect(youtubeImportGuard.isSessionInFlight('session-overflow')).toBe(false);
    expect(youtubeImportGuard.activeCount).toBe(YOUTUBE_IMPORT_MAX_CONCURRENT);

    for (const lease of held) lease?.release();
  });

  it('release frees a global slot so a subsequent distinct-session request is admitted', () => {
    const held = [];
    for (let i = 0; i < YOUTUBE_IMPORT_MAX_CONCURRENT; i++) {
      held.push(youtubeImportGuard.tryAcquire(`session-${i}`));
    }
    expect(youtubeImportGuard.tryAcquire('session-overflow')).toBeNull();

    // release exactly one held slot
    held[0]?.release();
    expect(youtubeImportGuard.activeCount).toBe(YOUTUBE_IMPORT_MAX_CONCURRENT - 1);

    const admitted = youtubeImportGuard.tryAcquire('session-overflow');
    expect(admitted).not.toBeNull();
    expect(youtubeImportGuard.activeCount).toBe(YOUTUBE_IMPORT_MAX_CONCURRENT);

    admitted?.release();
    for (const lease of held.slice(1)) lease?.release();
  });

  it('respects a caller-supplied maxConcurrent override, independent of the module default', () => {
    const first = youtubeImportGuard.tryAcquire('session-x', 1);
    expect(first).not.toBeNull();

    const second = youtubeImportGuard.tryAcquire('session-y', 1);
    expect(second).toBeNull();

    first?.release();
    const third = youtubeImportGuard.tryAcquire('session-y', 1);
    expect(third).not.toBeNull();
    third?.release();
  });
});
