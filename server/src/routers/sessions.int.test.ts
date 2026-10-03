import { describe, expect, it } from 'vitest';
import { anonApp, app, env, envWith } from '../test/harness';
import {
  catalogFor,
  loginCookie,
  SEED_CATEGORY_ID,
  seedAccessMatrix,
  seededSession,
  seedSession,
  seedShow,
  seedStudio,
  seedUser,
  testDb,
} from '../test/helpers';

async function activeStudioId(): Promise<string> {
  const res = await app.request('/api/studio', { method: 'GET' }, { ...env });
  return ((await res.json()) as { id: string }).id;
}

describe('GET /api/sessions', () => {
  it('returns the active/archived shape', async () => {
    const res = await app.request('/api/sessions', { method: 'GET' }, { ...env });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { active: unknown[]; archived: unknown[] };
    expect(Array.isArray(body.active)).toBe(true);
    expect(Array.isArray(body.archived)).toBe(true);
  });
});

describe('POST /api/sessions', () => {
  it('creates a session under the active studio’s show', async () => {
    const show = await seedShow({ studioId: await activeStudioId() });
    const res = await app.request(
      '/api/sessions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ show_id: show, episode: '007', frame_rate: 24 }),
      },
      { ...env },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBeTruthy();
  });

  it('422 for a start_offset_frames past MAX_SAFE_INTEGER, on create and update (api-contract-freeze "Catalog integer fields are bounded")', async () => {
    const show = await seedShow({ studioId: await activeStudioId() });
    const count = async () =>
      (await testDb().first<{ n: number }>('SELECT COUNT(*) AS n FROM sessions'))?.n;
    const before = await count();
    const create = await app.request(
      '/api/sessions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ show_id: show, episode: '008', start_offset_frames: 1e20 }),
      },
      { ...env },
    );
    expect(create.status).toBe(422);
    expect(await count()).toBe(before);
    const sid = await seedSession({ showId: show });
    const update = await app.request(
      `/api/sessions/${sid}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'T', start_offset_frames: 2 ** 53 }),
      },
      { ...env },
    );
    expect(update.status).toBe(422);
  });

  it('422 on an invalid create body (missing show_id)', async () => {
    const res = await app.request(
      '/api/sessions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ episode: '1' }),
      },
      { ...env },
    );
    expect(res.status).toBe(422);
  });
});

// session-title-suffix (design D2/D3/D4/D6, task 1.3) — create-path title
// derivation. Shows created via seedShow default to title_suffix 'date' (D7:
// newly created shows default to Date); tests that need Episode-suffix flip
// the column directly via raw SQL, mirroring what Settings will do once the
// Unit B wire lands.
async function setTitleSuffix(showId: string, suffix: 'date' | 'episode'): Promise<void> {
  await testDb().run('UPDATE shows SET title_suffix = ? WHERE id = ?', suffix, showId);
}

/** Test oracle for the UTC calendar date the server's own clock read will
 * use — mirrors dateSuffixBase's math without importing server internals,
 * so this test independently confirms the wire behavior rather than just
 * re-running the same helper. */
function utcDateStamp(): string {
  const d = new Date();
  const yy = String(d.getUTCFullYear() % 100).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

async function postSession(
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await app.request(
    '/api/sessions',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    { ...env },
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe('POST /api/sessions — title derivation (session-title-suffix)', () => {
  it('Date suffix: first untitled session of the UTC day gets the bare CODE_YYMMDD title', async () => {
    const studio = await activeStudioId();
    const show = await seedShow({ studioId: studio, code: 'HD' });
    const stamp = utcDateStamp();
    const { status, json } = await postSession({ show_id: show });
    expect(status).toBe(200);
    expect(json.title).toBe(`HD_${stamp}`);
    expect(json.episode).toBe('');
  });

  it('Date suffix: a second untitled session the same day collides to _002', async () => {
    const studio = await activeStudioId();
    const show = await seedShow({ studioId: studio, code: 'HD2' });
    const stamp = utcDateStamp();
    const first = await postSession({ show_id: show });
    const second = await postSession({ show_id: show });
    expect(first.json.title).toBe(`HD2_${stamp}`);
    expect(second.json.title).toBe(`HD2_${stamp}_002`);
  });

  it('Date suffix: allocation uses max-occupied-slot + 1 across a gap left by a rename', async () => {
    const studio = await activeStudioId();
    const show = await seedShow({ studioId: studio, code: 'HD3' });
    const stamp = utcDateStamp();
    const base = `HD3_${stamp}`;
    // Seed the bare base and a _003 directly (simulating a rename that left
    // a gap) rather than via three sequential creates.
    await seedSession({ showId: show, title: base });
    await seedSession({ showId: show, title: `${base}_003` });
    const { json } = await postSession({ show_id: show });
    expect(json.title).toBe(`${base}_004`);
  });

  it('Date suffix collision considers ui_hidden rows too', async () => {
    const studio = await activeStudioId();
    const show = await seedShow({ studioId: studio, code: 'HD4' });
    const stamp = utcDateStamp();
    const base = `HD4_${stamp}`;
    const hiddenId = await seedSession({ showId: show, title: base });
    await app.request(`/api/sessions/${hiddenId}`, { method: 'DELETE' }, { ...env }); // ui_hidden
    const { json } = await postSession({ show_id: show });
    expect(json.title).toBe(`${base}_002`);
  });

  // Unit A review observation 3: the store's Date-mode collision SELECT reads
  // every session for the show with no archived filter (server/src/db/
  // sessionIndexStore.ts), but until now nothing exercised an ARCHIVED row
  // (as opposed to ui_hidden, above) through the real archive endpoint.
  it('Date suffix collision considers archived rows too', async () => {
    const studio = await activeStudioId();
    const show = await seedShow({ studioId: studio, code: 'HD5' });
    const stamp = utcDateStamp();
    const base = `HD5_${stamp}`;
    const archivedId = await seedSession({ showId: show, title: `${base}_002` });
    const archiveRes = await app.request(
      `/api/sessions/${archivedId}/archive`,
      { method: 'POST' },
      { ...env },
    );
    expect(archiveRes.status).toBe(200);
    const { json } = await postSession({ show_id: show });
    expect(json.title).toBe(`${base}_003`);
  });

  it('Episode suffix: numeric episode is zero-padded to width 4 in the title, stored as sent', async () => {
    const studio = await activeStudioId();
    const show = await seedShow({ studioId: studio, code: 'EP' });
    await setTitleSuffix(show, 'episode');
    const { status, json } = await postSession({ show_id: show, episode: '7' });
    expect(status).toBe(200);
    expect(json.title).toBe('EP_0007');
    expect(json.episode).toBe('7');
  });

  it('Episode suffix: non-numeric episode is used unchanged (no padding)', async () => {
    const studio = await activeStudioId();
    const show = await seedShow({ studioId: studio, code: 'EP2' });
    await setTitleSuffix(show, 'episode');
    const { status, json } = await postSession({ show_id: show, episode: 'Pilot' });
    expect(status).toBe(200);
    expect(json.title).toBe('EP2_Pilot');
  });

  it('Episode suffix: blank/omitted episode without an explicit title is 400', async () => {
    const studio = await activeStudioId();
    const show = await seedShow({ studioId: studio, code: 'EP3' });
    await setTitleSuffix(show, 'episode');
    const { status, json } = await postSession({ show_id: show });
    expect(status).toBe(400);
    expect(typeof json.detail).toBe('string');
  });

  it('Episode suffix: an explicit non-blank title bypasses the episode requirement', async () => {
    const studio = await activeStudioId();
    const show = await seedShow({ studioId: studio, code: 'EP4' });
    await setTitleSuffix(show, 'episode');
    const { status, json } = await postSession({ show_id: show, title: '  Custom Title  ' });
    expect(status).toBe(200);
    expect(json.title).toBe('Custom Title');
  });

  it('Date suffix: an explicit title bypasses derivation and does not require a show code', async () => {
    const studio = await activeStudioId();
    const show = await seedShow({ studioId: studio, code: '   ' }); // trims to blank show_code
    const { status, json } = await postSession({ show_id: show, title: 'Explicit' });
    expect(status).toBe(200);
    expect(json.title).toBe('Explicit');
  });

  it('Date suffix: a blank trimmed show code fails derivation with 400', async () => {
    const studio = await activeStudioId();
    const show = await seedShow({ studioId: studio, code: '   ' }); // trims to blank show_code
    const { status, json } = await postSession({ show_id: show });
    expect(status).toBe(400);
    expect(typeof json.detail).toBe('string');
  });

  it('Episode suffix: a blank trimmed show code fails derivation with 400', async () => {
    const studio = await activeStudioId();
    const show = await seedShow({ studioId: studio, code: '   ' });
    await setTitleSuffix(show, 'episode');
    const { status, json } = await postSession({ show_id: show, episode: '1' });
    expect(status).toBe(400);
    expect(typeof json.detail).toBe('string');
  });

  it('does not bump shows.next_episode on create (D1 — no counter writer left)', async () => {
    const studio = await activeStudioId();
    const show = await seedShow({ studioId: studio, code: 'NB' });
    await setTitleSuffix(show, 'episode');
    await postSession({ show_id: show, episode: '9' });
    const row = await testDb().first<{ next_episode: number }>(
      'SELECT next_episode FROM shows WHERE id = ?',
      show,
    );
    expect(row?.next_episode).toBe(1);
  });

  // Batch import (web/src/pages/index/batchImport/runner.ts createSessionForStem)
  // sends explicit `title` AND `episode` both set to the file stem, bypassing
  // derivation entirely (D6) — mirrored here rather than trusted to the more
  // generic derivation-path counter test above, since it's the one real
  // caller that posts both fields explicit and together (task 3.1).
  it('batch-import-shaped create (explicit title + episode, no derivation) stores both verbatim and does not bump the counter', async () => {
    const studio = await activeStudioId();
    const show = await seedShow({ studioId: studio, code: 'BI' });
    const before = await testDb().first<{ next_episode: number }>(
      'SELECT next_episode FROM shows WHERE id = ?',
      show,
    );
    const { status, json } = await postSession({
      show_id: show,
      title: 'clip_003',
      episode: 'clip_003',
    });
    expect(status).toBe(200);
    expect(json.title).toBe('clip_003');
    expect(json.episode).toBe('clip_003');
    const after = await testDb().first<{ next_episode: number }>(
      'SELECT next_episode FROM shows WHERE id = ?',
      show,
    );
    expect(after?.next_episode).toBe(before?.next_episode);
  });

  it('concurrent same-clock creates for the same show never duplicate a title', async () => {
    const studio = await activeStudioId();
    const show = await seedShow({ studioId: studio, code: 'CC' });
    const stamp = utcDateStamp();
    const base = `CC_${stamp}`;
    const [a, b] = await Promise.all([
      postSession({ show_id: show }),
      postSession({ show_id: show }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const titles = [a.json.title, b.json.title].sort();
    expect(titles).toEqual([base, `${base}_002`]);
    expect(a.json.id).not.toBe(b.json.id);
  });
});

describe('session lifecycle (PUT / archive / restore / delete)', () => {
  it('PUT renames and updates the start offset', async () => {
    const session = (await seededSession()).sessionId;
    const res = await app.request(
      `/api/sessions/${session}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Renamed', start_offset_frames: 5 }),
      },
      { ...env },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { title: string; start_offset_frames: number };
    expect(body.title).toBe('Renamed');
    expect(body.start_offset_frames).toBe(5);
  });

  it('archive then restore toggles the flag', async () => {
    const session = (await seededSession()).sessionId;
    const a = await app.request(`/api/sessions/${session}/archive`, { method: 'POST' }, { ...env });
    expect(a.status).toBe(200);
    expect((await a.json()) as { archived: boolean }).toMatchObject({ archived: true });
    const r = await app.request(`/api/sessions/${session}/restore`, { method: 'POST' }, { ...env });
    expect((await r.json()) as { archived: boolean }).toMatchObject({ archived: false });
  });

  it('DELETE hides the session', async () => {
    const session = (await seededSession()).sessionId;
    const res = await app.request(`/api/sessions/${session}`, { method: 'DELETE' }, { ...env });
    expect(res.status).toBe(200);
    expect((await res.json()) as { hidden: boolean }).toMatchObject({ hidden: true });
  });

  it('youtube-import is 503 with the current unconditional-refusal detail body', async () => {
    const session = (await seededSession()).sessionId;
    const res = await app.request(
      `/api/sessions/${session}/youtube-import`,
      { method: 'POST' },
      { ...env },
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      detail: 'YouTube import is unavailable on this deployment.',
    });
  });
});

