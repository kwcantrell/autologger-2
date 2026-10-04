// Tests for the timecode→wall-time anchor interpolation helper
// (auto-generate-event-logs task 2.1 / design D4). The REQUIRED property
// fixture is the real-store multi-take one (real TransportStore + EventStore
// over a real core — a stopped transport freezes the timecode, so several
// rows share one timecode with spread walls); it needs a session database, so
// it lives in server/src/test/session/eventAnchors.int.test.ts (session-tables
// D12). The synthetic distinct-timecode "paused" fixture (30 minutes of
// timecode spanning 2.5 hours of wall time) is kept as a secondary case only —
// it cannot produce the duplicate-timecode shape (Phase-2 review finding 2).

import { isoZ } from '@autologger/domain';
import { describe, expect, it } from 'vitest';
import {
  timecodeWallAnchors,
  type WallAnchorCandidateEvent,
  wallMsForTimecode,
  wallTimeUtcForTimecode,
} from './eventAnchors';

const FPS = 30;
const MIN = 60 * FPS; // frames per minute at 30fps
const SEC = FPS; // frames per second at 30fps

const SESSION = { frameRate: FPS, startOffsetFrames: 0, startedAtUtc: '2026-01-01T09:00:00.000Z' };

const ms = (iso: string): number => Date.parse(iso);

/** Secondary synthetic fixture (distinct timecodes; every anchor interval is
 * degenerate lo === hi): tc 00:00 at wall 10:00, tc 00:30:00 at wall 12:30
 * (a 2h wall pause collapsed on the timecode axis), tc 00:40:00 at wall
 * 12:40 (second take rolling normally). */
const M1 = { tc: 0, wall: '2026-01-01T10:00:00.000Z' };
const M2 = { tc: 30 * MIN, wall: '2026-01-01T12:30:00.000Z' };
const M3 = { tc: 40 * MIN, wall: '2026-01-01T12:40:00.000Z' };

const anchorRows = (pairs: Array<{ tc: number; wall: string }>): WallAnchorCandidateEvent[] =>
  pairs.map((p) => ({ timecode_total_frames: p.tc, wall_time_utc: p.wall }));

const FIXTURE_ANCHORS = timecodeWallAnchors(anchorRows([M1, M2, M3]));

describe('timecodeWallAnchors', () => {
  it('extracts pairs from rows carrying both fields, including internal rows', () => {
    const rows: WallAnchorCandidateEvent[] = [
      { timecode_total_frames: M2.tc, wall_time_utc: M2.wall }, // out of order on purpose
      { timecode_total_frames: M1.tc, wall_time_utc: M1.wall },
    ];
    expect(timecodeWallAnchors(rows)).toEqual([
      { timecodeTotalFrames: M1.tc, wallLoMs: ms(M1.wall), wallHiMs: ms(M1.wall) },
      { timecodeTotalFrames: M2.tc, wallLoMs: ms(M2.wall), wallHiMs: ms(M2.wall) },
    ]);
  });

  it('skips rows missing a timecode or with an unparseable wall time', () => {
    const rows: WallAnchorCandidateEvent[] = [
      { timecode_total_frames: null, wall_time_utc: M1.wall },
      { timecode_total_frames: 10, wall_time_utc: 'not-a-time' },
      { timecode_total_frames: M2.tc, wall_time_utc: M2.wall },
    ];
    expect(timecodeWallAnchors(rows)).toEqual([
      { timecodeTotalFrames: M2.tc, wallLoMs: ms(M2.wall), wallHiMs: ms(M2.wall) },
    ]);
  });

  it("skips string-ish rows whose raw timecode is '' or non-numeric (no bogus tc-0 anchor)", () => {
    // SQLite rows are loosely typed at this seam; Number('') is 0, which the
    // old filter accepted as a fabricated tc-0 anchor (Phase-2 finding 6).
    const stringish = (v: unknown): number => v as number;
    const rows: WallAnchorCandidateEvent[] = [
      { timecode_total_frames: stringish(''), wall_time_utc: M1.wall },
      { timecode_total_frames: stringish('  '), wall_time_utc: M1.wall },
      { timecode_total_frames: stringish('12x'), wall_time_utc: M1.wall },
      { timecode_total_frames: stringish('600'), wall_time_utc: M2.wall }, // numeric string — usable
    ];
    expect(timecodeWallAnchors(rows)).toEqual([
      { timecodeTotalFrames: 600, wallLoMs: ms(M2.wall), wallHiMs: ms(M2.wall) },
    ]);
  });

  it('merges equal timecodes into a wall interval and clamps intervals monotone', () => {
    const rows = anchorRows([
      { tc: 0, wall: '2026-01-01T12:00:00.000Z' },
      { tc: 0, wall: '2026-01-01T12:05:00.000Z' }, // duplicate tc — widens the interval
      { tc: 30 * MIN, wall: '2026-01-01T11:00:00.000Z' }, // earlier wall — clamped up
    ]);
    expect(timecodeWallAnchors(rows)).toEqual([
      {
        timecodeTotalFrames: 0,
        wallLoMs: ms('2026-01-01T12:00:00.000Z'),
        wallHiMs: ms('2026-01-01T12:05:00.000Z'),
      },
      {
        timecodeTotalFrames: 30 * MIN,
        wallLoMs: ms('2026-01-01T12:05:00.000Z'),
        wallHiMs: ms('2026-01-01T12:05:00.000Z'),
      },
    ]);
  });
});

