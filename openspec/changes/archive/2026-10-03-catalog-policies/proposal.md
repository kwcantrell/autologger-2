# Catalog policies: row-level security enforces the team permission model

Tier: 2
Tier reason: authorization (database policies that decide which rows a signed-in user reads and
writes, and `SECURITY DEFINER` helpers that bypass row-level security), a catalog migration,
concurrency (policy reads add `SERIALIZABLE` predicate locks, so retries can rise), and frozen
statuses that existence probes could change; touches `supabase/migrations/**` and
`server/src/routers/**`. ADR 0021 slice 6b-2.

Approved-by: Kalen 2026-10-02

## Why

Slice 6b-1 (`catalog-roles`, PR #39) runs every catalog statement as `catalog_user` (with the
user's id) or `catalog_system` (with a reviewed reason), and turns row-level security on, but every
`catalog_user` policy still allows everything. A forgotten check in the app still reaches every
team's rows. This slice replaces the `<table>_user_all` policies with policies that hold the 6a
permission model (team-level reads, access-level content writes), so the database is a backstop
behind the app's gates. The app gates stay the precise check; the frozen HTTP and WebSocket
contract does not change.

## Owner decisions (owner, 2026-10-02 and 2026-10-03)

These are the human owner's binding decisions for this slice (plan of record
`parsed-honking-lobster.md`):
1. **Policy shape** (owner, 2026-10-03):
   - reads are team-level, as decided in 6a;
   - content writes are access-level: a show, a session or a team's settings needs owner or
     admin, or a grant on that show;
   - the team-management tables (memberships, invites, grants, the team row) accept writes from
     members of that team only. This holds the team boundary; the app's in-transaction role
     checks keep the owner/admin precision.
2. **Settings reads have no side effects** (owner, 2026-10-03). A missing or corrupt blob reads as
   the default and nothing is written. Team creation seeds the row, and saving still writes it.
3. **The 12 system reasons stay system** (owner, 2026-10-03). ADR 0021 records why each one needs
   rows outside the caller's teams.
4. **Earlier decisions stand** (owner, 2026-10-02):
   - `catalog_system` keeps its allow-all policies;
   - the helpers are `SECURITY DEFINER`, with `EXECUTE` revoked from `PUBLIC`;
   - an allow/deny matrix test;
   - the `40001` retry measurement (deferred from 6b-1);
   - `CatalogForbiddenError` maps to each route's existing status.

## After the adversarial panel (owner, 2026-10-03)

The owner added these after the three-reviewer panel:
- **A. Cross-team contention: accept retries.** Policy reads add `SERIALIZABLE` predicate locks,
  so a transaction in one team may abort with `40001` because of a transaction in another team.
  The adapter retries it, and while the retry budget (`maxTries`, 5 runs) holds, no such abort
  reaches HTTP. The cross-team test asserts that both transactions commit through the retry loop,
  not that no `40001` occurs. **Stop rule for retries:** measure `40001`/`40P01` retries with the
  test-only counter over 5 integration-plus-`pg` runs, and in the contention test and the probe
  on `ANALYZE`d test databases. Measure each before (6b-1 policies) and after. Stop and ask the
  owner if the retry rate (retries per transaction call) more than doubles against 6b-1, or if any
  call exhausts its retries in the integration runs, the contention test or the probe. This
  resolves the former OQ4.
- **B. Team-management inserts are system-only.** `catalog_user` gets no `INSERT` policy and no
  `INSERT` privilege on `user_studio_memberships` and `team_invites`. Only the system reasons
  `team-create`, `team-invite`, `oauth-callback`, `bootstrap-claim` and `support-plane` add them.
  No user-bound path inserts into either table (design A28).

Panel fixes, folded in without a scope change:
1. `users`: `catalog_user` holds `SELECT` and `UPDATE (given_name, family_name)` only, with no
   `INSERT` or `DELETE`. The user path's name edit gets its own two-column `UPDATE` (design D2,
   A29).
2. An `api-contract-freeze` delta records the race-only outcomes (design D8, D9).
3. `PUT /api/profile` re-checks the caller's role `FOR SHARE` inside one transaction before its
   first settings or show write. A mid-request demotion then gets `403 Admin role required.` with
   nothing written (design D8).
