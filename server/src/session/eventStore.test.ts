import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { formatSmpte, fromTotalFrames } from '../timecode';
import { sqliteSessionSql } from './SessionHub';
import { EventStore, eventRowToRpc } from './eventStore';
import { SessionCore, type SessionRuntime } from './sessionCore';

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
    const runtime: SessionRuntime = {
      sql: sqliteSessionSql(new Database(':memory:')),
      clock: { now: () => 1_000_000 },
      sockets: () => [],
      setAlarm: () => {},
    };
    const core = new SessionCore(runtime);
    core.initSchema();
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
