import { describe, expect, it } from 'vitest';
import { formatTimelineSec, sessionTimeToTimelineSec } from './timelineSec';

// Shared rates × seconds matrix (quality fix wave, FIX 2): hoisted to module
// scope so the `formatTimelineSec` inverse-property describe block below runs
// the SAME cases the round-trip describe block already exercises, rather than
// a second, driftable copy.
const RATES = [24, 25, 30, 23.976, 29.97, 59.94, 119.88];
const SECS = [0, 1, 100.3, 3600.5, 7325.75, 43200.9];

// feed-row-seek, task 2.1/2.2; design D3.
//
// The core hazard: session-time strings are produced by the server's
// `fromTotalFrames` (server/src/timecode.ts), which decomposes a linear
// frame count at `Math.round(frameRate)` — so `HH:MM:SS` encodes
// `totalFrames / Math.round(fps)`, while the timeline (and audio clips)
// live in `totalFrames / fps` (the ACTUAL, non-rounded rate) space. Reading
// `HH:MM:SS` as literal seconds is therefore wrong at every non-integer
// frame rate the app offers (23.976 / 29.97 / 59.94), by ~0.1% of elapsed
// time. These tests assert the CORRECT (frame-arithmetic) answer AND, where
// called out, the naive literal-seconds answer that a wrong implementation
// would produce instead — so a regression back to literal-seconds fails
// loudly rather than merely being "off by a bit".

