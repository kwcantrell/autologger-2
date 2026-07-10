import { app, env, envWith } from '../test/harness';
import { describe, expect, it } from 'vitest';
import { adminHeader, loginCookie, seedSession, seedShow, seedStudio, seedUser } from '../test/helpers';

const withLogin = envWith({ REQUIRE_LOGIN: '1' });

describe('auth gate', () => {
  it('blocks an unauthenticated /api/* when REQUIRE_LOGIN=1 (401)', async () => {
    const res = await app.request('/api/sessions', { method: 'GET' }, withLogin);
    expect(res.status).toBe(401);
  });

  it('allows GET /api/profile anonymously even under strict login', async () => {
    const res = await app.request('/api/profile', { method: 'GET' }, withLogin);
    expect(res.status).toBe(200);
  });

  it('admin routes 503 when ADMIN_TOKEN unconfigured, 401 on a wrong token', async () => {
    // .dev.vars provides an ADMIN_TOKEN in this env, so force-clear it for the 503 path.
    const noToken = await app.request('/api/admin/users', { method: 'GET' }, envWith({ ADMIN_TOKEN: '' }));
    expect(noToken.status).toBe(503);
    const bad = await app.request(
      '/api/admin/users',
      { method: 'GET', headers: adminHeader('wrong') },
      envWith({ ADMIN_TOKEN: 'right' }),
    );
    expect(bad.status).toBe(401);
  });
});

describe('tenancy', () => {
  it('returns 404 for a session outside the caller’s studio', async () => {
    const studioA = await seedStudio();
    const studioB = await seedStudio();
    const show = await seedShow({ studioId: studioB });
    const session = await seedSession({ showId: show });
    const user = await seedUser({ studios: [studioA] }); // NOT in studioB
    const cookie = await loginCookie(user);
    const res = await app.request(
      `/api/sessions/${session}/status`,
      { method: 'GET', headers: { Cookie: cookie } },
      withLogin,
    );
    expect(res.status).toBe(404);
  });
});

describe('validation + caps', () => {
  it('422 on a log body with oversized metadata', async () => {
    const studio = await seedStudio();
    const show = await seedShow({ studioId: studio });
    const session = await seedSession({ showId: show });
    const res = await app.request(
      `/api/sessions/${session}/events`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ category: 'c', message: 'm', metadata: { b: 'x'.repeat(9000) } }),
      },
      { ...env },
    );
    expect(res.status).toBe(422);
  });

  it('413 on an oversized audio upload (Content-Length over cap)', async () => {
    const studio = await seedStudio();
    const show = await seedShow({ studioId: studio });
    const session = await seedSession({ showId: show });
    const res = await app.request(
      `/api/sessions/${session}/audio/segments`,
      { method: 'POST', headers: { 'content-length': String(60 * 1024 * 1024) }, body: 'x' },
      { ...env },
    );
    expect(res.status).toBe(413);
  });
});
