import { describe, expect, it } from 'vitest';
import {
  appendSerializedAudioSeamParts,
  deserializeAudioSeamParts,
  parseAudioSeamPartsHeader,
  serializeAudioSeamParts,
} from './audioSeamParts';

describe('parseAudioSeamPartsHeader', () => {
  it('defaults to a single part equal to duration_s when header omitted', () => {
    expect(parseAudioSeamPartsHeader(undefined, 90)).toEqual([{ duration_s: 90 }]);
    expect(parseAudioSeamPartsHeader('  ', 12.5)).toEqual([{ duration_s: 12.5 }]);
  });

  it('accepts matching multi-part durations', () => {
    expect(parseAudioSeamPartsHeader('[{"duration_s":30},{"duration_s":60}]', 90)).toEqual([
      { duration_s: 30 },
      { duration_s: 60 },
    ]);
  });

  it('rejects bad JSON, empty arrays, and sum mismatch', () => {
    expect(() => parseAudioSeamPartsHeader('{', 10)).toThrow(/JSON array/);
    expect(() => parseAudioSeamPartsHeader('[]', 10)).toThrow(/non-empty/);
    expect(() => parseAudioSeamPartsHeader('[{"duration_s":1}]', 10)).toThrow(/within/);
  });
});

describe('serialize/deserializeAudioSeamParts', () => {
  it('round-trips', () => {
    const parts = [{ duration_s: 1.5 }, { duration_s: 2.5 }];
    expect(deserializeAudioSeamParts(serializeAudioSeamParts(parts))).toEqual(parts);
  });

  it('returns null for corrupt meta', () => {
    expect(deserializeAudioSeamParts(null)).toBeNull();
    expect(deserializeAudioSeamParts('nope')).toBeNull();
  });
});

describe('appendSerializedAudioSeamParts', () => {
  it('starts from absent/empty meta', () => {
    const raw = appendSerializedAudioSeamParts(null, [{ duration_s: 30 }]);
    expect(deserializeAudioSeamParts(raw)).toEqual([{ duration_s: 30 }]);
    const rawEmpty = appendSerializedAudioSeamParts('', [{ duration_s: 12.5 }]);
    expect(deserializeAudioSeamParts(rawEmpty)).toEqual([{ duration_s: 12.5 }]);
  });

  it('appends the new import parts AFTER the stored ones, in take order', () => {
    const take1 = appendSerializedAudioSeamParts(null, [{ duration_s: 30 }, { duration_s: 60 }]);
    const take2 = appendSerializedAudioSeamParts(take1, [{ duration_s: 45 }]);
    expect(deserializeAudioSeamParts(take2)).toEqual([
      { duration_s: 30 },
      { duration_s: 60 },
      { duration_s: 45 },
    ]);
  });

  it('treats corrupt stored meta as empty rather than failing the import', () => {
    const raw = appendSerializedAudioSeamParts('nope', [{ duration_s: 2 }]);
    expect(deserializeAudioSeamParts(raw)).toEqual([{ duration_s: 2 }]);
  });
});
