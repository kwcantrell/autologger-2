// ffmpeg, run safely (media-worker design D4): argv only (no shell), every input opened by the
// worker itself and streamed on stdin with a forced demuxer and `-protocol_whitelist pipe`, so
// ffmpeg can open no second file; `-xerror` so a decode error fails instead of decoding to
// silence; a wall-clock limit with SIGKILL; stderr kept only as a short tail for classification
// into the D2 error codes and never stored or logged.
//
// The one exception is an MP4 whose `moov` follows `mdat` (not demuxable from a pipe): it is read
// as `file:<path>` with `-f mov`, the file whitelist and external data references disabled
// (`-enable_drefs 0 -use_absolute_path 0`). The path is the one this module opened and checked;
// `audio/` and `.trash/` are owned by the API's uid, so the worker cannot swap it (documented
// residual in docs/security.md).

import { spawn } from 'node:child_process';
import { constants, createReadStream } from 'node:fs';
import { type FileHandle, open, readlink, realpath } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import type { MediaErrorCode } from '@autologger/ports/media';
import type { Demuxer } from './sniff';

export type DecodeInput =
  | { demuxer: Demuxer; mode: 'pipe' }
  | { demuxer: 'mov'; mode: 'file'; path: string };

const BASE = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-xerror'];

/** The input half of an ffmpeg argv: base flags, demuxer options, the whitelist and `-i`. */
export interface InputOpts {
  /** mov only: decode with edit lists ignored (AAC priming kept on both sides of a check). */
  ignoreEditlist?: boolean;
  /** Keep every decoded sample: no start skip (Opus pre-skip) and no end trim (WebM
   * DiscardPadding, Ogg end granule); the merge verification's unit (packet copy keeps every
   * packet, so these totals must be equal). */
  untrimmed?: boolean;
}

export function inputArgs(input: DecodeInput, opts: InputOpts = {}): string[] {
  const mov = input.demuxer === 'mov';
  if (opts.ignoreEditlist && !mov)
    throw new Error('-ignore_editlist applies to the mov demuxer only');
  if (input.mode === 'file' && !mov) throw new Error('only a moov-last MP4 is read by path');
  const movOpts = [
    ...(mov ? ['-enable_drefs', '0', '-use_absolute_path', '0'] : []),
    ...(opts.ignoreEditlist ? ['-ignore_editlist', '1'] : []),
    ...(opts.untrimmed ? ['-flags2', '+skip_manual'] : []),
  ];
  if (input.mode === 'file') {
    if (!isAbsolute(input.path) || /[\0\n]/.test(input.path)) throw new Error('bad input path');
    return [
      ...BASE,
      ...movOpts,
      '-protocol_whitelist',
      'file',
      '-f',
      'mov',
      '-i',
      `file:${input.path}`,
    ];
  }
  return [...BASE, ...movOpts, '-protocol_whitelist', 'pipe', '-f', input.demuxer, '-i', 'pipe:0'];
}

export interface PcmOut {
  pcm: 'f32le' | 's16le' | 's24le';
  /** `wav` (a header carrying rate and channels) or raw samples. */
  container: 'wav' | 'raw';
  /** Resample to this rate (the peaks decode uses 48 kHz like the browser); native when absent. */
  rate?: number;
}

/** Decode the first audio stream to PCM on stdout. */
export function decodeArgs(input: DecodeInput, out: PcmOut, opts: InputOpts = {}): string[] {
  return [
    ...inputArgs(input, opts),
    '-map',
    '0:a:0',
    '-vn',
    ...(out.rate ? ['-ar', String(out.rate)] : []),
    '-c:a',
    `pcm_${out.pcm}`,
    '-map_metadata',
    '-1',
    '-fflags',
    '+bitexact',
    '-flags:a',
    '+bitexact',
    '-f',
    out.container === 'wav' ? 'wav' : out.pcm,
    'pipe:1',
  ];
}

