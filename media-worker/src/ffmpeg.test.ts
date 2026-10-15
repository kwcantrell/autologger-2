import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  classifyFailure,
  decodeArgs,
  flacEncodeArgs,
  InputRefused,
  inputArgs,
  ok,
  openInput,
  runFfmpeg,
} from './ffmpeg';
import { mp4MoovOrder, opusPreSkip, sniffContainer } from './sniff';

const b = (...parts: (string | number[])[]) =>
  Buffer.concat(
    parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))),
  );

function box(type: string, payload = 0): Buffer {
  const h = Buffer.alloc(8);
  h.writeUInt32BE(8 + payload, 0);
  h.write(type, 4, 'latin1');
  return Buffer.concat([h, Buffer.alloc(payload)]);
}

describe('sniffContainer: magic bytes → forced demuxer (D4)', () => {
  it.each([
    ['EBML (WebM/Matroska)', b([0x1a, 0x45, 0xdf, 0xa3], [0x9f, 0x42, 0x86]), 'matroska'],
    ['OggS', b('OggS', [0, 2]), 'ogg'],
    ['MP4 ftyp', b([0, 0, 0, 0x18], 'ftypisom', [0, 0, 2, 0]), 'mov'],
    ['RIFF WAVE', b('RIFF', [0, 0, 0, 0], 'WAVEfmt '), 'wav'],
    ['fLaC', b('fLaC', [0, 0, 0, 0x22]), 'flac'],
    ['ID3', b('ID3', [4, 0, 0]), 'mp3'],
    ['MP3 frame sync (MPEG-1 layer III)', b([0xff, 0xfb, 0x90, 0x64]), 'mp3'],
    ['MP3 frame sync (MPEG-2 layer III)', b([0xff, 0xf3, 0x48, 0xc4]), 'mp3'],
  ])('%s → %s', (_name, head, demuxer) => {
    expect(sniffContainer(head)).toBe(demuxer);
  });

  it.each([
    ['HLS playlist', b('#EXTM3U\n#EXT-X-VERSION:3\n')],
    ['ffconcat script', b('ffconcat version 1.0\nfile /etc/passwd\n')],
    ['empty', Buffer.alloc(0)],
    ['ADTS AAC (layer bits 00)', b([0xff, 0xf1, 0x50, 0x80])],
    ['MP3 sync with a reserved bitrate', b([0xff, 0xfb, 0xf0, 0x64])],
    ['RIFF that is not WAVE (AVI)', b('RIFF', [0, 0, 0, 0], 'AVI LIST')],
    ['plain text', b('hello world, not audio')],
    ['SDP', b('v=0\no=- 0 0 IN IP4 127.0.0.1\n')],
  ])('%s → refused', (_name, head) => {
    expect(sniffContainer(head)).toBeNull();
  });
});

describe('mp4MoovOrder: the top-level atom scan', () => {
  const reader = (buf: Buffer) => async (pos: number, len: number) => buf.subarray(pos, pos + len);
  it('moov before mdat → moov-first', async () => {
    const f = Buffer.concat([box('ftyp', 16), box('moov', 40), box('mdat', 100)]);
    expect(await mp4MoovOrder(reader(f), f.length)).toBe('moov-first');
  });
  it('fragmented (ftyp, moov, moof, mdat) → moov-first', async () => {
    const f = Buffer.concat([box('ftyp', 16), box('moov', 40), box('moof', 20), box('mdat', 50)]);
    expect(await mp4MoovOrder(reader(f), f.length)).toBe('moov-first');
  });
  it('mdat before moov → moov-last', async () => {
    const f = Buffer.concat([box('ftyp', 16), box('free', 4), box('mdat', 100), box('moov', 40)]);
    expect(await mp4MoovOrder(reader(f), f.length)).toBe('moov-last');
  });
  it('64-bit largesize mdat is skipped correctly', async () => {
    const big = Buffer.alloc(16 + 30);
    big.writeUInt32BE(1, 0);
    big.write('mdat', 4, 'latin1');
    big.writeBigUInt64BE(46n, 8);
    const f = Buffer.concat([box('ftyp', 16), big, box('moov', 8)]);
    expect(await mp4MoovOrder(reader(f), f.length)).toBe('moov-last');
  });
  it('no moov, or a box running past the end → no-moov', async () => {
    const f = Buffer.concat([box('ftyp', 16), box('mdat', 10)]);
    expect(await mp4MoovOrder(reader(f), f.length)).toBe('no-moov');
    const bad = Buffer.concat([box('ftyp', 16)]);
    bad.writeUInt32BE(9999, 0);
    expect(await mp4MoovOrder(reader(bad), bad.length)).toBe('no-moov');
  });
});

describe('opusPreSkip', () => {
  it('reads the OpusHead pre-skip (LE u16 at +10)', () => {
    const head = b('junkjunk', 'OpusHead', [1, 1, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0]);
    expect(opusPreSkip(head)).toBe(312);
  });
  it('null without an OpusHead', () => {
    expect(opusPreSkip(b('OggS nothing here'))).toBeNull();
  });
});

