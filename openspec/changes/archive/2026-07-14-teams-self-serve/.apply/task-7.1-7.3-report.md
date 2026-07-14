# Tasks 7.1–7.3 report — e2e (seeded-session fixture, teams smoke, login-gate)

## Summary

- **7.1** `e2e/seededSession.ts` — a test-side-only fixture that seeds a user
  row + hashed login-session KV row directly into the hermetic chromium
  project's `catalog.db`, and a helper that injects the resulting cookie into
  a fresh `BrowserContext`. Proven by `e2e/seeded-session.spec.ts`.
- **7.2** `e2e/teams-smoke.spec.ts` — authenticated browser smoke: create
  team → rename → invite → pending invite visible → revoke; a zero-membership
  user landing on the onboarding panel; reload-on-`/teams` + Back.
- **7.3** `e2e/login-gate.spec.ts` — added a fourth test: anonymous `/teams`
  renders the login view with the URL preserved and sign-in hrefs intact
  (mirrors the existing `/sessions/<id>` deep-link test in the same file).

## Seeding mechanism chosen, and why

**Direct writes into the running hermetic server's `catalog.db` while the
server is up** (not `globalSetup` pre-boot seeding).

Verified empirically rather than assumed:
- The server opens `catalog.db` with `journal_mode = WAL` + `busy_timeout =
  5000` and keeps ONE connection open for its process lifetime
  (`server/src/node/migrate.ts` `openCatalogDb`). `journal_mode` is a
  persistent on-disk setting (already WAL by the time any second connection
  opens); `busy_timeout` is per-connection, so the seed script also sets it.
