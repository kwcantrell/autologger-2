// supabase-11a-legacy-import follow-up B: server/scripts/backfillWaveforms.ts, hermetic. A fake ffmpeg (a node
// script that streams its input file, already a float WAV, to stdout) stands in for the decoder,
// so the full CLI runs without ffmpeg or docker. Real-ffmpeg runs: backfillWaveforms.ffmpeg.test.ts.

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { segmentWaveformDecodeBucketCount } from '@autologger/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildUpdateSql,
  checkSegment,
  decodeArgs,
  EXPORT_QUERY,
  parseSegmentsCsv,
  peaksJson,
  readWavPcm,
  type SegmentRow,
} from '../../scripts/backfillWaveforms';
import { expectedPeaks, floatWav, wave } from './waveformFixtures';

const REPO = resolve(import.meta.dirname, '../../..');
const TSX = join(REPO, 'node_modules/.bin/tsx');
const CLI = join(REPO, 'server/scripts/backfillWaveforms.ts');

function chunked(buf: Buffer, size: number): Readable {
  const parts: Buffer[] = [];
  for (let o = 0; o < buf.length; o += size) parts.push(buf.subarray(o, o + size));
  return Readable.from(parts);
}

const ROW = (o: Partial<SegmentRow> = {}): SegmentRow => ({
  session_id: 's1',
  id: 'seg-1',
  r2_key: 'audio/s1/0001_seg-1.wav',
  ...o,
});

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wfbackfill-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('parseSegmentsCsv', () => {
  it('reads the export (header + rows, CRLF and quoted fields tolerated)', () => {
    const csv = 'session_id,id,r2_key\r\ns1,a,audio/s1/a.wav\r\n"s2","b","audio/s2/b.mp3"\n\n';
    expect(parseSegmentsCsv(csv)).toEqual([
      { session_id: 's1', id: 'a', r2_key: 'audio/s1/a.wav' },
      { session_id: 's2', id: 'b', r2_key: 'audio/s2/b.mp3' },
    ]);
  });
  it('refuses a missing or reordered header and a short row', () => {
    expect(() => parseSegmentsCsv('s1,a,audio/s1/a.wav\n')).toThrow(/header/);
    expect(() => parseSegmentsCsv('id,session_id,r2_key\n')).toThrow(/header/);
    expect(() => parseSegmentsCsv('session_id,id,r2_key\ns1,a\n')).toThrow(/line 2/);
  });
  it('the export query selects exactly those columns of rows still NULL', () => {
    expect(EXPORT_QUERY).toMatch(
      /select session_id, id, r2_key from catalog\.session_audio_segments/,
    );
    expect(EXPORT_QUERY).toMatch(/where waveform_peaks_json is null/);
    expect(EXPORT_QUERY).toMatch(/header/);
  });
});

describe('checkSegment (key validation)', () => {
  beforeEach(() => {
    mkdirSync(join(root, 'audio/s1'), { recursive: true });
    writeFileSync(join(root, 'audio/s1/0001_seg-1.wav'), 'x');
  });
  it('accepts audio/<session_id>/<file> inside the blob dir', () => {
    expect(checkSegment(ROW(), root)).toEqual({
      kind: 'ok',
      path: join(root, 'audio/s1/0001_seg-1.wav'),
    });
  });
  it.each([
    ['another session', { r2_key: 'audio/s2/0001_seg-1.wav' }],
    ['dot-dot', { r2_key: 'audio/s1/../s1/0001_seg-1.wav' }],
    ['dot-dot file', { r2_key: 'audio/s1/..' }],
    ['nested', { r2_key: 'audio/s1/x/0001_seg-1.wav' }],
    ['leading dash', { r2_key: 'audio/s1/-i.wav' }],
    ['leading dot', { r2_key: 'audio/s1/.hidden' }],
    ['absolute', { r2_key: '/etc/passwd' }],
    ['protocol', { r2_key: 'audio/s1/concat:a|b' }],
    ['quote in key', { r2_key: "audio/s1/a'b.wav" }],
    ['bad session id', { session_id: "s1';drop", r2_key: "audio/s1';drop/a.wav" }],
    ['bad segment id', { id: "x' or '1'='1" }],
    ['empty id', { id: '' }],
    ['newline', { r2_key: 'audio/s1/a\n.wav' }],
  ])('refuses %s', (_name, o) => {
    expect(checkSegment(ROW(o), root).kind).toBe('invalid');
  });
  it('reports a missing file as missing', () => {
    expect(checkSegment(ROW({ r2_key: 'audio/s1/nope.wav' }), root).kind).toBe('missing');
  });
  it('refuses a symlink that leaves the blob dir', () => {
    writeFileSync(join(root, '..', `outside-${process.pid}`), 'x');
    symlinkSync(join(root, '..', `outside-${process.pid}`), join(root, 'audio/s1/link.wav'));
    try {
      expect(checkSegment(ROW({ r2_key: 'audio/s1/link.wav' }), root).kind).toBe('invalid');
    } finally {
      rmSync(join(root, '..', `outside-${process.pid}`), { force: true });
    }
  });
});

