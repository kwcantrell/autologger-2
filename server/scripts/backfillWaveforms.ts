// CLI: compute missing waveform peaks server-side (supabase-11a-legacy-import follow-up B).
//
//   npx tsx server/scripts/backfillWaveforms.ts --print-query
//   npx tsx server/scripts/backfillWaveforms.ts --blob-dir <abs dir> --segments <csv> --out <sql>
//       [--ffmpeg <binary> | --ffmpeg-image <image ref>] [--jobs N]
//
// The browser computes a segment's peaks only when it can fetch and decode the whole file, which
// large imports (a 1.3 GB WAV, hundreds of MP3s) never manage. This script does the same
// computation offline, for the rows whose `waveform_peaks_json` is NULL:
//
// 1. The operator exports those rows with psql (`--print-query` prints the COPY; README
//    "Waveform peaks backfill" has the full commands). The CSV is session_id,id,r2_key.
// 2. Each blob (BLOB_DIR/<r2_key>) is decoded by ffmpeg to 32-bit float WAV on stdout, at 48 kHz,
//    every channel kept, streamed: memory does not grow with the file. By default ffmpeg runs in
//    the pinned image below (`docker run --rm --network none`, the blob dir mounted read-only);
//    `--ffmpeg` uses a local binary instead. Each file is decoded twice: once to count frames
//    (the bucket boundaries depend on the total), once to compute the peaks. `--jobs N` (1-64,
//    default 1) decodes N files at once; the SQL is the same for any N (rows keep input order).
// 3. Peaks come from @autologger/domain's `DbPeaksAccumulator`, the browser's `computeDbPeaks01`
//    bit for bit (pinned by web/src/shared/utils/waveformDecode.pinning.test.ts), with the bucket
//    count the browser uses for a segment decoded on its own, floor -48.
// 4. The output is one SQL transaction of UPDATEs, each guarded by `waveform_peaks_json is null`,
//    for the operator to apply with psql. Re-running, or applying after a browser stored peaks,
//    changes nothing that is already filled.
//
// Ids and keys are validated before any path is opened or any SQL is written; the per-segment
// report goes to stderr. Exit: 0 every segment filled, 1 any failed/missing/invalid (the SQL still
// holds the ones that worked), 2 usage.

import { spawn } from 'node:child_process';
import { endianness } from 'node:os';
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  DbPeaksAccumulator,
  segmentWaveformDecodeBucketCount,
  WF_DB_FLOOR,
  WF_SEGMENT_DECODE_MAX,
} from '@autologger/domain';
import {
  checkSegment,
  type Decoder,
  FFMPEG_IMAGE,
  lit,
  MAX_JOBS,
  parseJobs,
  parseSegmentsCsv,
  printable,
  runPool,
  type SegmentRow,
  validIds,
} from './blobSegmentRows';

// Re-exported: the tests and operators know these from this script (follow-up B).
export {
  checkSegment,
  type Decoder,
  FFMPEG_IMAGE,
  parseSegmentsCsv,
  type SegmentCheck,
  type SegmentRow,
} from './blobSegmentRows';

/** The browser decodes at its AudioContext rate; 48 kHz is the common one. */
export const DECODE_SAMPLE_RATE = 48_000;

export const EXPORT_QUERY =
  'copy (select session_id, id, r2_key from catalog.session_audio_segments where waveform_peaks_json is null order by session_id, ordinal) to stdout with (format csv, header true)';

// ---------------------------------------------------------------------------------------------
// Output

/** The browser's PUT body text: Float32 peaks as JS numbers; refuses anything the route would. */
export function peaksJson(peaks: Float32Array): string {
  if (peaks.length < 8 || peaks.length > WF_SEGMENT_DECODE_MAX) {
    throw new Error(`peaks length ${peaks.length} outside 8..${WF_SEGMENT_DECODE_MAX}`);
  }
  for (const x of peaks) {
    if (!(Number.isFinite(x) && x >= 0 && x <= 1)) throw new Error('peaks must be in [0, 1]');
  }
  const json = JSON.stringify(Array.from(peaks, Number));
  if (!/^\[[0-9.e+-]+(,[0-9.e+-]+)*\]$/.test(json)) throw new Error('peaks JSON is not numbers only');
  return json;
}

