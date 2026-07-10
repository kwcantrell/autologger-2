import { beforeAll, describe, expect, it } from 'vitest';
import { putOauthState } from '../auth/identity';
import { app, env, envWith } from '../test/harness';
import { catalogFor, loginCookie, seedUser } from '../test/helpers';
import { makeKeypair, mintIdToken, mockGoogleJwks, mockGoogleToken } from '../test/oauth';

const CLIENT = 'test-client';
const OAUTH_ENV = envWith({
  GOOGLE_CLIENT_ID: CLIENT,
  GOOGLE_CLIENT_SECRET: 'secret',
  PUBLIC_BASE_URL: 'http://127.0.0.1:8787',
});

// One shared keypair for the whole file: jose's createRemoteJWKSet caches the
// JWKS at module scope with a cooldown, so the first fetch's key is reused for
// every later verify. Reusing one kid keeps the cached JWKS valid for all
// happy-path tokens. (The bad-signature test deliberately uses a different key,
// whose kid is absent from the cached set → verify fails → 400.)
let KP: Awaited<ReturnType<typeof makeKeypair>>;
beforeAll(async () => {
  KP = await makeKeypair();
});

async function runCallback(opts: {
  sub?: string;
  email?: string;
  state?: string;
  code?: string;
}): Promise<Response> {
  const idToken = await mintIdToken({
    privateKey: KP.privateKey,
    kid: KP.kid,
    audience: CLIENT,
    claims: { sub: opts.sub, email: opts.email ?? 'a@b.com', given_name: 'A', family_name: 'B' },
  });
  mockGoogleToken({ id_token: idToken });
  mockGoogleJwks(KP.publicJwk);
  const state = opts.state ?? 'state-spike';
  await putOauthState(env.AUTH, state);
  return app.request(
    `/auth/google/callback?code=${opts.code ?? 'abc'}&state=${state}`,
    { method: 'GET' },
    OAUTH_ENV,
  );
}

describe('OAuth callback happy path (spike)', () => {
  it('verifies a minted id_token, creates the user, sets a session cookie', async () => {
    const res = await runCallback({ sub: 'sub-spike' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    expect(res.headers.get('set-cookie')).toContain('autologger_sid=');
    const user = await catalogFor().authGetUserByGoogleSub('sub-spike');
    expect(user).not.toBeNull();
  });
});

describe('GET /auth/google/start', () => {
  it('redirects to Google and stores a CSRF state', async () => {
    const res = await app.request('/auth/google/start', { method: 'GET' }, OAUTH_ENV);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location') ?? '');
    expect(loc.host).toBe('accounts.google.com');
    const state = loc.searchParams.get('state');
    expect(state).toBeTruthy();
    expect(await env.AUTH.get(`csrf:${state}`)).toBe('1');
  });

  it('503 when OAuth is not configured', async () => {
    const res = await app.request(
      '/auth/google/start',
      { method: 'GET' },
      envWith({ GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: 'secret' }),
    );
    expect(res.status).toBe(503);
  });
});

describe('callback — existing user', () => {
  it('updates (does not duplicate) a user with a known google sub', async () => {
    const sub = 'sub-existing';
    const seededId = await seedUser({ sub });
    const res = await runCallback({ sub });
    expect(res.status).toBe(302);
    const user = await catalogFor().authGetUserByGoogleSub(sub);
    expect(user).not.toBeNull();
    expect(String(user?.id)).toBe(seededId);
  });
});

describe('callback — error branches', () => {
  it('400 on ?error=', async () => {
    const res = await app.request(
      '/auth/google/callback?error=access_denied',
      { method: 'GET' },
      OAUTH_ENV,
    );
    expect(res.status).toBe(400);
  });

  it('503 when OAuth not configured', async () => {
    const res = await app.request(
      '/auth/google/callback?code=x&state=y',
      { method: 'GET' },
      envWith({ GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: 'secret' }),
    );
    expect(res.status).toBe(503);
  });

  it('400 on missing code/state', async () => {
    const res = await app.request('/auth/google/callback?code=abc', { method: 'GET' }, OAUTH_ENV);
    expect(res.status).toBe(400);
  });

  it('400 on unknown/expired state', async () => {
    const res = await app.request(
      '/auth/google/callback?code=abc&state=never-stored',
      { method: 'GET' },
      OAUTH_ENV,
    );
    expect(res.status).toBe(400);
  });

  it('400 when the token exchange fails', async () => {
    mockGoogleToken({ error: 'invalid_grant' }, 400);
    await putOauthState(env.AUTH, 'state-tokfail');
    const res = await app.request(
      '/auth/google/callback?code=abc&state=state-tokfail',
      { method: 'GET' },
      OAUTH_ENV,
    );
    expect(res.status).toBe(400);
  });

  it('400 on a bad id_token signature (JWKS key mismatch)', async () => {
    const signer = await makeKeypair();
    const other = await makeKeypair(); // different key served by JWKS
    const idToken = await mintIdToken({
      privateKey: signer.privateKey,
      kid: signer.kid,
      audience: CLIENT,
      claims: { sub: 'sub-badsig', email: 'a@b.com' },
    });
    mockGoogleToken({ id_token: idToken });
    mockGoogleJwks(other.publicJwk);
    await putOauthState(env.AUTH, 'state-badsig');
    const res = await app.request(
      '/auth/google/callback?code=abc&state=state-badsig',
      { method: 'GET' },
      OAUTH_ENV,
    );
    expect(res.status).toBe(400);
  });

  it('400 when claims are missing sub', async () => {
    const res = await runCallback({ sub: undefined, state: 'state-nosub' });
    expect(res.status).toBe(400);
  });
});

describe('logout', () => {
  it('GET clears the session cookie and redirects', async () => {
    const cookie = await loginCookie(await seedUser({}));
    const res = await app.request(
      '/auth/logout',
      { method: 'GET', headers: { Cookie: cookie } },
      OAUTH_ENV,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    expect(res.headers.get('set-cookie')).toContain('autologger_sid=');
  });

  it('POST logout also redirects', async () => {
    const res = await app.request('/auth/logout', { method: 'POST' }, OAUTH_ENV);
    expect(res.status).toBe(302);
  });
});
