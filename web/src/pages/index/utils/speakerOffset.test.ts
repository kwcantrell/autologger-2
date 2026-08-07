import { describe, expect, it } from 'vitest';
import type { TranscriptWord } from '../../../api/types';
import { speakerOffsetFromWords } from './speakerOffset';

function word(speaker: string): TranscriptWord {
  return {
    id: `w-${speaker}-${Math.random().toString(36).slice(2, 8)}`,
    session_id: 'sess-1',
    session_time: '00:00:01:00',
    speaker,
    word: 'hello',
    ordinal: 1,
  } as TranscriptWord;
}

describe('speakerOffsetFromWords', () => {
  it('returns 0 for undefined or empty transcripts', () => {
    expect(speakerOffsetFromWords(undefined)).toBe(0);
    expect(speakerOffsetFromWords([])).toBe(0);
  });

  it('returns 1 when a 0-based speaker exists (DeepGram numbering)', () => {
    expect(speakerOffsetFromWords([word('0'), word('1')])).toBe(1);
  });

  it('returns 0 when speakers already start at 1 (hand-entered numbering)', () => {
    expect(speakerOffsetFromWords([word('1'), word('2')])).toBe(0);
  });

  it('returns 0 when no speaker parses as a number', () => {
    expect(speakerOffsetFromWords([word('Host'), word('Guest')])).toBe(0);
  });
});
