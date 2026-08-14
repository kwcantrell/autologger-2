import { describe, expect, it } from 'vitest';
import { app, env, envWith } from '../test/harness';
import { catalogFor, loginCookie, seedShow, seedStudio, seedUser } from '../test/helpers';

async function activeStudioId(): Promise<string> {
  const res = await app.request('/api/studio', { method: 'GET' }, { ...env });
  return ((await res.json()) as { id: string }).id;
}

describe('GET /api/studio + /api/profile', () => {
  it('GET /api/studio returns a studio dict with an id', async () => {
    const res = await app.request('/api/studio', { method: 'GET' }, { ...env });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBeTruthy();
  });

  it('GET /api/profile returns the profile payload object', async () => {
    const res = await app.request('/api/profile', { method: 'GET' }, { ...env });
    expect(res.status).toBe(200);
    expect(typeof (await res.json())).toBe('object');
  });

  it('auth.user.teams[] entries carry role (teams-self-serve, task 4.1)', async () => {
    const teamA = seedStudio();
    const teamB = seedStudio();
    const userId = seedUser({});
    catalogFor().auth.authAddMembershipWithRole(userId, teamA, 'admin');
    catalogFor().auth.authAddMembershipWithRole(userId, teamB, 'member');
    const cookie = await loginCookie(userId);

    const res = await app.request(
      '/api/profile',
      { method: 'GET', headers: { Cookie: cookie } },
      { ...env },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      auth: { user: { teams: Array<{ id: string; name: string; role: string }> } };
    };
    const byId = new Map(body.auth.user.teams.map((t) => [t.id, t.role]));
    expect(byId.get(teamA)).toBe('admin');
    expect(byId.get(teamB)).toBe('member');
  });

  // Pins for the active-studio-with-shows assembly path (code-health-tail
  // task 2.7 / finding 5.7): the shows fetched once for the active studio must
  // still land in shows[] exactly once, with active_show_id resolved from them.
  it('logged-in: active studio with shows pins shows[] + active_show_id (frozen shape)', async () => {
    const studio = seedStudio();
    const showId = seedShow({ studioId: studio, name: 'Pinned Show', code: 'PS' });
    const userId = seedUser({ studios: [studio] });
    catalogFor().auth.authSetPrefs(userId, studio, showId);
    const cookie = await loginCookie(userId);

    const res = await app.request(
      '/api/profile',
      { method: 'GET', headers: { Cookie: cookie } },
      { ...env },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      active_studio_id: string;
      active_show_id: string;
      shows: Array<{ id: string; studio_id: string; name: string; show_code: string }>;
    };
    expect(body.active_studio_id).toBe(studio);
    expect(body.active_show_id).toBe(showId);
    const matches = body.shows.filter((s) => s.id === showId);
    expect(matches).toHaveLength(1); // present, and not duplicated
    expect(matches[0]).toMatchObject({
      id: showId,
      studio_id: studio,
      name: 'Pinned Show',
      show_code: 'PS',
    });
  });

  it('anonymous: active studio with shows pins shows[] + active_show_id (frozen shape)', async () => {
    const sid = await activeStudioId();
    const showId = seedShow({ studioId: sid, name: 'Anon Pin Show', code: 'AP' });

    const res = await app.request('/api/profile', { method: 'GET' }, { ...env });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      active_studio_id: string;
      active_show_id: string;
      shows: Array<{ id: string; studio_id: string }>;
    };
    expect(body.active_studio_id).toBe(sid);
    expect(body.active_show_id).toBe(showId); // only show → becomes active
    expect(body.shows.filter((s) => s.id === showId)).toHaveLength(1);
  });

  // profile-shows-slimming: `shows[]` is the SLIM `showBriefApiDict` entry.
  // The four heavy per-show config fields moved to the two full-show read
  // routes below; only these five keys stay on a payload that fans out over
  // every show in every reachable studio.
  it('shows[] entries are brief: exactly the five identity/selection keys', async () => {
    const sid = await activeStudioId();
    const showId = seedShow({ studioId: sid, name: 'Brief Show', code: 'BS' });

    const res = await app.request('/api/profile', { method: 'GET' }, { ...env });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { shows: Array<Record<string, unknown>> };
    const show = body.shows.find((s) => s.id === showId);
    expect(show).toBeTruthy();
    expect(Object.keys(show ?? {}).sort()).toEqual([
      'id',
      'name',
      'show_code',
      'studio_id',
      'title_suffix',
    ]);
  });

  it('logged-in shows[] entries are brief too (both fan-out loops)', async () => {
    const studio = seedStudio();
    const showId = seedShow({ studioId: studio, name: 'Brief Show', code: 'BS' });
    const userId = seedUser({ studios: [studio] });

    const res = await app.request(
      '/api/profile',
      { method: 'GET', headers: { Cookie: await loginCookie(userId) } },
      { ...env },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { shows: Array<Record<string, unknown>> };
    const show = body.shows.find((s) => s.id === showId);
    expect(show).toBeTruthy();
    expect(Object.keys(show ?? {}).sort()).toEqual([
      'id',
      'name',
      'show_code',
      'studio_id',
      'title_suffix',
    ]);
  });
});

