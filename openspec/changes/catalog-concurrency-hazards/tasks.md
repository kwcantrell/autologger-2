# Tasks

The first commit on `supabase-4d-catalog-concurrency-hazards` is
`openspec/changes/catalog-concurrency-hazards/` only. The PR targets `supabase-migration`, and the
gates run with `GITHUB_BASE_REF=supabase-migration`.

The PR needs the owner's `size-override` label. The ceiling was about 650 counted lines; at 576
after 4.2, the owner raised it to about 700 rather than split, and at 688 after 4.5 the owner
dropped the ceiling: every task ships in this PR (2026-10-01).

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

- [x] 3.1 Test first, in `auth.int.test.ts`: two first-sign-in callbacks for one `sub` with
  different states both give 302 with a cookie, and one user exists. Red (`500`), then D5. Green.
  Evidence: `4d-3.1-red.log` (one callback held after its `google_sub` lookup) -> `AssertionError:
  expected 500 to be 302`, and the 500's redacted log line names `23505`.
  `authCreateUserGoogle` now uses `ON CONFLICT (google_sub) DO NOTHING RETURNING id` and returns
  `null` on conflict; the callback then takes the existing-user path. `4d-3.1-green.log`:
  `auth.int` + `nulText.int` -> `Tests  34 passed (34)`. `npm test -w packages/catalog` ->
  `Tests  34 passed (34)`.
