// The anchors read, the remap and the replace are one hub transaction (async-session-hub design
// D7, S9): the zero-word guard's `no_speech` throws from inside the remap, so the replace rolls
// back and the existing transcript stays as it was. The provider and the audio merge are mocked;
// the hub is real. Moved from @autologger/transcription (session-tables D12): the integration
// setup file loads the app, and with it the modules under test, before this file's mocks
// register, so they are imported afresh after them (`vi.resetModules`).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BlobStore, Config } from '@autologger/ports';
import { SessionHub } from '@autologger/session-core';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionRow, testStorage } from './sessionRows';

type GenerateModule = typeof import('@autologger/transcription/generateTranscript');
type LockModule = typeof import('@autologger/transcription/transcriptGenerationLock');
let generateTranscriptWords: GenerateModule['generateTranscriptWords'];
let NO_SPEECH_DETAIL: GenerateModule['NO_SPEECH_DETAIL'];
let transcriptGenerationLock: LockModule['transcriptGenerationLock'];
beforeAll(async () => {
  vi.resetModules();
  ({ generateTranscriptWords, NO_SPEECH_DETAIL } = await import(
    '@autologger/transcription/generateTranscript'
  ));
  ({ transcriptGenerationLock } = await import(
    '@autologger/transcription/transcriptGenerationLock'
  ));
});

vi.mock('@autologger/transcription/audioMerge', () => ({
  mergeAudioSegments: vi.fn(async (paths: string[], scratch: string) => ({
    groups: [
      {
        family: 'opus',
        outPath: join(scratch, 'group-0.webm'),
        packets: 1,
        durationSeconds: 5,
        segments: paths.map((path) => ({ path, offsetSeconds: 0, durationSeconds: 5 })),
      },
    ],
    skipped: [],
  })),
}));
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  stat: vi.fn(async () => ({ size: 1 })),
}));
vi.mock('@autologger/transcription/deepgram', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@autologger/transcription/deepgram')>()),
  transcribeGroup: vi.fn(async () => ({ words: [], paragraphs: [], sentiments: [] })),
}));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'autologger-transcribe-'));
});
afterEach(() => {
  transcriptGenerationLock.release();
  rmSync(dir, { recursive: true, force: true });
});

describe('generateTranscriptWords remaps inside the replace transaction', () => {
  it('a no_speech result writes nothing and leaves the existing transcript unchanged', async () => {
    const hub = await SessionHub.open(await createSessionRow('s1'), testStorage('s1'));
    await hub.insertTranscriptWord({ session_time: '00:00:01:00', speaker: '0', word: 'kept' });
    await hub.addAudioSegment({
      sessionId: 's1',
      mimeType: 'audio/webm',
      startedAtUtc: '2026-10-03T00:00:00.000Z',
      endedAtUtc: '2026-10-03T00:00:05.000Z',
      recordingOrdinal: 1,
    });
    const before = await hub.listTranscriptWords();
    const audio = {
      scratchRoot: () => dir,
      resolveKeyPath: (key: string) => join(dir, key),
    } as unknown as BlobStore;

    const err = await generateTranscriptWords({
      config: { DEEPGRAM_API_KEY: 'k' } as unknown as Config,
      audio,
      getHub: async () => hub,
      ctx: { frameRate: 24, startOffsetFrames: 0 },
      sessionId: 's1',
    }).catch((e: unknown) => e);

    expect(err).toMatchObject({ code: 'no_speech', message: NO_SPEECH_DETAIL });
    expect(await hub.listTranscriptWords()).toEqual(before);
    expect(await hub.listTranscriptEnrichment()).toEqual({ paragraphs: [], sentiment: [] });
    expect(transcriptGenerationLock.getLock()).toBeNull();
    await hub.close();
  });
});
