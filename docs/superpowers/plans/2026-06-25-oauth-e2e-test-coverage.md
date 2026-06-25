# OAuth End-to-End Test Coverage — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cover the OAuth surface (`googleAuthorizationUrl` + `/auth/google/start|callback`, `/auth/logout`) end-to-end, intercepting Google's token + JWKS endpoints with `fetchMock` and verifying a real minted JWT through `jose`.

**Architecture:** A reusable `src/test/oauth.ts` helper (keypair + JWT minting + `fetchMock` wiring). One node unit test for the pure URL builder; one workers integration file driving the auth routes via `app.request`. A spike (Task 2) proves the `fetchMock`↔`jose` mechanism before the bulk.

**Tech Stack:** Vitest 2.1.9, `@cloudflare/vitest-pool-workers` 0.8.71 (`fetchMock`), `jose`, Hono.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-25-oauth-e2e-test-coverage-design.md`.
- **Branch:** `test/oauth-e2e` (already checked out).
- **No production-code changes.** Characterize current status codes / behavior (incl. error-message branches).
- **No new dependencies** (`jose` already a dep; `fetchMock` ships with pool-workers).
- **App access:** `import app from '../index'`; `app.request(path, init, envOverride)`.
- **Env overrides:** generated `Env` vars are literal-typed, so use the cast helper `envWith(o) = ({ ...env, ...o }) as unknown as typeof env`.
- **OAuth-configured env:** `oauthConfigured` needs `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` + `PUBLIC_BASE_URL`. `PUBLIC_BASE_URL` is set in `wrangler.jsonc` (`http://127.0.0.1:8787`); set the two Google vars via `envWith`.
- **Redirects are NOT followed** by `app.request` — assert `res.status === 302` + `Location`, never follow to `/` (which would hit ASSETS).
- **Test runner:** `npm run test`; single file `npx vitest run <path>` (add `--project workers` for `*.int.test.ts`). Type check: `npm run typecheck`.
- **Commit style:** Conventional Commits (`test:`).
- **Verified route facts** (from `src/routers/auth.ts`): start → 503 if unconfigured else 302; callback success → `c.redirect('/', 302)` + `setCookie('autologger_sid', ...)`; new user via `authCreateUserGoogle`, existing via `authUpdateUserProfile`; logout → `revokeLoginSession` + `deleteCookie` + 302.

---

### Task 1: Pure — `googleAuthorizationUrl`

**Files:**
- Create: `src/auth/oauth_google.test.ts`

**Interfaces:** Consumes `googleAuthorizationUrl` from `./oauth_google`.

- [ ] **Step 1: Write the test**

```ts
import { describe, expect, it } from 'vitest';
import { googleAuthorizationUrl } from './oauth_google';

describe('googleAuthorizationUrl', () => {
  it('builds the Google auth URL with the expected params', () => {
    const url = new URL(
      googleAuthorizationUrl({
        clientId: 'cid',
        state: 'st8',
        redirectUri: 'http://127.0.0.1:8787/auth/google/callback',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const q = url.searchParams;
    expect(q.get('client_id')).toBe('cid');
    expect(q.get('redirect_uri')).toBe('http://127.0.0.1:8787/auth/google/callback');
    expect(q.get('response_type')).toBe('code');
    expect(q.get('scope')).toBe('openid email profile');
    expect(q.get('state')).toBe('st8');
    expect(q.get('access_type')).toBe('online');
    expect(q.get('prompt')).toBe('select_account');
  });
});
```

- [ ] **Step 2: Run + commit**

Run: `npx vitest run src/auth/oauth_google.test.ts`
Expected: PASS.

```bash
git add src/auth/oauth_google.test.ts && git commit -m "test: googleAuthorizationUrl param building"
```

---

### Task 2: Mock harness + happy-path spike (DE-RISK GATE)

Builds `src/test/oauth.ts` and proves the whole mechanism with the callback happy path. **If the spike cannot be made green, STOP and report** — apply the spec's fallback (characterize only the pre-fetch branches; the other tasks depend on this).

**Files:**
- Create: `src/test/oauth.ts`
- Create: `src/routers/auth.int.test.ts` (spike test only; expanded in Task 3)

**Interfaces:**
- Produces `src/test/oauth.ts`:
  - `makeKeypair(): Promise<{ kid: string; privateKey: CryptoKey; publicJwk: JsonWebKey }>` — fresh RS256 keypair with a unique `kid` (forces `jose` JWKS re-fetch per test).
  - `mintIdToken(opts: { privateKey: CryptoKey; kid: string; audience: string; claims: Record<string, unknown> }): Promise<string>`.
  - `mockGoogleToken(body: unknown, status?: number): void` — intercept `POST oauth2.googleapis.com/token`.
  - `mockGoogleJwks(publicJwk: JsonWebKey): void` — intercept `GET www.googleapis.com/oauth2/v3/certs` with `{ keys: [publicJwk] }`.

- [ ] **Step 1: Write `src/test/oauth.ts`**

