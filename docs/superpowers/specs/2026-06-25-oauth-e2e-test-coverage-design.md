# OAuth end-to-end test coverage — design

**Date:** 2026-06-25
**Status:** Approved (pending spec review)
**Scope:** Test-only. No production-code changes — characterizes current behavior. Reuses the hybrid harness from `2026-06-25-comprehensive-test-suite-design.md`.

## Background

The comprehensive-test-suite work deferred `oauth_google.ts` end-to-end coverage because it needs mocked Google JWKS key material. This sub-spec covers the OAuth surface: the pure `googleAuthorizationUrl`, and the three auth routes (`/auth/google/start`, `/auth/google/callback`, `/auth/logout`). It is the first of three deferred follow-up sub-projects (the other two — the remaining-endpoint sweep and companion relay edge cases — get their own specs).

The callback (`src/routers/auth.ts:54-176`) is the hard part: it makes **two outbound fetches** —
1. `exchangeAuthorizationCode` → `POST https://oauth2.googleapis.com/token`, and
2. `verifyGoogleIdToken` → `jose.jwtVerify` against `createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'))` (`src/auth/oauth_google.ts:6,52-58`), which fetches Google's JWKS.

`GOOGLE_JWKS` is a module-level const but lazy — it fetches on first `jwtVerify`, so a mock active before the first verify works.

## Goals

1. A reusable OAuth mock harness: intercept Google's token + certs endpoints and mint a real JWT signed by a test keypair whose public half the mocked JWKS serves — so `verifyGoogleIdToken`'s real `jose` path is exercised (true e2e, not a stub).
2. Cover the OAuth happy path (new user + existing user) and every error branch in the callback.
3. Cover `/auth/google/start` (redirect + CSRF-state storage) and `/auth/logout` (session revocation + cookie clear).
4. Unit-test the pure `googleAuthorizationUrl`.

## Non-goals

- The remaining-endpoint sweep (~40 routes) and companion relay edge cases — separate later specs.
- Real network calls to Google; refresh-token / token-revocation-at-Google flows.
- Any production-code change. Error-message text and status codes are asserted as current behavior.

## Architecture

### Mock harness — `src/test/oauth.ts`

Reusable helpers for the integration tests:

- `makeKeypair(): Promise<{ kid; privateKey; publicJwk }>` — `jose.generateKeyPair('RS256')`; export the public half via `jose.exportJWK`, attach a fixed `kid`, `alg: 'RS256'`, `use: 'sig'`.
- `mintIdToken(opts: { privateKey; kid; audience; claims }): Promise<string>` — `new jose.SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid }).setIssuer('https://accounts.google.com').setAudience(audience).setIssuedAt().setExpirationTime('1h').sign(privateKey)`.
- `mockGoogle(opts: { token?: { status; body }; jwks?: object }): void` — uses `fetchMock` from `cloudflare:test` to intercept:
  - `fetchMock.get('https://oauth2.googleapis.com').intercept({ path: '/token', method: 'POST' }).reply(status, body)`
  - `fetchMock.get('https://www.googleapis.com').intercept({ path: '/oauth2/v3/certs', method: 'GET' }).reply(200, { keys: [publicJwk] })`
- Integration files call `fetchMock.activate()` in `beforeAll` and `fetchMock.assertNoPendingInterceptors()` where appropriate; `.reply` with `{ times: N }` or fresh interceptors per test as needed.

The env's `GOOGLE_CLIENT_ID` is set per-test (via the `envWith` cast pattern) so the audience in the minted JWT matches what the callback verifies.

### Pure tier — `src/auth/oauth_google.test.ts` (node)

`googleAuthorizationUrl({ clientId, state, redirectUri })` asserts the produced URL: base `https://accounts.google.com/o/oauth2/v2/auth`, and query params `client_id`, `redirect_uri`, `response_type=code`, `scope=openid email profile`, `state`, `access_type=online`, `prompt=select_account`.

### Integration tier — `src/routers/auth.int.test.ts` (workers)

Drives `app.request(path, init, envWith({...}))`. Cases:

- **start:** `GET /auth/google/start` → 302; `Location` host is `accounts.google.com` and carries a `state` param; a `csrf:<state>` key now exists in `AUTH` KV.
- **callback — new user:** put a valid state in KV, `mockGoogle({ token: { status: 200, body: { id_token } }, jwks })` with a freshly-minted id_token (sub/email/name claims) → 302 redirect to `/`; response sets the session cookie; `catalog.authGetUserByGoogleSub(sub)` now returns the user.
- **callback — existing user:** seed the user first (same `sub`), then run the callback → the existing-user update branch (`auth.ts:126-128+`) runs; still 302 + cookie; no duplicate user.
- **callback — error branches** (each asserts the status from `auth.ts`):
  - `?error=access_denied` → 400.
  - missing `code` and/or `state` → 400.
  - unknown/expired state (none stored) → 400.
  - `oauthConfigured` false (`envWith({ GOOGLE_CLIENT_ID: '' })`) → 503.
  - token exchange HTTP failure (`mockGoogle({ token: { status: 400, body: {...} } })`) → 400.
  - bad id_token signature (mock the JWKS with a *different* keypair's public JWK than the one that signed) → 400.
  - claims missing `sub` (mint a token without `sub`) → 400.
- **logout:** `GET` and `POST /auth/logout` with a valid session cookie → session key removed from `AUTH` KV; response clears the cookie; redirect.

## Error handling & edge cases

The callback's seven distinct failure branches are each asserted by status code, plus the two success branches (new/existing user). State single-use is exercised implicitly (the happy path consumes the stored state via `takeOauthState`).

## Verification

- `npm run test` green across both projects (existing 107 + new pure + new integration).
- `npm run typecheck` clean.
- The Task-0 spike (below) passes before the bulk of the OAuth integration tests are authored.

## Risks & rollback

- **`fetchMock` ↔ `jose` interplay (primary risk).** `createRemoteJWKSet` fetches the JWKS via the global `fetch`; the mock must intercept it inside the worker. **Plan Task 0 is a single spike test** — mint a JWT, mock both endpoints, run the callback, assert 302 + user created — to prove the mechanism in pool-workers 0.8.71 before writing the rest. If `fetchMock` cannot intercept jose's internal fetch, fall back to: unit-test `googleAuthorizationUrl` + the *pre-fetch* callback branches (error/missing-params/state/oauthConfigured), and characterize `exchangeAuthorizationCode`/`verifyGoogleIdToken` against `fetchMock` directly at the function level. This fallback is logged, not silently taken.
- **`createRemoteJWKSet` caching/cooldown.** jose caches the JWKS and has a cooldown; per-test isolation (`isolatedStorage`) plus fresh module state per worker should avoid cross-test bleed. If a stale-key cooldown bites, use a fresh `kid` per test so the set re-fetches.
- All additions are new files (`src/test/oauth.ts`, `src/auth/oauth_google.test.ts`, `src/routers/auth.int.test.ts`); revert is clean. No production code changes.

## Versioning

Test-only; no version bump. No new runtime dependencies (`jose` is already a dependency; `fetchMock` ships with `@cloudflare/vitest-pool-workers`).
