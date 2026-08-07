import { describe, expect, it } from 'vitest';
import { app, env, envWith } from '../test/harness';
import {
  catalogFor,
  loginCookie,
  seededSession,
  seedSession,
  seedShow,
  seedStudio,
  seedUser,
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
    const show = seedShow({ studioId: await activeStudioId() });
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
function setTitleSuffix(showId: string, suffix: 'date' | 'episode'): void {
  env.ports.catalog.run('UPDATE shows SET title_suffix = ? WHERE id = ?', suffix, showId);
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
    const show = seedShow({ studioId: studio, code: 'HD' });
    const stamp = utcDateStamp();
    const { status, json } = await postSession({ show_id: show });
    expect(status).toBe(200);
    expect(json.title).toBe(`HD_${stamp}`);
    expect(json.episode).toBe('');
  });

  it('Date suffix: a second untitled session the same day collides to _002', async () => {
    const studio = await activeStudioId();
    const show = seedShow({ studioId: studio, code: 'HD2' });
    const stamp = utcDateStamp();
    const first = await postSession({ show_id: show });
    const second = await postSession({ show_id: show });
    expect(first.json.title).toBe(`HD2_${stamp}`);
    expect(second.json.title).toBe(`HD2_${stamp}_002`);
  });

  it('Date suffix: allocation uses max-occupied-slot + 1 across a gap left by a rename', async () => {
    const studio = await activeStudioId();
    const show = seedShow({ studioId: studio, code: 'HD3' });
    const stamp = utcDateStamp();
    const base = `HD3_${stamp}`;
    // Seed the bare base and a _003 directly (simulating a rename that left
    // a gap) rather than via three sequential creates.
    seedSession({ showId: show, title: base });
    seedSession({ showId: show, title: `${base}_003` });
    const { json } = await postSession({ show_id: show });
    expect(json.title).toBe(`${base}_004`);
  });

  it('Date suffix collision considers ui_hidden rows too', async () => {
    const studio = await activeStudioId();
    const show = seedShow({ studioId: studio, code: 'HD4' });
    const stamp = utcDateStamp();
    const base = `HD4_${stamp}`;
    const hiddenId = seedSession({ showId: show, title: base });
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
    const show = seedShow({ studioId: studio, code: 'HD5' });
    const stamp = utcDateStamp();
    const base = `HD5_${stamp}`;
    const archivedId = seedSession({ showId: show, title: `${base}_002` });
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
    const show = seedShow({ studioId: studio, code: 'EP' });
    setTitleSuffix(show, 'episode');
    const { status, json } = await postSession({ show_id: show, episode: '7' });
    expect(status).toBe(200);
    expect(json.title).toBe('EP_0007');
    expect(json.episode).toBe('7');
  });

  it('Episode suffix: non-numeric episode is used unchanged (no padding)', async () => {
    const studio = await activeStudioId();
    const show = seedShow({ studioId: studio, code: 'EP2' });
    setTitleSuffix(show, 'episode');
    const { status, json } = await postSession({ show_id: show, episode: 'Pilot' });
    expect(status).toBe(200);
    expect(json.title).toBe('EP2_Pilot');
  });

  it('Episode suffix: blank/omitted episode without an explicit title is 400', async () => {
    const studio = await activeStudioId();
    const show = seedShow({ studioId: studio, code: 'EP3' });
    setTitleSuffix(show, 'episode');
    const { status, json } = await postSession({ show_id: show });
    expect(status).toBe(400);
    expect(typeof json.detail).toBe('string');
  });

  it('Episode suffix: an explicit non-blank title bypasses the episode requirement', async () => {
    const studio = await activeStudioId();
    const show = seedShow({ studioId: studio, code: 'EP4' });
    setTitleSuffix(show, 'episode');
    const { status, json } = await postSession({ show_id: show, title: '  Custom Title  ' });
    expect(status).toBe(200);
    expect(json.title).toBe('Custom Title');
  });

  it('Date suffix: an explicit title bypasses derivation and does not require a show code', async () => {
    const studio = await activeStudioId();
    const show = seedShow({ studioId: studio, code: '   ' }); // trims to blank show_code
    const { status, json } = await postSession({ show_id: show, title: 'Explicit' });
    expect(status).toBe(200);
    expect(json.title).toBe('Explicit');
  });

  it('Date suffix: a blank trimmed show code fails derivation with 400', async () => {
    const studio = await activeStudioId();
    const show = seedShow({ studioId: studio, code: '   ' }); // trims to blank show_code
    const { status, json } = await postSession({ show_id: show });
    expect(status).toBe(400);
    expect(typeof json.detail).toBe('string');
  });

  it('Episode suffix: a blank trimmed show code fails derivation with 400', async () => {
    const studio = await activeStudioId();
    const show = seedShow({ studioId: studio, code: '   ' });
    setTitleSuffix(show, 'episode');
    const { status, json } = await postSession({ show_id: show, episode: '1' });
    expect(status).toBe(400);
    expect(typeof json.detail).toBe('string');
  });

  it('does not bump shows.next_episode on create (D1 — no counter writer left)', async () => {
    const studio = await activeStudioId();
    const show = seedShow({ studioId: studio, code: 'NB' });
    setTitleSuffix(show, 'episode');
    await postSession({ show_id: show, episode: '9' });
    const row = env.ports.catalog.first<{ next_episode: number }>(
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
    const show = seedShow({ studioId: studio, code: 'BI' });
    const before = env.ports.catalog.first<{ next_episode: number }>(
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
    const after = env.ports.catalog.first<{ next_episode: number }>(
      'SELECT next_episode FROM shows WHERE id = ?',
      show,
    );
    expect(after?.next_episode).toBe(before?.next_episode);
  });

  it('concurrent same-clock creates for the same show never duplicate a title', async () => {
    const studio = await activeStudioId();
    const show = seedShow({ studioId: studio, code: 'CC' });
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
    const session = seededSession().sessionId;
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
    const session = seededSession().sessionId;
    const a = await app.request(`/api/sessions/${session}/archive`, { method: 'POST' }, { ...env });
    expect(a.status).toBe(200);
    expect((await a.json()) as { archived: boolean }).toMatchObject({ archived: true });
    const r = await app.request(`/api/sessions/${session}/restore`, { method: 'POST' }, { ...env });
    expect((await r.json()) as { archived: boolean }).toMatchObject({ archived: false });
  });

  it('DELETE hides the session', async () => {
    const session = seededSession().sessionId;
    const res = await app.request(`/api/sessions/${session}`, { method: 'DELETE' }, { ...env });
    expect(res.status).toBe(200);
    expect((await res.json()) as { hidden: boolean }).toMatchObject({ hidden: true });
  });

  it('youtube-import is 503 with the current unconditional-refusal detail body', async () => {
    const session = seededSession().sessionId;
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

    const hiddenSession = seededSession().sessionId;
    await app.request(`/api/sessions/${hiddenSession}`, { method: 'DELETE' }, { ...env });
    const hidden = await app.request(
      `/api/sessions/${hiddenSession}/youtube-import`,
      { method: 'POST' },
      { ...env },
    );

    const studioA = seedStudio();
    const studioB = seedStudio();
    const showB = seedShow({ studioId: studioB });
    const foreignSession = seedSession({ showId: showB });
    const cookie = await loginCookie(seedUser({ studios: [studioA] }));
    const foreign = await app.request(
      `/api/sessions/${foreignSession}/youtube-import`,
      { method: 'POST', headers: { Cookie: cookie } },
      envWith({ REQUIRE_LOGIN: '1' }),
    );

    for (const res of [nonexistent, hidden, foreign]) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ detail: 'Session not found' });
    }
  });

  it('a member of the session’s studio still reaches the 503 stub (guard passes through)', async () => {
    const studio = seedStudio();
    const show = seedShow({ studioId: studio });
    const session = seedSession({ showId: show });
    const cookie = await loginCookie(seedUser({ studios: [studio] }));
    const res = await app.request(
      `/api/sessions/${session}/youtube-import`,
      { method: 'POST', headers: { Cookie: cookie } },
      envWith({ REQUIRE_LOGIN: '1' }),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      detail: 'YouTube import is unavailable on this deployment.',
    });
  });
});

