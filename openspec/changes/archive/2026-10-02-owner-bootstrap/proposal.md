# Teams get an owner; the bootstrap owner; built-in studios become real teams

Tier: 2
Tier reason: authorization (a new role and who may change roles, delete and transfer), sign-in
(the bootstrap claim runs in the OAuth callback), a catalog migration (a check constraint, a
partial unique index, seed rows and a settings delete), a boot-time refusal, and changes to the
frozen HTTP contract; touches `server/src/routers/**`, `packages/contract/**` and
`supabase/migrations/**`.

Approved-by: Kalen 2026-10-02

## Why

ADR 0021 slice 5 removes anonymous mode. 5a made Supabase Auth (GoTrue) the identity of record
and 5b made login always required. Three pieces of the ADR's auth and permission model are still
missing, and slice 6 (RLS) needs all of them:
- **Roles are `owner`, `admin` and `member`.** Today there are only `admin` and `member`, and a
  "last enabled admin" rule stands in for an owner.
- **A bootstrap step makes the owner the owner of every studio.** Today nobody owns anything,
  and the two built-in studios are managed only through the support plane.
- **The built-in studios go.** `test-studios` and `test-studio-2` are hardcoded in
  `packages/domain`, merged into the registry, and excluded from the whole `/api/teams` surface.

5b also left two readers of global defaults (design D5 of `require-login`): first sign-in seeds a
new user's prefs from the global active team and show (`server/src/routers/auth.ts:234`), and the
session index falls back to the global active studio (`packages/catalog/src/sessionIndexStore.ts:372`).
Both depend on the built-in default studio, so they go with it.

## Owner decisions (owner, 2026-10-02)

These are the human owner's binding decisions for this slice:
1. **One change.**
2. **Built-ins become real teams.** A migration inserts `studio_definitions` rows with the same
   ids and names, so their shows, sessions and settings survive. They start with no owner, and
   the bootstrap owner claims them.
3. **The owner anchors the team.**
   - The owner can't leave, be removed or be demoted; they must transfer ownership first.
   - Only the owner promotes or demotes admins, and only the owner deletes the team.
   - Admins keep rename, invites and removing members (not admins).
   - Last-admin protection is retired: the owner invariant replaces it.
4. **Transfer.** `POST /api/teams/:id/owner {user_id}` hands ownership to an existing member, and
   the old owner becomes admin, in one transaction. The `/api/admin` membership upsert also
   accepts `role: 'owner'`, demoting the current owner to admin in the same transaction, so
   support can rescue a team whose owner is disabled.
5. **`BOOTSTRAP_OWNER_EMAIL` is required in every stack.** Boot and `compose-run` refuse when it
   is blank.
6. **The bootstrap owner claims every ownerless team.** At each sign-in, the bootstrap email
   becomes owner of every team with no owner. Existing admins stay admins. No migration promotes
   anyone.

After the adversarial panel (owner, 2026-10-02):

A. **Takeover accepted.** On dev and stage the bootstrap owner's first sign-in claims every
   ownerless team, including teams other users created after 5a (stage today: `my-crew2` and
   `my-studio` with one admin each, and the empty `my-crew`). The claim logs each claimed team
   id.
B. **`enabled_admin_count` keeps its meaning:** enabled members with role `admin` only. The owner
   is not counted, so a new team reports `0`. The web no longer reads it.
C. **A role-less support upsert never demotes the owner.** `POST
   /api/admin/users/:userId/memberships` without `role`, when it would change the current owner's
   role, gets `409 Explicit role required to change the team owner.`. An explicit
   `admin`/`member`, or a membership delete, still works and leaves the team ownerless until the
   bootstrap claim.
D. **Transfer details:** `200 {ok: true}`; a disabled target gets `400`; a non-member target gets
   `404`; a self-transfer is `200` with no change.

## What Changes

- **Database (migration `supabase/migrations/20261004000000_team_owner.sql`):**
  - `user_studio_memberships.role` gets `check (role in ('owner','admin','member'))`;
  - a partial unique index on `(studio_id) where role = 'owner'`: at most one owner per team, in
    the database. "Exactly one" is kept by the application (design D1);
  - `studio_definitions` rows for `test-studios` ("Test Studio") and `test-studio-2`
    ("Test Studio 2"), so the seed shows belong to defined teams;
  - the global `app_settings` rows `active_studio_id` and `active_show_id` are deleted.
