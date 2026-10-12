// media-worker D.4 (design D9, transcript-generation "Segment grouping and concatenation" and
// "Timeline remapping of word timestamps"): `seams` are threaded from the segment metadata into the
// remap, a listed segment whose blob is missing fails the run (502, naming the segment) instead of
// being skipped, and an unparseable blob is still skipped.
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AudioSegmentMeta, RemappedTranscript } from '@autologger/session-core';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { transcribeGroup } from './deepgram';
import { TRANSCRIPTION_FIXTURES_DIR } from './fixturesDir';
import {
  generateTranscriptWords,
  MISSING_BLOB_DETAIL_PREFIX,
  TranscriptGenerateError,
} from './generateTranscript';
import { transcriptGenerationLock } from './transcriptGenerationLock';

vi.mock('./deepgram', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./deepgram')>();
  return { ...actual, transcribeGroup: vi.fn() };
});
const mockedTranscribe = vi.mocked(transcribeGroup);

const W0 = '2026-10-12T10:00:00.000Z';
const at = (sec: number) => new Date(Date.parse(W0) + sec * 1000).toISOString();

let blobDir: string;
beforeAll(async () => {
  blobDir = await mkdtemp(join(tmpdir(), 'gen-transcript-'));
  const audio = join(TRANSCRIPTION_FIXTURES_DIR, 'audio');
  await copyFile(join(audio, 'seg1.webm'), join(blobDir, 'merged.webm'));
  await copyFile(join(audio, 'seg-corrupt.bin'), join(blobDir, 'corrupt.webm'));
});
afterAll(async () => {
  await rm(blobDir, { recursive: true, force: true });
});
afterEach(() => {
  transcriptGenerationLock.reset();
  mockedTranscribe.mockReset();
});

type SegmentWithSeams = AudioSegmentMeta & {
  seams?: { offset_ms: number; started_at_utc: string; ended_at_utc: string | null }[] | null;
};

function meta(id: string, ordinal: number, r2Key: string, extra: Partial<SegmentWithSeams> = {}) {
  return {
    id,
    ordinal,
    started_at_utc: at(0),
    ended_at_utc: null,
    mime_type: 'audio/webm',
    r2_key: r2Key,
    recording_ordinal: 1,
    waveform_peaks: null,
    waveform_db_floor: null,
    ...extra,
  } as SegmentWithSeams;
}

function run(segments: SegmentWithSeams[]) {
  const replaced: RemappedTranscript[] = [];
  const hub = {
    claimRunLease: async () => true,
    releaseRunLease: async () => true,
    runLeaseStartedAt: async () => null,
    listAudioSegments: async () => segments,
    replaceTranscriptWordsRemapped: async (
      remap: (events: unknown[]) => RemappedTranscript,
    ): Promise<unknown[]> => {
      const out = remap([
        {
          category: 'internal',
          message: 'Recording 1 Started',
          timecode_total_frames: 2400,
          frame_rate: 24,
          wall_time_utc: W0,
        },
      ]);
      replaced.push(out);
      return out.words;
    },
  };
  const promise = generateTranscriptWords({
    stt: { apiKey: 'k', model: 'nova-3' },
    audio: {
      scratchRoot: () => blobDir,
      resolveKeyPath: (key: string) => join(blobDir, key),
    } as never,
    getHub: async () => hub as never,
    ctx: { frameRate: 24, startOffsetFrames: 0 },
    sessionId: 's1',
  });
  return { promise, replaced };
}

describe('generateTranscriptWords and the media worker', () => {
  it('threads seams from the segment metadata into the remap', async () => {
    // seg1.webm is 0.6 s; its two seams sit at 0 and 0.3 s, the second chunk started 0.35 s
    // after the first in wall-clock time (a 50 ms rollover gap).
    mockedTranscribe.mockResolvedValue({
      words: [
        { word: 'a', start: 0.1, end: 0.2, speaker: 0 },
        { word: 'b', start: 0.4, end: 0.5, speaker: 0 },
      ],
      paragraphs: [],
      sentiments: [],
    } as never);
    const { promise, replaced } = run([
      meta('m', 0, 'merged.webm', {
        seams: [
          { offset_ms: 0, started_at_utc: at(0), ended_at_utc: at(0.3) },
          { offset_ms: 300, started_at_utc: at(0.35), ended_at_utc: at(0.65) },
        ],
      }),
    ]);
    await promise;
    const words = replaced[0].words;
    expect(words.map((w) => w.word)).toEqual(['a', 'b']);
    expect(words[0].start_sec).toBeCloseTo(100.1, 6);
    // Seam 2's anchor is 100 + 0.35, plus 0.1 s inside the seam.
    expect(words[1].start_sec).toBeCloseTo(100.45, 6);
  });

  it('fails with a 502-class error naming a listed segment whose blob is missing', async () => {
    const { promise, replaced } = run([
      meta('present', 0, 'merged.webm'),
      meta('gone-segment', 1, 'not-there.webm'),
    ]);
    const err = await promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TranscriptGenerateError);
    const e = err as TranscriptGenerateError;
    expect(e.code).toBe('missing_blob');
    expect(e.message.startsWith(MISSING_BLOB_DETAIL_PREFIX)).toBe(true);
    expect(e.message).toContain('gone-segment');
    expect(mockedTranscribe).not.toHaveBeenCalled();
    expect(replaced).toEqual([]);
  });

  it('still skips an unparseable blob and transcribes the rest', async () => {
    mockedTranscribe.mockResolvedValue({
      words: [{ word: 'a', start: 0.1, end: 0.2, speaker: 0 }],
      paragraphs: [],
      sentiments: [],
    } as never);
    const { promise, replaced } = run([
      meta('present', 0, 'merged.webm'),
      meta('corrupt', 1, 'corrupt.webm', { started_at_utc: at(1) }),
    ]);
    await promise;
    expect(mockedTranscribe).toHaveBeenCalledTimes(1);
    expect(replaced[0].words.map((w) => w.word)).toEqual(['a']);
  });
});
