// Authorization invariants locked by the gate (de-cloudflare-strong-core D6,
// tasks 7.1/7.3): API_TOKEN machine clients bypass studio membership
// (the Companion path), cross-studio access masks as 404 (not 403), the admin
// token distinguishes unset (503) from wrong (401), and a session cookie alone
// grants no admin access.

import { describe, expect, it } from 'vitest';
import { app, envWith } from '../test/harness';
import {
  loginCookie,
  seededSession,
  seedStudio,
  seedUser,
  setCompanionPresence,
} from '../test/helpers';

const withLogin = envWith({ REQUIRE_LOGIN: '1' });
const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

describe('API_TOKEN machine clients (task 7.1 — the Companion path)', () => {
  it('reaches a session in a studio it is not a member of, under REQUIRE_LOGIN=1', async () => {
    const { sessionId: session } = await seededSession();
    setCompanionPresence('authz-c1', session);
    // Machine client: bearer API_TOKEN, no cookie, no user, no membership anywhere.
    const res = await app.request(
      '/api/companion/state',
      { method: 'GET', headers: bearer('test-api-token') },
      withLogin,
    );
    expect(res.status).toBe(200); // no membership scoping applied on the Companion path
    const body = (await res.json()) as { session: { id: string } | null };
    expect(body.session?.id).toBe(session);
  });

  it('a wrong API token is NOT authenticated: 401 under REQUIRE_LOGIN=1', async () => {
    const res = await app.request(
      '/api/companion/state',
      { method: 'GET', headers: bearer('wrong-token') },
      withLogin,
    );
    expect(res.status).toBe(401);
  });

  it('is not an identity outside /api/companion/: 401 on a session-scoped route (api-contract-freeze)', async () => {
    const { sessionId: session } = await seededSession();
    for (const id of [session, 'no-such-session']) {
      const res = await app.request(
        `/api/sessions/${id}/status`,
        { method: 'GET', headers: bearer('test-api-token') },
        withLogin,
      );
      // Rejected by the single middleware login decision — requireSession is never reached,
      // so an existing and a nonexistent session are indistinguishable.
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ detail: 'Login required.' });
    }
  });
});

describe('API_TOKEN on an encoded /api spelling (gate-decoded-path D2)', () => {
  it('a token-only request to /%61pi/sessions/<id>/status is 401, not the session’s status', async () => {
    const { sessionId: session } = await seededSession();
    const res = await app.request(
      `/%61pi/sessions/${session}/status`,
      { method: 'GET', headers: bearer('test-api-token') },
      withLogin,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ detail: 'Login required.' });
  });
});

describe('cross-studio masking (task 7.3)', () => {
  it('an authenticated non-member gets 404 — never 403', async () => {
    const outsider = await seedStudio();
    const { sessionId: session } = await seededSession();
    const user = await seedUser({ studios: [outsider] });
    const res = await app.request(
      `/api/sessions/${session}/status`,
      { method: 'GET', headers: { Cookie: await loginCookie(user) } },
      withLogin,
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { detail: string }).detail).toBe('Session not found');
  });

  it('a member of the session’s studio gets 200', async () => {
    const { studioId: studio, sessionId: session } = await seededSession();
    const user = await seedUser({ studios: [studio] });
    const res = await app.request(
      `/api/sessions/${session}/status`,
      { method: 'GET', headers: { Cookie: await loginCookie(user) } },
      withLogin,
    );
    expect(res.status).toBe(200);
  });
});

describe('admin token semantics (task 7.3)', () => {
  it('503 when ADMIN_TOKEN is unset vs 401 when the token is wrong', async () => {
    const unset = await app.request(
      '/api/admin/users',
      { method: 'GET' },
      envWith({ ADMIN_TOKEN: '' }),
    );
    expect(unset.status).toBe(503);
    const wrong = await app.request(
      '/api/admin/users',
      { method: 'GET', headers: bearer('nope') },
      envWith({ ADMIN_TOKEN: 'right' }),
    );
    expect(wrong.status).toBe(401);
  });

  it('a session cookie alone grants no admin access (401)', async () => {
    const studio = await seedStudio();
    const user = await seedUser({ studios: [studio] });
    const res = await app.request(
      '/api/admin/users',
      { method: 'GET', headers: { Cookie: await loginCookie(user) } },
      envWith({ ADMIN_TOKEN: 'right', REQUIRE_LOGIN: '1' }),
    );
    expect(res.status).toBe(401);
  });
});
