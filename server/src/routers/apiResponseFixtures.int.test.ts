// Captured API-response fixtures (web-api-shape-conformance, tasks 4.1–4.3).
//
// Every test here issues a REAL request through `app.request` against the real
// handler and asserts the emitted body against a committed fixture under
// `fixtures/api-responses/`. That is design D2 ("fixtures are captured by
// executing the handler, never hand-authored") and the server half of D3
// ("fixtures are two-sided"): the web tier assigns these same files to the
// client types in `web/src/api/types.ts`, and this suite is what stops the
// fixture drifting away from the server behind that check's back.
//
// WHY THEY ALL LIVE IN ONE FILE. Task 4.2 points at `admin.int.test.ts` as a
// place to start, since it already issues `GET /api/admin/users`. The captures
// are collected here instead, for two reasons: regeneration is a single
// command over a single file rather than a sweep across eight router suites,
// and the fixture inventory is reviewable in one place — a reviewer can see
// which endpoints and which branches are covered without reading the whole
// server test tier. The per-router suites keep their own behavioural
// assertions; nothing was moved out of them.
//
// FROZEN SURFACE. These tests only observe. No handler, response shape,
// status code, or header is touched by this file or by anything it imports.
//
// REGENERATING:  npm run fixtures:capture -w server
// (assert-only otherwise — see `server/src/test/apiFixtures.ts` for why a
// missing fixture fails instead of being written.)

import { describe, expect, it, vi } from 'vitest';
import { expectCapturedResponse } from '../test/apiFixtures';
import { answer, callTools, type FakeLlm, startFakeLlm } from '../test/fakeLlm';
import { anonApp, app, defaultUser, env, envWith } from '../test/harness';
import {
  adminHeader,
  catalogFor,
  loginCookie,
  seedMemberStudio,
  seedSession,
  seedShow,
  seedStudio,
  seedUser,
  testDb,
} from '../test/helpers';
import { saveSdkCredential } from '../test/llmRoutes';
import { liveLeaseOfAnotherProcess } from '../test/runLeases';
import { harnessHub } from '../test/session/sessionRows';

const JSON_HEADERS = { 'content-type': 'application/json' };

/** A category set exercising a DROPDOWN (the one category kind whose
 * `dropdown_options` is non-empty, and the field CW-2 found emitted as two
 * different shapes on two endpoints) alongside an ON_OFF and a BUTTON, so the
 * captured fixtures carry every branch of the shapers. Ids are literal so they
 * survive `validateCategoriesList` unchanged. */
const CATEGORIES = [
  {
    id: 'cam',
    name: 'Camera',
    color: '#112233',
    type: 'BUTTON',
    dropdown_options: [],
    on_label: '',
    off_label: '',
  },
  {
    id: 'mic',
    name: 'Mic',
    color: '#7cb7ff',
    type: 'DROPDOWN',
    dropdown_options: [
      { label: 'Lav', needs_context: false },
      { label: 'Boom', needs_context: true },
    ],
    on_label: '',
    off_label: '',
  },
  {
    id: 'tally',
    name: 'Tally',
    color: '#ff8800',
    type: 'ON_OFF',
    dropdown_options: [],
    on_label: 'ON',
    off_label: 'OFF',
  },
];
const CATEGORIES_JSON = JSON.stringify(CATEGORIES);

/** `saveStudioSettingsBlob` validates against the in-memory studio registry,
 * which a freshly constructed `Catalog` populates only on `.init()` (normally
 * done per request by `authContext`) — the `initedCatalog()` idiom from
 * `teams.int.test.ts`. */
async function initedCatalog() {
  const cat = catalogFor();
  await cat.init();
  return cat;
}

async function activeStudioId(): Promise<string> {
  const res = await app.request('/api/studio', { method: 'GET' }, { ...env });
  return ((await res.json()) as { id: string }).id;
}

/** The default member's effective studio, given a show (which becomes the active
 * show, since it is the only one) and a session under it — the state
 * `GET /api/sessions` and every per-session route need. */
async function seedActiveChain(): Promise<{ studioId: string; showId: string; sessionId: string }> {
  const studioId = await activeStudioId();
  const showId = await seedShow({
    studioId,
    name: 'All The Smoke',
    code: 'ATS',
    categoriesJson: CATEGORIES_JSON,
  });
  const sessionId = await seedSession({ showId, episode: '002', title: 'ATS - 2' });
  return { studioId, showId, sessionId };
}

// ---------------------------------------------------------------------------
// Admin — GET /api/admin/users (the endpoint this whole change exists for)
// ---------------------------------------------------------------------------

describe('GET /api/admin/users', () => {
  it('matches the captured fixture', async () => {
    const token = 'fixture-admin-token';
    const teamA = await seedStudio({ id: 'my-crew', name: 'My Crew' });
    await seedStudio({ id: 'ymhs', name: 'YMHS' });
    await seedUser({ email: 'ann@example.com', sub: 'sub-ann', studios: [teamA] });
    // `authListUsersAdmin` orders by `created_at_utc DESC`, which is
    // millisecond-precision — two users minted in the same millisecond would
    // tie and the row order would be arbitrary, making the fixture flaky.
    await new Promise((resolve) => setTimeout(resolve, 2));
    await seedUser({ email: 'bo@example.com', sub: 'sub-bo' }); // no memberships → `studios: []`
    await new Promise((resolve) => setTimeout(resolve, 2));
    // A membership row pointing at a studio id with no catalog entry —
    // `authAddMemberships` has no FK check, so this is reachable in production
    // whenever a team is deleted out from under a member. Captures admin.ts's
    // `names[m] ?? m` fallback, i.e. a membership whose `name` equals its
    // `id` (the `web-admin-users` spec scenario; task 4.4).
    await seedUser({ email: 'cleo@example.com', sub: 'sub-cleo', studios: ['ghost-team'] });
    await new Promise((resolve) => setTimeout(resolve, 2));
    // A member of every studio in the catalog, including both built-ins —
    // captures the add-membership control's "offered nothing" branch
    // (task 4.4).
    await seedUser({
      email: 'dee@example.com',
      sub: 'sub-dee',
      studios: ['test-studios', 'test-studio-2', 'my-crew', 'ymhs'],
    });

    const res = await app.request(
      '/api/admin/users',
      { method: 'GET', headers: adminHeader(token) },
      envWith({ ADMIN_TOKEN: token }),
    );
    await expectCapturedResponse(
      { name: 'adminUsers', endpoint: 'GET /api/admin/users', format: 'json' },
      res,
    );
  });
});

// ---------------------------------------------------------------------------
// Profile — every branch of `profilePayload` (audit row 1; the anonymous one went with
// require-login, leaving two)
// ---------------------------------------------------------------------------

describe('GET /api/profile', () => {
  it('authenticated matches the captured fixture', async () => {
    const teamA = await seedStudio({ id: 'my-crew', name: 'My Crew' });
    const teamB = await seedStudio({ id: 'ymhs', name: 'YMHS' });
    await (await initedCatalog()).studios.saveStudioSettingsBlob(teamA, {
      categories: CATEGORIES,
      show_title_format: 'ATS',
      default_frame_rate: 24,
    });
    const showId = await seedShow({
      studioId: teamA,
      name: 'All The Smoke',
      code: 'ATS',
      categoriesJson: CATEGORIES_JSON,
    });
    // A show in the team where Ann is a plain member with no grant: `can_access: false`
    // (show-grants D7); the owner's ATS is `can_access: true`.
    await seedShow({ studioId: teamB, name: 'YMHS Weekly', code: 'YW' });
    const userId = await seedUser({ email: 'ann@example.com', sub: 'sub-ann' });
    await catalogFor().auth.authAddMembershipWithRole(userId, teamA, 'owner');
    await catalogFor().auth.authAddMembershipWithRole(userId, teamB, 'member');
    await catalogFor().auth.authSetPrefs(userId, teamA, showId);

    const res = await app.request(
      '/api/profile',
      { method: 'GET', headers: { Cookie: await loginCookie(userId) } },
      { ...env },
    );
    await expectCapturedResponse(
      {
        name: 'profileAuthenticated',
        endpoint: 'GET /api/profile (logged in, two team memberships)',
        format: 'ts',
        exportName: 'profileAuthenticated',
      },
      res,
    );
  });

  it('logged-out with oauth configured matches the captured fixture', async () => {
    // The signed-out branch (audit row 1, branch i): same key set, but an
    // empty active studio and empty studios/shows.
    const res = await anonApp.request(
      '/api/profile',
      { method: 'GET' },
      envWith({ GOOGLE_CLIENT_ID: 'fixture-client-id' }),
    );
    await expectCapturedResponse(
      {
        name: 'profileLoggedOutOauth',
        endpoint: 'GET /api/profile (logged out, oauth configured)',
        format: 'ts',
        exportName: 'profileLoggedOutOauth',
      },
      res,
    );
  });
});

// ---------------------------------------------------------------------------
// Shows
// ---------------------------------------------------------------------------

