// Authorization invariants locked by the gate (de-cloudflare-strong-core D6,
// tasks 7.1/7.3): API_TOKEN machine clients bypass studio membership
// (the Companion path), cross-studio access masks as 404 (not 403), the admin
// token distinguishes unset (503) from wrong (401), and a session cookie alone
// grants no admin access.

import { describe, expect, it } from 'vitest';
import { app, envWith } from '../test/harness';
import { loginCookie, seedSession, seedShow, seedStudio, seedUser } from '../test/helpers';

const withLogin = envWith({ REQUIRE_LOGIN: '1' });
const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

async function seededSession(): Promise<{ studio: string; session: string }> {
  const studio = await seedStudio();
  const show = await seedShow({ studioId: studio });
  const session = await seedSession({ showId: show });
  return { studio, session };
}

describe('API_TOKEN machine clients (task 7.1 — the Companion path)', () => {
  it('reaches a session in a studio it is not a member of, under REQUIRE_LOGIN=1', async () => {
    const { session } = await seededSession();
    // Machine client: bearer API_TOKEN, no cookie, no user, no membership anywhere.
    const res = await app.request(
      `/api/sessions/${session}/status`,
      { method: 'GET', headers: bearer('test-api-token') },
      withLogin,
    );
    expect(res.status).toBe(200); // existence check only; membership scoping not applied
  });

  it('a wrong API token is NOT authenticated: 401 under REQUIRE_LOGIN=1', async () => {
    const { session } = await seededSession();
    const res = await app.request(
      `/api/sessions/${session}/status`,
      { method: 'GET', headers: bearer('wrong-token') },
      withLogin,
    );
    expect(res.status).toBe(401);
  });

  it('still 404s for a nonexistent session (existence check retained)', async () => {
    const res = await app.request(
      '/api/sessions/no-such-session/status',
      { method: 'GET', headers: bearer('test-api-token') },
      withLogin,
    );
    expect(res.status).toBe(404);
  });
});

describe('cross-studio masking (task 7.3)', () => {
  it('an authenticated non-member gets 404 — never 403', async () => {
    const outsider = await seedStudio();
    const { session } = await seededSession();
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
    const { studio, session } = await seededSession();
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
