// Conformance checks for the CLIENT-WRONG findings corrected by
// `openspec/changes/web-api-shape-conformance` task 3.5 (audit.md §6, CW-1…CW-9).
//
// WHY THESE ARE TYPE-LEVEL, NOT BEHAVIOURAL. Eight of the nine findings are
// *latent*: the client declared a field the server never emits (or narrower
// than it emits) and **no component reads it**. Nothing observable changes when
// such a type is wrong, so there is no runtime behaviour to assert — the type
// checker is the only instrument that can catch the defect. Each finding below
// therefore gets a `const emitted = {…}` literal in the shape the server
// actually emits (transcribed from the producing function named in the audit's
// "evidence read" column) and an assignment of it to the client type. `npm run
// typecheck` is the gate: reintroducing a deleted field, re-narrowing a widened
// one, or collapsing a split type makes one of these assignments fail to
// compile. The one finding with live consequences (CW-5, `duration_sec`) also
// has behavioural coverage — see `useAudioClips.durationProbe.test.tsx`.
//
// ADDITIVE TOLERANCE IS PRESERVED BY CONSTRUCTION. Every literal is bound to a
// `const` first and only then assigned to the client type. That makes the
// expression non-fresh, so TypeScript's excess-property check does not fire and
// a response carrying keys the client does not declare still passes — the
// forward-compatibility property the spec requires. Two literals below
// deliberately carry an undeclared key to keep that honest.
//
// THESE ARE TRANSCRIPTIONS, NOT CAPTURES. Phase 4 replaces them with fixtures
// recorded from real server responses; until then they encode a *read* of the
// producing function, which is exactly the weaker evidence the spec warns
// about. They are here because task 3.5 requires a test per corrected shape.

import { describe, expect, it } from 'vitest';
import type {
  TransportStartResponse,
  TransportStateSnapshot,
  TransportStopResponse,
} from './types';

describe('CW-1 — transport start/stop emit the transport state, not `{ok}`', () => {
  // Server: `TransportStore.startTake` → `{...transportStateDict(ctx), started}`.
  const startEmitted = {
    is_rolling: true,
    current_take: 1,
    roll_started_at_utc: '2026-07-27T00:00:00Z',
    elapsed_frames: 0,
    timecode: '00:00:00:00',
    timecode_total_frames: 0,
    started: true,
  };
  // Server: `TransportStore.stopTake` → `{...transportStateDict(ctx), stopped}`.
  // The already-stopped early return emits `stopped: false` with no DB write.
  const stopEmitted = {
    is_rolling: false,
    current_take: 1,
    roll_started_at_utc: null,
    elapsed_frames: 240,
    timecode: '00:00:10:00',
    timecode_total_frames: 240,
    stopped: false,
  };

  it('the emitted start body is assignable to TransportStartResponse', () => {
    const check: TransportStartResponse = startEmitted;
    expect(check.started).toBe(true);
    // `ok` was the old (wrong) declaration; it is absent from the wire.
    expect('ok' in startEmitted).toBe(false);
  });

  it('the emitted stop body is assignable to TransportStopResponse', () => {
    const check: TransportStopResponse = stopEmitted;
    expect(check.stopped).toBe(false);
    expect('ok' in stopEmitted).toBe(false);
  });

  it('both responses share the transport snapshot key set', () => {
    const asStart: TransportStateSnapshot = startEmitted;
    const asStop: TransportStateSnapshot = stopEmitted;
    expect(asStart.roll_started_at_utc).not.toBeUndefined();
    expect(asStop.roll_started_at_utc).toBeNull();
  });
});