- **BREAKING (contract): the `owner` role.**
  - The creator of a team becomes its `owner` (`POST /api/teams` returns `role: "owner"`).
  - `role` values in responses are `owner`, `admin` or `member`: team detail, its members list,
    and the profile's `auth.user.teams[].role`. The role-change body stays `admin|member`.
  - Only the owner changes roles and deletes the team (an admin now gets `403`). Removing an
    admin is owner-only. The owner can't leave, be removed or be demoted (`409`).
  - New route `POST /api/teams/:id/owner {user_id}` (owner only): the target becomes owner and
    the old owner becomes admin, in one transaction.
  - The support plane's membership upsert accepts `role: "owner"` and demotes the current owner
    to admin in the same transaction. A role-less upsert that would demote the owner gets `409`.
  - The owner also sees pending invites in the team detail.
  - The 409 rules move from "last enabled admin" to "the owner". Last-admin protection is
    removed.
  - The creation cap counts teams the user owns.
- **The bootstrap owner (owner).** `BOOTSTRAP_OWNER_EMAIL` names one email. At every successful
  sign-in whose verified Google email normalizes to it, that user becomes owner of every team
  that has no owner, whoever created it. The match is exact ASCII (trim, ASCII lowercase); an
  email with any non-ASCII character never matches. Each claimed team id is logged. A failed
  claim is logged and the sign-in still succeeds.
- **Boot and compose refuse a blank `BOOTSTRAP_OWNER_EMAIL` (owner)** in every stack, the same
  way they refuse a blank Google client; boot also refuses a non-ASCII value, and logs a masked
  form (domain plus a short hash) so the operator can check it. `docker/secrets-env.yaml` passes
  it through.
- **BREAKING (contract): built-in teams are gone.** `test-studios` and `test-studio-2` are
  ordinary teams: the `/api/teams/:id` routes no longer reject them with `400`, and creating a
  team with either id gets the existing "already exists" `400`. `builtin` stays in the admin
  plane's frozen shapes, always `false`.
- **Global defaults removed.**
  - A new user's prefs are no longer seeded from the global active team and show; they start
    empty, so their first team (or onboarding) applies.
  - A session whose show's team is unknown gets a team-less profile (the show's categories, an
    empty id and name) instead of the global active studio's.
  - `DEFAULT_STUDIO_ID`, `BUILTIN_STUDIO_ORDER`, `BUILTIN_STUDIO_NAMES`, `LEGACY_STUDIO_MAP`,
    `SETTING_ACTIVE_STUDIO`, `SETTING_ACTIVE_SHOW` and `resolveActiveStudio` are deleted.
- **Web.**
  - `/teams` has three views: owner (everything, including role toggles, delete and "Transfer
    ownership"), admin (rename, invites, remove member) and member (read-only plus leave; leave
    is hidden for the owner).
  - The orphaned-team notice keys on "the team has no owner".
  - The built-in row is removed. Onboarding copy says "you'll be its owner".
