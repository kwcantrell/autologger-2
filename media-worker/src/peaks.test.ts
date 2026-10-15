import { Readable } from 'node:stream';
import {
  DbPeaksAccumulator,
  segmentWaveformDecodeBucketCount,
  WF_DB_FLOOR,
} from '@autologger/domain';
import { describe, expect, it } from 'vitest';
import { PEAKS_SAMPLE_RATE, peaksFromDecodes, readFloatWav } from './peaks';

/** A 32-bit float WAV as ffmpeg pipes it (size fields 0xFFFFFFFF, a LIST chunk first). */
function floatWav(channels: Float32Array[], rate: number): Buffer {
  const n = channels.length;
  const len = channels[0].length;
  const data = Buffer.alloc(len * n * 4);
  for (let i = 0; i < len; i++)
    for (let c = 0; c < n; c++) data.writeFloatLE(channels[c][i], (i * n + c) * 4);
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(3, 0);
  fmt.writeUInt16LE(n, 2);
  fmt.writeUInt32LE(rate, 4);
  fmt.writeUInt32LE(rate * n * 4, 8);
  fmt.writeUInt16LE(n * 4, 12);
  fmt.writeUInt16LE(32, 14);
  const hdr = (id: string, size: number) => {
    const h = Buffer.alloc(8);
    h.write(id, 0, 'latin1');
    h.writeUInt32LE(size, 4);
    return h;
  };
  return Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.from([0xff, 0xff, 0xff, 0xff]),
    Buffer.from('WAVE'),
    hdr('fmt ', 16),
    fmt,
    hdr('LIST', 3),
    Buffer.from('abc\0'),
    hdr('data', 0xffffffff),
    data,
  ]);
}

function wave(len: number, seed: number, gain: number): Float32Array {
  let s = seed;
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    out[i] = gain * ((s / 2147483648) * 2 - 1) * Math.abs(Math.sin(i / 9001));
  }
  return out;
}

/** Splits a buffer into awkward chunk sizes (not frame-aligned, not 4-byte aligned). */
function chunked(buf: Buffer, sizes = [7, 1, 333, 4096, 13]): Readable {
  const parts: Buffer[] = [];
  let o = 0;
  let i = 0;
  while (o < buf.length) {
    const n = sizes[i++ % sizes.length];
    parts.push(buf.subarray(o, o + n));
    o += n;
  }
  return Readable.from(parts);
}

describe('readFloatWav: streaming f32 pipe', () => {
  it('parses the header and hands over whole frames only, at any chunking', async () => {
    const l = wave(10_001, 1, 0.5);
    const r = wave(10_001, 2, 0.25);
    let frames = 0;
    let first = Number.NaN;
    const fmt = await readFloatWav(chunked(floatWav([l, r], 44_100)), (s, ch) => {
      expect(ch).toBe(2);
      expect(s.length % 2).toBe(0);
      if (frames === 0) first = s[0];
      frames += s.length / 2;
    });
    expect(fmt).toEqual({ channels: 2, sampleRate: 44_100, frames: 10_001 });
    expect(frames).toBe(10_001);
    expect(first).toBe(l[0]);
  });

  it('refuses a non-float or truncated stream', async () => {
    await expect(
      readFloatWav(Readable.from([Buffer.from('not a wav at all')]), () => {}),
    ).rejects.toThrow();
    const torn = floatWav([wave(10, 1, 0.5)], 48_000).subarray(0, -3);
    await expect(readFloatWav(Readable.from([torn]), () => {})).rejects.toThrow(/torn/);
  });
});

describe('peaksFromDecodes: two passes, the backfill/browser bucket rule', () => {
  it('equals DbPeaksAccumulator over the same PCM with segmentWaveformDecodeBucketCount(dur, dur)', async () => {
    const ch = [wave(48_000 * 3 + 17, 5, 0.8), wave(48_000 * 3 + 17, 6, 0.1)];
    const wav = floatWav(ch, PEAKS_SAMPLE_RATE);
    let passes = 0;
    const out = await peaksFromDecodes(async (onSamples) => {
      passes += 1;
      return readFloatWav(chunked(wav), onSamples);
    });
    expect(passes).toBe(2);
    const len = ch[0].length;
    const buckets = segmentWaveformDecodeBucketCount(
      len / PEAKS_SAMPLE_RATE,
      len / PEAKS_SAMPLE_RATE,
    );
    const acc = new DbPeaksAccumulator(len, buckets, WF_DB_FLOOR);
    const inter = new Float32Array(len * 2);
    for (let i = 0; i < len; i++) {
      inter[i * 2] = ch[0][i];
      inter[i * 2 + 1] = ch[1][i];
    }
    acc.pushInterleaved(inter, 2);
    expect(out.peaks).toEqual(Array.from(acc.finish(), Number));
    expect(out.frames).toBe(len);
    expect(out.channels).toBe(2);
    expect(out.durationMs).toBe(Math.round((len / PEAKS_SAMPLE_RATE) * 1000));
  });

  it('duration comes from frames, not headers', async () => {
    const wav = floatWav([new Float32Array(24_000)], PEAKS_SAMPLE_RATE);
    const out = await peaksFromDecodes((on) => readFloatWav(Readable.from([wav]), on));
    expect(out.durationMs).toBe(500);
    expect(out.peaks.length).toBe(4096); // span = own duration → 10000, clamped
    expect(out.peaks.every((p) => p === 0)).toBe(true);
  });

  it('no audio, or a second pass that disagrees, fails', async () => {
    const empty = floatWav([new Float32Array(0)], PEAKS_SAMPLE_RATE);
    await expect(
      peaksFromDecodes((on) => readFloatWav(Readable.from([empty]), on)),
    ).rejects.toThrow(/no audio/);
    let n = 0;
    await expect(
      peaksFromDecodes((on) =>
        readFloatWav(
          Readable.from([floatWav([new Float32Array(n++ === 0 ? 1000 : 999)], PEAKS_SAMPLE_RATE)]),
          on,
        ),
      ),
    ).rejects.toThrow();
  });
});
