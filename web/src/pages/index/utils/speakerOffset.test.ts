import { describe, expect, it } from 'vitest';
import type { TranscriptWord } from '../../../api/types';
import { formatSpeaker, parseSpeaker, speakerOffsetFromWords } from './speakerOffset';

function word(speaker: string): TranscriptWord {
  return {
    id: `w-${speaker}-${Math.random().toString(36).slice(2, 8)}`,
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

// `formatSpeaker` moved here from `transcriptCsv.ts` (it was duplicated
// verbatim in TranscribeRow.tsx) so that it and its new `parseSpeaker` inverse
// are defined once, next to the offset they both consume.
describe('formatSpeaker', () => {
  it('shifts numeric speaker ids by the feed offset', () => {
    expect(formatSpeaker('0', 1)).toBe('Person 1');
    expect(formatSpeaker('2', 0)).toBe('Person 2');
  });

  it('leaves non-numeric speakers unchanged', () => {
    expect(formatSpeaker('Host', 1)).toBe('Host');
  });
});

// --- parseSpeaker: the display -> raw inverse (speaker-display-space fix) ---
//
// The speaker cell is the only inline control whose rendered text differs from
// its stored value, and its blur handler used to feed the DISPLAY string
// straight into TranscribeRow's same-value guard and PATCH body. `'Person 1'`
// never equals the stored `'0'`, so a bare focus+blur overwrote a numeric
// diarization id with a label — after which the row stopped tracking
// `speakerOffset` and diverged from its siblings.
describe('parseSpeaker', () => {
  it('is the exact inverse of formatSpeaker for numeric ids', () => {
    for (const offset of [0, 1]) {
      for (const raw of ['0', '1', '2', '17']) {
        expect(parseSpeaker(formatSpeaker(raw, offset), offset)).toBe(raw);
      }
    }
  });

  it('maps a display label back through the offset', () => {
    expect(parseSpeaker('Person 1', 1)).toBe('0');
    expect(parseSpeaker('Person 3', 1)).toBe('2');
    expect(parseSpeaker('Person 3', 0)).toBe('3');
  });

  it('leaves a genuinely custom label alone', () => {
    expect(parseSpeaker('Ari', 1)).toBe('Ari');
    expect(parseSpeaker('', 1)).toBe('');
    expect(parseSpeaker('Host', 0)).toBe('Host');
  });

  it('treats near-misses of the generated shape as custom labels', () => {
    // Only the EXACT `Person <integer>` string formatSpeaker synthesises is a
    // label; everything else is text the operator meant literally.
    expect(parseSpeaker('person 1', 1)).toBe('person 1');
    expect(parseSpeaker('Person one', 1)).toBe('Person one');
    expect(parseSpeaker('Person 1 ', 1)).toBe('Person 1 ');
    expect(parseSpeaker(' Person 1', 1)).toBe(' Person 1');
    expect(parseSpeaker('Person  1', 1)).toBe('Person  1');
    expect(parseSpeaker('Person 1.5', 1)).toBe('Person 1.5');
    expect(parseSpeaker('Speaker 1', 1)).toBe('Speaker 1');
    expect(parseSpeaker('Person', 1)).toBe('Person');
  });

  it('round-trips a mid-typing digit append without mangling the display', () => {
    // "Person 1" + "0" typed at the caret -> "Person 10": the parsed raw id
    // must re-render as exactly what the operator sees, or the caret jumps.
    const raw = parseSpeaker('Person 10', 1);
    expect(raw).toBe('9');
    expect(formatSpeaker(raw, 1)).toBe('Person 10');
  });

  it('heals an already-corrupted row back to a raw id', () => {
    // Rows PATCHed by the old bug hold the literal display string; focusing and
    // blurring one now converts it back, invisibly (it renders identically).
    expect(parseSpeaker(formatSpeaker('Person 1', 1), 1)).toBe('0');
  });
});
