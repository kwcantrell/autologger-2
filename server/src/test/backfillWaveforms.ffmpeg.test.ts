// supabase-11a-legacy-import follow-up B: the CLI with a REAL ffmpeg. Uses `WAVEFORM_TEST_FFMPEG` or `ffmpeg` on
// PATH when present, else the pinned image through docker when it is already pulled
// (`docker pull <FFMPEG_IMAGE>`); skips deterministically when neither is available, like
// media-import's ytdlp.realbinary.test.ts. Fixtures are generated here: a 48 kHz float WAV (exact
// PCM, so the peaks must be bit-identical to the browser computation), a 44.1 kHz 16-bit WAV (the
// browser at 44.1 kHz vs our 48 kHz decode: within a small tolerance) and an MP3 made from it.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FFMPEG_IMAGE, peaksJson } from '../../scripts/backfillWaveforms';
import { expectedPeaks, floatWav } from './waveformFixtures';

const REPO = resolve(import.meta.dirname, '../../..');
const TSX = join(REPO, 'node_modules/.bin/tsx');
const CLI = join(REPO, 'server/scripts/backfillWaveforms.ts');

function pickFfmpeg(): { flag: string[]; run: (dir: string, args: string[]) => number } | null {
  const bin = (process.env.WAVEFORM_TEST_FFMPEG || '').trim() || 'ffmpeg';
  if (spawnSync(bin, ['-version']).status === 0) {
    return {
      flag: ['--ffmpeg', bin],
      run: (dir, args) =>
        spawnSync(
          bin,
          args.map((a) => a.replaceAll('/w/', `${dir}/`)),
        ).status ?? 1,
    };
  }
  if (spawnSync('docker', ['image', 'inspect', FFMPEG_IMAGE], { stdio: 'ignore' }).status === 0) {
    return {
      flag: [],
      run: (dir, args) =>
        spawnSync('docker', [
          'run',
          '--rm',
          '--network',
          'none',
          '-v',
          `${dir}:/w`,
          FFMPEG_IMAGE,
          ...args,
        ]).status ?? 1,
    };
  }
  return null;
}
const ffmpeg = pickFfmpeg();

function int16Wav(channels: Float32Array[], rate: number): Buffer {
  const n = channels.length;
  const len = channels[0].length;
  const b = Buffer.alloc(44 + len * n * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + len * n * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(n, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * n * 2, 28);
  b.writeUInt16LE(n * 2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(len * n * 2, 40);
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < n; c++) {
      b.writeInt16LE(
        Math.round(Math.max(-1, Math.min(1, channels[c][i])) * 32767),
        44 + (i * n + c) * 2,
      );
    }
  }
  return b;
}

/** A 440 Hz tone whose level ramps slowly between -40 dB and -1 dB: a waveform with shape. */
function tone(seconds: number, rate: number, phase: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    const db = -40 + 39 * (0.5 + 0.5 * Math.sin((2 * Math.PI * t) / seconds + phase));
    out[i] = 10 ** (db / 20) * Math.sin(2 * Math.PI * 440 * t);
  }
  return out;
}

function peaksOf(sql: string, id: string): number[] {
  const line = sql.split('\n').find((l) => l.includes(`and id = '${id}' and`));
  if (!line) throw new Error(`no update for ${id}`);
  const m = /waveform_peaks_json = '(\[[^']*\])'/.exec(line);
  return JSON.parse((m as RegExpExecArray)[1]);
}

const maxDiff = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
  let d = 0;
  for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - b[i]));
  return d;
};
const meanDiff = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return d / a.length;
};

describe.skipIf(ffmpeg === null)('backfillWaveforms with a real ffmpeg', () => {
  let root: string;
  let sql = '';
  let status: number | null = null;
  let stderr = '';
  const f32 = [tone(3, 48_000, 0), tone(3, 48_000, 1)];
  const s16 = [tone(3, 44_100, 2), tone(3, 44_100, 3)];

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'wfbackfill-ff-'));
    const blobs = join(root, 'blobs');
    mkdirSync(join(blobs, 'audio/s1'), { recursive: true });
    writeFileSync(join(blobs, 'audio/s1/0001_f32.wav'), floatWav(f32, 48_000, f32[0].length * 8));
    writeFileSync(join(blobs, 'audio/s1/0002_s16.wav'), int16Wav(s16, 44_100));
    writeFileSync(join(blobs, 'audio/s1/0004_junk.mp3'), 'definitely not audio');
    const enc = (ffmpeg as NonNullable<typeof ffmpeg>).run(join(blobs, 'audio/s1'), [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      '/w/0002_s16.wav',
      '-c:a',
      'libmp3lame',
      '-b:a',
      '192k',
      '/w/0003_s16.mp3',
    ]);
    if (enc !== 0) throw new Error('could not encode the MP3 fixture');
    const csv = join(root, 'segments.csv');
    writeFileSync(
      csv,
      'session_id,id,r2_key\ns1,f32,audio/s1/0001_f32.wav\ns1,s16,audio/s1/0002_s16.wav\ns1,mp3,audio/s1/0003_s16.mp3\ns1,junk,audio/s1/0004_junk.mp3\n',
    );
    const out = join(root, 'updates.sql');
    const r = spawnSync(
      TSX,
      [
        CLI,
        '--blob-dir',
        blobs,
        '--segments',
        csv,
        '--out',
        out,
        ...(ffmpeg as NonNullable<typeof ffmpeg>).flag,
      ],
      { encoding: 'utf8', timeout: 120_000 },
    );
    status = r.status;
    stderr = r.stderr;
    sql = readFileSync(out, 'utf8');
  }, 180_000);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('reports every segment and exits 1 for the undecodable one', () => {
    expect(stderr).toMatch(/^ok\s+s1\/f32\s+3\.0s 2ch -> 4096 peaks/m);
    expect(stderr).toMatch(/^ok\s+s1\/s16\b/m);
    expect(stderr).toMatch(/^ok\s+s1\/mp3\b/m);
    expect(stderr).toMatch(/^failed\s+s1\/junk\b/m);
    expect(status).toBe(1);
  });

  it('48 kHz float WAV: bit-identical to the browser computation on the same PCM', () => {
    expect(JSON.stringify(peaksOf(sql, 'f32'))).toBe(peaksJson(expectedPeaks(f32, 48_000)));
  });

  it('44.1 kHz WAV decoded at 48 kHz: within 0.02 (~1 dB) of the browser at 44.1 kHz', () => {
    const quantised = s16.map((c) => Float32Array.from(c, (x) => Math.round(x * 32767) / 32768));
    const browser = expectedPeaks(quantised, 44_100);
    const got = peaksOf(sql, 's16');
    expect(got).toHaveLength(browser.length);
    expect(maxDiff(got, browser)).toBeLessThan(0.02);
  });

  it('MP3 of the same audio: within 0.03 of the browser on the source PCM, 0.01 on average', () => {
    const quantised = s16.map((c) => Float32Array.from(c, (x) => Math.round(x * 32767) / 32768));
    const browser = expectedPeaks(quantised, 44_100);
    const got = peaksOf(sql, 'mp3');
    expect(got).toHaveLength(browser.length);
    expect(maxDiff(got, browser)).toBeLessThan(0.03);
    expect(meanDiff(got, browser)).toBeLessThan(0.01);
  });
});