/** Encode integer PCM to FLAC level 8 (#107's arguments) into `outPath`, never overwriting. */
export function flacEncodeArgs(input: DecodeInput, bits: 16 | 24, outPath: string): string[] {
  if (!isAbsolute(outPath) || /[\0\n]/.test(outPath)) throw new Error('bad output path');
  return [
    ...inputArgs(input),
    '-map',
    '0:a:0',
    '-vn',
    '-map_metadata',
    '-1',
    '-c:a',
    'flac',
    '-compression_level',
    '8',
    '-sample_fmt',
    bits === 16 ? 's16' : 's32',
    ...(bits === 24 ? ['-bits_per_raw_sample', '24'] : []),
    '-fflags',
    '+bitexact',
    '-flags:a',
    '+bitexact',
    '-n',
    '-f',
    'flac',
    `file:${outPath}`,
  ];
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  /** Spawn failure (ENOENT…), when ffmpeg never ran. */
  spawnError: string | null;
  /** The last bytes of stderr, for `classifyFailure` only: never stored or logged. */
  stderrTail: string;
  /** What `consumeStdout` threw, if anything. */
  consumerError: unknown;
  /** Error-level stderr lines other than the benign end-of-file note: ffmpeg drops a corrupt
   * packet and still exits 0 even with -xerror (spike 0.2), so any of these fails the run. */
  errorLines: number;
}

export interface RunOpts {
  ffmpegPath: string;
  args: string[];
  /** Streamed into stdin (an fd the worker opened); stdin is otherwise closed. */
  stdinFd?: FileHandle;
  onStdout?: (chunk: Buffer) => void;
  /** Reads stdout as a stream (with backpressure); a throw kills ffmpeg and is reported. */
  consumeStdout?: (stdout: Readable) => Promise<void>;
  timeoutMs: number;
  signal?: AbortSignal;
}

const STDERR_TAIL = 4096;
/** The only error-level lines a good decode may print: a live WebM cut at a slice boundary ends
 * "prematurely" (spike 0.2), and ffmpeg's repeat counter belongs to the line before it. */
const BENIGN_STDERR = [/File ended prematurely/, /^\s*Last message repeated \d+ times?\s*$/];

/** Runs ffmpeg once; resolves (never rejects) when the process has exited. */
export function runFfmpeg(o: RunOpts): Promise<RunResult> {
  return new Promise((resolveRun) => {
    let stderrTail = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let consumerError: unknown = null;
    let errorLines = 0;
    let partial = '';
    const child = spawn(o.ffmpegPath, o.args, {
      shell: false,
      stdio: [
        o.stdinFd ? 'pipe' : 'ignore',
        o.onStdout || o.consumeStdout ? 'pipe' : 'ignore',
        'pipe',
      ],
      env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' },
    });
    const kill = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, o.timeoutMs);
    const onAbort = () => {
      aborted = true;
      kill();
    };
    if (o.signal?.aborted) onAbort();
    else o.signal?.addEventListener('abort', onAbort, { once: true });
    let consumed: Promise<void> = Promise.resolve();
    const done = (
      r: Omit<RunResult, 'timedOut' | 'aborted' | 'stderrTail' | 'consumerError' | 'errorLines'>,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      if (partial && !BENIGN_STDERR.some((re) => re.test(partial))) errorLines += 1;
      void consumed.then(() =>
        resolveRun({ ...r, timedOut, aborted, stderrTail, consumerError, errorLines }),
      );
    };
    child.stderr?.on('data', (d: Buffer) => {
      const text = d.toString('utf8');
      stderrTail = (stderrTail + text).slice(-STDERR_TAIL);
      const lines = (partial + text).split('\n');
      partial = (lines.pop() ?? '').slice(-STDERR_TAIL);
      for (const line of lines) {
        if (line.trim() && !BENIGN_STDERR.some((re) => re.test(line))) errorLines += 1;
      }
    });
    if (o.onStdout) child.stdout?.on('data', (c: Buffer) => o.onStdout?.(c));
    if (o.consumeStdout && child.stdout) {
      const out = child.stdout;
      consumed = o.consumeStdout(out).catch((err) => {
        consumerError = err ?? new Error('stdout consumer failed');
        kill();
        out.resume();
      });
    }
    if (o.stdinFd && child.stdin) {
      const src = createReadStream('', {
        fd: o.stdinFd,
        start: 0,
        autoClose: false,
        highWaterMark: 1 << 20,
      });
      // ffmpeg may stop reading early (an error, or it has what it needs): EPIPE is not ours.
      child.stdin.on('error', () => {});
      src.on('error', () => kill());
      src.pipe(child.stdin);
      child.on('close', () => src.unpipe());
    }
    child.on('error', (err) =>
      done({
        code: null,
        signal: null,
        spawnError: (err as NodeJS.ErrnoException).code ?? 'spawn',
      }),
    );
    child.on('close', (code, signal) => done({ code, signal, spawnError: null }));
  });
}

