// byo-ai-providers D3 (provider-credentials "Work runs on its user's credentials"): the caller
// resolves the speech-to-text credential and passes it in. With none, generation is unavailable,
// with the Settings → Advanced detail, before any run, lock or provider request.
import { afterEach, describe, expect, it } from 'vitest';
import {
  generateTranscriptWords,
  TRANSCRIPT_NEEDS_KEY,
  TranscriptGenerateError,
} from './generateTranscript';
import { transcriptGenerationLock } from './transcriptGenerationLock';

afterEach(() => transcriptGenerationLock.reset());

describe('generateTranscriptWords without a speech-to-text credential', () => {
  it('throws unavailable with the Settings → Advanced detail, taking no lock and calling nothing', async () => {
    let hubCalls = 0;
    const err = await generateTranscriptWords({
      stt: null,
      audio: {} as never,
      getHub: async () => {
        hubCalls++;
        return {} as never;
      },
      ctx: { frameRate: 24, startOffsetFrames: 0 },
      sessionId: 's1',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TranscriptGenerateError);
    expect((err as TranscriptGenerateError).code).toBe('unavailable');
    expect((err as Error).message).toBe(TRANSCRIPT_NEEDS_KEY);
    expect(TRANSCRIPT_NEEDS_KEY).toBe(
      'Add a speech-to-text key in Settings → Advanced to generate transcripts.',
    );
    expect(transcriptGenerationLock.startedAt('s1')).toBeNull();
    expect(hubCalls).toBe(0);
  });
});
