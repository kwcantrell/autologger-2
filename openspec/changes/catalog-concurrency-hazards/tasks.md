# Tasks

The first commit on `supabase-4d-catalog-concurrency-hazards` is
`openspec/changes/catalog-concurrency-hazards/` only. The PR targets `supabase-migration`, and the
gates run with `GITHUB_BASE_REF=supabase-migration`.

The PR needs the owner's `size-override` label. The ceiling is about 650 counted lines; past it,
stop and ask to split (owner, 2026-10-01).

Logs: keep the full output of every test and gate run under the session scratchpad as
`4d-<task>-<red|green>.log`, and name the log in each `Evidence:` line. Each "test first" item is
red before its fix (record the failure line) and green after.

## 1. Test seam and indexes (design D1, D12)

- [x] 1.1 Add `server/src/test/gatedCatalog.ts`: one-shot gates per pattern that stay open for
  retries, `tx` handles wrapped, and `reached()`/`release()`. Self-test in
  `gatedCatalog.int.test.ts`: a held request finishes only after release, a second request
  commits meanwhile, and a body re-run passes an opened gate.
  Evidence: `4d-1.1-green.log`: `npx vitest run --project integration
  src/test/gatedCatalog.int.test.ts` -> `Tests  2 passed (2)`.
- [x] 1.2 Test first, `server/src/test/pg/teamIndexes.pg.test.ts`: `EXPLAIN` of a membership
  delete by `studio_id` uses an index. Red (`Seq Scan`), then add
  `supabase/migrations/<ts>_catalog_team_indexes.sql`. Green, and `docker/supabase/test_migrate.sh`
  passes.
  Evidence: `EXPLAIN` can't tell a seek from a walk of the primary key, where `studio_id` is the
  second column (it showed `Index Cond: studio_id` without an index). So the test checks
  `pg_index` for an index whose first column is `studio_id`. `4d-1.2-red.log` -> `× catalog.user_studio_memberships …`,
  `× catalog.shows …`, `Tests  2 failed | 1 passed (3)` (team_invites passes via its PK).
  Added `supabase/migrations/20261002000000_catalog_team_indexes.sql`. The 4a parity test
  (`catalogSchema.pg.test.ts`: "named indexes match" SQLite) then failed, so the same two indexes
  went into `packages/catalog/migrations/0006_team_indexes.sql` (design D12 said no SQLite
  mirror; this keeps the catalog-database parity requirement true until 4e).
  `4d-1.2-green.log`: `npx vitest run --project pg` -> `Tests  19 passed (19)`.
  `migrations.int.test.ts` -> `Tests  5 passed (5)` (name lists include 0006).
  `npm test -w packages/catalog` -> `Tests  34 passed (34)`. `docker/supabase/test_migrate.sh`
  -> `test_migrate: 35 passed, 0 failed`.

## 2. Team writes (design D2, D3; team-management "Concurrent team writes")

Tests in `server/src/routers/teams.race.int.test.ts`; each request is held before its
in-transaction role read.