4. Test clones carry no planner statistics for the rows the tests seed. The contention test and
   the probe also run after `ANALYZE`, and the vacuous lock-granularity test is dropped (design
   D10, D11).
5. The deploy and rollback windows are spelled out (Impact; design "Migration Plan").

## For the approver

Design proposes these; the owner confirms them at approval (design "Open Questions" holds the
alternatives):
- **Seven helpers, not three** (design D1, OQ1). The plan names `member_studios`,
  `manager_studios` and `accessible_shows`. The design adds two more for the same membership facts
  and two existence checks:
  - `member_shows` and `co_members`: written as plain policy subqueries, the `sessions`,
    `show_grants` and `users` policies made Postgres take relation-level `SERIALIZABLE` locks on
    `shows` and on `user_studio_memberships` (A10). Moving those reads into helpers with
    `set enable_seqscan = off` lowers them to page and tuple locks, so fewer transactions abort
    and retry (owner decision A accepts the rest).
  - `studio_exists` and `show_exists`: two existence checks that keep two frozen outcomes (D6).
- **`POST /api/shows` keeps its in-transaction existence read** (D6, OQ2). The plan said to check
  the team against the request's snapshot (`isKnownStudio`). That turns team-management's
  "No show for a deleted team" outcome (`400 Unknown studio id.`, asserted by
  `teams.race.int.test.ts:443`) into `404`, because the snapshot predates the delete. The design
  keeps `studioExists` inside the transaction. When the policy hides the team, the design asks
  `catalog.studio_exists` whether the team exists, so the answer is `404` for a foreign team and
  `400` for a missing one.
- **A migration backfill of team settings** (D7, OQ3). The default blob draws fresh category ids
  on every call (`packages/domain/src/studio.ts:147-180`), so once reads stop writing, a team with
  no stored row would show new category ids on every load. The migration stores a default row for
  each existing team that has none. It writes the same shape as the app's default, and a `pg` test
  holds the two in step.
- **The team delete removes memberships last** (D5). Under member-only policies, a delete that
  removes the memberships first leaves the definition and settings rows behind, without an error
  (A6). The shared store method changes its order, so both planes still cascade identically.
