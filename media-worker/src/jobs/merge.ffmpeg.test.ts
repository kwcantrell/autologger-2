// Merge with a real ffmpeg (skips without one): packet copy per family, exact verification,
// seams, and refusals that leave no output.

import { copyFile, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AudioSeam, MediaMergeResult } from '@autologger/ports/media';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeArgs, runFfmpeg } from '../ffmpeg';
import { opusPreSkip, sniffContainer } from '../sniff';
import { FFMPEG, TRANSCRIPTION_FIXTURES } from '../test/ffmpegBin';
import { ctx, fakeReads, intWav, job, makeTree, seg, type Tree, wave } from '../test/fixtures';
import { parseFlacStreamInfo } from '../verify';
import { runMerge } from './merge';

const d = describe.skipIf(!FFMPEG);
const MJOB = job({ kind: 'merge', target: '1', inputBytes: 10_000 });
const JOB_DIR = `media/${MJOB.id}`;
const T = (m: number) => `2026-10-12T10:${String(m).padStart(2, '0')}:00.000Z`;

let tree: Tree;
beforeAll(async () => {
  tree = await makeTree();
});
afterAll(async () => {
  await rm(tree.root, { recursive: true, force: true });
});

/** Native-rate decoded frames of a file, counted independently of the worker's code path. */
async function frames(src: string, ignoreEditlist = false, untrimmed = false): Promise<number> {
  // the docker ffmpeg sees only the scratch root: copy repo fixtures there first
  const path = src.startsWith(tree.root)
    ? src
    : join(tree.root, `copy-${Math.random().toString(36).slice(2)}`);
  if (path !== src) await copyFile(src, path);
  const head = await readFile(path);
  const demuxer = sniffContainer(head);
  if (!demuxer) throw new Error('fixture not sniffable');
  let bytes = 0;
  let headOut = Buffer.alloc(0);
  const r = await runFfmpeg({
    ffmpegPath: FFMPEG as string,
    args: [
      '-nostdin',
      '-loglevel',
      'error',
      ...(ignoreEditlist ? ['-ignore_editlist', '1'] : []),
      ...(untrimmed ? ['-flags2', '+skip_manual'] : []),
      '-f',
      demuxer,
      '-i',
      `file:${path}`,
      '-map',
      '0:a:0',
      '-ac',
      '1',
      '-c:a',
      'pcm_f32le',
      '-f',
      'wav',
      'pipe:1',
    ],
    onStdout: (c) => {
      if (headOut.length < 512) headOut = Buffer.concat([headOut, c]).subarray(0, 512);
      bytes += c.length;
    },
    timeoutMs: 60_000,
  });
  if (r.code !== 0) throw new Error(`ffmpeg ${r.code}: ${r.stderrTail}`);
  const data = headOut.indexOf('data');
  return (bytes - data - 8) / 4;
}
void decodeArgs;

type Input = { id: string; key: string; start: number; seams?: AudioSeam[] };

async function merge(inputs: Input[], over = {}) {
  await rm(join(tree.blobDir, JOB_DIR), { recursive: true, force: true });
  const rows = inputs.map((i, n) =>
    seg({
      id: i.id,
      r2Key: i.key,
      startedAtUtc: T(i.start),
      ordinal: n + 1,
      endedAtUtc: T(i.start + 1),
    }),
  );
  const seams = inputs.flatMap(
    (i) =>
      i.seams ?? [
        {
          sessionId: 's1',
          recordingOrdinal: 1,
          startedAtUtc: T(i.start),
          endedAtUtc: T(i.start + 1),
          segmentId: i.id,
          offsetMs: 0,
          sourceKey: i.key,
        },
      ],
  );
  return runMerge(
    ctx(tree, fakeReads(rows, seams), { ffmpegPath: FFMPEG as string, ...over }),
    MJOB,
  );
}

function resultOf(out: Awaited<ReturnType<typeof runMerge>>): MediaMergeResult {
  if (out.kind !== 'done') throw new Error(`expected done, got ${JSON.stringify(out)}`);
  return out.result as MediaMergeResult;
}

const fx = (f: string) => join(TRANSCRIPTION_FIXTURES, f);
const ms = (samples: number, rate: number) => Math.round((samples / rate) * 1000);

