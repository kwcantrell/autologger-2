import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fmtDateOnly } from './fmtDateOnly';

// youtube-audio-import, task 4.2; design D4 "publish-date off-by-one".
//
// Regression target: `new Date("2024-01-15")` parses as UTC midnight, which
// for any negative-UTC-offset viewer (the Americas) renders as the PREVIOUS
// calendar day once converted to local time — Jan 15 silently becomes Jan
// 14. The zone must be pinned to a negative UTC offset for this test to mean
// anything: under UTC (a common CI default) the bug is invisible, since
// UTC-midnight-of-day-N *is* day N locally. `process.env.TZ` is set here,
// before any `Date`/`toLocaleDateString` call runs, to a fixed
// negative-offset zone (`America/Los_Angeles`, UTC-8/UTC-7) — Node's ICU
// reads `TZ` per-call, not just at process start, so reassigning it here
// deterministically changes the local zone the module-under-test's `Date`
// calls resolve against, independent of the machine/CI's real zone.
describe('fmtDateOnly', () => {
  let originalTz: string | undefined;

  beforeEach(() => {
    originalTz = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles'; // fixed negative UTC offset
  });

  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('renders a bare YYYY-MM-DD on its literal calendar day under a negative-UTC-offset zone (no UTC-midnight shift)', () => {
    // This is the exact regression case from design D4: under the old
    // `new Date(iso).toLocaleDateString(...)` implementation, this would
    // render "Jan 14, 2024" in America/Los_Angeles because
    // `new Date("2024-01-15")` is UTC midnight = Jan 14, 16:00 local.
    expect(fmtDateOnly('2024-01-15')).toBe('Jan 15, 2024');
  });

  it('renders a bare date at the start of the year correctly (adjacent-day edge case)', () => {
    expect(fmtDateOnly('2024-01-01')).toBe('Jan 1, 2024');
  });

  it('renders a full created_at_utc timestamp as a local-zone instant (unchanged fallback behavior)', () => {
    // A full ISO timestamp represents an instant, not a calendar day — local
    // rendering of it is correct and must be preserved. 2024-01-15T05:00:00Z
    // is 2024-01-14T21:00:00-08:00 in America/Los_Angeles: the date DOES
    // shift back a day here, and that's expected/correct for an instant.
    expect(fmtDateOnly('2024-01-15T05:00:00Z')).toBe('Jan 14, 2024');
  });

  it('renders a full created_at_utc timestamp that stays on the same local day', () => {
    // 2024-01-15T20:00:00Z is 2024-01-15T12:00:00-08:00 local — same day.
    expect(fmtDateOnly('2024-01-15T20:00:00Z')).toBe('Jan 15, 2024');
  });

  it('returns empty string for empty input', () => {
    expect(fmtDateOnly('')).toBe('');
  });

  // web-api-shape-conformance audit CW-9: `Session.created_at_utc` is nullable
  // on the wire, and both callers pass `episode_date ?? created_at_utc` — so
  // `null` genuinely reaches here when a session has neither. It renders as an
  // empty date rather than a fabricated one.
  it('returns empty string for a null or undefined date', () => {
    expect(fmtDateOnly(null)).toBe('');
    expect(fmtDateOnly(undefined)).toBe('');
  });

  it('echoes back unparseable input', () => {
    expect(fmtDateOnly('not-a-date')).toBe('not-a-date');
  });
});
