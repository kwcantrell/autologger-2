import { app, env, envWith } from '../test/harness';
import { describe, expect, it } from 'vitest';
import { catalogFor, loginCookie, seedSession, seedShow, seedStudio, seedUser } from '../test/helpers';

async function activeStudioId(): Promise<string> {
  const res = await app.request('/api/studio', { method: 'GET' }, { ...env });
  return ((await res.json()) as { id: string }).id;
}
async function seededSession(): Promise<string> {
  const studio = seedStudio();
  const show = seedShow({ studioId: studio });
  return seedSession({ showId: show });
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

describe('session lifecycle (PUT / archive / restore / delete)', () => {
  it('PUT renames and updates the start offset', async () => {
    const session = await seededSession();
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
    const session = await seededSession();
    const a = await app.request(`/api/sessions/${session}/archive`, { method: 'POST' }, { ...env });
    expect(a.status).toBe(200);
    expect((await a.json()) as { archived: boolean }).toMatchObject({ archived: true });
    const r = await app.request(`/api/sessions/${session}/restore`, { method: 'POST' }, { ...env });
    expect((await r.json()) as { archived: boolean }).toMatchObject({ archived: false });
  });

  it('DELETE hides the session', async () => {
    const session = await seededSession();
    const res = await app.request(`/api/sessions/${session}`, { method: 'DELETE' }, { ...env });
    expect(res.status).toBe(200);
    expect((await res.json()) as { hidden: boolean }).toMatchObject({ hidden: true });
  });

  it('youtube-import is 503 with the current unconditional-refusal detail body', async () => {
    const session = await seededSession();
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

    const hiddenSession = await seededSession();
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
    const session = await seededSession();
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
    const nonexistent = await app.request('/api/sessions/does-not-exist', { method: 'GET' }, { ...env });

    const hiddenSession = await seededSession();
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
