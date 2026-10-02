# Tasks

The first commit on `supabase-5c-owner-bootstrap` holds only `openspec/changes/owner-bootstrap/`.
The PR targets `supabase-migration`, and the gates run with
`GITHUB_BASE_REF=supabase-migration`. One PR, no size budget (ADR 0024). Every `make stage-up`
needs the owner's permission; the live dev and stage checks are in proposal.md "After merge".

Logs: keep every test and gate run under the session scratchpad as `5c-<task>-<red|green>.log`,
and name the log in each `Evidence:` line. Each "test first" item is red before its change (record
the failure line) and green after; if a new test already passes, record that.

Test commands: server tiers are `cd server && npx vitest run --project <unit|integration|pg>
<files>`; packages and web are `npx vitest run <files>` in their workspace; compose-run is
`node --test docker/scripts/compose-run.test.mjs`.

**Dev is unavailable from task 3.1 until the owner sets `BOOTSTRAP_OWNER_EMAIL` in Infisical dev**
(design Risks). Don't change compose to "fix" it.

## 1. Migration: the role check, one owner per team, the seed teams (design D1)

- [x] 1.1 Test first, in `server/src/test/pg/` (new `teamOwner.pg.test.ts`, plus
  `catalogSchema.pg.test.ts`):
  - a second `role = 'owner'` row for one team fails `23505`; a `role = 'superuser'` row fails
    `23514`; two owners in two different teams both insert;
  - `studio_definitions` holds `test-studios` ("Test Studio", sort 0) and `test-studio-2`
    ("Test Studio 2", sort 1), with no memberships, and each seed show's `studio_id` names one;
  - `app_settings` has no `active_studio_id` or `active_show_id` row after the migrations, also
    when the rows existed before the new migration ran (apply the earlier migrations, insert both
    rows, then apply `20261004000000`);
  - the schema record captures check constraints (`contype = 'c'`) and expects the new check and
    `idx_user_studio_memberships_one_owner`.
  Verify: red before 1.2, green after (`--project pg`).
  Evidence: `cd server && npx vitest run --project pg src/test/pg/teamOwner.pg.test.ts
  src/test/pg/catalogSchema.pg.test.ts` before 1.2 (`5c-1.1-red.log`) -> `Tests  5 failed | 14
  passed (19)`: the schema record lacks `$checks` and `idx_user_studio_memberships_one_owner`,
  `studio_definitions` is `[]`, and `ENOENT ... 20261004000000_team_owner.sql`. After 1.2 green
  (see 1.2).
- [x] 1.2 Write `supabase/migrations/20261004000000_team_owner.sql` as design D1 gives it (no
  transaction-control lines). Verify: 1.1 green, and the whole `pg` project green.
  Evidence: `cd server && npx vitest run --project pg` (`5c-1.2-green.log`) -> `Test Files  6
  passed (6)`, `Tests  27 passed (27)`; the recorded check is `user_studio_memberships_role_check
  CHECK ((role = ANY (ARRAY['owner'::text, ...])))`.

## 2. Built-ins become data; the global defaults go (design D9, D10)

- [x] 2.1 Test first:
  - catalog (`server/src/test/catalog.int.test.ts`, `authStore.int.test.ts`):
    - a fresh catalog's registry lists `test-studios`, `test-studio-2` first and in order, then
      created teams;
    - creating `test-studios` through either plane gets `A team with that id already exists.`;
    - deleting a former built-in (either plane) is refused only for its shows (`400`), and
      `renameStudio` on it succeeds;
    - `getStudioSettingsBlob('nope')` returns the default and persists nothing;
    - a user whose only membership names an unknown team gets a `null` profile studio;
  - `packages/catalog` unit test for `studioProfileForSession`: a session whose show's team is
    unknown gets id `''`, name `''` and the show's categories; with no show, the default
    categories; never a `500`;
  - `auth.int.test.ts`: with `active_studio_id`/`active_show_id` set in `app_settings`, a new
    user's `user_prefs` row is absent or empty after sign-in (not seeded);
  - `admin.int.test.ts`: `studios_catalog` reports `builtin: false` for both former built-ins;
  - `teams.int.test.ts`: the built-in `400` cases become "former built-ins are ordinary teams"
    (a member of `test-studios` gets `200` on `GET /api/teams/test-studios`; a non-member gets
    the masked `404`).
  Verify: red before 2.2.
  Evidence: red before 2.2: `cd server && npx vitest run --project integration
  src/test/catalog.int.test.ts src/test/authStore.int.test.ts src/routers/auth.int.test.ts
  src/routers/admin.int.test.ts src/routers/teams.int.test.ts` (`5c-2.1-red.log`) -> `Tests  10
  failed | 119 passed (129)` (e.g. `creating test-studios through either plane`, `studios_catalog
  reports builtin: false`, `a new user is not seeded from the global active team and show`); `cd
  packages/catalog && npx vitest run src/sessionIndexStore.test.ts` -> `3 failed | 4 passed (7)`;
  `cd packages/domain && npx vitest run src/studio.test.ts` -> `2 failed | 24 passed (26)`
  (`5c-2.1-red-catalog.log`, `5c-2.1-red-domain.log`). Green after 2.2 (`5c-2.1-green.log`): `Test
  Files  5 passed (5)`, `Tests  129 passed (129)`.
