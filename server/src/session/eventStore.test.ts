import { describe, expect, it } from 'vitest';
import { fakeRuntime } from '../test/fakeCore';
import { formatSmpte, fromTotalFrames, isoZ } from '../timecode';
import { EventStore, eventRowToRpc } from './eventStore';

describe('eventRowToRpc', () => {
  it('maps a row with a timecode', () => {
    const r = {
      id: 'e1',
      wall_time_utc: '2026-06-25T00:00:00.000Z',
      frame_rate: 24,
      timecode_total_frames: 48,
      category: 'note',
      message: 'hi',
      metadata_json: '{"a":1}',
    };
    expect(eventRowToRpc(r)).toEqual({
      event_id: 'e1',
      wall_time_utc: '2026-06-25T00:00:00.000Z',
      timecode: formatSmpte(fromTotalFrames(48, 24)),
      frame_rate: 24,
      timecode_total_frames: 48,
      category: 'note',
      message: 'hi',
      metadata_json: '{"a":1}',
    });
  });

  it('nulls timecode fields when timecode_total_frames is absent, defaults metadata', () => {
    const r = {
      id: 'e2',
      wall_time_utc: '2026-06-25T00:00:01.000Z',
      frame_rate: 24,
      timecode_total_frames: null,
      category: 'internal',
      message: 'rec start',
      metadata_json: null,
    };
    expect(eventRowToRpc(r)).toEqual({
      event_id: 'e2',
      wall_time_utc: '2026-06-25T00:00:01.000Z',
      timecode: null,
      frame_rate: null,
      timecode_total_frames: null,
      category: 'internal',
      message: 'rec start',
      metadata_json: '{}',
    });
  });
});

// code-health-tail task 2.2 (design D10) — behavior pin over a REAL core
// (in-memory SQLite), written BEFORE the count SQL moved into
// core.eventCounts(): listEvents' total/loggedTotal must exclude
// internal-category rows regardless of casing/whitespace, and near-miss
// categories must still count as logged.
describe('listEvents counts over a real core (D10 pin)', () => {
  it('total counts every event; loggedTotal excludes internal (any casing/whitespace)', () => {
    const { core } = fakeRuntime();
    const categories = [
      'mark', // logged
      'note', // logged
      'internal', // filtered
      'Internal', // filtered (casing)
      ' INTERNAL ', // filtered (casing + surrounding spaces)
      '\tinternal', // logged — SQLite trim() strips SPACES only, a tab survives
      'INTERNAL', // filtered
      'internally', // logged
      'x internal', // logged
    ];
    categories.forEach((cat, i) => {
      core.db.run(
        `INSERT INTO events (id, wall_time_utc, frame_rate, category, message)
         VALUES (?, ?, ?, ?, ?)`,
        `e${i}`,
        '2026-06-25T00:00:00.000Z',
        30,
        cat,
        `m${i}`,
      );
    });
    const out = new EventStore(core).listEvents({ limit: 100, offset: 0 });
    expect(out.total).toBe(9);
    expect(out.loggedTotal).toBe(5);
    expect(out.events).toHaveLength(9);
  });
});