describe('sessionTimeToTimelineSec', () => {
  describe('non-integer frame rates — the core D3 hazard', () => {
    it('at 23.976 fps resolves 00:59:56:10 to ~3600.0s, NOT the ~3596.4s literal-seconds answer', () => {
      const got = sessionTimeToTimelineSec('00:59:56:10', 23.976);
      expect(got).not.toBeNull();
      // Correct: (0*3600 + 59*60 + 56)*24 + 10 = 86314 frames; /23.976 ≈ 3600.02s.
      expect(got as number).toBeCloseTo(3600.02, 1);
      // A literal-seconds reader would answer 3596 + 10/23.976 ≈ 3596.42 — assert
      // we are NOT anywhere near that value, and that the two answers diverge by
      // approximately the ~3.6s design.md predicts for an hour of elapsed time.
      const naive = 0 * 3600 + 59 * 60 + 56 + 10 / 23.976;
      expect(naive).toBeCloseTo(3596.42, 1);
      expect(Math.abs((got as number) - naive)).toBeCloseTo(3.6, 1);
    });

    it('at 29.97 fps resolves 00:59:56:10 to the frame-arithmetic answer, not the literal-seconds one', () => {
      const got = sessionTimeToTimelineSec('00:59:56:10', 29.97);
      expect(got).not.toBeNull();
      // Correct: (59*60 + 56)*30 + 10 = 107890 frames; /29.97 ≈ 3599.93s.
      expect(got as number).toBeCloseTo(3599.93, 1);
      const naive = 59 * 60 + 56 + 10 / 29.97;
      expect(naive).toBeCloseTo(3596.33, 1);
      expect(Math.abs((got as number) - naive)).toBeCloseTo(3.6, 1);
    });

    it('at 59.94 fps resolves 00:59:56:10 to the frame-arithmetic answer, not the literal-seconds one', () => {
      const got = sessionTimeToTimelineSec('00:59:56:10', 59.94);
      expect(got).not.toBeNull();
      // Correct: (59*60 + 56)*60 + 10 = 215770 frames; /59.94 ≈ 3599.77s.
      expect(got as number).toBeCloseTo(3599.77, 1);
      const naive = 59 * 60 + 56 + 10 / 59.94;
      expect(naive).toBeCloseTo(3596.17, 1);
      expect(Math.abs((got as number) - naive)).toBeCloseTo(3.6, 1);
    });
  });

  describe('integer frame rates — both readings agree', () => {
    it('at 24 fps (integer), frame arithmetic and literal seconds land on the same answer', () => {
      const got = sessionTimeToTimelineSec('00:10:00:12', 24);
      // (600)*24 + 12 = 14412 frames; /24 = 600.5s.
      expect(got).toBeCloseTo(600.5, 6);
      const naive = 10 * 60 + 12 / 24;
      expect(got).toBeCloseTo(naive, 6);
    });

    it('at 30 fps (integer), frame arithmetic and literal seconds land on the same answer', () => {
      const got = sessionTimeToTimelineSec('01:02:03:15', 30);
      // (3600+120+3)*30 + 15 = 111705 frames; /30 = 3723.5s.
      expect(got).toBeCloseTo(3723.5, 6);
      const naive = 3600 + 2 * 60 + 3 + 15 / 30;
      expect(got).toBeCloseTo(naive, 6);
    });
  });

  describe('frame field width', () => {
    it('accepts a three-digit frame field (>= 100) at 119.88 fps', () => {
      // Math.round(119.88) = 120, so frame fields run 0..119 and need three
      // digits from 100 up. formatSmpte pads with padStart(2,'0'), which does
      // NOT truncate, so the renderer legitimately emits e.g. "105".
      const got = sessionTimeToTimelineSec('00:00:01:105', 119.88);
      expect(got).not.toBeNull();
      // (1)*120 + 105 = 225 frames; /119.88 ≈ 1.877s.
      expect(got as number).toBeCloseTo(1.877, 2);
    });
  });

  describe('frame field bounds — reject rather than clamp', () => {
    it('rejects a frame field >= Math.round(fps): 00:00:00:99 at 24fps must NOT yield 4.125s', () => {
      const got = sessionTimeToTimelineSec('00:00:00:99', 24);
      expect(got).toBeNull();
    });

    it('accepts a frame field one below the boundary (23 at 24fps)', () => {
      const got = sessionTimeToTimelineSec('00:00:00:23', 24);
      expect(got).not.toBeNull();
      expect(got as number).toBeCloseTo(23 / 24, 6);
    });

    it('rejects a three-digit frame field at or above the rounded rate (120 at 119.88fps)', () => {
      const got = sessionTimeToTimelineSec('00:00:01:120', 119.88);
      expect(got).toBeNull();
    });
  });

  describe('minutes/seconds bounds', () => {
    it('rejects minutes > 59', () => {
      expect(sessionTimeToTimelineSec('00:60:00', 24)).toBeNull();
    });

    it('rejects seconds > 59', () => {
      expect(sessionTimeToTimelineSec('00:00:60', 24)).toBeNull();
    });
  });

  describe('field-count / hour-width shape', () => {
    it('accepts H:MM:SS with a single-digit hour', () => {
      const got = sessionTimeToTimelineSec('1:02:03', 24);
      // (3600+120+3)*24 = 89352 frames; /24 = 3723s exactly (integer fps).
      expect(got).toBeCloseTo(3723, 6);
    });

    it('rejects MM:SS — ambiguous with HH:MM, a 19,470s error if guessed wrong', () => {
      // As MM:SS, "05:30" is 330s. As HH:MM, it's 19800s. The two readings
      // differ by 19470s and nothing in the string disambiguates them.
      const asMmSs = 5 * 60 + 30;
      const asHhMm = 5 * 3600 + 30 * 60;
      expect(asHhMm - asMmSs).toBe(19470);
      expect(sessionTimeToTimelineSec('05:30', 24)).toBeNull();
    });

    it('parses HH:MM:SS with zero frames when the frame field is omitted', () => {
      const got = sessionTimeToTimelineSec('00:10:05', 24);
      expect(got).toBeCloseTo(605, 6);
    });

    it('accepts a ";" frame separator (drop-frame notation the renderer emits at 29.97fps)', () => {
      const got = sessionTimeToTimelineSec('00:59:56;10', 29.97);
      expect(got).not.toBeNull();
      expect(got as number).toBeCloseTo(3599.93, 1);
    });
  });

  describe('empty / garbage input — "no position", never 0', () => {
    it.each([
      ['', 24],
      [null, 24],
      [undefined, 24],
      ['garbage', 24],
      ['not:a:time', 24],
      ['12:34:56:78:90', 24],
      ['-1:02:03', 24],
    ] as const)('sessionTimeToTimelineSec(%o, %i) is null, not 0', (input, fps) => {
      const got = sessionTimeToTimelineSec(input, fps);
      expect(got).toBeNull();
      expect(got).not.toBe(0);
    });
  });

  describe('invalid fps', () => {
    it('is unresolvable when fps is zero, negative, or non-finite', () => {
      expect(sessionTimeToTimelineSec('00:10:00', 0)).toBeNull();
      expect(sessionTimeToTimelineSec('00:10:00', -24)).toBeNull();
      expect(sessionTimeToTimelineSec('00:10:00', Number.NaN)).toBeNull();
    });
  });

  describe("round-trip against the server's rendering construction (design D3)", () => {
    // Test-only mirror of server/src/timecode.ts's `fromTotalFrames` +
    // `formatSmpte` — NOT imported from server/ (this is web/ code; the
    // constraint is deliberate), but reproduced verbatim so this test can
    // construct the exact strings the server actually renders onto the
    // wire, and confirm our converter recovers the position within half a
    // frame. This is what "round-trip" tests: format(fromTotalFrames(f))
    // parsed back by our converter recovers f/fps.
    interface Timecode {
      hours: number;
      minutes: number;
      seconds: number;
      frames: number;
      frame_rate: number;
    }

    function fromTotalFramesForTest(total: number, frameRate: number): Timecode {
      const fps = Math.round(frameRate * 1000) / 1000;
      const fpsI = Math.max(1, Math.round(fps));
      const f = total % fpsI;
      let t = Math.floor(total / fpsI);
      const s = t % 60;
      t = Math.floor(t / 60);
      const m = t % 60;
      const h = Math.floor(t / 60) % 24; // WRAPS at 24 hours — see below.
      return { hours: h, minutes: m, seconds: s, frames: f, frame_rate: fps };
    }

    function formatSmpteForTest(tc: Timecode): string {
      const sep = Math.abs(tc.frame_rate - 29.97) < 0.001 * 29.97 ? ';' : ':';
      const p2 = (n: number) => String(n).padStart(2, '0');
      return `${p2(tc.hours)}:${p2(tc.minutes)}:${p2(tc.seconds)}${sep}${p2(tc.frames)}`;
    }

    for (const fps of RATES) {
      for (const sec of SECS) {
        it(`recovers ~${sec}s at ${fps}fps within half a frame`, () => {
          const totalFrames = Math.round(sec * fps);
          const tc = fromTotalFramesForTest(totalFrames, fps);
          const str = formatSmpteForTest(tc);
          const got = sessionTimeToTimelineSec(str, fps);
          expect(got).not.toBeNull();
          expect(Math.abs((got as number) - sec)).toBeLessThanOrEqual(0.5 / fps + 1e-9);
        });
      }
    }

    it('past 24 hours: fromTotalFrames wraps the hour field, and the converter stays consistent with the WRAPPED value rather than erroring or silently recovering the true elapsed time', () => {
      // D3's correctness depends on `fromTotalFrames` continuing to wrap
      // (`% 24`). This pins that dependency: an innocuous future "don't wrap
      // the hour field" fix would desynchronize rendered strings from what
      // markers/clips actually store, and this test would catch it because
      // the wrapped string here would stop decoding to the wrapped second.
      const fps = 24; // integer rate keeps the wrap arithmetic exact (no fps/fpsI distortion)
      const sec = 24 * 3600 + 100; // 24h 1m 40s — one day plus 100s
      const totalFrames = Math.round(sec * fps);
      const tc = fromTotalFramesForTest(totalFrames, fps);
      expect(tc.hours).toBeLessThan(24); // confirms the wrap actually happened
      expect(tc.hours).toBe(0); // 25h wraps to hour 0 (24 % 24)
      const str = formatSmpteForTest(tc);
      expect(str).toBe('00:01:40:00');

      const got = sessionTimeToTimelineSec(str, fps);
      expect(got).not.toBeNull();
      // Recovers the WRAPPED second (sec mod 24h = 100), not the original
      // 86500 — the string itself lost the day information, exactly as
      // design.md describes ("mutually consistent... offset").
      expect(got as number).toBeCloseTo(100, 6);
      expect(got as number).not.toBeCloseTo(sec, 0);
    });
  });
});

