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
import { clearLogImportJobs } from '../logImport/jobStore';
import { transcriptGenerationLock } from '../node/transcriptGenerationLock';
import { expectCapturedResponse } from '../test/apiFixtures';
import { app, env, envWith } from '../test/harness';
import {
  adminHeader,
  catalogFor,
  loginCookie,
  seedSession,
  seedShow,
  seedStudio,
  seedUser,
} from '../test/helpers';

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
function initedCatalog() {
  const cat = catalogFor();
  cat.init();
  return cat;
}

async function anonymousStudioId(): Promise<string> {
  const res = await app.request('/api/studio', { method: 'GET' }, { ...env });
  return ((await res.json()) as { id: string }).id;
}

/** The anonymous effective studio, given a show (which becomes the active
 * show, since it is the only one) and a session under it — the state
 * `GET /api/sessions` and every per-session route need. */
async function seedActiveChain(): Promise<{ studioId: string; showId: string; sessionId: string }> {
  const studioId = await anonymousStudioId();
  const showId = seedShow({
    studioId,
    name: 'All The Smoke',
    code: 'ATS',
    categoriesJson: CATEGORIES_JSON,
  });
  const sessionId = seedSession({ showId, episode: '002', title: 'ATS - 2' });
  return { studioId, showId, sessionId };
}

// ---------------------------------------------------------------------------
// Admin — GET /api/admin/users (the endpoint this whole change exists for)
// ---------------------------------------------------------------------------

