import { afterEach, describe, expect, it } from 'vitest';
import {
  TranscriptGenerationLock,
  generationInFlightDetail,
} from './transcriptGenerationLock';

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

  it('release in finally semantics: errors after acquire still free the slot', () => {
    expect(lock.tryAcquire('sess-a', 100)).toBe(true);
    try {
      throw new Error('simulated route failure');
    } catch {
      // route handler would catch/rethrow after this
    } finally {
      lock.release();
    }
    expect(lock.getLock()).toBeNull();
    expect(lock.tryAcquire('sess-b', 200)).toBe(true);
  });
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
