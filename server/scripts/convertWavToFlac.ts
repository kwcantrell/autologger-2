// CLI: store PCM WAV blobs losslessly as FLAC (supabase-11a-legacy-import follow-up C).
//
//   npx tsx server/scripts/convertWavToFlac.ts --print-query
//   npx tsx server/scripts/convertWavToFlac.ts --blob-dir <abs dir> --segments <csv> --out <sql>
//       [--ffmpeg <binary> | --ffmpeg-image <image ref>] [--jobs N] [--limit N] [--min-free-gb N]
//   npx tsx server/scripts/convertWavToFlac.ts --print-referenced-query
//   npx tsx server/scripts/convertWavToFlac.ts --cleanup --blob-dir <abs dir> --referenced <csv>
//       [--delete] [--ffmpeg <binary> | --ffmpeg-image <image ref>]
//
// Legacy imports brought 16- and 24-bit PCM WAVs of a GB and more; FLAC holds the same samples in
// about a third of the space. The app plays, waveforms and transcribes FLAC like any segment.
//
// Convert (the WAV is never modified or removed here):
// 1. The operator exports the WAV rows with psql (`--print-query`: key ends `.wav` or mime says
//    wav). The CSV is session_id,id,r2_key. Ids and keys are validated as in backfillWaveforms.ts
//    (`audio/<session_id>/<file>`, inside the blob dir, here also with no symlink on the way).
// 2. The WAV header is probed (16/24-bit integer PCM only; float or other formats are `skipped`).
// 3. ffmpeg (pinned image, `--network none`, the blob dir read-only, a temp dir inside the blob
//    dir writable, run as the invoking uid) encodes FLAC at -compression_level 8 with the WAV's
//    rate, channels and bit depth into BLOB_DIR/.flac-tmp.
// 4. Verified before it is accepted: both files are decoded to raw PCM in the WAV's sample format
//    and their MD5 and length must match, and the FLAC's STREAMINFO must carry the WAV's rate,
//    channels, bit depth and sample count. On a mismatch the temp FLAC is deleted (`failed`).
// 5. Accepted: mode (and, as root, owner) copied from the WAV, fsync, hard-linked into place as
//    `audio/<sid>/<same stem>.flac` (never over an existing file), temp name removed. A target
//    that already exists is verified the same way and reused (`reused`) or reported `failed`
//    and left alone.
// 6. Output: one SQL transaction of UPDATEs setting r2_key and mime_type = 'audio/flac', each
//    guarded by `and r2_key = <the WAV key>`, for the operator to apply with psql.
//
// Cleanup (`--cleanup`, after the SQL is applied and playback checked): input is a fresh export of
// every referenced key (`--print-referenced-query`). A WAV under BLOB_DIR/audio/<sid>/ is listed
// only when its `.flac` sibling exists, is a regular file and is referenced, and the WAV itself
// is not referenced. Dry run by default; `--delete` verifies the pair (same PCM) and unlinks the
// WAV. Nothing else is ever deleted.
//
// Report on stderr, one line per segment. Exit: 0 all converted/reused (cleanup: no failure),
// 1 anything else (the SQL still holds the ones that worked), 2 usage.

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  chownSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  type Stats,
  statfsSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkSegment,
  type Decoder,
  FFMPEG_IMAGE,
  lit,
  MAX_JOBS,
  NAME_RE,
  parseJobs,
  parseSegmentsCsv,
  printable,
  runPool,
  type SegmentRow,
  validIds,
} from './blobSegmentRows';

export const EXPORT_QUERY =
  "copy (select session_id, id, r2_key from catalog.session_audio_segments where lower(r2_key) like '%.wav' or lower(mime_type) like '%wav%' order by session_id, ordinal) to stdout with (format csv, header true)";

export const REFERENCED_QUERY =
  'copy (select session_id, id, r2_key from catalog.session_audio_segments order by session_id, ordinal) to stdout with (format csv, header true)';

export const FLAC_MIME = 'audio/flac';
const TMP_DIR_NAME = '.flac-tmp';
const PROBE_BYTES = 1 << 20;

// ---------------------------------------------------------------------------------------------
// Keys and headers

