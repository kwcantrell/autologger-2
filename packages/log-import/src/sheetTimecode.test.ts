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

  // session-tables design D5 (A11): an hour so large that its frame count at 120 fps is not a safe
  // integer would reach a session `bigint` out of range; it is unparseable, so the row is dropped
  // at fetch as any malformed timecode row is.
  it('rejects a timecode whose frame count at 120 fps is not a safe integer', () => {
    expect(parseSheetTimecodeToSeconds('123456789012345678901:00:00')).toBeNull();
  });
});

describe('secondsToTotalFrames', () => {
  it('rounds at session fps', () => {
    expect(secondsToTotalFrames(8 * 60 + 47, 24)).toBe((8 * 60 + 47) * 24);
  });
});
