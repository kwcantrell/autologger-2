// Conformance checks for the CLIENT-WRONG findings corrected by
// `openspec/changes/web-api-shape-conformance` task 3.5 (audit.md §6, CW-1…CW-9),
// now driven by CAPTURED responses (task 4.2/4.3), and — since task 5.1 — for
// EVERY captured fixture, including the ones that map to no CW finding.
//
// COVERAGE RULE (task 5.1). Every file in `fixtures/api-responses/` gets at
// least one type-level assignment against the client type its endpoint's call
// site names, or a recorded reason why it does not. `_mutable.ts` is the sole
// exception and is not a fixture: it is the hand-written support type the
// generated `.ts` modules import (audit §9, and the residual in §10).
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
// requires. That property is asserted deliberately, not left incidental: see
// the "additive tolerance" describe block at the end of this file (task 5.2).
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
import adminUsers from '../../../fixtures/api-responses/adminUsers.json';
import audioSegmentCreate from '../../../fixtures/api-responses/audioSegmentCreate.json';
import audioSegmentsList from '../../../fixtures/api-responses/audioSegmentsList.json';
import eventCreate from '../../../fixtures/api-responses/eventCreate.json';
import eventsList from '../../../fixtures/api-responses/eventsList.json';
import { profileAnonymous } from '../../../fixtures/api-responses/profileAnonymous';
import { profileAuthenticated } from '../../../fixtures/api-responses/profileAuthenticated';
import { profileLoggedOutOauth } from '../../../fixtures/api-responses/profileLoggedOutOauth';
import sessionCreate from '../../../fixtures/api-responses/sessionCreate.json';
import { sessionDetail } from '../../../fixtures/api-responses/sessionDetail';
import sessionStatus from '../../../fixtures/api-responses/sessionStatus.json';
import { sessionsList } from '../../../fixtures/api-responses/sessionsList';
import sessionUpdate from '../../../fixtures/api-responses/sessionUpdate.json';
import { showCategories } from '../../../fixtures/api-responses/showCategories';
import { showCreate } from '../../../fixtures/api-responses/showCreate';
import { teamCreate } from '../../../fixtures/api-responses/teamCreate';
import { teamDetailAdmin } from '../../../fixtures/api-responses/teamDetailAdmin';
import { teamDetailMember } from '../../../fixtures/api-responses/teamDetailMember';
import teamRename from '../../../fixtures/api-responses/teamRename.json';
import { teamRoleChange } from '../../../fixtures/api-responses/teamRoleChange';
import topicCreate from '../../../fixtures/api-responses/topicCreate.json';
import topicsList from '../../../fixtures/api-responses/topicsList.json';
import transcriptWordCreate from '../../../fixtures/api-responses/transcriptWordCreate.json';
import transcriptWordsList from '../../../fixtures/api-responses/transcriptWordsList.json';
import transportStart from '../../../fixtures/api-responses/transportStart.json';
import transportStop from '../../../fixtures/api-responses/transportStop.json';
import { fmtDateOnly } from '../shared/utils/fmtDateOnly';
import type {
  ActiveStudioCategory,
  AdminDataResponse,
  AdminStudio,
  AdminUser,
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
  Show,
  ShowCategoriesResponse,
  TeamCreateResponse,
  TeamDetail,
  TeamMember,
  TeamRenameResponse,
  TeamRoleChangeResponse,
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

  // `sessionStatus` also carries an *undeclared* key. That is not a CW-3
  // property — it is additive tolerance, asserted deliberately in the last
  // describe block of this file (task 5.2).
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

// ---------------------------------------------------------------------------
// Task 5.1 — the captured fixtures that map to no CW finding.
//
// Phase 4 captured 26 fixtures but only the CW blocks above consumed them, so
// nine files were reaching neither this module nor any other `tsc` input:
// `adminUsers` (typechecked only incidentally, by `AdminUsersPage.test.tsx`),
// both remaining `profile*` branches, `showCreate`, all four team responses,
// and `transcriptWordCreate`. A fixture no `tsc` run reads checks nothing.
//
// Each block below names the client type **the real call site names**, so the
// assignment fails when the client type and the captured response diverge —
// the same instrument as the CW blocks, applied to the conforming endpoints so
// they cannot quietly stop conforming.
// ---------------------------------------------------------------------------

describe('GET /api/admin/users — the original `memberships` defect', () => {
  it('the captured body is assignable to AdminDataResponse', () => {
    // `AdminUsersPage.fetchAdmin<AdminDataResponse>('admin/users', token)` —
    // the call whose type argument was wrong, laundered through a local generic
    // wrapper so `grep 'apiFetch<'` never saw it (design D6).
    const check: AdminDataResponse = adminUsers;
    expect(check.users.length).toBeGreaterThan(0);
    expect(check.studios_catalog.length).toBeGreaterThan(0);
  });

  it('a user row is assignable to AdminUser, with and without memberships', () => {
    // Two runtime-guarded rows, so a re-capture that drops either shape fails
    // here rather than silently reducing what the assignments cover.
    // `.filter(…)[0]` rather than `.find(…)!` or a cast: an assertion would let
    // a diverging fixture through, which is the one thing this must not do.
    const populated: AdminUser = adminUsers.users.filter((u) => u.studios.length > 0)[0];
    const empty: AdminUser = adminUsers.users.filter((u) => u.studios.length === 0)[0];
    expect(populated.studios[0].name).toBeTruthy();
    expect(empty.studios).toEqual([]);
  });

  it('the wire has `studios: [{id, name}]` and no `memberships` key at all', () => {
    // This is the whole defect, stated against a captured response: the client
    // declared `memberships: string[]`, the server has never emitted the key,
    // and `u.memberships.map(…)` unmounted the page. Reintroducing that field
    // on `AdminUser` makes the assignments above fail with TS2741.
    const row = adminUsers.users[0];
    expect('memberships' in row).toBe(false);
    expect(row.studios.every((s) => typeof s.id === 'string' && typeof s.name === 'string')).toBe(
      true,
    );
    // The fixture's own type has no such property either — this directive goes
    // unused (a compile error) the moment a re-capture starts emitting one,
    // which is the signal to re-check `AdminUser`, not to delete this line.
    // @ts-expect-error `memberships` is not on the captured response
    const gone = row.memberships;
    expect(gone).toBeUndefined();
  });

  it('a studios-catalog row is assignable to AdminStudio', () => {
    const check: AdminStudio = adminUsers.studios_catalog[0];
    expect(typeof check.builtin).toBe('boolean');
  });
});

describe('GET /api/profile — the two branches with no CW finding', () => {
  it('the logged-in capture is assignable to ProfilePayload', () => {
    const check: ProfilePayload = profileAuthenticated;
    // Runtime guard on the branch identity: this fixture is only evidence about
    // the authenticated shape while it really is the authenticated capture.
    expect(check.auth.logged_in).toBe(true);
    expect(check.auth.user).not.toBeNull();
    // Both `TeamRole` literals appear here, which is why this fixture is a `.ts`
    // module with `as const` (audit §9) — a `.json` import would widen them.
    expect(check.auth.user?.teams.map((t) => t.role)).toEqual(['admin', 'member']);
  });

  it('the logged-out + oauth-configured capture is assignable to ProfilePayload', () => {
    const check: ProfilePayload = profileLoggedOutOauth;
    expect(check.auth.logged_in).toBe(false);
    expect(check.auth.oauth_configured).toBe(true);
    // `user: null` on this branch — the field is declared `AuthUser | null`,
    // and this is the capture that exercises the null side.
    expect(check.auth.user).toBeNull();
  });
});

describe('POST /api/shows — the created show', () => {
  it("the captured body is assignable to the call site's `{show: Show}`", () => {
    // `useProfile.ts` names this type inline: `apiFetch<{ show: Show }>('shows', …)`.
    const check: { show: Show } = showCreate;
    expect(check.show.show_code).toBe('ATS');
    expect(check.show.event_palette.length).toBeGreaterThan(0);
  });

  it('its categories are `ShowCategory`, i.e. `{label, needs_context}` options', () => {
    // The other side of the CW-2 split, on a third endpoint: `Show.categories`
    // uses `ShowCategory`, whose `dropdown_options` are option OBJECTS.
    const dropdown = showCreate.show.categories.find((c) => c.type === 'DROPDOWN');
    expect(dropdown).toBeDefined();
    expect(dropdown?.dropdown_options).toEqual([
      { label: 'Lav', needs_context: false },
      { label: 'Boom', needs_context: false },
    ]);
  });
});

describe('Teams — the four responses `useTeams.ts` types', () => {
  it('POST /api/teams is assignable to TeamCreateResponse', () => {
    const check: TeamCreateResponse = teamCreate;
    expect(check.role).toBe('admin');
  });

  it('PATCH /api/teams/:id is assignable to TeamRenameResponse', () => {
    const check: TeamRenameResponse = teamRename;
    expect(check.name).toBe('My Crew Renamed');
    // Rename emits `{id, name}` only — no `role`, unlike create.
    expect('role' in teamRename).toBe(false);
  });

  it('POST …/members/:uid/role is assignable to TeamRoleChangeResponse', () => {
    const check: TeamRoleChangeResponse = teamRoleChange;
    expect(check.ok).toBe(true);
    expect(check.role).toBe('admin');
  });

  it('both caller branches of GET /api/teams/:id are assignable to TeamDetail', () => {
    const asAdmin: TeamDetail = teamDetailAdmin;
    const asMember: TeamDetail = teamDetailMember;
    // The caller-dependent key (audit row 26): `invites` is emitted only for
    // admins, which is why `TeamDetail.invites` is optional. Captured from the
    // same seeded state with the same pending invite present, so the member
    // body's missing key is an observation about the caller branch, not about
    // there being nothing to send.
    expect(asAdmin.role).toBe('admin');
    expect(asMember.role).toBe('member');
    expect(asAdmin.invites?.[0]?.email).toBe('pending@example.com');
    expect('invites' in teamDetailMember).toBe(false);
    expect(asMember.invites).toBeUndefined();
  });

  it('a member row is assignable to TeamMember and carries both roles', () => {
    const members: TeamMember[] = teamDetailAdmin.members;
    expect(members.map((m) => m.role)).toEqual(['admin', 'member']);
  });
});

describe('POST …/transcript-words — the created word', () => {
  it('the captured 201 body is assignable to TranscriptWord', () => {
    const check: TranscriptWord = transcriptWordCreate;
    expect(check.word).toBe('hello');
    // The asymmetry CW-6 turns on, captured on the create route too: the
    // transcript-words handlers spread `{...w, session_id}`; topics do not.
    expect(check.session_id).toMatch(/^#+-#+-#+-#+-#+$/);
  });
});

// ---------------------------------------------------------------------------
// Task 5.2 — ADDITIVE TOLERANCE, asserted deliberately.
//
// The spec requires that a response carrying fields the client does not declare
// must NOT fail verification (forward compatibility: the server may add keys
// without breaking the client). TypeScript gives us this for free — excess-
// property checking applies only to *fresh* object literals, and every fixture
// here is an imported module binding — but "for free" and "unasserted" is how a
// property silently disappears. So it is asserted from both sides:
//
//   1. the assignments above compile (that IS the tolerance), and
//   2. `ExpectUndeclared` pins that the tolerated keys really are absent from
//      the client type. If someone later "tightens" a client type by declaring
//      one of these captured extras, this block fails with a message naming
//      exactly what happened, instead of the tolerance check quietly becoming
//      vacuous.
//
// The failure mode this guards against is subtle: without (2), a future edit
// that declares every captured key makes these checks pass for a reason that
// has nothing to do with tolerance, and the property stops being tested while
// the suite stays green.
// ---------------------------------------------------------------------------

/** `K` unless the client type `T` declares it — in which case a tuple whose
 * text is the failure message. */
type ExpectUndeclared<T, K extends string> = K extends keyof T
  ? ['ADDITIVE TOLERANCE: the client type now DECLARES this captured key', K]
  : K;

describe('additive tolerance — captured keys the client does not declare', () => {
  it('AdminUser tolerates `picture_url` and `created_at_utc`', () => {
    // `GET /api/admin/users` emits eight keys per user; `AdminUser` declares
    // six. The assignments in the admin block above compile anyway.
    const undeclared = ['picture_url', 'created_at_utc'] as const;
    for (const key of undeclared) {
      expect(key in adminUsers.users[0]).toBe(true);
    }
    const pictureUrl: ExpectUndeclared<AdminUser, 'picture_url'> = 'picture_url';
    const createdAt: ExpectUndeclared<AdminUser, 'created_at_utc'> = 'created_at_utc';
    expect([pictureUrl, createdAt]).toEqual(undeclared.slice());
  });

  it('SessionStatus tolerates `audio_recording_lease_age_sec`', () => {
    expect('audio_recording_lease_age_sec' in sessionStatus).toBe(true);
    const ageSec: ExpectUndeclared<SessionStatus, 'audio_recording_lease_age_sec'> =
      'audio_recording_lease_age_sec';
    expect(ageSec).toBe('audio_recording_lease_age_sec');
  });

  it('the helper itself is not vacuous — a DECLARED key does not typecheck', () => {
    // Without this, `ExpectUndeclared` could be broken (or reduced to `K`) and
    // the two checks above would keep passing. `email` IS declared on
    // `AdminUser`, so the conditional must resolve to the failure tuple.
    // @ts-expect-error `email` is declared, so this resolves to the message tuple
    const declared: ExpectUndeclared<AdminUser, 'email'> = 'email';
    expect(declared).toBe('email');
  });
});
