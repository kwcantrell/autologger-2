// Ingest with a real ffmpeg (skips without one; see src/test/ffmpegBin.ts).

import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, open, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { MediaIngestResult } from '@autologger/ports/media';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inputArgs, runFfmpeg } from '../ffmpeg';
import { FFMPEG, TRANSCRIPTION_FIXTURES } from '../test/ffmpegBin';
import {
  ctx,
  fakeReads,
  floatWav,
  intWav,
  job,
  makeTree,
  seg,
  type Tree,
  wave,
} from '../test/fixtures';
import { parseFlacStreamInfo } from '../verify';
import { runIngest } from './ingest';

const d = describe.skipIf(!FFMPEG);
const JOB = job();
const JOB_DIR = `media/${JOB.id}`;

let tree: Tree;
beforeAll(async () => {
  tree = await makeTree();
});
afterAll(async () => {
  await rm(tree.root, { recursive: true, force: true });
});

async function ingest(key: string, over = {}) {
  await rm(join(tree.blobDir, JOB_DIR), { recursive: true, force: true });
  return runIngest(
    ctx(tree, fakeReads([seg({ id: 'seg-1', r2Key: key })]), {
      ffmpegPath: FFMPEG as string,
      ...over,
    }),
    JOB,
  );
}

function resultOf(out: Awaited<ReturnType<typeof runIngest>>): MediaIngestResult {
  if (out.kind !== 'done') throw new Error(`expected done, got ${JSON.stringify(out)}`);
  return out.result as MediaIngestResult;
}

/** Paths a result names must be `media/<job id>/<single name>`. */
function assertConfined(r: MediaIngestResult) {
  const keys = JSON.stringify(r).match(/"key":"[^"]*"/g) ?? [];
  for (const k of keys) expect(k).toMatch(new RegExp(`^"key":"${JOB_DIR}/[A-Za-z0-9._-]+"$`));
  expect(JSON.stringify(r)).not.toMatch(/\/blobs|"audio\/[^"]+\/|\.trash|\.tmp|\.\./);
}

