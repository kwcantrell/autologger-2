import { app, env, envWith } from '../test/harness';
import { describe, expect, it } from 'vitest';
import { loginCookie, seedSession, seedShow, seedStudio, seedUser } from '../test/helpers';

async function activeStudioId(): Promise<string> {
  const res = await app.request('/api/studio', { method: 'GET' }, { ...env });
  return ((await res.json()) as { id: string }).id;
}
async function seededSession(): Promise<string> {
  const studio = await seedStudio();
  const show = await seedShow({ studioId: studio });
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

  it('youtube-import is 503', async () => {
    const session = await seededSession();
    const res = await app.request(
      `/api/sessions/${session}/youtube-import`,
      { method: 'POST' },
      { ...env },
    );
    expect(res.status).toBe(503);
  });
});

describe('tenancy', () => {
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
      envWith({ REQUIRE_LOGIN: '1' }),
    );
    expect(res.status).toBe(404);
  });
});