describe('PUT /api/profile', () => {
  it('sets the active studio (anonymous)', async () => {
    const sid = await activeStudioId();
    const res = await app.request(
      '/api/profile',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ active_studio_id: sid }),
      },
      { ...env },
    );
    expect(res.status).toBe(200);
  });

  it('400 when active_studio_id is missing (anonymous)', async () => {
    const res = await app.request(
      '/api/profile',
      { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' },
      { ...env },
    );
    expect(res.status).toBe(400);
  });
});

describe('shows', () => {
  it('GET /api/shows returns a shows array for the active studio', async () => {
    const sid = await activeStudioId();
    const res = await app.request(`/api/shows?studio_id=${sid}`, { method: 'GET' }, { ...env });
    expect(res.status).toBe(200);
    expect(Array.isArray(((await res.json()) as { shows: unknown[] }).shows)).toBe(true);
  });

  it('POST /api/shows creates a show under the active studio', async () => {
    const sid = await activeStudioId();
    const res = await app.request(
      '/api/shows',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ studio_id: sid, name: 'Sweep Show', show_code: 'SW' }),
      },
      { ...env },
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as { show: { id: string } }).toHaveProperty('show.id');
  });

  // GET /api/shows/:showId — the per-show full-config read added by
  // profile-shows-slimming, now that `/api/profile` carries brief entries.
  it('GET /api/shows/:showId returns the FULL show config', async () => {
    const sid = await activeStudioId();
    const showId = seedShow({ studioId: sid, name: 'Detail Show', code: 'DS' });

    const res = await app.request(`/api/shows/${showId}`, { method: 'GET' }, { ...env });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { show: Record<string, unknown> };
    expect(Object.keys(body.show).sort()).toEqual([
      'categories',
      'event_palette',
      'event_palette_custom',
      'event_palette_preset',
      'id',
      'name',
      'show_code',
      'studio_id',
      'title_suffix',
    ]);
    expect(body.show.id).toBe(showId);
    expect(Array.isArray(body.show.categories)).toBe(true);
    expect((body.show.event_palette as string[]).length).toBe(9);
  });

  it('GET /api/shows/:showId 404s on an unknown show id', async () => {
    const res = await app.request('/api/shows/no-such-show', { method: 'GET' }, { ...env });
    expect(res.status).toBe(404);
  });

  it('GET /api/shows/:showId 404s for a logged-in non-member (no existence oracle)', async () => {
    const otherStudio = seedStudio();
    const showId = seedShow({ studioId: otherStudio, name: 'Private Show', code: 'PV' });
    const outsider = seedUser({ studios: [seedStudio()] });

    const res = await app.request(
      `/api/shows/${showId}`,
      { method: 'GET', headers: { Cookie: await loginCookie(outsider) } },
      { ...env },
    );
    expect(res.status).toBe(404);
    // Byte-identical to the unknown-id body: the two outcomes must not be
    // distinguishable by a caller probing for other tenants' show ids.
    const unknown = await app.request(
      '/api/shows/no-such-show',
      { method: 'GET', headers: { Cookie: await loginCookie(outsider) } },
      { ...env },
    );
    expect(await res.json()).toEqual(await unknown.json());
  });

  it('GET /api/shows/:showId 200s for a member of the show’s studio', async () => {
    const studio = seedStudio();
    const showId = seedShow({ studioId: studio, name: 'Member Show', code: 'MS' });
    const member = seedUser({ studios: [studio] });

    const res = await app.request(
      `/api/shows/${showId}`,
      { method: 'GET', headers: { Cookie: await loginCookie(member) } },
      { ...env },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { show: { id: string } }).show.id).toBe(showId);
  });

  it('GET /api/shows/:showId 404s for an anonymous caller when OAuth is configured', async () => {
    const sid = await activeStudioId();
    const showId = seedShow({ studioId: sid, name: 'Gated Show', code: 'GS' });

    const res = await app.request(
      `/api/shows/${showId}`,
      { method: 'GET' },
      envWith({ GOOGLE_CLIENT_ID: 'test-client-id' }),
    );
    expect(res.status).toBe(404);
  });

  it('422 on POST /api/shows with a missing name', async () => {
    const sid = await activeStudioId();
    const res = await app.request(
      '/api/shows',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ studio_id: sid }),
      },
      { ...env },
    );
    expect(res.status).toBe(422);
  });
});

