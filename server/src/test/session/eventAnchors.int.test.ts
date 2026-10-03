// The real-store part of the timecode→wall-time anchor helper's tests (auto-generate-event-logs
// task 2.1 / design D4), moved from packages/session-core/src/eventAnchors.test.ts because it needs
// a session database (session-tables D12); the pure cases stay there. The REQUIRED property
// fixture: real TransportStore + EventStore over a real core — a stopped transport freezes the
// timecode, so several rows share one timecode with spread walls.

import {
  timecodeWallAnchors,
  wallMsForTimecode,
  wallTimeUtcForTimecode,
} from '@autologger/session-core/eventAnchors';
import { EventStore } from '@autologger/session-core/eventStore';
import { TransportStore } from '@autologger/session-core/transportStore';
import { describe, expect, it } from 'vitest';
import { fakeRuntime } from './fakeCore';

const FPS = 30;

const ms = (iso: string): number => Date.parse(iso);

describe('bracketing over a REAL multi-take store (spec invariant; Phase-2 fix wave Critical 1)', () => {
  /** Real TransportStore + EventStore over a real in-memory core. A stopped
   * transport FREEZES the timecode, so the take-1 stop row, two operator
   * notes, and the next take's `Recording 2 Started` all carry tc 600 with
   * walls spread across 20 minutes of dead air — several rows sharing one
   * timecode, the shape a synthetic distinct-timecode fixture never produces.
   *
   * Timeline @30fps (startOffsetFrames 0):
   * - 10:00:00 startTake (take 1) + `Recording 1 Started`  → tc 0
   * - 10:00:20 stopTake (banks 600 frames) + `Recording 1 Stopped` → tc 600
   * - 10:05:00 operator note                                → tc 600
   * - 10:15:00 operator note                                → tc 600
   * - 10:20:00 `Recording 2 Started` + startTake (take 2)   → tc 600
   * - 10:20:10 take-2 operator note                         → tc 900
   */
  const CTX = { frameRate: FPS, startOffsetFrames: 0 };
  const REAL_SESSION = { ...CTX, startedAtUtc: '2026-01-01T10:00:00.000Z' };

  async function multiTakeFixture(opts: { includeTake2Note?: boolean } = {}) {
    const { includeTake2Note = true } = opts;
    const rt = await fakeRuntime();
    const transport = new TransportStore(rt.core);
    const events = new EventStore(rt.core);
    const at = (iso: string): void => {
      rt.time.now = Date.parse(iso);
    };
    const log = async (category: string, message: string): Promise<void> => {
      await events.addEvent({ category, message, metadataJson: '', markedAtUtc: null, ctx: CTX });
    };
    at('2026-01-01T10:00:00.000Z');
    await transport.startTake(CTX);
    await log('internal', 'Recording 1 Started');
    at('2026-01-01T10:00:20.000Z');
    await transport.stopTake(CTX);
    await log('internal', 'Recording 1 Stopped');
    at('2026-01-01T10:05:00.000Z');
    await log('note', 'note-1005');
    at('2026-01-01T10:15:00.000Z');
    await log('note', 'note-1015');
    at('2026-01-01T10:20:00.000Z');
    await log('internal', 'Recording 2 Started');
    await transport.startTake(CTX);
    if (includeTake2Note) {
      at('2026-01-01T10:20:10.000Z');
      await log('note', 'note-take2');
    }
    return { rt, transport, events };
  }

  async function fixtureRowsAndAnchors(opts: { includeTake2Note?: boolean } = {}) {
    const { includeTake2Note = true } = opts;
    const { events } = await multiTakeFixture({ includeTake2Note });
    const rows = (await events.listEvents({ limit: 100, offset: 0 })).events;
    // Sanity: the REAL stores produced the frozen-timecode shape claimed above.
    expect(rows.map((r) => [r.message, r.timecode_total_frames])).toEqual(
      includeTake2Note
        ? [
            ['Recording 1 Started', 0],
            ['Recording 1 Stopped', 600],
            ['note-1005', 600],
            ['note-1015', 600],
            ['Recording 2 Started', 600],
            ['note-take2', 900],
          ]
        : [
            ['Recording 1 Started', 0],
            ['Recording 1 Stopped', 600],
            ['note-1005', 600],
            ['note-1015', 600],
            ['Recording 2 Started', 600],
          ],
    );
    return { events, rows, anchors: timecodeWallAnchors(rows) };
  }

  it('take-2 timecodes (630/750/890) map after EVERY tc-600 row and before the tc-900 row', async () => {
    const { rows, anchors } = await fixtureRowsAndAnchors();
    const tc600Walls = rows
      .filter((r) => r.timecode_total_frames === 600)
      .map((r) => Date.parse(r.wall_time_utc));
    const wall900 = Date.parse(
      (rows.find((r) => r.timecode_total_frames === 900) as { wall_time_utc: string })
        .wall_time_utc,
    );
    for (const tc of [630, 750, 890]) {
      const w = wallMsForTimecode(tc, anchors, REAL_SESSION);
      for (const anchorWall of tc600Walls) {
        expect(w, `tc ${tc} must land after every tc-600 row`).toBeGreaterThan(anchorWall);
      }
      expect(w, `tc ${tc} must land before the tc-900 row`).toBeLessThan(wall900);
    }
  });

  it('with the take-2 note omitted, tc 630 (past the now-LAST tc-600 anchor) lands after every tc-600 row', async () => {
    // Drops note-take2 so the frozen tc-600 group is the LAST anchor, forcing
    // the `timecodeTotalFrames >= last.timecodeTotalFrames` end-clamp arm
    // (extrapolation from `last.wallHiMs`) instead of the mid-segment
    // interpolation the other cases in this block exercise.
    const { rows, anchors } = await fixtureRowsAndAnchors({ includeTake2Note: false });
    const tc600Walls = rows
      .filter((r) => r.timecode_total_frames === 600)
      .map((r) => Date.parse(r.wall_time_utc));
    const w = wallMsForTimecode(630, anchors, REAL_SESSION);
    for (const anchorWall of tc600Walls) {
      expect(w, 'tc 630 must land after every tc-600 row').toBeGreaterThan(anchorWall);
    }
  });

  it('a generated tc-300 event lands inside take 1 (10:00:00–10:00:20)', async () => {
    const { anchors } = await fixtureRowsAndAnchors();
    const w = wallMsForTimecode(300, anchors, REAL_SESSION);
    expect(w).toBeGreaterThan(ms('2026-01-01T10:00:00.000Z'));
    expect(w).toBeLessThan(ms('2026-01-01T10:00:20.000Z'));
  });

  it('inserted via explicitAnchor, generated rows take their bracketed feed positions', async () => {
    const { events, rows, anchors } = await fixtureRowsAndAnchors();
    const gen: Array<[number, string]> = [
      [300, 'gen-300'],
      [630, 'gen-630'],
      [750, 'gen-750'],
      [890, 'gen-890'],
    ];
    for (const [tc, message] of gen) {
      await events.addEvent({
        category: 'note',
        message,
        metadataJson: '',
        markedAtUtc: null,
        ctx: CTX,
        explicitAnchor: {
          timecodeTotalFrames: tc,
          wallTimeUtc: wallTimeUtcForTimecode(tc, anchors, REAL_SESSION),
        },
      });
    }
    expect(rows).toHaveLength(6); // pre-insert snapshot unaffected
    const order = (await events.listEvents({ limit: 100, offset: 0 })).events.map((e) => e.message);
    expect(order).toEqual([
      'Recording 1 Started',
      'gen-300',
      'Recording 1 Stopped',
      'note-1005',
      'note-1015',
      'Recording 2 Started',
      'gen-630',
      'gen-750',
      'gen-890',
      'note-take2',
    ]);
  });
});
