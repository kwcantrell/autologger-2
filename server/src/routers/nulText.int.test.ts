// api-contract-freeze "Text containing NUL is refused" (catalog-on-postgres D5): Postgres text
// can't hold U+0000, so a NUL that would reach a catalog statement is a 400, never a 500; the
// presence, OAuth state and identity-claim paths are handled where they enter.

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { putOauthState } from '../auth/identity';
import { app, defaultUser, env, envWith } from '../test/harness';
import {
  catalogFor,
  loginCookie,
  SEED_CATEGORY_ID,
  seedCompanionDevice,
  seededSession,
  seedStudio,
  seedUser,
  testDb,
} from '../test/helpers';
import {
  makeKeypair,
  mintIdToken,
  mockGoogleJwks,
  mockGoogleToken,
  mockGoTrue,
  resetMockAgent,
} from '../test/oauth';
import { harnessHub } from '../test/session/sessionRows';

const J = { 'content-type': 'application/json' };
const NUL = '\u0000';

async function member(): Promise<{ studioId: string; cookie: string }> {
  const studioId = await seedStudio();
  // An admin: creating a show needs owner or admin (show-grants D9).
  const userId = await seedUser({ studios: [studioId], role: 'admin' });
  return { studioId, cookie: await loginCookie(userId) };
}

// session-tables task 6.4 (design D5; api-contract-freeze "Text containing NUL is refused", which
// now covers session content): an event message with NUL was stored by the SQLite session file
// (200); on the session tables the adapter refuses it before sending, so the write saves nothing
// and sends no frame.
describe('NUL in session content is a 400', () => {
  it('POST …/events with a NUL message: 400 with detail, no event, no frame', async () => {
    const { sessionId } = await seededSession();
    const hub = await harnessHub(sessionId);
    const frames: string[] = [];
    const socket = { send: (d: string) => void frames.push(d) };
    hub.attachSocket(socket, 'browser');
    const res = await app.request(
      `/api/sessions/${sessionId}/events`,
      {
        method: 'POST',
        headers: J,
        body: JSON.stringify({ category: SEED_CATEGORY_ID, message: `a${NUL}b` }),
      },
      { ...env },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ detail: expect.any(String) });
    expect((await hub.listEvents({ limit: 10, offset: 0 })).total).toBe(0);
    expect(frames).toEqual([]);
    hub.detachSocket(socket);
  });
});

describe('NUL in request values reaching the catalog is a 400', () => {
  it('a show name with NUL: 400 with detail, and no show is created', async () => {
    const { studioId, cookie } = await member();
    const res = await app.request(
      '/api/shows',
      {
        method: 'POST',
        headers: { ...J, cookie },
        body: JSON.stringify({ studio_id: studioId, name: `a${NUL}b`, show_code: 'AB' }),
      },
      { ...env },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ detail: expect.any(String) });
    expect(await catalogFor().shows.listShowsForStudio(studioId)).toEqual([]);
  });

  it('a team display name with NUL: 400, as the family’s other validation errors, and no team', async () => {
    const userId = await seedUser();
    const cookie = await loginCookie(userId);
    const res = await app.request(
      '/api/teams',
      {
        method: 'POST',
        headers: { ...J, cookie },
        body: JSON.stringify({ id: 'nul-team', display_name: `x${NUL}y` }),
      },
      { ...env },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ detail: expect.any(String) });
    expect(
      await testDb().first('SELECT id FROM studio_definitions WHERE id = ?', 'nul-team'),
    ).toBeNull();
  });

  it('a team id path segment with a percent-encoded NUL: 400 with detail, not 500', async () => {
    const { cookie } = await member();
    const res = await app.request(
      '/api/teams/a%00b',
      { method: 'GET', headers: { cookie } },
      { ...env },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ detail: expect.any(String) });
  });

  it('a presence session_id with NUL: 400, and state answers as if it was never posted', async () => {
    const res = await app.request(
      '/api/companion/presence',
      {
        method: 'POST',
        // D9 category 7: presence is posted by the browser (a cookie); a device now gets 403.
        headers: { ...J, cookie: (await defaultUser()).cookie },
        body: JSON.stringify({ client_id: 'c-nul', session_id: `s${NUL}1`, visible: true }),
      },
      { ...env },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ detail: expect.any(String) });
    const state = await app.request(
      '/api/companion/state',
      { method: 'GET', headers: (await seedCompanionDevice()).bearer },
      { ...env },
    );
    expect(state.status).toBe(200);
    expect(((await state.json()) as { active_session_id: unknown }).active_session_id).toBeNull();
  });
});

describe('NUL in the OAuth callback', () => {
  const CLIENT = 'test-client';
  const OAUTH_ENV = envWith({
    GOOGLE_CLIENT_ID: CLIENT,
    GOOGLE_CLIENT_SECRET: 'secret',
    PUBLIC_BASE_URL: 'http://127.0.0.1:8787',
  });
  let KP: Awaited<ReturnType<typeof makeKeypair>>;
  beforeAll(async () => {
    KP = await makeKeypair();
  });
  afterEach(resetMockAgent);

  async function callback(claims: Record<string, unknown>): Promise<Response> {
    const idToken = await mintIdToken({
      privateKey: KP.privateKey,
      kid: KP.kid,
      audience: CLIENT,
      claims: { given_name: 'A', family_name: 'B', email_verified: true, ...claims },
    });
    mockGoogleToken({ id_token: idToken });
    mockGoogleJwks(KP.publicJwk);
    mockGoTrue({ id: `gt-${String(claims.sub)}`, sub: String(claims.sub) });
    await putOauthState(env.ports.kv, 'state-nul');
    return app.request(
      '/auth/google/callback?code=abc&state=state-nul',
      { method: 'GET' },
      OAUTH_ENV,
    );
  }

  it('a state with a percent-encoded NUL is an invalid state', async () => {
    const res = await app.request(
      '/auth/google/callback?code=abc&state=a%00b',
      { method: 'GET' },
      OAUTH_ENV,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/?login_error=state_invalid');
  });

  it('an email claim with NUL refuses sign-in with token_invalid and creates no user', async () => {
    const res = await callback({ sub: 'sub-nul-email', email: `a${NUL}@b.com` });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/?login_error=token_invalid');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await catalogFor().auth.authGetUserByGoogleSub('sub-nul-email')).toBeNull();
  });

  it('a sub claim with NUL refuses sign-in with token_invalid', async () => {
    const res = await callback({ sub: `s${NUL}1`, email: 'nul-sub@b.com' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/?login_error=token_invalid');
  });

  it('a given_name with NUL is stripped, and the user is created', async () => {
    const res = await callback({ sub: 'sub-nul-name', email: 'n@b.com', given_name: `An${NUL}na` });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    const user = await catalogFor().auth.authGetUserByGoogleSub('sub-nul-name');
    expect(user?.given_name).toBe('Anna');
  });
});