d('runIngest with ffmpeg', () => {
  it('s16 stereo WAV → FLAC under media/<job>/, verified (STREAMINFO, sample count), peaks and duration', async () => {
    const len = 48_000 * 2 + 123;
    const key = await tree.put(
      '2_a.wav',
      intWav([wave(len, 1, 0.7), wave(len, 2, 0.3)], 48_000, 16),
    );
    const r = resultOf(await ingest(key));
    expect(r.flac).toEqual({ key: `${JOB_DIR}/converted-a1.flac`, mime: 'audio/flac' });
    expect(r.duration_ms).toBe(Math.round((len / 48_000) * 1000));
    expect(r.sample_rate).toBe(48_000);
    expect(r.channels).toBe(2);
    expect(r.codec).toMatch(/pcm/);
    expect(r.peaks.length).toBe(4096);
    expect(r.peaks.every((p) => p >= 0 && p <= 1)).toBe(true);
    const flacPath = join(tree.blobDir, JOB_DIR, 'converted-a1.flac');
    const info = parseFlacStreamInfo(await readFile(flacPath));
    expect(info).toEqual({ sampleRate: 48_000, channels: 2, bitsPerSample: 16, totalSamples: len });
    expect((await stat(flacPath)).mode & 0o777).toBe(0o644);
    expect((await stat(join(tree.blobDir, JOB_DIR))).mode & 0o777).toBe(0o777);
    assertConfined(r);
  });

  it('24-bit mono 44.1 kHz WAV → FLAC 24-bit', async () => {
    const len = 44_100;
    const key = await tree.put('3_a.wav', intWav([wave(len, 3, 0.9)], 44_100, 24));
    const r = resultOf(await ingest(key));
    expect(r.flac?.key).toBe(`${JOB_DIR}/converted-a1.flac`);
    const info = parseFlacStreamInfo(
      await readFile(join(tree.blobDir, JOB_DIR, 'converted-a1.flac')),
    );
    expect(info).toMatchObject({
      sampleRate: 44_100,
      channels: 1,
      bitsPerSample: 24,
      totalSamples: len,
    });
    expect(r.duration_ms).toBe(1000);
  });

  it('f32 WAV → no FLAC (integer only), still duration and peaks; no job directory', async () => {
    const key = await tree.put('4_a.wav', floatWav([wave(24_000, 4, 0.5)], 48_000));
    const r = resultOf(await ingest(key));
    expect(r.flac).toBeNull();
    expect(r.duration_ms).toBe(500);
    await expect(stat(join(tree.blobDir, JOB_DIR))).rejects.toThrow();
  });

  it.each([
    ['seg1.webm', 'opus'],
    ['seg5-opus.ogg', 'opus'],
    ['seg-flac.flac', 'flac'],
    ['seg-aac.m4a', 'aac'],
  ])('%s → duration and peaks, no FLAC', async (fixture, codec) => {
    const key = await tree.copyFixture(fixture, `5_${fixture}`);
    const r = resultOf(await ingest(key));
    expect(r.codec).toBe(codec);
    expect(r.flac).toBeNull();
    expect(r.duration_ms).toBeGreaterThan(0);
    expect(r.peaks.length).toBeGreaterThanOrEqual(256);
    assertConfined(r);
  });

  it('a corrupted Opus stream fails decode-failed under -xerror', async () => {
    const bytes = Buffer.from(await readFile(join(TRANSCRIPTION_FIXTURES, 'seg1.webm')));
    // Damage each SimpleBlock's Opus packet header: ffmpeg's parser drops those packets and exits
    // 0 even with -xerror (spike 0.2's lesson), so the worker must fail it from stderr.
    const cluster = bytes.indexOf(Buffer.from([0x1f, 0x43, 0xb6, 0x75]));
    expect(cluster).toBeGreaterThan(0);
    let damaged = 0;
    for (let i = cluster; i < bytes.length - 8; i++) {
      if (bytes[i] === 0xa3 && bytes[i + 1] & 0x80 && (bytes[i + 1] & 0x7f) > 4) {
        bytes[i + 6] = 0xff;
        bytes[i + 7] = 0xff;
        damaged++;
      }
    }
    expect(damaged).toBeGreaterThan(5);
    const key = await tree.put('6_bad.webm', bytes);
    expect(await ingest(key)).toEqual({ kind: 'fail', error: 'decode-failed', final: false });
  });

  it('a timeout is classified timeout', async () => {
    const key = await tree.copyFixture('seg1.webm', '7_a.webm');
    expect(await ingest(key, { timeoutMs: 1 })).toEqual({
      kind: 'fail',
      error: 'timeout',
      final: false,
    });
  });

  it('a moov-last MP4 with an external alias reference decodes only its own samples and opens nothing else', async () => {
    const key = await tree.copyFixture('seg-aac-dref.m4a', '8_dref.m4a');
    const sentinel = join(tree.blobDir, 'audio/s1/sentinel.m4a');
    execFileSync('mkfifo', [sentinel]);
    // A reader opening the FIFO (even blocked in open) lets a non-blocking writer open succeed.
    const opened = async () => {
      const fh = await open(sentinel, constants.O_WRONLY | constants.O_NONBLOCK).catch(() => null);
      if (!fh) return false;
      await fh.write(Buffer.from('not audio'));
      await fh.close();
      return true;
    };
    let seen = false;
    const watch = setInterval(async () => {
      if (await opened()) seen = true;
    }, 20);
    try {
      const r = resultOf(await ingest(key));
      expect(r.codec).toBe('aac');
      expect(r.duration_ms).toBeGreaterThan(0);
      expect(seen).toBe(false);

      // Positive control: the same file with external references enabled does open the sentinel.
      const control = runFfmpeg({
        ffmpegPath: FFMPEG as string,
        args: [
          ...inputArgs({ demuxer: 'mov', mode: 'file', path: join(tree.blobDir, key) }).map(
            (a, i, all) => (all[i - 1] === '-enable_drefs' ? '1' : a),
          ),
          '-map',
          '0:a:0',
          '-f',
          'null',
          '-',
        ],
        timeoutMs: 30_000,
      });
      await control;
      expect(seen).toBe(true);
    } finally {
      clearInterval(watch);
      await rm(sentinel, { force: true });
    }
  });

  it('results never name a path outside media/<job>/ and the worker writes nothing else', async () => {
    const before = await readdir(join(tree.blobDir, 'audio/s1'));
    const key = await tree.put('9_a.wav', intWav([wave(4800, 9, 0.2)], 48_000, 16));
    const r = resultOf(await ingest(key));
    assertConfined(r);
    const after = await readdir(join(tree.blobDir, 'audio/s1'));
    expect(after.filter((f) => !before.includes(f))).toEqual(['9_a.wav']);
    expect(await readdir(join(tree.blobDir, 'media'))).toEqual([JOB.id]);
    expect(await readdir(join(tree.blobDir, JOB_DIR))).toEqual(['converted-a1.flac']);
  });

  it('the input is never modified', async () => {
    const src = join(TRANSCRIPTION_FIXTURES, 'seg2.webm');
    const key = await tree.copyFixture('seg2.webm', '10_a.webm');
    await ingest(key);
    expect(await readFile(join(tree.blobDir, key))).toEqual(await readFile(src));
    await copyFile(src, join(tree.root, 'unused'));
  });
});
