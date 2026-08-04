import { afterEach, describe, expect, it } from 'vitest';
import { generationInFlightDetail, TranscriptGenerationLock } from './transcriptGenerationLock';

describe('TranscriptGenerationLock', () => {
  const lock = new TranscriptGenerationLock();

  afterEach(() => {
    lock.reset();
  });

  it('starts idle with no holder metadata', () => {
    expect(lock.getLock()).toBeNull();
  });

  it('tryAcquire succeeds once and records sessionId + startedAtMs', () => {
    expect(lock.tryAcquire('sess-a', 1_700_000_000_000)).toBe(true);
    expect(lock.getLock()).toEqual({ sessionId: 'sess-a', startedAtMs: 1_700_000_000_000 });
  });

  it('tryAcquire returns false while the slot is held', () => {
    expect(lock.tryAcquire('sess-a', 100)).toBe(true);
    expect(lock.tryAcquire('sess-b', 200)).toBe(false);
    expect(lock.getLock()?.sessionId).toBe('sess-a');
  });

  it('release clears the slot so a later acquire succeeds', () => {
    expect(lock.tryAcquire('sess-a', 100)).toBe(true);
    lock.release();
    expect(lock.getLock()).toBeNull();
    expect(lock.tryAcquire('sess-b', 200)).toBe(true);
    expect(lock.getLock()?.sessionId).toBe('sess-b');
  });

  // NOTE (pr-3-review): release-on-failure of the PRODUCTION `finally` in
  // generateTranscriptWords cannot be proven at this class level — a local
  // try/finally that calls release() itself only re-tests `release` above.
  // The real proof lives in transcribe.int.test.ts ("a failed run releases
  // the process-wide lock on its own — no manual reset needed"), which runs
  // a failing generation and asserts the slot is free BEFORE any reset.
});

describe('generationInFlightDetail', () => {
  it('prefers catalog title over session id', () => {
    const detail = generationInFlightDetail('uuid-1', 'HD_384', 1_700_000_000_000);
    expect(detail).toContain('HD_384');
    expect(detail).not.toContain('uuid-1');
    expect(detail).toContain('2023-11-14T22:13:20.000Z');
  });

  it('falls back to session id when title is absent', () => {
    const detail = generationInFlightDetail('uuid-1', null, 1_700_000_000_000);
    expect(detail).toContain('"uuid-1"');
  });
});
