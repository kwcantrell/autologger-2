// supabase-11a-legacy-import follow-up C: server/scripts/convertWavToFlac.ts, the parts that need
// no ffmpeg (export queries, key derivation, header probes, SQL emission, cleanup planning, CLI
// usage errors). Real conversions: convertWavToFlac.ffmpeg.test.ts; SQL applied with psql:
// pg/wavToFlac.pg.test.ts.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildConvertSql,
  EXPORT_QUERY,
  ffmpegCommand,
  flacKeyFor,
  parseFlacStreamInfo,
  planCleanup,
  probeWavHeader,
  REFERENCED_QUERY,
} from '../../scripts/convertWavToFlac';

const REPO = resolve(import.meta.dirname, '../../..');
const TSX = join(REPO, 'node_modules/.bin/tsx');
const CLI = join(REPO, 'server/scripts/convertWavToFlac.ts');

/** A PCM WAV header (+ `frames` of silence) with the given format; `tag` 0xfffe = extensible. */
function wavHeader(
  o: {
    channels?: number;
    rate?: number;
    bits?: number;
    tag?: number;
    sub?: number;
    frames?: number;
  } = {},
): Buffer {
  const { channels = 2, rate = 48_000, bits = 16, tag = 1, sub = 1, frames = 4 } = o;
  const ext = tag === 0xfffe;
  const fmtSize = ext ? 40 : 16;
  const dataSize = frames * channels * (bits / 8);
  const b = Buffer.alloc(12 + 8 + fmtSize + 8 + dataSize);
  b.write('RIFF', 0);
  b.writeUInt32LE(b.length - 8, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(fmtSize, 16);
  b.writeUInt16LE(tag, 20);
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE((rate * channels * bits) / 8, 28);
  b.writeUInt16LE((channels * bits) / 8, 32);
  b.writeUInt16LE(bits, 34);
  if (ext) {
    b.writeUInt16LE(22, 36);
    b.writeUInt16LE(bits, 38);
    b.writeUInt16LE(sub, 44); // first two bytes of the sub-format GUID
  }
  b.write('data', 20 + fmtSize);
  b.writeUInt32LE(dataSize, 24 + fmtSize);
  return b;
}

/** `fLaC` + a last-block STREAMINFO with the given fields. */
function flacHeader(rate: number, channels: number, bits: number, total: number): Buffer {
  const b = Buffer.alloc(4 + 4 + 34);
  b.write('fLaC', 0);
  b[4] = 0x80; // last metadata block, type 0
  b.writeUIntBE(34, 5, 3);
  b.writeUInt16BE(4096, 8);
  b.writeUInt16BE(4096, 10);
  // bytes 18..25: rate(20) channels-1(3) bits-1(5) total(36)
  const hi =
    rate * 2 ** 12 + (channels - 1) * 2 ** 9 + (bits - 1) * 2 ** 4 + Math.floor(total / 2 ** 32);
  b.writeUInt32BE(hi, 18);
  b.writeUInt32BE(total % 2 ** 32, 22);
  return b;
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wav2flac-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('export queries', () => {
  it('selects WAV rows (by key or mime) and all referenced keys, as session_id,id,r2_key CSV', () => {
    expect(EXPORT_QUERY).toMatch(
      /^copy \(select session_id, id, r2_key from catalog\.session_audio_segments where /,
    );
    expect(EXPORT_QUERY).toMatch(/lower\(r2_key\) like '%\.wav'/);
    expect(EXPORT_QUERY).toMatch(/lower\(mime_type\) like '%wav%'/);
    expect(EXPORT_QUERY).toMatch(/format csv, header true/);
    expect(REFERENCED_QUERY).toMatch(
      /^copy \(select session_id, id, r2_key from catalog\.session_audio_segments order by/,
    );
    expect(REFERENCED_QUERY).not.toMatch(/where/);
  });
});

describe('flacKeyFor', () => {
  it('replaces the file extension (or appends one) and keeps the stem', () => {
    expect(flacKeyFor('audio/s1/0001_a.wav')).toBe('audio/s1/0001_a.flac');
    expect(flacKeyFor('audio/s1/0001_a.WAV')).toBe('audio/s1/0001_a.flac');
    expect(flacKeyFor('audio/s1/0001_a.x.webm')).toBe('audio/s1/0001_a.x.flac');
    expect(flacKeyFor('audio/s1/0001_a')).toBe('audio/s1/0001_a.flac');
  });
});

describe('probeWavHeader', () => {
  it('accepts 16- and 24-bit integer PCM, plain and WAVE_FORMAT_EXTENSIBLE', () => {
    expect(probeWavHeader(wavHeader())).toEqual({
      ok: true,
      channels: 2,
      sampleRate: 48_000,
      bitsPerSample: 16,
    });
    expect(probeWavHeader(wavHeader({ bits: 24, channels: 1, rate: 44_100 }))).toEqual({
      ok: true,
      channels: 1,
      sampleRate: 44_100,
      bitsPerSample: 24,
    });
    expect(probeWavHeader(wavHeader({ tag: 0xfffe, bits: 24 }))).toMatchObject({
      ok: true,
      bitsPerSample: 24,
    });
  });
  it('refuses float, 8/32-bit, non-PCM extensible, and non-WAV bytes', () => {
    const float = probeWavHeader(wavHeader({ tag: 3, bits: 32 }));
    expect(float.ok).toBe(false);
    expect(float.ok ? '' : float.reason).toMatch(
      /^32-bit float PCM: FLAC is integer-only, kept as WAV/,
    );
    expect(probeWavHeader(wavHeader({ bits: 8 }))).toMatchObject({ ok: false });
    expect(probeWavHeader(wavHeader({ bits: 32 }))).toMatchObject({ ok: false });
    expect(probeWavHeader(wavHeader({ tag: 0xfffe, sub: 3, bits: 32 }))).toMatchObject({
      ok: false,
    });
    expect(probeWavHeader(Buffer.from('ID3\x04 not a wav at all'))).toMatchObject({
      ok: false,
      reason: /not a RIFF\/WAVE/,
    });
    expect(probeWavHeader(wavHeader().subarray(0, 30))).toMatchObject({ ok: false });
  });
});

describe('parseFlacStreamInfo', () => {
  it('reads rate, channels, bits per sample and total samples (36 bits)', () => {
    expect(parseFlacStreamInfo(flacHeader(48_000, 2, 16, 172_800_000))).toEqual({
      sampleRate: 48_000,
      channels: 2,
      bitsPerSample: 16,
      totalSamples: 172_800_000,
    });
    expect(parseFlacStreamInfo(flacHeader(44_100, 1, 24, 2 ** 33 + 7))).toMatchObject({
      bitsPerSample: 24,
      totalSamples: 2 ** 33 + 7,
    });
  });
  it('refuses bytes that are not a FLAC stream', () => {
    expect(() => parseFlacStreamInfo(Buffer.from('RIFF....WAVE'))).toThrow(/not a FLAC/);
  });
});

describe('buildConvertSql', () => {
  const row = { session_id: 's1', id: 'a', r2_key: 'audio/s1/0001_a.wav' };
  it('one transaction; each UPDATE switches key + mime only while the row still has the WAV key', () => {
    const sql = buildConvertSql([{ row, flacKey: 'audio/s1/0001_a.flac' }]);
    const lines = sql.split('\n');
    expect(lines).toContain('\\set ON_ERROR_STOP on');
    expect(lines).toContain('begin;');
    expect(lines.at(-2)).toBe('commit;');
    expect(lines.filter((l) => l.startsWith('update '))).toEqual([
      "update catalog.session_audio_segments set r2_key = 'audio/s1/0001_a.flac', mime_type = 'audio/flac' where session_id = 's1' and id = 'a' and r2_key = 'audio/s1/0001_a.wav';",
    ]);
  });
  it("refuses invalid ids/keys and a FLAC key outside the row's session even if validation was skipped", () => {
    expect(() =>
      buildConvertSql([
        { row: { ...row, id: "a'; drop table x; --" }, flacKey: 'audio/s1/0001_a.flac' },
      ]),
    ).toThrow(/invalid/);
    expect(() => buildConvertSql([{ row, flacKey: 'audio/s2/0001_a.flac' }])).toThrow(/invalid/);
    expect(() => buildConvertSql([{ row, flacKey: 'audio/s1/0001_a.wav' }])).toThrow(/invalid/);
  });
  it('an empty run is still a valid, no-op transaction', () => {
    expect(
      buildConvertSql([])
        .split('\n')
        .filter((l) => l.startsWith('update ')),
    ).toEqual([]);
  });
});

describe('ffmpegCommand', () => {
  it('docker: no network, blob dir read-only, out dir writable, invoking uid, the image', () => {
    const { cmd, args } = ffmpegCommand(
      { kind: 'docker', image: 'img@sha256:x' },
      { blobDir: '/b', outDir: '/b/.flac-tmp', user: '0:0' },
      ['-i', 'file:{blob}/audio/s1/a.wav', 'file:{out}/t.flac'],
    );
    expect(cmd).toBe('docker');
    expect(args.slice(0, 11)).toEqual([
      'run',
      '--rm',
      '--network',
      'none',
      '--user',
      '0:0',
      '-v',
      '/b:/blobs:ro',
      '-v',
      '/b/.flac-tmp:/out',
      'img@sha256:x',
    ]);
    expect(args.slice(11)).toEqual(['-i', 'file:/blobs/audio/s1/a.wav', 'file:/out/t.flac']);
  });
  it('binary: host paths substituted, no docker', () => {
    const { cmd, args } = ffmpegCommand(
      { kind: 'binary', path: '/usr/bin/ffmpeg' },
      { blobDir: '/b', outDir: '/b/.flac-tmp', user: '0:0' },
      ['-i', 'file:{blob}/audio/s1/a.wav', 'file:{out}/t.flac'],
    );
    expect(cmd).toBe('/usr/bin/ffmpeg');
    expect(args).toEqual(['-i', 'file:/b/audio/s1/a.wav', 'file:/b/.flac-tmp/t.flac']);
  });
});

describe('planCleanup', () => {
  const ref = (key: string) => ({ session_id: key.split('/')[1], id: 'x', r2_key: key });
  beforeEach(() => {
    mkdirSync(join(root, 'audio/s1'), { recursive: true });
    mkdirSync(join(root, 'audio/s2'), { recursive: true });
    for (const f of [
      's1/0001_a.wav',
      's1/0001_a.flac',
      's1/0002_b.wav',
      's1/0002_b.flac',
      's1/0003_c.wav',
      's2/0001_d.wav',
      's2/0001_d.flac',
    ]) {
      writeFileSync(join(root, 'audio', f), f);
    }
  });

  it('lists only WAVs whose FLAC sibling is referenced while the WAV itself is not', () => {
    const plan = planCleanup(root, [
      ref('audio/s1/0001_a.flac'), // a: converted and applied -> delete wav
      ref('audio/s1/0002_b.wav'), // b: SQL not applied yet -> keep
      ref('audio/s1/0003_c.wav'), // c: never converted -> keep
      // d: neither referenced (session deleted?) -> keep, not ours to judge
    ]);
    expect(plan.delete.map((d) => d.wavKey)).toEqual(['audio/s1/0001_a.wav']);
    expect(plan.delete[0].flacKey).toBe('audio/s1/0001_a.flac');
    expect(plan.keep.map((k) => [k.wavKey, k.reason])).toEqual([
      ['audio/s1/0002_b.wav', 'the WAV is still referenced'],
      ['audio/s1/0003_c.wav', 'no .flac sibling'],
      ['audio/s2/0001_d.wav', 'the .flac sibling is not referenced'],
    ]);
  });

  it('never lists a WAV that is referenced, even when its FLAC is referenced too', () => {
    const plan = planCleanup(root, [ref('audio/s1/0001_a.flac'), ref('audio/s1/0001_a.wav')]);
    expect(plan.delete).toEqual([]);
  });

  it('ignores symlinks (WAV, FLAC or session dir) and non-files', () => {
    rmSync(join(root, 'audio/s1/0001_a.flac'));
    symlinkSync(join(root, 'audio/s2/0001_d.flac'), join(root, 'audio/s1/0001_a.flac'));
    mkdirSync(join(root, 'outside/sx'), { recursive: true });
    writeFileSync(join(root, 'outside/sx/0001_e.wav'), 'w');
    writeFileSync(join(root, 'outside/sx/0001_e.flac'), 'f');
    symlinkSync(join(root, 'outside/sx'), join(root, 'audio/sx'));
    mkdirSync(join(root, 'audio/s2/0009_dir.wav'));
    const plan = planCleanup(root, [
      ref('audio/s1/0001_a.flac'),
      ref('audio/sx/0001_e.flac'),
      ref('audio/s2/0001_d.flac'),
    ]);
    expect(plan.delete.map((d) => d.wavKey)).toEqual(['audio/s2/0001_d.wav']);
    expect(plan.keep.find((k) => k.wavKey === 'audio/s1/0001_a.wav')?.reason).toBe(
      'the .flac sibling is not a regular file',
    );
  });
});

describe('the CLI: usage', () => {
  const run = (args: string[]) => spawnSync(TSX, [CLI, ...args], { encoding: 'utf8' });
  it('--print-query / --print-referenced-query print the export queries', () => {
    expect(run(['--print-query']).stdout.trim()).toBe(EXPORT_QUERY);
    expect(run(['--print-referenced-query']).stdout.trim()).toBe(REFERENCED_QUERY);
  });
  it('exits 2 on usage errors', () => {
    writeFileSync(join(root, 'seg.csv'), 'session_id,id,r2_key\n');
    expect(run([]).status).toBe(2);
    expect(
      run([
        '--blob-dir',
        'relative',
        '--segments',
        join(root, 'seg.csv'),
        '--out',
        join(root, 'o.sql'),
      ]).status,
    ).toBe(2);
    expect(
      run([
        '--blob-dir',
        root,
        '--segments',
        join(root, 'seg.csv'),
        '--out',
        join(root, 'o.sql'),
        '--jobs',
        '0',
      ]).status,
    ).toBe(2);
    expect(
      run([
        '--blob-dir',
        root,
        '--segments',
        join(root, 'seg.csv'),
        '--out',
        join(root, 'o.sql'),
        '--limit',
        'x',
      ]).status,
    ).toBe(2);
    expect(run(['--cleanup', '--blob-dir', root]).status).toBe(2); // no --referenced
    expect(
      run(['--cleanup', '--blob-dir', root, '--referenced', join(root, 'seg.csv'), '--out', 'x'])
        .status,
    ).toBe(2);
    expect(
      run([
        '--blob-dir',
        root,
        '--segments',
        join(root, 'seg.csv'),
        '--out',
        join(root, 'o.sql'),
        '--delete',
      ]).status,
    ).toBe(2);
  });
  it('cleanup dry run with an empty reference list deletes nothing and exits 0', () => {
    mkdirSync(join(root, 'audio/s1'), { recursive: true });
    writeFileSync(join(root, 'audio/s1/0001_a.wav'), 'w');
    writeFileSync(join(root, 'audio/s1/0001_a.flac'), 'f');
    writeFileSync(join(root, 'ref.csv'), 'session_id,id,r2_key\n');
    const r = run(['--cleanup', '--blob-dir', root, '--referenced', join(root, 'ref.csv')]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/0 to delete/);
  });
});