// auto-generate-event-logs task 2.3 (design D4) — ONE insert path: addEvent
// gains an optional explicit-anchor parameter; when absent, behavior is
// byte-identical to today (pinned below over a real rolling transport), and
// when present the timecodeForMark derivation is bypassed entirely.
describe('addEvent over a real core', () => {
  /** Rolling transport at a known instant: roll started 5s before the fake
   * clock's default now (1_000_000ms), 50 frames already banked. */
  function rollingFixture() {
    const rt = fakeRuntime();
    rt.core.db.run(
      'UPDATE session_transport SET is_rolling = ?, current_take = ?, roll_started_at_utc = ?, elapsed_frames = ? WHERE id = 1',
      1,
      1,
      isoZ(new Date(995_000)),
      50,
    );
    return rt;
  }
  const ctx = { frameRate: 24, startOffsetFrames: 100 };

  describe('manual path (parameter absent) — byte-identical pin', () => {
    it('derives via timecodeForMark from the rolling transport at now(), broadcasts one event.changed', () => {
      const { core, broadcasts } = rollingFixture();
      const out = new EventStore(core).addEvent({
        category: 'note',
        message: 'hi',
        metadataJson: '',
        markedAtUtc: null,
        ctx,
      });
      // 100 offset + 50 elapsed + trunc(5s * 24fps) = 270
      expect(out.event).toEqual({
        event_id: out.event.event_id,
        wall_time_utc: '1970-01-01T00:16:40.000Z',
        timecode: formatSmpte(fromTotalFrames(270, 24)),
        frame_rate: 24,
        timecode_total_frames: 270,
        category: 'note',
        message: 'hi',
        metadata_json: '{}',
      });
      expect(out.projection.event_count).toBe(1);
      expect(out.projection.max_timecode_total_frames).toBe(270);
      expect(broadcasts).toEqual([{ type: 'event.changed', revision: 1 }]);
      // Pin the INSERT columns on the raw row, not just the RPC mapping.
      const r = core.first('SELECT * FROM events WHERE id = ?', out.event.event_id);
      expect(r).toEqual({
        id: out.event.event_id,
        wall_time_utc: '1970-01-01T00:16:40.000Z',
        frame_rate: 24,
        timecode_total_frames: 270,
        category: 'note',
        message: 'hi',
        metadata_json: '{}',
      });
    });

    it('honors markedAtUtc as the mark instant for both wall time and timecode', () => {
      const { core, broadcasts } = rollingFixture();
      const out = new EventStore(core).addEvent({
        category: 'note',
        message: 'marked',
        metadataJson: '{"a":1}',
        markedAtUtc: '1970-01-01T00:16:37.000Z', // 2s after roll start
        ctx,
      });
      // 100 offset + 50 elapsed + trunc(2s * 24fps) = 198
      expect(out.event.wall_time_utc).toBe('1970-01-01T00:16:37.000Z');
      expect(out.event.timecode_total_frames).toBe(198);
      expect(out.event.metadata_json).toBe('{"a":1}');
      expect(broadcasts).toEqual([{ type: 'event.changed', revision: 1 }]);
    });
  });

  describe('explicit anchor (design D4)', () => {
    it('stores the given frames + wall time verbatim, bypassing the transport derivation', () => {
      const { core, broadcasts } = rollingFixture();
      const out = new EventStore(core).addEvent({
        category: 'note',
        message: 'generated',
        metadataJson: '{"auto_generated":true}',
        markedAtUtc: null,
        ctx,
        explicitAnchor: {
          timecodeTotalFrames: 12345,
          wallTimeUtc: '2026-06-25T00:01:00.000Z',
        },
      });
      expect(out.event).toEqual({
        event_id: out.event.event_id,
        wall_time_utc: '2026-06-25T00:01:00.000Z',
        timecode: formatSmpte(fromTotalFrames(12345, 24)),
        frame_rate: 24,
        timecode_total_frames: 12345,
        category: 'note',
        message: 'generated',
        metadata_json: '{"auto_generated":true}',
      });
      expect(out.projection.event_count).toBe(1);
      expect(out.projection.max_timecode_total_frames).toBe(12345);
      expect(broadcasts).toEqual([{ type: 'event.changed', revision: 1 }]);
      const r = core.first('SELECT * FROM events WHERE id = ?', out.event.event_id);
      expect(r).toEqual({
        id: out.event.event_id,
        wall_time_utc: '2026-06-25T00:01:00.000Z',
        frame_rate: 24,
        timecode_total_frames: 12345,
        category: 'note',
        message: 'generated',
        metadata_json: '{"auto_generated":true}',
      });
    });

    it('stores frame_rate rounded from ctx exactly as the manual path does (29.97)', () => {
      const { core } = fakeRuntime();
      const out = new EventStore(core).addEvent({
        category: 'note',
        message: 'df',
        metadataJson: '',
        markedAtUtc: null,
        ctx: { frameRate: 29.97, startOffsetFrames: 0 },
        explicitAnchor: { timecodeTotalFrames: 60, wallTimeUtc: '2026-06-25T00:00:02.000Z' },
      });
      expect(out.event.frame_rate).toBe(29.97);
      expect(out.event.timecode).toBe(formatSmpte(fromTotalFrames(60, 29.97)));
      expect(out.event.metadata_json).toBe('{}');
    });

    it('still honors suppressBroadcast (same broadcast handling as the manual path)', () => {
      const { core, broadcasts } = fakeRuntime();
      new EventStore(core).addEvent({
        category: 'note',
        message: 'quiet',
        metadataJson: '',
        markedAtUtc: null,
        ctx,
        explicitAnchor: { timecodeTotalFrames: 1, wallTimeUtc: '2026-06-25T00:00:00.000Z' },
        suppressBroadcast: true,
      });
      expect(broadcasts).toEqual([]);
      expect(core.revision()).toBe(1); // revision still bumps
    });

    it('interleaves per wall_time_utc ASC among manual events in listEvents', () => {
      const { core } = fakeRuntime();
      const store = new EventStore(core);
      store.addEvent({
        category: 'note',
        message: 'first-manual',
        metadataJson: '',
        markedAtUtc: '2026-06-25T00:00:00.000Z',
        ctx,
      });
      store.addEvent({
        category: 'note',
        message: 'second-manual',
        metadataJson: '',
        markedAtUtc: '2026-06-25T00:02:00.000Z',
        ctx,
      });
      store.addEvent({
        category: 'note',
        message: 'generated-between',
        metadataJson: '',
        markedAtUtc: null,
        ctx,
        explicitAnchor: {
          timecodeTotalFrames: 24 * 60,
          wallTimeUtc: '2026-06-25T00:01:00.000Z',
        },
      });
      const out = store.listEvents({ limit: 10, offset: 0 });
      expect(out.events.map((e) => e.message)).toEqual([
        'first-manual',
        'generated-between',
        'second-manual',
      ]);
    });
  });
});
