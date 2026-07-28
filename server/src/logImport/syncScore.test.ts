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
    expect(cands[0]?.score).toBeGreaterThanOrEqual(4.5);
    expect(isSolid(cands[0]!)).toBe(true);
    expect(Math.round(cands[0]!.offsetSec)).toBe(-1);
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