// Characterization for youtube-audio-import task 1.1: pins the CURRENT (pre-import-pipeline)
// behavior of POST /api/sessions/:id/youtube-import — the unconditional 503 stub, and that
// its requireSession guard (existence + tenancy masking) behaves exactly like the other
// non-includeHidden per-session routes (PUT, archive, restore). Any future change to this
// route's status/shape needs an authorizing api-contract-freeze delta (per CLAUDE.md).
describe('POST /api/sessions/:sessionId/youtube-import (requireSession guard, pre-pipeline)', () => {
  it('masked 404 (identical shape) for nonexistent, ui_hidden, and foreign-studio ids', async () => {
    const nonexistent = await app.request(
      '/api/sessions/does-not-exist/youtube-import',
      { method: 'POST' },
      { ...env },
    );

    const hiddenSession = (await seededSession()).sessionId;
    await app.request(`/api/sessions/${hiddenSession}`, { method: 'DELETE' }, { ...env });
    const hidden = await app.request(
      `/api/sessions/${hiddenSession}/youtube-import`,
      { method: 'POST' },
      { ...env },
    );

    const studioA = await seedStudio();
    const studioB = await seedStudio();
    const showB = await seedShow({ studioId: studioB });
    const foreignSession = await seedSession({ showId: showB });
    const cookie = await loginCookie(await seedUser({ studios: [studioA] }));
    const foreign = await app.request(
      `/api/sessions/${foreignSession}/youtube-import`,
      { method: 'POST', headers: { Cookie: cookie } },
      envWith({}),
    );

    for (const res of [nonexistent, hidden, foreign]) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ detail: 'Session not found' });
    }
  });

  it('an admin of the session’s studio still reaches the 503 stub (guard passes through)', async () => {
    const studio = await seedStudio();
    const show = await seedShow({ studioId: studio });
    const session = await seedSession({ showId: show });
    const cookie = await loginCookie(await seedUser({ studios: [studio], role: 'admin' }));
    const res = await app.request(
      `/api/sessions/${session}/youtube-import`,
      { method: 'POST', headers: { Cookie: cookie } },
      envWith({}),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      detail: 'YouTube import is unavailable on this deployment.',
    });
  });
});

