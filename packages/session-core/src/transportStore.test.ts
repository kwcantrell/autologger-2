import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionCore, TimecodeCtx } from './sessionCore';
import { fakeRuntime } from './test/fakeCore';
import { TransportStore } from './transportStore';

interface TRow {
  is_rolling: boolean;
  current_take: number;
  roll_started_at_utc: string | null;
  elapsed_frames: number;
}

// A REAL core over the shared typed fake runtime (code-health-tail task 5.2)
// — replaces this file's hand-rolled cast fake and its SQL string-sniffing
// `db.run`/`first` stubs: transport writes now hit the real session_transport
// row, and the initial state is seeded into it directly. The clock follows
// Date.now() so vitest fake timers control it, as before.
function setup(initial: Partial<TRow> = {}) {
  const { core, broadcasts } = fakeRuntime({ now: () => Date.now() });
  core.db.run(
    'UPDATE session_transport SET is_rolling = ?, current_take = ?, roll_started_at_utc = ?, elapsed_frames = ? WHERE id = 1',
    initial.is_rolling ? 1 : 0,
    initial.current_take ?? 0,
    initial.roll_started_at_utc ?? null,
    initial.elapsed_frames ?? 0,
  );
  return { core, broadcasts };
}

const CTX: TimecodeCtx = { frameRate: 30, startOffsetFrames: 0 };

describe('TransportStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-25T00:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('startTake on an idle transport rolls, increments take, broadcasts', () => {
    const { core, broadcasts } = setup();
    const store = new TransportStore(core);
    const { state } = store.startTake(CTX);
    expect(state.started).toBe(true);
    const row = core.transportRow();
    expect(row.is_rolling).toBe(true);
    expect(row.current_take).toBe(1);
    expect(broadcasts).toEqual([{ type: 'transport.changed', is_rolling: true, current_take: 1 }]);
  });

  it('startTake while already rolling is a no-op (started=false, take unchanged)', () => {
    const { core } = setup({ is_rolling: true, current_take: 4 });
    const store = new TransportStore(core);
    const { state } = store.startTake(CTX);
    expect(state.started).toBe(false);
    expect(core.transportRow().current_take).toBe(4);
  });

  it('stopTake accumulates elapsed_frames = trunc(seconds * frameRate)', () => {
    const { core } = setup({
      is_rolling: true,
      current_take: 1,
      roll_started_at_utc: '2026-06-25T00:00:00.000Z',
      elapsed_frames: 0,
    });
    const store = new TransportStore(core);
    vi.setSystemTime(new Date('2026-06-25T00:00:05.000Z')); // 5s @ 30fps = 150 frames
    const { state } = store.stopTake(CTX);
    expect(state.stopped).toBe(true);
    const row = core.transportRow();
    expect(row.is_rolling).toBe(false);
    expect(row.roll_started_at_utc).toBe(null);
    expect(row.elapsed_frames).toBe(150);
  });

  it('stopTake while idle is a no-op (stopped=false)', () => {
    const { core } = setup({ is_rolling: false });
    const store = new TransportStore(core);
    const { state } = store.stopTake(CTX);
    expect(state.stopped).toBe(false);
  });

  it('stopTakeWithDuration adds trunc(durationS * frameRate) to elapsed_frames and broadcasts transport.changed', () => {
    const { core, broadcasts } = setup({
      is_rolling: true,
      current_take: 2,
      elapsed_frames: 10,
    });
    const store = new TransportStore(core);
    store.stopTakeWithDuration({ durationS: 2, ctx: CTX }); // 2s @ 30fps = 60
    const row = core.transportRow();
    expect(row.elapsed_frames).toBe(70);
    expect(row.is_rolling).toBe(false);
    expect(broadcasts).toEqual([{ type: 'transport.changed', is_rolling: false, current_take: 2 }]);
  });

  // Phase-9 fix-wave (finding 1): `suppressBroadcast` lets
  // SessionHub.anchorImportedTake's composite RPC apply this write inside its
  // `inTxn` without a mid-transaction broadcast, then fire the equivalent
  // broadcast itself once the transaction commits.
  it('stopTakeWithDuration({ suppressBroadcast: true }) still applies the DB write but broadcasts nothing', () => {
    const { core, broadcasts } = setup({
      is_rolling: true,
      current_take: 2,
      elapsed_frames: 10,
    });
    const store = new TransportStore(core);
    store.stopTakeWithDuration({ durationS: 2, ctx: CTX, suppressBroadcast: true });
    const row = core.transportRow();
    expect(row.elapsed_frames).toBe(70);
    expect(row.is_rolling).toBe(false);
    expect(broadcasts).toEqual([]);
  });

  it('statusLive reports event counts and revision', () => {
    const { core } = setup({ is_rolling: true, current_take: 3 });
    // Real rows behind the same numbers the old stubs returned: 3 events of
    // which 2 are logged (one `internal`), and a revision bumped to 7.
    seedEvents(core, ['mark', 'note', 'internal']);
    for (let i = 0; i < 7; i += 1) core.bumpRevision();
    const store = new TransportStore(core);
    const s = store.statusLive(CTX);
    expect(s.is_rolling).toBe(true);
    expect(s.current_take).toBe(3);
    expect(s.event_count).toBe(3);
    expect(s.logged_event_count).toBe(2);
    expect(s.events_stream_revision).toBe(7);
  });
});

function seedEvents(core: SessionCore, categories: string[]): void {
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
}

// code-health-tail task 2.2 (design D10) — behavior pin over a REAL core
// (in-memory SQLite), written BEFORE the count SQL moved into
// core.eventCounts(). The `lower(trim(category)) != 'internal'` filter's
// subtleties are the point: internal-category rows with odd casing/whitespace
// are excluded from logged_event_count; near-misses ('internally', 'x internal')
// are not.
describe('statusLive event counts over a real core (D10 pin)', () => {
  it('excludes internal-category events (any casing/whitespace) from logged_event_count only', () => {
    const { core } = fakeRuntime();
    seedEvents(core, [
      'mark', // logged
      'note', // logged
      'internal', // filtered
      'Internal', // filtered (casing)
      ' INTERNAL ', // filtered (casing + surrounding spaces)
      '\tinternal', // logged — SQLite trim() strips SPACES only, a tab survives
      'INTERNAL', // filtered
      'internally', // logged — trim/lower never turns this into 'internal'
      'x internal', // logged — interior match is not a match
    ]);
    const s = new TransportStore(core).statusLive({ frameRate: 30, startOffsetFrames: 0 });
    expect(s.event_count).toBe(9);
    expect(s.logged_event_count).toBe(5);
  });

  it('reports zero counts on an empty events table', () => {
    const { core } = fakeRuntime();
    const s = new TransportStore(core).statusLive({ frameRate: 30, startOffsetFrames: 0 });
    expect(s.event_count).toBe(0);
    expect(s.logged_event_count).toBe(0);
  });
});