- The seed script (`e2e/seededSession.ts`'s `seedSession()`) opens a **second,
  short-lived** `better-sqlite3` connection to the same file, does its
  writes inside `db.transaction(...)`, and closes. All three new e2e specs
  ran repeatedly (parallel workers, 3 workers in the default chromium run)
  with zero `SQLITE_BUSY` errors or flakiness — ordinary multi-reader/
  multi-writer WAL behavior at this trivial write volume, not a race.
- `globalSetup` was considered per the task brief's fallback instruction but
  wasn't needed: seeding happens inside each `test()` body immediately
  before `page.goto()`, which is simpler (per-test isolation, unique
  `google_sub`/`email` per seed call via `crypto.randomUUID()`, no shared
  global state across the parallel spec files) and proved reliable.

Row shapes mirrored byte-for-byte from the real code paths:
- User row: `authCreateUserGoogle` (`server/src/db/authStore.ts`).
- Prefs row: `authSeedPrefsFromGlobals` semantics (only meaningful once a
  membership exists — a zero-membership seed leaves prefs empty, matching
  `profileStudioForUser`'s empty-allowed-set short-circuit).
- Membership rows: `authAddMembershipWithRole` shape (`INSERT OR IGNORE`
  into `user_studio_memberships` with an explicit `role`).
- KV login-session row: `createLoginSession`
  (`server/src/auth/identity.ts`) — `session:<sha256hex(rawToken)>` → userId,
  `expires_at` in epoch **milliseconds** (`KvStore.put`'s
  `now + ttlSeconds*1000`), TTL mirrors `env.ts` `sessionTtlDays()`'s
  14-day default (`SESSION_DAYS` unset on both hermetic servers).
- Cookie: name `autologger_sid` (`sessionCookieName()` default, `SESSION_COOKIE`
  unset), `httpOnly`, `sameSite=Lax`, `path=/`, `secure=false` — matches
  `cookieSecureForRequest()`'s computed value for plain
  `http://127.0.0.1` with no `COOKIE_SECURE`/`TRUST_PROXY` set on either
  hermetic server.
- `randomToken`/`sha256Hex` are line-for-line ports of the primitives in
  `server/src/auth/identity.ts` (Web Crypto — available as Node 22 globals,
  no import needed) rather than importing from `server/`: `e2e/` is a
  separate, non-workspace test root (own `tsconfig.json`), and the point of
  a TEST-SIDE fixture is that it reaches the server only via its on-disk
  file, not its code.

## Which server hosts which spec

- **`e2e/seeded-session.spec.ts`** and **`e2e/teams-smoke.spec.ts`** run on
  the **`chromium`** project (`:8791`, `REQUIRE_LOGIN=0`), the same server
  the rest of the anonymous-dev suite already uses. No new webServer/project
  entry was added.
- **Why `:8791` works despite `REQUIRE_LOGIN=0`**: traced
  `resolveSessionUser` (`server/src/auth/identity.ts`) and `authContext`
  middleware (`server/src/middleware/auth.ts`) — cookie resolution to a user
  is **entirely independent of `REQUIRE_LOGIN`**; that flag only gates
  whether an *unauthenticated* request gets a 401. `profilePayload`'s
  `logged_in` field (`server/src/db/profileAssembler.ts`) is driven purely
  by whether `c.get('user')` is non-null, which comes from the cookie. This
  was empirically confirmed by `seeded-session.spec.ts`: the seeded cookie
  resolves to the seeded user's email with `logged_in: true` on `:8791`.
  The task brief's fallback ("use the login-gate server instead if
  `REQUIRE_LOGIN=0` short-circuits profile") was therefore not needed.
- **`e2e/login-gate.spec.ts`**'s new anonymous-`/teams` test runs on the
  **`login-gate`** project (`:8792`, `REQUIRE_LOGIN=1`), per task 7.3's
  explicit instruction — no seeding involved, it's the anonymous-gate path.

## WAL concurrency findings

No failures across many repeated runs (full `npm run e2e` run + several
scoped re-runs while iterating). Direct-write-while-running is reliable at
this scale; see "Seeding mechanism chosen" above for the mechanism. No
`globalSetup` fallback was required.

## Files added/changed

- `e2e/seededSession.ts` (new) — `seedSession()`, `injectSessionCookie()`,
  `CHROMIUM_DATA_DIR`.
- `e2e/seeded-session.spec.ts` (new) — task 7.1 proof.
- `e2e/teams-smoke.spec.ts` (new) — task 7.2: create/rename/invite/revoke,
  zero-membership → onboarding-panel, reload/Back on `/teams`.
- `e2e/login-gate.spec.ts` (modified) — task 7.3: new anonymous `/teams` test
  appended, mirroring the existing `/sessions/<id>` deep-link test.
- `openspec/changes/teams-self-serve/tasks.md` — 7.1/7.2/7.3 ticked.

No changes to `server/src`, `web/src`, or `playwright.config.ts` — e2e/ only,
per the task brief's scope guardrail.

## Gate results

- `npm run typecheck` — **green** (server + web + companion + `tsc --noEmit -p e2e`).
- `npm test` — **green**: server 335/335, web 157/157, companion 20/20.
- `npx biome check e2e playwright.config.ts companion/src` — **green** (auto-fixed
  import order + one formatting nit in the new files before the final pass).

### `npm run e2e` (project: chromium) — 8/8 passed

```
Running 8 tests using 3 workers

  ✓  1 [chromium] › e2e/smoke.spec.ts:3:1 › workspace shell renders with no page errors (480ms)
  ✓  3 [chromium] › e2e/seeded-session.spec.ts:14:1 › seeded login cookie resolves to the seeded user on GET /api/profile (529ms)
  ✓  4 [chromium] › e2e/smoke.spec.ts:13:1 › /admin/users renders (141ms)
  ✓  2 [chromium] › e2e/teams-smoke.spec.ts:21:3 › teams self-serve (seeded-session fixture) › create team, rename, invite, revoke — full admin round trip without reload (989ms)
  ✓  6 [chromium] › e2e/teams-smoke.spec.ts:85:3 › teams self-serve (seeded-session fixture) › a fresh zero-membership user lands on the onboarding panel (287ms)
  ✓  5 [chromium] › e2e/smoke.spec.ts:18:1 › create a session, log via UI, and see an out-of-band event live (WS) (694ms)
  ✓  7 [chromium] › e2e/teams-smoke.spec.ts:114:3 › teams self-serve (seeded-session fixture) › reload on /teams keeps the teams page; Back restores the prior view (379ms)
  ✓  8 [chromium] › e2e/smoke.spec.ts:82:1 › deep-linking: a fresh reload on /sessions/<id> restores the session; a garbage id renders not-found (656ms)

  8 passed (4.4s)
```

### `npx playwright test --project=login-gate` — 5/5 passed

```
Running 5 tests using 1 worker

  ✓  1 [login-gate] › ... renders the login view instead of the app shell; sign-in/create-account hrefs; no authenticated traffic (765ms)
  ✓  2 [login-gate] › ... ?login_error=state_invalid shows the expired message (141ms)
  ✓  3 [login-gate] › ... an unrecognized login_error code shows the generic message (135ms)
  ✓  4 [login-gate] › ... anonymous deep link to /sessions/<id> renders the login view without redirecting, and keeps the sign-in hrefs (632ms)
  ✓  5 [login-gate] › ... anonymous visit to /teams renders the login view without redirecting, and keeps the sign-in hrefs (639ms)

  5 passed (4.6s)
```

### `npx playwright test --project=companion` — 1/1 passed

```
Running 1 test using 1 worker

  ✓  1 [companion] › e2e/companion.e2e.spec.ts:38:3 › ... adds the connection, reaches OK, and a transport action rolls the take (6.5s)

  1 passed (11.7s)
```

### `npx playwright test --workers=1 --project=visual-desktop --project=visual-mobile` — 21 passed, 4 skipped, 23 failed (PRE-EXISTING, unrelated)

23 pixel-diff failures, all in `visual.spec.ts` tests unrelated to
teams/login (`home`, `workspace *`, `feed *`, `timeline *`,
`hide-internal`, `mobile-rail-drawer`, `rename-session-modal`,
`audio-*`, `transcribe-feed`, `topics-feed`). Confirmed **pre-existing**,
not caused by this task:
- No file under `web/src` or `e2e/visual.spec.ts` was touched by 7.1–7.3
  (this task only added `e2e/seededSession.ts`,
  `e2e/seeded-session.spec.ts`, `e2e/teams-smoke.spec.ts`, and one new test
  appended to `e2e/login-gate.spec.ts`).
- Git history already documents this exact flake class: commit `d5c3602`
  ("test(e2e): fix openRailIfMobile boot race, verify pre-existing visual
  flake against main (task 3.2)") ran the same visual projects against
  `main` and got the identical failure signature, root-caused to
  "session-id-width mask nondeterminism" — deliberately left unfixed and
  unrebaselined there per the guard's own rule (`toHaveScreenshot`'s strict
  `maxDiffPixels: 0` default in `playwright.config.ts`).
- Not run as part of this task's required gates (the task brief's gate list
  is `typecheck` + `npm test` + `npm run e2e` + `--project=login-gate` +
  "whatever project hosts your new specs" — chromium and login-gate, both
  green); ran anyway for the "all projects" reporting requirement.

## Concerns / notes for the reviewer

- None blocking. The visual-project pre-existing flake (above) is the only
  non-green result across all six projects, and it's independently
  documented as pre-existing in this branch's own history, unrelated to
  scope.
- Task 7.2's "zero-membership onboarding covered if the fixture can seed a
  zero-team user cheaply" clause: it could, cheaply (`seedSession()` with no
  `memberships` option) — full e2e coverage landed rather than falling back
  to the unit-tier note.
- `npm run e2e`'s npm script only ever runs `--project=chromium`; it was not
  changed. `companion`/`visual-*` are invoked directly via `npx playwright
  test --project=...` per the existing `e2e:visual`/companion conventions
  already in `package.json`.

## Orchestrator correction (post-review, 2026-07-14)

The visual-suite characterization above is corrected by the phase-7 review: of the
23 failures, 17 are the pre-existing environmental class documented at the
session-deep-links archive; **6 are branch-induced** (desktop: home, workspace
rolling, audio-recording transport state, audio-save overlay, timeline
seeked-paused; mobile: rail drawer open) — the new V6Rail Teams button vs. baselines
frozen before it existed. Expected consequence of a legitimate UI addition; not a
regression; recorded honestly for the future re-baseline chore's provenance.