describe('tenancy', () => {
  it('the session WebSocket gate 404s a logged-in non-member before upgrading (async-session-callers 3.1)', async () => {
    const studioA = await seedStudio();
    const session = await seedSession({ showId: await seedShow({ studioId: await seedStudio() }) });
    const outsider = await loginCookie(await seedUser({ studios: [studioA] }));
    const res = await app.request(
      `/api/sessions/${session}/ws`,
      { headers: { Cookie: outsider } },
      envWith({}),
    );
    expect(res.status).toBe(404);
  });

  it('404 on PUT for a logged-in non-member', async () => {
    const studioA = await seedStudio();
    const studioB = await seedStudio();
    const show = await seedShow({ studioId: studioB });
    const session = await seedSession({ showId: show });
    const cookie = await loginCookie(await seedUser({ studios: [studioA] }));
    const res = await app.request(
      `/api/sessions/${session}`,
      {
        method: 'PUT',
        headers: { Cookie: cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'x', start_offset_frames: 0 }),
      },
      envWith({}),
    );
    expect(res.status).toBe(404);
  });
});

describe('GET /api/sessions/:sessionId (detail endpoint)', () => {
  it('200 with field-for-field shape parity vs. the list entry', async () => {
    // A logged-in user with explicit active prefs, so the list scope is
    // deterministic regardless of other tests' shared anonymous-mode
    // app_settings active-show state.
    const studio = await seedStudio();
    const show = await seedShow({ studioId: studio });
    const session = await seedSession({ showId: show, episode: '042' });
    const userId = await seedUser({ studios: [studio], role: 'admin' });
    await catalogFor().auth.authSetPrefs(userId, studio, show);
    const cookie = await loginCookie(userId);
    const reqEnv = envWith({});

    const listRes = await app.request(
      '/api/sessions',
      { method: 'GET', headers: { Cookie: cookie } },
      reqEnv,
    );
    const listBody = (await listRes.json()) as { active: Array<Record<string, unknown>> };
    const listEntry = listBody.active.find((r) => r.id === session);
    expect(listEntry).toBeTruthy();

    const detailRes = await app.request(
      `/api/sessions/${session}`,
      { method: 'GET', headers: { Cookie: cookie } },
      reqEnv,
    );
    expect(detailRes.status).toBe(200);
    const detailBody = await detailRes.json();
    expect(detailBody).toEqual(listEntry);
  });

  it('200 for an authorized session outside the requester’s active show/studio prefs', async () => {
    const studioA = await seedStudio();
    const studioB = await seedStudio();
    const showA = await seedShow({ studioId: studioA });
    const showB = await seedShow({ studioId: studioB });
    const session = await seedSession({ showId: showA });
    const userId = await seedUser({ studios: [studioA, studioB], role: 'admin' });
    await catalogFor().auth.authSetPrefs(userId, studioB, showB);
    const cookie = await loginCookie(userId);

    const res = await app.request(
      `/api/sessions/${session}`,
      { method: 'GET', headers: { Cookie: cookie } },
      envWith({}),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; session_status: string };
    expect(body.id).toBe(session);
    expect(body.session_status).toBe('active');
  });

  it('200 for an archived session, reflecting its archived state', async () => {
    const session = (await seededSession()).sessionId;
    const archiveRes = await app.request(
      `/api/sessions/${session}/archive`,
      { method: 'POST' },
      { ...env },
    );
    expect(archiveRes.status).toBe(200);

    const res = await app.request(`/api/sessions/${session}`, { method: 'GET' }, { ...env });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { archived: boolean; session_status: string };
    expect(body.archived).toBe(true);
    expect(body.session_status).toBe('archived');
  });

  it('masked 404 (identical shape) for nonexistent, ui_hidden, and foreign-studio ids', async () => {
    const nonexistent = await app.request(
      '/api/sessions/does-not-exist',
      { method: 'GET' },
      { ...env },
    );

    const hiddenSession = (await seededSession()).sessionId;
    await app.request(`/api/sessions/${hiddenSession}`, { method: 'DELETE' }, { ...env });
    const hidden = await app.request(
      `/api/sessions/${hiddenSession}`,
      { method: 'GET' },
      { ...env },
    );

    const studioA = await seedStudio();
    const studioB = await seedStudio();
    const showB = await seedShow({ studioId: studioB });
    const foreignSession = await seedSession({ showId: showB });
    const cookie = await loginCookie(await seedUser({ studios: [studioA] }));
    const foreign = await app.request(
      `/api/sessions/${foreignSession}`,
      { method: 'GET', headers: { Cookie: cookie } },
      envWith({}),
    );

    for (const res of [nonexistent, hidden, foreign]) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ detail: 'Session not found' });
    }
  });
});

