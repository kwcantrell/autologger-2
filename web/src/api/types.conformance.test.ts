// Conformance checks for the CLIENT-WRONG findings corrected by
// `openspec/changes/web-api-shape-conformance` task 3.5 (audit.md §6, CW-1…CW-9),
// now driven by CAPTURED responses (task 4.2/4.3).
//
// WHERE THESE VALUES COME FROM. Every `emitted` binding below is imported from
// `fixtures/api-responses/`, whose files are produced by issuing the real
// request against the real handler in
// `server/src/routers/apiResponseFixtures.int.test.ts` and are re-asserted
// against that handler on every server test run. Nothing here is transcribed
// from a reading of the client type or of the handler source — that
// transcription step is the defect this change exists to remove (design D2),
// and the previous revision of this file did exactly that, deliberately and
// temporarily, until the captures existed.
//
// WHY THESE ARE TYPE-LEVEL, NOT BEHAVIOURAL. Eight of the nine findings are
// *latent*: the client declared a field the server never emits (or narrower
// than it emits) and **no component reads it**. Nothing observable changes when
// such a type is wrong, so there is no runtime behaviour to assert — the type
// checker is the only instrument that can catch the defect. `npm run typecheck`
// is the gate: reintroducing a deleted field, re-narrowing a widened one, or
// collapsing a split type makes one of the assignments below fail to compile.
// The one finding with live consequences (CW-5, `duration_sec`) also has
// behavioural coverage — see `useAudioClips.durationProbe.test.tsx`.
//
// ADDITIVE TOLERANCE IS PRESERVED BY CONSTRUCTION. Every fixture is a module
// binding, never a fresh object literal at the assignment site, so TypeScript's
// excess-property check does not fire and a response carrying keys the client
// does not declare still passes — the forward-compatibility property the spec
// requires. `sessionStatus` below carries such a key on purpose.
//
// UNSTABLE VALUES ARE REDACTED, NOT REMOVED. Ids, timestamps, and clock
// readouts appear as `#`-masked strings of the original length. See
// `server/src/test/apiFixtures.ts` for why that keeps the check honest about
// key presence, JSON type, and nullability.
//
// WHAT A CAPTURED FIXTURE STRUCTURALLY CANNOT COVER (audit CW-9, and the
// `enrichEventRpc` orphan branch inside CW-4). Both turn on a data state that
// seeded test rows do not produce — a session whose joined show row is gone, an
// event whose category has been deleted from the profile. No amount of capture
// fidelity reaches them; this is the "production data variance" residual named
// in design D1 and the risk table, not a gap in how phase 4 was executed. The
// two describe blocks that cover those branches say so at their literals, which
// remain the only hand-written values in this file.

import { describe, expect, it } from 'vitest';
import audioSegmentCreate from '../../../fixtures/api-responses/audioSegmentCreate.json';
import audioSegmentsList from '../../../fixtures/api-responses/audioSegmentsList.json';
import eventCreate from '../../../fixtures/api-responses/eventCreate.json';
import eventsList from '../../../fixtures/api-responses/eventsList.json';
import { profileAnonymous } from '../../../fixtures/api-responses/profileAnonymous';
import sessionCreate from '../../../fixtures/api-responses/sessionCreate.json';
import { sessionDetail } from '../../../fixtures/api-responses/sessionDetail';
import sessionStatus from '../../../fixtures/api-responses/sessionStatus.json';
import { sessionsList } from '../../../fixtures/api-responses/sessionsList';
import sessionUpdate from '../../../fixtures/api-responses/sessionUpdate.json';
import { showCategories } from '../../../fixtures/api-responses/showCategories';
import topicCreate from '../../../fixtures/api-responses/topicCreate.json';
import topicsList from '../../../fixtures/api-responses/topicsList.json';
import transcriptWordsList from '../../../fixtures/api-responses/transcriptWordsList.json';
import transportStart from '../../../fixtures/api-responses/transportStart.json';
import transportStop from '../../../fixtures/api-responses/transportStop.json';
import { fmtDateOnly } from '../shared/utils/fmtDateOnly';
import type {
  ActiveStudioCategory,
  AudioSegment,
  AudioSegmentsResponse,
  Category,
  EventsResponse,
  LogEvent,
  ProfilePayload,
  Session,
  SessionCreateResponse,
  SessionStatus,
  SessionsResponse,
  SessionTopic,
  SessionUpdateResponse,
  ShowCategoriesResponse,
  TranscriptWord,
  TransportStartResponse,
  TransportStateSnapshot,
  TransportStopResponse,
} from './types';

