import { describe, expect, it } from 'vitest';
import {
  findAlignmentCandidates,
  isSolid,
  syncLogRowsToSeams,
  type TranscriptToken,
} from './syncScore';

describe('findAlignmentCandidates HD_385 helicopter', () => {
  it('scores five exact consecutive words as solid', () => {
    const tx: TranscriptToken[] = [
      { word: 'almost', startSec: 8 * 60 + 47 },
      { word: 'called', startSec: 8 * 60 + 47.3 },
      { word: 'a', startSec: 8 * 60 + 47.5 },
      { word: 'helicopter,', startSec: 8 * 60 + 47.7 },
      { word: 'but', startSec: 8 * 60 + 48.5 },
      { word: 'just', startSec: 8 * 60 + 49 },
    ];
    const cands = findAlignmentCandidates(
      'almost called a helicopter but just crawled for hours instead',
      8 * 60 + 48,
      tx,
    );
    const top = cands[0];
    if (!top) throw new Error('expected at least one candidate');
    expect(top.score).toBeGreaterThanOrEqual(4.5);
    expect(isSolid(top)).toBe(true);
    expect(Math.round(top.offsetSec)).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// Multi-part scenarios (pr-3-review test-gap wave). Two 600 s parts throughout.
//
// Transcript layout: session time 0–600 is part 0's audio, 600–1200 part 1's.
// Words are consecutive so `findAlignmentCandidates` scores exact runs:
// 5 exact tokens → 5.0 (solid, ≥4.5); 3 exact tokens → 3.0 (decent, ≥2.5).
// ---------------------------------------------------------------------------

/** Consecutive transcript tokens for `words`, 0.3 s apart from `startSec`. */
function tokensAt(startSec: number, words: string[]): TranscriptToken[] {
  return words.map((word, i) => ({ word, startSec: startSec + i * 0.3 }));
}

const TWO_PARTS = [{ duration_s: 600 }, { duration_s: 600 }];

/** Part-0 solid anchor: row at sheet 10, transcript at 10 + `offset0`. */
function part0Anchor(offset0 = 0) {
  return {
    row: { sheetSec: 10, message: 'alpha bravo charlie delta echo', type: '' },
    tokens: tokensAt(10 + offset0, ['alpha', 'bravo', 'charlie', 'delta', 'echo']),
  };
}

describe('syncLogRowsToSeams — multi-part offset-selection ladder (i > 0)', () => {
  it('a single solid reference resolves part 1 directly (solids==1 && decent==1)', () => {
    const anchor = part0Anchor();
    const { parts, assignments } = syncLogRowsToSeams(
      [anchor.row, { sheetSec: 610, message: 'foxtrot golf hotel india juliet', type: '' }],
      TWO_PARTS,
      [...anchor.tokens, ...tokensAt(615, ['foxtrot', 'golf', 'hotel', 'india', 'juliet'])],
    );
    expect(parts).toHaveLength(2);
    expect(parts[0].offsetSec).toBeCloseTo(0, 5);
    expect(parts[1].offsetSec).toBeCloseTo(5, 5);
    const ref = assignments.find((a) => a.row.sheetSec === 610);
    expect(ref?.partIndex).toBe(1);
    expect(ref?.sessionSec).toBeCloseTo(615, 5);
  });

  it('two agreeing decent references (< OFFSET_AGREE_S apart) choose the earliest sheet one', () => {
    const anchor = part0Anchor();
    const { parts, assignments } = syncLogRowsToSeams(
      [
        anchor.row,
        { sheetSec: 610, message: 'foxtrot golf hotel', type: '' }, // decent, offset +5
        { sheetSec: 700, message: 'india juliet kilo', type: '' }, // decent, offset +7
      ],
      TWO_PARTS,
      [
        ...anchor.tokens,
        ...tokensAt(615, ['foxtrot', 'golf', 'hotel']),
        ...tokensAt(707, ['india', 'juliet', 'kilo']),
      ],
    );
    // The earliest-sheetSec decent candidate's offset wins (a=610 → +5, not +7)…
    expect(parts[1].offsetSec).toBeCloseTo(5, 5);
    // …and is what maps every part-1 row, including the later reference's own.
    const later = assignments.find((a) => a.row.sheetSec === 700);
    expect(later?.partIndex).toBe(1);
    expect(later?.sessionSec).toBeCloseTo(705, 5);
  });

  it('throws when two decent references disagree by ≥ OFFSET_AGREE_S', () => {
    const anchor = part0Anchor();
    expect(() =>
      syncLogRowsToSeams(
        [
          anchor.row,
          { sheetSec: 610, message: 'foxtrot golf hotel', type: '' }, // offset +5
          { sheetSec: 700, message: 'india juliet kilo', type: '' }, // offset +100
        ],
        TWO_PARTS,
        [
          ...anchor.tokens,
          ...tokensAt(615, ['foxtrot', 'golf', 'hotel']),
          ...tokensAt(800, ['india', 'juliet', 'kilo']),
        ],
      ),
    ).toThrow(/Part 1 sync failed: reference offsets disagree/);
  });

  it('throws when part 1 has rows but no decent transcript match', () => {
    const anchor = part0Anchor();
    expect(() =>
      syncLogRowsToSeams(
        [anchor.row, { sheetSec: 610, message: 'zulu yankee xray whiskey', type: '' }],
        TWO_PARTS,
        anchor.tokens, // no part-1 vocabulary at all
      ),
    ).toThrow(/Part 1 sync failed: insufficient decent transcript matches/);
  });
});

describe('syncLogRowsToSeams — row assignment windows', () => {
  it('a row past the LAST part’s sheetEnd falls back onto the last part with its offset', () => {
    const anchor = part0Anchor();
    const { parts, assignments } = syncLogRowsToSeams(
      [
        anchor.row,
        { sheetSec: 610, message: 'foxtrot golf hotel india juliet', type: '' }, // offset +5
        { sheetSec: 1500, message: 'nothing matches here at all', type: '' },
      ],
      TWO_PARTS,
      [...anchor.tokens, ...tokensAt(615, ['foxtrot', 'golf', 'hotel', 'india', 'juliet'])],
    );
    // sheetEnd of part 1 = 601 + 600 − 5 = 1196 < 1500 → past-end fallback.
    expect(parts[1].sheetEnd).toBeCloseTo(1196, 5);
    const past = assignments.find((a) => a.row.sheetSec === 1500);
    expect(past?.partIndex).toBe(1);
    expect(past?.sessionSec).toBeCloseTo(1505, 5);
  });

  it('a row in the fractional gap between part 0’s sheetEnd and part 1’s sheetStart lands on part 0 (contiguous windows)', () => {
    // Fractional part-0 offset (+0.4) → sheetEnd0 = 599.6, sheetStart1 = 600.6.
    // The integer row at 600 sits strictly between them: before the fix it
    // matched NO window and was silently dropped (not even the past-end
    // fallback caught it, since 600 < part 1's sheetEnd).
    const anchor = part0Anchor(0.4);
    const { parts, assignments } = syncLogRowsToSeams(
      [
        anchor.row,
        { sheetSec: 600, message: 'plain unmatched filler words', type: '' }, // the gap row
        { sheetSec: 610, message: 'foxtrot golf hotel india juliet', type: '' }, // offset +5
      ],
      TWO_PARTS,
      [...anchor.tokens, ...tokensAt(615, ['foxtrot', 'golf', 'hotel', 'india', 'juliet'])],
    );
    expect(parts[0].offsetSec).toBeCloseTo(0.4, 5);
    expect(parts[0].sheetEnd).toBeCloseTo(599.6, 5);
    expect(parts[1].sheetStart).toBeCloseTo(600.6, 5);

    // Every row is assigned — the gap row no longer vanishes.
    expect(assignments).toHaveLength(3);
    const gap = assignments.find((a) => a.row.sheetSec === 600);
    expect(gap?.partIndex).toBe(0);
    expect(gap?.sessionSec).toBeCloseTo(600.4, 5);

    // Rows clearly inside a window are unaffected by the boundary rule.
    const inside = assignments.find((a) => a.row.sheetSec === 610);
    expect(inside?.partIndex).toBe(1);
    expect(inside?.sessionSec).toBeCloseTo(615, 5);
  });
});

describe('syncLogRowsToSeams', () => {
  it('uses solid part-0 offset and imports adjusted session times', () => {
    const tx: TranscriptToken[] = [
      { word: 'almost', startSec: 527 },
      { word: 'called', startSec: 527.3 },
      { word: 'a', startSec: 527.5 },
      { word: 'helicopter', startSec: 527.7 },
      { word: 'but', startSec: 528.5 },
    ];
    const { parts, assignments } = syncLogRowsToSeams(
      [
        { sheetSec: 528, message: 'almost called a helicopter but just crawled', type: 'PROMO' },
        { sheetSec: 100, message: 'unrelated filler words here now', type: '' },
      ],
      [{ duration_s: 1800 }],
      tx,
    );
    expect(parts[0].offsetSec).toBeCloseTo(-1, 0);
    const heli = assignments.find((a) => a.row.sheetSec === 528);
    expect(heli?.sessionSec).toBeCloseTo(527, 0);
  });
});