// The two full-`showApiDict` read routes. Both became web-consumed by
// profile-shows-slimming — `/api/profile`'s `shows[]` is now the slim
// `showBriefApiDict`, so `useStudioShows` (HomeSettingsModal) and `useShow`
// (EventGenerateCustomModal) read the full per-show config from here instead.
// `format: 'ts'`: the payload carries literal-union values a `.json` import
// would widen to `string` — `title_suffix: 'date'` and every category's
// `type: 'BUTTON' | 'DROPDOWN' | 'ON_OFF'` (design D4's wrinkle).
describe('GET /api/shows?studio_id=…', () => {
  it('matches the captured fixture', async () => {
    const studioId = await activeStudioId();
    await seedShow({
      studioId,
      name: 'All The Smoke',
      code: 'ATS',
      categoriesJson: CATEGORIES_JSON,
    });
    const res = await app.request(
      `/api/shows?studio_id=${studioId}`,
      { method: 'GET' },
      { ...env },
    );
    await expectCapturedResponse(
      {
        name: 'showsList',
        endpoint: 'GET /api/shows?studio_id=…',
        format: 'ts',
        exportName: 'showsList',
      },
      res,
    );
  });
});

describe('GET /api/shows/:showId', () => {
  it('matches the captured fixture', async () => {
    const studioId = await activeStudioId();
    const showId = await seedShow({
      studioId,
      name: 'All The Smoke',
      code: 'ATS',
      categoriesJson: CATEGORIES_JSON,
    });
    const res = await app.request(`/api/shows/${showId}`, { method: 'GET' }, { ...env });
    await expectCapturedResponse(
      {
        name: 'showDetail',
        endpoint: 'GET /api/shows/:showId',
        format: 'ts',
        exportName: 'showDetail',
      },
      res,
    );
  });
});

describe('POST /api/shows', () => {
  it('matches the captured fixture', async () => {
    const studioId = await activeStudioId();
    const res = await app.request(
      '/api/shows',
      {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ studio_id: studioId, name: 'All The Smoke', show_code: 'ATS' }),
      },
      { ...env },
    );
    await expectCapturedResponse(
      {
        name: 'showCreate',
        endpoint: 'POST /api/shows',
        format: 'ts',
        exportName: 'showCreate',
      },
      res,
    );
  });
});

describe('GET /api/sessions/:id/show-categories', () => {
  it('matches the captured fixture', async () => {
    const { sessionId } = await seedActiveChain();
    const res = await app.request(
      `/api/sessions/${sessionId}/show-categories`,
      { method: 'GET' },
      { ...env },
    );
    await expectCapturedResponse(
      {
        name: 'showCategories',
        endpoint: 'GET /api/sessions/:id/show-categories',
        format: 'ts',
        exportName: 'showCategories',
      },
      res,
    );
  });
});

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

describe('sessions', () => {
  it('GET /api/sessions matches the captured fixture (active + archived)', async () => {
    const { showId, sessionId } = await seedActiveChain();
    const archived = await seedSession({ showId, episode: '001', title: 'ATS - 1' });
    await app.request(`/api/sessions/${archived}/archive`, { method: 'POST' }, { ...env });
    expect(sessionId).toBeTruthy();

    const res = await app.request('/api/sessions', { method: 'GET' }, { ...env });
    await expectCapturedResponse(
      {
        name: 'sessionsList',
        endpoint: 'GET /api/sessions',
        format: 'ts',
        exportName: 'sessionsList',
      },
      res,
    );
  });

  it('GET /api/sessions for a member without access to the active show matches the captured fixture (blanked entries, show-grants D21)', async () => {
    const team = await seedStudio({ id: 'my-crew', name: 'My Crew' });
    const showId = await seedShow({
      studioId: team,
      name: 'All The Smoke',
      code: 'ATS',
      categoriesJson: CATEGORIES_JSON,
    });
    const now = new Date().toISOString();
    const sessionId = await catalogFor().sessions.createSessionIndex({
      showId,
      title: 'ATS - 2',
      frameRate: 24,
      startOffsetFrames: 0,
      episode: '002',
      notes: 'Private notes',
      startedAtUtc: now,
      createdAtUtc: now,
    });
    const adminId = await seedUser({ email: 'ann@example.com', sub: 'sub-ann' });
    await catalogFor().auth.authAddMembershipWithRole(adminId, team, 'admin');
    const adminCookie = await loginCookie(adminId);
    // Content and live state the blanked entry must not carry: notes (above), an event, a
    // rolling take.
    for (const [path, body] of [
      [`/api/sessions/${sessionId}/events`, { category: 'cam', message: 'Cut to 2' }],
      [`/api/sessions/${sessionId}/transport/start`, undefined],
    ] as const) {
      const r = await anonApp.request(
        path,
        {
          method: 'POST',
          headers:
            body === undefined ? { Cookie: adminCookie } : { ...JSON_HEADERS, Cookie: adminCookie },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
        { ...env },
      );
      expect(r.status).toBe(200);
    }
    const memberId = await seedUser({ email: 'bo@example.com', sub: 'sub-bo' });
    await catalogFor().auth.authAddMembershipWithRole(memberId, team, 'member');
    await catalogFor().auth.authSetPrefs(memberId, team, showId);

    const res = await anonApp.request(
      '/api/sessions',
      { method: 'GET', headers: { Cookie: await loginCookie(memberId) } },
      { ...env },
    );
    await expectCapturedResponse(
      {
        name: 'sessionsListNoAccess',
        endpoint: 'GET /api/sessions (caller has no access to the active show)',
        format: 'ts',
        exportName: 'sessionsListNoAccess',
      },
      res,
    );
  });

  it('GET /api/sessions/:id matches the captured fixture', async () => {
    const { sessionId } = await seedActiveChain();
    const res = await app.request(`/api/sessions/${sessionId}`, { method: 'GET' }, { ...env });
    await expectCapturedResponse(
      {
        name: 'sessionDetail',
        endpoint: 'GET /api/sessions/:id',
        format: 'ts',
        exportName: 'sessionDetail',
      },
      res,
    );
  });

  it('POST /api/sessions matches the captured fixture', async () => {
    const studioId = await activeStudioId();
    const showId = await seedShow({
      studioId,
      name: 'All The Smoke',
      code: 'ATS',
      categoriesJson: CATEGORIES_JSON,
    });
    // session-title-suffix: pin this show to Episode-suffix derivation so the
    // captured title is deterministic (`ATS_0002`) rather than embedding
    // today's UTC date — the Date-suffix derivation path has its own
    // dedicated, non-fixture coverage in sessions.int.test.ts.
    await testDb().run('UPDATE shows SET title_suffix = ? WHERE id = ?', 'episode', showId);
    const res = await app.request(
      '/api/sessions',
      {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ show_id: showId, episode: '002', frame_rate: 24 }),
      },
      { ...env },
    );
    await expectCapturedResponse(
      { name: 'sessionCreate', endpoint: 'POST /api/sessions', format: 'json' },
      res,
    );
  });

  it('PUT /api/sessions/:id matches the captured fixture', async () => {
    const { sessionId } = await seedActiveChain();
    const res = await app.request(
      `/api/sessions/${sessionId}`,
      {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ title: 'Renamed', start_offset_frames: 5 }),
      },
      { ...env },
    );
    await expectCapturedResponse(
      { name: 'sessionUpdate', endpoint: 'PUT /api/sessions/:id', format: 'json' },
      res,
    );
  });

  it('GET /api/sessions/:id/status matches the captured fixture', async () => {
    const { sessionId } = await seedActiveChain();
    const res = await app.request(
      `/api/sessions/${sessionId}/status`,
      { method: 'GET' },
      { ...env },
    );
    await expectCapturedResponse(
      {
        name: 'sessionStatus',
        endpoint: 'GET /api/sessions/:id/status',
        format: 'json',
        // `now − lease acquisition`. `null` in this capture because no client
        // holds the recording lease; declared so a future capture that does
        // hold one is not flaky.
        volatileNumbers: ['audio_recording_lease_age_sec'],
      },
      res,
    );
  });
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

