import { env, fetchMock } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { putOauthState } from '../auth/identity';
import app from '../index';
import { catalogFor } from '../test/helpers';
import { makeKeypair, mintIdToken, mockGoogleJwks, mockGoogleToken } from '../test/oauth';

const envWith = (o: Record<string, string>): typeof env =>
  ({ ...env, ...o }) as unknown as typeof env;
const CLIENT = 'test-client';
const OAUTH_ENV = envWith({
  GOOGLE_CLIENT_ID: CLIENT,
  GOOGLE_CLIENT_SECRET: 'secret',
  PUBLIC_BASE_URL: 'http://127.0.0.1:8787',
});

beforeAll(() => fetchMock.activate());

async function runCallback(opts: {
  sub?: string;
  email?: string;
  state?: string;
  code?: string;
}): Promise<Response> {
  const kp = await makeKeypair();
  const idToken = await mintIdToken({
    privateKey: kp.privateKey,
    kid: kp.kid,
    audience: CLIENT,
    claims: { sub: opts.sub, email: opts.email ?? 'a@b.com', given_name: 'A', family_name: 'B' },
  });
  mockGoogleToken({ id_token: idToken });
  mockGoogleJwks(kp.publicJwk);
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