describe('argv assembly (no shell; pipe-only input, forced demuxer, -xerror)', () => {
  it('pipe input', () => {
    const a = inputArgs({ demuxer: 'matroska', mode: 'pipe' });
    expect(a.slice(0, 5)).toEqual(['-nostdin', '-hide_banner', '-loglevel', 'error', '-xerror']);
    expect(a).toEqual(expect.arrayContaining(['-protocol_whitelist', 'pipe']));
    const tail = a.slice(a.indexOf('-protocol_whitelist'));
    expect(tail).toEqual(['-protocol_whitelist', 'pipe', '-f', 'matroska', '-i', 'pipe:0']);
    expect(a.join(' ')).not.toMatch(/file/);
  });
  it('mov from a pipe disables external references too', () => {
    const a = inputArgs({ demuxer: 'mov', mode: 'pipe' });
    expect(a).toEqual(expect.arrayContaining(['-enable_drefs', '0', '-use_absolute_path', '0']));
    expect(a.slice(-6)).toEqual(['-protocol_whitelist', 'pipe', '-f', 'mov', '-i', 'pipe:0']);
  });
  it('moov-last MP4: only file:<path> with -f mov and the file whitelist', () => {
    const a = inputArgs({ demuxer: 'mov', mode: 'file', path: '/blobs/audio/s/1_a.m4a' });
    expect(a.slice(-6)).toEqual([
      '-protocol_whitelist',
      'file',
      '-f',
      'mov',
      '-i',
      'file:/blobs/audio/s/1_a.m4a',
    ]);
    expect(a).toEqual(expect.arrayContaining(['-enable_drefs', '0', '-use_absolute_path', '0']));
    expect(a).not.toContain('pipe:0');
  });
  it('-ignore_editlist 1 only when asked, and only for mov', () => {
    expect(inputArgs({ demuxer: 'mov', mode: 'pipe' }, { ignoreEditlist: true })).toEqual(
      expect.arrayContaining(['-ignore_editlist', '1']),
    );
    expect(() => inputArgs({ demuxer: 'ogg', mode: 'pipe' }, { ignoreEditlist: true })).toThrow();
  });
  it('a file input is refused for anything but mov', () => {
    expect(() =>
      inputArgs({ demuxer: 'matroska', mode: 'file', path: '/blobs/audio/x' } as never),
    ).toThrow();
  });
  it('decode to float WAV on stdout, optionally resampled', () => {
    const a = decodeArgs(
      { demuxer: 'ogg', mode: 'pipe' },
      { pcm: 'f32le', container: 'wav', rate: 48000 },
    );
    expect(a.slice(a.indexOf('-i') + 2)).toEqual([
      '-map',
      '0:a:0',
      '-vn',
      '-ar',
      '48000',
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
      'pipe:1',
    ]);
  });
  it('FLAC encode writes only the named output, never overwriting', () => {
    const a = flacEncodeArgs({ demuxer: 'wav', mode: 'pipe' }, 24, '/blobs/media/j/converted.flac');
    expect(a).toEqual(expect.arrayContaining(['-c:a', 'flac', '-compression_level', '8', '-n']));
    expect(a).toEqual(expect.arrayContaining(['-sample_fmt', 's32', '-bits_per_raw_sample', '24']));
    expect(a.at(-1)).toBe('file:/blobs/media/j/converted.flac');
  });
});

describe('openInput: the worker opens the blob itself', () => {
  let root: string;
  let blobDir: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'mw-open-'));
    blobDir = join(root, 'blobs');
    await mkdir(join(blobDir, 'audio/s1'), { recursive: true });
    await mkdir(join(blobDir, '.trash/2026-10-12/audio/s1'), { recursive: true });
    await mkdir(join(blobDir, 'media/j1'), { recursive: true });
    await writeFile(join(blobDir, 'audio/s1/1_a.webm'), 'x'.repeat(10));
    await writeFile(join(blobDir, '.trash/2026-10-12/audio/s1/0_b.webm'), 'y');
    await writeFile(join(blobDir, 'media/j1/out.webm'), 'z');
    await writeFile(join(root, 'outside.webm'), 'o');
    await symlink(join(blobDir, 'audio/s1/1_a.webm'), join(blobDir, 'audio/s1/link.webm'));
    await symlink(join(root, 'outside.webm'), join(blobDir, 'audio/s1/out.webm'));
    await mkdir(join(blobDir, 'audio/s1/dir.webm'));
    execFileSync('mkfifo', [join(blobDir, 'audio/s1/fifo.webm')]);
    await writeFile(join(blobDir, 'audio/s1/secret.webm'), 's');
    await chmod(join(blobDir, 'audio/s1/secret.webm'), 0o000);
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('opens a regular file under audio/ and .trash/', async () => {
    const a = await openInput(blobDir, 'audio/s1/1_a.webm');
    expect(a.size).toBe(10);
    await a.close();
    const t = await openInput(blobDir, '.trash/2026-10-12/audio/s1/0_b.webm');
    expect(t.size).toBe(1);
    await t.close();
  });

  it.each([
    ['a symlink (O_NOFOLLOW)', 'audio/s1/link.webm', 'decode-failed'],
    ['a symlink out of the tree', 'audio/s1/out.webm', 'decode-failed'],
    ['a directory', 'audio/s1/dir.webm', 'decode-failed'],
    ['a FIFO (not a regular file, never blocks)', 'audio/s1/fifo.webm', 'decode-failed'],
    ['outside audio/ and .trash/ (media/)', 'media/j1/out.webm', 'decode-failed'],
    ['a parent escape', 'audio/../../outside.webm', 'decode-failed'],
    ['an absolute key', '/etc/passwd', 'decode-failed'],
    ['a missing file', 'audio/s1/nope.webm', 'missing-blob'],
  ])('refuses %s', async (_n, key, code) => {
    const err = await openInput(blobDir, key).catch((e) => e);
    expect(err).toBeInstanceOf(InputRefused);
    expect((err as InputRefused).code).toBe(code);
    expect((err as Error).message).not.toContain(blobDir);
  });

  it.skipIf(process.getuid?.() === 0)(
    'an unreadable file is missing-blob (mode 0600 import note)',
    async () => {
      const err = await openInput(blobDir, 'audio/s1/secret.webm').catch((e) => e);
      expect((err as InputRefused).code).toBe('missing-blob');
    },
  );
});

