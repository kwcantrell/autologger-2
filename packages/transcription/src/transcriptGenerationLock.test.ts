import { afterEach, describe, expect, it } from 'vitest';
import { generationInFlightDetail, TranscriptGenerationRuns } from './transcriptGenerationLock';

// Per-session transcript generation runs (run-status-and-sweeper D3): one run per session in this
// process, any number of sessions at once.
describe('TranscriptGenerationRuns', () => {
  const runs = new TranscriptGenerationRuns();

  afterEach(() => {
    runs.reset();
  });

  it('starts idle: no session has a start time', () => {
    expect(runs.startedAt('sess-a')).toBeNull();
  });

  it('tryAcquire records the start time of that session', () => {
    expect(runs.tryAcquire('sess-a', 1_700_000_000_000)).toBe(true);
    expect(runs.startedAt('sess-a')).toBe(1_700_000_000_000);
    expect(runs.startedAt('sess-b')).toBeNull();
  });

  it('two sessions both acquire, each with its own start time', () => {
    expect(runs.tryAcquire('sess-a', 100)).toBe(true);
    expect(runs.tryAcquire('sess-b', 200)).toBe(true);
    expect(runs.startedAt('sess-a')).toBe(100);
    expect(runs.startedAt('sess-b')).toBe(200);
  });

  it('the same session is refused while it runs, and keeps its first start time', () => {
    expect(runs.tryAcquire('sess-a', 100)).toBe(true);
    expect(runs.tryAcquire('sess-a', 200)).toBe(false);
    expect(runs.startedAt('sess-a')).toBe(100);
  });

  it('release frees only that session, and is idempotent', () => {
    expect(runs.tryAcquire('sess-a', 100)).toBe(true);
    expect(runs.tryAcquire('sess-b', 200)).toBe(true);
    runs.release('sess-a');
    runs.release('sess-a');
    expect(runs.startedAt('sess-a')).toBeNull();
    expect(runs.startedAt('sess-b')).toBe(200);
    expect(runs.tryAcquire('sess-a', 300)).toBe(true);
    expect(runs.startedAt('sess-a')).toBe(300);
  });

  it('reset frees every session', () => {
    expect(runs.tryAcquire('sess-a', 100)).toBe(true);
    expect(runs.tryAcquire('sess-b', 200)).toBe(true);
    runs.reset();
    expect(runs.startedAt('sess-a')).toBeNull();
    expect(runs.startedAt('sess-b')).toBeNull();
    expect(runs.tryAcquire('sess-b', 300)).toBe(true);
  });

  // NOTE (pr-3-review): release-on-failure of the PRODUCTION `finally` in
  // generateTranscriptWords cannot be proven at this class level. The real proof lives in
  // transcribe.int.test.ts ("a failed run releases ... on its own"), which runs a failing
  // generation and asserts the session's slot is free BEFORE any reset.
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