describe('events', () => {
  it('POST /api/sessions/:id/events matches the captured fixture', async () => {
    const { sessionId } = await seedActiveChain();
    const res = await app.request(
      `/api/sessions/${sessionId}/events`,
      {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ category: 'cam', message: 'Cut to 2' }),
      },
      { ...env },
    );
    await expectCapturedResponse(
      { name: 'eventCreate', endpoint: 'POST /api/sessions/:id/events', format: 'json' },
      res,
    );
  });

  it('GET /api/sessions/:id/events matches the captured fixture', async () => {
    const { sessionId } = await seedActiveChain();
    // `eventStore.listEvents` orders `ORDER BY wall_time_utc ASC, id ASC`, so
    // two events landing in the same millisecond would tie-break on the
    // random uuid `id`, making the emitted array order nondeterministic (N1,
    // web-api-shape-conformance phase-4 fix-2 re-review). Explicit,
    // second-apart `marked_at_utc` values remove the tie outright rather than
    // relying on real wall-clock separation between two sequential requests —
    // this doesn't touch `timecode_total_frames`, since the transport here
    // never rolls (`is_rolling` is false), so `timecodeForMark` ignores the
    // mark instant entirely.
    for (const [category, message, markedAtUtc] of [
      ['cam', 'Cut to 2', '2026-06-25T00:00:00.000Z'],
      ['internal', 'Recording started', '2026-06-25T00:00:01.000Z'],
    ]) {
      await app.request(
        `/api/sessions/${sessionId}/events`,
        {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ category, message, marked_at_utc: markedAtUtc }),
        },
        { ...env },
      );
    }
    const res = await app.request(
      `/api/sessions/${sessionId}/events`,
      { method: 'GET' },
      { ...env },
    );
    await expectCapturedResponse(
      { name: 'eventsList', endpoint: 'GET /api/sessions/:id/events', format: 'json' },
      res,
    );
  });
  // session-edit-conflicts design D6: the versioned update and the two version-conflict 409s,
  // captured so the web types `LogEvent` and `EventVersionConflict` are pinned to real bodies.
  // Each conflict is set up the same way: create (version 1), then an unversioned write moves it
  // to version 2, so a request carrying version 1 is stale and `current.version` is 2.
  const eventPut = async (
    sessionId: string,
    eventId: string,
    extra: Record<string, unknown> = {},
  ): Promise<Response> =>
    app.request(
      `/api/sessions/${sessionId}/events/${eventId}`,
      {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          category: 'cam',
          message: 'Cut to 3',
          wall_time_utc: '2026-06-25T00:00:05.000Z',
          timecode_hms: '00:00:01',
          ...extra,
        }),
      },
      { ...env },
    );
  async function seedEvent(): Promise<{ sessionId: string; eventId: string }> {
    const { sessionId } = await seedActiveChain();
    const created = await app.request(
      `/api/sessions/${sessionId}/events`,
      {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ category: 'cam', message: 'Cut to 2' }),
      },
      { ...env },
    );
    return { sessionId, eventId: ((await created.json()) as { event_id: string }).event_id };
  }

  it('PUT /api/sessions/:id/events/:eventId with a current version matches the captured fixture', async () => {
    const { sessionId, eventId } = await seedEvent();
    const res = await eventPut(sessionId, eventId, { version: 1 });
    await expectCapturedResponse(
      { name: 'eventUpdate', endpoint: 'PUT /api/sessions/:id/events/:eventId', format: 'json' },
      res,
    );
  });

  it('PUT …/events/:eventId with a stale version (409) matches the captured fixture', async () => {
    const { sessionId, eventId } = await seedEvent();
    expect((await eventPut(sessionId, eventId, { message: 'Theirs' })).status).toBe(200);
    const res = await eventPut(sessionId, eventId, { version: 1 });
    const body = await expectCapturedResponse(
      {
        name: 'eventUpdateConflict',
        endpoint: 'PUT /api/sessions/:id/events/:eventId (stale version)',
        format: 'json',
        status: 409,
      },
      res,
    );
    expect(body).toMatchObject({ detail: 'Version conflict.', current: { version: 2 } });
  });

  it('DELETE …/events/:eventId?version= with a stale version (409) matches the captured fixture', async () => {
    const { sessionId, eventId } = await seedEvent();
    expect((await eventPut(sessionId, eventId, { message: 'Theirs' })).status).toBe(200);
    const res = await app.request(
      `/api/sessions/${sessionId}/events/${eventId}?version=1`,
      { method: 'DELETE' },
      { ...env },
    );
    const body = await expectCapturedResponse(
      {
        name: 'eventDeleteConflict',
        endpoint: 'DELETE /api/sessions/:id/events/:eventId?version= (stale version)',
        format: 'json',
        status: 409,
      },
      res,
    );
    expect(body).toMatchObject({ detail: 'Version conflict.', current: { version: 2 } });
  });
});

// ---------------------------------------------------------------------------
// Transport — audit CW-1: neither route emits `ok`
// ---------------------------------------------------------------------------

describe('transport', () => {
  it('POST …/transport/start matches the captured fixture', async () => {
    const { sessionId } = await seedActiveChain();
    const res = await app.request(
      `/api/sessions/${sessionId}/transport/start`,
      { method: 'POST' },
      { ...env },
    );
    await expectCapturedResponse(
      {
        name: 'transportStart',
        endpoint: 'POST /api/sessions/:id/transport/start',
        format: 'json',
        // ONLY `timecode_total_frames`. The transport is rolling in this
        // response, so the live timecode advances with wall-clock time between
        // the request and the next capture. `elapsed_frames` does NOT:
        // `TransportStore.startTake` writes `is_rolling`, `current_take` and
        // `roll_started_at_utc` and nothing else, and the emitted value is the
        // stored column, deterministically `0` on a fresh seed. Declaring it
        // volatile zeroed a value the fixture can and should pin (branch-audit
        // finding M2 — a `startTake` mutated to emit 987 passed 26/26 before
        // this line changed, and fails now). `transportStop`'s identical
        // declaration below IS correct: `stopTake` folds the rolled duration in.
        volatileNumbers: ['timecode_total_frames'],
      },
      res,
    );
  });

  it('POST …/transport/stop matches the captured fixture', async () => {
    const { sessionId } = await seedActiveChain();
    await app.request(`/api/sessions/${sessionId}/transport/start`, { method: 'POST' }, { ...env });
    const res = await app.request(
      `/api/sessions/${sessionId}/transport/stop`,
      { method: 'POST' },
      { ...env },
    );
    await expectCapturedResponse(
      {
        name: 'transportStop',
        endpoint: 'POST /api/sessions/:id/transport/stop',
        format: 'json',
        // `stopTake` folds the rolled duration into `elapsed_frames`, so both
        // numbers depend on how long the preceding start→stop pair took.
        volatileNumbers: ['elapsed_frames', 'timecode_total_frames'],
      },
      res,
    );
  });
});

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

describe('audio segments', () => {
  it('POST …/audio/segments matches the captured fixture', async () => {
    const { sessionId } = await seedActiveChain();
    const res = await app.request(
      `/api/sessions/${sessionId}/audio/segments`,
      {
        method: 'POST',
        headers: { 'content-type': 'audio/webm' },
        body: new Uint8Array([1, 2, 3, 4, 5]),
      },
      { ...env },
    );
    await expectCapturedResponse(
      {
        name: 'audioSegmentCreate',
        endpoint: 'POST /api/sessions/:id/audio/segments',
        // media-worker D16: `media_status` is a literal union, which a JSON import widens.
        format: 'ts',
        exportName: 'audioSegmentCreate',
      },
      res,
    );
  });

  it('GET …/audio/segments matches the captured fixture', async () => {
    const { sessionId } = await seedActiveChain();
    await app.request(
      `/api/sessions/${sessionId}/audio/segments`,
      {
        method: 'POST',
        headers: { 'content-type': 'audio/webm' },
        body: new Uint8Array([1, 2, 3, 4, 5]),
      },
      { ...env },
    );
    const res = await app.request(
      `/api/sessions/${sessionId}/audio/segments`,
      { method: 'GET' },
      { ...env },
    );
    await expectCapturedResponse(
      {
        name: 'audioSegmentsList',
        endpoint: 'GET /api/sessions/:id/audio/segments',
        // media-worker D16: `media_status` is a literal union, which a JSON import widens.
        format: 'ts',
        exportName: 'audioSegmentsList',
      },
      res,
    );
  });
});

