// Test fixtures for the waveform backfill tests: float WAV bytes and expected peaks for known PCM.

import {
  DbPeaksAccumulator,
  segmentWaveformDecodeBucketCount,
  WF_DB_FLOOR,
} from '@autologger/domain';

/** A WAVE_FORMAT_IEEE_FLOAT file with interleaved Float32 frames (what ffmpeg pipes out). */
export function floatWav(channels: Float32Array[], rate: number, dataSize = -1): Buffer {
  const n = channels.length;
  const len = channels[0].length;
  const data = Buffer.alloc(len * n * 4);
  for (let i = 0; i < len; i++)
    for (let c = 0; c < n; c++) data.writeFloatLE(channels[c][i], (i * n + c) * 4);
  const fmt = Buffer.alloc(18);
  fmt.writeUInt16LE(3, 0);
  fmt.writeUInt16LE(n, 2);
  fmt.writeUInt32LE(rate, 4);
  fmt.writeUInt32LE(rate * n * 4, 8);
  fmt.writeUInt16LE(n * 4, 12);
  fmt.writeUInt16LE(32, 14);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0);
  head.writeUInt32LE(0xffffffff, 4);
  head.write('WAVE', 8);
  const fmtHdr = Buffer.alloc(8);
  fmtHdr.write('fmt ', 0);
  fmtHdr.writeUInt32LE(18, 4);
  const junk = Buffer.concat([
    Buffer.from('JUNK'),
    Buffer.from([3, 0, 0, 0]),
    Buffer.from('abc\0'),
  ]);
  const dataHdr = Buffer.alloc(8);
  dataHdr.write('data', 0);
  dataHdr.writeUInt32LE(dataSize < 0 ? 0xffffffff : dataSize, 4);
  return Buffer.concat([head, fmtHdr, fmt, junk, dataHdr, data]);
}

export function wave(len: number, seed: number, gain: number): Float32Array {
  let s = seed;
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    out[i] = gain * ((s / 2147483648) * 2 - 1) * Math.abs(Math.sin(i / 9001));
  }
  return out;
}

export function expectedPeaks(channels: Float32Array[], rate: number): Float32Array {
  const len = channels[0].length;
  const buckets = segmentWaveformDecodeBucketCount(len / rate, len / rate);
  const acc = new DbPeaksAccumulator(len, buckets, WF_DB_FLOOR);
  const n = channels.length;
  const inter = new Float32Array(len * n);
  for (let i = 0; i < len; i++) for (let c = 0; c < n; c++) inter[i * n + c] = channels[c][i];
  acc.pushInterleaved(inter, n);
  return acc.finish();
}
