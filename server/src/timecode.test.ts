import { describe, expect, it } from 'vitest';
import {
  formatRuntimeHms,
  formatSmpte,
  fromTotalFrames,
  parseTimecodeString,
  parseUtcMs,
  timecodeForMark,
  toTotalFrames,
  transportTimecode,
} from './timecode';

describe('fromTotalFrames / toTotalFrames', () => {
  it('round-trips across common integer frame rates within 24h', () => {
    for (const fps of [24, 25, 30, 50, 60]) {
      for (const total of [0, 1, fps - 1, fps, fps * 60, fps * 3600 + 7]) {
        expect(toTotalFrames(fromTotalFrames(total, fps))).toBe(total);
      }
    }
  });

  it('decomposes 1 second + 1 frame at 30fps', () => {
    expect(fromTotalFrames(31, 30)).toMatchObject({
      hours: 0,
      minutes: 0,
      seconds: 1,
      frames: 1,
      frame_rate: 30,
    });
  });

  it('wraps hours at 24', () => {
    expect(fromTotalFrames(30 * 3600 * 25, 30).hours).toBe(1); // 25h → 1h
  });

  it('rounds fractional fps to integer frame buckets but keeps frame_rate', () => {
    const tc = fromTotalFrames(30, 29.97);
    expect(tc).toMatchObject({ seconds: 1, frames: 0, frame_rate: 29.97 });
  });

  it('throws on non-positive frame rate', () => {
    expect(() => fromTotalFrames(10, 0)).toThrow();
  });
});

describe('formatSmpte', () => {
  it('uses ":" for non-drop rates', () => {
    expect(formatSmpte({ hours: 1, minutes: 2, seconds: 3, frames: 4, frame_rate: 30 })).toBe(
      '01:02:03:04',
    );
  });
  it('uses ";" for 29.97 (current behavior — NDF math, DF label)', () => {
    expect(formatSmpte({ hours: 0, minutes: 0, seconds: 0, frames: 0, frame_rate: 29.97 })).toBe(
      '00:00:00;00',
    );
  });
});

describe('transportTimecode / timecodeForMark', () => {
  const ROLL = '2026-06-25T00:00:00.000Z';
  const now = Date.parse('2026-06-25T00:00:05.000Z'); // +5s

  it('adds elapsed + (now-roll)*fps while rolling', () => {
    const tc = transportTimecode(
      30,
      0,
      { is_rolling: true, elapsed_frames: 0, roll_started_at_utc: ROLL },
      now,
    );
    expect(toTotalFrames(tc)).toBe(150); // 5s @ 30
  });

  it('ignores live extra when stopped', () => {
    const tc = transportTimecode(
      30,
      0,
      { is_rolling: false, elapsed_frames: 90, roll_started_at_utc: null },
      now,
    );
    expect(toTotalFrames(tc)).toBe(90);
  });

  it('timecodeForMark clamps a mark before roll start to the base', () => {
    const before = Date.parse('2026-06-24T23:59:59.000Z');
    const tc = timecodeForMark(
      30,
      0,
      { is_rolling: true, elapsed_frames: 12, roll_started_at_utc: ROLL },
      before,
    );
    expect(toTotalFrames(tc)).toBe(12);
  });
});

