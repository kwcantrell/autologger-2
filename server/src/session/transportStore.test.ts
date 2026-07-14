import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionCore, TimecodeCtx } from './sessionCore';
import { TransportStore } from './transportStore';

interface TRow {
  is_rolling: boolean;
  current_take: number;
  roll_started_at_utc: string | null;
  elapsed_frames: number;
}

function fakeCore(initial: Partial<TRow> = {}) {
  const row: TRow = {
    is_rolling: false,
    current_take: 0,
    roll_started_at_utc: null,
    elapsed_frames: 0,
    ...initial,
  };
  const broadcasts: unknown[] = [];
  const core = {
    now: (): number => Date.now(), // vitest fake timers control this
    get db() {
      return {
        run: (sql: string, ...args: unknown[]): { changes: number } => {
          if (sql.includes('is_rolling = 1')) {
            row.is_rolling = true;
            row.current_take = args[0] as number;
            row.roll_started_at_utc = args[1] as string;
          } else if (sql.includes('is_rolling = 0')) {
            row.is_rolling = false;
            row.roll_started_at_utc = null;
            row.elapsed_frames = args[0] as number;
          }
          return { changes: 1 };
        },
      };
    },
    transportRow: (): TRow => ({ ...row }),
    broadcast: (m: unknown): void => void broadcasts.push(m),
    projection: () => ({
      event_count: 0,
      max_timecode_total_frames: null,
      is_rolling: row.is_rolling,
      current_take: row.current_take,
      transport_elapsed_frames: row.elapsed_frames,
      roll_started_at_utc: row.roll_started_at_utc,
    }),
    first: (sql: string): { c: number } => (sql.includes("!= 'internal'") ? { c: 2 } : { c: 3 }),
    revision: (): number => 7,
  };
  return { core: core as unknown as SessionCore, row, broadcasts };
}

const CTX: TimecodeCtx = { frameRate: 30, startOffsetFrames: 0 };

describe('TransportStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-25T00:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('startTake on an idle transport rolls, increments take, broadcasts', () => {
    const { core, row, broadcasts } = fakeCore();
    const store = new TransportStore(core);
    const { state } = store.startTake(CTX);
    expect(state.started).toBe(true);
    expect(row.is_rolling).toBe(true);
    expect(row.current_take).toBe(1);
    expect(broadcasts).toEqual([{ type: 'transport.changed', is_rolling: true, current_take: 1 }]);
  });

  it('startTake while already rolling is a no-op (started=false, take unchanged)', () => {
    const { core, row } = fakeCore({ is_rolling: true, current_take: 4 });
    const store = new TransportStore(core);
    const { state } = store.startTake(CTX);
    expect(state.started).toBe(false);
    expect(row.current_take).toBe(4);
  });

  it('stopTake accumulates elapsed_frames = trunc(seconds * frameRate)', () => {
    const { core, row } = fakeCore({
      is_rolling: true,
      current_take: 1,
      roll_started_at_utc: '2026-06-25T00:00:00.000Z',
      elapsed_frames: 0,
    });
    const store = new TransportStore(core);
    vi.setSystemTime(new Date('2026-06-25T00:00:05.000Z')); // 5s @ 30fps = 150 frames
    const { state } = store.stopTake(CTX);
    expect(state.stopped).toBe(true);
    expect(row.is_rolling).toBe(false);
    expect(row.roll_started_at_utc).toBe(null);
    expect(row.elapsed_frames).toBe(150);
  });

  it('stopTake while idle is a no-op (stopped=false)', () => {
    const { core } = fakeCore({ is_rolling: false });
    const store = new TransportStore(core);
    const { state } = store.stopTake(CTX);
    expect(state.stopped).toBe(false);
  });

  it('stopTakeWithDuration adds trunc(durationS * frameRate) to elapsed_frames', () => {
    const { core, row } = fakeCore({ is_rolling: true, elapsed_frames: 10 });
    const store = new TransportStore(core);
    store.stopTakeWithDuration({ durationS: 2, ctx: CTX }); // 2s @ 30fps = 60
    expect(row.elapsed_frames).toBe(70);
    expect(row.is_rolling).toBe(false);
  });

  it('statusLive reports event counts and revision', () => {
    const { core } = fakeCore({ is_rolling: true, current_take: 3 });
    const store = new TransportStore(core);
    const s = store.statusLive(CTX);
    expect(s.is_rolling).toBe(true);
    expect(s.current_take).toBe(3);
    expect(s.event_count).toBe(3);
    expect(s.logged_event_count).toBe(2);
    expect(s.events_stream_revision).toBe(7);
  });
});
