import { describe, expect, it } from 'vitest';
import {
  DbPeaksAccumulator,
  segmentWaveformDecodeBucketCount,
  WF_DB_FLOOR,
  WF_SEGMENT_DECODE_MAX,
  WF_SEGMENT_DECODE_MIN,
} from './waveformPeaks';

/** Straightforward reference: whole-buffer max-abs per bucket, dB envelope (the browser's math). */
function reference(channels: Float32Array[], bucketCount: number, dbFloor: number): Float32Array {
  const len = channels[0]?.length ?? 0;
  const peaks = new Float32Array(bucketCount);
  if (len === 0) return peaks;
  const merged = new Float32Array(len);
  for (const ch of channels)
    for (let i = 0; i < len; i++) merged[i] = Math.max(merged[i], Math.abs(ch[i]));
  const spp = len / bucketCount;
  for (let b = 0; b < bucketCount; b++) {
    const start = Math.floor(b * spp);
    const end = Math.min(len, Math.floor((b + 1) * spp));
    let m = 0;
    for (let i = start; i < end; i++) if (merged[i] > m) m = merged[i];
    const db = Math.max(dbFloor, Math.min(0, 20 * Math.log10(Math.max(m, 1e-10))));
    peaks[b] = (db - dbFloor) / -dbFloor;
  }
  return peaks;
}

function interleave(channels: Float32Array[]): Float32Array {
  const n = channels.length;
  const len = channels[0].length;
  const out = new Float32Array(len * n);
  for (let i = 0; i < len; i++) for (let c = 0; c < n; c++) out[i * n + c] = channels[c][i];
  return out;
}

function noise(len: number, seed: number): Float32Array {
  let s = seed;
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    out[i] = ((s / 2147483648) * 2 - 1) * Math.sin(i / 997) ** 2;
  }
  return out;
}

function accumulate(
  channels: Float32Array[],
  bucketCount: number,
  chunkFrames: number,
  dbFloor = WF_DB_FLOOR,
): Float32Array {
  const n = channels.length;
  const inter = interleave(channels);
  const acc = new DbPeaksAccumulator(channels[0].length, bucketCount, dbFloor);
  for (let f = 0; f < channels[0].length; f += chunkFrames) {
    acc.pushInterleaved(inter.subarray(f * n, Math.min(inter.length, (f + chunkFrames) * n)), n);
  }
  return acc.finish();
}

describe('DbPeaksAccumulator', () => {
  it('equals the whole-buffer computation bit for bit, whatever the chunking', () => {
    const chans = [noise(48_000 * 3 + 17, 1), noise(48_000 * 3 + 17, 2)];
    const want = reference(chans, 4096, WF_DB_FLOOR);
    for (const chunk of [1, 7, 1024, 48_000, 10_000_000]) {
      expect(accumulate(chans, 4096, chunk)).toEqual(want);
    }
  });

  it('handles more buckets than frames (empty buckets sit at the floor) and a mono input', () => {
    const chans = [noise(1000, 3)];
    expect(accumulate(chans, 4096, 333)).toEqual(reference(chans, 4096, WF_DB_FLOOR));
  });

  it('honours another floor and maps full scale to 1 and silence to 0', () => {
    const loud = new Float32Array(4800).fill(1);
    const quiet = new Float32Array(4800);
    expect(Array.from(accumulate([loud], 8, 100))).toEqual(Array(8).fill(1));
    expect(Array.from(accumulate([quiet], 8, 100))).toEqual(Array(8).fill(0));
    const chans = [noise(9000, 4), noise(9000, 5), noise(9000, 6)];
    expect(accumulate(chans, 256, 500, -72)).toEqual(reference(chans, 256, -72));
  });

  it('returns all zeros for zero frames, like the browser', () => {
    const acc = new DbPeaksAccumulator(0, 8);
    expect(Array.from(acc.finish())).toEqual(Array(8).fill(0));
  });

  it('refuses a frame count that differs from the announced total', () => {
    const acc = new DbPeaksAccumulator(10, 8);
    acc.pushInterleaved(new Float32Array(8), 1);
    expect(() => acc.finish()).toThrow(/frames/);
    const over = new DbPeaksAccumulator(2, 8);
    expect(() => over.pushInterleaved(new Float32Array(6), 2)).toThrow(/frames/);
  });

  it('refuses a chunk that is not whole frames', () => {
    const acc = new DbPeaksAccumulator(10, 8);
    expect(() => acc.pushInterleaved(new Float32Array(3), 2)).toThrow(/whole frames/);
  });
});

describe('segmentWaveformDecodeBucketCount', () => {
  it('a segment decoded on its own (span = its duration) gets the maximum once it is long enough', () => {
    expect(segmentWaveformDecodeBucketCount(3600, 3600)).toBe(WF_SEGMENT_DECODE_MAX);
    expect(segmentWaveformDecodeBucketCount(1, 1)).toBe(WF_SEGMENT_DECODE_MAX);
    expect(segmentWaveformDecodeBucketCount(0.2, 0.2)).toBe(2000);
    expect(segmentWaveformDecodeBucketCount(0.01, 0.01)).toBe(500);
  });

  it('scales with the share of the timeline span, clamped to [256, 4096]', () => {
    expect(segmentWaveformDecodeBucketCount(60, 600)).toBe(1000);
    expect(segmentWaveformDecodeBucketCount(1, 3600)).toBe(WF_SEGMENT_DECODE_MIN);
    expect(segmentWaveformDecodeBucketCount(Number.NaN, 0)).toBe(500);
  });
});