- **Docs:** the README endpoint table (the transfer route), the env docs, ADR 0021 (the 5c entry
  and these owner decisions), and `docs/infisical-secrets.md` (the new required key).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `team-management`:
  - roles become owner, admin and member (REMOVED "Membership roles", ADDED "Team roles: owner,
    admin and member");
  - the creator becomes owner and the cap counts owned teams (REMOVED "Self-serve team
    creation", ADDED "Self-serve team creation makes the creator owner");
  - owner-anchored lifecycle and transfer replace last-admin protection (REMOVED "Team lifecycle
    and last-admin protection", ADDED "Owner-anchored team lifecycle");
  - concurrency rules lose the built-in exclusions and gain transfer (REMOVED "Concurrent team
    writes", ADDED "Concurrent team and ownership writes");
  - MODIFIED: "Email invites", "NEW_USER_ALL_TEAMS deprecated", "Zero-membership onboarding",
    "Teams management page";
  - ADDED "Bootstrap owner".
- `api-contract-freeze` (team family): MODIFIED "Team management endpoint family" (owner role,
  the transfer row, the 403/409 rules, no built-in rejection), "Profile teams role field",
  "Admin add-membership role field" (`owner` with demotion) and "New-user membership grant
  behavior" (the bootstrap claim); ADDED "Admin-plane builtin flag is always false".
- `catalog-database`: MODIFIED "The catalog schema lives in Postgres schema `catalog`" (check
  constraints join the recorded expectation; the seed teams exist; one owner per team).
- `web-frontend-platform`: MODIFIED "Single-process development" (boot refuses a blank
  `BOOTSTRAP_OWNER_EMAIL`).
- `local-container-environments`: MODIFIED "Secrets come from Infisical, one environment per
  stack" (compose targets refuse a blank `BOOTSTRAP_OWNER_EMAIL`).

`container-deployment` and `web-login-experience` have no requirement that names the sign-in
variables or the first-sign-in prefs, so they don't change (design D15).

## Non-goals

- **RLS.** Slice 6 builds on this role model.
- **Per-show grants and "members see the show list only"** (ADR 0021 permissions). Content
  access stays role-blind in this slice.
- **Guarding the support plane** beyond decision C. Its membership delete, disable and explicit
  non-owner upserts stay unguarded, as today (design D6).
- **First-sign-in team assignment beyond the bootstrap claim.** Invites stay the only grant for
  other users; `NEW_USER_ALL_TEAMS` stays deprecated.
- **A database trigger for "exactly one owner".** The database enforces "at most one"; the
  application keeps "at least one" (design D1).
- **Removing `enabled_admin_count` or `builtin`** from a frozen shape. Both stay.
- **Moving or importing data.** Slice 11's import lands real shows in these teams.
- **Companion credentials** (slice 9) and **rebuilding browser e2e**.

## Impact

- **Database:** one migration; `server/src/test/pg/catalogSchema.pg.test.ts`'s recorded
  expectation gains the index and the check constraint.
- **Packages:**
  - `domain` (`studio.ts`: built-in constants, `DEFAULT_STUDIO_ID`, `LEGACY_STUDIO_MAP`, the
    global setting keys and the `test-studio-2` category branch deleted);
  - `catalog` (`authStore`, `studioRegistry`, `profileAssembler`, `sessionIndexStore`);
  - `contract` (`adminMembershipBodySchema` gains `owner`; new `teamOwnerTransferBodySchema`);
  - `ports` (`Config.BOOTSTRAP_OWNER_EMAIL`).
- **Server:** routers `teams`, `admin`, `auth`, `shows` (its `DEFAULT_STUDIO_ID` fallback);
  `bootGuard.ts`, `env.ts`, `node/config.ts`; the test harness and fixtures;
  `server/scripts/bootstrapMemberships.example.ts`.
- **Web:** `api/types.ts`, `useTeams.ts`, `TeamCard.tsx`, `TeamsRoute.tsx`, `OnboardingPanel.tsx`
  and their tests.
- **Compose and tooling:** `docker/secrets-env.yaml`, `docker/scripts/compose-run.mjs` and its
  test.
- **Owner steps, before the live checks:** set `BOOTSTRAP_OWNER_EMAIL` in Infisical `dev`,
  `stage` and `prod`. Until then `make <env>-up` refuses, by design, and dev's bind-mounted
  server refuses to boot once task 3.1 lands.

## After merge

These are outside tasks.md, because they need the merged branch, the owner's Infisical values or
`make stage-up` permission:
- **The owner:** set `BOOTSTRAP_OWNER_EMAIL` in Infisical `autologger-dev`, `-stage` and `-prod`.
- **Dev live check** (`make dev-up`):
  - the migration applied: `test-studios` and `test-studio-2` are `studio_definitions` rows;
  - the owner signs in and `GET /api/teams/test-studios` shows `role: "owner"`; the log lists
    each claimed team id (on stage including `my-crew2`, `my-studio`, `my-crew`);
  - a team created as the owner works (create, invite, rename);
  - transfer, leave and demote refusals behave (`409` for the owner; `403` for an admin's role
    change or delete);
  - `bootGuardCli` with `BOOTSTRAP_OWNER_EMAIL` blank prints the refusal, and `compose-run` with
    it withheld refuses.
- **Stage live check**, with the owner's permission for `make stage-up`: the same probes, plus
  `docker/scripts/check-envs.sh` and `docker/scripts/test_router.sh stage`.
- **Prod:** the catalog is created at cutover, so the migration runs on an empty catalog and the
  two teams start ownerless; the bootstrap owner's first prod sign-in claims them. Check the
  masked `bootstrap owner:` boot log line first. **Immediately after the first prod sign-in,
  verify** (psql, or `GET /api/teams/test-studios` as that user) that the owner of `test-studios`
  is the expected user id; if not, stop and fix it through the support plane (owner upsert). ADR 0021's
  cutover notes record that prod's Infisical needs the key before the first deploy of this
  image (design Risks).