describe('CW-1 — transport start/stop emit the transport state, not `{ok}`', () => {
  it('the captured start body is assignable to TransportStartResponse', () => {
    const check: TransportStartResponse = transportStart;
    expect(check.started).toBe(true);
    // `ok` was the old (wrong) declaration. This is a captured response, so
    // its absence is an observation about the server, not an assumption.
    expect('ok' in transportStart).toBe(false);
  });

  it('the captured stop body is assignable to TransportStopResponse', () => {
    const check: TransportStopResponse = transportStop;
    expect(check.stopped).toBe(true);
    expect('ok' in transportStop).toBe(false);
  });

  it('both responses share the transport snapshot key set', () => {
    const asStart: TransportStateSnapshot = transportStart;
    const asStop: TransportStateSnapshot = transportStop;
    // Split into two types rather than one with both flags optional, so
    // neither fixture can satisfy the other's contract by omission:
    expect('stopped' in asStart).toBe(false);
    expect('started' in asStop).toBe(false);
    // `roll_started_at_utc` is `string | null` and the two captures land on
    // opposite sides of that — start while rolling, stop after.
    expect(typeof asStart.roll_started_at_utc).toBe('string');
    expect(asStop.roll_started_at_utc).toBeNull();
  });
});

describe('CW-2 — `dropdown_options` is two different shapes on two endpoints', () => {
  it('/show-categories keeps the `{label, needs_context}` option objects', () => {
    const check: ShowCategoriesResponse = showCategories;
    const dropdown = check.categories.find((c) => c.type === 'DROPDOWN');
    // `CategoryButtonStrip` renders `opt.label`; this is the shape that feeds it.
    expect(dropdown?.dropdown_options).toEqual([
      { label: 'Lav', needs_context: false },
      { label: 'Boom', needs_context: true },
    ]);
  });

  it('/api/profile `active_studio.categories` carries bare label strings', () => {
    const check: ProfilePayload['active_studio'] = profileAnonymous.active_studio;
    const dropdown = check.categories.find(
      (c: ActiveStudioCategory) => c.type === 'DROPDOWN',
    ) as ActiveStudioCategory;
    // Same seeded categories, same DROPDOWN, two different emitted shapes —
    // captured from the two endpoints in the same test run.
    expect(dropdown.dropdown_options).toEqual(['Lav', 'Boom']);
  });

  it('the two category types are not interchangeable', () => {
    // Index 1 is the DROPDOWN in both captures, and it has to be: a BUTTON's
    // `dropdown_options` is `[]`, whose type is assignable to BOTH `string[]`
    // and `DropdownOption[]`, so the non-DROPDOWN rows cannot express the
    // incompatibility at all. The runtime guard below fails loudly if a
    // re-capture ever reorders them, rather than letting the two directives
    // silently start passing for the wrong reason.
    expect(profileAnonymous.active_studio.categories[1].type).toBe('DROPDOWN');
    expect(showCategories.categories[1].type).toBe('DROPDOWN');

    // Both directives fail to compile ("unused '@ts-expect-error' directive")
    // the moment someone collapses the split back into one type — which is the
    // regression this finding exists to prevent.
    // @ts-expect-error `string[]` is not `DropdownOption[]`
    const wrongWay: Category = profileAnonymous.active_studio.categories[1];
    // @ts-expect-error `DropdownOption[]` is not `string[]`
    const otherWay: ActiveStudioCategory = showCategories.categories[1];
    expect(wrongWay.id).toBe(otherWay.id);
  });
});

describe('CW-3 — SessionStatus declared three fields /status never emits', () => {
  it('the captured body is assignable to SessionStatus', () => {
    const check: SessionStatus = sessionStatus;
    expect(check.logged_event_count).toBe(0);
  });

  it('the three removed fields are absent from the captured response', () => {
    for (const key of ['timecode_total_frames', 'start_offset_frames', 'audio_segment_count']) {
      expect(key in sessionStatus).toBe(false);
    }
  });

  it('tolerates the undeclared `audio_recording_lease_age_sec`', () => {
    // The captured response carries a key `SessionStatus` does not declare and
    // the assignment above still compiles — additive tolerance, observed.
    expect('audio_recording_lease_age_sec' in sessionStatus).toBe(true);
  });
});

describe('CW-4 — LogEvent declared two unemitted fields and two over-narrow types', () => {
  it('the captured event-create body is assignable to LogEvent', () => {
    const check: LogEvent = eventCreate;
    expect(check.category_label).toBe('Camera');
  });

  it('the captured events envelope is assignable to EventsResponse', () => {
    const check: EventsResponse = eventsList;
    // Two captured branches of `enrichEventRpc`: a category resolved from the
    // profile, and the `internal` category with its fixed label/colour.
    expect(check.events.map((e) => e.category_label)).toEqual(['Camera', 'Internal']);
  });

  it('`session_id` and `timecode_hms` are absent from the captured rows', () => {
    for (const event of eventsList.events) {
      for (const key of ['session_id', 'timecode_hms']) {
        expect(key in event).toBe(false);
      }
    }
  });

  it('the orphan branch — NOT CAPTURABLE, established from the producing function', () => {
    // `enrichEventRpc`'s third branch fires when the event's category is gone
    // from the profile and its `al_category_color_snapshot` is missing or not
    // `#RRGGBB`; `eventRowToRpc` nulls `timecode`/`frame_rate` together when
    // `timecode_total_frames` is NULL. Neither state is reachable by seeding —
    // seeds create the category they log against — so this literal is written
    // from the audit's read of those two functions, not captured. It is here
    // to hold the widened types in place; it is NOT evidence about the wire.
    const orphanFromSourceRead = {
      event_id: '00000000-0000-0000-0000-000000000000',
      wall_time_utc: '2026-07-27T00:00:11Z',
      timecode: null,
      frame_rate: null,
      timecode_total_frames: null,
      category: 'deleted-cat',
      message: 'Manually entered',
      metadata: {},
      category_label: 'deleted-cat',
      category_color: null,
    };
    const orphan: LogEvent = orphanFromSourceRead;
    expect(orphan.category_color).toBeNull();
    expect(orphan.timecode).toBeNull();
  });
});

