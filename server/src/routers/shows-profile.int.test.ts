import { describe, expect, it } from 'vitest';
import { app, env } from '../test/harness';
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