describe('wallMsForTimecode — two or more anchors (piecewise-linear)', () => {
  it('maps anchor timecodes to their own walls exactly', () => {
    expect(wallMsForTimecode(M1.tc, FIXTURE_ANCHORS, SESSION)).toBe(ms(M1.wall));
    expect(wallMsForTimecode(M2.tc, FIXTURE_ANCHORS, SESSION)).toBe(ms(M2.wall));
    expect(wallMsForTimecode(M3.tc, FIXTURE_ANCHORS, SESSION)).toBe(ms(M3.wall));
  });

  it('interpolates linearly between bracketing anchors', () => {
    // Midpoint of the collapsed segment: tc 15m → wall midpoint 11:15.
    expect(wallMsForTimecode(15 * MIN, FIXTURE_ANCHORS, SESSION)).toBe(
      ms('2026-01-01T11:15:00.000Z'),
    );
    // Second take rolls 1:1 (10m tc over 10m wall): tc 35m → 12:35.
    expect(wallMsForTimecode(35 * MIN, FIXTURE_ANCHORS, SESSION)).toBe(
      ms('2026-01-01T12:35:00.000Z'),
    );
  });

  it('brackets: T strictly between anchors maps strictly between their walls', () => {
    for (const t of [1, 5 * MIN, 10 * MIN, 29 * MIN + 59 * SEC]) {
      const w = wallMsForTimecode(t, FIXTURE_ANCHORS, SESSION);
      expect(w).toBeGreaterThan(ms(M1.wall));
      expect(w).toBeLessThan(ms(M2.wall));
    }
  });

  it('extrapolates beyond the ends at the session frame rate from the nearest anchor', () => {
    const anchors = timecodeWallAnchors(anchorRows([{ tc: 10 * SEC, wall: M1.wall }, M2, M3]));
    // 5s before the first anchor's timecode → 5s before its wall.
    expect(wallMsForTimecode(5 * SEC, anchors, SESSION)).toBe(ms(M1.wall) - 5000);
    // 10s past the last anchor's timecode → 10s past its wall.
    expect(wallMsForTimecode(M3.tc + 10 * SEC, anchors, SESSION)).toBe(ms(M3.wall) + 10000);
  });

  it('clamped monotone: a later timecode never maps earlier than an earlier one', () => {
    const nonMonotone = timecodeWallAnchors(
      anchorRows([
        { tc: 0, wall: '2026-01-01T12:00:00.000Z' },
        { tc: 30 * MIN, wall: '2026-01-01T11:00:00.000Z' }, // wall regressed
      ]),
    );
    let prev = Number.NEGATIVE_INFINITY;
    for (let t = 0; t <= 40 * MIN; t += 90 * SEC) {
      const w = wallMsForTimecode(t, nonMonotone, SESSION);
      expect(w).toBeGreaterThanOrEqual(prev);
      prev = w;
    }
  });
});

