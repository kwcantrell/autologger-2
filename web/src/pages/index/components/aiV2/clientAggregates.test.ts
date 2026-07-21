// ai-v2-dashboards — unit tests for clientAggregates.ts (task 5.6). Covers
// the one function with NO server counterpart (computeTranscriptExcerpt,
// see that module's header) plus edge cases the pinning test's shared
// fixtures don't specifically target (single-speaker windows, partial
// degeneracy). The mirrored functions' correctness against the server is
// covered by clientAggregates.pinning.test.ts — this file is about THIS
// module's own behavior in isolation.

import { describe, expect, it } from 'vitest';
import { computeTranscriptExcerpt } from './clientAggregates';

function word(speaker: string, w: string, start_sec: number, end_sec: number) {
  return { speaker, word: w, start_sec, end_sec };
}

describe('computeTranscriptExcerpt', () => {
  it('is unavailable, naming the reason, for an empty transcript — never a fabricated quote', () => {
    const result = computeTranscriptExcerpt([]);
    expect(result.available).toBe(false);
    expect(result.reason).toBe('This session has no transcript words yet.');
    expect(result.text).toBe('');
    expect(result.speaker).toBeNull();
    expect(result.timestampSec).toBeNull();
  });

  it('renders the real joined quote, majority speaker, and first timestamp when timing is real', () => {
    const words = [word('0', 'hello', 0, 1), word('0', 'there', 1, 2), word('1', 'hi', 2, 3)];
    const result = computeTranscriptExcerpt(words);
    expect(result.available).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.text).toBe('hello there hi');
    expect(result.speaker).toBe('0'); // majority across the window
    expect(result.timestampSec).toBe(0);
  });

  it('degrades ONLY the timestamp to null when timing is degenerate — text and speaker stay real (D2b partial degradation)', () => {
    const words = [word('1', 'hello', 0, 0), word('1', 'world', 0, 0)];
    const result = computeTranscriptExcerpt(words);
    expect(result.available).toBe(true);
    expect(result.text).toBe('hello world');
    expect(result.speaker).toBe('1');
    expect(result.timestampSec).toBeNull(); // never a fabricated "0:00"
  });

  it('bounds the excerpt to the trailing window rather than the whole transcript', () => {
    const words = Array.from({ length: 100 }, (_, i) => word('0', `w${i}`, i, i + 1));
    const result = computeTranscriptExcerpt(words);
    // Trailing window only — the earliest word ("w0") must not appear.
    expect(result.text.startsWith('w0 ')).toBe(false);
    expect(result.text.endsWith('w99')).toBe(true);
  });
});