/** One psql-applied transaction; each UPDATE fills its row only while it is still NULL. */
export function buildUpdateSql(updates: Array<{ row: SegmentRow; peaks: Float32Array }>): string {
  const out = [
    `-- waveform peaks backfill (server/scripts/backfillWaveforms.ts): ${updates.length} update(s).`,
    '-- Fills only rows whose waveform_peaks_json is still NULL; safe to apply more than once.',
    '\\set ON_ERROR_STOP on',
    'begin;',
    'set local standard_conforming_strings = on;',
  ];
  for (const { row, peaks } of updates) {
    if (!validIds(row)) throw new Error(`invalid segment id or key: refusing to emit SQL`);
    out.push(
      `update catalog.session_audio_segments set waveform_peaks_json = ${lit(peaksJson(peaks))}, waveform_db_floor = ${WF_DB_FLOOR} where session_id = ${lit(row.session_id)} and id = ${lit(row.id)} and waveform_peaks_json is null;`,
    );
  }
  out.push('commit;', '');
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Decoding

export interface WavFormat {
  channels: number;
  sampleRate: number;
  frames: number;
}

const MAX_HEADER_BYTES = 1 << 20;

/**
 * Streams a 32-bit float WAV (ffmpeg's `-c:a pcm_f32le -f wav -` on a pipe, whose size fields are
 * placeholders): parses the header, then hands every run of whole interleaved frames to
 * `onSamples` (the array is only valid during the call). The data chunk runs to end of stream.
 */
export async function readWavPcm(
  stream: Readable,
  onSamples: (samples: Float32Array, channels: number) => void,
): Promise<WavFormat> {
  let head: Buffer = Buffer.alloc(0);
  let fmt: { channels: number; sampleRate: number } | null = null;
  let inData = false;
  let rest: Buffer = Buffer.alloc(0);
  let frames = 0;

  const feedData = (chunk: Buffer, channels: number): void => {
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
      feedData(chunk, fmt.channels);
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
        if (sub !== 3 || bits !== 32 || channels < 1) {
          throw new Error('WAV is not 32-bit float PCM');
        }
        fmt = { channels, sampleRate };
      }
      o += 8 + padded;
    }
    if (inData && fmt) {
      const tail = head.subarray(o);
      head = Buffer.alloc(0);
      if (tail.length) feedData(tail, fmt.channels);
    }
  }
  if (!inData || !fmt) throw new Error('not a WAV stream (no data chunk)');
  if (rest.length) throw new Error('decoded audio ends in a torn frame');
  return { ...fmt, frames };
}

function ffmpegArgs(input: string): string[] {
  return [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    `file:${input}`,
    '-map',
    '0:a:0',
    '-vn',
    '-ar',
    String(DECODE_SAMPLE_RATE),
    '-c:a',
    'pcm_f32le',
    '-map_metadata',
    '-1',
    '-fflags',
    '+bitexact',
    '-flags:a',
    '+bitexact',
    '-f',
    'wav',
    '-',
  ];
}

/** The decode command for one (already validated) key. */
export function decodeArgs(
  decoder: Decoder,
  blobDir: string,
  key: string,
): { cmd: string; args: string[] } {
  if (decoder.kind === 'binary') {
    return { cmd: decoder.path, args: ffmpegArgs(resolve(blobDir, key)) };
  }
  return {
    cmd: 'docker',
    args: [
      'run',
      '--rm',
      '--network',
      'none',
      '-v',
      `${resolve(blobDir)}:/blobs:ro`,
      decoder.image,
      ...ffmpegArgs(`/blobs/${key}`),
    ],
  };
}

async function decodeOnce(
  cmd: string,
  args: string[],
  onSamples: (samples: Float32Array, channels: number) => void,
): Promise<WavFormat> {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => {
    stderr = (stderr + d.toString('utf8')).slice(-2000);
  });
  const exited = new Promise<number | null>((res, rej) => {
    child.on('error', rej);
    child.on('close', (code) => res(code));
  });
  let fmt: WavFormat | null = null;
  let parseError: unknown = null;
  try {
    fmt = await readWavPcm(child.stdout, onSamples);
  } catch (e) {
    parseError = e;
    child.kill('SIGKILL');
  }
  const code = await exited;
  const why = stderr.trim().split('\n').at(-1) ?? '';
  if (code !== 0 && parseError === null) throw new Error(`ffmpeg exited ${code}: ${why}`);
  if (parseError !== null) {
    const msg = parseError instanceof Error ? parseError.message : String(parseError);
    throw new Error(why ? `${msg} (ffmpeg: ${why})` : msg);
  }
  return fmt as WavFormat;
}

/** Two streamed decodes: count frames, then accumulate peaks over exactly that many. */
export async function decodePeaks(
  decoder: Decoder,
  blobDir: string,
  key: string,
): Promise<{ peaks: Float32Array; frames: number; channels: number; sampleRate: number }> {
  const { cmd, args } = decodeArgs(decoder, blobDir, key);
  const first = await decodeOnce(cmd, args, () => {});
  if (first.frames === 0) throw new Error('no audio decoded');
  const durationSec = first.frames / first.sampleRate;
  // The rule the browser applies to a segment decoded on its own (timeline span = its duration).
  const buckets = segmentWaveformDecodeBucketCount(durationSec, durationSec);
  const acc = new DbPeaksAccumulator(first.frames, buckets, WF_DB_FLOOR);
  await decodeOnce(cmd, args, (s, ch) => acc.pushInterleaved(s, ch));
  return { peaks: acc.finish(), ...first };
}

