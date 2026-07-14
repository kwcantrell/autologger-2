import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { putOauthState } from '../auth/identity';
import { app, env, envWith } from '../test/harness';
import { catalogFor, loginCookie, seedUser } from '../test/helpers';
import {
  makeKeypair,
  mintIdToken,
  mockGoogleJwks,
  mockGoogleToken,
  resetMockAgent,
} from '../test/oauth';

const CLIENT = 'test-client';
const OAUTH_ENV = envWith({
  GOOGLE_CLIENT_ID: CLIENT,
  GOOGLE_CLIENT_SECRET: 'secret',
  PUBLIC_BASE_URL: 'http://127.0.0.1:8787',
});

// test/oauth.ts prescribes this: it queues fake Google responses on global
// fetch, keyed on (method, path), consumed in registration order. Any mock a
// test queues but never consumes (an early return, an assertion failure
// before the request fires, etc.) must not bleed into the next test's queue.
afterEach(resetMockAgent);

// One shared keypair for the whole file: jose's createRemoteJWKSet caches the
// JWKS at module scope with a cooldown, so the first fetch's key is reused for
// every later verify. Reusing one kid keeps the cached JWKS valid for all
// happy-path tokens. (The bad-signature test deliberately uses a different key,
// whose kid is absent from the cached set -- verify fails -- 400.)
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
  await putOauthState(env.ports.kv, state);
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
    const user = catalogFor().auth.authGetUserByGoogleSub('sub-spike');
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
    expect(await env.ports.kv.get(`csrf:${state}`)).toBe('1');
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

describe('callback -- existing user', () => {
  it('updates (does not duplicate) a user with a known google sub', async () => {
    const sub = 'sub-existing';
    const seededId = await seedUser({ sub });
    const res = await runCallback({ sub });
    expect(res.status).toBe(302);
    const user = catalogFor().auth.authGetUserByGoogleSub(sub);
    expect(user).not.toBeNull();
    expect(String(user?.id)).toBe(seededId);
  });
});

