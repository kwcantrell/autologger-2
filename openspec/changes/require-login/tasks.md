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

  Keep `REQUIRE_LOGIN: '0'` for now, so this step changes only who the caller is.
  Verify: the server suite runs. Record every failure: each must be a suite named in D7/D12 that
  encodes anonymous behavior. Nothing else may fail.
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
- [ ] 1.2 Convert the suites D7 and D12 name:
  - auth, role and anonymous suites go to `anonApp` or explicit cookies (`gate`, `authz`,
    `apiToken`, `teams`, `admin`, `shows-profile` signed-out, `activeShow.race`);
  - Companion suites use the bearer;
  - `events.generate` sets user prefs;
  - the real-server suites (`upgradeDispatch`, `companion-ws`) send a cookie or the bearer.

  Verify: the server suite is green.

## 2. Login is always required (design D1, D2, D3, D13)

- [ ] 2.1 Test first:
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

  Red before 2.2, green after (the repo test may already pass; record that).
- [ ] 2.2 Implement D1 and D2:
  - the `checkBootEnv` refusals (trimmed);
  - `compose-run.mjs` `checkSignInClient` requires both Google values in every stack;
  - `authContext` checks login unconditionally;
  - the `apiRequestRequiresLogin` HEAD exemption;
  - delete `requireLoginEnabled`, `Config.REQUIRE_LOGIN` (`packages/ports`,
    `server/src/node/config.ts`) and the harness's temporary `REQUIRE_LOGIN`;
  - update `env.test.ts`, `node/config.test.ts` and `upgradeDispatch.test.ts`.

  Verify: 2.1 green, `npm run typecheck`, and `node --test docker/scripts/compose-run.test.mjs`.
- [ ] 2.3 Implement D3:
  - `requireUser` moves to `_helpers.ts`; a null user is an internal error (500), not a 401;
  - `requireSession` uses it and always checks membership;
  - the D3 route list uses it (including `GET /api/studio`); `teams.ts` uses the shared helper;
  - `packages/log-import`: `createdByUserId: string`.

  Test first:
  - calling the helper directly, `requireSession` and `requireUser` with a null user throw the
    internal error, not an `ApiError(401)`;
  - a non-member gets 404 on `GET /api/shows/:id` and on the Sheets job status, and sees no
    holder in the topics-generate busy detail.

  Verify: the server suite and typecheck are green.

## 3. Anonymous state and open-network refusals removed (design D4, D5, D6, D12)

- [ ] 3.1 Delete the open-network refusals:
  - `env.ts` predicate and exports (`loopbackHostname` stays);
  - the six routers' detail constants and checks;
  - the `main.ts` warning;
  - their tests in `ai`, `aiV2`, `transcribe`, `sessions.youtubeImport`, `events.generate`,
    `logImport` and `env.test.ts`.

  Verify: `grep -rn "OpenNetwork\|open-network\|REQUIRE_LOGIN" server/src packages web/src` hits
  only the boot refusal and its tests, the AI v2 credentials-refusal tests still pass, and the
  suite is green.
- [ ] 3.2 Remove the anonymous active team and show (D5):
  - the `sessions.ts` list branch;
  - the `profile.ts` `PUT` anonymous transaction;
  - `profileAssembler.getEffectiveStudioForUser(user: AuthUser)`;
  - `profilePayload(null)` always returns the signed-out shape.

  Delete `fixtures/api-responses/profileAnonymous.ts` and its capture entry, and point
  `web/src/api/types.conformance.test.ts` at `profileLoggedOutOauth`. Leave `auth.ts:234` and
  `sessionIndexStore.ts:372` alone (5c).
  Test first: the catalog unit test `profilePayload(null, ctx)` returns the signed-out shape with
  `oauth_configured` taken from `ctx`; an anonymous `PUT /api/profile` writes nothing (401 from
  the middleware; the settings rows are unchanged).
  Verify: the catalog, server and web suites are green.

## 4. Web (design D8)

- [ ] 4.1 Test first: `RootGate` renders the login page for
  `auth: {logged_in:false, oauth_configured:false}`, which is the old dev scenario inverted;
  `TeamsRoute` has no anonymous-mode panel.
  Implement:
  - `RootGate.tsx` keys on `!logged_in`;
  - delete the `TeamsRoute.tsx` anonymous panel and its branch;
  - drop the stale comments in `AppShell.tsx`, `useLoginReturnConsume.ts` and `LoginPage.tsx`;
  - update `AppShell.onboarding.test.tsx` and `EventLogSheet.test.tsx`.

  Verify: the web `vitest run` and typecheck are green.

## 5. Compose, static checks and docs (design D9, D10)

- [ ] 5.1 Remove `REQUIRE_LOGIN` from `compose.yaml` and `docker/compose.dev.yaml`. Update
  `check-envs.sh`: invariants 6 and 7 drop it (`TRUST_PROXY` stays pinned), and it leaves the
  `unset` list and `dev-custom.env`.
  Verify: `docker/scripts/check-envs.sh` and `docker/scripts/test_check_envs.sh` pass.
- [ ] 5.2 Docs:
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

## 6. Verification

- [ ] 6.1 Run `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --stage hook`; it is
  green except the size gate, which is over budget by the owner's choice (`size-override`).
- [ ] 6.2 Owner step: create the dev Google OAuth client (redirect
  `http://localhost:8787/auth/google/callback`), put `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
  and `API_TOKEN` in Infisical `autologger-dev`, and set the token in the dev Companion module.
- [ ] 6.3 Dev live check (`make dev-up`):
  - anonymous `GET /api/sessions` and `/%61pi/sessions` give 401;
  - `GET /api/profile` gives `logged_in:false, oauth_configured:true`;
  - the owner signs in with Google on `http://localhost:8787`;
  - `GET /api/companion/state` with the bearer gives 200; without `API_TOKEN` in dev, the
    Companion gets 401 (expected).

  Negative check: a compose-run with `GOOGLE_CLIENT_SECRET` withheld (scratch override) refuses.
  Running `bootGuardCli` in the app container with `REQUIRE_LOGIN=0` added prints the refusal.
- [ ] 6.4 Stage live check, with owner permission for `make stage-up`: the same probes, plus
  `docker/scripts/test_router.sh stage`.
- [ ] 6.5 Consistency read (tier 2) after any post-approval artifact edit.
- [ ] 6.6 At archive (design D11), edit the Purpose paragraphs of `web-login-experience`,
  `ai-topics-chat` and `youtube-audio-import` in `openspec/specs/` to drop the removed modes.
  Verify: `grep -n -i "REQUIRE_LOGIN\|open-network\|anonymous mode" openspec/specs/*/spec.md`
  hits no Purpose paragraph.