export function ok(r: RunResult): boolean {
  return (
    r.code === 0 &&
    !r.timedOut &&
    !r.aborted &&
    r.spawnError === null &&
    r.consumerError === null &&
    r.errorLines === 0
  );
}

/** The D2 code for a failed run. Tool output is consulted only here and never leaves. */
export function classifyFailure(r: RunResult): MediaErrorCode {
  if (r.timedOut) return 'timeout';
  if (r.spawnError !== null) return 'internal';
  if (/No space left on device/i.test(r.stderrTail)) return 'low-disk';
  if (/Cannot allocate memory/i.test(r.stderrTail)) return 'decode-failed';
  if (r.signal === 'SIGKILL') return 'decode-failed'; // the memory limit's OOM kill
  return 'decode-failed';
}

/** A refused input (D4), with its classified code; the message never names a path. */
export class InputRefused extends Error {
  override name = 'InputRefused';
  constructor(
    readonly code: MediaErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface OpenedInput {
  fd: FileHandle;
  size: number;
  /** The checked absolute path (for the moov-last `file:` exception and mediabunny). */
  path: string;
  /** `/proc/self/fd/<n>`: the opened inode, for in-process readers (mediabunny). */
  fdPath: string;
  close(): Promise<void>;
}

const KEY_PART = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,254}$/;

/** Opens `BLOB_DIR/<key>` for reading: only under `audio/` or `.trash/`, plain path components,
 * `O_NOFOLLOW` (a symlinked last component fails `ELOOP`), `O_NONBLOCK` (a FIFO never blocks the
 * open), then the handle's `fstat` must be a regular file and its resolved path must still lie
 * under one of the two roots (an intermediate symlink is caught here). */
export async function openInput(blobDir: string, key: string): Promise<OpenedInput> {
  const parts = key.split('/');
  if (
    isAbsolute(key) ||
    parts.length < 2 ||
    !(parts[0] === 'audio' || parts[0] === '.trash') ||
    !parts.slice(1).every((p) => KEY_PART.test(p))
  ) {
    throw new InputRefused('decode-failed', 'input key outside audio/ and .trash/');
  }
  const root = await realpath(blobDir);
  const path = resolve(root, key);
  let fd: FileHandle;
  try {
    fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM') {
      throw new InputRefused('missing-blob', `input not readable (${code})`);
    }
    throw new InputRefused('decode-failed', `input refused (${code ?? 'open'})`);
  }
  try {
    const st = await fd.stat();
    if (!st.isFile()) throw new InputRefused('decode-failed', 'input is not a regular file');
    const fdPath = `/proc/self/fd/${fd.fd}`;
    const real = await readlink(fdPath).catch(() => path);
    const roots = [`${root}${sep}audio${sep}`, `${root}${sep}.trash${sep}`];
    if (!roots.some((r) => real.startsWith(r))) {
      throw new InputRefused('decode-failed', 'input resolves outside audio/ and .trash/');
    }
    return { fd, size: st.size, path, fdPath, close: () => fd.close() };
  } catch (err) {
    await fd.close();
    throw err;
  }
}

/** Reads up to `len` bytes at `pos` from an opened input. */
export async function readAt(fd: FileHandle, pos: number, len: number): Promise<Buffer> {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fd.read(buf, 0, len, pos);
  return buf.subarray(0, bytesRead);
}
