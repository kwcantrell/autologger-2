// Waveform peaks and duration from a streamed decode (media-worker design D5): ffmpeg decodes the
// blob to 32-bit float WAV at 48 kHz on a pipe (what the browser's decodeAudioData does, and what
// server/scripts/backfillWaveforms.ts does), twice: once to count frames (the bucket boundaries
// depend on the total), once into @autologger/domain's DbPeaksAccumulator with the per-segment
// bucket rule. Memory is O(buckets); duration_ms comes from the decoded frames.

import type { Readable } from 'node:stream';
import {
  DbPeaksAccumulator,
  segmentWaveformDecodeBucketCount,
  WF_DB_FLOOR,
} from '@autologger/domain';

/** The decode rate for peaks (the browser's AudioContext rate; the backfill's `-ar`). */
export const PEAKS_SAMPLE_RATE = 48_000;

export interface WavFormat {
  channels: number;
  sampleRate: number;
  frames: number;
}

const MAX_HEADER_BYTES = 1 << 20;

/** Parses a float WAV stream (ffmpeg's `-c:a pcm_f32le -f wav pipe:1`: placeholder sizes, the
 * data chunk runs to the end) and hands each run of whole interleaved frames to `onSamples` (the
 * array is valid only during the call). Ported from backfillWaveforms.ts's `readWavPcm`. */
export async function readFloatWav(
  stream: Readable | AsyncIterable<Buffer>,
  onSamples: (samples: Float32Array, channels: number) => void,
): Promise<WavFormat> {
  let head: Buffer = Buffer.alloc(0);
  let fmt: { channels: number; sampleRate: number } | null = null;
  let inData = false;
  let rest: Buffer = Buffer.alloc(0);
  let frames = 0;

  const feed = (chunk: Buffer, channels: number): void => {
    const buf = rest.length ? Buffer.concat([rest, chunk]) : chunk;
    const frameBytes = 4 * channels;
    const usable = buf.length - (buf.length % frameBytes);
    rest = Buffer.from(buf.subarray(usable));
    if (usable === 0) return;
    const aligned = buf.byteOffset % 4 === 0 ? buf : Buffer.from(buf.subarray(0, usable));
    onSamples(new Float32Array(aligned.buffer, aligned.byteOffset, usable / 4), channels);
    frames += usable / frameBytes;
  };

  for await (const c of stream) {
    const chunk = c as Buffer;
    if (inData && fmt) {
      feed(chunk, fmt.channels);
      continue;
    }
    head = Buffer.concat([head, chunk]);
    if (head.length > MAX_HEADER_BYTES) throw new Error('not a WAV stream (no data chunk)');
    if (head.length < 12) continue;
    if (head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WAVE') {
      throw new Error('not a WAV stream');
    }
    let o = 12;
    while (!inData && head.length >= o + 8) {
      const id = head.toString('latin1', o, o + 4);
      const size = head.readUInt32LE(o + 4);
      if (id === 'data') {
        if (!fmt) throw new Error('WAV data before fmt');
        inData = true;
        o += 8;
        break;
      }
      const padded = size + (size % 2);
      if (head.length < o + 8 + padded) break;
      if (id === 'fmt ') {
        const tag = head.readUInt16LE(o + 8);
        const channels = head.readUInt16LE(o + 10);
        const sampleRate = head.readUInt32LE(o + 12);
        const bits = head.readUInt16LE(o + 22);
        const sub = tag === 0xfffe && size >= 26 ? head.readUInt16LE(o + 32) : tag;
        if (sub !== 3 || bits !== 32 || channels < 1)
          throw new Error('WAV is not 32-bit float PCM');
        fmt = { channels, sampleRate };
      }
      o += 8 + padded;
    }
    if (inData && fmt) {
      const tail = head.subarray(o);
      head = Buffer.alloc(0);
      if (tail.length) feed(tail, fmt.channels);
    }
  }
  if (!inData || !fmt) throw new Error('not a WAV stream (no data chunk)');
  if (rest.length) throw new Error('decoded audio ends in a torn frame');
  return { ...fmt, frames };
}

/** One full decode of the input at PEAKS_SAMPLE_RATE, streaming samples to `onSamples`. */
export type FloatDecode = (
  onSamples: (s: Float32Array, channels: number) => void,
) => Promise<WavFormat>;

export interface PeaksResult {
  peaks: number[];
  frames: number;
  channels: number;
  durationMs: number;
}

/** Two decodes: count, then accumulate over exactly that many frames (the second must agree). */
export async function peaksFromDecodes(decode: FloatDecode): Promise<PeaksResult> {
  const first = await decode(() => {});
  if (first.frames === 0) throw new Error('no audio decoded');
  if (first.sampleRate !== PEAKS_SAMPLE_RATE) throw new Error('peaks decode is not at 48 kHz');
  const durationSec = first.frames / first.sampleRate;
  const buckets = segmentWaveformDecodeBucketCount(durationSec, durationSec);
  const acc = new DbPeaksAccumulator(first.frames, buckets, WF_DB_FLOOR);
  const second = await decode((s, ch) => acc.pushInterleaved(s, ch));
  if (second.frames !== first.frames || second.channels !== first.channels) {
    throw new Error('the two decodes disagree');
  }
  return {
    peaks: Array.from(acc.finish(), Number),
    frames: first.frames,
    channels: first.channels,
    durationMs: Math.round(durationSec * 1000),
  };
}
