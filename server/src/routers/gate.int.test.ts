import { describe, expect, it } from 'vitest';
import { anonApp, app, env, envWith } from '../test/harness';
import {
  adminHeader,
  loginCookie,
  seededSession,
  seedSession,
  seedShow,
  seedStudio,
  seedUser,
} from '../test/helpers';

const withLogin = envWith({ REQUIRE_LOGIN: '1' });

describe('auth gate', () => {
  it('blocks an unauthenticated /api/* when REQUIRE_LOGIN=1 (401)', async () => {
    const res = await anonApp.request('/api/sessions', { method: 'GET' }, withLogin);
    expect(res.status).toBe(401);
  });

  it('allows GET /api/profile anonymously even under strict login', async () => {
    const res = await anonApp.request('/api/profile', { method: 'GET' }, withLogin);
    expect(res.status).toBe(200);
  });

  it('admin routes 503 when ADMIN_TOKEN unconfigured, 401 on a wrong token', async () => {
    // .dev.vars provides an ADMIN_TOKEN in this env, so force-clear it for the 503 path.
    const noToken = await anonApp.request(
      '/api/admin/users',
      { method: 'GET' },
      envWith({ ADMIN_TOKEN: '' }),
    );
    expect(noToken.status).toBe(503);
    const bad = await anonApp.request(
      '/api/admin/users',
      { method: 'GET', headers: adminHeader('wrong') },
      envWith({ ADMIN_TOKEN: 'right' }),
    );
    expect(bad.status).toBe(401);
  });
});

// gate-decoded-path D2: Hono routes on the percent-decoded path, so the gate must judge that same
// path. `/%61pi/x` IS `/api/x` to the router (and the Caddy router forwards it as such).
describe('encoded spellings of /api paths get the literal path’s answer', () => {
  const bearer = { Authorization: 'Bearer test-api-token' };

  it.each([
    '/%61pi/sessions',
    '/a%70i/sessions',
    '/%61%70%69/sessions',
    '/api/s%65ssions',
  ])('%s with no credentials is 401 Login required', async (path) => {
    const res = await anonApp.request(path, { method: 'GET' }, withLogin);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ detail: 'Login required.' });
  });

  it('/%61pi/companion/state: 401 without the token, 200 with it', async () => {
    const anon = await anonApp.request('/%61pi/companion/state', { method: 'GET' }, withLogin);
    expect(anon.status).toBe(401);
    const tok = await anonApp.request(
      '/%61pi/companion/state',
      { method: 'GET', headers: bearer },
      withLogin,
    );
    expect(tok.status).toBe(200);
  });

  it('a valid token on /api/%63ompanion/state is honoured like /api/companion/state', async () => {
    const res = await anonApp.request(
      '/api/%63ompanion/state',
      { method: 'GET', headers: bearer },
      withLogin,
    );
    expect(res.status).toBe(200);
  });

  it.each(['/%61pi/profile', '/api/pro%66ile'])('GET %s stays login-exempt', async (path) => {
    const res = await anonApp.request(path, { method: 'GET' }, withLogin);
    expect(res.status).toBe(200);
  });

  it.each([
    '/%61pi/admin/users',
    '/api/%61dmin/users',
  ])('%s keeps the admin-token rules', async (path) => {
    const res = await anonApp.request(
      path,
      { method: 'GET', headers: adminHeader('wrong') },
      envWith({ REQUIRE_LOGIN: '1', ADMIN_TOKEN: 'right' }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ detail: 'Invalid or missing admin token.' });
  });

  it('every registered /api route answers /%61pi<rest> exactly as /api<rest>', async () => {
    const routes = anonApp.routes.filter((r) => r.method !== 'ALL' && r.path.startsWith('/api/'));
    expect(routes.length).toBeGreaterThan(40);
    for (const r of routes) {
      const rest = r.path.slice('/api'.length).replace(/:[^/]+/g, 'x');
      const literal = await anonApp.request(`/api${rest}`, { method: r.method }, withLogin);
      const encoded = await anonApp.request(`/%61pi${rest}`, { method: r.method }, withLogin);
      expect(`${r.method} ${r.path} -> ${encoded.status}`).toBe(
        `${r.method} ${r.path} -> ${literal.status}`,
      );
    }
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
    const { sessionId: session } = await seededSession();
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
    const { sessionId: session } = await seededSession();
    const res = await app.request(
      `/api/sessions/${session}/audio/segments`,
      { method: 'POST', headers: { 'content-length': String(60 * 1024 * 1024) }, body: 'x' },
      { ...env },
    );
    expect(res.status).toBe(413);
  });
});
