import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TimecodeCtx } from '@autologger/session-core/sessionCore';
import { boundCore } from './boundCore';
import { insertRaw, type TestStorage } from './sessionRows';

interface TRow {
  is_rolling: boolean;
  current_take: number;
  roll_started_at_utc: string | null;
  elapsed_frames: number;
}

// A REAL core over the bound-core harness (code-health-tail task 5.2,
// session-tables D12) — transport writes hit the real session_transport
// row, and the initial state is seeded into it directly. The clock follows
// Date.now() so vitest's faked Date controls it, as before (only Date is faked:
// the database driver needs real timers).
async function setup(initial: Partial<TRow> = {}) {
  const { run, read, storage, broadcasts } = await boundCore({ now: () => Date.now() });
  await run((s) =>
    s.core.db.run(
      'UPDATE session_transport SET is_rolling = ?, current_take = ?, roll_started_at_utc = ?, elapsed_frames = ? WHERE session_id = ?',
      initial.is_rolling ? 1 : 0,
      initial.current_take ?? 0,
      initial.roll_started_at_utc ?? null,
      initial.elapsed_frames ?? 0,
      s.core.sessionId,
    ),
  );
  return { run, read, storage, broadcasts };
}

const CTX: TimecodeCtx = { frameRate: 30, startOffsetFrames: 0 };

describe('TransportStore', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-25T00:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('startTake on an idle transport rolls, increments take, broadcasts', async () => {
    const { run, read, broadcasts } = await setup();
    const { state } = await run((s) => s.transport.startTake(CTX));
    expect(state.started).toBe(true);
    const row = await read((t) => t.core.transportRow());
    expect(row.is_rolling).toBe(true);
    expect(row.current_take).toBe(1);
    expect(broadcasts).toEqual([{ type: 'transport.changed', is_rolling: true, current_take: 1 }]);
  });

  it('startTake while already rolling is a no-op (started=false, take unchanged)', async () => {
    const { run, read } = await setup({ is_rolling: true, current_take: 4 });
    const { state } = await run((s) => s.transport.startTake(CTX));
    expect(state.started).toBe(false);
    expect((await read((t) => t.core.transportRow())).current_take).toBe(4);
  });

  it('stopTake accumulates elapsed_frames = trunc(seconds * frameRate)', async () => {
    const { run, read } = await setup({
      is_rolling: true,
      current_take: 1,
      roll_started_at_utc: '2026-06-25T00:00:00.000Z',
      elapsed_frames: 0,
    });
    vi.setSystemTime(new Date('2026-06-25T00:00:05.000Z')); // 5s @ 30fps = 150 frames
    const { state } = await run((s) => s.transport.stopTake(CTX));
    expect(state.stopped).toBe(true);
    const row = await read((t) => t.core.transportRow());
    expect(row.is_rolling).toBe(false);
    expect(row.roll_started_at_utc).toBe(null);
    expect(row.elapsed_frames).toBe(150);
  });

  it('stopTake while idle is a no-op (stopped=false)', async () => {
    const { run } = await setup({ is_rolling: false });
    const { state } = await run((s) => s.transport.stopTake(CTX));
    expect(state.stopped).toBe(false);
  });

  it('stopTakeWithDuration adds trunc(durationS * frameRate) to elapsed_frames and broadcasts transport.changed', async () => {
    const { run, read, broadcasts } = await setup({
      is_rolling: true,
      current_take: 2,
      elapsed_frames: 10,
    });
    await run((s) => s.transport.stopTakeWithDuration({ durationS: 2, ctx: CTX })); // 2s @ 30fps = 60
    const row = await read((t) => t.core.transportRow());
    expect(row.elapsed_frames).toBe(70);
    expect(row.is_rolling).toBe(false);
    expect(broadcasts).toEqual([{ type: 'transport.changed', is_rolling: false, current_take: 2 }]);
  });

  // Phase-9 fix-wave (finding 1): `suppressBroadcast` lets
  // SessionHub.anchorImportedTake's composite RPC apply this write inside its
  // `inTxn` without a mid-transaction broadcast, then fire the equivalent
  // broadcast itself once the transaction commits.
  it('stopTakeWithDuration({ suppressBroadcast: true }) still applies the DB write but broadcasts nothing', async () => {
    const { run, read, broadcasts } = await setup({
      is_rolling: true,
      current_take: 2,
      elapsed_frames: 10,
    });
    await run((s) =>
      s.transport.stopTakeWithDuration({ durationS: 2, ctx: CTX, suppressBroadcast: true }),
    );
    const row = await read((t) => t.core.transportRow());
    expect(row.elapsed_frames).toBe(70);
    expect(row.is_rolling).toBe(false);
    expect(broadcasts).toEqual([]);
  });

  it('statusLive reports event counts and revision', async () => {
    const { run, read, storage } = await setup({ is_rolling: true, current_take: 3 });
    // Real rows behind the same numbers the old stubs returned: 3 events of
    // which 2 are logged (one `internal`), and a revision advanced to 7 by seven changing writes
    // (session-row-versions D2).
    await seedEvents(storage, ['mark', 'note', 'internal']);
    const before = await read((t) => t.core.revision());
    for (let i = 0; i < 7; i += 1) await run((t) => t.core.metaSet('k', String(i)));
    const s = await read((t) => t.transport.statusLive(CTX));
    expect(s.is_rolling).toBe(true);
    expect(s.current_take).toBe(3);
    expect(s.event_count).toBe(3);
    expect(s.logged_event_count).toBe(2);
    expect(s.events_stream_revision).toBe(before + 7);
  });
});

async function seedEvents(storage: TestStorage, categories: string[]): Promise<void> {
  for (const [i, cat] of categories.entries()) {
    await insertRaw(storage, 'session_events', {
      id: `e${i}`,
      wall_time_utc: '2026-06-25T00:00:00.000Z',
      frame_rate: 30,
      category: cat,
      message: `m${i}`,
    });
  }
}

// code-health-tail task 2.2 (design D10) — behavior pin over a REAL core
// (in-memory SQLite then; Postgres since session-tables), written BEFORE the
// count SQL moved into core.eventCounts(). The `lower(trim(category)) != 'internal'` filter's
// subtleties are the point: internal-category rows with odd casing/whitespace
// are excluded from logged_event_count; near-misses ('internally', 'x internal')
// are not.
describe('statusLive event counts over a real core (D10 pin)', () => {
  it('excludes internal-category events (any casing/whitespace) from logged_event_count only', async () => {
    const { read, storage } = await boundCore();
    await seedEvents(storage, [
      'mark', // logged
      'note', // logged
      'internal', // filtered
      'Internal', // filtered (casing)
      ' INTERNAL ', // filtered (casing + surrounding spaces)
      '\tinternal', // logged — trim() strips SPACES only, a tab survives
      'INTERNAL', // filtered
      'internally', // logged — trim/lower never turns this into 'internal'
      'x internal', // logged — interior match is not a match
    ]);
    const s = await read((t) => t.transport.statusLive({ frameRate: 30, startOffsetFrames: 0 }));
    expect(s.event_count).toBe(9);
    expect(s.logged_event_count).toBe(5);
  });

  it('reports zero counts on an empty events table', async () => {
    const { read } = await boundCore();
    const s = await read((t) => t.transport.statusLive({ frameRate: 30, startOffsetFrames: 0 }));
    expect(s.event_count).toBe(0);
    expect(s.logged_event_count).toBe(0);
  });
});