// session-title-suffix (design D5, gate ruling 2026-08-02, task 1.5/3.1):
// `deck_title` equals the stored session `title` everywhere — it no longer
// derives `{show_code} - {episode}` even though a show code is present.
// `GET /api/sessions/:id/status` (events.ts) is covered here too, since it's
// the third of the three frozen `deck_title` emitters (Companion state is
// covered separately in companion.int.test.ts).
describe('deck_title equals stored title (D5) — list/detail/status', () => {
  it('list + detail + status all report the stored title as deck_title, not CODE - episode', async () => {
    // Explicit active-show prefs (the detail-endpoint parity test's idiom
    // above) — the list endpoint scopes to ONE active show, and a fresh
    // studio's default active-show setting is otherwise not guaranteed to
    // resolve to the show seeded below.
    const studio = await seedStudio();
    const show = await seedShow({ studioId: studio, code: 'HD' });
    const session = await seedSession({ showId: show, episode: '7', title: 'HD_260802' });
    const userId = await seedUser({ studios: [studio], role: 'admin' });
    await catalogFor().auth.authSetPrefs(userId, studio, show);
    const cookie = await loginCookie(userId);
    const reqEnv = envWith({});

    const listRes = await app.request(
      '/api/sessions',
      { method: 'GET', headers: { Cookie: cookie } },
      reqEnv,
    );
    const listBody = (await listRes.json()) as { active: Array<Record<string, unknown>> };
    const listEntry = listBody.active.find((r) => r.id === session);
    expect(listEntry?.deck_title).toBe('HD_260802');

    const detailRes = await app.request(
      `/api/sessions/${session}`,
      { method: 'GET', headers: { Cookie: cookie } },
      reqEnv,
    );
    const detailBody = (await detailRes.json()) as { deck_title: string };
    expect(detailBody.deck_title).toBe('HD_260802');

    const statusRes = await app.request(
      `/api/sessions/${session}/status`,
      { method: 'GET', headers: { Cookie: cookie } },
      reqEnv,
    );
    const statusBody = (await statusRes.json()) as { deck_title: string };
    expect(statusBody.deck_title).toBe('HD_260802');
  });

  it('falls back to "—" for a blank stored title, even with a show code present', async () => {
    const studio = await seedStudio();
    const show = await seedShow({ studioId: studio, code: 'HD' });
    const session = await seedSession({ showId: show, episode: '7', title: '' });
    const userId = await seedUser({ studios: [studio], role: 'admin' });
    await catalogFor().auth.authSetPrefs(userId, studio, show);
    const cookie = await loginCookie(userId);
    const reqEnv = envWith({});

    const listRes = await app.request(
      '/api/sessions',
      { method: 'GET', headers: { Cookie: cookie } },
      reqEnv,
    );
    const listBody = (await listRes.json()) as { active: Array<Record<string, unknown>> };
    const listEntry = listBody.active.find((r) => r.id === session);
    expect(listEntry?.title).toBe('');
    expect(listEntry?.deck_title).toBe('—');

    const detailRes = await app.request(
      `/api/sessions/${session}`,
      { method: 'GET', headers: { Cookie: cookie } },
      reqEnv,
    );
    const detailBody = (await detailRes.json()) as { deck_title: string };
    expect(detailBody.deck_title).toBe('—');

    const statusRes = await app.request(
      `/api/sessions/${session}/status`,
      { method: 'GET', headers: { Cookie: cookie } },
      reqEnv,
    );
    const statusBody = (await statusRes.json()) as { deck_title: string };
    expect(statusBody.deck_title).toBe('—');
  });
});