// session-title-suffix (design D1/D7/D8, api-contract-freeze delta, task
// 1.4/3.1): the show wire carries title_suffix and never next_episode; a
// new show defaults to 'date'; profile show_updates round-trips
// title_suffix; a legacy next_episode update key is ignored, not a 400 and
// not a live counter.
describe('session-title-suffix — show wire', () => {
  it('POST /api/shows: new show defaults title_suffix to "date" and omits next_episode', async () => {
    const sid = await activeStudioId();
    const res = await app.request(
      '/api/shows',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ studio_id: sid, name: 'New Show', show_code: 'NS' }),
      },
      { ...env },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { show: Record<string, unknown> };
    expect(body.show.title_suffix).toBe('date');
    expect('next_episode' in body.show).toBe(false);
  });

  it('GET /api/shows omits next_episode and includes title_suffix for every entry', async () => {
    const sid = await activeStudioId();
    seedShow({ studioId: sid, name: 'Wire Show', code: 'WS' });
    const res = await app.request(`/api/shows?studio_id=${sid}`, { method: 'GET' }, { ...env });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { shows: Array<Record<string, unknown>> };
    expect(body.shows.length).toBeGreaterThan(0);
    for (const s of body.shows) {
      expect('next_episode' in s).toBe(false);
      expect(['date', 'episode']).toContain(s.title_suffix);
    }
  });

  it('GET /api/profile: every shows[] entry omits next_episode and includes title_suffix', async () => {
    const sid = await activeStudioId();
    seedShow({ studioId: sid, name: 'Profile Show', code: 'PW' });
    const res = await app.request('/api/profile', { method: 'GET' }, { ...env });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { shows: Array<Record<string, unknown>> };
    expect(body.shows.length).toBeGreaterThan(0);
    for (const s of body.shows) {
      expect('next_episode' in s).toBe(false);
      expect(['date', 'episode']).toContain(s.title_suffix);
    }
  });

  it('PUT /api/profile show_updates[].title_suffix round-trips through a subsequent read', async () => {
    const sid = await activeStudioId();
    const showId = seedShow({ studioId: sid, name: 'Suffix Show', code: 'SF' });

    const putRes = await app.request(
      '/api/profile',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          active_studio_id: sid,
          show_updates: [{ show_id: showId, title_suffix: 'episode' }],
        }),
      },
      { ...env },
    );
    expect(putRes.status).toBe(200);

    const res = await app.request(`/api/shows?studio_id=${sid}`, { method: 'GET' }, { ...env });
    const body = (await res.json()) as { shows: Array<{ id: string; title_suffix: string }> };
    const show = body.shows.find((s) => s.id === showId);
    expect(show?.title_suffix).toBe('episode');
  });

  it('legacy next_episode on a show_updates entry is ignored: 200, no 400, no counter written', async () => {
    const sid = await activeStudioId();
    const showId = seedShow({ studioId: sid, name: 'Legacy Show', code: 'LG' });
    const before = env.ports.catalog.first<{ next_episode: number }>(
      'SELECT next_episode FROM shows WHERE id = ?',
      showId,
    );

    const putRes = await app.request(
      '/api/profile',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          active_studio_id: sid,
          // A stale client still sending the retired wire key — MUST NOT
          // 400 solely because of it, and MUST NOT persist as a counter.
          show_updates: [{ show_id: showId, next_episode: 999 }],
        }),
      },
      { ...env },
    );
    expect(putRes.status).toBe(200);

    const res = await app.request(`/api/shows?studio_id=${sid}`, { method: 'GET' }, { ...env });
    const body = (await res.json()) as { shows: Array<Record<string, unknown>> };
    const show = body.shows.find((s) => s.id === showId);
    expect(show).toBeTruthy();
    expect('next_episode' in (show ?? {})).toBe(false);

    // The soft-retained SQL column itself never moved off its pre-update value.
    const after = env.ports.catalog.first<{ next_episode: number }>(
      'SELECT next_episode FROM shows WHERE id = ?',
      showId,
    );
    expect(after?.next_episode).toBe(before?.next_episode);
  });
});
