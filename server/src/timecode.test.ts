import { describe, expect, it } from 'vitest';
import {
  formatRuntimeHms,
  formatSmpte,
  fromTotalFrames,
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
