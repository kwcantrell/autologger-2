# Tasks 8.1-8.3 — e2e: URL-driven session assertions + deep-link smoke + anonymous deep-link gate

Branch: `session-deep-links`. Scope: `e2e/` only (no `web/src` or `server/src` changes).

## 8.1 — flip `smoke.spec.ts`'s session assertion off `body.dataset.sessionId`

File: `e2e/smoke.spec.ts`, test `create a session, log via UI, and see an out-of-band
event live (WS)`.

- Added `await expect(page).toHaveURL(/\/sessions\/[^/]+$/);` immediately after session
  creation (right after the existing `#v3-session-grid` visibility assertion).
- Replaced `const sessionId = await page.evaluate(() => document.body.dataset.sessionId);`
  with `const sessionId = new URL(page.url()).pathname.split('/').pop();` — the id used
  to build the out-of-band POST now comes from the URL, matching the retired legacy
  spine (design D9 / spec "Legacy selection spine retired").
- The existing `#v3-session-grid` visibility assertions in both `smoke.spec.ts` and
  `visual.spec.ts` were left untouched and verified still green (they were already
  render-driven off the `sessionId` prop since phase 3, not off the dataset attribute).

## 8.2 — deep-link smoke (new test, chromium project, same hermetic server)

File: `e2e/smoke.spec.ts`, new test `deep-linking: a fresh reload on /sessions/<id>
restores the session; a garbage id renders not-found`.

- Creates a session via the UI, captures its `/sessions/<id>` URL.
- `page.goto(sessionUrl)` — a genuine fresh navigation (full reload), not an in-app
  transition — then asserts the URL is stable and `#v3-session-grid` is visible
  (workspace mounted), i.e. spec "Deep-link reload restores the session".
- `page.goto('/sessions/does-not-exist-xyz')` then asserts `#session-route-not-found`
  is visible, `#v3-session-grid` has count 0 (workspace never mounts for an unresolved
  id), and clicking its "Back to sessions" button navigates to `/` — spec "Unknown,
  deleted, and unauthorized ids are indistinguishable".

## 8.3 — login-gate project: anonymous deep link keeps its URL

File: `e2e/login-gate.spec.ts`, new test `anonymous deep link to /sessions/<id> renders
the login view without redirecting, and keeps the sign-in hrefs`, added inside the
existing `describe` block (own hermetic server: `REQUIRE_LOGIN=1`, dummy-configured
OAuth, port 8792).

- `page.goto('/sessions/deep-link-e2e-probe')` (an id that was never created — the gate
  mounts above the router and must never fetch session data, so which id is used is
  immaterial).
- Asserts `#login-wordmark` visible, `#v6-app` absent (login view renders, shell does
  not).
- Asserts `page` URL is still `/sessions/deep-link-e2e-probe` (no redirect to `/`) —
  spec "Anonymous deep link keeps its URL".
- Asserts `#login-btn-google` / `#login-btn-create-account` both keep
  `href="/auth/google/start"` at this URL — the contract phase 6's stash-write
  `onClick` silently depends on (per the phase-6 review recommendation cited in the
  task brief).
- Asserts only `/api/profile` was requested (no session-detail fetch while gated).
- Follows the file's existing `blockGoogleNavigation` convention; the anchors are never
  clicked.

## Gates

- `npm run typecheck` — green (server + web + companion + e2e).
- `npm test` — green: server 43 files / 252 tests, web 13 files / 123 tests, companion
  6 files / 20 tests.
- `npm run lint` — exit 0 (4 pre-existing warnings in `web/src/shared/utils/loadingVideo.ts`,
  unrelated to this task, not in `e2e/`).
- `npm run e2e` (chromium project — the project the script actually runs) — **4/4
  passed**, including both new/modified assertions:

  ```
  Running 4 tests using 1 worker

    ✓  1 [chromium] › e2e/smoke.spec.ts:3:1 › workspace shell renders with no page errors (221ms)
    ✓  2 [chromium] › e2e/smoke.spec.ts:13:1 › /admin/users renders (95ms)
    ✓  3 [chromium] › e2e/smoke.spec.ts:18:1 › create a session, log via UI, and see an out-of-band event live (WS) (566ms)
    ✓  4 [chromium] › e2e/smoke.spec.ts:82:1 › deep-linking: a fresh reload on /sessions/<id> restores the session; a garbage id renders not-found (610ms)

    4 passed (3.8s)
  ```

- `npx playwright test --project=login-gate` (this project is NOT part of `npm run e2e`
  — `package.json`'s `e2e` script hardcodes `--project=chromium`; the login-gate project
  has its own hermetic server on :8792 and must be invoked separately, same as before
  this task) — **4/4 passed**, including the new task-8.3 test:

  ```
  Running 4 tests using 1 worker

    ✓  1 [login-gate] › ... renders the login view instead of the app shell; sign-in/create-account hrefs; no authenticated traffic (766ms)
    ✓  2 [login-gate] › ... ?login_error=state_invalid shows the expired message (135ms)
    ✓  3 [login-gate] › ... an unrecognized login_error code shows the generic message (137ms)
    ✓  4 [login-gate] › ... anonymous deep link to /sessions/<id> renders the login view without redirecting, and keeps the sign-in hrefs (645ms)

    4 passed (4.0s)
  ```

- `companion` project — binary-gated (`existsSync(COMPANION_LAUNCHER)` in
  `playwright.config.ts`); the Companion headless binary is not installed on this
  machine, so `--project=companion` collects zero tests by config-time design. Not
  exercised (as before this task — unrelated to 8.1-8.3).

### Visual project (`e2e:visual`, `visual-desktop` + `visual-mobile`) — pre-existing, unrelated failures

`npm run e2e:visual` was run (not required by this task's gates — `npm run e2e` only
runs `chromium` — but run anyway to double-check the `visual.spec.ts` `#v3-session-grid`
assertions, since 8.1 calls those out specifically). Result: **17 failures, all
`toHaveScreenshot` pixel-diff mismatches** (typically 3 pixels / 0.01 ratio) across
`workspace stopped + seeded events`, `workspace play`, `rename-session-modal`, `feed
edit-mode`, `feed pending-delete`, `transcribe-feed tab`, `topics-feed tab`,
`hide-internal toggle` (both viewports) and `timeline seeked-paused` (mobile only). 27
passed, 4 skipped.

**Verified these are pre-existing and unrelated to this task's diff**: `git stash`ed
both `e2e/smoke.spec.ts` and `e2e/login-gate.spec.ts` (this task's only changes,
neither file `visual.spec.ts` touches) and re-ran `npm run e2e:visual` against the
unmodified branch tip (`aeedcec`) — **identical 17 failures**, same tests, same shape.
This is environment-level font/anti-aliasing jitter in this sandbox versus the
committed baseline-capture machine, not a "baseline legitimately changed" situation and
not caused by task 8.1-8.3. No `visual.spec.ts` assertion logic (including the
`#v3-session-grid` `not.toHaveClass(/hidden/)` checks inside `createSession`/
`seedStoppedSession`) failed — every failure is purely a `toHaveScreenshot` pixel diff.
No baselines were touched or regenerated. Changes were `git stash pop`ped back
afterward; working tree confirmed to contain only the two `e2e/` files.

## Commit

One commit, `e2e/` only:

```
test(e2e): URL-driven session assertions + deep-link smoke + anonymous deep-link gate
```
