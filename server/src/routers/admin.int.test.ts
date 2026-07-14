import { app, envWith } from '../test/harness';
import { describe, expect, it } from 'vitest';
import { adminHeader, catalogFor, seedUser } from '../test/helpers';

const TOKEN = 'sweep-admin-token';
const ADMIN_ENV = envWith({ ADMIN_TOKEN: TOKEN });
const H = { ...adminHeader(TOKEN), 'content-type': 'application/json' };

describe('admin auth', () => {
  it('401 with a wrong token', async () => {
    const res = await app.request(
      '/api/admin/users',
      { method: 'GET', headers: adminHeader('nope') },
      ADMIN_ENV,
    );
    expect(res.status).toBe(401);
  });

  it('GET /api/admin/users returns studios_catalog + users', async () => {
    const res = await app.request('/api/admin/users', { method: 'GET', headers: H }, ADMIN_ENV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { studios_catalog: unknown[]; users: unknown[] };
    expect(Array.isArray(body.studios_catalog)).toBe(true);
    expect(Array.isArray(body.users)).toBe(true);
  });
});

describe('admin studios', () => {
  it('creates then deletes a studio', async () => {
    const create = await app.request(
      '/api/admin/studios',
      {
        method: 'POST',
        headers: H,
        body: JSON.stringify({ id: 'sweep-team', display_name: 'Sweep' }),
      },
      ADMIN_ENV,
    );
    expect(create.status).toBe(200);
    expect((await create.json()) as { studio: { id: string } }).toMatchObject({
      studio: { id: 'sweep-team' },
    });
    const del = await app.request(
      '/api/admin/studios/sweep-team',
      { method: 'DELETE', headers: H },
      ADMIN_ENV,
    );
    expect(del.status).toBe(200);
    expect((await del.json()) as { ok: boolean }).toMatchObject({ ok: true });
  });

  it('422 on an invalid studio id (too short)', async () => {
    const res = await app.request(
      '/api/admin/studios',
      { method: 'POST', headers: H, body: JSON.stringify({ id: 'a', display_name: 'X' }) },
      ADMIN_ENV,
    );
    expect(res.status).toBe(422);
  });

  it('DELETE cascades pending team_invites (shared delete method, teams-self-serve)', async () => {
    const create = await app.request(
      '/api/admin/studios',
      {
        method: 'POST',
        headers: H,
        body: JSON.stringify({ id: 'sweep-team-invites', display_name: 'Sweep Invites' }),
      },
      ADMIN_ENV,
    );
    expect(create.status).toBe(200);
    const inviter = await seedUser({});
    catalogFor().auth.authUpsertInvite('sweep-team-invites', 'pending@example.com', inviter);
    expect(catalogFor().auth.authCountPendingInvites('sweep-team-invites')).toBe(1);

    const del = await app.request(
      '/api/admin/studios/sweep-team-invites',
      { method: 'DELETE', headers: H },
      ADMIN_ENV,
    );
    expect(del.status).toBe(200);
    expect(catalogFor().auth.authCountPendingInvites('sweep-team-invites')).toBe(0);
  });
});

describe('admin user memberships + disable/enable', () => {
  it('adds and removes a membership for a known builtin studio', async () => {
    const user = await seedUser({});
    const add = await app.request(
      `/api/admin/users/${user}/memberships`,
      { method: 'POST', headers: H, body: JSON.stringify({ studio_id: 'test-studios' }) },
      ADMIN_ENV,
    );
    expect(add.status).toBe(200);
    const del = await app.request(
      `/api/admin/users/${user}/memberships/test-studios`,
      { method: 'DELETE', headers: H },
      ADMIN_ENV,
    );
    expect(del.status).toBe(200);
  });

  it('disable then enable a user', async () => {
    const user = await seedUser({});
    const d = await app.request(
      `/api/admin/users/${user}/disable`,
      { method: 'POST', headers: H },
      ADMIN_ENV,
    );
    expect(d.status).toBe(200);
    const e = await app.request(
      `/api/admin/users/${user}/enable`,
      { method: 'POST', headers: H },
      ADMIN_ENV,
    );
    expect(e.status).toBe(200);
  });

  it('404 disabling an unknown user', async () => {
    const res = await app.request(
      '/api/admin/users/no-such-user/disable',
      { method: 'POST', headers: H },
      ADMIN_ENV,
    );
    expect(res.status).toBe(404);
  });
});
