// Unit tests for the mediabunny packet-copy concat pipeline. Fixtures are
// tiny ffmpeg-generated files committed under src/test/fixtures/audio/:
//
//   seg1.webm / seg2.webm   — Opus/WebM, 48kHz mono (0.6s + 0.4s)
//   seg5-opus.ogg           — Opus/Ogg,  48kHz mono (0.5s) — same params as
//                             seg1/seg2, proving webm+ogg land in one group
//   seg3.wav                — PCM/WAVE,  16kHz mono
//   seg4-pcm-mismatch.wav   — PCM/WAVE,  44.1kHz stereo — deliberately
//                             different params from seg3.wav, for the
//                             param-mismatch sub-grouping test
//   seg-aac.m4a / seg-aac2.m4a — AAC/fragmented-MP4, 44.1kHz mono, emulating
//                             Safari MediaRecorder output (ffmpeg -movflags
//                             frag_keyframe+empty_moov+default_base_moof)
//   seg-corrupt.bin         — 256 random bytes, no valid container at all

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALL_FORMATS, FilePathSource, Input } from 'mediabunny';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mergeAudioSegments } from './audioMerge';

const fixtures = join(import.meta.dirname, '..', 'test', 'fixtures', 'audio');
const seg1 = join(fixtures, 'seg1.webm');
const seg2 = join(fixtures, 'seg2.webm');
const segOgg = join(fixtures, 'seg5-opus.ogg');
const wav = join(fixtures, 'seg3.wav');
const wavMismatch = join(fixtures, 'seg4-pcm-mismatch.wav');
const aac1 = join(fixtures, 'seg-aac.m4a');
const aac2 = join(fixtures, 'seg-aac2.m4a');
const mp3 = join(fixtures, 'deepgram-enrichment-source.mp3');
const corrupt = join(fixtures, 'seg-corrupt.bin');

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
    if (track === null) throw new Error(`no primary audio track in '${path}'`);
    const duration = await track.computeDuration();
    let packets = 0;
    const { EncodedPacketSink } = await import('mediabunny');
    const sink = new EncodedPacketSink(track);
    for await (const _ of sink.packets()) packets += 1;
    return { codec: track.codec, duration, packets };
  } finally {
    input.dispose();
  }
}

