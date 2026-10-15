// media-worker B.5 (design D3): result validation before anything is applied. The apply itself
// runs over real bindings in mediaApply.int.test.ts.
import { describe, expect, it } from 'vitest';
import { validateIngestResult, validateMergeResult, validMediaKey } from './mediaApply';

const PEAKS = Array.from({ length: 8 }, (_, i) => i / 8);
const J = 'job-1';

describe('validMediaKey', () => {
  it('accepts exactly media/<job>/<plain name>', () => {
    expect(validMediaKey(J, 'media/job-1/out.webm')).toBe(true);
    for (const bad of [
      'media/../audio/x.webm',
      'media/job-1/../x',
      'media/job-2/out.webm',
      'media/job-1/a/b',
      'audio/s/x.webm',
      'media/job-1/.hidden',
      'media/job-1/',
      7,
    ]) {
      expect(validMediaKey(J, bad), String(bad)).toBe(false);
    }
  });
});

describe('validateIngestResult', () => {
  const ok = {
    duration_ms: 1000,
    peaks: PEAKS,
    codec: 'opus',
    sample_rate: 48000,
    channels: 1,
    flac: null,
  };
  it('accepts a result with and without a FLAC', () => {
    expect(validateIngestResult(J, JSON.stringify(ok)).ok).toBe(true);
    expect(
      validateIngestResult(
        J,
        JSON.stringify({ ...ok, flac: { key: 'media/job-1/c.flac', mime: 'audio/flac' } }),
      ).ok,
    ).toBe(true);
  });
  it('refuses bad peaks, durations, keys and junk', () => {
    for (const bad of [
      { ...ok, peaks: [0.1] },
      { ...ok, peaks: [...PEAKS.slice(1), 1.5] },
      { ...ok, peaks: Array(4097).fill(0) },
      { ...ok, duration_ms: 0 },
      { ...ok, duration_ms: 1.5 },
      { ...ok, flac: { key: 'media/../audio/x.flac', mime: 'audio/flac' } },
      { ...ok, flac: { key: 'media/job-1/c.flac', mime: 'audio/wav' } },
    ]) {
      expect(
        validateIngestResult(J, JSON.stringify(bad)).ok,
        JSON.stringify(bad).slice(0, 60),
      ).toBe(false);
    }
    expect(validateIngestResult(J, 'not json').ok).toBe(false);
    expect(validateIngestResult(J, null).ok).toBe(false);
  });
});

describe('validateMergeResult', () => {
  const ok = {
    key: 'media/job-1/merged.webm',
    mime: 'audio/webm',
    duration_ms: 2000,
    peaks: PEAKS,
    seams: [
      { offset_ms: 0, started_at_utc: 'a', ended_at_utc: 'b', source_key: 'audio/s/1.webm' },
      { offset_ms: 1000, started_at_utc: 'b', ended_at_utc: null, source_key: 'audio/s/2.webm' },
    ],
    input_ids: ['s1', 's2'],
    verify: { merged_samples: 1, expected_samples: 1 },
  };
  it('accepts a well-formed result', () => {
    expect(validateMergeResult(J, JSON.stringify(ok)).ok).toBe(true);
  });
  it('refuses a foreign key, an unknown mime, bad seams and no inputs', () => {
    for (const bad of [
      { ...ok, key: 'media/other/merged.webm' },
      { ...ok, mime: 'text/html' },
      { ...ok, seams: [] },
      { ...ok, seams: [{ ...ok.seams[0], offset_ms: -1 }] },
      { ...ok, seams: [ok.seams[0], ok.seams[0]] },
      { ...ok, input_ids: [] },
      { ...ok, peaks: [2, 2, 2, 2, 2, 2, 2, 2] },
    ]) {
      expect(validateMergeResult(J, JSON.stringify(bad)).ok, JSON.stringify(bad).slice(0, 60)).toBe(
        false,
      );
    }
  });
});

describe('startMediaApply (D3)', () => {
  it('passes never overlap; a wake during a pass runs exactly one more', async () => {
    const { startMediaApply } = await import('./mediaApply');
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const deps = {
      db: { all: async () => [], run: async () => ({ changes: 0 }) },
      jobs: {
        doneJobs: async () => {
          calls += 1;
          if (calls === 1) await gate;
          return [];
        },
      },
      sessions: {},
      blobs: {},
      clock: { now: () => 0 },
      log: () => {},
    } as never;
    const loop = startMediaApply(deps, { intervalMs: 3_600_000 });
    loop.wake();
    loop.wake();
    loop.wake();
    release();
    await loop.idle();
    await loop.idle();
    loop.stop();
    expect(calls).toBe(2);
  });
});

describe('mediaErrorCodeOf (B.9)', () => {
  it('keeps a fixed code and maps anything else to internal', async () => {
    const { mediaErrorCodeOf } = await import('./mediaApply');
    expect(mediaErrorCodeOf('decode-failed')).toBe('decode-failed');
    for (const bad of [null, '', '/blobs/audio/x', 'DECODE-FAILED', '<script>']) {
      expect(mediaErrorCodeOf(bad)).toBe('internal');
    }
  });
});

describe('main.ts shutdown (B.9)', () => {
  it('stops the apply loop and awaits an in-flight pass before closing the hubs and the database', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
    const handler = src.slice(src.indexOf("for (const sig of ['SIGINT', 'SIGTERM']"));
    const stop = handler.indexOf('mediaApply.stop()');
    const idle = handler.indexOf('mediaApply.idle()');
    const close = handler.indexOf('close()', idle);
    expect(stop).toBeGreaterThan(-1);
    expect(idle).toBeGreaterThan(stop);
    expect(close).toBeGreaterThan(idle);
  });
});