/** `audio/<sid>/<stem>.<ext>` -> `audio/<sid>/<stem>.flac` (appends when there is no ext). */
export function flacKeyFor(key: string): string {
  const slash = key.lastIndexOf('/');
  const name = key.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  return `${key.slice(0, slash + 1)}${dot > 0 ? name.slice(0, dot) : name}.flac`;
}

export type WavProbe =
  | { ok: true; channels: number; sampleRate: number; bitsPerSample: 16 | 24 }
  | { ok: false; reason: string };

/** Reads the RIFF/WAVE `fmt ` chunk: 16/24-bit integer PCM (plain or extensible) is convertible. */
export function probeWavHeader(head: Buffer): WavProbe {
  if (head.length < 12 || head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WAVE') {
    return { ok: false, reason: 'not a RIFF/WAVE file' };
  }
  let o = 12;
  while (head.length >= o + 8) {
    const id = head.toString('latin1', o, o + 4);
    const size = head.readUInt32LE(o + 4);
    if (id === 'fmt ') {
      if (size < 16 || head.length < o + 8 + size) return { ok: false, reason: 'truncated fmt chunk' };
      const tag = head.readUInt16LE(o + 8);
      const channels = head.readUInt16LE(o + 10);
      const sampleRate = head.readUInt32LE(o + 12);
      const bits = head.readUInt16LE(o + 22);
      const sub = tag === 0xfffe && size >= 40 ? head.readUInt16LE(o + 8 + 24) : tag;
      if (sub === 3) {
        return {
          ok: false,
          reason: `${bits}-bit float PCM: FLAC is integer-only, kept as WAV (converting would round the samples)`,
        };
      }
      if (sub !== 1) return { ok: false, reason: `not integer PCM (format tag 0x${sub.toString(16)})` };
      if (bits !== 16 && bits !== 24) {
        return { ok: false, reason: `${bits}-bit PCM (only 16- and 24-bit are converted)` };
      }
      if (channels < 1 || channels > 8) return { ok: false, reason: `${channels} channels (FLAC: 1-8)` };
      if (sampleRate < 1 || sampleRate > 655_350) return { ok: false, reason: `sample rate ${sampleRate}` };
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

function readHead(path: string, bytes = PROBE_BYTES): Buffer {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------------------------
// SQL

/** One psql-applied transaction; each UPDATE moves a row to its FLAC only while it still has
 * the WAV key, so re-applying, or applying after the row changed, does nothing. */
export function buildConvertSql(updates: Array<{ row: SegmentRow; flacKey: string }>): string {
  const out = [
    `-- WAV -> FLAC (server/scripts/convertWavToFlac.ts): ${updates.length} update(s).`,
    '-- Each row switches to its verified FLAC only while r2_key is still the WAV; safe to re-apply.',
    '\\set ON_ERROR_STOP on',
    'begin;',
    'set local standard_conforming_strings = on;',
  ];
  for (const { row, flacKey } of updates) {
    const target = { ...row, r2_key: flacKey };
    if (!validIds(row) || !validIds(target) || flacKey !== flacKeyFor(row.r2_key) || flacKey === row.r2_key) {
      throw new Error('invalid segment id or key: refusing to emit SQL');
    }
    out.push(
      `update catalog.session_audio_segments set r2_key = ${lit(flacKey)}, mime_type = ${lit(FLAC_MIME)} where session_id = ${lit(row.session_id)} and id = ${lit(row.id)} and r2_key = ${lit(row.r2_key)};`,
    );
  }
  out.push('commit;', '');
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------
// ffmpeg

export interface FfmpegDirs {
  blobDir: string;
  /** Writable temp dir (mounted at /out in docker); omitted when nothing is written. */
  outDir?: string;
  /** `uid:gid` the container runs as. */
  user: string;
}

/** The command for `args`, whose `{blob}` / `{out}` stand for the blob dir and the temp dir. */
export function ffmpegCommand(
  decoder: Decoder,
  dirs: FfmpegDirs,
  args: string[],
): { cmd: string; args: string[] } {
  const sub = (blob: string, out: string) =>
    args.map((a) => a.replaceAll('{blob}', blob).replaceAll('{out}', out));
  if (decoder.kind === 'binary') {
    return { cmd: decoder.path, args: sub(resolve(dirs.blobDir), dirs.outDir ?? '') };
  }
  return {
    cmd: 'docker',
    args: [
      'run',
      '--rm',
      '--network',
      'none',
      '--user',
      dirs.user,
      '-v',
      `${resolve(dirs.blobDir)}:/blobs:ro`,
      ...(dirs.outDir ? ['-v', `${dirs.outDir}:/out`] : []),
      decoder.image,
      ...sub('/blobs', '/out'),
    ],
  };
}

function runFfmpeg(
  cmd: { cmd: string; args: string[] },
  onData?: (chunk: Buffer) => void,
): Promise<void> {
  return new Promise((res, rej) => {
    const child = spawn(cmd.cmd, cmd.args, { stdio: ['ignore', onData ? 'pipe' : 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString('utf8')).slice(-2000);
    });
    if (onData) child.stdout?.on('data', onData);
    child.on('error', rej);
    child.on('close', (code) => {
      if (code === 0) res();
      else rej(new Error(`ffmpeg exited ${code}: ${stderr.trim().split('\n').at(-1) ?? ''}`));
    });
  });
}

const BASE = ['-nostdin', '-hide_banner', '-loglevel', 'error'];

/** MD5 and length of the decoded first audio stream, as raw PCM in the WAV's sample format. */
async function pcmDigest(
  decoder: Decoder,
  dirs: FfmpegDirs,
  input: string,
  bits: 16 | 24,
): Promise<{ md5: string; bytes: number }> {
  const fmt = bits === 16 ? 's16le' : 's24le';
  const hash = createHash('md5');
  let bytes = 0;
  await runFfmpeg(
    ffmpegCommand(decoder, dirs, [...BASE, '-i', `file:${input}`, '-map', '0:a:0', '-vn', '-c:a', `pcm_${fmt}`, '-f', fmt, '-']),
    (c) => {
      hash.update(c);
      bytes += c.length;
    },
  );
  return { md5: hash.digest('hex'), bytes };
}

interface Verified {
  frames: number;
  md5: string;
}

/** Same PCM (MD5 + length), same rate/channels/bit depth, STREAMINFO sample count = frames. */
async function verifyPair(
  decoder: Decoder,
  dirs: FfmpegDirs,
  wav: { input: string; probe: Extract<WavProbe, { ok: true }> },
  flac: { input: string; path: string },
): Promise<Verified> {
  const info = parseFlacStreamInfo(readHead(flac.path, 64));
  const p = wav.probe;
  if (info.sampleRate !== p.sampleRate || info.channels !== p.channels || info.bitsPerSample !== p.bitsPerSample) {
    throw new Error(
      `stream parameters differ (FLAC ${info.sampleRate} Hz ${info.channels}ch ${info.bitsPerSample}-bit)`,
    );
  }
  const [a, b] = await Promise.all([
    pcmDigest(decoder, dirs, wav.input, p.bitsPerSample),
    pcmDigest(decoder, dirs, flac.input, p.bitsPerSample),
  ]);
  const frameBytes = (p.channels * p.bitsPerSample) / 8;
  if (a.bytes === 0 || a.bytes % frameBytes !== 0) throw new Error('the WAV decodes to no or torn audio');
  if (a.bytes !== b.bytes || a.md5 !== b.md5) {
    throw new Error(`decoded PCM differs (WAV ${a.bytes} B md5 ${a.md5}, FLAC ${b.bytes} B md5 ${b.md5})`);
  }
  const frames = a.bytes / frameBytes;
  if (info.totalSamples !== 0 && info.totalSamples !== frames) {
    throw new Error(`STREAMINFO says ${info.totalSamples} samples, the WAV has ${frames}`);
  }
  return { frames, md5: a.md5 };
}

function encodeArgs(wavInput: string, out: string, bits: 16 | 24): string[] {
  return [
    ...BASE,
    '-i',
    `file:${wavInput}`,
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
    '-f',
    'flac',
    `file:${out}`,
  ];
}

// ---------------------------------------------------------------------------------------------
// Convert

type Status = 'ok' | 'reused' | 'failed' | 'missing' | 'invalid' | 'skipped';

interface ConvertCtx {
  decoder: Decoder;
  blobDir: string;
  tmpDir: string;
  user: string;
  minFreeBytes: number;
  reserved: { bytes: number };
}

const fmtBytes = (n: number): string =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${n} B`;

/** Copies the WAV's mode (and, as root, owner) so the app's user keeps the same access. */
function copyOwnership(path: string, from: Stats): string {
  chmodSync(path, from.mode & 0o7777);
  if (process.getuid?.() === 0) {
    chownSync(path, from.uid, from.gid);
    return '';
  }
  const own = statSync(path);
  return own.uid === from.uid && own.gid === from.gid
    ? ''
    : ` (owner ${own.uid}:${own.gid}, the WAV's is ${from.uid}:${from.gid}; run as root to copy it)`;
}

function fsyncPath(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

async function convertOne(
  ctx: ConvertCtx,
  row: SegmentRow,
): Promise<{ status: Status; detail: string; flacKey?: string; wavBytes?: number; flacBytes?: number }> {
  const check = checkSegment(row, ctx.blobDir);
  if (check.kind !== 'ok') return { status: check.kind, detail: check.reason };
  const root = realpathSync(ctx.blobDir);
  if (realpathSync(check.path) !== join(root, row.r2_key)) {
    return { status: 'invalid', detail: 'the WAV path goes through a symlink' };
  }
  const probe = probeWavHeader(readHead(check.path));
  if (!probe.ok) return { status: 'skipped', detail: probe.reason };
  const flacKey = flacKeyFor(row.r2_key);
  if (!validIds({ ...row, r2_key: flacKey })) return { status: 'invalid', detail: `bad FLAC key ${flacKey}` };
  const flacPath = join(root, flacKey);
  const wavStat = statSync(check.path);
  const dirs: FfmpegDirs = { blobDir: root, outDir: ctx.tmpDir, user: ctx.user };
  const fmt = `${probe.sampleRate} Hz ${probe.channels}ch ${probe.bitsPerSample}-bit`;
  const done = (status: Status, v: Verified, extra = '') => {
    const flacBytes = statSync(flacPath).size;
    const pct = Math.round((100 * flacBytes) / wavStat.size);
    return {
      status,
      flacKey,
      wavBytes: wavStat.size,
      flacBytes,
      detail: `${fmtBytes(wavStat.size)} -> ${fmtBytes(flacBytes)} (${pct}%) ${fmt}, ${(v.frames / probe.sampleRate).toFixed(1)}s, pcm md5 ${v.md5}${extra}`,
    };
  };

  let existing: Stats | null = null;
  try {
    existing = lstatSync(flacPath);
  } catch {
    existing = null;
  }
  if (existing) {
    if (!existing.isFile()) return { status: 'failed', detail: `existing ${flacKey} is not a regular file` };
    try {
      const v = await verifyPair(ctx.decoder, dirs, { input: `{blob}/${row.r2_key}`, probe }, { input: `{blob}/${flacKey}`, path: flacPath });
      return done('reused', v);
    } catch (e) {
      return {
        status: 'failed',
        detail: `existing ${flacKey} does not match the WAV (${e instanceof Error ? e.message : e}); left as is, remove it and re-run`,
      };
    }
  }

  // The FLAC is smaller than the WAV it comes from; reserve the WAV's size until it is placed.
  const free = (() => {
    const s = statfsSync(root);
    return s.bavail * s.bsize;
  })();
  if (free - ctx.reserved.bytes - wavStat.size < ctx.minFreeBytes) {
    return {
      status: 'failed',
      detail: `not enough free space (${fmtBytes(free)} free, ${fmtBytes(ctx.reserved.bytes)} reserved, needs ${fmtBytes(wavStat.size)} + ${fmtBytes(ctx.minFreeBytes)} headroom)`,
    };
  }
  ctx.reserved.bytes += wavStat.size;
  const tmpName = `flac-${randomUUID()}.flac`;
  const tmpPath = join(ctx.tmpDir, tmpName);
  try {
    await runFfmpeg(ffmpegCommand(ctx.decoder, dirs, encodeArgs(`{blob}/${row.r2_key}`, `{out}/${tmpName}`, probe.bitsPerSample)));
    let v: Verified;
    try {
      v = await verifyPair(ctx.decoder, dirs, { input: `{blob}/${row.r2_key}`, probe }, { input: `{out}/${tmpName}`, path: tmpPath });
    } catch (e) {
      return { status: 'failed', detail: `verification failed, FLAC discarded: ${e instanceof Error ? e.message : e}` };
    }
    const note = copyOwnership(tmpPath, wavStat);
    fsyncPath(tmpPath);
    try {
      linkSync(tmpPath, flacPath); // never replaces: EEXIST if something appeared meanwhile
    } catch (e) {
      return { status: 'failed', detail: `could not place ${flacKey}: ${e instanceof Error ? e.message : e}` };
    }
    fsyncPath(dirname(flacPath));
    return done('ok', v, note);
  } catch (e) {
    return { status: 'failed', detail: e instanceof Error ? e.message : String(e) };
  } finally {
    ctx.reserved.bytes -= wavStat.size;
    try {
      unlinkSync(tmpPath);
    } catch {
      // never created, or already placed and removed
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Cleanup

export interface CleanupPlan {
  delete: Array<{ wavKey: string; flacKey: string; wavPath: string; flacPath: string; bytes: number }>;
  keep: Array<{ wavKey: string; reason: string }>;
}

/** The WAVs under BLOB_DIR/audio/<sid>/ (no symlinks anywhere) that may go: their `.flac`
 * sibling is a regular file and referenced, and they are not referenced themselves. */
export function planCleanup(blobDir: string, referenced: SegmentRow[]): CleanupPlan {
  const plan: CleanupPlan = { delete: [], keep: [] };
  const refs = new Set(referenced.map((r) => r.r2_key));
  const root = realpathSync(resolve(blobDir));
  const audio = join(root, 'audio');
  const isDir = (p: string) => {
    try {
      const s = lstatSync(p);
      return s.isDirectory() && !s.isSymbolicLink();
    } catch {
      return false;
    }
  };
  const isFile = (p: string): Stats | null => {
    try {
      const s = lstatSync(p);
      return s.isFile() ? s : null;
    } catch {
      return null;
    }
  };
  if (!isDir(audio)) return plan;
  for (const sid of readdirSync(audio).sort()) {
    if (!NAME_RE.test(sid) || !isDir(join(audio, sid))) continue;
    for (const name of readdirSync(join(audio, sid)).sort()) {
      if (!/\.wav$/i.test(name) || !NAME_RE.test(name)) continue;
      const wavKey = `audio/${sid}/${name}`;
      const wavPath = join(root, wavKey);
      const wav = isFile(wavPath);
      if (!wav) continue;
      const flacKey = flacKeyFor(wavKey);
      const flacPath = join(root, flacKey);
      let flacLstat: Stats | null = null;
      try {
        flacLstat = lstatSync(flacPath);
      } catch {
        flacLstat = null;
      }
      if (!flacLstat) plan.keep.push({ wavKey, reason: 'no .flac sibling' });
      else if (!flacLstat.isFile()) plan.keep.push({ wavKey, reason: 'the .flac sibling is not a regular file' });
      else if (refs.has(wavKey)) plan.keep.push({ wavKey, reason: 'the WAV is still referenced' });
      else if (!refs.has(flacKey)) plan.keep.push({ wavKey, reason: 'the .flac sibling is not referenced' });
      else plan.delete.push({ wavKey, flacKey, wavPath, flacPath, bytes: wav.size });
    }
  }
  return plan;
}

async function cleanup(
  blobDir: string,
  referenced: SegmentRow[],
  del: boolean,
  decoder: Decoder,
  user: string,
  jobs: number,
): Promise<number> {
  const plan = planCleanup(blobDir, referenced);
  for (const k of plan.keep) console.error(`keep         ${printable(k.wavKey)}  ${k.reason}`);
  const total = plan.delete.reduce((n, d) => n + d.bytes, 0);
  if (!del) {
    for (const d of plan.delete) {
      console.error(`would delete ${printable(d.wavKey)}  (${fmtBytes(d.bytes)}; referenced: ${printable(d.flacKey)})`);
    }
    console.error(
      `${plan.delete.length} to delete (${fmtBytes(total)}), ${plan.keep.length} kept; dry run, nothing deleted (pass --delete)`,
    );
    return 0;
  }
  const root = realpathSync(resolve(blobDir));
  let deleted = 0;
  let failed = 0;
  let freed = 0;
  await runPool(plan.delete.length, jobs, async (i) => {
    const d = plan.delete[i];
    try {
      const probe = probeWavHeader(readHead(d.wavPath));
      if (!probe.ok) throw new Error(`the WAV is not convertible PCM (${probe.reason}), not verified`);
      try {
        await verifyPair(decoder, { blobDir: root, user }, { input: `{blob}/${d.wavKey}`, probe }, { input: `{blob}/${d.flacKey}`, path: d.flacPath });
      } catch (e) {
        throw new Error(`the FLAC does not match the WAV (${e instanceof Error ? e.message : e})`);
      }
      const now = lstatSync(d.wavPath);
      if (!now.isFile() || !lstatSync(d.flacPath).isFile()) throw new Error('changed during the run');
      unlinkSync(d.wavPath);
      deleted += 1;
      freed += now.size;
      console.error(`deleted      ${printable(d.wavKey)}  (${fmtBytes(now.size)})`);
    } catch (e) {
      failed += 1;
      console.error(`failed       ${printable(d.wavKey)}  ${printable(e instanceof Error ? e.message : String(e))}`);
    }
  });
  console.error(`${deleted} deleted (${fmtBytes(freed)}), ${failed} failed, ${plan.keep.length} kept`);
  return failed === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------------------------
// CLI

const USAGE = `usage:
  convertWavToFlac.ts --print-query
  convertWavToFlac.ts --blob-dir <abs dir> --segments <csv> --out <file.sql>
                      [--ffmpeg <binary> | --ffmpeg-image <image>]   (default image: ${FFMPEG_IMAGE})
                      [--jobs N]          (files converted at once, 1-${MAX_JOBS}, default 1)
                      [--limit N]         (only the first N rows of the CSV)
                      [--min-free-gb N]   (free space to leave on the blob filesystem, default 2)
  convertWavToFlac.ts --print-referenced-query
  convertWavToFlac.ts --cleanup --blob-dir <abs dir> --referenced <csv> [--delete]
                      [--ffmpeg <binary> | --ffmpeg-image <image>] [--jobs N]`;

const VALUE_OPTS = [
  '--blob-dir',
  '--segments',
  '--out',
  '--ffmpeg',
  '--ffmpeg-image',
  '--jobs',
  '--limit',
  '--min-free-gb',
  '--referenced',
];

function usage(msg: string): number {
  console.error(`${msg}\n${USAGE}`);
  return 2;
}

export async function main(argv: string[]): Promise<number> {
  const opt: Record<string, string> = {};
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--print-query') {
      console.log(EXPORT_QUERY);
      return 0;
    }
    if (a === '--print-referenced-query') {
      console.log(REFERENCED_QUERY);
      return 0;
    }
    if (a === '--help' || a === '-h') {
      console.log(USAGE);
      return 0;
    }
    if (a === '--cleanup' || a === '--delete') {
      flags.add(a);
      continue;
    }
    if (!VALUE_OPTS.includes(a) || i + 1 >= argv.length) {
      return usage(`unknown or incomplete argument ${printable(a)}`);
    }
    opt[a.slice(2)] = argv[++i];
  }
  const blobDir = opt['blob-dir'];
  const isCleanup = flags.has('--cleanup');
  if (!blobDir) return usage('error: --blob-dir is required');
  if (isCleanup) {
    if (!opt.referenced) return usage('error: --cleanup needs --referenced <csv>');
    for (const k of ['segments', 'out', 'limit', 'min-free-gb']) {
      if (opt[k] !== undefined) return usage(`error: --${k} does not apply to --cleanup`);
    }
  } else {
    if (!opt.segments || !opt.out) return usage('error: --segments and --out are required');
    if (flags.has('--delete')) return usage('error: --delete only applies to --cleanup');
    if (opt.referenced !== undefined) return usage('error: --referenced only applies to --cleanup');
  }
  if (!isAbsolute(blobDir) || !existsSync(blobDir) || !statSync(blobDir).isDirectory()) {
    return usage('error: --blob-dir must be an existing absolute directory');
  }
  if (opt.ffmpeg && opt['ffmpeg-image']) return usage('error: give --ffmpeg or --ffmpeg-image, not both');
  if (!opt.ffmpeg && /[:,]/.test(realpathSync(blobDir))) {
    return usage('error: --blob-dir cannot contain ":" or "," for a docker bind mount');
  }
  const jobs = parseJobs(opt.jobs);
  if (jobs === 0) return usage(`error: --jobs must be an integer from 1 to ${MAX_JOBS}`);
  const limit = opt.limit === undefined ? Infinity : /^[1-9][0-9]*$/.test(opt.limit) ? Number(opt.limit) : 0;
  if (limit === 0) return usage('error: --limit must be a positive integer');
  const minFreeGb = opt['min-free-gb'] === undefined ? 2 : /^[0-9]+$/.test(opt['min-free-gb']) ? Number(opt['min-free-gb']) : -1;
  if (minFreeGb < 0) return usage('error: --min-free-gb must be a whole number');
  const decoder: Decoder = opt.ffmpeg
    ? { kind: 'binary', path: opt.ffmpeg }
    : { kind: 'docker', image: opt['ffmpeg-image'] ?? FFMPEG_IMAGE };
  const user = `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`;

  let rows: SegmentRow[];
  try {
    rows = parseSegmentsCsv(readFileSync(isCleanup ? opt.referenced : opt.segments, 'utf8'));
  } catch (e) {
    return usage(`error: ${e instanceof Error ? e.message : e}`);
  }
  if (isCleanup) return cleanup(blobDir, rows, flags.has('--delete'), decoder, user, jobs);

  rows = rows.slice(0, limit);
  const root = realpathSync(blobDir);
  const tmpDir = join(root, TMP_DIR_NAME);
  mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  const stale = readdirSync(tmpDir).filter((n) => /^flac-.*\.flac$/.test(n));
  if (stale.length) {
    console.error(`note: ${stale.length} temp file(s) from an interrupted run in ${tmpDir}; remove them`);
  }
  const ctx: ConvertCtx = { decoder, blobDir: root, tmpDir, user, minFreeBytes: minFreeGb * 2 ** 30, reserved: { bytes: 0 } };

  const counts: Record<Status, number> = { ok: 0, reused: 0, failed: 0, missing: 0, invalid: 0, skipped: 0 };
  const results: Array<{ row: SegmentRow; flacKey: string } | undefined> = new Array(rows.length);
  let wavTotal = 0;
  let flacTotal = 0;
  let skippedBytes = 0;
  await runPool(rows.length, jobs, async (idx) => {
    const row = rows[idx];
    let r: Awaited<ReturnType<typeof convertOne>>;
    try {
      r = await convertOne(ctx, row);
    } catch (e) {
      r = { status: 'failed', detail: e instanceof Error ? e.message : String(e) };
    }
    counts[r.status] += 1;
    if (r.status === 'skipped') {
      try {
        skippedBytes += statSync(resolve(root, row.r2_key)).size;
      } catch {
        // validated key, file gone meanwhile
      }
    }
    if ((r.status === 'ok' || r.status === 'reused') && r.flacKey) {
      results[idx] = { row, flacKey: r.flacKey };
      wavTotal += r.wavBytes ?? 0;
      flacTotal += r.flacBytes ?? 0;
    }
    console.error(`${r.status.padEnd(8)} ${printable(row.session_id)}/${printable(row.id)}  ${printable(r.detail)}`);
  });
  try {
    rmdirSync(tmpDir);
  } catch {
    // not empty (stale files reported above) or already gone
  }
  const updates = results.filter((u): u is { row: SegmentRow; flacKey: string } => u !== undefined);
  const tmp = `${opt.out}.tmp-${process.pid}`;
  writeFileSync(tmp, buildConvertSql(updates));
  renameSync(tmp, opt.out);
  console.error(
    `${counts.ok} ok, ${counts.reused} reused, ${counts.failed} failed, ${counts.missing} missing, ${counts.invalid} invalid, ${counts.skipped} skipped${counts.skipped ? ` (${fmtBytes(skippedBytes)} stay as they are)` : ''}; ` +
      `WAV ${fmtBytes(wavTotal)} -> FLAC ${fmtBytes(flacTotal)}; wrote ${updates.length} update(s) to ${opt.out}`,
  );
  return counts.ok + counts.reused === rows.length ? 0 : 1;
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
