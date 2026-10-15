// WAV → FLAC conversion and its verification (media-worker design D5), ported from #107's
// server/scripts/convertWavToFlac.ts (`probeWavHeader`, `parseFlacStreamInfo`, `verifyPair`,
// `pcmDigest`) rather than imported: the worker image carries no server/scripts. A conversion is
// kept only when the FLAC's STREAMINFO carries the WAV's rate, channels and bit depth, both decode
// to the same PCM (MD5 and byte count), and the sample counts agree.

import { chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { type Prepared, pcmDigest, runOn } from './decode';
import { flacEncodeArgs, readAt } from './ffmpeg';
import { type JobCtx, JobFailure } from './jobs/types';
import { openOwn } from './output';

export type WavProbe =
  | { ok: true; channels: number; sampleRate: number; bitsPerSample: 16 | 24 }
  | { ok: false; reason: string };

/** Reads the RIFF/WAVE `fmt ` chunk: 16/24-bit integer PCM (plain or extensible) is convertible. */
export function probeWavHeader(head: Buffer): WavProbe {
  if (
    head.length < 12 ||
    head.toString('latin1', 0, 4) !== 'RIFF' ||
    head.toString('latin1', 8, 12) !== 'WAVE'
  ) {
    return { ok: false, reason: 'not a RIFF/WAVE file' };
  }
  let o = 12;
  while (head.length >= o + 8) {
    const id = head.toString('latin1', o, o + 4);
    const size = head.readUInt32LE(o + 4);
    if (id === 'fmt ') {
      if (size < 16 || head.length < o + 8 + size)
        return { ok: false, reason: 'truncated fmt chunk' };
      const tag = head.readUInt16LE(o + 8);
      const channels = head.readUInt16LE(o + 10);
      const sampleRate = head.readUInt32LE(o + 12);
      const bits = head.readUInt16LE(o + 22);
      const sub = tag === 0xfffe && size >= 40 ? head.readUInt16LE(o + 8 + 24) : tag;
      if (sub === 3) return { ok: false, reason: 'float PCM: FLAC is integer-only' };
      if (sub !== 1) return { ok: false, reason: 'not integer PCM' };
      if (bits !== 16 && bits !== 24) return { ok: false, reason: `${bits}-bit PCM` };
      if (channels < 1 || channels > 8) return { ok: false, reason: `${channels} channels` };
      if (sampleRate < 1 || sampleRate > 655_350) return { ok: false, reason: 'sample rate' };
      return { ok: true, channels, sampleRate, bitsPerSample: bits };
    }
    if (id === 'data') break;
    o += 8 + size + (size % 2);
  }
  return { ok: false, reason: 'no fmt chunk before the audio data' };
}

export interface FlacStreamInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  totalSamples: number;
}

/** `fLaC` + STREAMINFO (always the first metadata block). */
export function parseFlacStreamInfo(head: Buffer): FlacStreamInfo {
  if (head.length < 42 || head.toString('latin1', 0, 4) !== 'fLaC' || (head[4] & 0x7f) !== 0) {
    throw new Error('not a FLAC stream (no fLaC/STREAMINFO)');
  }
  return {
    sampleRate: (head[18] << 12) | (head[19] << 4) | (head[20] >> 4),
    channels: ((head[20] >> 1) & 7) + 1,
    bitsPerSample: (((head[20] & 1) << 4) | (head[21] >> 4)) + 1,
    totalSamples: (head[21] & 0x0f) * 2 ** 32 + head.readUInt32BE(22),
  };
}

/** Encodes `wav` into `<jobDir>/<name>` (mode 0644) and verifies it; returns the frame count. */
export async function convertToFlac(
  ctx: JobCtx,
  wav: Prepared,
  probe: Extract<WavProbe, { ok: true }>,
  jobDirAbs: string,
  name: string,
): Promise<{ frames: number }> {
  const out = join(jobDirAbs, name);
  await runOn(
    ctx,
    wav,
    flacEncodeArgs(wav.input, probe.bitsPerSample, out),
    undefined,
    'flac encode',
  );
  await chmod(out, 0o644);
  const fl = await openOwn(jobDirAbs, name);
  try {
    const info = parseFlacStreamInfo(await readAt(fl.opened.fd, 0, 64));
    if (
      info.sampleRate !== probe.sampleRate ||
      info.channels !== probe.channels ||
      info.bitsPerSample !== probe.bitsPerSample
    ) {
      throw new JobFailure('verify-mismatch', 'FLAC stream parameters differ');
    }
    const a = await pcmDigest(ctx, wav, probe.bitsPerSample);
    const b = await pcmDigest(ctx, fl, probe.bitsPerSample);
    const frameBytes = (probe.channels * probe.bitsPerSample) / 8;
    if (a.bytes === 0 || a.bytes % frameBytes !== 0) {
      throw new JobFailure('decode-failed', 'WAV decodes to no or torn audio');
    }
    if (a.bytes !== b.bytes || a.md5 !== b.md5)
      throw new JobFailure('verify-mismatch', 'decoded PCM differs');
    const frames = a.bytes / frameBytes;
    if (info.totalSamples !== 0 && info.totalSamples !== frames) {
      throw new JobFailure('verify-mismatch', 'STREAMINFO sample count differs');
    }
    return { frames };
  } finally {
    await fl.opened.close();
  }
}
