// supabase-11a-legacy-import follow-up C: convertWavToFlac with a REAL ffmpeg. Uses
// `WAVEFORM_TEST_FFMPEG` or `ffmpeg` on PATH when present, else the pinned image through docker
// when it is already pulled (`docker pull <FFMPEG_IMAGE>`); skips deterministically when neither
// is available (as backfillWaveforms.ffmpeg.test.ts). Fixtures are generated here: a 16-bit
// stereo 48 kHz WAV, a 24-bit mono 44.1 kHz WAV (WAVE_FORMAT_EXTENSIBLE), a float WAV (refused:
// FLAC is integer-only) and a non-WAV file.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FFMPEG_IMAGE } from '../../scripts/blobSegmentRows';
import { parseFlacStreamInfo } from '../../scripts/convertWavToFlac';
import { floatWav } from './waveformFixtures';

const REPO = resolve(import.meta.dirname, '../../..');
const TSX = join(REPO, 'node_modules/.bin/tsx');
const CLI = join(REPO, 'server/scripts/convertWavToFlac.ts');

function pickFfmpeg(): {
  flag: string[];
  pcm: (dir: string, file: string, fmt: string) => Buffer;
} | null {
  const bin = (process.env.WAVEFORM_TEST_FFMPEG || '').trim() || 'ffmpeg';
  const args = (file: string, fmt: string) => [
    '-v',
    'error',
    '-i',
    file,
    '-map',
    '0:a:0',
    '-f',
    fmt,
    '-',
  ];
  if (spawnSync(bin, ['-version']).status === 0) {
    return {
      flag: ['--ffmpeg', bin],
      pcm: (dir, f, fmt) => spawnSync(bin, args(join(dir, f), fmt), { maxBuffer: 1 << 28 }).stdout,
    };
  }
  if (spawnSync('docker', ['image', 'inspect', FFMPEG_IMAGE], { stdio: 'ignore' }).status === 0) {
    return {
      flag: [],
      pcm: (dir, f, fmt) =>
        spawnSync(
          'docker',
          [
            'run',
            '--rm',
            '--network',
            'none',
            '-v',
            `${dir}:/w:ro`,
            FFMPEG_IMAGE,
            ...args(`/w/${f}`, fmt),
          ],
          {
            maxBuffer: 1 << 28,
          },
        ).stdout,
    };
  }
  return null;
}
const ffmpeg = pickFfmpeg();

/** Integer PCM WAV; `bits` 16 or 24; extensible header when `extensible`. Noise-like content
 * so FLAC cannot shrink it to nothing and a flipped bit changes the decoded PCM. */
function intWav(
  channels: number,
  rate: number,
  bits: 16 | 24,
  frames: number,
  extensible = false,
): Buffer {
  const bps = bits / 8;
  const fmtSize = extensible ? 40 : 16;
  const dataSize = frames * channels * bps;
  const b = Buffer.alloc(12 + 8 + fmtSize + 8 + dataSize);
  b.write('RIFF', 0);
  b.writeUInt32LE(b.length - 8, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(fmtSize, 16);
  b.writeUInt16LE(extensible ? 0xfffe : 1, 20);
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * channels * bps, 28);
  b.writeUInt16LE(channels * bps, 32);
  b.writeUInt16LE(bits, 34);
  if (extensible) {
    b.writeUInt16LE(22, 36);
    b.writeUInt16LE(bits, 38);
    b.writeUInt32LE(channels === 1 ? 4 : 3, 40);
    Buffer.from('0100000000001000800000aa00389b71', 'hex').copy(b, 44);
  }
  const o = 20 + fmtSize;
  b.write('data', o);
  b.writeUInt32LE(dataSize, o + 4);
  let seed = 12345;
  const max = 2 ** (bits - 1) - 1;
  for (let i = 0; i < frames * channels; i++) {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    const tone = Math.sin((2 * Math.PI * 440 * Math.floor(i / channels)) / rate) * 0.5;
    const noise = (seed / 2 ** 31 - 0.5) * 0.05;
    const v = Math.round((tone + noise) * max);
    if (bits === 16) b.writeInt16LE(v, o + 8 + i * 2);
    else b.writeIntLE(v, o + 8 + i * 3, 3);
  }
  return b;
}

const md5 = (b: Buffer) => createHash('md5').update(b).digest('hex');