// show-grants D8, D21: session creation needs show access, decided in the create's transaction;
// the session list keeps its scope and shape and blanks content for a caller without access.
describe('POST /api/sessions needs show access (show-grants D8)', () => {
  const J = { 'content-type': 'application/json' };
  const create = (cookie: string, body: Record<string, unknown>) =>
    anonApp.request(
      '/api/sessions',
      { method: 'POST', headers: { ...J, cookie }, body: JSON.stringify(body) },
      { ...env },
    );
  const sessionsOf = async (showId: string) =>
    (await catalogFor().sessions.listSessionsForShow(showId)).map((r) => String(r.id));

  it('an ungranted member gets 403 No access to this show. and no session exists; a granted member gets 200', async () => {
    const m = await seedAccessMatrix();
    await catalogFor().auth.authSetPrefs(m.ungranted.id, m.studioId, m.showId);
    await catalogFor().auth.authSetPrefs(m.granted.id, m.studioId, m.showId);
    const before = await sessionsOf(m.showId);

    const denied = await create(m.ungranted.cookie, {
      show_id: m.showId,
      episode: '9',
      frame_rate: 24,
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ detail: 'No access to this show.' });
    expect(await sessionsOf(m.showId)).toEqual(before);

    const ok = await create(m.granted.cookie, { show_id: m.showId, episode: '9', frame_rate: 24 });
    expect(ok.status).toBe(200);
    const { id } = (await ok.json()) as { id: string };
    expect((await sessionsOf(m.showId)).sort()).toEqual([...before, id].sort());
  });

  it('the existing 400 checks come before the access 403', async () => {
    const m = await seedAccessMatrix();
    await catalogFor().auth.authSetPrefs(m.ungranted.id, m.studioId, m.showId);
    const unknown = await create(m.ungranted.cookie, { show_id: 'no-such-show', frame_rate: 24 });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toEqual({ detail: 'Unknown show_id.' });
    const foreignShow = await seedShow({ studioId: await seedStudio() });
    const foreign = await create(m.ungranted.cookie, { show_id: foreignShow, frame_rate: 24 });
    expect(foreign.status).toBe(400);
    expect(await foreign.json()).toEqual({ detail: 'Show does not belong to the active team.' });
  });
});