describe('callback -- error branches', () => {
  // Delta table (specs/api-contract-freeze/spec.md): each enumerated failure
  // class now redirects 302 -> /?login_error=<code>, no body, no Set-Cookie --
  // replacing the former JSON 400/503 bodies.

  it('redirects with login_error=provider_error on ?error=', async () => {
    const res = await app.request(
      '/auth/google/callback?error=access_denied',
      { method: 'GET' },
      OAUTH_ENV,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/?login_error=provider_error');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('redirects with login_error=oauth_not_configured when OAuth not configured', async () => {
    const res = await app.request(
      '/auth/google/callback?code=x&state=y',
      { method: 'GET' },
      envWith({ GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: 'secret' }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/?login_error=oauth_not_configured');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('redirects with login_error=missing_params on missing code/state', async () => {
    const res = await app.request('/auth/google/callback?code=abc', { method: 'GET' }, OAUTH_ENV);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/?login_error=missing_params');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('redirects with login_error=state_invalid on unknown/expired state', async () => {
    const res = await app.request(
      '/auth/google/callback?code=abc&state=never-stored',
      { method: 'GET' },
      OAUTH_ENV,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/?login_error=state_invalid');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('redirects with login_error=exchange_failed when the token exchange fails', async () => {
    mockGoogleToken({ error: 'invalid_grant' }, 400);
    await putOauthState(env.ports.kv, 'state-tokfail');
    const res = await app.request(
      '/auth/google/callback?code=abc&state=state-tokfail',
      { method: 'GET' },
      OAUTH_ENV,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/?login_error=exchange_failed');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('redirects with login_error=token_invalid on a bad id_token signature (JWKS key mismatch)', async () => {
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
    await putOauthState(env.ports.kv, 'state-badsig');
    const res = await app.request(
      '/auth/google/callback?code=abc&state=state-badsig',
      { method: 'GET' },
      OAUTH_ENV,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/?login_error=token_invalid');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('redirects with login_error=token_invalid when claims are missing sub', async () => {
    const res = await runCallback({ sub: undefined, state: 'state-nosub' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/?login_error=token_invalid');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  // New coverage (task 1.1): the only token_invalid sub-branch not already
  // covered above. Written without runCallback -- that helper unconditionally
  // mints an id_token and queues a JWKS mock, which this case must not have:
  // the handler should short-circuit on the missing id_token before ever
  // reaching verifyIdToken/JWKS.
  it('redirects with login_error=token_invalid when the token response has no id_token', async () => {
    mockGoogleToken({ access_token: 'opaque-access-token' }); // no id_token field
    const state = 'state-no-idtoken';
    await putOauthState(env.ports.kv, state);
    const res = await app.request(
      `/auth/google/callback?code=abc&state=${state}`,
      { method: 'GET' },
      OAUTH_ENV,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/?login_error=token_invalid');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  // New coverage (task 1.1): the delta's boundary rule -- only the explicit,
  // classified branches above redirect; anything else (a post-verification
  // write throwing) must keep propagating to the app's ordinary 500 handler.
  // This is what makes "no blanket catch-all to 302" an executable rule
  // rather than just prose. May already be green today (current code has no
  // try/catch around the post-verification writes either) -- that's expected;
  // it's still required coverage for the redirect rework in 1.2 not to
  // regress it.
  it('stays 500 (no redirect, no cookie) when a post-verification write throws', async () => {
    const idToken = await mintIdToken({
      privateKey: KP.privateKey,
      kid: KP.kid,
      audience: CLIENT,
      claims: { sub: 'sub-writefail', email: 'a@b.com', given_name: 'A', family_name: 'B' },
    });
    mockGoogleToken({ id_token: idToken });
    mockGoogleJwks(KP.publicJwk);
    const state = 'state-writefail';
    await putOauthState(env.ports.kv, state);
    // The only kv.put call left on this request path (after state consumption
    // and successful verification) is createLoginSession's session write.
    const putSpy = vi.spyOn(env.ports.kv, 'put').mockImplementationOnce(() => {
      throw new Error('kv unavailable');
    });
    try {
      const res = await app.request(
        `/auth/google/callback?code=abc&state=${state}`,
        { method: 'GET' },
        OAUTH_ENV,
      );
      expect(res.status).toBe(500);
      expect(res.headers.get('location')).toBeNull();
      expect(res.headers.get('set-cookie')).toBeNull();
    } finally {
      putSpy.mockRestore();
    }
  });

  // New coverage (task 1.1): log sanitization (design D4). Former JSON
  // `detail` strings move to console.warn; request/provider-derived values
  // (here, the `error` query param) must be sanitized first because a
  // terminal log line is a new injection sink a JSON body never was. Pinned
  // to the D4 constants: strip C0 (U+0000-U+001F), U+007F, C1
  // (U+0080-U+009F), line/paragraph separators (U+2028/U+2029), bidi
  // overrides (U+202A-U+202E, U+2066-U+2069); cap at 256 chars; non-reversible
  // (no \u-style escaping that re-expands downstream).
  //
  // Assertions are written against *behavior* (which markers survive) rather
  // than one exact sanitized string, so they hold whether 1.2 implements
  // "strip" or "printable placeholder" -- D4 allows either. All forbidden
  // code points are built via \u escapes below -- never pasted as literal
  // control/invisible characters in source -- so the fixture is auditable.
  it('sanitizes a hostile ?error= value before logging it (control chars stripped, capped at 256)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // One representative code point per forbidden D4 class: C0 (U+0000,
    // U+001B "ESC"), U+007F (DEL), C1 (U+009B -- 8-bit CSI, the one C0-only
    // stripping would miss), line/paragraph separators (U+2028, U+2029),
    // bidi overrides (U+202E, U+2066).
    const controlNoise = [
      '\u0000',
      '\u001b',
      '\u007f',
      '\u009b',
      '\u2028',
      '\u2029',
      '\u202e',
      '\u2066',
    ].join('');
    const prefix = 'MARK_START';
    const filler = 'f'.repeat(260);
    const tailMarker = 'MARK_END_PAST_CAP';
    const hostile = prefix + controlNoise + filler + tailMarker;
    // Sanity check on the fixture itself: prefix + filler alone already
    // exceed 256 chars, so tailMarker is guaranteed to fall outside any
    // correctly-capped sanitized output regardless of where controlNoise
    // lands relative to the cut.
    expect(prefix.length + filler.length).toBeGreaterThan(256);
    try {
      const res = await app.request(
        `/auth/google/callback?error=${encodeURIComponent(hostile)}`,
        { method: 'GET' },
        OAUTH_ENV,
      );
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/?login_error=provider_error');
      expect(res.headers.get('set-cookie')).toBeNull();
      expect(await res.text()).toBe('');

      expect(warnSpy).toHaveBeenCalled();
      const logged = warnSpy.mock.calls.map((args) => args.map(String).join(' ')).join('\n');

      // The harmless printable prefix must survive whichever sanitization
      // strategy is used (strip-in-place or placeholder substitution only
      // touches the forbidden code points, never ordinary ASCII).
      expect(logged).toContain(prefix);
      // The marker placed past the 256-char cap must not appear -- proves
      // truncation happened, not just character stripping.
      expect(logged).not.toContain(tailMarker);
      // None of the forbidden code points may appear in the log line,
      // literally or otherwise-untransformed.
      const forbidden = /[\u0000-\u001f\u007f\u0080-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
      expect(forbidden.test(logged)).toBe(false);
      // Non-reversible: sanitization must not be a JSON/\u-style escape that
      // re-expands to a live control byte downstream.
      expect(logged).not.toMatch(/\\u0000|\\u001b|\\u202e/i);
    } finally {
      warnSpy.mockRestore();
    }
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