describe('SQL emission', () => {
  const peaks = Float32Array.from([0, 0.5, 0.123456789, 1, 0.25, 0.75, 0.1, 0.9]);
  it('peaksJson is the browser PUT body text (Float32 values as JS numbers)', () => {
    expect(peaksJson(peaks)).toBe(JSON.stringify(Array.from(peaks, (x) => Number(x))));
    expect(peaksJson(peaks)).toMatch(/^\[[0-9.e+-]+(,[0-9.e+-]+)*\]$/);
  });
  it('refuses out-of-range, non-finite or wrongly sized peaks', () => {
    expect(() => peaksJson(Float32Array.from([...peaks, 1.5]))).toThrow(/\[0, 1\]/);
    expect(() => peaksJson(Float32Array.from([...peaks, Number.NaN]))).toThrow(/\[0, 1\]/);
    expect(() => peaksJson(new Float32Array(7))).toThrow(/8\.\.4096/);
    expect(() => peaksJson(new Float32Array(4097))).toThrow(/8\.\.4096/);
  });
  it('one transaction; each UPDATE sets peaks + floor -48 only where the row is still NULL', () => {
    const sql = buildUpdateSql([
      { row: ROW(), peaks },
      { row: ROW({ session_id: 's.2_x-y', id: 'b', r2_key: 'audio/s.2_x-y/b.mp3' }), peaks },
    ]);
    const lines = sql.split('\n');
    expect(lines).toContain('\\set ON_ERROR_STOP on');
    expect(lines).toContain('begin;');
    expect(lines.at(-2)).toBe('commit;');
    const updates = lines.filter((l) => l.startsWith('update '));
    expect(updates).toHaveLength(2);
    expect(updates[0]).toBe(
      `update catalog.session_audio_segments set waveform_peaks_json = '${peaksJson(peaks)}', waveform_db_floor = -48 where session_id = 's1' and id = 'seg-1' and waveform_peaks_json is null;`,
    );
    expect(updates[1]).toContain(
      "where session_id = 's.2_x-y' and id = 'b' and waveform_peaks_json is null;",
    );
  });
  it('refuses to emit an invalid id even if a caller skipped validation', () => {
    expect(() => buildUpdateSql([{ row: ROW({ id: "a'b" }), peaks }])).toThrow(/invalid/);
  });
  it('an empty run is still a valid, no-op transaction', () => {
    expect(buildUpdateSql([])).toMatch(/begin;\n.*commit;\n$/s);
  });
});