describe('GET /api/admin/users', () => {
  it('matches the captured fixture', async () => {
    const token = 'fixture-admin-token';
    const teamA = seedStudio({ id: 'my-crew', name: 'My Crew' });
    seedStudio({ id: 'ymhs', name: 'YMHS' });
    seedUser({ email: 'ann@example.com', sub: 'sub-ann', studios: [teamA] });
    // `authListUsersAdmin` orders by `created_at_utc DESC`, which is
    // millisecond-precision — two users minted in the same millisecond would
    // tie and the row order would be arbitrary, making the fixture flaky.
    await new Promise((resolve) => setTimeout(resolve, 2));
    seedUser({ email: 'bo@example.com', sub: 'sub-bo' }); // no memberships → `studios: []`
    await new Promise((resolve) => setTimeout(resolve, 2));
    // A membership row pointing at a studio id with no catalog entry —
    // `authAddMemberships` has no FK check, so this is reachable in production
    // whenever a team is deleted out from under a member. Captures admin.ts's
    // `names[m] ?? m` fallback, i.e. a membership whose `name` equals its
    // `id` (the `web-admin-users` spec scenario; task 4.4).
    seedUser({ email: 'cleo@example.com', sub: 'sub-cleo', studios: ['ghost-team'] });
    await new Promise((resolve) => setTimeout(resolve, 2));
    // A member of every studio in the catalog, including both built-ins —
    // captures the add-membership control's "offered nothing" branch
    // (task 4.4).
    seedUser({
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
// Profile — every branch of `profilePayload` (audit row 1: three of them)
// ---------------------------------------------------------------------------

describe('GET /api/profile', () => {
  it('anonymous (oauth unconfigured) matches the captured fixture', async () => {
    const studioId = await anonymousStudioId();
    initedCatalog().studios.saveStudioSettingsBlob(studioId, {
      categories: CATEGORIES,
      show_title_format: 'ATS',
      default_frame_rate: 24,
    });
    seedShow({ studioId, name: 'All The Smoke', code: 'ATS', categoriesJson: CATEGORIES_JSON });

    const res = await app.request('/api/profile', { method: 'GET' }, { ...env });
    await expectCapturedResponse(
      {
        name: 'profileAnonymous',
        endpoint: 'GET /api/profile (anonymous, oauth unconfigured)',
        format: 'ts',
        exportName: 'profileAnonymous',
      },
      res,
    );
  });

  it('authenticated matches the captured fixture', async () => {
    const teamA = seedStudio({ id: 'my-crew', name: 'My Crew' });
    const teamB = seedStudio({ id: 'ymhs', name: 'YMHS' });
    initedCatalog().studios.saveStudioSettingsBlob(teamA, {
      categories: CATEGORIES,
      show_title_format: 'ATS',
      default_frame_rate: 24,
    });
    const showId = seedShow({
      studioId: teamA,
      name: 'All The Smoke',
      code: 'ATS',
      categoriesJson: CATEGORIES_JSON,
    });
    const userId = seedUser({ email: 'ann@example.com', sub: 'sub-ann' });
    catalogFor().auth.authAddMembershipWithRole(userId, teamA, 'admin');
    catalogFor().auth.authAddMembershipWithRole(userId, teamB, 'member');
    catalogFor().auth.authSetPrefs(userId, teamA, showId);

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
    // The third branch the audit records for `profilePayload` (row 1, branch
    // i): same key set, but an empty active studio and empty studios/shows.
    const res = await app.request(
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

describe('POST /api/shows', () => {
  it('matches the captured fixture', async () => {
    const studioId = await anonymousStudioId();
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
    const archived = seedSession({ showId, episode: '001', title: 'ATS - 1' });
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
    const studioId = await anonymousStudioId();
    const showId = seedShow({
      studioId,
      name: 'All The Smoke',
      code: 'ATS',
      categoriesJson: CATEGORIES_JSON,
    });
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
        format: 'json',
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
        format: 'json',
      },
      res,
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
});

// ---------------------------------------------------------------------------
// Teams — `GET /api/teams/:id` is caller-dependent (audit row 26)
// ---------------------------------------------------------------------------

async function seedTeam(): Promise<{ team: string; adminId: string; adminCookie: string }> {
  const team = seedStudio({ id: 'my-crew', name: 'My Crew' });
  const adminId = seedUser({ email: 'ann@example.com', sub: 'sub-ann' });
  catalogFor().auth.authAddMembershipWithRole(adminId, team, 'admin');
  return { team, adminId, adminCookie: await loginCookie(adminId) };
}

describe('teams', () => {
  it('POST /api/teams matches the captured fixture', async () => {
    const cookie = await loginCookie(seedUser({ email: 'ann@example.com', sub: 'sub-ann' }));
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

  it('GET /api/teams/:id as an admin matches the captured fixture (carries `invites`)', async () => {
    const { team, adminCookie } = await seedTeam();
    const memberId = seedUser({ email: 'bo@example.com', sub: 'sub-bo' });
    catalogFor().auth.authAddMembershipWithRole(memberId, team, 'member');
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
    const memberId = seedUser({ email: 'bo@example.com', sub: 'sub-bo' });
    catalogFor().auth.authAddMembershipWithRole(memberId, team, 'member');
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

  it('POST …/members/:uid/role matches the captured fixture', async () => {
    const { team, adminCookie } = await seedTeam();
    const memberId = seedUser({ email: 'bo@example.com', sub: 'sub-bo' });
    catalogFor().auth.authAddMembershipWithRole(memberId, team, 'member');
    const res = await app.request(
      `/api/teams/${team}/members/${memberId}/role`,
      {
        method: 'POST',
        headers: { ...JSON_HEADERS, Cookie: adminCookie },
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

  it('busy matches the captured fixture (dev-anonymous requester sees the holder)', async () => {
    // The MEMBER/dev-anonymous view: full identifiers. The cross-tenant
    // REDACTED view differs only by `session_id`/`session_title` going null
    // (same key set — see transcribe.int.test.ts), so the web tier covers it
    // type-level off this same fixture with a nulled spread rather than a
    // second capture.
    const studioId = seedStudio();
    const showId = seedShow({ studioId });
    const sessionId = seedSession({ showId, episode: '002', title: 'ATS - 2' });
    // Fixed acquisition instant — redacted to `#`s anyway, but deterministic.
    expect(transcriptGenerationLock.tryAcquire(sessionId, 1_700_000_000_000)).toBe(true);
    try {
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
    } finally {
      transcriptGenerationLock.reset();
    }
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
    const studioId = seedStudio();
    const showId = seedShow({ studioId });
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
      clearLogImportJobs();
    }
  });
});