describe('parseTimecodeString', () => {
  it('accepts HH:MM:SS (frames default to 0)', () => {
    expect(parseTimecodeString('01:02:03', 30)).toEqual({
      hours: 1,
      minutes: 2,
      seconds: 3,
      frames: 0,
      frame_rate: 30,
    });
  });

  it('accepts HH:MM:SS:FF and matches toTotalFrames arithmetic', () => {
    const tc = parseTimecodeString('00:14:03:12', 30);
    expect(tc).toEqual({ hours: 0, minutes: 14, seconds: 3, frames: 12, frame_rate: 30 });
    expect(toTotalFrames(tc as NonNullable<typeof tc>)).toBe((14 * 60 + 3) * 30 + 12);
  });

  it('accepts drop-frame HH:MM:SS;FF at 29.97', () => {
    expect(parseTimecodeString('00:14:03;12', 29.97)).toEqual({
      hours: 0,
      minutes: 14,
      seconds: 3,
      frames: 12,
      frame_rate: 29.97,
    });
  });

  it('accepts either separator at any rate and tolerates surrounding whitespace', () => {
    // The grammar lists all three forms unconditionally — the model echoes
    // what it reads, so `;` parses at non-29.97 rates too (and vice versa).
    expect(parseTimecodeString('00:00:01;05', 25)).toMatchObject({ seconds: 1, frames: 5 });
    expect(parseTimecodeString('00:00:01:05', 29.97)).toMatchObject({ seconds: 1, frames: 5 });
    expect(parseTimecodeString(' 00:00:01:05 ', 30)).toMatchObject({ seconds: 1, frames: 5 });
  });

  it('rejects malformed strings', () => {
    for (const bad of [
      '',
      'garbage',
      '1:02:03', // one-digit field
      '01:02', // too few fields
      '01:02:03:04:05', // too many fields
      '01:02:03:', // dangling separator
      '-1:02:03', // negative
      '01:02:03;4', // one-digit frames
      '01:02:03.04', // wrong separator
      '01 02 03', // wrong delimiters
    ]) {
      expect(parseTimecodeString(bad, 30)).toBeNull();
    }
  });

  it('rejects out-of-bounds fields: >= 24h, minutes/seconds > 59, frames >= round(fps)', () => {
    expect(parseTimecodeString('24:00:00', 30)).toBeNull();
    expect(parseTimecodeString('00:60:00', 30)).toBeNull();
    expect(parseTimecodeString('00:00:60', 30)).toBeNull();
    expect(parseTimecodeString('00:00:00:30', 30)).toBeNull(); // FF must be < 30
    expect(parseTimecodeString('00:00:00;30', 29.97)).toBeNull(); // round(29.97) = 30
    expect(parseTimecodeString('00:00:00:24', 24)).toBeNull();
    expect(parseTimecodeString('23:59:59:29', 30)).not.toBeNull(); // max valid
  });

  it('rejects non-positive frame rates', () => {
    expect(parseTimecodeString('00:00:01', 0)).toBeNull();
    expect(parseTimecodeString('00:00:01', -30)).toBeNull();
  });

  it('round-trips 29.97 drop-frame output of formatSmpte', () => {
    const fps = 29.97;
    const fpsI = 30; // repo convention: NDF math at round(fps)
    for (const total of [0, 1, 29, 30, fpsI * 60 - 1, fpsI * 3600 + 7, fpsI * 86400 - 1]) {
      const rendered = formatSmpte(fromTotalFrames(total, fps));
      expect(rendered).toContain(';');
      const parsed = parseTimecodeString(rendered, fps);
      expect(parsed).not.toBeNull();
      expect(toTotalFrames(parsed as NonNullable<typeof parsed>)).toBe(total);
    }
  });

  it('round-trips formatSmpte output across integer rates', () => {
    for (const fps of [24, 25, 30, 60]) {
      for (const total of [0, fps - 1, fps * 61 + 3, fps * 3600 * 23 + 5]) {
        const parsed = parseTimecodeString(formatSmpte(fromTotalFrames(total, fps)), fps);
        expect(toTotalFrames(parsed as NonNullable<typeof parsed>)).toBe(total);
      }
    }
  });
});

describe('formatRuntimeHms / parseUtcMs', () => {
  it('formats HH:MM:SS and zero', () => {
    expect(formatRuntimeHms(0, 30)).toBe('00:00:00');
    expect(formatRuntimeHms(30 * 65, 30)).toBe('00:01:05');
  });
  it('parseUtcMs handles +00:00 and bad input', () => {
    expect(parseUtcMs('2026-06-25T00:00:00+00:00')).toBe(Date.parse('2026-06-25T00:00:00Z'));
    expect(Number.isNaN(parseUtcMs(null))).toBe(true);
  });
});