describe.skipIf(ffmpeg === null)('convertWavToFlac with a real ffmpeg', () => {
  const ff = ffmpeg as NonNullable<typeof ffmpeg>;
  let root: string;
  let blobs: string;
  let csv: string;
  const run = (args: string[]) =>
    spawnSync(TSX, [CLI, ...args, ...ff.flag], { encoding: 'utf8', timeout: 240_000 });
  let first: ReturnType<typeof run>;
  let firstSql = '';

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'wav2flac-ff-'));
    blobs = join(root, 'blobs');
    mkdirSync(join(blobs, 'audio/s1'), { recursive: true });
    mkdirSync(join(blobs, 'audio/s2'), { recursive: true });
    writeFileSync(join(blobs, 'audio/s1/0001_s16.wav'), intWav(2, 48_000, 16, 48_000 * 2 + 17));
    chmodSync(join(blobs, 'audio/s1/0001_s16.wav'), 0o640);
    writeFileSync(join(blobs, 'audio/s1/0002_s24.wav'), intWav(1, 44_100, 24, 44_100 + 5, true));
    writeFileSync(join(blobs, 'audio/s2/0001_f32.wav'), floatWav([new Float32Array(4800)], 48_000));
    writeFileSync(join(blobs, 'audio/s2/0002_junk.wav'), 'definitely not audio');
    csv = join(root, 'segments.csv');
    writeFileSync(
      csv,
      [
        'session_id,id,r2_key',
        's1,s16,audio/s1/0001_s16.wav',
        's1,s24,audio/s1/0002_s24.wav',
        's2,f32,audio/s2/0001_f32.wav',
        's2,junk,audio/s2/0002_junk.wav',
        's2,gone,audio/s2/0003_gone.wav',
        '',
      ].join('\n'),
    );
    first = run(['--blob-dir', blobs, '--segments', csv, '--out', join(root, 'first.sql')]);
    firstSql = readFileSync(join(root, 'first.sql'), 'utf8');
  }, 300_000);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('converts the integer-PCM WAVs, refuses the rest, reports each, exits 1', () => {
    expect(first.stderr).toMatch(/^ok\s+s1\/s16\s.*48000 Hz 2ch 16-bit/m);
    expect(first.stderr).toMatch(/^ok\s+s1\/s24\s.*44100 Hz 1ch 24-bit/m);
    expect(first.stderr).toMatch(
      /^skipped\s+s2\/f32\s+.*float PCM: FLAC is integer-only, kept as WAV/m,
    );
    expect(first.stderr).toMatch(/2 skipped \(\d+ B stay as they are\)/);
    expect(first.stderr).toMatch(/^skipped\s+s2\/junk\s/m);
    expect(first.stderr).toMatch(/^missing\s+s2\/gone\s/m);
    expect(first.status).toBe(1);
    expect(firstSql.split('\n').filter((l) => l.startsWith('update '))).toEqual([
      "update catalog.session_audio_segments set r2_key = 'audio/s1/0001_s16.flac', mime_type = 'audio/flac' where session_id = 's1' and id = 's16' and r2_key = 'audio/s1/0001_s16.wav';",
      "update catalog.session_audio_segments set r2_key = 'audio/s1/0002_s24.flac', mime_type = 'audio/flac' where session_id = 's1' and id = 's24' and r2_key = 'audio/s1/0002_s24.wav';",
    ]);
  });

  it("the FLAC decodes to exactly the WAV's samples, same rate/channels/bit depth; WAVs untouched", () => {
    for (const [wav, fmt, rate, ch, bits, frames] of [
      ['audio/s1/0001_s16', 's16le', 48_000, 2, 16, 48_000 * 2 + 17],
      ['audio/s1/0002_s24', 's24le', 44_100, 1, 24, 44_100 + 5],
    ] as const) {
      const flac = readFileSync(join(blobs, `${wav}.flac`));
      expect(parseFlacStreamInfo(flac)).toEqual({
        sampleRate: rate,
        channels: ch,
        bitsPerSample: bits,
        totalSamples: frames,
      });
      const a = ff.pcm(blobs, `${wav}.wav`, fmt);
      const b = ff.pcm(blobs, `${wav}.flac`, fmt);
      expect(a.length).toBe(frames * ch * (bits / 8));
      expect(md5(b)).toBe(md5(a));
      expect(flac.length).toBeLessThan(statSync(join(blobs, `${wav}.wav`)).size);
    }
    expect(existsSync(join(blobs, 'audio/s2/0001_f32.flac'))).toBe(false);
    // The new file takes the WAV's mode; the temp dir is gone.
    expect(statSync(join(blobs, 'audio/s1/0001_s16.flac')).mode & 0o777).toBe(0o640);
    expect(readdirSync(blobs)).toEqual(['audio']);
  });

  it('a re-run reuses the verified FLACs and writes the same SQL; --jobs gives the same SQL', () => {
    const again = run([
      '--blob-dir',
      blobs,
      '--segments',
      csv,
      '--out',
      join(root, 'again.sql'),
      '--jobs',
      '3',
    ]);
    expect(again.stderr).toMatch(/^reused\s+s1\/s16\s/m);
    expect(again.stderr).toMatch(/^reused\s+s1\/s24\s/m);
    expect(again.status).toBe(1);
    expect(readFileSync(join(root, 'again.sql'), 'utf8')).toBe(firstSql);
  });

  it('a corrupted existing FLAC is reported failed and left for the operator', () => {
    const p = join(blobs, 'audio/s1/0001_s16.flac');
    const good = readFileSync(p);
    const bad = Buffer.from(good);
    bad[Math.floor(bad.length / 2)] ^= 0x55;
    writeFileSync(p, bad);
    const one = join(root, 'one.csv');
    writeFileSync(one, 'session_id,id,r2_key\ns1,s16,audio/s1/0001_s16.wav\n');
    const r = run(['--blob-dir', blobs, '--segments', one, '--out', join(root, 'bad.sql')]);
    expect(r.stderr).toMatch(/^failed\s+s1\/s16\s.*does not match the WAV/m);
    expect(r.status).toBe(1);
    expect(readFileSync(join(root, 'bad.sql'), 'utf8')).not.toMatch(/^update /m);
    expect(readFileSync(p)).toEqual(bad);
    writeFileSync(p, good);
  });

  it('--limit converts only the first N rows', () => {
    const r = run([
      '--blob-dir',
      blobs,
      '--segments',
      csv,
      '--out',
      join(root, 'lim.sql'),
      '--limit',
      '1',
    ]);
    expect(r.stderr).toMatch(/^reused\s+s1\/s16\s/m);
    expect(r.stderr).not.toMatch(/s1\/s24/);
    expect(r.status).toBe(0);
  });

  it('cleanup: dry run lists, --delete verifies then removes only the unreferenced WAV', () => {
    const ref = join(root, 'ref.csv');
    // s16 applied (FLAC referenced), s24 not applied yet (WAV referenced).
    writeFileSync(
      ref,
      'session_id,id,r2_key\ns1,s16,audio/s1/0001_s16.flac\ns1,s24,audio/s1/0002_s24.wav\ns2,f32,audio/s2/0001_f32.wav\n',
    );
    const dry = run(['--cleanup', '--blob-dir', blobs, '--referenced', ref]);
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stderr).toMatch(/^would delete\s+audio\/s1\/0001_s16\.wav/m);
    expect(dry.stderr).toMatch(/^keep\s+audio\/s1\/0002_s24\.wav\s+the WAV is still referenced/m);
    expect(existsSync(join(blobs, 'audio/s1/0001_s16.wav'))).toBe(true);

    const del = run(['--cleanup', '--blob-dir', blobs, '--referenced', ref, '--delete']);
    expect(del.status, del.stderr).toBe(0);
    expect(del.stderr).toMatch(/^deleted\s+audio\/s1\/0001_s16\.wav/m);
    expect(existsSync(join(blobs, 'audio/s1/0001_s16.wav'))).toBe(false);
    expect(existsSync(join(blobs, 'audio/s1/0001_s16.flac'))).toBe(true);
    expect(existsSync(join(blobs, 'audio/s1/0002_s24.wav'))).toBe(true);
    expect(existsSync(join(blobs, 'audio/s2/0001_f32.wav'))).toBe(true);
  });

  it('cleanup --delete keeps a WAV whose FLAC no longer matches it', () => {
    const ref = join(root, 'ref2.csv');
    writeFileSync(ref, 'session_id,id,r2_key\ns1,s24,audio/s1/0002_s24.flac\n');
    const p = join(blobs, 'audio/s1/0002_s24.flac');
    const bad = readFileSync(p);
    bad[Math.floor(bad.length / 2)] ^= 0x55;
    writeFileSync(p, bad);
    const del = run(['--cleanup', '--blob-dir', blobs, '--referenced', ref, '--delete']);
    expect(del.stderr).toMatch(/^failed\s+audio\/s1\/0002_s24\.wav\s.*does not match/m);
    expect(del.status).toBe(1);
    expect(existsSync(join(blobs, 'audio/s1/0002_s24.wav'))).toBe(true);
  });
});