describe('audio media-worker routes (finalize, resumable uploads)', () => {
  const sha = async (b: Uint8Array) =>
    (await import('node:crypto')).createHash('sha256').update(b).digest('hex');

  it('POST …/audio/recordings/:ord/finalize matches the captured fixture', async () => {
    const { sessionId } = await seedActiveChain();
    for (const [started, ended] of [
      ['2026-10-12T10:00:00.000Z', '2026-10-12T10:10:00.000Z'],
      ['2026-10-12T10:10:00.000Z', '2026-10-12T10:20:00.000Z'],
    ] as const) {
      const q = new URLSearchParams({
        recording_ordinal: '1',
        started_at_utc: started,
        ended_at_utc: ended,
      });
      await app.request(
        `/api/sessions/${sessionId}/audio/segments?${q.toString()}`,
        {
          method: 'POST',
          headers: { 'content-type': 'audio/webm' },
          body: new Uint8Array([1, 2, 3]),
        },
        { ...env },
      );
    }
    const res = await app.request(
      `/api/sessions/${sessionId}/audio/recordings/1/finalize`,
      {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ chunks: ['2026-10-12T10:00:00.000Z', '2026-10-12T10:10:00.000Z'] }),
      },
      { ...env },
    );
    await expectCapturedResponse(
      {
        name: 'audioRecordingFinalize',
        endpoint: 'POST /api/sessions/:id/audio/recordings/:recordingOrdinal/finalize',
        format: 'ts',
        exportName: 'audioRecordingFinalize',
      },
      res,
    );
  });

  it('the upload create, status and complete bodies match the captured fixtures', async () => {
    const { sessionId } = await seedActiveChain();
    const file = new Uint8Array([4, 5, 6, 7, 8]);
    const created = await app.request(
      `/api/sessions/${sessionId}/audio/uploads`,
      {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          content_type: 'audio/wav',
          size_bytes: file.length,
          part_sha256: [await sha(file)],
        }),
      },
      { ...env },
    );
    await expectCapturedResponse(
      {
        name: 'audioUploadCreate',
        endpoint: 'POST /api/sessions/:id/audio/uploads',
        format: 'json',
        status: 201,
      },
      created,
    );
    // The capture redacts the id; read the real one from the database.
    const [row] = await testDb().all<{ id: string }>(
      'SELECT id FROM catalog.media_uploads WHERE session_id = ? ORDER BY created_at_ms DESC LIMIT 1',
      sessionId,
    );
    const id = String(row?.id);
    await app.request(
      `/api/sessions/${sessionId}/audio/uploads/${id}/parts/1`,
      { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: file },
      { ...env },
    );
    await expectCapturedResponse(
      {
        name: 'audioUploadStatus',
        endpoint: 'GET /api/sessions/:id/audio/uploads/:uploadId',
        format: 'json',
      },
      await app.request(
        `/api/sessions/${sessionId}/audio/uploads/${id}`,
        { method: 'GET' },
        { ...env },
      ),
    );
    await expectCapturedResponse(
      {
        name: 'audioUploadComplete',
        endpoint: 'POST /api/sessions/:id/audio/uploads/:uploadId/complete',
        format: 'ts',
        exportName: 'audioUploadComplete',
      },
      await app.request(
        `/api/sessions/${sessionId}/audio/uploads/${id}/complete?duration_s=1`,
        { method: 'POST' },
        { ...env },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Transcript words + topics
// ---------------------------------------------------------------------------

describe('transcript words', () => {
  it('POST …/transcript-words matches the captured fixture', async () => {
    const { sessionId } = await seedActiveChain();
    const res = await app.request(
      `/api/sessions/${sessionId}/transcript-words`,
      {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ session_time: '00:00:10:00', speaker: '0', word: 'hello' }),
      },
      { ...env },
    );
    await expectCapturedResponse(
      {
        name: 'transcriptWordCreate',
        endpoint: 'POST /api/sessions/:id/transcript-words',
        format: 'json',
        status: 201,
      },
      res,
    );
  });

  it('GET …/transcript-words matches the captured fixture', async () => {
    const { sessionId } = await seedActiveChain();
    await app.request(
      `/api/sessions/${sessionId}/transcript-words`,
      {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ session_time: '00:00:10:00', speaker: '0', word: 'hello' }),
      },
      { ...env },
    );
    const res = await app.request(
      `/api/sessions/${sessionId}/transcript-words`,
      { method: 'GET' },
      { ...env },
    );
    await expectCapturedResponse(
      {
        name: 'transcriptWordsList',
        endpoint: 'GET /api/sessions/:id/transcript-words',
        format: 'json',
      },
      res,
    );
  });
  // session-edit-conflicts design D6: the versioned update and the two version-conflict 409s
  // (create at version 1, an unversioned PATCH to version 2, then a stale request at version 1).
  const wordCreate = async (): Promise<{ sessionId: string; id: string }> => {
    const { sessionId } = await seedActiveChain();
    const created = await app.request(
      `/api/sessions/${sessionId}/transcript-words`,
      {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ session_time: '00:00:10:00', speaker: '0', word: 'hello' }),
      },
      { ...env },
    );
    return { sessionId, id: ((await created.json()) as { id: string }).id };
  };
  const wordPatch = async (
    sessionId: string,
    id: string,
    body: Record<string, unknown>,
  ): Promise<Response> =>
    app.request(
      `/api/sessions/${sessionId}/transcript-words/${id}`,
      { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(body) },
      { ...env },
    );

  it('PATCH …/transcript-words/:wordId with a current version matches the captured fixture', async () => {
    const { sessionId, id } = await wordCreate();
    const res = await wordPatch(sessionId, id, { word: 'hi', version: 1 });
    await expectCapturedResponse(
      {
        name: 'transcriptWordUpdate',
        endpoint: 'PATCH /api/sessions/:id/transcript-words/:wordId',
        format: 'json',
      },
      res,
    );
  });

  it('PATCH …/transcript-words/:wordId with a stale version (409) matches the captured fixture', async () => {
    const { sessionId, id } = await wordCreate();
    expect((await wordPatch(sessionId, id, { word: 'hullo' })).status).toBe(200);
    const res = await wordPatch(sessionId, id, { word: 'hi', version: 1 });
    const body = await expectCapturedResponse(
      {
        name: 'transcriptWordUpdateConflict',
        endpoint: 'PATCH /api/sessions/:id/transcript-words/:wordId (stale version)',
        format: 'json',
        status: 409,
      },
      res,
    );
    expect(body).toMatchObject({ detail: 'Version conflict.', current: { version: 2 } });
  });

  it('DELETE …/transcript-words/:wordId?version= with a stale version (409) matches the captured fixture', async () => {
    const { sessionId, id } = await wordCreate();
    expect((await wordPatch(sessionId, id, { word: 'hullo' })).status).toBe(200);
    const res = await app.request(
      `/api/sessions/${sessionId}/transcript-words/${id}?version=1`,
      { method: 'DELETE' },
      { ...env },
    );
    const body = await expectCapturedResponse(
      {
        name: 'transcriptWordDeleteConflict',
        endpoint: 'DELETE /api/sessions/:id/transcript-words/:wordId?version= (stale version)',
        format: 'json',
        status: 409,
      },
      res,
    );
    expect(body).toMatchObject({ detail: 'Version conflict.', current: { version: 2 } });
  });
});

describe('topics', () => {
  it('POST …/topics matches the captured fixture', async () => {
    const { sessionId } = await seedActiveChain();
    const res = await app.request(
      `/api/sessions/${sessionId}/topics`,
      {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          session_time: '00:00:10:00',
          duration_sec: 30,
          topic_level: 1,
          summary: 'A summary',
        }),
      },
      { ...env },
    );
    await expectCapturedResponse(
      {
        name: 'topicCreate',
        endpoint: 'POST /api/sessions/:id/topics',
        format: 'json',
        status: 201,
      },
      res,
    );
  });

  it('GET …/topics matches the captured fixture', async () => {
    const { sessionId } = await seedActiveChain();
    await app.request(
      `/api/sessions/${sessionId}/topics`,
      {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          session_time: '00:00:10:00',
          duration_sec: 30,
          topic_level: 1,
          summary: 'A summary',
        }),
      },
      { ...env },
    );
    const res = await app.request(
      `/api/sessions/${sessionId}/topics`,
      { method: 'GET' },
      { ...env },
    );
    await expectCapturedResponse(
      { name: 'topicsList', endpoint: 'GET /api/sessions/:id/topics', format: 'json' },
      res,
    );
  });
  // session-edit-conflicts design D6: the versioned update and the two version-conflict 409s
  // (create at version 1, an unversioned PATCH to version 2, then a stale request at version 1).
  const topicCreate = async (): Promise<{ sessionId: string; id: string }> => {
    const { sessionId } = await seedActiveChain();
    const created = await app.request(
      `/api/sessions/${sessionId}/topics`,
      {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          session_time: '00:00:10:00',
          duration_sec: 30,
          topic_level: 1,
          summary: 'A summary',
        }),
      },
      { ...env },
    );
    return { sessionId, id: ((await created.json()) as { id: string }).id };
  };
  const topicPatch = async (
    sessionId: string,
    id: string,
    body: Record<string, unknown>,
  ): Promise<Response> =>
    app.request(
      `/api/sessions/${sessionId}/topics/${id}`,
      { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(body) },
      { ...env },
    );

  it('PATCH …/topics/:topicId with a current version matches the captured fixture', async () => {
    const { sessionId, id } = await topicCreate();
    const res = await topicPatch(sessionId, id, { summary: 'My summary', version: 1 });
    await expectCapturedResponse(
      { name: 'topicUpdate', endpoint: 'PATCH /api/sessions/:id/topics/:topicId', format: 'json' },
      res,
    );
  });

  it('PATCH …/topics/:topicId with a stale version (409) matches the captured fixture', async () => {
    const { sessionId, id } = await topicCreate();
    expect((await topicPatch(sessionId, id, { summary: 'Their summary' })).status).toBe(200);
    const res = await topicPatch(sessionId, id, { summary: 'My summary', version: 1 });
    const body = await expectCapturedResponse(
      {
        name: 'topicUpdateConflict',
        endpoint: 'PATCH /api/sessions/:id/topics/:topicId (stale version)',
        format: 'json',
        status: 409,
      },
      res,
    );
    expect(body).toMatchObject({ detail: 'Version conflict.', current: { version: 2 } });
  });

  it('DELETE …/topics/:topicId?version= with a stale version (409) matches the captured fixture', async () => {
    const { sessionId, id } = await topicCreate();
    expect((await topicPatch(sessionId, id, { summary: 'Their summary' })).status).toBe(200);
    const res = await app.request(
      `/api/sessions/${sessionId}/topics/${id}?version=1`,
      { method: 'DELETE' },
      { ...env },
    );
    const body = await expectCapturedResponse(
      {
        name: 'topicDeleteConflict',
        endpoint: 'DELETE /api/sessions/:id/topics/:topicId?version= (stale version)',
        format: 'json',
        status: 409,
      },
      res,
    );
    expect(body).toMatchObject({ detail: 'Version conflict.', current: { version: 2 } });
  });
});

// ---------------------------------------------------------------------------
// Teams — `GET /api/teams/:id` is caller-dependent (audit row 26)
// ---------------------------------------------------------------------------

/** A team with an owner (Olu) and an admin (Ann), the caller of most captures (owner-bootstrap
 * D13: owner-only routes are captured as the owner). */
async function seedTeam(): Promise<{
  team: string;
  adminId: string;
  adminCookie: string;
  ownerId: string;
  ownerCookie: string;
}> {
  const team = await seedStudio({ id: 'my-crew', name: 'My Crew' });
  const ownerId = await seedUser({ email: 'olu@example.com', sub: 'sub-olu' });
  await catalogFor().auth.authAddMembershipWithRole(ownerId, team, 'owner');
  const adminId = await seedUser({ email: 'ann@example.com', sub: 'sub-ann' });
  await catalogFor().auth.authAddMembershipWithRole(adminId, team, 'admin');
  return {
    team,
    adminId,
    adminCookie: await loginCookie(adminId),
    ownerId,
    ownerCookie: await loginCookie(ownerId),
  };
}