// ---------------------------------------------------------------------------------------------
// CLI

const USAGE = `usage:
  backfillWaveforms.ts --print-query
  backfillWaveforms.ts --blob-dir <abs dir> --segments <csv> --out <file.sql>
                       [--ffmpeg <binary> | --ffmpeg-image <image>]   (default image: ${FFMPEG_IMAGE})
                       [--jobs N]   (files decoded at once, 1-${MAX_JOBS}, default 1)`;

export async function main(argv: string[]): Promise<number> {
  const opt: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--print-query') {
      console.log(EXPORT_QUERY);
      return 0;
    }
    if (a === '--help' || a === '-h') {
      console.log(USAGE);
      return 0;
    }
    if (!['--blob-dir', '--segments', '--out', '--ffmpeg', '--ffmpeg-image', '--jobs'].includes(a) || i + 1 >= argv.length) {
      console.error(`unknown or incomplete argument ${printable(a)}\n${USAGE}`);
      return 2;
    }
    opt[a.slice(2)] = argv[++i];
  }
  const blobDir = opt['blob-dir'];
  if (!blobDir || !opt.segments || !opt.out) {
    console.error(USAGE);
    return 2;
  }
  if (!isAbsolute(blobDir) || !existsSync(blobDir) || !statSync(blobDir).isDirectory()) {
    console.error('error: --blob-dir must be an existing absolute directory');
    return 2;
  }
  if (opt.ffmpeg && opt['ffmpeg-image']) {
    console.error('error: give --ffmpeg or --ffmpeg-image, not both');
    return 2;
  }
  if (!opt.ffmpeg && /[:,]/.test(resolve(blobDir))) {
    console.error('error: --blob-dir cannot contain ":" or "," for a docker bind mount');
    return 2;
  }
  const jobs = parseJobs(opt.jobs);
  if (jobs === 0) {
    console.error(`error: --jobs must be an integer from 1 to ${MAX_JOBS}`);
    return 2;
  }
  if (endianness() !== 'LE') {
    console.error('error: little-endian host required (float WAV samples are read in place)');
    return 2;
  }
  const decoder: Decoder = opt.ffmpeg
    ? { kind: 'binary', path: opt.ffmpeg }
    : { kind: 'docker', image: opt['ffmpeg-image'] ?? FFMPEG_IMAGE };

  let rows: SegmentRow[];
  try {
    rows = parseSegmentsCsv(readFileSync(opt.segments, 'utf8'));
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : e}`);
    return 2;
  }

  const counts = { ok: 0, failed: 0, missing: 0, invalid: 0 };
  // Indexed by input row, so the SQL keeps input order whatever finishes first.
  const results: Array<{ row: SegmentRow; peaks: Float32Array } | undefined> = new Array(rows.length);
  const report = (status: keyof typeof counts, row: SegmentRow, detail: string): void => {
    counts[status] += 1;
    console.error(`${status.padEnd(8)} ${printable(row.session_id)}/${printable(row.id)}  ${printable(detail)}`);
  };
  const one = async (idx: number): Promise<void> => {
    const row = rows[idx];
    const check = checkSegment(row, blobDir);
    if (check.kind !== 'ok') {
      report(check.kind, row, check.reason);
      return;
    }
    try {
      const r = await decodePeaks(decoder, blobDir, row.r2_key);
      peaksJson(r.peaks); // validate now, so a bad result is reported per segment
      results[idx] = { row, peaks: r.peaks };
      report(
        'ok',
        row,
        `${(r.frames / r.sampleRate).toFixed(1)}s ${r.channels}ch -> ${r.peaks.length} peaks`,
      );
    } catch (e) {
      report('failed', row, e instanceof Error ? e.message : String(e));
    }
  };
  await runPool(rows.length, jobs, one);
  const updates = results.filter((u): u is { row: SegmentRow; peaks: Float32Array } => u !== undefined);

  const tmp = `${opt.out}.tmp-${process.pid}`;
  writeFileSync(tmp, buildUpdateSql(updates));
  renameSync(tmp, opt.out);
  console.error(
    `${counts.ok} ok, ${counts.failed} failed, ${counts.missing} missing, ${counts.invalid} invalid; wrote ${updates.length} update(s) to ${opt.out}`,
  );
  return counts.ok === rows.length ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}
