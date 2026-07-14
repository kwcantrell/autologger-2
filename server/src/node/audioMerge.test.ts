// Unit tests for the mediabunny packet-copy merge. Fixtures are tiny
// ffmpeg-generated files committed under src/test/fixtures/audio/: two
// WebM/Opus segments (0.6s + 0.4s) and one WAV/PCM used for the
// codec-mismatch case.

import { ALL_FORMATS, FilePathSource, Input } from 'mediabunny';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mergeAudioFiles } from './audioMerge';

const fixtures = join(import.meta.dirname, '..', 'test', 'fixtures', 'audio');
const seg1 = join(fixtures, 'seg1.webm');
const seg2 = join(fixtures, 'seg2.webm');
const wav = join(fixtures, 'seg3.wav');

let outDir: string;
beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'audio-merge-'));
});
afterAll(async () => {
  await rm(outDir, { recursive: true, force: true });
});

async function readBack(path: string) {
  const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(path) });
  try {
    const track = await input.getPrimaryAudioTrack();
    expect(track).not.toBeNull();
    const duration = await track!.computeDuration();
    let packets = 0;
    const { EncodedPacketSink } = await import('mediabunny');
    const sink = new EncodedPacketSink(track!);
    for await (const _ of sink.packets()) packets += 1;
    return { codec: track!.codec, duration, packets };
  } finally {
    input.dispose();
  }
}

describe('mergeAudioFiles', () => {
  it('concatenates two opus segments losslessly, back-to-back', async () => {
    const out = join(outDir, 'merged.webm');
    const result = await mergeAudioFiles([seg1, seg2], out);

    const [a, b, merged] = await Promise.all([readBack(seg1), readBack(seg2), readBack(out)]);
    expect(merged.codec).toBe('opus');
    expect(result.packets).toBe(a.packets + b.packets);
    expect(merged.packets).toBe(a.packets + b.packets);
    // Back-to-back: merged duration ≈ sum of inputs (one packet ~20ms tolerance).
    expect(merged.duration).toBeGreaterThan(a.duration + b.duration - 0.05);
    expect(merged.duration).toBeLessThan(a.duration + b.duration + 0.05);
    expect(result.durationSeconds).toBeCloseTo(merged.duration, 1);
  });

  it('remuxes a single segment', async () => {
    const out = join(outDir, 'single.webm');
    const result = await mergeAudioFiles([seg1], out);
    const [orig, merged] = await Promise.all([readBack(seg1), readBack(out)]);
    expect(result.files).toBe(1);
    expect(merged.packets).toBe(orig.packets);
    expect(merged.duration).toBeCloseTo(orig.duration, 1);
  });

  it('rejects mixed codecs instead of producing a broken file', async () => {
    const out = join(outDir, 'mixed.webm');
    await expect(mergeAudioFiles([seg1, wav], out)).rejects.toThrow(/codec mismatch/);
  });

  it('rejects an empty input list', async () => {
    await expect(mergeAudioFiles([], join(outDir, 'empty.webm'))).rejects.toThrow(/No input/);
  });
});
