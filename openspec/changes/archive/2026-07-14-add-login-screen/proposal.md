## Why

On `REQUIRE_LOGIN=1` deployments with Google OAuth configured, an unauthenticated visitor
gets no designed sign-in experience: the full app shell renders around an empty profile,
the only affordance is a small "Sign in with Google" button in the nav rail
(`web/src/pages/index/components/V6Rail.tsx`), and every OAuth callback failure (user
cancels at Google, expired CSRF state, token-exchange error, invalid id_token) strands the
user on a raw JSON error page — the callback is a top-level navigation, so the web app
never regains control.

## What Changes

- **Branded full-screen login page (web-only render gate).** The index page renders a
  dedicated login view instead of the app shell when the anonymous-allowed
  `GET /api/profile` payload reports `auth.oauth_configured === true && auth.logged_in ===
  false` — the same predicate the existing rail button uses. It carries AutoLogger
  branding, a Google sign-in button and a create-account affordance (both linking to the
  existing `/auth/google/start` — first Google sign-in creates the account
  automatically; no separate registration flow exists), and an error banner (see below).
  A profile fetch that fails outright renders a retryable error state, never the app
  shell and never an unbounded blank screen.
- **OAuth callback failure redirect (authorized server delta).** The failure paths of
  `GET /auth/google/callback` change from JSON `400`/`503` bodies to
  `302 → /?login_error=<code>`, where `<code>` is a stable identifier per failure class
  (`provider_error`, `oauth_not_configured`, `missing_params`, `state_invalid`,
  `exchange_failed`, `token_invalid`). The login page maps codes to grouped, retryable
  messages. Former response `detail` strings (including operator guidance) move to the
  server log, sanitized. The success path (cookie + `302 /`), `/auth/google/start`, and
  `/auth/logout` are untouched.
- **Dev anonymous mode unaffected.** With `REQUIRE_LOGIN=0` and no OAuth config,
  `/api/profile` returns a full profile with `oauth_configured: false`; the login gate
  never triggers and the app behaves exactly as today.

## Capabilities

### New Capabilities
- `web-login-experience`: the frontend's unauthenticated experience — login-page render
  gate (including loading and profile-error states), Google sign-in entry, and
  login-error rendering from `?login_error=<code>`.

### Modified Capabilities
- `api-contract-freeze`: authorizes exactly one observable change — the failure responses
  of `GET /auth/google/callback` become `302` redirects to `/?login_error=<code>` instead
  of JSON `400`/`503` bodies. The frozen surface is the redirect mechanism and the
  meaning/stability of the named codes; the code set is additive-open (clients must
  tolerate unknown codes). All other frozen surface (callback success path, `/start`,
  `/logout`, every `/api/*` shape) is unchanged.

## Impact

- **Contract impact:** one authorized change — `GET /auth/google/callback` failure
  responses (status codes 400/503 + JSON bodies → 302 + `Location: /?login_error=<code>`).
  Everything else: none.
- **Server:** `server/src/routers/auth.ts` (callback failure branches only). Seven
  existing status assertions in `server/src/routers/auth.int.test.ts` currently lock
  the 400/503 failure behavior and are rewritten to assert the redirects (plus new
  coverage: the missing-`id_token` sub-branch, an unexpected-error-stays-500 test, and
  log sanitization; the existing happy-path test already locks the success path).
  README endpoint table note for the callback row.
- **Web:** `web/src/pages/index/` — new login page component + root render switch above
  `AppShell`, error-code → grouped-message mapping, removal of the now-unreachable
  rail sign-in button. No new API calls (uses the existing profile query).
- **e2e:** a second hermetic server config (dummy `GOOGLE_CLIENT_ID/SECRET/
  PUBLIC_BASE_URL`, `REQUIRE_LOGIN=1`, own port + `DATA_DIR`) alongside the existing
  OAuth-unconfigured `webServer` in `playwright.config.ts`, with a login-gate smoke spec
  scoped to its own project (the existing `chromium` project gains one `testIgnore`
  line). The existing smoke/visual suites keep the OAuth-unconfigured server unchanged.
- **Untouched:** Companion module, WebSocket surface, all `/api/*` routes, catalog/DB
  layer.

## Non-Goals

- No post-login redirect-back. Gate decision (2026-07-14): dropped — the login page is
  the only sign-in entry and only renders at `/`, the app has no URL-addressed state, and
  `/admin/users` is admin-token-gated outside the Google-login world, so there is nothing
  to preserve; the callback's frozen `302 /` already lands users on the only gated page.
  Planned to return in the follow-on **session-deep-links** change (router +
  `/sessions/:id`), which creates the URL-addressed state that gives it a payload.
  (Likewise no server-side `?next=` parameter.)
- No change to session/cookie semantics, TTLs, or the login-session KV scheme.
- No new identity providers, no email/password auth, no logout-confirmation UX.
- No exposure of `REQUIRE_LOGIN` in the profile payload; the hybrid config
  (`REQUIRE_LOGIN=0` **with** OAuth configured) intentionally shows the login page, as the
  current UI already treats that state as signed-out (empty profile + rail sign-in
  button).
- No redesign of `/admin/users`; it keeps its admin-token flow and stays unlinked.