describe('tenancy', () => {
  it('404 on PUT for a logged-in non-member', async () => {
    const studioA = seedStudio();
    const studioB = seedStudio();
    const show = seedShow({ studioId: studioB });
    const session = seedSession({ showId: show });
    const cookie = await loginCookie(seedUser({ studios: [studioA] }));
    const res = await app.request(
      `/api/sessions/${session}`,
      {
        method: 'PUT',
        headers: { Cookie: cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'x', start_offset_frames: 0 }),
      },
      envWith({ REQUIRE_LOGIN: '1' }),
    );
    expect(res.status).toBe(404);
  });
});

describe('GET /api/sessions/:sessionId (detail endpoint)', () => {
  it('200 with field-for-field shape parity vs. the list entry', async () => {
    // A logged-in user with explicit active prefs, so the list scope is
    // deterministic regardless of other tests' shared anonymous-mode
    // app_settings active-show state.
    const studio = seedStudio();
    const show = seedShow({ studioId: studio });
    const session = seedSession({ showId: show, episode: '042' });
    const userId = seedUser({ studios: [studio] });
    catalogFor().auth.authSetPrefs(userId, studio, show);
    const cookie = await loginCookie(userId);
    const reqEnv = envWith({ REQUIRE_LOGIN: '1' });

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
    const studioA = seedStudio();
    const studioB = seedStudio();
    const showA = seedShow({ studioId: studioA });
    const showB = seedShow({ studioId: studioB });
    const session = seedSession({ showId: showA });
    const userId = seedUser({ studios: [studioA, studioB] });
    catalogFor().auth.authSetPrefs(userId, studioB, showB);
    const cookie = await loginCookie(userId);

    const res = await app.request(
      `/api/sessions/${session}`,
      { method: 'GET', headers: { Cookie: cookie } },
      envWith({ REQUIRE_LOGIN: '1' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; session_status: string };
    expect(body.id).toBe(session);
    expect(body.session_status).toBe('active');
  });

  it('200 for an archived session, reflecting its archived state', async () => {
    const session = seededSession().sessionId;
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

    const hiddenSession = seededSession().sessionId;
    await app.request(`/api/sessions/${hiddenSession}`, { method: 'DELETE' }, { ...env });
    const hidden = await app.request(
      `/api/sessions/${hiddenSession}`,
      { method: 'GET' },
      { ...env },
    );

    const studioA = seedStudio();
    const studioB = seedStudio();
    const showB = seedShow({ studioId: studioB });
    const foreignSession = seedSession({ showId: showB });
    const cookie = await loginCookie(seedUser({ studios: [studioA] }));
    const foreign = await app.request(
      `/api/sessions/${foreignSession}`,
      { method: 'GET', headers: { Cookie: cookie } },
      envWith({ REQUIRE_LOGIN: '1' }),
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
    const studio = seedStudio();
    const show = seedShow({ studioId: studio, code: 'HD' });
    const session = seedSession({ showId: show, episode: '7', title: 'HD_260802' });
    const userId = seedUser({ studios: [studio] });
    catalogFor().auth.authSetPrefs(userId, studio, show);
    const cookie = await loginCookie(userId);
    const reqEnv = envWith({ REQUIRE_LOGIN: '1' });

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
    const studio = seedStudio();
    const show = seedShow({ studioId: studio, code: 'HD' });
    const session = seedSession({ showId: show, episode: '7', title: '' });
    const userId = seedUser({ studios: [studio] });
    catalogFor().auth.authSetPrefs(userId, studio, show);
    const cookie = await loginCookie(userId);
    const reqEnv = envWith({ REQUIRE_LOGIN: '1' });

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
