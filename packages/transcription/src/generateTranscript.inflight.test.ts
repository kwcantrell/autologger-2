// The in-flight refusal names one holder and carries that holder's id, so the route redacts by the
// holder the detail actually names (async-session-callers D5).
import type { Config } from '@autologger/ports';
import { afterEach, describe, expect, it } from 'vitest';
import { generateTranscriptWords, TranscriptGenerateError } from './generateTranscript';
import { transcriptGenerationLock } from './transcriptGenerationLock';

const deps = (resolveSessionTitle: (id: string) => Promise<string | null>) =>
  ({
    config: { DEEPGRAM_API_KEY: 'k' } as unknown as Config,
    audio: {} as never,
    getHub: async () => ({}) as never,
    ctx: { frameRate: 24, startOffsetFrames: 0 },
    sessionId: 'mine',
    resolveSessionTitle,
  }) as Parameters<typeof generateTranscriptWords>[0];

afterEach(() => transcriptGenerationLock.release());

describe('in-flight refusal', () => {
  it('awaits an async title lookup and carries the named holder id', async () => {
    expect(transcriptGenerationLock.tryAcquire('holder-a', 1_700_000_000_000)).toBe(true);
    const err = await generateTranscriptWords(deps(async (id) => `Title of ${id}`)).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TranscriptGenerateError);
    const e = err as TranscriptGenerateError;
    expect(e.code).toBe('in_flight');
    expect(e.message).toContain('Title of holder-a');
    expect(e.holderSessionId).toBe('holder-a');
  });
});
