# Tasks

The first commit on `supabase-5b-require-login` holds only `openspec/changes/require-login/`.
The PR targets `supabase-migration`, and the gates run with
`GITHUB_BASE_REF=supabase-migration`. The owner chose one PR with the `size-override` label.
Every `make stage-up` needs the owner's permission.

Logs: keep every test and gate run under the session scratchpad as `5b-<task>-<red|green>.log`,
and name the log in each `Evidence:` line. Each "test first" item is red before its change (record
the failure line) and green after.

**Dev is unavailable from task 2.2 until 6.2/6.3** (design Risks): the bind-mounted dev server
reloads and refuses to boot. That is expected. Don't change compose early to "fix" it.

## 1. Test harness signs in a narrowed default member (design D7, D12)

- [x] 1.1 Change `server/src/test/harness.ts` and `helpers.ts` as D7 describes:
  - a default `member` in the built-in studios and in each `seededSession()` studio; no
    auto-membership in `seedStudio`;
  - the wrapped `app` adds the default cookie only when there is no `cookie` header (any case),
    no `authorization` header, and the path is not under `/api/companion/`;
  - `anonApp` exported.
  Evidence: `cd server && npx vitest run` -> `5b-1.1-red.log`: `Tests  61 failed | 879 passed`
  (baseline `5b-baseline.log`: `940 passed`). Failing suites: `activeShow.race` (anonymous case),
  `apiToken` (2, REQUIRE_LOGIN=1 anonymous), `gate` (7: anonymous 401s, plus 413/422 cases on a
  `seedStudio` session the default member can't see), `shows-profile` (anonymous 404), `teams`
  (anonymous 401), `events.generate` (:807 anonymous list), `apiResponseFixtures` (4: anonymous
  profile captures, dev-anonymous busy holder, log-import on a non-member show), `ai` (4: the
  REQUIRE_LOGIN=1 anonymous case now gets 200 and leaks its MCP registration, cascading into 3
  `registrationCount` checks), `aiV2` (3 anonymous), `logImport` (9: anonymous dev-mode GET and
  shows seeded with `seedStudio`, which anonymous could see), `sessions.localAudioImport` (26: a
  file-local `seedStudio` chain anonymous could see -> `expected 404 to be 200`), `transcribe` (1:
  ghost holder visible only to anonymous), `auth` (1: the OAuth callback test's one-shot
  `kv.put` spy caught the default cookie's login session). Every failure is anonymous visibility
  or an anonymous caller. Harness choice: the default user is created on first use (wrapped
  `app` or `seededSession()`), so the admin users capture keeps no extra user (D7's stated
  invariant).
  Keep `REQUIRE_LOGIN: '0'` for now, so this step changes only who the caller is.
  Verify: the server suite runs. Record every failure: each must be a suite named in D7/D12 that
  encodes anonymous behavior. Nothing else may fail.
- [x] 1.2 Convert the suites D7 and D12 name:
  - auth, role and anonymous suites go to `anonApp` or explicit cookies (`gate`, `authz`,
    `apiToken`, `teams`, `admin`, `shows-profile` signed-out, `activeShow.race`);
  - Companion suites use the bearer;
  - `events.generate` sets user prefs;
  - the real-server suites (`upgradeDispatch`, `companion-ws`) send a cookie or the bearer.
  Evidence: `cd server && npx vitest run` -> `5b-1.2-green.log`: `Test Files  76 passed | 2
  skipped (78)`, `Tests  936 passed | 3 skipped (939)`. `anonApp`: `gate` (auth and
  encoded-path cases), `apiToken` (whole file; "token-only is inert under open login" deleted),
  `teams`, `admin`, `authz`, `auth` (OAuth suites), the `shows-profile` signed-out 404, the
  `ai`/`aiV2` "no credentials 401" cases and the signed-out profile captures. `activeShow.race`
  anonymous case deleted; `shows-profile` "(anonymous)" cases now run signed in;
  `events.generate` sets the default user's prefs. Companion suites (`companion`, `nulText`'s
  presence/state) send `COMPANION_BEARER`; `upgradeDispatch` and `companion-ws` open the session
  WS with the default cookie and post `/api/companion/command` with the bearer. Follow-ons on
  suites that seeded studios only anonymous could see: `seedMemberStudio()` (helpers) in
  `logImport`, the `apiResponseFixtures` busy ("a member sees the holder") and log-import cases;
  `sessions.localAudioImport` and `gate` caps use the shared `seededSession()`; `logImport`'s
  "anonymous GET still works in dev mode" and `aiV2`'s "anonymous write records created_by:
  null" deleted (anonymous-only); `transcribe` "missing catalog row" now uses a member's hidden
  session (a row-less holder has no studio, so only anonymous could view it).
  Note: `sessions.int` "concurrent same-clock creates" hit a `40001` 500 once under full-suite
  load in `5b-1.1-red.log` (signed-in path, after the adapter's 3 tries); it passed 3/3 alone and
  in this run.
  Verify: the server suite is green.

## 2. Login is always required (design D1, D2, D3, D13)

- [x] 2.1 Test first:
  - `bootGuard` unit cases:
    - `REQUIRE_LOGIN` set to `0`, `1` or empty gives a refusal that names `REQUIRE_LOGIN`;
    - blank or whitespace-only `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` or `PUBLIC_BASE_URL`
      each give a refusal that names the variable;
    - a full env gives `null`;
    - no message contains a value.
  - `compose-run.test.mjs`: a dev, stage or prod env missing `GOOGLE_CLIENT_SECRET`, or with a
    whitespace-only `GOOGLE_CLIENT_ID`, refuses. The existing fixtures gain the secret.
  - `gate.int.test.ts`:
    - the `app.routes` table: every `/api/*` route through `anonApp` with no credentials gives
      `401 {"detail":"Login required."}`, except the named exemptions;
    - `GET` and `HEAD /api/profile` give 200, with `auth.logged_in:false, oauth_configured:true`
      on GET;
    - `/api/admin/*` keeps its token rules;
    - `API_TOKEN` on `/api/companion/state` gives 200.
  - The raw-path repo test (D13).
  - `bootOrder.int.test.ts`: its env gains the Google values and `PUBLIC_BASE_URL`.
  Evidence: red `5b-2.1-red.log` (`vitest run bootGuard rawPath.repo gate bootOrder` + `node
  --test docker/scripts/compose-run.test.mjs`): `× refuses REQUIRE_LOGIN present with any value`,
  `× refuses a missing, blank or whitespace-only sign-in setting`, `× every registered /api route
  with no credentials is 401 Login required` (timed out serving anonymous requests), `× GET and
  HEAD /api/profile are exempt` (`expected false to be true`, oauth_configured); compose-run
  `Missing expected exception: dev` / `dev GOOGLE_CLIENT_ID`, and the dev-run case exited 0
  (`ℹ fail 3`). `rawPath.repo.test.ts` and `bootOrder` already passed (recorded). Green: see 2.2.
  Red before 2.2, green after (the repo test may already pass; record that).
- [x] 2.2 Implement D1 and D2:
  - the `checkBootEnv` refusals (trimmed);
  - `compose-run.mjs` `checkSignInClient` requires both Google values in every stack;
  - `authContext` checks login unconditionally;
  - the `apiRequestRequiresLogin` HEAD exemption;
  - delete `requireLoginEnabled`, `Config.REQUIRE_LOGIN` (`packages/ports`,
    `server/src/node/config.ts`) and the harness's temporary `REQUIRE_LOGIN`;
  - update `env.test.ts`, `node/config.test.ts` and `upgradeDispatch.test.ts`.
  Evidence: `5b-2.2-green.log`: the 2.1 files plus `env`, `node/config`, `upgradeDispatch`
  unit: `Test Files  7 passed (7)`, `Tests  84 passed (84)`; compose-run `ℹ pass 51`, `ℹ fail 0`.
  `npm run typecheck` exit 0 (`5b-2.2-typecheck.log`). Forced follow-ons (deleting
  `requireLoginEnabled`/`Config.REQUIRE_LOGIN`): the `main.ts` warning block goes now (it read
  `requireLoginEnabled`); `openNetworkRefused` is stubbed to `false` until 3.1; the open-network
  predicate tests that named `REQUIRE_LOGIN` in a `Config` literal (`env.test.ts` describe,
  `ai`/`aiV2` predicate cases) are deleted now for typecheck; `aiV2CredentialsRefused`'s
  predicate test keeps passing without the key. Harness: `GOOGLE_CLIENT_ID: 'test-client-id'`, no
  `REQUIRE_LOGIN`. Tests that encoded anonymous success: `shows-profile` anonymous show read is
  now 401; `staticServing` unmatched `/api` 404 case signs in; `aiV2` token-only "inert" cases
  compare through `anonApp` (both 401), and its two `REQUIRE_LOGIN=0` 503 cases are deleted;
  `fixtures/api-responses/profileAuthenticated.ts` `oauth_configured` is now `true` (every
  running server has OAuth configured, D6). Full suite `5b-2.2-suite.log` before those
  follow-ons: the only remaining failures afterwards are 3.1/3.2 targets (open-network 503 cases,
  `profileAnonymous` capture).
  Verify: 2.1 green, `npm run typecheck`, and `node --test docker/scripts/compose-run.test.mjs`.
- [x] 2.3 Implement D3:
  - `requireUser` moves to `_helpers.ts`; a null user is an internal error (500), not a 401;
  - `requireSession` uses it and always checks membership;
  - the D3 route list uses it (including `GET /api/studio`); `teams.ts` uses the shared helper;
  - `packages/log-import`: `createdByUserId: string`.
  Evidence: red `5b-2.3-red.log`: `× requireUser with a null user throws the internal error`,
  `× requireSession with a null user throws the internal error instead of skipping membership`
  (`TypeError: requireUser is not a function` / `instanceof assertion needs a constructor`); the
  non-member cases (`shows-profile` "404s for a logged-in non-member", the new `logImport` "GET
  job 404s for a signed-in non-member", `transcribe` 409/status redaction for a non-member)
  already passed (recorded). Implementation: `MissingPrincipalError` (plain `Error` -> the
  existing `onError` 500 `Internal Server Error` + redacted `unhandled error` log). Green:
  `npm run typecheck` exit 0 (`5b-2.3-typecheck.log`); `packages/log-import` `Tests  32 passed`;
  server `5b-2.3-green.log`: `Tests  10 failed | 933 passed`, and every failure is a 3.1/3.2
  deletion target: the six open-network 503 cases (`ai`, `aiV2`, `events.generate`,
  `logImport`, `sessions.youtubeImport`, `transcribe`), three `ai` `registrationCount` checks
  cascading from the `ai` open-network case's leaked turn, and the `profileAnonymous` capture
  (plus one unhandled rejection from the `logImport` open-network case's job outliving its
  test). The predicate is stubbed `false` since 2.2, so those cases can't pass until 3.1 deletes
  them. Follow-on: `jobStore.test.ts` "stores null for an anonymous creator" deleted, other cases
  pass `'user-1'`.
  Test first:
  - calling the helper directly, `requireSession` and `requireUser` with a null user throw the
    internal error, not an `ApiError(401)`;
  - a non-member gets 404 on `GET /api/shows/:id` and on the Sheets job status, and sees no
    holder in the topics-generate busy detail.
  Verify: the server suite and typecheck are green.

## 3. Anonymous state and open-network refusals removed (design D4, D5, D6, D12)

- [x] 3.1 Delete the open-network refusals:
  - `env.ts` predicate and exports (`loopbackHostname` stays);
  - the six routers' detail constants and checks;
  - the `main.ts` warning;
  - their tests in `ai`, `aiV2`, `transcribe`, `sessions.youtubeImport`, `events.generate`,
    `logImport` and `env.test.ts`.
  Evidence: the grep -> only `server/src/bootGuard.ts:36-37` and `server/src/bootGuard.test.ts`
  (57-78). `npm run typecheck` exit 0 (`5b-3.1-typecheck.log`). Server `5b-3.1-green.log`:
  `Tests  1 failed | 934 passed | 3 skipped (938)`; the one failure is the `profileAnonymous`
  capture that 3.2 deletes; the AI v2 credentials-refusal cases (`aiV2.int` "agent credentials
  refusal (503)", the per-route gate-set suite, the `aiV2CredentialsRefused` predicate) pass.
  `ai-runtime` `aiV2SdkSpawn.test.ts` `Tests  4 passed`. Deleted: `openNetworkRefused` and the
  four exports in `env.ts` (`loopbackHostname` kept), the six routers' `*_OPEN_NETWORK_DETAIL`
  constants and checks (events step comments renumbered), and the open-network cases in `ai`,
  `aiV2`, `transcribe`, `sessions.youtubeImport` (incl. the "unconfigured wins over open-network"
  precedence case), `events.generate` (ladder case 3), `logImport` (incl. its precedence case);
  the `main.ts` warning and the `env.test.ts` predicate cases went in 2.2. Follow-ons: every
  `REQUIRE_LOGIN` key/title left in test `envWith` literals is removed (`apiToken` loses
  `openLogin`), and `ai-runtime`'s guard-order comments and test label say
  `config/credentials 503`.
  Verify: `grep -rn "OpenNetwork\|open-network\|REQUIRE_LOGIN" server/src packages web/src` hits
  only the boot refusal and its tests, the AI v2 credentials-refusal tests still pass, and the
  suite is green.
- [x] 3.2 Remove the anonymous active team and show (D5):
  - the `sessions.ts` list branch;
  - the `profile.ts` `PUT` anonymous transaction;
  - `profileAssembler.getEffectiveStudioForUser(user: AuthUser)`;
  - `profilePayload(null)` always returns the signed-out shape.
  Evidence: red `5b-3.2-red.log`: catalog `× oauth_configured is taken from ctx (false)` (`Error:
  the global active studio must not be read for a signed-out caller`); the anonymous `PUT
  /api/profile` case (`shows-profile`, 401 + `app_settings` rows unchanged) already passed, since
  the middleware has 401'd it since 2.2 (recorded). Green: `npm run typecheck` exit 0
  (`5b-3.2-typecheck.log`); catalog `Tests  36 passed (36)` (`5b-3.2-catalog-green.log`); web
  `Test Files  107 passed (107)`, `Tests  1383 passed` (`5b-3.2-web-green.log`); server
  `5b-3.2-green-run3.log`: `Tests  935 passed | 3 skipped (938)`. Not clean every run:
  `sessions.int` "concurrent same-clock creates for the same show never duplicate a title"
  failed with a `40001` 500 in `5b-3.2-green.log` and `5b-3.2-green-run2.log` (and once in
  `5b-1.1-red.log`); it passes alone 6/6. It is the signed-in `POST /api/sessions` path (the
  harness now signs in) exhausting the adapter's 3 SERIALIZABLE tries under full-suite load:
  not anonymous behavior, and left for the owner. Also: `profileAuthenticated` /
  `profileLoggedOutOauth` stay; the conformance test's category and `shows[]` checks moved
  to `profileAuthenticated` (the signed-out capture has no categories or shows), and the
  signed-out shape stays checked by `profileLoggedOutOauth`.
  Delete `fixtures/api-responses/profileAnonymous.ts` and its capture entry, and point
  `web/src/api/types.conformance.test.ts` at `profileLoggedOutOauth`. Leave `auth.ts:234` and
  `sessionIndexStore.ts:372` alone (5c).
  Test first: the catalog unit test `profilePayload(null, ctx)` returns the signed-out shape with
  `oauth_configured` taken from `ctx`; an anonymous `PUT /api/profile` writes nothing (401 from
  the middleware; the settings rows are unchanged).
  Verify: the catalog, server and web suites are green.

## 4. Web (design D8)

- [x] 4.1 Test first: `RootGate` renders the login page for
  `auth: {logged_in:false, oauth_configured:false}`, which is the old dev scenario inverted;
  `TeamsRoute` has no anonymous-mode panel.
  Implement:
  - `RootGate.tsx` keys on `!logged_in`;
  - delete the `TeamsRoute.tsx` anonymous panel and its branch;
  - drop the stale comments in `AppShell.tsx`, `useLoginReturnConsume.ts` and `LoginPage.tsx`;
  - update `AppShell.onboarding.test.tsx` and `EventLogSheet.test.tsx`.
  Verify: the web `vitest run` and typecheck are green.
  Evidence: red (`5b-4.1-red.log`) -> `RootGate ... renders LoginPage when logged out even if
  oauth_configured is false` failed with `Unable to find an element by:
  [data-testid="login-page-sentinel"]`; `TeamsRoute ... renders no anonymous-mode panel` failed
  with `expected <div …(3)><h1 …(1)></h1>…(1)</div> to be null`; `Tests  2 failed | 15 passed`.
  Green (`5b-4.1-green.log`) -> `cd web && npx vitest run`: `Test Files 107 passed (107)`,
  `Tests 1383 passed (1383)`; `npm run typecheck -w web` exit 0; `npx biome check` on 12 files ->
  `No fixes applied`. Stale fixtures fixed in the same sweep (test-only): `eventGenerateLatch`,
  `BatchImportModal` and `useLoginReturnConsume` tests.

## 5. Compose, static checks and docs (design D9, D10)

- [x] 5.1 Remove `REQUIRE_LOGIN` from `compose.yaml` and `docker/compose.dev.yaml`. Update
  `check-envs.sh`: invariants 6 and 7 drop it (`TRUST_PROXY` stays pinned), and it leaves the
  `unset` list and `dev-custom.env`.
  Verify: `docker/scripts/check-envs.sh` and `docker/scripts/test_check_envs.sh` pass.
  Evidence: with the compose pins removed first, `docker/scripts/check-envs.sh` (`5b-5.1-red.log`)
  -> exit 1, `FAIL [invariant 6] dev: a posture pin (HOST/REQUIRE_LOGIN/...) is not a literal`,
  `FAIL [invariant 7] stage: api REQUIRE_LOGIN is not "1"`. After the check-envs edits
  (`5b-5.1-green.log`) -> `check-envs: ok (all)`, exit 0; `bash docker/scripts/test_check_envs.sh`
  (`5b-5.1-guards.log`) -> `test_check_envs: 47 passed, 0 failed`. The stage overlay's header
  comment is updated too.
- [x] 5.2 Docs:
  - README: the env table and the auth section, where `REQUIRE_LOGIN`, anonymous dev mode and
    the open-network refusals go;
  - the `server/.env.example` and `docker/.env*.example` files;
  - `docker/compose.stage.yaml` header comment;
  - `companion/src/config.ts` token label and `companion/companion/HELP.md`;
  - `server/scripts/bootstrapMemberships.example.ts`;
  - `docs/supabase.md` / `docs/infisical-secrets.md`: dev needs the Google client and
    `API_TOKEN`; without the token the dev Companion gets 401;
  - ADR 0021: the slice 5b entry, the owner decisions, and the cutover and rollback notes (design
    Risks).
  Verify: `grep -rn REQUIRE_LOGIN --exclude-dir=node_modules --exclude-dir=archive .` hits only:
  `docs/superpowers/` (historical plans), ADR text about the removal, and the boot guard and its
  tests.
  Evidence: `grep -rn REQUIRE_LOGIN --exclude-dir=node_modules --exclude-dir=archive
  --exclude-dir=.git .` -> `docs/superpowers/**` (historical); ADR 0021 lines on the removal;
  `server/src/bootGuard.ts:36-37` and `bootGuard.test.ts`; three more lines that state the
  refusal (`README.md:837`, `server/.env.example:12`, `docker/compose.stage.yaml:13`); the change's
  own artifacts; and the main specs this change's deltas rewrite at archive (checked again in 6.6).
  `grep -n "checkSignInClient" -A3 docker/scripts/compose-run.mjs` -> both Google values are
  required in every stack, as the docs now say. `npx biome check companion/src/config.ts` -> `No
  fixes applied`. The hook gates passed (`5b-5.2-hook.log`).

## 6. Verification

- [x] 6.1 Run `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --stage hook`; it is
  green except the size gate, which is over budget by the owner's choice (`size-override`).
  Evidence: `5b-6.1-hook.log` -> exit 0; every gate PASS (openspec, yaml, workflows, skills-sync,
  guide-size, change, risk-floor, evidence, `commands  ran ['typecheck', 'test']`); `WARN  size
  1022 changed lines > budget 400` (owner: one PR, `size-override`). Server suite after rebasing
  onto `catalog-retry-backoff`: 5 runs in a row, `Tests  935 passed | 3 skipped (938)` each
  (`5b-flake-{1..5}.log`).
- [x] 6.2 Owner step: create the dev Google OAuth client (redirect
  `http://localhost:8787/auth/google/callback`), put `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
  and `API_TOKEN` in Infisical `autologger-dev`, and set the token in the dev Companion module.
  Evidence: owner reported the client created and the values set (2026-10-02). `make dev-up`
  (`5b-6.3-devup.log`) -> exit 0, which `compose-run` refuses without both Google values;
  `docker exec autologger-dev-app printenv API_TOKEN` -> set; `GET /auth/google/start` -> `302
  https://accounts.google.com/...redirect_uri=http%3A%2F%2Flocalhost%3A8787%2Fauth%2Fgoogle%2Fcallback...`.
- [x] 6.3 Dev live check (`make dev-up`):
  - anonymous `GET /api/sessions` and `/%61pi/sessions` give 401;
  - `GET /api/profile` gives `logged_in:false, oauth_configured:true`;
  - the owner signs in with Google on `http://localhost:8787`;
  - `GET /api/companion/state` with the bearer gives 200; without `API_TOKEN` in dev, the
    Companion gets 401 (expected).
  Negative check: a compose-run with `GOOGLE_CLIENT_SECRET` withheld (scratch override) refuses.
  Running `bootGuardCli` in the app container with `REQUIRE_LOGIN=0` added prints the refusal.
  Evidence: `5b-6.3-probes.log` -> `GET /api/sessions -> 401`, `GET /%61pi/sessions -> 401`, `/api/studio`
  and `/api/shows` -> 401; `/api/profile` -> `{"logged_in":false,"user":null,"oauth_configured":true}`;
  `HEAD /api/profile -> 200`; `/api/companion/state` with the bearer -> 200, without it -> 401;
  `REQUIRE_LOGIN absent from app env`. The owner signed in with Google on `http://localhost:8787`
  (2026-10-02, "signed in fine"). `5b-6.3-negative.log` -> `bootGuardCli REQUIRE_LOGIN=0 exit 1`
  ("REQUIRE_LOGIN was removed"), blank `GOOGLE_CLIENT_SECRET` -> exit 1 ("sign-in settings missing
  or blank: GOOGLE_CLIENT_SECRET"), and `compose-run` `checkSignInClient('dev')` without the secret
  -> refused.
- [x] 6.4 Stage live check, with owner permission for `make stage-up`: the same probes, plus
  `docker/scripts/test_router.sh stage`.
  Evidence: `make stage-up` (`5b-6.4-stageup.log`) -> exit 0, all services healthy;
  `5b-6.4-probes.log` -> `GET /api/sessions -> 401`, `GET /%61pi/sessions -> 401`, `/api/studio` and
  `/api/shows` -> 401, `/api/profile` -> `{"logged_in":false,"user":null,"oauth_configured":true}`,
  `HEAD /api/profile -> 200`, companion state with the bearer -> 200, without it -> 401,
  `REQUIRE_LOGIN absent from stage api env`; `bash docker/scripts/test_router.sh stage`
  (`5b-6.4-router.log`) -> `test_router: 67 passed, 0 failed`. The owner signed in with Google on
  `http://localhost:8788` (2026-10-02, "it worked").
- [x] 6.5 Consistency read (tier 2) after any post-approval artifact edit.
  Evidence: `panel.md` "Consistency read 2026-10-02" -> scope change: no; every delta requirement
  has a task and a test; the deviations are recorded; `openspec validate require-login --strict` ->
  valid. It is repeated if 6.2-6.4 edit the artifacts.
- [x] 6.6 At archive (design D11), edit the Purpose paragraphs of `web-login-experience`,
  `ai-topics-chat` and `youtube-audio-import` in `openspec/specs/` to drop the removed modes.
  Verify: `grep -n -i "REQUIRE_LOGIN\|open-network\|anonymous mode" openspec/specs/*/spec.md`
  hits no Purpose paragraph.
  Evidence: the three Purpose paragraphs are edited (signed-out login view keyed on
  `auth.logged_in`; "open-network refusal" dropped from ai-topics-chat and youtube-audio-import);
  the grep's remaining hits are inside requirements that this change's deltas replace at archive,
  and none is in a Purpose paragraph.
