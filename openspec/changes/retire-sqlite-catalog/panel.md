# Panel: retire-sqlite-catalog
Tier: 2 · Reviewers: assumption tester, failure and abuse, scope and simplicity · Date: 2026-10-01

No reviewer raised a critical finding. Every finding below is resolved in the artifacts; none
changes scope.

## Assumption tester

- [x] [major] D2 dropped the SQLite lock block on the claim that Postgres tests already cover "a key/value call never joins a catalog transaction"; `rg -n -i "never join|survives (its|the) rollback" server/src packages` finds only the SQLite case. Resolved: D2 and task 2.1 port it as a Postgres case (a put made during an open transaction survives that transaction's rollback, and the transaction's own row does not).
- [x] [major] Two more KvStore cases lean on SQLite lock ordering: the re-put between `get`'s read and its delete would be flaky on the 3-connection root pool, and "two takes queued behind a held transaction" no longer queues. Resolved: D2 and task 2.1 restate them as a deterministic wrapper that re-puts between `SELECT` and `DELETE`, and as two concurrent takes with exactly one winner. The proposal now says behaviours are kept, not cases.
- [x] [major] `makeFakeClock().tick()` calls `vi.advanceTimersByTime`, which throws without fake timers, and D2 forbids fake timers. Resolved: every case uses a plain mutable-`now` clock (D2, task 2.1).
- [x] [major] README `:1365` (the upgrade-rollback note) points at the deleted `packages/storage/src/migrate.ts`, and no task touched it. Resolved: added to D6 and task 5.1, repointed at `supabase/migrations/` + `docker/supabase/migrate.sh`; the non-goal now names this one exception.
- [x] [minor] Task 3.3's `rg -i sqlite` evidence would still hit `ports/kvStore.ts:4` and `showsStore.ts:179`, and missed comments naming deleted `.sql` files (`showsStore.ts:48,198`, `authStore.ts:422`). Resolved: listed in D6 and 3.3, and the evidence grep now targets deleted names.
- [x] [minor] D6's "no stale names outside openspec/ and docs/" contradicted the non-goal that leaves `supabase/migrations/` comments unedited. Resolved: D6 excludes the applied migrations and the README slice 11 runbook.
- [x] [minor] Task 4.1's negative check passed for the wrong reason: after the deletion, a re-added migrations mount is refused by the existence loop, not by the ALLOW pattern. Resolved: the guard case binds an existing non-`src` path (`packages/catalog/package.json`), with a red check that widens ALLOW.
- [x] [minor] The recorded expectation was weaker than the spec delta says: index names only, and the first FK column only. Resolved: D3, task 1.1 and the delta record full `indexdef` and every FK column.
- [x] [minor] Prod's `_migrations` = 0001-0005 can't be verified from the repo. Resolved: D4 and the ADR task say "expected, to be confirmed by slice 11 against the real file".
- [x] [minor] "Last commit containing the migrations is `c783b99`" holds only without a rebase. Resolved: D4 says `c783b99` contains 0001-0006, and records the deletion commit's parent if the branch is rebased.
- [x] [minor] The moved error classes carry SQLite-flavoured doc comments. Resolved: task 2.2 allows rewording the doc comments; names, messages and `name` fields stay.

## Failure and abuse

