// Pure-function coverage for the yt-dlp upload_date normalizer (design D4).
// The DB-backed setSessionEpisodeDate round-trip lives in the integration
// tier (changesReaders.int.test.ts) alongside its setSessionArchived /
// setSessionUiHidden siblings.

import { describe, expect, it } from 'vitest';
import { normalizeUploadDate } from './sessionIndexStore';

describe('normalizeUploadDate (yt-dlp YYYYMMDD -> catalog YYYY-MM-DD)', () => {
  it('converts a well-formed YYYYMMDD string', () => {
    expect(normalizeUploadDate('20240115')).toBe('2024-01-15');
    expect(normalizeUploadDate('20240101')).toBe('2024-01-01');
    expect(normalizeUploadDate('20241231')).toBe('2024-12-31');
  });

  it('is a no-op (returns null) for null/undefined/blank input', () => {
    expect(normalizeUploadDate(null)).toBeNull();
    expect(normalizeUploadDate(undefined)).toBeNull();
    expect(normalizeUploadDate('')).toBeNull();
    expect(normalizeUploadDate('   ')).toBeNull();
  });

  it('is a no-op (returns null) for malformed input', () => {
    expect(normalizeUploadDate('2024-01-15')).toBeNull(); // already-formatted, wrong shape
    expect(normalizeUploadDate('202401')).toBeNull(); // too short
    expect(normalizeUploadDate('2024011599')).toBeNull(); // too long
    expect(normalizeUploadDate('abcdefgh')).toBeNull(); // non-numeric
    expect(normalizeUploadDate('20241301')).toBeNull(); // month 13
    expect(normalizeUploadDate('20240132')).toBeNull(); // day 32
    expect(normalizeUploadDate('20240000')).toBeNull(); // month/day 00
  });

  it('trims surrounding whitespace before validating', () => {
    expect(normalizeUploadDate('  20240115  ')).toBe('2024-01-15');
  });
});