d('runMerge with ffmpeg', () => {
  it('two Opus WebM chunks → one WebM: untrimmed merged samples = Σ untrimmed inputs exactly; seams at the inputs’ offsets', async () => {
    const a = await tree.copyFixture('seg1.webm', 'm1_a.webm');
    const b = await tree.copyFixture('seg2.webm', 'm1_b.webm');
    const r = resultOf(
      await merge([
        { id: 'a', key: a, start: 0 },
        { id: 'b', key: b, start: 10 },
      ]),
    );
    const rawA = await frames(fx('seg1.webm'));
    const rawB = await frames(fx('seg2.webm'));
    const fullA = await frames(fx('seg1.webm'), false, true);
    const fullB = await frames(fx('seg2.webm'), false, true);
    const pre = opusPreSkip(await readFile(fx('seg2.webm'))) as number;
    expect(pre).toBe(312);
    // the inputs carry end padding (DiscardPadding 648) that packet copy cannot keep, so the
    // design's Σ raw + pre_skip₂ is short by exactly that padding: the untrimmed totals are exact
    expect([rawA, rawB, fullA, fullB]).toEqual([28_800, 19_200, 29_760, 20_160]);
    expect(r.verify).toEqual({ merged_samples: fullA + fullB, expected_samples: fullA + fullB });
    expect(await frames(join(tree.blobDir, r.key), false, true)).toBe(fullA + fullB);
    const played = await frames(join(tree.blobDir, r.key));
    expect(played).toBe(fullA + fullB - pre);
    expect(r.key).toBe(`${JOB_DIR}/merged.webm`);
    expect(r.mime).toBe('audio/webm');
    expect(r.input_ids).toEqual(['a', 'b']);
    expect(r.seams).toEqual([
      { offset_ms: 0, started_at_utc: T(0), ended_at_utc: T(1), source_key: a },
      { offset_ms: ms(fullA, 48_000), started_at_utc: T(10), ended_at_utc: T(11), source_key: b },
    ]);
    expect(r.duration_ms).toBe(ms(played, 48_000));
    expect(r.peaks.length).toBe(4096);
    expect((await stat(join(tree.blobDir, r.key))).mode & 0o777).toBe(0o644);
    expect(await readdir(join(tree.blobDir, JOB_DIR))).toEqual(['merged.webm']);
  });

  it('Ogg + WebM Opus → WebM, exact', async () => {
    const a = await tree.copyFixture('seg5-opus.ogg', 'm2_a.ogg');
    const b = await tree.copyFixture('seg1.webm', 'm2_b.webm');
    const r = resultOf(
      await merge([
        { id: 'a', key: a, start: 0 },
        { id: 'b', key: b, start: 10 },
      ]),
    );
    expect(r.mime).toBe('audio/webm');
    expect(r.verify.merged_samples).toBe(r.verify.expected_samples);
    expect(r.verify.expected_samples).toBe(
      (await frames(fx('seg5-opus.ogg'), false, true)) +
        (await frames(fx('seg1.webm'), false, true)),
    );
    expect(r.seams[1].offset_ms).toBe(ms(await frames(fx('seg5-opus.ogg'), false, true), 48_000));
  });

  it('two AAC m4a → MP4, verified with -ignore_editlist on both sides, exact', async () => {
    const a = await tree.copyFixture('seg-aac.m4a', 'm3_a.m4a');
    const b = await tree.copyFixture('seg-aac2.m4a', 'm3_b.m4a');
    const r = resultOf(
      await merge([
        { id: 'a', key: a, start: 0 },
        { id: 'b', key: b, start: 10 },
      ]),
    );
    expect(r.mime).toBe('audio/mp4');
    const rawA = await frames(fx('seg-aac.m4a'), true, true);
    const rawB = await frames(fx('seg-aac2.m4a'), true, true);
    expect(r.verify).toEqual({ merged_samples: rawA + rawB, expected_samples: rawA + rawB });
    expect(await frames(join(tree.blobDir, r.key), true, true)).toBe(rawA + rawB);
    expect(r.seams.map((s) => s.offset_ms)).toEqual([0, expect.any(Number)]);
    expect(Math.abs(r.seams[1].offset_ms - ms(rawA, 44_100))).toBeLessThanOrEqual(
      ms(2112, 44_100) + 1,
    );
  });

  it('FLAC + FLAC → FLAC, exact', async () => {
    const a = await tree.copyFixture('seg-flac.flac', 'm4_a.flac');
    const b = await tree.copyFixture('seg-flac2.flac', 'm4_b.flac');
    const r = resultOf(
      await merge([
        { id: 'a', key: a, start: 0 },
        { id: 'b', key: b, start: 10 },
      ]),
    );
    expect(r.mime).toBe('audio/flac');
    const rawA = await frames(fx('seg-flac.flac'));
    const rawB = await frames(fx('seg-flac2.flac'));
    expect(r.verify).toEqual({ merged_samples: rawA + rawB, expected_samples: rawA + rawB });
    expect(r.seams[1].offset_ms).toBe(ms(rawA, 48_000));
  });

  it('PCM WAVs → FLAC (merged WAV converted and verified)', async () => {
    const a = await tree.put('m5_a.wav', intWav([wave(16_000, 1, 0.5)], 16_000, 16));
    const b = await tree.put('m5_b.wav', intWav([wave(8_000, 2, 0.5)], 16_000, 16));
    const r = resultOf(
      await merge([
        { id: 'a', key: a, start: 0 },
        { id: 'b', key: b, start: 10 },
      ]),
    );
    expect(r.key).toBe(`${JOB_DIR}/merged.flac`);
    expect(r.mime).toBe('audio/flac');
    expect(r.verify).toEqual({ merged_samples: 24_000, expected_samples: 24_000 });
    expect(parseFlacStreamInfo(await readFile(join(tree.blobDir, r.key)))).toMatchObject({
      sampleRate: 16_000,
      totalSamples: 24_000,
    });
    expect(r.seams[1].offset_ms).toBe(1000);
    expect(r.duration_ms).toBe(1500);
    expect(await readdir(join(tree.blobDir, JOB_DIR))).toEqual(['merged.flac']);
  });

  it('mixed Opus + AAC → mixed-codecs, no output left', async () => {
    const a = await tree.copyFixture('seg1.webm', 'm6_a.webm');
    const b = await tree.copyFixture('seg-aac.m4a', 'm6_b.m4a');
    expect(
      await merge([
        { id: 'a', key: a, start: 0 },
        { id: 'b', key: b, start: 10 },
      ]),
    ).toEqual({
      kind: 'fail',
      error: 'mixed-codecs',
      final: true,
    });
    await expect(stat(join(tree.blobDir, JOB_DIR))).rejects.toThrow();
  });

  it('two groups (stream parameters differ) → mixed-codecs; a skipped input → decode-failed; no output', async () => {
    const a = await tree.copyFixture('seg3.wav', 'm7_a.wav');
    const b = await tree.copyFixture('seg4-pcm-mismatch.wav', 'm7_b.wav');
    expect(
      await merge([
        { id: 'a', key: a, start: 0 },
        { id: 'b', key: b, start: 10 },
      ]),
    ).toMatchObject({
      kind: 'fail',
      error: 'mixed-codecs',
    });
    const c = await tree.copyFixture('seg1.webm', 'm7_c.webm');
    const trunc = (await readFile(fx('seg2.webm'))).subarray(0, 60);
    const t = await tree.put('m7_t.webm', trunc);
    expect(
      await merge([
        { id: 'c', key: c, start: 0 },
        { id: 't', key: t, start: 10 },
      ]),
    ).toMatchObject({
      kind: 'fail',
      error: 'decode-failed',
    });
    await expect(stat(join(tree.blobDir, JOB_DIR))).rejects.toThrow();
  });

  it('a corrupt second chunk → decode-failed', async () => {
    const a = await tree.copyFixture('seg1.webm', 'm8_a.webm');
    const b = await tree.copyFixture('seg-corrupt.bin', 'm8_b.webm');
    expect(
      await merge([
        { id: 'a', key: a, start: 0 },
        { id: 'b', key: b, start: 10 },
      ]),
    ).toMatchObject({
      kind: 'fail',
      error: 'decode-failed',
    });
  });

  it('a merged input with seams plus a later chunk → seams concatenated, shifted by the merged input', async () => {
    const a = await tree.copyFixture('seg1.webm', 'm9_a.webm');
    const b = await tree.copyFixture('seg2.webm', 'm9_b.webm');
    const first = resultOf(
      await merge([
        { id: 'a', key: a, start: 0 },
        { id: 'b', key: b, start: 10 },
      ]),
    );
    const mkey = await tree.put('m9_m.webm', await readFile(join(tree.blobDir, first.key)));
    const c = await tree.copyFixture('seg1.webm', 'm9_c.webm');
    const mSeams: AudioSeam[] = first.seams.map((s) => ({
      sessionId: 's1',
      recordingOrdinal: 1,
      startedAtUtc: s.started_at_utc,
      endedAtUtc: s.ended_at_utc,
      segmentId: 'm',
      offsetMs: s.offset_ms,
      sourceKey: s.source_key,
    }));
    const r = resultOf(
      await merge([
        { id: 'm', key: mkey, start: 0, seams: mSeams },
        { id: 'c', key: c, start: 20 },
      ]),
    );
    expect(r.input_ids).toEqual(['m', 'c']);
    expect(r.verify.merged_samples).toBe(r.verify.expected_samples);
    expect(r.seams.map((s) => s.source_key)).toEqual([a, b, c]);
    expect(r.seams.slice(0, 2)).toEqual(first.seams);
    const fullM = await frames(join(tree.blobDir, mkey), false, true);
    expect(r.seams[2].offset_ms).toBe(ms(fullM, 48_000));
  });

  it('a late chunk between two seams → rebuilt from the originals under .trash/, in wall-clock order', async () => {
    const a = await tree.copyFixture('seg1.webm', 'm10_a.webm');
    const c = await tree.copyFixture('seg2.webm', 'm10_c.webm');
    const first = resultOf(
      await merge([
        { id: 'a', key: a, start: 0 },
        { id: 'c', key: c, start: 20 },
      ]),
    );
    const mkey = await tree.put('m10_m.webm', await readFile(join(tree.blobDir, first.key)));
    // the apply step trashed the originals
    await tree.trashFixture('seg1.webm', a);
    await tree.trashFixture('seg2.webm', c);
    await rm(join(tree.blobDir, a));
    await rm(join(tree.blobDir, c));
    const b = await tree.copyFixture('seg5-opus.ogg', 'm10_b.ogg');
    const mSeams: AudioSeam[] = first.seams.map((s) => ({
      sessionId: 's1',
      recordingOrdinal: 1,
      startedAtUtc: s.started_at_utc,
      endedAtUtc: s.ended_at_utc,
      segmentId: 'm',
      offsetMs: s.offset_ms,
      sourceKey: s.source_key,
    }));
    const r = resultOf(
      await merge([
        { id: 'm', key: mkey, start: 0, seams: mSeams },
        { id: 'b', key: b, start: 10 },
      ]),
    );
    expect(r.seams.map((s) => s.source_key)).toEqual([a, b, c]);
    expect(r.input_ids).toEqual(['m', 'b']);
    expect(r.verify.merged_samples).toBe(r.verify.expected_samples);
    const fullA = await frames(fx('seg1.webm'), false, true);
    const fullB = await frames(fx('seg5-opus.ogg'), false, true);
    expect(r.seams.map((s) => s.offset_ms)).toEqual([
      0,
      ms(fullA, 48_000),
      ms(fullA + fullB, 48_000),
    ]);
    // …and with an original purged: interleaved-input, nothing written
    await rm(join(tree.blobDir, '.trash/2026-10-12', c));
    expect(
      await merge([
        { id: 'm', key: mkey, start: 0, seams: mSeams },
        { id: 'b', key: b, start: 10 },
      ]),
    ).toEqual({ kind: 'fail', error: 'interleaved-input', final: true });
    await expect(stat(join(tree.blobDir, JOB_DIR))).rejects.toThrow();
  });

  it('inputs are never modified and nothing is written outside media/<job>/', async () => {
    const a = await tree.copyFixture('seg1.webm', 'm11_a.webm');
    const b = await tree.copyFixture('seg2.webm', 'm11_b.webm');
    const before = (await readdir(join(tree.blobDir, 'audio/s1'))).sort();
    await merge([
      { id: 'a', key: a, start: 0 },
      { id: 'b', key: b, start: 10 },
    ]);
    expect((await readdir(join(tree.blobDir, 'audio/s1'))).sort()).toEqual(before);
    expect(await readFile(join(tree.blobDir, a))).toEqual(await readFile(fx('seg1.webm')));
    expect(await readdir(join(tree.blobDir, 'media'))).toEqual([MJOB.id]);
    await copyFile(fx('seg1.webm'), join(tree.root, 'unused'));
  });
});