describe('readWavPcm', () => {
  it('streams interleaved frames whatever the chunking, skipping other chunks', async () => {
    const chans = [wave(5000, 1, 0.7), wave(5000, 2, 0.3)];
    const wav = floatWav(chans, 48_000);
    for (const size of [1, 3, 7, 4096, wav.length]) {
      const got: number[] = [];
      const fmt = await readWavPcm(chunked(wav, size), (s) => {
        for (const x of s) got.push(x);
      });
      expect(fmt).toEqual({ channels: 2, sampleRate: 48_000, frames: 5000 });
      expect(got.length).toBe(10_000);
      expect(got[0]).toBe(chans[0][0]);
      expect(got[9999]).toBe(chans[1][4999]);
    }
  });
  it('refuses non-float or non-WAV input and a torn final frame', async () => {
    await expect(
      readWavPcm(chunked(Buffer.from('not a wav at all, really'), 4), () => {}),
    ).rejects.toThrow(/WAV/);
    const wav = floatWav([wave(10, 1, 1), wave(10, 2, 1)], 48_000);
    const s16 = Buffer.from(wav);
    s16.writeUInt16LE(1, 20); // PCM int, not float
    await expect(readWavPcm(chunked(s16, 64), () => {})).rejects.toThrow(/float/);
    await expect(
      readWavPcm(chunked(wav.subarray(0, wav.length - 2), 64), () => {}),
    ).rejects.toThrow(/frame/);
  });
});

describe('decodeArgs', () => {
  it('docker mode: no network, blob dir read-only, the pinned image, file: input', () => {
    const a = decodeArgs(
      { kind: 'docker', image: 'img@sha256:abc' },
      '/blobs-on-host',
      'audio/s1/a.wav',
    );
    expect(a.cmd).toBe('docker');
    expect(a.args.slice(0, 6)).toEqual([
      'run',
      '--rm',
      '--network',
      'none',
      '-v',
      '/blobs-on-host:/blobs:ro',
    ]);
    expect(a.args).toContain('img@sha256:abc');
    expect(a.args).toContain('file:/blobs/audio/s1/a.wav');
  });
  it('binary mode: absolute file: path, f32 WAV at 48 kHz, first audio stream, channels kept', () => {
    const a = decodeArgs({ kind: 'binary', path: '/usr/bin/ffmpeg' }, '/b', 'audio/s1/a.wav');
    expect(a.cmd).toBe('/usr/bin/ffmpeg');
    const s = a.args.join(' ');
    expect(s).toContain('-i file:/b/audio/s1/a.wav');
    expect(s).toContain('-map 0:a:0');
    expect(s).toContain('-ar 48000');
    expect(s).toContain('-c:a pcm_f32le');
    expect(s).toContain('-f wav -');
    expect(a.args).not.toContain('-ac');
  });
});

