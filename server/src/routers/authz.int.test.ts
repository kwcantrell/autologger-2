// Authorization invariants locked by the gate (de-cloudflare-strong-core D6,
// tasks 7.1/7.3): a Companion device is authorized as its user (companion-devices D9 category 3;
// it replaced the API_TOKEN machine client that bypassed studio membership), cross-studio access
// masks as 404 (not 403), the admin
// token distinguishes unset (503) from wrong (401), and a session cookie alone
// grants no admin access.

import { describe, expect, it } from 'vitest';
import { anonApp, envWith } from '../test/harness';
import {
  catalogFor,
  loginCookie,
  seedAccessMatrix,
  seedCompanionDevice,
  seededSession,
  seedStudio,
  seedUser,
  setCompanionPresence,
} from '../test/helpers';

const withLogin = envWith({});
const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

describe('Companion device clients (task 7.1 — the Companion path)', () => {
  // core-ports-architecture "Companion device callers are authorized as their user".
  it("is scoped as its user: a studio the user is not in reads as no session; a granted show's session is seen", async () => {
    const m = await seedAccessMatrix();
    for (const [who, sees] of [
      [m.nonMember, false],
      [m.ungranted, false],
      [m.granted, true],
    ] as const) {
      await setCompanionPresence(`authz-${who.id}`, m.sessionId, { user_id: who.id });
      const res = await anonApp.request(
        '/api/companion/state',
        { method: 'GET', headers: (await seedCompanionDevice(who.id)).bearer },
        withLogin,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        active_session_id: string | null;
        session: { id: string } | null;
      };
      expect(body.session?.id ?? null).toBe(sees ? m.sessionId : null);
      expect(body.active_session_id).toBe(sees ? m.sessionId : null);
    }
  });

  it('a wrong device token is NOT authenticated: 401', async () => {
    const res = await anonApp.request(
      '/api/companion/state',
      { method: 'GET', headers: bearer('wrong-token') },
      withLogin,
    );
    expect(res.status).toBe(401);
  });

  it('is not an identity outside /api/companion/: 401 on a session-scoped route (api-contract-freeze)', async () => {
    const { sessionId: session } = await seededSession();
    for (const id of [session, 'no-such-session']) {
      const res = await anonApp.request(
        `/api/sessions/${id}/status`,
        { method: 'GET', headers: (await seedCompanionDevice()).bearer },
        withLogin,
      );
      // Rejected by the single middleware login decision — requireSession is never reached,
      // so an existing and a nonexistent session are indistinguishable.
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ detail: 'Login required.' });
    }
  });
});

describe('a device token on an encoded /api spelling (gate-decoded-path D2)', () => {
  it('a device-token-only request to /%61pi/sessions/<id>/status is 401, not the session’s status', async () => {
    const { sessionId: session } = await seededSession();
    const res = await anonApp.request(
      `/%61pi/sessions/${session}/status`,
      { method: 'GET', headers: (await seedCompanionDevice()).bearer },
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
    const res = await anonApp.request(
      `/api/sessions/${session}/status`,
      { method: 'GET', headers: { Cookie: await loginCookie(user) } },
      withLogin,
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { detail: string }).detail).toBe('Session not found');
  });

  it('a member of the session’s studio granted its show gets 200 (show-grants D3)', async () => {
    const { studioId: studio, showId: show, sessionId: session } = await seededSession();
    const user = await seedUser({ studios: [studio] });
    await catalogFor().auth.authGrantShow(user, show, user, new Date().toISOString());
    const res = await anonApp.request(
      `/api/sessions/${session}/status`,
      { method: 'GET', headers: { Cookie: await loginCookie(user) } },
      withLogin,
    );
    expect(res.status).toBe(200);
  });
});

describe('admin token semantics (task 7.3)', () => {
  it('503 when ADMIN_TOKEN is unset vs 401 when the token is wrong', async () => {
    const unset = await anonApp.request(
      '/api/admin/users',
      { method: 'GET' },
      envWith({ ADMIN_TOKEN: '' }),
    );
    expect(unset.status).toBe(503);
    const wrong = await anonApp.request(
      '/api/admin/users',
      { method: 'GET', headers: bearer('nope') },
      envWith({ ADMIN_TOKEN: 'right' }),
    );
    expect(wrong.status).toBe(401);
  });

  it('a session cookie alone grants no admin access (401)', async () => {
    const studio = await seedStudio();
    const user = await seedUser({ studios: [studio] });
    const res = await anonApp.request(
      '/api/admin/users',
      { method: 'GET', headers: { Cookie: await loginCookie(user) } },
      envWith({ ADMIN_TOKEN: 'right' }),
    );
    expect(res.status).toBe(401);
  });
});