- [x] 2.2 Implement D9 and D10:
  - `packages/domain/src/studio.ts`: delete `BUILTIN_STUDIO_ORDER`, `BUILTIN_STUDIO_NAMES`,
    `DEFAULT_STUDIO_ID`, `LEGACY_STUDIO_MAP`, `SETTING_ACTIVE_STUDIO`, `SETTING_ACTIVE_SHOW` and
    the `test-studio-2` category branch (update `studio.test.ts`);
  - `packages/catalog/src/studioRegistry.ts`: definitions-only registry, no reserved-id check,
    `studioExists` is the query, no delete/rename refusals, `resolveActiveStudio` deleted, no
    `DEFAULT_STUDIO_ID` remap;
  - `profileAssembler.ts` (null when no known team), `sessionIndexStore.ts` (team-less profile);
  - `authStore.ts`: delete `authSeedPrefsFromGlobals` (facade and class);
  - `server/src/routers/auth.ts`: delete the prefs seed and its imports;
  - `server/src/routers/shows.ts:70`: `defaultSettingsBlob('')`;
  - `server/src/routers/teams.ts`: delete `requireNotBuiltin`; the creation cap keeps working on
    `authCountAdminTeams(userId, [])` until 4.2;
  - `server/src/routers/admin.ts`: `builtin: false`;
  - `server/src/test/harness.ts`: the default member's teams are the literal
    `['test-studios', 'test-studio-2']`.
  Verify: 2.1 green; `npm run typecheck` exit 0; the catalog, domain and server suites green;
  `grep -rn "BUILTIN_STUDIO\|DEFAULT_STUDIO_ID\|LEGACY_STUDIO_MAP\|SETTING_ACTIVE_\|resolveActiveStudio\|authSeedPrefsFromGlobals" packages server/src web/src --include=*.ts --include=*.tsx`
  has no hit outside web (web's `BUILTIN_TEAM_IDS` goes in 8.2).
  Evidence: `npm run typecheck` -> exit 0 (`5c-2.2-typecheck.log`). `cd packages/domain && npx
  vitest run` -> `Tests  50 passed (50)`; `cd packages/catalog && npx vitest run` -> `Tests  39
  passed (39)`; `cd server && npx vitest run --project unit` -> `Tests  274 passed | 3 skipped
  (277)` (`5c-2.2-unit.log`); `--project integration` -> `Tests  1 failed | 648 passed (649)`
  (`5c-2.2-int.log`): the one failure is `apiResponseFixtures.int.test.ts > GET /api/admin/users`,
  whose diff is only `"builtin": true` -> `false` for the two former built-ins, the capture task
  6.1 recaptures. The grep (`5c-2.2-grep.log`) hits only
  `web/src/pages/index/components/OnboardingPanel.tsx:18` and `TeamsRoute.tsx:26` (web, 8.2).

## 3. `BOOTSTRAP_OWNER_EMAIL` is required (design D8)

- [x] 3.1 Test first, then implement:
  - `server/src/bootGuard.test.ts`: `BOOTSTRAP_OWNER_EMAIL` unset, empty or only spaces gives a
    refusal naming it and no value; a full env gives `null`;
  - `bootGuard.test.ts`: a non-ASCII `BOOTSTRAP_OWNER_EMAIL` (`Kalen@gmail.com`) refuses,
    naming the variable and no value;
  - `server/src/env.test.ts` (design D16, D8): `bootstrapOwnerEmail` trims and ASCII-lowercases;
    `bootstrapEmailMatch('Kalen@gmail.com', 'kalen@gmail.com')` is `'non-ascii'` (no match)
    and `bootstrapEmailMatch(' Kalen@Gmail.com', 'kalen@gmail.com')` is `true`;
    `maskBootstrapOwnerEmail('Owner@Example.com')` contains `example.com` and an 8-hex hash and
    not `owner`;
  - `docker/scripts/compose-run.test.mjs`: dev, stage and prod each refuse a missing or
    whitespace-only `BOOTSTRAP_OWNER_EMAIL` (fixtures gain the key);
  - `server/src/bootOrder.int.test.ts`: the spawned env gains the key,
    so "unreachable catalog" still reaches the catalog wait.
  Then: `Config.BOOTSTRAP_OWNER_EMAIL` (`packages/ports/src/config.ts`), `server/src/node/config.ts`,
  `env.ts` `bootstrapOwnerEmail` / `bootstrapEmailMatch` / `maskBootstrapOwnerEmail`, the
  `checkBootEnv` blank and non-ASCII refusals, the masked boot log line in `server/src/main.ts`, `checkSignInClient`'s third key, the
  `docker/secrets-env.yaml` passthrough, and the harness base config
  `BOOTSTRAP_OWNER_EMAIL: 'bootstrap-owner@example.com'`; update `node/config.test.ts`.
  Verify: the named tests red then green; `npm run typecheck` exit 0;
  `docker/scripts/check-envs.sh` and `bash docker/scripts/test_check_envs.sh` pass.
  Evidence: red: `cd server && npx vitest run --project unit src/bootGuard.test.ts src/env.test.ts
  src/node/config.test.ts` (`5c-3.1-red.log`) -> `Tests  6 failed | 41 passed (47)` (`refuses a
  missing, empty or whitespace-only BOOTSTRAP_OWNER_EMAIL`, `refuses a non-ASCII
  BOOTSTRAP_OWNER_EMAIL`, the three env helpers, the config passthrough); `node --test
  docker/scripts/compose-run.test.mjs` (`5c-3.1-red-compose.log`) -> `✖ every stack refuses a
  missing or empty GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET or BOOTSTRAP_OWNER_EMAIL`, `✖ a dev run
  without BOOTSTRAP_OWNER_EMAIL in Infisical refuses before docker runs` (the key was not yet
  allowed; the run hung after its failures and was stopped). `bootOrder.int.test.ts` without the
  new key (`5c-3.1-bootorder-red.log`) -> `expected 'autologger: BOOTSTRAP_OWNER_EMAIL is …' to
  match /catalog not ready/`. green: `--project unit` -> `Tests  280 passed | 3 skipped (283)`
  (`5c-3.1-green.log`); `timeout 280 node --test docker/scripts/compose-run.test.mjs` -> `ℹ tests
  52`, `ℹ pass 52` (`5c-3.1-green-compose.log`); `npx vitest run --project integration
  src/bootOrder.int.test.ts` -> `Tests  4 passed (4)`; `npm run typecheck` -> exit 0
  (`5c-3.1-typecheck.log`); `docker/scripts/check-envs.sh` -> `check-envs: ok (all)`; `bash
  docker/scripts/test_check_envs.sh` -> `47 passed, 0 failed`.
- [ ] 3.2 Docs for the key: `docs/infisical-secrets.md` (required in every stack, what it does,
  that a blank value refuses boot and `make <env>-up`), the README env table, `server/.env.example`
  and `docker/.env.example`, `docker/.env.dev.example`, `docker/.env.stage.example`. Verify:
  `grep -rn BOOTSTRAP_OWNER_EMAIL README.md docs/infisical-secrets.md server/.env.example docker/`
  hits each, and the hook gates pass.

## 4. Owner role in the catalog stores (design D1, D4, D5, D7, D11)

- [ ] 4.1 Test first, in `server/src/test/authStore.int.test.ts`:
  - `authCountOwnedTeams` counts `owner` rows only;
  - `authTransferOwnership` swaps owner and admin in one transaction, and throws (changing
    nothing) when the target has no membership or the source is not the owner;
  - `authSetOwner` demotes the current owner to `admin` and makes the target owner; for the
    current owner it is a no-op;
  - `authClaimOwnerlessStudios` creates or upgrades the claimant to `owner` in every team with
    no owner, leaves owned teams and other members' roles alone, and returns the claimed team
    ids;
  - `authListTeamMembers` orders owner, admin, member;
  - `authCountEnabledAdmins` still counts enabled `admin` rows only (the owner is not counted;
    owner decision B).
  Verify: red before 4.2.
- [ ] 4.2 Implement in `packages/catalog/src/authStore.ts` (`TeamRole` gains `owner`; facade
  and class): the methods above, replacing `authCountAdminTeams`; the `CASE` order;
  `authCountEnabledAdmins` unchanged. Switch the `teams.ts` cap call to `authCountOwnedTeams`. Verify: 4.1 green;
  `npm run typecheck` exit 0.

## 5. Team routes: owner rules and transfer (design D2, D3, D4, D5, D13)

- [ ] 5.1 Test first, in `server/src/routers/teams.int.test.ts`:
  - create returns `role: "owner"` and the profile shows `owner`;
  - an admin gets `403` on a role change, on delete, on transfer, and on removing another admin;
    an admin removes a `member` (`200`);
  - the owner leaving, being removed (by an admin or themselves) or having their role changed
    gets `409 Transfer ownership first.`;
  - a role-change body `{role: "owner"}` gets `400`;
  - transfer: `200 {ok: true}`, the target is owner and the caller admin; to a non-member `404
    Member not found`; to a disabled member `400`; to self `200` with no change; a bad body `400`;
  - after transfer the old owner can leave;
  - the cap: owning 20 teams refuses the 21st; owning 19 and admining 5 more allows it;
  - the team detail lists the owner first; the owner's `GET /api/teams/:id` carries `invites`;
    a brand-new team reports `enabled_admin_count: 0` (owner decision B);
  - the owner promotes member M, demotes M, then removes M, each `200`, with the members list
    reflecting each step;
  - former built-ins: after the bootstrap owner owns `test-studios` (claimed through
    `authClaimOwnerlessStudios`), the owner renames it (`200`), and a non-member gets the masked
    `404` on every `/api/teams/test-studios/*` operation.
  Delete the last-admin `409` cases they replace. Verify: red before 5.2.
- [ ] 5.2 Implement: `packages/contract/src/schemas.ts` `teamOwnerTransferBodySchema` (role-change
  schema unchanged); in `teams.ts`, `requireTeamRole` / `requireTeamRoleIn`, the D2 target rules,
  creation as `owner`, the transfer route, the `invites` gate in `GET /api/teams/:id`
  (`teams.ts:190`) widened to admin or owner, and the deletion of `wouldStripLastEnabledAdmin`,
  `guardedAgainstLastAdmin` and `LAST_ADMIN_MESSAGE`; update the file header comment. Verify: 5.1
  green, `teams.int` and `authz.int` green, typecheck exit 0.
- [ ] 5.3 Test first, in `server/src/routers/teams.race.int.test.ts` (replacing the last-admin
  races): two concurrent transfers to different members; a transfer racing the target's leave;
  the owner's demotion of admin B racing B's rename; each run asserts exactly one owner at the
  end. Fix anything they expose in 5.2's code. Verify: green 5 runs in a row
  (`5c-5.3-race-{1..5}.log`).
- [ ] 5.4 Recapture the fixtures in `server/src/routers/apiResponseFixtures.int.test.ts`:
  `teamCreate`, `teamDetailAdmin`, `teamDetailMember`, `teamRoleChange`, `profileAuthenticated`,
  and new `teamOwnerTransfer` and `teamDetailOwner` captures (seed the caller as owner, not
  through `seedTeam()`, which adds an admin); check them in `web/src/api/types.conformance.test.ts` and
  `web/src/apiResponseShapes.repo.test.ts`. Update the README endpoint table (`README.md:814-815`)
  with `POST …/owner`. Verify: the capture test and both web tests green; `git diff --stat
  fixtures/` names only those captures.

## 6. Support plane: owner upsert (design D6)

- [ ] 6.1 Test first, in `server/src/routers/admin.int.test.ts`: a membership POST with
  `role: "owner"` makes the target owner and the old owner `admin` (exactly one owner); for the
  current owner it changes nothing; a body without `role` for the current owner gets `409
  Explicit role required to change the team owner.` and changes nothing, while an explicit
  `role: "admin"` for the owner succeeds and leaves the team ownerless (owner decision C); a
  legacy body still creates a `member`; `GET /api/admin/users` `builtin` is `false` everywhere,
  and so is the `studio` object of `POST /api/admin/studios`; `fixtures/api-responses/adminUsers.json` recaptured. Then
  implement: `adminMembershipBodySchema` role enum gains `owner`; `admin.ts` calls
  `authSetOwner` for `owner` and refuses the role-less owner demotion inside the transaction; `server/scripts/bootstrapMemberships.example.ts` accepts `owner`
  (its header and validation). Verify: red then green; `bootstrapMemberships.int.test.ts` green.

## 7. Bootstrap claim at sign-in (design D7)

- [ ] 7.1 Test first, in `server/src/routers/auth.int.test.ts` (fake identity, bootstrap email
  `bootstrap-owner@example.com`):
  - the first sign-in claims `test-studios` and `test-studio-2`; `GET /api/teams/test-studios`
    shows `role: "owner"`; the log has one `bootstrap owner claimed team <id>` line per claimed
    team, naming exactly those ids;
  - a team another user created with themselves as admin and no owner (the stage case) is
    claimed and logged, and that user stays `admin`;
  - a Google email `Kalen@…` against a configured `kalen@…` claims nothing, still signs in,
    and logs the non-ASCII refusal;
  - a repeat sign-in claims a team created meanwhile through the admin plane;
  - `Bootstrap-Owner@Example.com ` as the Google email matches;
  - a team that already has an owner keeps it, and its admins stay admins;
  - a non-matching email claims nothing;
  - an unverified email is refused before the claim (`email_unverified`), and a disabled
    bootstrap account claims nothing (`account_disabled`);
  - a failing claim (a stub catalog that throws on the claim) still gives `302 /` with a cookie,
    and the log line has no email.
  Verify: red before 7.2.
- [ ] 7.2 Implement the claim in `server/src/routers/auth.ts` after both branches and before
  `createLoginSession`, through `bootstrapEmailMatch`, logging each claimed id. Verify: 7.1 green; `auth.int`, `teams.int` and `admin.int` green.
- [ ] 7.3 ADR 0021: replace the 5c line with the slice entry: the owner decisions (owner,
  2026-10-02) as recorded in proposal.md, the post-panel decisions A-D, the "at most one in the database" refinement
  (design OQ4), and the cutover note (prod's Infisical needs
  `BOOTSTRAP_OWNER_EMAIL` before the first deploy of this image). Verify: the hook gates pass.

## 8. Web (design D12)

- [ ] 8.1 Test first: `TeamCard` tests (owner view: role toggles, transfer, delete, no leave;
  admin view: rename, invites, remove on member rows only, no role toggles, no delete, leave;
  member view unchanged; no-owner notice for a member and above the admin panel for an admin);
  `useTeams.test.tsx`: `useTransferOwnership` posts `{user_id}` and invalidates the detail and
  profile. Verify: red before 8.2.
- [ ] 8.2 Implement: `web/src/api/types.ts` (`TeamRole`, transfer body and response),
  `web/src/api/hooks/useTeams.ts`, `TeamCard.tsx`, `TeamsRoute.tsx` (delete `BUILTIN_TEAM_IDS` and
  `BuiltinTeamRow`; update `TeamsRoute.test.tsx`), `OnboardingPanel.tsx` copy ("you'll be its
  owner"). Verify: `cd web && npx vitest run` green, `npm run typecheck -w web` exit 0,
  `npx biome check` on the changed files clean.

## 9. Verification

- [ ] 9.1 Run `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --stage hook`. Verify:
  exit 0, every gate PASS (`5c-9.1-hook.log`).
- [ ] 9.2 Run the server `integration` and `pg` projects 5 times in a row (`5c-flake-{1..5}.log`).
  Verify: every run green; any flake is named with its test and reported to the owner.
- [ ] 9.3 Consistency read (tier 2) after any post-approval artifact edit, logged in `panel.md`.
  Verify: `openspec validate owner-bootstrap --strict` -> valid.
- [ ] 9.4 At archive (design D14), edit the Purpose paragraph of
  `openspec/specs/team-management/spec.md`: roles are owner, admin and member; the owner anchors
  the team; no built-in teams; no last-admin invariant. Verify: `grep -n -i "built-in\|last-admin"
  openspec/specs/team-management/spec.md` hits no Purpose line.