describe('the CLI end to end (fake ffmpeg)', () => {
  function setup() {
    const blobs = join(root, 'blobs');
    mkdirSync(join(blobs, 'audio/s1'), { recursive: true });
    mkdirSync(join(blobs, 'audio/s2'), { recursive: true });
    const a = [wave(48_000 * 2 + 5, 3, 0.9), wave(48_000 * 2 + 5, 4, 0.2)];
    const b = [wave(1234, 5, 0.5)];
    writeFileSync(join(blobs, 'audio/s1/0001_a.wav'), floatWav(a, 48_000));
    writeFileSync(join(blobs, 'audio/s2/0001_b.mp3'), floatWav(b, 48_000));
    writeFileSync(join(blobs, 'audio/s2/0002_bad.mp3'), 'BAD');
    const fake = join(root, 'fake-ffmpeg.mjs');
    writeFileSync(
      fake,
      `#!/usr/bin/env node
import { createReadStream, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const input = args[args.indexOf('-i') + 1].replace(/^file:/, '');
if (readFileSync(input).subarray(0, 3).toString() === 'BAD') { console.error('Invalid data found when processing input'); process.exit(1); }
createReadStream(input, { highWaterMark: 1000 }).pipe(process.stdout);
`,
    );
    chmodSync(fake, 0o755);
    const csv = join(root, 'segments.csv');
    writeFileSync(
      csv,
      [
        'session_id,id,r2_key',
        's1,a,audio/s1/0001_a.wav',
        's2,b,audio/s2/0001_b.mp3',
        's2,bad,audio/s2/0002_bad.mp3',
        's2,gone,audio/s2/0003_gone.mp3',
        's2,evil,audio/s2/../../etc/passwd',
        '',
      ].join('\n'),
    );
    return { blobs, fake, csv, a, b, out: join(root, 'updates.sql') };
  }

  it('fills the decodable rows, reports the rest, exits 1', () => {
    const { blobs, fake, csv, a, b, out } = setup();
    const r = spawnSync(
      TSX,
      [CLI, '--blob-dir', blobs, '--segments', csv, '--out', out, '--ffmpeg', fake],
      {
        encoding: 'utf8',
        cwd: root,
      },
    );
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toMatch(/^ok\s+s1\/a\b/m);
    expect(r.stderr).toMatch(/^ok\s+s2\/b\b/m);
    expect(r.stderr).toMatch(/^failed\s+s2\/bad\b.*Invalid data/m);
    expect(r.stderr).toMatch(/^missing\s+s2\/gone\b/m);
    expect(r.stderr).toMatch(/^invalid\s+s2\/evil\b/m);
    expect(r.stderr).toMatch(/2 ok, 1 failed, 1 missing, 1 invalid/);
    const sql = readFileSync(out, 'utf8');
    const updates = sql.split('\n').filter((l) => l.startsWith('update '));
    expect(updates).toHaveLength(2);
    expect(updates[0]).toContain(`'${peaksJson(expectedPeaks(a, 48_000))}'`);
    expect(updates[0]).toContain("session_id = 's1' and id = 'a' and waveform_peaks_json is null");
    expect(updates[1]).toContain(`'${peaksJson(expectedPeaks(b, 48_000))}'`);
    expect(expectedPeaks(a, 48_000)).toHaveLength(4096);
    expect(expectedPeaks(b, 48_000)).toHaveLength(
      segmentWaveformDecodeBucketCount(1234 / 48_000, 1234 / 48_000),
    );
  });

  it('exits 0 when every segment is filled; 2 on usage errors; --print-query prints the export query', () => {
    const { blobs, fake, out } = setup();
    const csv = join(root, 'one.csv');
    writeFileSync(csv, 'session_id,id,r2_key\ns1,a,audio/s1/0001_a.wav\n');
    const ok = spawnSync(
      TSX,
      [CLI, '--blob-dir', blobs, '--segments', csv, '--out', out, '--ffmpeg', fake],
      {
        encoding: 'utf8',
      },
    );
    expect(ok.status, ok.stderr).toBe(0);
    const usage = spawnSync(TSX, [CLI, '--blob-dir', 'relative', '--segments', csv, '--out', out], {
      encoding: 'utf8',
    });
    expect(usage.status).toBe(2);
    const q = spawnSync(TSX, [CLI, '--print-query'], { encoding: 'utf8' });
    expect(q.status).toBe(0);
    expect(q.stdout.trim()).toBe(EXPORT_QUERY);
  });

  it('--jobs N decodes in parallel and writes the same SQL, in input order, as one job', () => {
    const { blobs, fake, csv, out } = setup();
    const run = (extra: string[], dest: string) =>
      spawnSync(
        TSX,
        [CLI, '--blob-dir', blobs, '--segments', csv, '--out', dest, '--ffmpeg', fake, ...extra],
        { encoding: 'utf8', cwd: root },
      );
    const one = run([], out);
    const par = join(root, 'updates-par.sql');
    const four = run(['--jobs', '4'], par);
    expect(four.status, four.stderr).toBe(1);
    expect(four.stderr).toMatch(/2 ok, 1 failed, 1 missing, 1 invalid/);
    expect(readFileSync(par, 'utf8')).toBe(readFileSync(out, 'utf8'));
    expect(one.status).toBe(1);
    for (const bad of ['0', '-1', '1.5', 'x', '65']) {
      const r = run(['--jobs', bad], join(root, 'never.sql'));
      expect(r.status, `--jobs ${bad}`).toBe(2);
      expect(r.stderr).toMatch(/--jobs/);
    }
  });
});