// --- formatTimelineSec (quality fix wave, FIX 2) ---
//
// `formatTimelineSec`'s docstring claims it is the "exact inverse of
// `sessionTimeToTimelineSec`", and until now nothing asserted that — its only
// coverage was indirect, through three `TranscribeRow.test.tsx` cases fixed
// at integer fps (24) with whole-second values. That left untested: the `;`
// drop-frame separator branch, every non-integer rate (the entire point of
// the module — see D3), the 24-hour wrap, the null-returning guards, and the
// inverse property itself.
describe('formatTimelineSec', () => {
  describe('inverse property — round-trips through sessionTimeToTimelineSec', () => {
    for (const fps of RATES) {
      for (const sec of SECS) {
        it(`formatTimelineSec(${sec}, ${fps}) parses back to within half a frame via sessionTimeToTimelineSec`, () => {
          const str = formatTimelineSec(sec, fps);
          expect(str).not.toBeNull();
          const got = sessionTimeToTimelineSec(str as string, fps);
          expect(got).not.toBeNull();
          expect(Math.abs((got as number) - sec)).toBeLessThanOrEqual(0.5 / fps + 1e-9);
        });
      }
    }
  });

  describe('drop-frame separator', () => {
    it('uses ";" before the frame field at ~29.97fps', () => {
      const str = formatTimelineSec(3600, 29.97);
      expect(str).not.toBeNull();
      expect(str as string).toMatch(/^\d{2}:\d{2}:\d{2};\d{2}$/);
    });

    it('uses ":" before the frame field at every other rate, including other non-integer ones', () => {
      for (const fps of [24, 25, 30, 23.976, 59.94, 119.88]) {
        const str = formatTimelineSec(100, fps);
        expect(str).not.toBeNull();
        // The frame field is zero-padded to at least 2 digits and never
        // truncated, so only rates whose rounded fps is >= 100 (here, only
        // 119.88) can actually emit a 3-digit frame count — every rate below
        // that must stay exactly 2 digits, or a malformed 3-digit field would
        // slip past a looser `{1,3}` assertion undetected.
        const frameDigits = Math.round(fps) >= 100 ? '{2,3}' : '{2}';
        expect(str as string).toMatch(new RegExp(`^\\d{2}:\\d{2}:\\d{2}:\\d${frameDigits}$`));
      }
    });
  });

  describe('24-hour wrap', () => {
    it('wraps the hour field at 24 hours, mirroring fromTotalFrames/formatSmpte', () => {
      // 24h 1m 40s -> wraps to 00:01:40:00 (D3's dependency on the server's
      // existing wrap behavior; see the round-trip describe block above).
      const str = formatTimelineSec(24 * 3600 + 100, 24);
      expect(str).toBe('00:01:40:00');
    });
  });

  describe('null / guard cases', () => {
    it('rejects a negative second', () => {
      expect(formatTimelineSec(-1, 24)).toBeNull();
    });

    it('rejects a non-finite second', () => {
      expect(formatTimelineSec(Number.NaN, 24)).toBeNull();
      expect(formatTimelineSec(Number.POSITIVE_INFINITY, 24)).toBeNull();
    });

    it('rejects fps that is zero, negative, or non-finite', () => {
      expect(formatTimelineSec(10, 0)).toBeNull();
      expect(formatTimelineSec(10, -24)).toBeNull();
      expect(formatTimelineSec(10, Number.NaN)).toBeNull();
    });

    it('accepts second zero', () => {
      expect(formatTimelineSec(0, 24)).toBe('00:00:00:00');
    });
  });
});