describe('mergeAudioSegments', () => {
  it('groups homogeneous Opus segments (webm+ogg) into one group, back-to-back', async () => {
    const groupOutDir = join(outDir, 'homogeneous-opus');
    const { groups, skipped } = await mergeAudioSegments([seg1, seg2, segOgg], groupOutDir);

    expect(skipped).toEqual([]);
    expect(groups).toHaveLength(1);
    const [group] = groups;
    expect(group.family).toBe('opus');

    const [a, b, c, merged] = await Promise.all([
      readBack(seg1),
      readBack(seg2),
      readBack(segOgg),
      readBack(group.outPath),
    ]);
    expect(merged.codec).toBe('opus');
    expect(group.packets).toBe(a.packets + b.packets + c.packets);
    expect(merged.packets).toBe(a.packets + b.packets + c.packets);

    // Per-segment cumulative offsets, in input order.
    expect(group.segments).toHaveLength(3);
    expect(group.segments[0].path).toBe(seg1);
    expect(group.segments[0].offsetSeconds).toBeCloseTo(0, 1);
    expect(group.segments[1].path).toBe(seg2);
    expect(group.segments[1].offsetSeconds).toBeCloseTo(a.duration, 1);
    expect(group.segments[2].path).toBe(segOgg);
    expect(group.segments[2].offsetSeconds).toBeCloseTo(a.duration + b.duration, 1);

    expect(group.durationSeconds).toBeCloseTo(a.duration + b.duration + c.duration, 1);
  });

  it('remuxes a single segment into its own group', async () => {
    const groupOutDir = join(outDir, 'single');
    const { groups } = await mergeAudioSegments([seg1], groupOutDir);
    expect(groups).toHaveLength(1);
    const [orig, merged] = await Promise.all([readBack(seg1), readBack(groups[0].outPath)]);
    expect(groups[0].segments).toEqual([
      { path: seg1, offsetSeconds: 0, durationSeconds: expect.closeTo(orig.duration, 1) },
    ]);
    expect(merged.packets).toBe(orig.packets);
  });

  it('skips an unreadable/corrupt segment and still merges the readable ones', async () => {
    const groupOutDir = join(outDir, 'skip-corrupt');
    const { groups, skipped } = await mergeAudioSegments([seg1, corrupt, seg2], groupOutDir);

    expect(skipped).toHaveLength(1);
    expect(skipped[0].path).toBe(corrupt);
    expect(skipped[0].reason).toBeTruthy();

    expect(groups).toHaveLength(1);
    expect(groups[0].segments.map((s) => s.path)).toEqual([seg1, seg2]);
  });

  it('sub-groups PCM segments on stream-parameter mismatch instead of failing', async () => {
    const groupOutDir = join(outDir, 'pcm-mismatch');
    const { groups, skipped } = await mergeAudioSegments([wav, wavMismatch], groupOutDir);

    expect(skipped).toEqual([]);
    expect(groups).toHaveLength(2);
    expect(groups[0].family).toBe('pcm');
    expect(groups[1].family).toBe('pcm');
    expect(groups[0].segments.map((s) => s.path)).toEqual([wav]);
    expect(groups[1].segments.map((s) => s.path)).toEqual([wavMismatch]);
    // Each sub-group's own offsets restart at 0 — they are independent output files.
    expect(groups[0].segments[0].offsetSeconds).toBe(0);
    expect(groups[1].segments[0].offsetSeconds).toBe(0);
  });

  it('writes an AAC group into an MP4 container on the same packet loop', async () => {
    const groupOutDir = join(outDir, 'aac-mp4');
    const { groups, skipped } = await mergeAudioSegments([aac1, aac2], groupOutDir);

    expect(skipped).toEqual([]);
    expect(groups).toHaveLength(1);
    const [group] = groups;
    expect(group.family).toBe('aac');
    expect(group.outPath.endsWith('.mp4')).toBe(true);

    const [a, b, merged] = await Promise.all([
      readBack(aac1),
      readBack(aac2),
      readBack(group.outPath),
    ]);
    expect(merged.codec).toBe('aac');
    expect(group.packets).toBe(a.packets + b.packets);
    expect(merged.packets).toBe(a.packets + b.packets);
    expect(group.segments[1].offsetSeconds).toBeCloseTo(a.duration, 1);
    expect(group.durationSeconds).toBeCloseTo(a.duration + b.duration, 1);
  });

  it('writes a PCM group into a WAVE container', async () => {
    const groupOutDir = join(outDir, 'pcm-wav');
    const { groups } = await mergeAudioSegments([wav], groupOutDir);
    expect(groups).toHaveLength(1);
    expect(groups[0].family).toBe('pcm');
    expect(groups[0].outPath.endsWith('.wav')).toBe(true);
    const merged = await readBack(groups[0].outPath);
    expect(merged.codec).toBe('pcm-s16');
  });

  it('produces one group per codec family for a mixed-codec input list', async () => {
    const groupOutDir = join(outDir, 'mixed-codec');
    const { groups, skipped } = await mergeAudioSegments([seg1, seg2, aac1, wav], groupOutDir);

    expect(skipped).toEqual([]);
    expect(groups).toHaveLength(3);
    const families = groups.map((g) => g.family);
    expect(families).toEqual(['opus', 'aac', 'pcm']);
    const exts = groups.map((g) => g.outPath.split('.').pop());
    expect(exts).toEqual(['webm', 'mp4', 'wav']);
  });

  it('returns no groups and no skips for an empty input list', async () => {
    const groupOutDir = join(outDir, 'empty');
    const { groups, skipped } = await mergeAudioSegments([], groupOutDir);
    expect(groups).toEqual([]);
    expect(skipped).toEqual([]);
  });

  it('passes through MP3 segments as one group per file (no remux)', async () => {
    const groupOutDir = join(outDir, 'mp3-passthrough');
    const { groups, skipped } = await mergeAudioSegments([mp3, mp3], groupOutDir);

    expect(skipped).toEqual([]);
    expect(groups).toHaveLength(2);
    expect(groups[0].family).toBe('mp3');
    expect(groups[1].family).toBe('mp3');
    expect(groups[0].outPath).toBe(mp3);
    expect(groups[1].outPath).toBe(mp3);
    expect(groups[0].durationSeconds).toBeGreaterThan(0);
    expect(groups[0].segments).toEqual([
      { path: mp3, offsetSeconds: 0, durationSeconds: groups[0].durationSeconds },
    ]);
  });
});