describe('runFfmpeg: limits and classification', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mw-run-'));
    await writeFile(join(dir, 'hang.sh'), '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
    await writeFile(
      join(dir, 'fail.sh'),
      '#!/bin/sh\necho "Invalid data found when processing input /blobs/audio/s/x" >&2\nexit 183\n',
      { mode: 0o755 },
    );
    await writeFile(join(dir, 'echo.sh'), '#!/bin/sh\nprintf "%s|" "$@"\n', { mode: 0o755 });
    await writeFile(
      join(dir, 'soft.sh'),
      '#!/bin/sh\necho "[opus @ 0x1] Error parsing Opus packet header." >&2\necho "    Last message repeated 29 times" >&2\nexit 0\n',
      { mode: 0o755 },
    );
    await writeFile(
      join(dir, 'eof.sh'),
      '#!/bin/sh\necho "[in#0/matroska,webm @ 0x1] File ended prematurely" >&2\nexit 0\n',
      { mode: 0o755 },
    );
    await writeFile(
      join(dir, 'nospace.sh'),
      '#!/bin/sh\necho "No space left on device" >&2\nexit 1\n',
      { mode: 0o755 },
    );
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('passes argv without a shell (metacharacters stay literal)', async () => {
    let out = '';
    const r = await runFfmpeg({
      ffmpegPath: join(dir, 'echo.sh'),
      args: ['-i', 'pipe:0', '$(id)', ';rm -rf /'],
      onStdout: (c) => {
        out += c.toString();
      },
      timeoutMs: 5000,
    });
    expect(r.code).toBe(0);
    expect(out).toBe('-i|pipe:0|$(id)|;rm -rf /|');
  });

  it('kills with SIGKILL at the wall-clock limit → timeout', async () => {
    const t0 = Date.now();
    const r = await runFfmpeg({ ffmpegPath: join(dir, 'hang.sh'), args: [], timeoutMs: 300 });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.timedOut).toBe(true);
    expect(r.signal).toBe('SIGKILL');
    expect(classifyFailure(r)).toBe('timeout');
  });

  it('an abort signal kills it too', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const r = await runFfmpeg({
      ffmpegPath: join(dir, 'hang.sh'),
      args: [],
      timeoutMs: 10_000,
      signal: ac.signal,
    });
    expect(r.aborted).toBe(true);
    expect(r.signal).toBe('SIGKILL');
  });

  it('a non-zero exit is decode-failed; the stderr tail is kept for classification only', async () => {
    const r = await runFfmpeg({ ffmpegPath: join(dir, 'fail.sh'), args: [], timeoutMs: 5000 });
    expect(r.code).toBe(183);
    expect(classifyFailure(r)).toBe('decode-failed');
  });

  it('exit 0 with an error line on stderr is a failure (spike 0.2: a dropped packet is not fatal to ffmpeg)', async () => {
    const r = await runFfmpeg({ ffmpegPath: join(dir, 'soft.sh'), args: [], timeoutMs: 5000 });
    expect(r.code).toBe(0);
    expect(ok(r)).toBe(false);
    expect(classifyFailure(r)).toBe('decode-failed');
  });

  it('the truncated-WebM end-of-file note alone is not a failure (a partial chunk trimmed to a slice)', async () => {
    const r = await runFfmpeg({ ffmpegPath: join(dir, 'eof.sh'), args: [], timeoutMs: 5000 });
    expect(ok(r)).toBe(true);
  });

  it('ENOSPC on stderr is low-disk; a missing binary is internal', async () => {
    const r = await runFfmpeg({ ffmpegPath: join(dir, 'nospace.sh'), args: [], timeoutMs: 5000 });
    expect(classifyFailure(r)).toBe('low-disk');
    const m = await runFfmpeg({
      ffmpegPath: join(dir, 'does-not-exist'),
      args: [],
      timeoutMs: 5000,
    });
    expect(classifyFailure(m)).toBe('internal');
  });
});