```ts
import { fetchMock } from 'cloudflare:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

let kidCounter = 0;

export async function makeKeypair(): Promise<{
  kid: string;
  privateKey: CryptoKey;
  publicJwk: JsonWebKey;
}> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const kid = `test-kid-${(kidCounter += 1)}`;
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  return { kid, privateKey: privateKey as CryptoKey, publicJwk };
}

export async function mintIdToken(opts: {
  privateKey: CryptoKey;
  kid: string;
  audience: string;
  claims: Record<string, unknown>;
}): Promise<string> {
  return new SignJWT(opts.claims)
    .setProtectedHeader({ alg: 'RS256', kid: opts.kid })
    .setIssuer('https://accounts.google.com')
    .setAudience(opts.audience)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(opts.privateKey);
}

export function mockGoogleToken(body: unknown, status = 200): void {
  fetchMock
    .get('https://oauth2.googleapis.com')
    .intercept({ path: '/token', method: 'POST' })
    .reply(status, JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

export function mockGoogleJwks(publicJwk: JsonWebKey): void {
  fetchMock
    .get('https://www.googleapis.com')
    .intercept({ path: '/oauth2/v3/certs', method: 'GET' })
    .reply(200, JSON.stringify({ keys: [publicJwk] }), {
      headers: { 'content-type': 'application/json' },
    });
}
```

- [ ] **Step 2: Write the spike `src/routers/auth.int.test.ts`**

```ts
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
```

- [ ] **Step 3: Run the spike (DE-RISK GATE)**

Run: `npx vitest run --project workers src/routers/auth.int.test.ts`
Expected: PASS. If it fails on the JWKS fetch (jose can't reach the mock), debug `fetchMock` activation/interceptor paths first; if `fetchMock` fundamentally can't intercept jose's internal fetch in this version, STOP and switch to the spec's fallback (drop the signed-JWT path; keep pre-fetch branches + function-level helper tests). Capture the decision in the commit message.

- [ ] **Step 4: Typecheck + commit**

Run: `npm run typecheck`
Expected: clean.

```bash
git add src/test/oauth.ts src/routers/auth.int.test.ts
git commit -m "test: OAuth mock harness (fetchMock + jose keypair) + callback happy-path spike"
```

---

### Task 3: Expand auth integration — start, existing-user, error branches, logout

**Files:**
- Modify: `src/routers/auth.int.test.ts` (add describes; keep the spike + its helpers)

**Interfaces:** Consumes the Task-2 helpers + `seedUser`, `loginCookie` from `../test/helpers`.

- [ ] **Step 1: Add the `/auth/google/start` tests**

Append to `src/routers/auth.int.test.ts`:

```ts
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
```

- [ ] **Step 2: Add the existing-user callback branch**

```ts
import { seedUser } from '../test/helpers';

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
```

- [ ] **Step 3: Add the callback error branches**

```ts
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
```

- [ ] **Step 4: Add the logout tests**

```ts
import { loginCookie } from '../test/helpers';

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
    // deleteCookie emits a clearing Set-Cookie for the session cookie.
    expect(res.headers.get('set-cookie')).toContain('autologger_sid=');
  });

  it('POST logout also redirects', async () => {
    const res = await app.request('/auth/logout', { method: 'POST' }, OAUTH_ENV);
    expect(res.status).toBe(302);
  });
});
```

- [ ] **Step 5: Run the full OAuth integration file + typecheck**

Run: `npx vitest run --project workers src/routers/auth.int.test.ts && npm run typecheck`
Expected: all OAuth integration tests PASS; typecheck clean. If any status differs, re-read the relevant branch in `src/routers/auth.ts` and correct the assertion to the real contract (do not change the router). If `fetchMock.assertNoPendingInterceptors`-style cross-test bleed appears (a leftover interceptor), set interceptors fresh per test (already the pattern) and ensure each minted token uses a fresh `makeKeypair` (unique `kid`).

- [ ] **Step 6: Commit**

```bash
git add src/routers/auth.int.test.ts
git commit -m "test: OAuth start/callback(new+existing)/error-branches/logout integration"
```

---

### Task 4: Full-suite verification

**Files:** none.

- [ ] **Step 1: Run both projects + typecheck**

Run: `npm run test && npm run typecheck`
Expected: every file green across `unit` and `workers`; `tsc --noEmit` clean. Confirm the total rose from 107 by the new OAuth tests.

- [ ] **Step 2: Commit (only if reconciling edits were needed)**

```bash
git add -A && git commit -m "test: reconcile OAuth suite to green" || echo "nothing to commit"
```

---

## Self-Review

**Spec coverage:**
- Mock harness (`src/test/oauth.ts`: keypair, mint, fetchMock) → Task 2.
- Pure `googleAuthorizationUrl` → Task 1.
- start (redirect + CSRF state; 503) → Task 3 Step 1.
- callback new user → Task 2 spike; existing user → Task 3 Step 2.
- callback 7 error branches (error / unconfigured / missing params / unknown state / token-fail / bad-sig / missing-sub) → Task 3 Step 3.
- logout (GET + POST) → Task 3 Step 4.
- Spike de-risk gate + fallback → Task 2 Step 3.
- Verification → Task 4.

**Placeholder scan:** No TODO/TBD. Task 3 Step 5's "re-read the branch if a status differs" names the exact file and contract — not a vague placeholder; complete test code is provided for every case.

**Type consistency:** `makeKeypair`/`mintIdToken`/`mockGoogleToken`/`mockGoogleJwks` signatures, the `envWith` cast helper, `CLIENT`/`OAUTH_ENV`, and `runCallback` are defined in Task 2 and reused verbatim in Task 3. `catalogFor`/`seedUser`/`loginCookie`/`putOauthState` match the existing helper + identity exports.