/** A show in the team granted to the member (show-grants D6: the manager views' `show_ids`). */
async function grantBoAShow(team: string, memberId: string, grantedBy: string): Promise<string> {
  const showId = await seedShow({ studioId: team, name: 'All The Smoke', code: 'ATS' });
  await catalogFor().auth.authGrantShow(memberId, showId, grantedBy, new Date().toISOString());
  return showId;
}

describe('teams', () => {
  it('POST /api/teams matches the captured fixture', async () => {
    const cookie = await loginCookie(await seedUser({ email: 'ann@example.com', sub: 'sub-ann' }));
    const res = await app.request(
      '/api/teams',
      {
        method: 'POST',
        headers: { ...JSON_HEADERS, Cookie: cookie },
        body: JSON.stringify({ id: 'my-crew', display_name: 'My Crew' }),
      },
      { ...env },
    );
    await expectCapturedResponse(
      { name: 'teamCreate', endpoint: 'POST /api/teams', format: 'ts', exportName: 'teamCreate' },
      res,
    );
  });

  it('GET /api/teams/:id as an admin matches the captured fixture (carries `invites` and `show_ids`)', async () => {
    const { team, adminId, adminCookie } = await seedTeam();
    const memberId = await seedUser({ email: 'bo@example.com', sub: 'sub-bo' });
    await catalogFor().auth.authAddMembershipWithRole(memberId, team, 'member');
    await grantBoAShow(team, memberId, adminId);
    await app.request(
      `/api/teams/${team}/invites`,
      {
        method: 'POST',
        headers: { ...JSON_HEADERS, Cookie: adminCookie },
        body: JSON.stringify({ email: 'pending@example.com' }),
      },
      { ...env },
    );

    const res = await app.request(
      `/api/teams/${team}`,
      { method: 'GET', headers: { Cookie: adminCookie } },
      { ...env },
    );
    const body = await expectCapturedResponse(
      {
        name: 'teamDetailAdmin',
        endpoint: 'GET /api/teams/:id (caller is a team admin)',
        format: 'ts',
        exportName: 'teamDetailAdmin',
      },
      res,
    );
    expect(body).toHaveProperty('invites');
  });

  it('GET /api/teams/:id as a member matches the captured fixture (no `invites` key)', async () => {
    const { team, adminCookie } = await seedTeam();
    const memberId = await seedUser({ email: 'bo@example.com', sub: 'sub-bo' });
    await catalogFor().auth.authAddMembershipWithRole(memberId, team, 'member');
    await app.request(
      `/api/teams/${team}/invites`,
      {
        method: 'POST',
        headers: { ...JSON_HEADERS, Cookie: adminCookie },
        body: JSON.stringify({ email: 'pending@example.com' }),
      },
      { ...env },
    );

    const res = await app.request(
      `/api/teams/${team}`,
      { method: 'GET', headers: { Cookie: await loginCookie(memberId) } },
      { ...env },
    );
    const body = await expectCapturedResponse(
      {
        name: 'teamDetailMember',
        endpoint: 'GET /api/teams/:id (caller is a plain member)',
        format: 'ts',
        exportName: 'teamDetailMember',
      },
      res,
    );
    // The branch that makes `invites` optional on `TeamDetail` — the same
    // pending invite exists, and the member's body simply does not carry it.
    expect(body).not.toHaveProperty('invites');
  });

  it('PATCH /api/teams/:id matches the captured fixture', async () => {
    const { team, adminCookie } = await seedTeam();
    const res = await app.request(
      `/api/teams/${team}`,
      {
        method: 'PATCH',
        headers: { ...JSON_HEADERS, Cookie: adminCookie },
        body: JSON.stringify({ display_name: 'My Crew Renamed' }),
      },
      { ...env },
    );
    await expectCapturedResponse(
      { name: 'teamRename', endpoint: 'PATCH /api/teams/:id', format: 'json' },
      res,
    );
  });

  it('GET /api/teams/:id as the owner matches the captured fixture (carries `invites` and `show_ids`)', async () => {
    const { team, ownerId, ownerCookie } = await seedTeam();
    const memberId = await seedUser({ email: 'bo@example.com', sub: 'sub-bo' });
    await catalogFor().auth.authAddMembershipWithRole(memberId, team, 'member');
    await grantBoAShow(team, memberId, ownerId);
    await app.request(
      `/api/teams/${team}/invites`,
      {
        method: 'POST',
        headers: { ...JSON_HEADERS, Cookie: ownerCookie },
        body: JSON.stringify({ email: 'pending@example.com' }),
      },
      { ...env },
    );

    const res = await app.request(
      `/api/teams/${team}`,
      { method: 'GET', headers: { Cookie: ownerCookie } },
      { ...env },
    );
    const body = await expectCapturedResponse(
      {
        name: 'teamDetailOwner',
        endpoint: 'GET /api/teams/:id (caller is the team owner)',
        format: 'ts',
        exportName: 'teamDetailOwner',
      },
      res,
    );
    expect(body).toHaveProperty('invites');
  });

  it('POST /api/teams/:id/owner matches the captured fixture', async () => {
    const { team, ownerCookie } = await seedTeam();
    const memberId = await seedUser({ email: 'bo@example.com', sub: 'sub-bo' });
    await catalogFor().auth.authAddMembershipWithRole(memberId, team, 'member');
    const res = await app.request(
      `/api/teams/${team}/owner`,
      {
        method: 'POST',
        headers: { ...JSON_HEADERS, Cookie: ownerCookie },
        body: JSON.stringify({ user_id: memberId }),
      },
      { ...env },
    );
    await expectCapturedResponse(
      { name: 'teamOwnerTransfer', endpoint: 'POST /api/teams/:id/owner', format: 'json' },
      res,
    );
  });

  it('POST …/members/:uid/role matches the captured fixture', async () => {
    const { team, ownerCookie } = await seedTeam();
    const memberId = await seedUser({ email: 'bo@example.com', sub: 'sub-bo' });
    await catalogFor().auth.authAddMembershipWithRole(memberId, team, 'member');
    const res = await app.request(
      `/api/teams/${team}/members/${memberId}/role`,
      {
        method: 'POST',
        headers: { ...JSON_HEADERS, Cookie: ownerCookie },
        body: JSON.stringify({ role: 'admin' }),
      },
      { ...env },
    );
    await expectCapturedResponse(
      {
        name: 'teamRoleChange',
        endpoint: 'POST /api/teams/:id/members/:uid/role',
        format: 'ts',
        exportName: 'teamRoleChange',
      },
      res,
    );
  });

  it('PUT /api/teams/:id/shows/:showId/grants/:userId matches the captured fixture', async () => {
    const { team, adminCookie } = await seedTeam();
    const memberId = await seedUser({ email: 'bo@example.com', sub: 'sub-bo' });
    await catalogFor().auth.authAddMembershipWithRole(memberId, team, 'member');
    const showId = await seedShow({ studioId: team, name: 'All The Smoke', code: 'ATS' });
    const res = await app.request(
      `/api/teams/${team}/shows/${showId}/grants/${memberId}`,
      { method: 'PUT', headers: { Cookie: adminCookie } },
      { ...env },
    );
    await expectCapturedResponse(
      {
        name: 'showGrantPut',
        endpoint: 'PUT /api/teams/:id/shows/:showId/grants/:userId',
        format: 'ts',
        exportName: 'showGrantPut',
      },
      res,
    );
  });
});

// ---------------------------------------------------------------------------
// Transcript generation status — both sides of the `in_flight` discriminated
// union (pr-3-review test-gap wave). `.ts` fixtures: the client type carries
// the literal discriminants `in_flight: false` / `in_flight: true`, which a
// JSON import would widen to `boolean` (design D4's wrinkle).
// ---------------------------------------------------------------------------

describe('GET /api/transcript-generation/status', () => {
  it('idle matches the captured fixture', async () => {
    const res = await app.request(
      '/api/transcript-generation/status',
      { method: 'GET' },
      { ...env },
    );
    await expectCapturedResponse(
      {
        name: 'transcriptGenerationStatusIdle',
        endpoint: 'GET /api/transcript-generation/status (idle)',
        format: 'ts',
        exportName: 'transcriptGenerationStatusIdle',
      },
      res,
    );
  });

  it('busy matches the captured fixture (a member sees the holder)', async () => {
    // The MEMBER view: full identifiers. The cross-tenant
    // REDACTED view differs only by `session_id`/`session_title` going null
    // (same key set — see transcribe.int.test.ts), so the web tier covers it
    // type-level off this same fixture with a nulled spread rather than a
    // second capture.
    const studioId = await seedMemberStudio();
    const showId = await seedShow({ studioId });
    const sessionId = await seedSession({ showId, episode: '002', title: 'ATS - 2' });
    // Fixed run start — redacted to `#`s anyway, but deterministic. The status reads the live
    // lease (run-status-and-sweeper D5), so the case seeds one.
    await liveLeaseOfAnotherProcess(sessionId, 'transcript-generation', 1_700_000_000_000);
    const res = await app.request(
      '/api/transcript-generation/status',
      { method: 'GET' },
      { ...env },
    );
    await expectCapturedResponse(
      {
        name: 'transcriptGenerationStatusBusy',
        endpoint: 'GET /api/transcript-generation/status (busy, holder visible)',
        format: 'ts',
        exportName: 'transcriptGenerationStatusBusy',
      },
      res,
    );
  });
});