describe('GET /api/sessions for a show without access (show-grants D21)', () => {
  const J = { 'content-type': 'application/json' };
  type Entry = Record<string, unknown>;
  const list = async (cookie: string): Promise<{ active: Entry[]; archived: Entry[] }> => {
    const res = await anonApp.request(
      '/api/sessions',
      { method: 'GET', headers: { cookie } },
      { ...env },
    );
    expect(res.status).toBe(200);
    return (await res.json()) as { active: Entry[]; archived: Entry[] };
  };
  const live = ['rolling_timecode', 'total_runtime_hms'];
  const stable = (e: Entry) =>
    Object.fromEntries(Object.entries(e).filter(([k]) => !live.includes(k)));

  it('lists the active show with titles and dates only for an ungranted member; granted and admin entries are unchanged', async () => {
    const m = await seedAccessMatrix();
    for (const who of [m.ungranted, m.granted, m.admin]) {
      await catalogFor().auth.authSetPrefs(who.id, m.studioId, m.showId);
    }
    await testDb().run('UPDATE sessions SET notes = ? WHERE id = ?', 'secret notes', m.sessionId);
    const ev = await anonApp.request(
      `/api/sessions/${m.sessionId}/events`,
      {
        method: 'POST',
        headers: { ...J, cookie: m.admin.cookie },
        body: JSON.stringify({ category: SEED_CATEGORY_ID, message: 'hello' }),
      },
      { ...env },
    );
    expect(ev.status).toBe(200);
    const roll = await anonApp.request(
      `/api/sessions/${m.sessionId}/transport/start`,
      { method: 'POST', headers: { cookie: m.admin.cookie } },
      { ...env },
    );
    expect(roll.status).toBe(200);

    const admin = await list(m.admin.cookie);
    const full = admin.active.find((e) => e.id === m.sessionId) as Entry;
    expect(full).toMatchObject({
      notes: 'secret notes',
      event_count: 1,
      is_rolling: true,
      current_take: 1,
    });
    expect(full.rolling_timecode).not.toBeNull();

    const granted = await list(m.granted.cookie);
    expect(granted.active.map(stable)).toEqual(admin.active.map(stable));
    expect(granted.archived.map(stable)).toEqual(admin.archived.map(stable));

    const blind = await list(m.ungranted.cookie);
    expect(blind.active.map((e) => e.id)).toEqual(admin.active.map((e) => e.id));
    const entry = blind.active.find((e) => e.id === m.sessionId) as Entry;
    expect(Object.keys(entry).sort()).toEqual(Object.keys(full).sort());
    expect(entry).toEqual({
      ...full,
      notes: '',
      event_count: 0,
      is_rolling: false,
      current_take: 0,
      rolling_timecode: null,
      total_runtime_hms: '00:00:00',
    });
  });
});
