// One input, prepared and decoded (media-worker design D4, D5): open by the checked opener, sniff
// the container, scan an MP4's atoms, then run ffmpeg on it with the forced demuxer. Every failure
// is a `JobFailure` with a D2 code.

import { createHash } from 'node:crypto';
import { ALL_FORMATS, FilePathSource, Input } from 'mediabunny';
import {
  classifyFailure,
  type DecodeInput,
  decodeArgs,
  InputRefused,
  type OpenedInput,
  ok,
  openInput,
  readAt,
  runFfmpeg,
} from './ffmpeg';
import { type JobCtx, JobFailure } from './jobs/types';
import { PEAKS_SAMPLE_RATE, readFloatWav, type WavFormat } from './peaks';
import { type Demuxer, mp4MoovOrder, opusPreSkip, SNIFF_BYTES, sniffContainer } from './sniff';

export interface Prepared {
  opened: OpenedInput;
  demuxer: Demuxer;
  input: DecodeInput;
  head: Buffer;
  key: string;
}

/** Opens and classifies `key`; the caller must `opened.close()`. */
export async function prepareInput(ctx: JobCtx, key: string): Promise<Prepared> {
  let opened: OpenedInput;
  try {
    opened = await openInput(ctx.blobDir, key);
  } catch (err) {
    if (err instanceof InputRefused)
      throw new JobFailure(err.code, err.message, err.code !== 'missing-blob');
    throw err;
  }
  return classifyOpened(opened, key);
}

/** Sniffs an opened input (closing it on refusal). */
export async function classifyOpened(opened: OpenedInput, key: string): Promise<Prepared> {
  try {
    const head = await readAt(opened.fd, 0, SNIFF_BYTES);
    const demuxer = sniffContainer(head);
    if (!demuxer) throw new JobFailure('decode-failed', 'container not in the allowlist', true);
    let input: DecodeInput = { demuxer, mode: 'pipe' };
    if (demuxer === 'mov') {
      const order = await mp4MoovOrder((pos, len) => readAt(opened.fd, pos, len), opened.size);
      if (order === 'no-moov')
        throw new JobFailure('decode-failed', 'MP4 without a moov box', true);
      if (order === 'moov-last') input = { demuxer: 'mov', mode: 'file', path: opened.path };
    }
    return { opened, demuxer, input, head, key };
  } catch (err) {
    await opened.close();
    throw err;
  }
}

function failed(ctx: JobCtx, r: Awaited<ReturnType<typeof runFfmpeg>>, what: string): JobFailure {
  if (r.aborted || ctx.signal?.aborted) return new JobFailure('internal', `${what}: aborted`);
  if (r.consumerError !== null && r.code === 0) {
    return new JobFailure('decode-failed', `${what}: unreadable decoder output`);
  }
  return new JobFailure(classifyFailure(r), `${what}: ffmpeg failed`);
}

/** Runs one ffmpeg command over a prepared input (stdin-fed unless the moov-last exception). */
export async function runOn(
  ctx: JobCtx,
  p: Prepared,
  args: string[],
  consumeStdout?: Parameters<typeof runFfmpeg>[0]['consumeStdout'],
  what = 'decode',
): Promise<void> {
  const r = await runFfmpeg({
    ffmpegPath: ctx.ffmpegPath,
    args,
    stdinFd: p.input.mode === 'pipe' ? p.opened.fd : undefined,
    consumeStdout,
    timeoutMs: ctx.timeoutMs,
    signal: ctx.signal,
  });
  if (!ok(r)) throw failed(ctx, r, what);
}

/** One full float decode to a WAV stream; `rate` resamples (48 kHz for peaks), else native. */
export async function floatDecode(
  ctx: JobCtx,
  p: Prepared,
  onSamples: (s: Float32Array, channels: number) => void,
  opts: { rate?: number; ignoreEditlist?: boolean; untrimmed?: boolean } = {},
): Promise<WavFormat> {
  let fmt: WavFormat | null = null;
  await runOn(
    ctx,
    p,
    decodeArgs(
      p.input,
      { pcm: 'f32le', container: 'wav', rate: opts.rate },
      { ignoreEditlist: opts.ignoreEditlist, untrimmed: opts.untrimmed },
    ),
    async (stdout) => {
      fmt = await readFloatWav(stdout, onSamples);
    },
  );
  if (!fmt) throw new JobFailure('decode-failed', 'no decoder output');
  return fmt;
}

/** The decoded frame count at the native rate; `untrimmed` keeps start skip and end trim (the
 * merge verification's unit), `ignoreEditlist` applies to mov. */
export async function nativeFrames(
  ctx: JobCtx,
  p: Prepared,
  opts: { ignoreEditlist?: boolean; untrimmed?: boolean } = {},
): Promise<WavFormat> {
  return floatDecode(ctx, p, () => {}, opts);
}

/** The 48 kHz decode the peaks use. */
export function peaksDecode(ctx: JobCtx, p: Prepared) {
  return (on: (s: Float32Array, channels: number) => void) =>
    floatDecode(ctx, p, on, { rate: PEAKS_SAMPLE_RATE });
}

/** MD5 and length of the decoded first audio stream as raw integer PCM (#107's `pcmDigest`). */
export async function pcmDigest(
  ctx: JobCtx,
  p: Prepared,
  bits: 16 | 24,
): Promise<{ md5: string; bytes: number }> {
  const hash = createHash('md5');
  let bytes = 0;
  await runOn(
    ctx,
    p,
    decodeArgs(p.input, { pcm: bits === 16 ? 's16le' : 's24le', container: 'raw' }),
    async (out) => {
      for await (const c of out) {
        hash.update(c as Buffer);
        bytes += (c as Buffer).length;
      }
    },
  );
  return { md5: hash.digest('hex'), bytes };
}

export interface StreamInfo {
  codec: string;
  sampleRate: number;
  channels: number;
}

/** Codec, rate and channels by mediabunny over the opened inode (no path is re-resolved);
 * null when it cannot parse the file (ffmpeg's decode still decides success). */
export async function probeStream(p: Prepared): Promise<StreamInfo | null> {
  const input = new Input({ source: new FilePathSource(p.opened.fdPath), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track?.codec) return null;
    return { codec: track.codec, sampleRate: track.sampleRate, channels: track.numberOfChannels };
  } catch {
    return null;
  } finally {
    input.dispose();
  }
}

/** The Opus pre-skip from the prepared head, or 0 when the input is not Opus. */
export function preSkipOf(p: Prepared): number {
  return opusPreSkip(p.head) ?? 0;
}
