import { app, env } from '../test/harness';
import { describe, expect, it } from 'vitest';

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
