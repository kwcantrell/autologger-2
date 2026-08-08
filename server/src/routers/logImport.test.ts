// Characterization test for `ensureTimedTranscript`'s retry-once-on-upstream
// path (feature-service-packages task 1.1). This function had no prior direct
// test — routers/logImport.int.test.ts exercises it only incidentally and
// never drives the retry branch. Pinned before D2 relocated the function
// body verbatim from `logImport/runSessionLogImport.ts` into this router
// (task 5.1), so the move was verified to change nothing; this file moved
// alongside it, unchanged except for the import path below. Fake timers
// stand in for the real 2000ms retry pause so this file adds no real
// elapsed time to the unit tier.

import type { Config } from '@autologger/ports';
import type { SessionHubFacade, TimecodeCtx, TranscriptWord } from '@autologger/session-core';
import { generateTranscriptWords, TranscriptGenerateError } from '@autologger/transcription';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureTimedTranscript } from './logImport';

vi.mock('@autologger/transcription', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@autologger/transcription')>();
  return { ...actual, generateTranscriptWords: vi.fn() };
});
const generateTranscriptWordsMock = vi.mocked(generateTranscriptWords);

function makeWord(word: string, startSec: number): TranscriptWord {
  return {
    id: `w-${word}-${startSec}`,
    session_time: '00:00:00:00',
    speaker: '',
    word,
    start_sec: startSec,
    end_sec: startSec + 0.3,
    ordinal: 0,
    created_at_utc: '2026-08-07T00:00:00Z',
  };
}

/** Minimal hub stub: `ensureTimedTranscript` only ever calls
 * `listTranscriptWords()` directly (via `timedTranscriptTokens`); every other
 * collaborator lives behind the mocked `generateTranscriptWords`. Each call
 * returns the next entry in `sequence`, holding the last once exhausted. */
function makeHub(sequence: TranscriptWord[][]): SessionHubFacade {
  let call = 0;
  const listTranscriptWords = vi.fn(() => {
    const words = sequence[Math.min(call, sequence.length - 1)] ?? [];
    call += 1;
    return words;
  });
  return { listTranscriptWords } as unknown as SessionHubFacade;
}

const ctx: TimecodeCtx = { frameRate: 30, startOffsetFrames: 0 };
const config = {} as Config;
const audio = {} as Parameters<typeof ensureTimedTranscript>[0]['audio'];

function baseInput(hub: SessionHubFacade, onProgress: (line: string) => void) {
  return {
    sessionId: 'sess-1',
    getHub: () => hub,
    config,
    audio,
    ctx,
    onProgress,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  generateTranscriptWordsMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ensureTimedTranscript retry path', () => {
  it('retries once after an upstream TranscriptGenerateError and returns the fresh tokens', async () => {
    const freshWords = [makeWord('hello', 1.5), makeWord('world', 2.1)];
    const hub = makeHub([[], freshWords]);
    const lines: string[] = [];

    generateTranscriptWordsMock
      .mockRejectedValueOnce(new TranscriptGenerateError('upstream', 'DeepGram timed out'))
      // The resolved value itself is unused by ensureTimedTranscript except for
      // its .length in an error path this scenario never reaches — the hub
      // stub's second entry supplies the actual returned tokens.
      .mockResolvedValueOnce([makeWord('hello', 1.5)]);

    const promise = ensureTimedTranscript(baseInput(hub, (line) => lines.push(line)));
    // Flush the 2000ms retry pause without any real elapsed time.
    await vi.advanceTimersByTimeAsync(2000);
    const tokens = await promise;

    expect(tokens).toEqual([
      { word: 'hello', startSec: 1.5 },
      { word: 'world', startSec: 2.1 },
    ]);
    expect(generateTranscriptWordsMock).toHaveBeenCalledTimes(2);
    expect(lines).toEqual([
      'Generating transcript (DeepGram)…',
      'Transcript generation failed (DeepGram timed out); retrying once…',
      'Transcript ready after retry (2 timed words).',
    ]);
  });

  it('treats an in_flight TranscriptGenerateError as retryable, wrapping the retry failure', async () => {
    const hub = makeHub([[]]);
    const lines: string[] = [];

    generateTranscriptWordsMock
      .mockRejectedValueOnce(new TranscriptGenerateError('in_flight', 'slot already held'))
      .mockRejectedValueOnce(new TranscriptGenerateError('in_flight', 'slot already held'));

    const promise = ensureTimedTranscript(baseInput(hub, (line) => lines.push(line)));
    // Attach the rejection expectation before advancing timers so the promise
    // is never observably unhandled between creation and assertion.
    const assertion = expect(promise).rejects.toThrow(
      'Transcript generation failed: slot already held',
    );
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
    // The retry attempt actually ran (not merely the first).
    expect(generateTranscriptWordsMock).toHaveBeenCalledTimes(2);
    expect(lines).toEqual([
      'Generating transcript (DeepGram)…',
      'Transcript generation failed (slot already held); retrying once…',
    ]);
  });

  it('propagates a non-TranscriptGenerateError unwrapped, with no retry', async () => {
    const hub = makeHub([[]]);
    const lines: string[] = [];
    const original = new Error('unrelated disk failure');

    generateTranscriptWordsMock.mockRejectedValueOnce(original);

    const promise = ensureTimedTranscript(baseInput(hub, (line) => lines.push(line)));

    await expect(promise).rejects.toBe(original);
    expect(generateTranscriptWordsMock).toHaveBeenCalledTimes(1);
    expect(lines).toEqual(['Generating transcript (DeepGram)…']);
  });
});
