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
  SessionStatus,
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

describe('CW-3 — SessionStatus declared three fields /status never emits', () => {
  // Server: the `GET /api/sessions/:sessionId/status` handler
  // (`server/src/routers/events.ts`) — its 21 emitted keys, verbatim.
  const emitted = {
    timecode: '00:00:10:00',
    master_timecode: '00:00:12:00',
    session_timecode: '00:00:10:00',
    now_utc: '2026-07-27T00:00:12Z',
    session_created_at_utc: '2026-07-27T00:00:00Z',
    frame_rate: 24,
    event_count: 3,
    logged_event_count: 2,
    events_stream_revision: 7,
    title: 'ATS - 2',
    deck_title: 'ATS - 2',
    show_id: 'show-1',
    show_name: 'All The Smoke',
    show_code: 'ATS',
    episode: '2',
    notes: '',
    is_rolling: true,
    current_take: 1,
    audio_recording_lease_holder_id: null,
    audio_recording_lease_alive: false,
    // Emitted but undeclared on the client type — the additive-tolerance case.
    audio_recording_lease_age_sec: null,
  };

  it('the emitted body is assignable to SessionStatus', () => {
    const check: SessionStatus = emitted;
    expect(check.logged_event_count).toBe(2);
  });

  it('the three removed fields are genuinely absent from the wire', () => {
    for (const key of ['timecode_total_frames', 'start_offset_frames', 'audio_segment_count']) {
      expect(key in emitted).toBe(false);
    }
  });

  it('tolerates the undeclared `audio_recording_lease_age_sec`', () => {
    const check: SessionStatus = emitted;
    expect('audio_recording_lease_age_sec' in check).toBe(true);
  });
});