describe('CW-5 — AudioSegment declared three fields `segmentApiDict` never emits', () => {
  it('the captured upload body is assignable to AudioSegment', () => {
    const check: AudioSegment = audioSegmentCreate;
    expect(check.url).toContain('/audio/segments/');
  });

  it('the captured list envelope is assignable to AudioSegmentsResponse', () => {
    const check: AudioSegmentsResponse = audioSegmentsList;
    expect(check.has_audio).toBe(true);
  });

  it('no duration, session id, or file path appears in the captured segment', () => {
    for (const key of ['session_id', 'duration_sec', 'file_path', 'r2_key']) {
      expect(key in audioSegmentCreate).toBe(false);
      expect(key in audioSegmentsList.segments[0]).toBe(false);
    }
  });
});

describe('CW-6 — SessionTopic declared a `session_id` the topics routes never add', () => {
  it('the captured topic is assignable to SessionTopic', () => {
    const check: SessionTopic = topicCreate;
    expect(check.ordinal).toBe(0);
    const listed: SessionTopic[] = topicsList.topics;
    expect(listed).toHaveLength(1);
  });

  it('`session_id` is absent from the captured topic — unlike the transcript-words rows', () => {
    expect('session_id' in topicCreate).toBe(false);
    // The contrast that made this easy to get wrong, both sides captured in
    // the same run: the transcript-words handlers DO spread
    // `{...w, session_id}` onto every row.
    const word: TranscriptWord = transcriptWordsList.words[0];
    expect(word.session_id).toMatch(/^#+-#+-#+-#+-#+$/);
  });
});

describe('CW-7/CW-8 — session create and update are not `Session`', () => {
  it('the captured create body is assignable to SessionCreateResponse', () => {
    const check: SessionCreateResponse = sessionCreate;
    // `NewSessionModal` reads exactly this and nothing else.
    expect(check.id).toBeTruthy();
  });

  it('the captured update body is assignable to SessionUpdateResponse', () => {
    const check: SessionUpdateResponse = sessionUpdate;
    expect(check.title).toBe('Renamed');
  });

  it('neither captured body carries the rest of `Session`', () => {
    for (const key of ['deck_title', 'session_status', 'event_count', 'archived']) {
      expect(key in sessionCreate).toBe(false);
      expect(key in sessionUpdate).toBe(false);
    }
    // Both routes were typed `Session`, so these assignments must NOT compile.
    // @ts-expect-error 12 of `Session`'s 19 keys are missing
    const asSession: Session = sessionCreate;
    // @ts-expect-error 15 of `Session`'s 19 keys are missing
    const asSessionToo: Session = sessionUpdate;
    expect(asSession.id).toBe(asSessionToo.id);
  });
});

describe('CW-9 — four Session fields are nullable on the wire', () => {
  it('the captured list and detail bodies are assignable to their types', () => {
    const list: SessionsResponse = sessionsList;
    const detail: Session = sessionDetail;
    expect(list.active).toHaveLength(1);
    expect(list.archived[0].session_status).toBe('archived');
    expect(detail.session_status).toBe('active');
    // Captured from seeded state, every one of the four is populated — which
    // is precisely why the capture cannot establish the finding:
    expect(detail.show_id).not.toBeNull();
    expect(detail.created_at_utc).not.toBeNull();
  });

  it('the orphaned-show branch — NOT CAPTURABLE, established from `serializeSessionEntry`', () => {
    // A seeded session always has a joined show row and a `created_at_utc`, so
    // the `?? null` branches never fire against seed data no matter how the
    // capture is done (audit CW-9's caveat, and design D1's production-data-
    // variance residual). This literal is written from the serializer, not
    // captured, and is the only thing holding the four widened types in place.
    const orphanedFromSourceRead = {
      ...sessionDetail,
      show_id: null,
      show_code: null,
      show_name: null,
      created_at_utc: null,
    };
    const check: Session = orphanedFromSourceRead;
    expect(check.show_name).toBeNull();
    expect(fmtDateOnly(check.episode_date ?? check.created_at_utc)).toBe('');
  });
});