- [x] [major] The KvStore take-contention case becomes meaningless on Postgres, and the dropped lock block's "write survives rollback" property has no Postgres test. Resolved: same fix as the assumption tester's first two majors (D2, task 2.1).
- [x] [minor] The recorded expectation compares index names and first FK columns only, and the risk section overclaimed "any unplanned change". Resolved: full `indexdef` and every FK column are recorded, the risk wording names what is and isn't covered, and task 1.1's evidence must be one vitest run with parity and literal green together.
- [x] [minor] Nothing builds the prod/stage `api` image, the only consumer of the edited `api-src` stage. Resolved: task 4.2 builds `--target api` and checks `/api/health`.
- [x] [minor] The negative env check was a one-off run, not a regression test. Resolved: task 4.1 adds the case to `docker/scripts/test_check_envs.sh`. That script isn't wired into `check-change.sh` or CI; the gap predates this change and is flagged to the owner.
- [x] [minor] Slice 11 should not assume prod's migration level. Resolved: the ADR 4e entry tells slice 11 to refuse a source whose `_migrations` isn't exactly 0001-0005, and to copy every column explicitly (so `title_suffix` keeps the backfilled `'episode'`); it names `main` as a second copy of the SQL.
- [x] [minor] `pendingAfter` was claimed to be used by `server/src/test/gatedCatalog.int.test.ts`. Resolved: that file defines its own local `pendingAfter` (line 7) and doesn't import storage's (`rg -n pendingAfter server packages`), so task 3.1 drops storage's copy.
- [x] [minor] The `catalog-database` Purpose still calls the schema "a faithful port of the SQLite catalog". Resolved: kept as accurate history (a Purpose isn't a delta target); the delta's normative text no longer depends on SQLite.

## Scope and simplicity

- [x] [major] The catalog-database delta contradicted itself: the schema must equal a recorded expectation that must equal SQLite 0001-0006, yet a later migration must update that expectation. Its THEN clause also asserted untestable provenance. Resolved: the SHALL is now "equals the recorded expectation", with the SQLite capture as a parenthetical note, and the provenance clause is gone from the scenario. The scenario keeps its title because `openspec validate` refuses to drop a scenario from a MODIFIED block; its body no longer mentions SQLite.
- [x] [major] The `api-src` edit also changes the prod `api` image, which the proposal didn't say and no task verified. Resolved: the proposal says so ("Images and dev compose"), and task 4.2 builds and boots `--target api`.
- [x] [minor] The "two takes queued behind a held transaction" case can't be ported as written. Resolved: it becomes two concurrent takes (D2, task 2.1).
- [x] [minor] The "KV TTL with a fake clock" block duplicates the main block's expiry cases. Resolved: merged during the port (D2).
- [x] [minor] Stale comments the plan missed (`storage/kvStore.ts:3-5,31-32`, `session-core/src/fakeClock.test.ts:6`), and a grep that can't catch "async catalog adapter" wording. Resolved: added to D6 and 3.3, and the grep is widened.
- [x] [minor] `api-contract-freeze` `:596` (`SQLITE_FULL`) and `:895` (the SQLite `shows.next_episode` column) are stale, but that spec is frozen. Resolved: task 5.2 adds them to ADR 0021's revisit list.
- [x] [minor] The delta's "A migration" became "Migrations" without the proposal saying so. Resolved: listed in the proposal's catalog-database entry.

## Consistency read 2026-10-01
Edits since approval (`fa260e0`): tasks.md and design.md change the health route from `/api/health` to `/api/profile` (the compose healthcheck route; `/api/health` is 404). Task 4.2 boots the `api` image with `make stage-up`, which the owner runs or allows (the agent's run was refused as a deploy). Ticks and evidence were added, and blank lines inside items removed for the evidence gate.
Scope change: no
- [x] [minor] Each spec delta requirement has a task and a test: core-ports MODIFIED (contract suite on Postgres, `postgresCatalogStore.pg.test.ts`), REMOVED SQLite adapter (3.1), catalog-database MODIFIED (1.1 recorded schema, ordering and round-trip tests kept), package-architecture REMOVED and MODIFIED (3.2, 5.1), local-container-environments MODIFIED (4.1, guard case in `test_check_envs.sh`). Resolved: no gaps.
- [x] [minor] Task 3.3 also rewrote `sessionIndexStore.ts:180` ("holds the connection's lock" became SERIALIZABLE with retry), a stale comment its grep found but D6 didn't list. Resolved: within D6's rule (comments that describe the deleted adapter); recorded in 3.3's evidence.
- [x] [minor] The README edits touch the rollback note only, not the slice 11 runbook, as the non-goal's stated exception allows; `docs/supabase.md:10` ("Nothing in the app uses Supabase yet") was stale since 4c and was reworded. Resolved: docs only, no non-goal crossed.
- [x] [minor] Size is 689 counted lines, not the estimated ~600: README additions count. Resolved: within the owner's `size-override` decision (one PR, no ceiling given).
