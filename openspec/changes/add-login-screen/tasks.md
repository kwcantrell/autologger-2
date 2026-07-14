> Panel + gate passed 2026-07-14 (see design.md "Panel & review log"); this is the plan
> of record. `file:line` anchors are orientation only — locate code by content.

## 1. Server — authorized callback failure redirect (delta: api-contract-freeze)

- [x] 1.1 Rewrite the callback failure tests in `server/src/routers/auth.int.test.ts`
      (tests first — red against current behavior). The seven existing status assertions
      in the `callback — error branches` block (incl. the existing unconfigured-callback
      503 test) flip to: `302`, `Location: /?login_error=<code>` per the delta table,
      and no `Set-Cookie`. The `/start` 503 test is untouched; the existing happy-path
      test already locks the success path — confirm it still passes. Use the existing
      global-fetch Google mocks (`server/src/test/oauth.ts`). Hazards: the `runCallback`
      helper unconditionally mints an `id_token` + queues a JWKS mock — write the
      missing-`id_token` case without it; add the `afterEach(resetMockAgent)` that
      `test/oauth.ts` prescribes (currently missing from this file). Add missing
      coverage: the missing-`id_token` sub-branch (the only `token_invalid` path not
      already tested); an unexpected-error-stays-500 test (stub a post-verification
      write — e.g. the login-session KV put — to throw; assert 500, no `Location`, no
      cookie); and log sanitization (a hostile `?error=` carrying C0/C1 controls is
      logged stripped and capped per design D4; capture via `vi.spyOn(console, 'warn')`).
- [x] 1.2 Rework the failure branches in `server/src/routers/auth.ts` (locate by
      content): replace JSON `400`/`503` responses with `302 /?login_error=<code>`
      redirects; move former `detail` strings (incl. the `PUBLIC_BASE_URL` operator
      hint) to `console.warn`, sanitizing every request/provider-derived value per
      design D4: strip C0 (U+0000–U+001F), U+007F, C1 (U+0080–U+009F), U+2028/U+2029,
      and bidi overrides (U+202A–U+202E, U+2066–U+2069); cap at 256 chars; removal or a
      printable placeholder, never reversible escaping. Unexpected errors keep
      propagating to the app's 500 handler — no catch-all; `state_invalid` only on a
      completed lookup reporting the state absent. Success path untouched. Gate:
      `npm test` + `npm run typecheck`.
- [x] 1.3 Update the README endpoint table's auth row note to record the callback
      failure-redirect semantics (README is the normative inventory).

## 2. Web — login page and root gate

- [x] 2.1 Build `LoginPage` under `web/src/pages/index/components/`: branded full-screen
      view (existing dark theme tokens + brand assets, Google-branded sign-in button
      navigating to `/auth/google/start`), a distinct create-account affordance also
      navigating to `/auth/google/start` (copy: account creation happens automatically
      via Google sign-in — no separate registration form), `?login_error` banner with
      the three grouped messages (`state_invalid` → expired/try-again; `provider_error`
      → cancelled-or-refused; all else incl. unknown codes → generic) and a retry
      control. No deployment-config copy. Apply the frontend-design skill for the
      visual pass.
- [x] 2.2 Add the root switch in `pages/index/main.tsx` (design D2): `useProfile()` →
      brand loading treatment (in flight) / retryable error state (initial-load failure
      only; retry disabled while in flight) / `LoginPage` (`oauth_configured &&
      !logged_in`) / `AppShell`. Build it as a self-contained wrapper component (D2
      shape note — it later relocates above the session-deep-links router shell
      unchanged). Switch semantics per D2: key on query status + data — a successful
      refetch reporting signed-out flips shell → login view (mid-session sign-out); a
      refetch error with data present keeps the shell. Verify no authenticated `/api/*`
      or WebSocket traffic fires in the loading, error, or login states. Gate:
      `npm run typecheck` + `npm run lint`.
- [x] 2.3 Remove the now-unreachable sign-in button from `V6Rail` (its render predicate
      is identical to the gate's, so it can never render post-change) and simplify the
      `showSettings` complement in the same edit (it becomes constant-true); confirm dev
      anonymous mode renders identically to before (manual check; e2e guard is 3.2).

## 3. e2e smoke

- [ ] 3.1 Add a second hermetic server config (Playwright project + `webServer` entry)
      with: dummy `GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/PUBLIC_BASE_URL` (OAuth
      "configured", never contacting Google), `REQUIRE_LOGIN=1`, a distinct port, its
      **own `DATA_DIR`** (e.g. `e2e/.data-oauth`) with its own atomic wipe-then-start
      (webServer entries boot concurrently — do not share `e2e/.data`), and a
      per-project `use.baseURL`. Scope collection: `testMatch` the new spec to the new
      project and add one `testIgnore` entry for it to the existing `chromium` project.
      New spec asserts: login page renders instead of the app shell; the Google
      control's href is `/auth/google/start` (assert href only — never click; block or
      fail any navigation to `accounts.google.com`); `/?login_error=state_invalid`
      shows the expired message; an unknown code shows the generic message; no
      authenticated `/api/*` requests and no WebSocket connections while gated.
- [ ] 3.2 Confirm the existing OAuth-unconfigured e2e suites (smoke + visual) pass
      unchanged — the dev-anonymous regression guard.

## 4. Finalize

- [ ] 4.1 Full gates: `npm test`, `npm run typecheck`, `npm run lint`, `npm run e2e`.
- [ ] 4.2 Whole-branch review (apply-protocol final review), then
      `openspec validate add-login-screen --strict`.
