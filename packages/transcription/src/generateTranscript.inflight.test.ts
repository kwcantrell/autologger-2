// The in-flight refusal names the requested session (the only possible holder now that runs are per
// session, run-status-and-sweeper D3) and carries its id, so the route redacts by the session the
// detail actually names (async-session-callers D5).
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

afterEach(() => transcriptGenerationLock.reset());

describe('in-flight refusal', () => {
  it('a same-session run in this process: awaits an async title lookup and carries the session id', async () => {
    expect(transcriptGenerationLock.tryAcquire('mine', 1_700_000_000_000)).toBe(true);
    const err = await generateTranscriptWords(deps(async (id) => `Title of ${id}`)).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TranscriptGenerateError);
    const e = err as TranscriptGenerateError;
    expect(e.code).toBe('in_flight');
    expect(e.message).toContain('Title of mine');
    expect(e.message).toContain('2023-11-14T22:13:20.000Z');
    expect(e.holderSessionId).toBe('mine');
    // The refusal left the running session's own start untouched.
    expect(transcriptGenerationLock.startedAt('mine')).toBe(1_700_000_000_000);
  });

  it('a run of another session does not refuse this one', async () => {
    expect(transcriptGenerationLock.tryAcquire('other', 1_700_000_000_000)).toBe(true);
    // Past the run check, the stub hub has no lease methods: the run proceeds to the lease claim.
    const err = await generateTranscriptWords(deps(async (id) => `Title of ${id}`)).catch(
      (e: unknown) => e,
    );
    expect(err).not.toBeInstanceOf(TranscriptGenerateError);
    expect(transcriptGenerationLock.startedAt('other')).toBe(1_700_000_000_000);
    expect(transcriptGenerationLock.startedAt('mine')).toBeNull();
  });
});