describe('wallMsForTimecode — fallbacks', () => {
  it('one anchor: constant offset from it', () => {
    const one = timecodeWallAnchors(anchorRows([{ tc: 60 * MIN, wall: M2.wall }]));
    expect(wallMsForTimecode(60 * MIN, one, SESSION)).toBe(ms(M2.wall));
    expect(wallMsForTimecode(60 * MIN + 10 * SEC, one, SESSION)).toBe(ms(M2.wall) + 10000);
    expect(wallMsForTimecode(60 * MIN - 10 * SEC, one, SESSION)).toBe(ms(M2.wall) - 10000);
  });

  it('zero anchors: started_at_utc + (tc − startOffsetFrames)/fps', () => {
    const session = { ...SESSION, startOffsetFrames: 2 * MIN };
    expect(wallMsForTimecode(2 * MIN + 10 * SEC, [], session)).toBe(
      ms(SESSION.startedAtUtc) + 10000,
    );
    // Below the start offset: maps before session start (still monotone).
    expect(wallMsForTimecode(2 * MIN - 5 * SEC, [], session)).toBe(ms(SESSION.startedAtUtc) - 5000);
  });

  it('zero anchors + empty started_at_utc: Unix epoch base, ordering preserved', () => {
    const session = { frameRate: FPS, startOffsetFrames: 0, startedAtUtc: '' };
    expect(wallMsForTimecode(10 * SEC, [], session)).toBe(10_000);
    const a = wallMsForTimecode(5 * SEC, [], session);
    const b = wallMsForTimecode(10 * SEC, [], session);
    expect(a).toBeLessThan(b);
  });

  it('non-finite timecode is guarded: clamped nearest-anchor wall, never NaN/±∞ (finding 5)', () => {
    // Precondition is a finite, parser-gated timecode; the guard keeps the
    // function total instead of silently misplacing or throwing in isoZ.
    expect(wallMsForTimecode(Number.POSITIVE_INFINITY, FIXTURE_ANCHORS, SESSION)).toBe(ms(M3.wall));
    expect(wallMsForTimecode(Number.NEGATIVE_INFINITY, FIXTURE_ANCHORS, SESSION)).toBe(ms(M1.wall));
    expect(wallMsForTimecode(Number.NaN, FIXTURE_ANCHORS, SESSION)).toBe(ms(M1.wall));
    // Zero anchors: the session-start base (or epoch), still finite.
    expect(wallMsForTimecode(Number.NaN, [], SESSION)).toBe(ms(SESSION.startedAtUtc));
    expect(wallMsForTimecode(Number.POSITIVE_INFINITY, [], { ...SESSION, startedAtUtc: '' })).toBe(
      0,
    );
    // And the isoZ wrapper therefore cannot throw on the guarded inputs.
    expect(wallTimeUtcForTimecode(Number.NaN, FIXTURE_ANCHORS, SESSION)).toBe(M1.wall);
  });
});

describe('wallTimeUtcForTimecode', () => {
  it('renders the interpolated instant as an isoZ string', () => {
    expect(wallTimeUtcForTimecode(15 * MIN, FIXTURE_ANCHORS, SESSION)).toBe(
      '2026-01-01T11:15:00.000Z',
    );
    expect(wallTimeUtcForTimecode(15 * MIN, FIXTURE_ANCHORS, SESSION)).toBe(
      isoZ(new Date(wallMsForTimecode(15 * MIN, FIXTURE_ANCHORS, SESSION))),
    );
  });
});

describe('feed-order property on the multi-take/paused fixture', () => {
  /** The feed's order (EventStore.listEvents): wall_time_utc ASC, id ASC —
   * both TEXT columns, so lexicographic over isoZ strings + ids. */
  const feedSort = (rows: Array<{ id: string; wall: string }>) =>
    [...rows].sort((x, y) => {
      if (x.wall !== y.wall) return x.wall < y.wall ? -1 : 1;
      return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
    });

  it('generated events sort between bracketing manual events and among themselves in timecode order', () => {
    const manual = [
      { id: 'a-m1', wall: M1.wall },
      { id: 'a-m2', wall: M2.wall },
      { id: 'a-m3', wall: M3.wall },
    ];
    // Generated ids sort BACKWARDS relative to their intended feed position,
    // proving wall_time_utc (not id) carries the ordering.
    const generatedTcs = [5 * MIN, 10 * MIN, 20 * MIN, 35 * MIN, 45 * MIN];
    const generated = generatedTcs.map((tc, i) => ({
      id: `z-g${generatedTcs.length - i}`,
      wall: wallTimeUtcForTimecode(tc, FIXTURE_ANCHORS, SESSION),
    }));
    const order = feedSort([...manual, ...generated]).map((r) => r.id);
    expect(order).toEqual(['a-m1', 'z-g5', 'z-g4', 'z-g3', 'a-m2', 'z-g2', 'a-m3', 'z-g1']);
  });

  it('pseudo-random anchor sets: interpolated walls are monotone over ascending timecodes', () => {
    // Deterministic LCG — no property-testing dep in the repo.
    let seed = 0xdecafbad;
    const rand = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    for (let run = 0; run < 50; run++) {
      const anchorCount = Math.floor(rand() * 5); // 0..4 anchors, incl. fallback arms
      const rows = anchorRows(
        Array.from({ length: anchorCount }, () => ({
          tc: Math.floor(rand() * 24 * 60 * MIN),
          // Deliberately un-ordered walls: clamping must repair monotonicity.
          wall: isoZ(new Date(ms('2026-01-01T00:00:00.000Z') + Math.floor(rand() * 86_400_000))),
        })),
      );
      const anchors = timecodeWallAnchors(rows);
      const tcs = Array.from({ length: 40 }, () => Math.floor(rand() * 24 * 60 * MIN)).sort(
        (x, y) => x - y,
      );
      let prev = Number.NEGATIVE_INFINITY;
      for (const t of tcs) {
        const w = wallMsForTimecode(t, anchors, SESSION);
        expect(w).toBeGreaterThanOrEqual(prev);
        prev = w;
      }
    }
  });
});