- [x] 2.1 Admin re-check (#8). Test first: a demoted admin's held delete and held rename each get
  403 and change nothing. Red, then `requireTeamAdminIn` (FOR SHARE) plus the transaction-wrapped
  admin routes, with `guardedAgainstLastAdmin` taking `cat`. Green; `teams.int.test.ts` and
  `apiResponseFixtures.int.test.ts` stay green.
  Evidence: `4d-2.1-red.log`: `npx vitest run --project integration
  src/routers/teams.race.int.test.ts` -> `× a demoted admin’s in-flight delete…`, `× …rename…`,
  `AssertionError: expected 200 to be 403` ×2. The seam gained `holdAfter` (it holds after the
  early root role read). Rename and delete no longer refresh the registry inside the
  transaction (a full read of `studio_definitions` would make teams conflict); the routes call
  `refreshAfterWrite()` after commit, and so does `admin.ts` delete. `4d-2.1-green.log`: race +
  `teams.int` + `apiResponseFixtures.int` + `admin.int` -> `Test Files  4 passed (4)`, `Tests  85
  passed (85)`. `npm run typecheck -w server` is clean.
- [x] 2.2 Create (#9, #18). Test first:
  - concurrent creates at 19 give one 200 and one 400;
  - a held invite racing a team delete gets 404;
  - recreating the id gives only its creator, no invites and default settings;
  - an id with leftover shows gets 400;
  - `test-studios` gets 400 with its memberships unchanged;
  - the same on the admin plane.
  Red, then the create transaction and purge in both planes, with the refresh after commit
  warning on failure. Green.
  Evidence: `4d-2.2-red.log` (`-t creation`) -> `× concurrent creates… expected [ 200, 200 ] to
  deeply equal [ 200, 400 ]`, `× a recreated id…` (stranger still a member), `× an id that still
  has shows… expected 200 to be 400`, `× the admin plane…`; `Tests  4 failed | 2 passed`. The two
  that passed:
  - the invite-vs-delete race, already closed by 2.1's re-check (404);
  - the built-in refusal, existing validation, which now runs before the transaction.
  Validation went onto the registry facade (`validateNewStudio`), because
  `packageBoundaries.repo.test.ts` forbids routers from importing `StudioRegistry`.
  `4d-2.2-green.log`: race + teams + fixtures + admin + `catalog.int` -> `Tests  100 passed
  (100)`; `packageBoundaries.repo.test.ts` -> `Tests  82 passed (82)`. `npm test -w
  packages/catalog` -> `Tests  34 passed (34)`.
- [x] 2.3 Invite (#10). Test first: concurrent invites at 199 give one recorded and one 400. Red,
  then the invite transaction. Green.
  Evidence: the invite transaction landed in 2.1, so red was shown by running the new test
  against the pre-4d `teams.ts` (`git show supabase-migration:server/src/routers/teams.ts`,
  restored afterwards). `4d-2.3-red.log` -> `AssertionError: expected [ 200, 200 ] to deeply equal
  [ 200, 400 ]`. `4d-2.3-green.log` (current `teams.ts`) -> `Tests  1 passed`.
- [x] 2.4 Role and removal (#11, #12). Test first: a held promotion racing a removal gets 404
  with no membership; a double removal gives 200 and 404. Red, then
  `authSetExistingMembershipRole` and the guard result. Green.
  Evidence: `4d-2.4-red.log` (pre-4d `teams.ts`, as in 2.3) -> `expected 200 to be 404`
  (promotion re-created the member), `expected [ 200, 200 ] to deeply equal [ 200, 404 ]`. With
  2.1's transactions both already passed (`4d-2.4-mid.log` -> `Tests  2 passed`), via a
  SERIALIZABLE retry. `authSetExistingMembershipRole` (UPDATE only) and the guard's
  `'missing'` result were added as designed. `4d-2.4-green.log`: race + teams + fixtures + admin
  -> `Tests  94 passed (94)`.
- [x] 2.5 Admin plane (A20): dropped by the re-panel (2026-10-01); see design D2.
  Evidence: `server/src/routers/admin.ts:94-112` has no last-admin check (support plane, by
  spec), so the raced outcome equals the serial order. Re-panel recorded in `panel.md` (owner
  re-approved 2026-10-01).
- [x] 2.6 Show create (#13, #14). Test first: a held show create racing a team delete gets
  `400 Unknown studio id.`, and no show; an admin-plane membership add for a deleted team is
  refused. Red, then D3. Green.
  Evidence: `4d-2.6-red.log` (`-t "show create"`) -> `AssertionError: expected 200 to be 400` ×2
  (an orphan show; an orphan membership). Added `studioExists` (registry facade), the show
  create transaction, and the admin-plane membership-add transaction. `4d-2.6-green.log`: race +
  `shows-profile` + `admin` + fixtures + `nulText` + `crossPackageErrorIdentity` -> `Tests  87
  passed (87)`; `npm run typecheck -w server` is clean.
- [x] 2.7 Cross-team. Test first: two creates of different teams by different users, and two
  invites in different teams, all with `Promise.all` and held to overlap, all succeed. Red
  without 1.2's migration (record it), green with it.
  Evidence: this test can't be red. With the index migration moved out, the template rebuilt
  and the test asserting "no retry" (`4d-2.7-red.log`), and also with the index
  (`4d-2.7-green.log`, first run), the held create showed `expected 2 to be 1`: on tables this
  small SERIALIZABLE tracks reads by index page (or table), so a create in another team still
  conflicts once. The invite pair didn't conflict. The test now asserts the spec outcome: both
  succeed, at most one retry. It is a regression pin; the index is proved by 1.2. Design D12 and
  R2 are corrected to say this. `4d-2.7-green.log` -> `Tests  15 passed (15)`.

## 3. Sign-in and settings (design D4, D5)

- [ ] 3.1 Test first, in `auth.int.test.ts`: two first-sign-in callbacks for one `sub` with
  different states both give 302 with a cookie, and one user exists. Red (`500`), then D5. Green.
- [ ] 3.2 Test first, `server/src/test/settingsDefaults.int.test.ts`:
  - five concurrent `GET /api/profile` for a new team all give 200, with one settings row;
  - a deleted team's settings read writes no row;
  - a corrupt blob is repaired once.
  Red, then D4. Green.

## 4. Session mirror and Companion (design D6-D9)

- [ ] 4.1 Test first, `server/src/sessionMirror.test.ts` (fake catalog and registry):
  - a call made while a link runs gets a later link that reads the newer state;
  - a failure warns and resolves;
  - a root timeout waits for `settled` before the next link;
  - sessions are independent;
  - after `close()`, calls are no-ops and no hub is opened.
  Red, then `SessionMirror` and `ports.mirror`. Green.
- [ ] 4.2 Test first, server integration with `projectSessionLive` failing
  (`vi.spyOn(SessionIndexStore.prototype, …)`):
  - an event log gives 200 with the event saved once, and a warning;
  - the next event heals the projection;
  - a local import updates `event_count`/`current_take`;
  - YouTube import gives 200 when the episode-date write fails (warning names the sid and date);
  - generate returns its outcome (update the `events.generate.int.test.ts:1033` pin).
  Red, then switch the A2 call sites and the import paths to `ports.mirror`. Green.
- [ ] 4.3 Test first: a `kvStore` unit test for `replaceIf` (true, false on mismatch, false when
  expired). Server, with `ports.kv` on a gated catalog: ack(A) held after its read, command B
  lands, then ack(A) gives `{ok:false}` and `last_command` is B. Red, then D7. Green.
- [ ] 4.4 Test first: a held `GET /api/sessions` repair racing `PUT /api/profile`, logged in and
  anonymous, keeps the profile's choice. Red, then D8. Green.
- [ ] 4.5 Test first: a log-import job whose catalog statement fails shows `Failed "<title>"`
  without the error text, and the server warns. A domain error (no audio segments) keeps its
  message. Red, then D9. Green.

## 5. Adapter and ops (design D10)

- [ ] 5.1 Test first, `postgresCatalogStore.test.ts` (fake client):
  - an unsent root statement past `rootTimeoutMs` rejects with `CatalogRootTimeoutError`, is
    withdrawn, and `settled` is resolved;
  - a sent one rejects with no cancel, and `settled` resolves when it finishes;
  - no retry.
  Red, then the bound and `max_pipeline: 1`. Green, plus the storage pg project.
- [ ] 5.2 Test first, `startupPurge.test.ts` (fake timers): the periodic purge runs every 10
  minutes, is unref'd, warns with its own text, and stops when cleared. Red, then wire it in
  `main.ts`. Green.

## 6. Docs and integration checks

- [ ] 6.1 ADR 0021:
  - hazards 2-6, 8-13, 15-20 done, #7 verified with no change, #14 partly done (gates), with
    display names on the revisit list;
  - the D11 revisit list as post-migration follow-ups;
  - the index migration;
  - the owner's one-PR `size-override`.
  Also the `docs/supabase.md` root deadline note. Verify with
  `grep -n "Revisit after the migration\|4d" docs/decisions/0021-*.md`.
- [ ] 6.2 `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --stage hook` is green except
  size (label); record the counted lines (ceiling about 650).
- [ ] 6.3 Dev stack:
  - `make dev-up` (the index migration applies);
  - Companion command, then ack, while a second command lands: `last_command` is the second;
  - two concurrent team creates at the cap: one 400;
  - `docker pause autologger-dev-db-1` for 7 s: a request gets the generic 500 within about
    5-6 s (not 30 s); after unpause, requests succeed.
- [ ] 6.4 `consistency-read`, then archive.