// ---------------------------------------------------------------------------
// Sheets log import — the POST job handle and a TERMINAL job status
// (pr-3-review test-gap wave). Needs the config gate + loopback HOST (the
// logImport.int.test.ts `enabledEnv` pattern) and a stubbed global fetch, so
// the async job reaches a deterministic terminal state with no egress: the
// stub serves HTML, which fetchPublicWorkbookSheets rejects with a fixed
// message on both of its candidate URLs.
// ---------------------------------------------------------------------------

describe('log-import', () => {
  it('POST /api/shows/:showId/log-import and GET /api/log-import/:jobId (terminal) match the captured fixtures', async () => {
    const studioId = await seedMemberStudio();
    const showId = await seedShow({ studioId });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<!DOCTYPE html><html></html>', { status: 200 })),
    );
    try {
      const bindings = envWith({ SHEETS_LOG_IMPORT_ENABLED: '1', HOST: '127.0.0.1' });
      const post = await app.request(
        `/api/shows/${showId}/log-import`,
        {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({
            spreadsheet_url: 'https://docs.google.com/spreadsheets/d/abc123xyz/edit',
          }),
        },
        bindings,
      );
      // The capture consumes the body (redacting the uuid), so the live job id
      // for the GET below has to come from a clone read first.
      const postClone = post.clone();
      await expectCapturedResponse(
        {
          name: 'logImportJobCreate',
          endpoint: 'POST /api/shows/:showId/log-import',
          format: 'json',
        },
        post,
      );
      const { job_id } = (await postClone.json()) as { job_id: string };

      // Poll to the terminal state; capture THAT, not a racy in-flight body.
      let status = 'queued';
      for (let i = 0; i < 80 && status !== 'failed' && status !== 'completed'; i++) {
        const probe = await app.request(`/api/log-import/${job_id}`, {}, { ...env });
        expect(probe.status).toBe(200);
        status = ((await probe.json()) as { status: string }).status;
        if (status !== 'failed' && status !== 'completed') {
          await new Promise((r) => setTimeout(r, 25));
        }
      }
      expect(status).toBe('failed');

      const get = await app.request(`/api/log-import/${job_id}`, {}, { ...env });
      await expectCapturedResponse(
        {
          name: 'logImportJobStatus',
          endpoint: 'GET /api/log-import/:jobId (terminal: failed download)',
          format: 'ts',
          exportName: 'logImportJobStatus',
        },
        get,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ---------------------------------------------------------------------------
// Companion devices (companion-devices task 7.1, design D6): the list (a never-used device and
// an expired one with a last use) and the one-time create body, whose token is redacted by
// pattern (`ald_` + 43 masked characters).
// ---------------------------------------------------------------------------

describe('companion devices', () => {
  it('POST and GET /api/companion-devices match the captured fixtures', async () => {
    const cookie = await loginCookie(await seedUser({ email: 'ann@example.com', sub: 'sub-ann' }));
    const post = (name: string) =>
      app.request(
        '/api/companion-devices',
        {
          method: 'POST',
          headers: { ...JSON_HEADERS, Cookie: cookie },
          body: JSON.stringify({ name }),
        },
        { ...env },
      );
    const createRes = await post('Booth A');
    const createClone = createRes.clone();
    await expectCapturedResponse(
      {
        name: 'companionDeviceCreate',
        endpoint: 'POST /api/companion-devices',
        format: 'json',
        status: 201,
      },
      createRes,
    );
    const boothA = ((await createClone.json()) as { id: string }).id;
    const boothB = ((await (await post('Booth B')).json()) as { id: string }).id;

    // Booth A: idle past the 90-day window with a last use, so `expired: true` and a non-null
    // `last_used_at`; Booth B: never used. Distinct created times fix the list order.
    const DAY = 86_400_000;
    await testDb().run(
      'UPDATE companion_devices SET created_at_utc = ?, last_used_at_utc = ? WHERE id = ?',
      new Date(Date.now() - 200 * DAY).toISOString(),
      new Date(Date.now() - 120 * DAY).toISOString(),
      boothA,
    );
    await testDb().run(
      'UPDATE companion_devices SET created_at_utc = ? WHERE id = ?',
      new Date(Date.now() - DAY).toISOString(),
      boothB,
    );

    const list = await app.request(
      '/api/companion-devices',
      { method: 'GET', headers: { Cookie: cookie } },
      { ...env },
    );
    const body = await expectCapturedResponse(
      { name: 'companionDevicesList', endpoint: 'GET /api/companion-devices', format: 'json' },
      list,
    );
    expect(body).toMatchObject({
      devices: [
        { name: 'Booth B', last_used_at: null, expired: false },
        { name: 'Booth A', expired: true },
      ],
    });
  });
});

// ---------------------------------------------------------------------------
// Provider credentials (byo-ai-providers task 6.1, design D6): the list with both kinds, one save
// and one connection-test result, as `useProviders.ts` types them. The key never appears; only
// its last four characters do.
// ---------------------------------------------------------------------------

describe('provider credentials', () => {
  it('GET, PUT and POST test on /api/me/providers match the captured fixtures', async () => {
    const cookie = await loginCookie(await seedUser({ email: 'pat@example.com', sub: 'sub-pat' }));
    const put = (kind: string, body: unknown) =>
      app.request(
        `/api/me/providers/${kind}`,
        { method: 'PUT', headers: { ...JSON_HEADERS, Cookie: cookie }, body: JSON.stringify(body) },
        envWith({ PROVIDER_DEV_MODE: false }),
      );
    const saved = await put('stt', {
      provider: 'deepgram',
      model: 'nova-3',
      api_key: 'dg_secret_abcd',
    });
    await expectCapturedResponse(
      { name: 'providerSave', endpoint: 'PUT /api/me/providers/:kind', format: 'json' },
      saved,
    );
    expect(
      (
        await put('llm', {
          provider: 'openai-compatible',
          base_url: 'https://api.example.com/v1',
          model: 'gpt-4o-mini',
          api_key: 'sk-test-0123456789-9f2c',
        })
      ).status,
    ).toBe(200);

    const list = await app.request(
      '/api/me/providers',
      { method: 'GET', headers: { Cookie: cookie } },
      { ...env },
    );
    const body = await expectCapturedResponse(
      { name: 'providersList', endpoint: 'GET /api/me/providers', format: 'json' },
      list,
    );
    expect(JSON.stringify(body)).not.toMatch(/dg_secret|sk-test/);

    // A connection-test result, against a local fake standing in for DeepGram.
    const { createServer } = await import('node:http');
    const { ProviderTester } = await import('../auth/providerTester');
    const fake = createServer((_req, res) => {
      _req.resume();
      _req.on('end', () => res.end('{}'));
    });
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;
    try {
      const test = await app.request(
        '/api/me/providers/stt/test',
        { method: 'POST', headers: { Cookie: cookie } },
        envWith(
          { PROVIDER_DEV_MODE: false },
          {
            providerTester: new ProviderTester({
              openai: origin,
              anthropic: origin,
              google: origin,
              deepgram: origin,
            }),
          },
        ),
      );
      await expectCapturedResponse(
        { name: 'providerTest', endpoint: 'POST /api/me/providers/:kind/test', format: 'json' },
        test,
      );
    } finally {
      await new Promise((r) => fake.close(r));
    }
  });
  // ai-sdk-agent-harness D2: the keyless claude-cli save, by an allowlisted caller.
  it('PUT of the claude-cli provider matches the captured fixture (key_last4 null)', async () => {
    const cookie = await loginCookie(
      await seedUser({ email: 'cli-dev@example.com', sub: 'sub-cli-dev' }),
    );
    const saved = await app.request(
      '/api/me/providers/llm',
      {
        method: 'PUT',
        headers: { ...JSON_HEADERS, Cookie: cookie },
        body: JSON.stringify({ provider: 'claude-cli' }),
      },
      envWith({
        PROVIDER_DEV_MODE: false,
        CLAUDE_CLI_PATH: '/fake/claude',
        CLAUDE_CLI_EMAILS: 'cli-dev@example.com',
      }),
    );
    const body = await expectCapturedResponse(
      {
        name: 'providerSaveClaudeCli',
        endpoint: 'PUT /api/me/providers/:kind',
        format: 'json',
      },
      saved,
    );
    expect(body).toMatchObject({ provider: 'claude-cli', model: 'claude-cli', key_last4: null });
  });
});

// ---------------------------------------------------------------------------
// Catalog search (catalog-search task 4.4, design D5): one result with every group filled, so the
// fixture carries a studio, a show, a session (`match` title, `snippet` null) and the three moment
// kinds (`sec` a number for the transcript moment, null for the topic and the event). A `.ts`
// fixture: `match` and `kind` are string-literal unions.
// ---------------------------------------------------------------------------

describe('catalog search', () => {
  it('GET /api/search matches the captured fixture', async () => {
    const at = '2026-10-12T10:00:00.000Z';
    const studioId = await seedMemberStudio({ id: 'search-studio', name: 'Beacon Studio' });
    const showId = await seedShow({ studioId, name: 'Beacon Show', code: 'BS' });
    const sessionId = await catalogFor().sessions.createSessionIndex({
      showId,
      title: 'Beacon session',
      frameRate: 24,
      startOffsetFrames: 0,
      episode: '007',
      notes: 'notes about the beacon',
      startedAtUtc: at,
      createdAtUtc: at,
    });
    const db = testDb();
    for (const [i, word] of ['we', 'lit', 'the', 'beacon', 'tonight'].entries()) {
      await db.run(
        `INSERT INTO session_transcript_words
           (session_id, id, session_time, speaker, word, start_sec, end_sec, ordinal, created_at_utc)
         VALUES (?, ?, '', 'Ann', ?, ?, ?, ?, ?)`,
        sessionId,
        `w${i}`,
        word,
        12 + i,
        12.5 + i,
        i,
        at,
      );
    }
    await db.run(
      `INSERT INTO session_topics (session_id, id, summary, ordinal, created_at_utc)
       VALUES (?, 'topic-1', 'Talk about the beacon', 0, ?)`,
      sessionId,
      at,
    );
    await db.run(
      `INSERT INTO session_events (session_id, id, wall_time_utc, frame_rate, category, message)
       VALUES (?, 'event-1', ?, 24, 'cam', 'beacon on camera')`,
      sessionId,
      at,
    );
    const res = await app.request('/api/search?q=beacon', {}, { ...env });
    const body = await expectCapturedResponse(
      { name: 'search', endpoint: 'GET /api/search', format: 'ts' },
      res,
    );
    expect(body).toMatchObject({ q: 'beacon', studios: [{ name: 'Beacon Studio' }] });
    const kinds = (body as { moments: { kind: string }[] }).moments.map((m) => m.kind).sort();
    expect(kinds).toEqual(['event', 'topic', 'transcript']);
  });
});

// ---------------------------------------------------------------------------
// Show wiki (show-wiki task 4.3, design D6, D8 category 5): one capture per wiki route, plus the
// version-conflict branch of `PUT`. The default member (an admin of the seeded team) writes, so
// every `*_by_name` is "Default User". `.ts` fixtures: `kind` is a string-literal union in every
// page, list item and revision (design D4's rule, as for `search`).
// ---------------------------------------------------------------------------

describe('show wiki', () => {
  async function wikiSend(method: string, path: string, body?: unknown): Promise<Response> {
    return app.request(
      path,
      body === undefined
        ? { method }
        : { method, headers: JSON_HEADERS, body: JSON.stringify(body) },
      { ...env },
    );
  }

  /** A show with a person page (body, two aliases, revision 2), a topic page, and a session page;
   * the default member administers its team. */
  async function seedWiki() {
    const studioId = await seedMemberStudio();
    const showId = await seedShow({ studioId, name: 'Wiki Show', code: 'WS' });
    const sessionId = await seedSession({ showId, episode: '003', title: 'WS - 3' });
    const create = async (body: unknown) => {
      const res = await wikiSend('POST', `/api/shows/${showId}/wiki/pages`, body);
      expect(res.status).toBe(201);
      return (await res.json()) as { id: string; revision: number };
    };
    const person = await create({
      kind: 'person',
      title: 'Christina Ramos',
      body_md: 'Co-host.',
      aliases: ['Tina', 'C. Ramos'],
    });
    const edited = await wikiSend('PUT', `/api/wiki/pages/${person.id}`, {
      expected_revision: 1,
      body_md: `Co-host. See [the cold open](cite:${sessionId}@12.5).`,
    });
    expect(edited.status).toBe(200);
    const topic = await create({ kind: 'topic', title: 'Cold opens', body_md: 'Running list.' });
    const session = await create({ kind: 'session', title: 'WS - 3', session_id: sessionId });
    return { showId, sessionId, person, topic, session };
  }

  it('GET /api/shows/:showId/wiki/pages matches the captured fixture', async () => {
    const { showId } = await seedWiki();
    const res = await wikiSend('GET', `/api/shows/${showId}/wiki/pages`);
    const body = await expectCapturedResponse(
      {
        name: 'wikiPageList',
        endpoint: 'GET /api/shows/:showId/wiki/pages',
        format: 'ts',
      },
      res,
    );
    expect(body).toMatchObject({ truncated: false });
    expect((body as { pages: unknown[] }).pages).toHaveLength(3);
  });

  it('POST /api/shows/:showId/wiki/pages matches the captured fixture', async () => {
    const studioId = await seedMemberStudio();
    const showId = await seedShow({ studioId, name: 'Wiki Show', code: 'WS' });
    const res = await wikiSend('POST', `/api/shows/${showId}/wiki/pages`, {
      kind: 'bit',
      title: 'The Ladder',
      body_md: 'A running bit.',
      aliases: ['Step Ladder'],
    });
    const body = await expectCapturedResponse(
      {
        name: 'wikiPageCreate',
        endpoint: 'POST /api/shows/:showId/wiki/pages',
        format: 'ts',
        status: 201,
      },
      res,
    );
    expect(body).toMatchObject({ revision: 1, deleted: false, merged_into: null });
  });

  it('GET /api/wiki/pages/:pageId matches the captured fixture', async () => {
    const { person } = await seedWiki();
    const res = await wikiSend('GET', `/api/wiki/pages/${person.id}`);
    const body = await expectCapturedResponse(
      { name: 'wikiPage', endpoint: 'GET /api/wiki/pages/:pageId', format: 'ts' },
      res,
    );
    expect(body).toMatchObject({ title: 'Christina Ramos', revision: 2 });
  });

  it('PUT /api/wiki/pages/:pageId matches the captured fixture', async () => {
    const { person } = await seedWiki();
    const res = await wikiSend('PUT', `/api/wiki/pages/${person.id}`, {
      expected_revision: 2,
      title: 'Christina R. Ramos',
      aliases: ['Tina'],
    });
    const body = await expectCapturedResponse(
      { name: 'wikiPageUpdate', endpoint: 'PUT /api/wiki/pages/:pageId', format: 'ts' },
      res,
    );
    expect(body).toMatchObject({ revision: 3, aliases: ['Tina'] });
  });

  it('PUT /api/wiki/pages/:pageId with a stale revision (409) matches the captured fixture', async () => {
    const { person } = await seedWiki();
    const res = await wikiSend('PUT', `/api/wiki/pages/${person.id}`, {
      expected_revision: 1,
      body_md: 'late',
    });
    const body = await expectCapturedResponse(
      {
        name: 'wikiPageUpdateConflict',
        endpoint: 'PUT /api/wiki/pages/:pageId (stale revision)',
        format: 'ts',
        status: 409,
      },
      res,
    );
    expect(body).toMatchObject({ detail: 'Version conflict.', current: { revision: 2 } });
  });

  it('DELETE /api/wiki/pages/:pageId?expected_revision= matches the captured fixture', async () => {
    const { topic } = await seedWiki();
    const res = await wikiSend('DELETE', `/api/wiki/pages/${topic.id}?expected_revision=1`);
    const body = await expectCapturedResponse(
      {
        name: 'wikiPageDelete',
        endpoint: 'DELETE /api/wiki/pages/:pageId?expected_revision=',
        format: 'ts',
      },
      res,
    );
    expect(body).toMatchObject({ deleted: true, revision: 2 });
  });

  it('POST /api/wiki/pages/:pageId/restore matches the captured fixture', async () => {
    const { topic } = await seedWiki();
    const del = await wikiSend('DELETE', `/api/wiki/pages/${topic.id}?expected_revision=1`);
    expect(del.status).toBe(200);
    const res = await wikiSend('POST', `/api/wiki/pages/${topic.id}/restore`, {
      expected_revision: 2,
    });
    const body = await expectCapturedResponse(
      {
        name: 'wikiPageRestore',
        endpoint: 'POST /api/wiki/pages/:pageId/restore',
        format: 'ts',
      },
      res,
    );
    expect(body).toMatchObject({ deleted: false, revision: 3 });
  });

  it('GET /api/wiki/pages/:pageId/revisions matches the captured fixture', async () => {
    const { person } = await seedWiki();
    const res = await wikiSend('GET', `/api/wiki/pages/${person.id}/revisions?limit=1`);
    const body = await expectCapturedResponse(
      {
        name: 'wikiRevisionList',
        endpoint: 'GET /api/wiki/pages/:pageId/revisions',
        format: 'ts',
      },
      res,
    );
    expect(body).toMatchObject({ next_before: 2, revisions: [{ revision: 2, note: 'edited' }] });
  });

  it('GET /api/wiki/pages/:pageId/revisions/:rev matches the captured fixture', async () => {
    const { person } = await seedWiki();
    const res = await wikiSend('GET', `/api/wiki/pages/${person.id}/revisions/1`);
    const body = await expectCapturedResponse(
      {
        name: 'wikiRevision',
        endpoint: 'GET /api/wiki/pages/:pageId/revisions/:rev',
        format: 'ts',
      },
      res,
    );
    expect(body).toMatchObject({ revision: 1, note: 'created', body_md: 'Co-host.' });
  });

  it('POST /api/wiki/pages/:pageId/merge matches the captured fixture', async () => {
    const { person, topic } = await seedWiki();
    const res = await wikiSend('POST', `/api/wiki/pages/${topic.id}/merge`, {
      into_page_id: person.id,
      expected_revision: 1,
      into_expected_revision: 2,
    });
    const body = await expectCapturedResponse(
      { name: 'wikiMerge', endpoint: 'POST /api/wiki/pages/:pageId/merge', format: 'ts' },
      res,
    );
    expect(body).toMatchObject({
      page: { revision: 3, aliases: ['Tina', 'C. Ramos', 'Cold opens'] },
    });
  });

  it('POST /api/wiki/pages/:pageId/split matches the captured fixture', async () => {
    const { topic } = await seedWiki();
    const res = await wikiSend('POST', `/api/wiki/pages/${topic.id}/split`, {
      expected_revision: 1,
      remaining_body_md: 'Running list.',
      new_page: { kind: 'bit', title: 'The Ladder', body_md: 'Moved here.', aliases: ['Ladder'] },
    });
    const body = await expectCapturedResponse(
      {
        name: 'wikiSplit',
        endpoint: 'POST /api/wiki/pages/:pageId/split',
        format: 'ts',
        status: 201,
      },
      res,
    );
    expect(body).toMatchObject({ page: { revision: 2 }, new_page: { revision: 1, kind: 'bit' } });
  });
});

// ---------------------------------------------------------------------------
// Wiki suggestions (show-wiki-ai task 5.2, design D5, D7 category 3): one capture per suggestion
// route, plus the version-conflict branch of accept and the already-resolved 409. The default
// member (an admin of the seeded team) writes and reviews, so every `*_by_name` is "Default User".
// `wiki/generate` runs on the AI SDK route against the local fake provider. `.ts` fixtures: `kind`
// and `status` are string-literal unions.
// ---------------------------------------------------------------------------

describe('wiki suggestions', () => {
  async function send(method: string, path: string, body?: unknown, on = env): Promise<Response> {
    return app.request(
      path,
      body === undefined
        ? { method }
        : { method, headers: JSON_HEADERS, body: JSON.stringify(body) },
      { ...on },
    );
  }

  /** A show with a person page (revision 1), a pending edit of it, and a pending new topic page,
   * stored as two runs of the default member, oldest first. */
  async function seedSuggestions() {
    const studioId = await seedMemberStudio();
    const showId = await seedShow({ studioId, name: 'Wiki Show', code: 'WS' });
    const sessionId = await seedSession({ showId, episode: '003', title: 'WS - 3' });
    const created = await send('POST', `/api/shows/${showId}/wiki/pages`, {
      kind: 'person',
      title: 'Christina Ramos',
      body_md: 'Co-host.',
      aliases: ['Tina'],
    });
    expect(created.status).toBe(201);
    const page = (await created.json()) as { id: string };
    const wiki = catalogFor().forUser((await defaultUser()).id).wiki;
    const [edit] = await wiki.saveRun(showId, sessionId, crypto.randomUUID(), [
      {
        target: { type: 'page', pageId: page.id, baseRevision: 1 },
        kind: 'person',
        title: 'Christina Ramos',
        aliases: ['Tina'],
        bodyMd: `Co-host. [She opens the show](cite:${sessionId}@12).`,
        rationale: 'She opens this session.',
      },
    ]);
    await new Promise((r) => setTimeout(r, 5));
    const [fresh] = await wiki.saveRun(showId, sessionId, crypto.randomUUID(), [
      {
        target: { type: 'new' },
        kind: 'topic',
        title: 'Cold opens',
        aliases: ['Openers'],
        bodyMd: 'A running list.',
        rationale: 'A recurring segment.',
      },
    ]);
    if (!edit || !fresh) throw new Error('seeding the suggestions failed');
    return { showId, sessionId, page, edit, fresh };
  }

  it('GET /api/shows/:showId/wiki/suggestions matches the captured fixture', async () => {
    const { showId } = await seedSuggestions();
    const res = await send('GET', `/api/shows/${showId}/wiki/suggestions`);
    const body = await expectCapturedResponse(
      {
        name: 'wikiSuggestionList',
        endpoint: 'GET /api/shows/:showId/wiki/suggestions',
        format: 'ts',
      },
      res,
    );
    expect(body).toMatchObject({ truncated: false });
    expect(
      (body as { suggestions: Array<{ title: string }> }).suggestions.map((x) => x.title),
    ).toEqual(['Cold opens', 'Christina Ramos']);
  });

  it('GET /api/wiki/suggestions/:suggestionId matches the captured fixture', async () => {
    const { edit } = await seedSuggestions();
    const res = await send('GET', `/api/wiki/suggestions/${edit.id}`);
    const body = await expectCapturedResponse(
      { name: 'wikiSuggestion', endpoint: 'GET /api/wiki/suggestions/:suggestionId', format: 'ts' },
      res,
    );
    expect(body).toMatchObject({ status: 'pending', base_revision: 1, stale: false });
  });

  it('POST /api/wiki/suggestions/:suggestionId/accept (existing page, 200) matches the captured fixture', async () => {
    const { edit } = await seedSuggestions();
    const res = await send('POST', `/api/wiki/suggestions/${edit.id}/accept`, {
      expected_revision: 1,
    });
    const body = await expectCapturedResponse(
      {
        name: 'wikiSuggestionAccept',
        endpoint: 'POST /api/wiki/suggestions/:suggestionId/accept',
        format: 'ts',
      },
      res,
    );
    expect(body).toMatchObject({
      page: { revision: 2 },
      suggestion: { status: 'accepted', resolved_revision: 2 },
    });
  });

  it('POST /api/wiki/suggestions/:suggestionId/accept (new page, 201) matches the captured fixture', async () => {
    const { fresh } = await seedSuggestions();
    const res = await send('POST', `/api/wiki/suggestions/${fresh.id}/accept`, {});
    const body = await expectCapturedResponse(
      {
        name: 'wikiSuggestionAcceptCreate',
        endpoint: 'POST /api/wiki/suggestions/:suggestionId/accept (new page)',
        format: 'ts',
        status: 201,
      },
      res,
    );
    expect(body).toMatchObject({
      page: { kind: 'topic', revision: 1 },
      suggestion: { status: 'accepted', resolved_revision: 1 },
    });
  });

  it('POST /api/wiki/suggestions/:suggestionId/accept with a stale revision (409) matches the captured fixture', async () => {
    const { page, edit } = await seedSuggestions();
    const bumped = await send('PUT', `/api/wiki/pages/${page.id}`, {
      expected_revision: 1,
      body_md: 'Co-host and producer.',
    });
    expect(bumped.status).toBe(200);
    const res = await send('POST', `/api/wiki/suggestions/${edit.id}/accept`, {
      expected_revision: 1,
    });
    const body = await expectCapturedResponse(
      {
        name: 'wikiSuggestionAcceptConflict',
        endpoint: 'POST /api/wiki/suggestions/:suggestionId/accept (stale revision)',
        format: 'ts',
        status: 409,
      },
      res,
    );
    expect(body).toMatchObject({ detail: 'Version conflict.', current: { revision: 2 } });
  });

  it('POST /api/wiki/suggestions/:suggestionId/dismiss matches the captured fixture', async () => {
    const { fresh } = await seedSuggestions();
    const res = await send('POST', `/api/wiki/suggestions/${fresh.id}/dismiss`);
    const body = await expectCapturedResponse(
      {
        name: 'wikiSuggestionDismiss',
        endpoint: 'POST /api/wiki/suggestions/:suggestionId/dismiss',
        format: 'ts',
      },
      res,
    );
    expect(body).toMatchObject({ status: 'dismissed', resolved_by_name: 'Default User' });
  });

  it('POST /api/wiki/suggestions/:suggestionId/dismiss when already resolved (409) matches the captured fixture', async () => {
    const { fresh } = await seedSuggestions();
    expect((await send('POST', `/api/wiki/suggestions/${fresh.id}/dismiss`)).status).toBe(200);
    const res = await send('POST', `/api/wiki/suggestions/${fresh.id}/dismiss`);
    const body = await expectCapturedResponse(
      {
        name: 'wikiSuggestionResolved',
        endpoint: 'POST /api/wiki/suggestions/:suggestionId/dismiss (already resolved)',
        format: 'ts',
        status: 409,
      },
      res,
    );
    expect(body).toEqual({ detail: 'Suggestion already resolved.', status: 'dismissed' });
  });

  it('POST /api/sessions/:sessionId/wiki/generate matches the captured fixture', async () => {
    const studioId = await seedMemberStudio();
    const showId = await seedShow({ studioId, name: 'Wiki Show', code: 'WS' });
    const sessionId = await seedSession({ showId, episode: '003', title: 'WS - 3' });
    const hub = await harnessHub(sessionId);
    for (const word of ['She', 'opens', 'the', 'show']) {
      await hub.insertTranscriptWord({ session_time: '00:00:12:00', speaker: 'Host', word });
    }
    let llm: FakeLlm | null = null;
    try {
      llm = await startFakeLlm((n) =>
        n === 1
          ? callTools(1, [{ name: 'get_transcript_words', args: { page: 0 } }])
          : n === 2
            ? callTools(2, [
                {
                  name: 'propose_page',
                  args: {
                    kind: 'person',
                    title: 'Christina Ramos',
                    aliases: ['Tina'],
                    body_md: `Co-host. [She opens the show](cite:${sessionId}@12).`,
                    rationale: 'She opens this session.',
                  },
                },
              ])
            : answer('done'),
      );
      await saveSdkCredential(llm.baseURL);
      const res = await send(
        'POST',
        `/api/sessions/${sessionId}/wiki/generate`,
        undefined,
        envWith({ HOST: '127.0.0.1' }),
      );
      const body = await expectCapturedResponse(
        {
          name: 'wikiSuggestionGenerate',
          endpoint: 'POST /api/sessions/:sessionId/wiki/generate',
          format: 'ts',
        },
        res,
      );
      expect(body).toMatchObject({
        suggestions: [{ status: 'pending', page_id: null, kind: 'person' }],
      });
    } finally {
      await llm?.close();
    }
  });
});