- [x] 3.2 Test first, `server/src/test/settingsDefaults.int.test.ts`:
  - five concurrent `GET /api/profile` for a new team all give 200, with one settings row;
  - a deleted team's settings read writes no row;
  - a corrupt blob is repaired once.
  Red, then D4. Green.
  Evidence: these are store-level tests, because the hazard is a registry snapshot taken before a
  delete (the middleware's `init()`). `4d-3.2-red.log` -> `× a read through a snapshot taken
  before the team was deleted stores nothing`, `expected [ Array(1) ] to deeply equal []`. The
  five concurrent reads and the corrupt-blob repair passed before too (regression pins).
  `4d-3.2-green.log`: settings + `shows-profile` + fixtures -> `Tests  56 passed (56)`. `npm test
  -w packages/catalog` -> `Tests  34 passed (34)`.

## 4. Session mirror and Companion (design D6-D9)

- [x] 4.1 Test first, `server/src/sessionMirror.test.ts` (fake catalog and registry):
  - a call made while a link runs gets a later link that reads the newer state;
  - a failure warns and resolves;
  - a root timeout waits for `settled` before the next link;
  - sessions are independent;
  - after `close()`, calls are no-ops and no hub is opened.
  Red, then `SessionMirror` and `ports.mirror`. Green.
  Evidence: `4d-4.1-red.log` -> `Cannot find module './sessionMirror'`. `4d-4.1-green.log` ->
  `Tests  5 passed (5)` (one test fixed: the cross-session case needed a per-session block).
  `promiseHygiene.repo.test.ts` flagged a promise comparison and a promise used as a condition;
  rewritten with a sequence number. `promiseHygiene` + mirror -> `Tests  21 passed (21)`.
  `ports.mirror` is built in `createBindings`, and `close()` awaits it before
  `registry.closeAll()`.
- [x] 4.2 Test first, server integration with `projectSessionLive` failing
  (`vi.spyOn(SessionIndexStore.prototype, …)`):
  - an event log gives 200 with the event saved once, and a warning;
  - the next event heals the projection;
  - a local import updates `event_count`/`current_take`;
  - YouTube import gives 200 when the episode-date write fails (warning names the sid and date);
  - generate returns its outcome (update the `events.generate.int.test.ts:1033` pin).
  Red, then switch the A2 call sites and the import paths to `ports.mirror`. Green.
  Evidence: `4d-4.2-red.log` -> `expected 500 to be 200` (event log), `expected +0 to be 2`
  (local import never mirrored), `expected 502 to be 200` (YouTube episode date). All nine call
  sites and both imports now use `ports.mirror`; the episode date is caught and warned with the
  sid and the date. The generate pin (`events.generate.int.test.ts`) now expects 200 plus the
  warning. `4d-4.2-green.log`: whole server `npx vitest run` -> `Tests  909 passed | 3 skipped`;
  the only failure (promise hygiene) was fixed in 4.1. `npm run typecheck` is clean.
- [x] 4.3 Test first: a `kvStore` unit test for `replaceIf` (true, false on mismatch, false when
  expired). Server, with `ports.kv` on a gated catalog: ack(A) held after its read, command B
  lands, then ack(A) gives `{ok:false}` and `last_command` is B. Red, then D7. Green.
  Evidence: `4d-4.3-red.log` -> `TypeError: s.replaceIf is not a function` ×2; server ->
  `expected { ok: true } to deeply equal { ok: false }`. `replaceIf` was added to the port and the
  store, and the ack uses it. `4d-4.3-green.log` -> storage `kvStore.test.ts` `Tests  16 passed
  (16)`, `companion.int` `Tests  16 passed (16)`.
- [x] 4.4 Test first: a held `GET /api/sessions` repair racing `PUT /api/profile`, logged in and
  anonymous, keeps the profile's choice. Red, then D8. Green.
  Evidence: `4d-4.4-red.log` (the repair write held before it is sent) -> logged in and anonymous
  both `expected '<first show>' to be '<chosen>'`. The anonymous test first stores the team's
  settings, so the held write is the repair and not the settings default. Added
  `authReplaceActiveShowIf` (conditional upsert on `active_show_id` only) and `setSettingIf`; the
  anonymous `PUT /api/profile` writes in one transaction. `4d-4.4-green.log`: race + sessions +
  `shows-profile` + fixtures -> `Tests  88 passed (88)`.
- [x] 4.5 Test first: a log-import job whose catalog statement fails shows `Failed "<title>"`
  without the error text, and the server warns. A domain error (no audio segments) keeps its
  message. Red, then D9. Green.
  Evidence: `4d-4.5-red.log` -> `expected [ 'Fetching spreadsheet…', …(5) ] to include 'Failed
  “Catalog Failure Session”'` (the line carried the `40001` text). The job builds its own
  `createCatalog(...)` + `init()`; `jobFailureDetail` redacts errors with a string `code` or a
  `Catalog*` name and warns. `4d-4.5-green.log`: `logImport.int` -> `Tests  14 passed (14)`; the
  existing domain-message case ("Transcript generation failed: …") still passes.
  `packageBoundaries` + `promiseHygiene` -> `Tests  98 passed (98)`.

## 5. Adapter and ops (design D10)

- [x] 5.1 Test first, `postgresCatalogStore.test.ts` (fake client):
  - an unsent root statement past `rootTimeoutMs` rejects with `CatalogRootTimeoutError`, is
    withdrawn, and `settled` is resolved;
  - a sent one rejects with no cancel, and `settled` resolves when it finishes;
  - no retry.
  Red, then the bound and `max_pipeline: 1`. Green, plus the storage pg project.
  Evidence: `4d-5.1-red.log` -> both cases `Error: Test timed out in 5000ms` (no root bound).
  Added `rootTimeoutMs` (5 000), `CatalogRootTimeoutError` with `settled`, root
  `max_pipeline: 1`, a dequeue `cancel()` only when `state` is unset, and no retry.
  `4d-5.1-green.log`: storage `npx vitest run` (unit + pg) -> `Test Files  7 passed (7)`, `Tests
  101 passed (101)`.
- [x] 5.2 Test first, `startupPurge.test.ts` (fake timers): the periodic purge runs every 10
  minutes, is unref'd, warns with its own text, and stops when cleared. Red, then wire it in
  `main.ts`. Green.
  Evidence: `4d-5.2-red.log` -> `TypeError: startPeriodicPurge is not a function`. Added
  `startPeriodicPurge` (unref'd `setInterval`, own warning text), started in `main.ts` after the
  boot purge and cleared on SIGINT/SIGTERM. `4d-5.2-green.log`: `startupPurge` +
  `promiseHygiene` -> `Tests  21 passed (21)`. Whole server `4d-5-server-all.log` -> `Tests  916
  passed | 3 skipped (919)`; `npm run typecheck` -> exit 0.

## 6. Docs and integration checks

- [x] 6.1 ADR 0021:
  - hazards 2-6, 8-13, 15-20 done, #7 verified with no change, #14 partly done (gates), with
    display names on the revisit list;
  - the D11 revisit list as post-migration follow-ups;
  - the index migration;
  - the owner's one-PR `size-override`.
  Also the `docs/supabase.md` root deadline note. Verify with
  `grep -n "Revisit after the migration\|4d" docs/decisions/0021-*.md`.
  Evidence: `grep -n "Revisit after the migration\|   - 4d" docs/decisions/0021-*.md` ->
  `218:   - 4d \`catalog-concurrency-hazards\`: … Done (2026-10-01), as one`, `252:   - **Revisit
  after the migration** (4d alternatives not taken, owner 2026-10-01):`. `docs/supabase.md`
  gained "Catalog time limits".
- [x] 6.2 `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --stage hook` is green except
  size (label); record the counted lines (ceiling about 650).
  Evidence: `4d-6.2-hook.log` -> exit 0; every gate PASS (`risk-floor 20 high-risk path(s)`,
  `evidence`, `commands ran ['typecheck', 'test']`), and `WARN  size  777 changed lines > budget
  400 … ask the human for size-override`. The owner dropped the ceiling (header).
- [x] 6.3 Dev stack:
  - `make dev-up` (the index migration applies);
  - Companion command, then ack, while a second command lands: `last_command` is the second;
  - two concurrent team creates at the cap: one 400;
  - `docker pause autologger-dev-db-1` for 7 s: a request gets the generic 500 within about
    5-6 s (not 30 s); after unpause, requests succeed.
  Evidence: `make dev-up` -> exit 0; `4d-6.3-devup.log` -> `applied 20261002000000`, `1 applied`;
  the app is `healthy`. Companion on the 4c scratch session: command A, then command B, then
  ack(A) -> `{"ok":false}`, and `/api/companion/state` -> `last_command 6c1acb6a-… False` (B).
  With `docker pause autologger-dev-db-1`: `GET /api/sessions` -> `paused: 500 in 5.035585s`, and
  the app log has `CatalogRootTimeoutError: catalog statement timed out; it may still apply`
  (from `refreshStudioRegistry`). After unpause -> `200 in 0.003286s`, `200`. **Not run live:**
  the concurrent team-create cap check. Dev has no sign-in, and team routes need a logged-in user
  (401), so that race is covered only by integration test 2.2.
- [x] 6.4 `consistency-read`, then archive.
  Evidence: `panel.md` "Consistency read 2026-10-01": edits since `53f9a7c` are the D12/R2
  measurement wording and the tasks evidence, with no scope change. Every requirement maps to a
  test, and 2 minor findings are resolved. `check-change.sh --only panel` -> `PASS  panel  46
  finding(s), no open criticals`. The archive follows in its own commit.