- **Writes a policy can still refuse in a race keep existing statuses** (D8). A revoke or
  demotion that commits between a session route's gate and its write gets `404 Session not
  found` and changes nothing. Before this slice those writes went through. The
  `api-contract-freeze` delta narrows the success outcome for this race only.
- **`kv` is closed to `catalog_user`** (D2). Its table privileges are revoked, so a user-bound
  statement on `kv` fails loudly with `42501` instead of silently reading nothing.
- **`set enable_seqscan = off` on every helper** (D1, A10). Kept, with this justification: the
  catalog's tables are small in prod too (tens of teams and shows), where the planner prefers a
  sequential scan. Under `SERIALIZABLE`, a sequential scan locks the whole relation. The setting
  holds inside the function only, costs a GUC save and restore per call, and keeps the helper's
  locks at page or tuple level, which cuts avoidable `40001`s. It does not make teams independent
  (owner decision A).

## What Changes

- **Database** (migration `supabase/migrations/20261007000000_catalog_policies.sql`):
  - seven `SECURITY DEFINER` helpers in schema `catalog`, owned by `postgres`, each with
    `set search_path = pg_catalog, pg_temp` and `set enable_seqscan = off`, `EXECUTE` revoked from
    `PUBLIC` and granted to `catalog_user` only: `member_studios(uid)`,
    `manager_studios(uid)`, `accessible_shows(uid)`, `member_shows(uid)`, `co_members(uid)`,
    `studio_exists(id)` and `show_exists(id)`;
  - the `<table>_user_all` policies are dropped, and 23 per-command `catalog_user` policies take
    their place (design D2):
    - reads are team-level;
    - show, session and settings writes need owner or admin, or a grant;
    - updates and deletes on the team-management tables are limited to members of that team, and
      inserts into memberships and invites are system-only (owner decision B);
    - `user_prefs` is the user's own row only;
    - in `users`, a user reads their own row and their co-members' rows, and updates their own
      names only;
  - `catalog_user`'s privileges narrow:
    - no privilege on `kv`;
    - `SELECT` plus `UPDATE (given_name, family_name)` on `users`;
    - no `INSERT` on `user_studio_memberships` or `team_invites`;
  - a default settings row for every team that has none (design D7);
  - `catalog_system` keeps its allow-all policies and full privileges.
- **Settings reads write nothing.** Reading a team's settings never inserts or replaces a row. A
  missing or corrupt blob reads as the default. Team creation (both planes) stores the default row
  in place of the leftover-settings delete. Saving is unchanged.
- **Existence probes keep their statuses.** `POST /api/shows` answers `404` for a foreign team and
  `400 Unknown studio id.` for a missing or concurrently deleted team. `POST /api/sessions`
  answers `400 Show does not belong to the active team.` for another team's show and
  `400 Unknown show_id.` for a missing one.
- **Writes keep their statuses under the policies** (design D8):
  - the team delete removes memberships last;
  - the user-path name edit updates only the two name columns;
  - `PUT /api/profile` runs its role re-check and its settings and show writes in one
    transaction (`FOR SHARE`);
  - a `null` transfer target is `404 Member not found`;
  - a session update that changes no row is `404 Session not found`;
  - where an in-transaction gate already decided, a `42501` stays the generic `500` with a log
    line (the backstop fired, a bug).
- **Tests:**
  - an allow/deny matrix (`pg`) over every table, command and restricted column, for owner,
    admin, granted member, ungranted member, a non-member from another team, and no user id;
  - tests for each helper;
  - a cross-team contention test that commits through the retry loop on an `ANALYZE`d clone;
  - new integration cases, including the races (design D10);
  - a test-only retry counter, with 5 integration-plus-`pg` runs before and after;
  - the 6b-1 concurrency probe, with and without `ANALYZE`, before and after, under the stop
    rules.
- **Docs:** ADR 0021's 6b-2 entry, which records:
  - these decisions;
  - why each of the 12 system reasons stays;
  - the rollback SQL;
  - the retry and probe numbers.

  `docs/supabase.md`'s role table changes too: `catalog_user` is policy-restricted, has no access
  to `kv`, and has narrowed privileges on `users`, memberships and invites.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `catalog-database`:
  - MODIFIED:
    - "Catalog roles for user and system callers": `catalog_user`'s narrowed privileges and the
      helpers.
    - "Row-level security is enabled on every catalog table": the policies are no longer
      allow-all; `kv` has no user policy.
    - "Settings defaults are race-free and never recreate a deleted team": a read writes
      nothing; creation seeds.
  - ADDED:
    - "User policies enforce the team permission model": the per-table rules, the matrix, and
      cross-team retries.
    - "Policy helpers are reviewed definer functions".
- `core-ports-architecture`:
  - ADDED "Policy outcomes keep each route's status": existence probes, the in-transaction
    profile check, zero-row writes, and the `42501` mapping.
- `api-contract-freeze`:
  - ADDED "Writes whose access is revoked in flight change nothing": the race-only outcomes of
    design D8. It narrows the session routes' and the profile route's success outcome only for
    that race, on the model of "Concurrent first sign-in succeeds".

`team-management` needs no delta (design D9). Its "Cross-team independence" is stated at the
request level ("writes in another team fail", "both succeed"). Under owner decision A, cross-team
`40001`s are retried inside the adapter and never reach a request while the retry budget holds;
the stop rule watches that budget.

## Non-goals

- **Moving any of the 12 system reasons to user scope** (owner decision 3). This includes
  `team-create`, `team-invite`, `access-loss-check` and `log-import-job`, which ADR 0021's 6b-1
  outline listed as candidates.
- **Mapping `CatalogForbiddenError` to new masked `404`/`403` responses.** ADR 0021's outline
  said so. Owner decision 4 says to keep each route's existing status, so routes whose
  in-transaction gate already decided keep the generic `500`.
- **Database-enforced role precision inside a team.** A member can still update or delete
  membership, grant and invite rows of their own team as far as the policies go. The app's
  in-transaction gates are the only check there (design "Risks").
- **Any change to the 6a app gates**, except the ordering, transaction and zero-row checks in
  design D5 and D8.
- **Policies for `catalog_system`**, and restricting `postgres` (owner of the tables, with
  `BYPASSRLS`).
- **Database-side audit logging** (the 6b-1 follow-up C).
- **A production retry hook.** Retries are counted by a test-only wrapper (design D11).
- **Session content** (per-session SQLite until slice 7), and Realtime authorization (slice 9).

## Impact

- **Database:** one new migration; seven new functions; narrowed `catalog_user` privileges; a
  settings row for every team without one. `catalog_system` and `autologger_app` are unchanged.
- **Packages:** `catalog`:
  - `studioRegistry.ts`: the settings read, the seeding in `insertStudioDefinition`, the delete
    order, and `studioExistsAnywhere`;
  - `authStore.ts`: `authUpdateUserNames` gets its own two-column `UPDATE`;
  - `showsStore.ts`: `showExistsAnywhere`;
  - `sessionIndexStore.ts`: `updateSessionIndex` returns `null` on a zero-row update.
- **Server:** routers `shows.ts`, `sessions.ts`, `teams.ts` and `profile.ts`, with
  status-preserving checks and the profile transaction; test plumbing in
  `server/src/test/harness.ts` (the retry counter) and the probe (an `ANALYZE` option and the
  counter); new `pg` and integration suites; `settingsDefaults.int.test.ts` follows the modified
  requirement.
- **Contract:** one ADDED `api-contract-freeze` requirement for in-flight revocation races. No
  status, body or message changes for requests a serial order can produce (design D9).
- **Operators:** no new env var or secret. The migration applies on the next `migrate` run, and
  the new app should run right after it. While the old (6b-1) image runs against the migrated
  database:
  - its self-healing settings read is refused for plain members, a `500` on loading a team with
    no settings row (the backfill leaves none; only teams the old image creates in the window
    lack one);
  - its team delete removes memberships first. The definition and settings deletes then change
    nothing, so the owner gets `200` while the team's definition and settings stay behind with no
    members. Such an orphan is removed by the support plane's delete (system).

  Rolling back is the documented SQL in design "Migration Plan". It drops the helpers, so it must
  not run while the new image serves: the new image's `studio_exists`/`show_exists` calls would
  fail (a `500` on the foreign-team and foreign-show probes). The Migration Plan therefore deploys
  the previous image first and runs the SQL right after.
- **Performance:** each user-bound statement on a policy table runs each referenced helper once
  (a hashed subplan). Policy reads add `SERIALIZABLE` predicate locks in transactions, so
  cross-team `40001` retries can rise (owner decision A). The stop rules:
  - the retry rate more than doubles against 6b-1, or any call exhausts its retries;
  - the probe's root p95 median rises above 11.7 ms (2× 6b-1's 5.85 ms), or any root timeout
    appears.

## After merge

These are outside tasks.md, because they need the merged branch or `make stage-up` permission:
- **Dev live check** (`make dev-up`):
  - the migration applied: `select count(*) from pg_policies where schemaname = 'catalog' and
    'catalog_user' = any(roles)` is 23, and no `<table>_user_all` policy is
    left;
  - as the owner, the stage admin and an invited plain member:
    - the plain member sees titles only and gets "not found" on an ungranted session, which
      works after a grant;
    - a member's profile on a new team loads;
    - the team page, show create (admin) and session create (granted member) work;
  - `docker exec … psql` as `autologger_app`, `set role catalog_user`,
    `set_config('app.user_id', '<a user with no team in common>', true)`: `select` on `shows`,
    `sessions`, `user_studio_memberships` and `app_settings` returns nothing of the other team;
    `select` on `kv` fails with `permission denied`;
  - the app log shows no `CatalogForbiddenError` after the walk-through.
- **Stage live check**, with the owner's permission for `make stage-up`: the same probes.
- **Prod:** prod runs `main` until slice 11's cutover, so no prod step here.
