import { describe, expect, it } from 'vitest';
import { parseSheetTimecodeToSeconds, secondsToTotalFrames } from './sheetTimecode';

describe('parseSheetTimecodeToSeconds', () => {
  it('parses M:SS and H:MM:SS', () => {
    expect(parseSheetTimecodeToSeconds('8:48')).toBe(8 * 60 + 48);
    expect(parseSheetTimecodeToSeconds('1:07:05')).toBe(1 * 3600 + 7 * 60 + 5);
  });

  it('drops frames when present', () => {
    expect(parseSheetTimecodeToSeconds('00:08:48:00')).toBe(8 * 60 + 48);
  });

  it('rejects garbage', () => {
    expect(parseSheetTimecodeToSeconds('')).toBeNull();
    expect(parseSheetTimecodeToSeconds('nope')).toBeNull();
    expect(parseSheetTimecodeToSeconds('1:99')).toBeNull();
  });
});

describe('secondsToTotalFrames', () => {
  it('rounds at session fps', () => {
    expect(secondsToTotalFrames(8 * 60 + 47, 24)).toBe((8 * 60 + 47) * 24);
  });
});
