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
  ActiveStudioCategory,
  Category,
  ProfilePayload,
  ShowCategoriesResponse,
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

describe('CW-2 — `dropdown_options` is two different shapes on two endpoints', () => {
  // Server: `showCategoriesApiShape` → `dropdownOptionsApiShape`
  // (`server/src/db/showsStore.ts`). Objects, and `[]` for non-DROPDOWN types.
  const showCategoriesEmitted = {
    categories: [
      {
        id: 'cat-mic',
        label: 'Mic',
        color: '#7cb7ff',
        type: 'DROPDOWN' as const,
        dropdown_options: [
          { label: 'Lav', needs_context: false },
          { label: 'Boom', needs_context: true },
        ],
        on_label: '',
        off_label: '',
      },
    ],
    show_name: 'All The Smoke',
    show_code: 'ATS',
  };

  // Server: `studioToApiDict` (`server/src/studio.ts`) over `blobToProfile`'s
  // `optLabels: string[]` — bare labels, the option objects already flattened.
  const activeStudioEmitted = {
    id: 'studio-1',
    name: 'Studio One',
    categories: [
      {
        id: 'cat-mic',
        label: 'Mic',
        color: '#7cb7ff',
        type: 'DROPDOWN' as const,
        dropdown_options: ['Lav', 'Boom'],
        on_label: '',
        off_label: '',
      },
    ],
  };

  it('/show-categories keeps the `{label, needs_context}` option objects', () => {
    const check: ShowCategoriesResponse = showCategoriesEmitted;
    const opt = check.categories[0].dropdown_options[0];
    // `CategoryButtonStrip` renders `opt.label`; this is the shape that feeds it.
    expect(opt.label).toBe('Lav');
    expect(opt.needs_context).toBe(false);
  });

  it('/api/profile `active_studio.categories` carries bare label strings', () => {
    const check: ProfilePayload['active_studio'] = activeStudioEmitted;
    const asCategory: ActiveStudioCategory = check.categories[0];
    expect(asCategory.dropdown_options).toEqual(['Lav', 'Boom']);
  });

  it('the two category types are not interchangeable', () => {
    // Both directives fail to compile ("unused '@ts-expect-error' directive")
    // the moment someone collapses the split back into one type — which is the
    // regression this finding exists to prevent.
    // @ts-expect-error `string[]` is not `DropdownOption[]`
    const wrongWay: Category = activeStudioEmitted.categories[0];
    // @ts-expect-error `DropdownOption[]` is not `string[]`
    const otherWay: ActiveStudioCategory = showCategoriesEmitted.categories[0];
    expect(wrongWay.id).toBe(otherWay.id);
  });
});
