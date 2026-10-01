# Panel: supabase-db
Tier: 2 · Reviewers: assumption tester, failure and abuse, scope and simplicity · Date: 2026-09-30

Three fresh subagents reviewed v1 of the artifacts and did not see each other's findings. Each
resolution below points to the v2 artifacts. Findings that two or more reviewers raised are
merged and say so.

## Assumption tester

- [x] [critical] The vendored init set (`roles.sql`, `jwt.sql`, `realtime.sql`) fails initdb on every empty volume. `roles.sql` alters `supabase_functions_admin`, which only `webhooks.sql` creates. Evidence: compose up with only roles/jwt/realtime -> `99-roles.sql:7: ERROR: role "supabase_functions_admin" does not exist`, unhealthy; with `98-webhooks.sql` added -> healthy. Resolved: init SQL moved to 1.2b, next to the services that use it. Dev and stage hold no data before slice 4, and prod's `db` isn't started before cutover (proposal "Decisions (agent…)", design D2, A12).
- [x] [critical] O.1 (prod key "before cutover") breaks every `make prod-*` target on frozen `main`. Its `COMPOSE_KEYS` lacks the key, so `validateSecrets` refuses the whole environment. Evidence: `validateSecrets` with main's prod allowed set -> `refusing the Infisical environment: POSTGRES_PASSWORD [not-allowed]`. Resolved: the prod key is added only at cutover, after `main` allows it. Covered by the spec ("Ordering with frozen checkouts"), proposal Decisions and BREAKING, tasks O.1, and the design Risks and Migration Plan.
- [x] [major] Invariant 4's dev bind allowlist rejects the new `migrate` binds, and nothing planned to widen it. Evidence: design applied to a copy, then `check-envs.sh` -> `FAIL [invariant 4] dev: a read-only bind source is not under server/src, …`. Resolved: the spec's "Dev isolates data and secrets" adds exactly `docker/supabase/migrate.sh` and `supabase/migrations` (read-only, `migrate` only). Covered by design D7 and task 2.1.
- [x] [major] A7's method (empty volume only) picks a cap set that fails on the second boot. Evidence: `[SETUID, SETGID]` -> empty healthy, restart `exited 1` / `find: /var/lib/postgresql/data: Permission denied`; `[DAC_READ_SEARCH, SETUID, SETGID]` -> healthy on both. Resolved: task 2.2 tests an empty volume, a restart and a recreate, and A7 records the evidence.
- [x] [major] Invariant 16 checked env key names only, so `DATABASE_URL: postgres://u:${POSTGRES_PASSWORD}@db` on `app` passes. Evidence: `compose config --no-env-resolution` -> `{"DATABASE_URL":"postgres://u:PLACEHOLDERPW@db/x"}`. Also raised by failure and abuse. Resolved: a sentinel placeholder plus `[.. | strings | contains]` over every non-db/migrate service, statically, and the real value in `checkResolved` at run time (spec invariant 16 and Allowed names, design D4, tasks 1.1 and 2.1).
- [x] [minor] `${POSTGRES_PASSWORD:?}` fails every compose subcommand, including `down`, `ps` and `logs`, while the key is missing. Resolved: the `:?` message names the generator, break-glass gains the key (D2, D4, Risks, task 1.4).
- [x] [minor] A file with its own `COMMIT`/`BEGIN` commits partially, and `CREATE INDEX CONCURRENTLY` can't run. Also raised by failure and abuse. Resolved: transaction-control statements and meta-commands are refused before connecting, and docs/supabase.md lists what can't run in a transaction (spec "Migrations runner", D3, tasks 3.1 and 3.4).
- [x] [minor] Against the default base, task 4.1's size check counts 1.1's 888 lines. Evidence: `--only size` -> `FAIL size 888`; `--base origin/supabase-migration` -> `PASS size 0/400`. Resolved: tasks and D7 use `--base origin/supabase-migration`.
- [x] [minor] Task 1.1's "run main only when executed directly" is already done (`compose-run.mjs:435`). Also raised by scope. Resolved: dropped from 1.1 and noted in D5.
- [x] [minor] D2 omitted upstream's `command:` (`log_min_messages=fatal`). Also raised by scope. Resolved: D2 adopts it, which also keeps failed-auth text out of the logs.
- [x] [minor] A5 holds only today: Docker's default pools include 172.28.0.0/16. Resolved: recorded in Risks. The risk already exists for front/back, and it fails loudly.
- [x] [minor] D5's Infisical API calls and the claim that the viewer can't write were untested. Resolved: A15 cites 1.1's runs of both endpoints, and task 1.3 step 1 shows the viewer's 403 before the real run.

## Failure and abuse

- [x] [major] An `internal: true` bridge still gives the host a gateway IP, so host processes can connect to Postgres on 5432 and plant text in the db logs. Evidence: internal net + postgres -> `HOST_CAN_CONNECT`; with `gateway_mode_ipv4=isolated` -> `HOST_CANNOT_CONNECT`, peer still connects. Resolved: `gateway_mode_ipv4/ipv6: isolated` on every `db` network (D1, A11). Enforced by invariant 16, the container-deployment scenario, and a host-connect check in task 2.2.
- [x] [major] Invariant 16 detected password leaks by key name only. Resolved: see the assumption tester's matching major (value sentinel).
- [x] [major] Invariant 16 listed only app/api/web/router, so dev `companion` and the gates could join `db`. Also raised by scope. Resolved: "a service other than `db` and `migrate` joins the `db` network", with a `companion` test case (spec, D7).
- [x] [major] `--single-transaction` alone can be evaded: in-file `COMMIT`/`BEGIN`, `\set ON_ERROR_STOP off`, `\c`, `SET ROLE`/`search_path`, `\!`, `\i`. Resolved: meta-command and transaction-control lines are refused before connecting. The wrapper script also `RESET`s role and search_path before inserting the record, and the record is verified after every file (D3, test cases 3.1.3-3.1.4).
- [x] [major] Two concurrent runs race the check-then-apply, giving spurious failures or hangs. Resolved: `pg_advisory_xact_lock` plus an in-transaction re-check, with `lock_timeout` and `statement_timeout` (spec scenario "Concurrent runs apply each file once", D3, test 3.1.5).
- [x] [major] Duplicate versions were silently skipped forever, and the checked set and the applied set could differ (`ls | sort`, newline names, locale collation). Resolved: one `LC_ALL=C` glob enumeration, `case` name validation, refusal of duplicate prefixes and non-regular files (spec, D3, test 3.1.4).
- [x] [major] The design didn't say how the `statements` record is quoted, so sh building it risks corruption or injection. Resolved: the text reaches SQL only through psql's `:'stmts'` from a backtick `\set` over an env-named path, never through sh interpolation (D3, spec scenario "The record holds the file exactly", test 3.1.6).
- [x] [major] Nothing in code prevented migrate or psql against prod, since `compose-run.mjs` accepts any `compose` step. Resolved: the wrapper refuses `run` and `exec` for prod (spec Makefile requirement and scenario, D6, test 1.1.3).
- [x] [major] `POSTGRES_PASSWORD` was only NUL-checked, and busybox `echo` mangles values such as `-e`. A value shared with the service roles would spread the superuser password. Resolved: the format `^[0-9a-f]{32,}$` is enforced by the wrapper (spec "Allowed names" with a scenario, D4, test 1.1.2). The shared versus separate service-role password decision moves to 1.2b along with `roles.sql`, before any initdb bakes it in.
- [x] [minor] Rotation or loss of the key after initdb has no recovery path. Resolved: docs/supabase.md gives a tested procedure (`\password` over `dev-psql`, recovery from Infisical version history, reset for dev and stage) (Risks, task 3.4).
- [x] [minor] The password could reach the logs (DDL logging) or psql history. Resolved: `log_min_messages=fatal`, no init `ALTER USER` in 1.2a, `PSQL_HISTORY=/dev/null` on `dev-psql`, rotation through `\password`, and a `grep -cF` count of the password in the db logs in task 2.2.
- [x] [minor] Losing only the pgsodium config volume silently creates a new root key. Resolved: D2 and docs state the two volumes are a unit that 1.3 must back up and restore together.
- [x] [minor] Rollback step 4 didn't work after a revert. Resolved: Migration Plan resets before reverting, with an orphan and volume cleanup path if the revert came first.
- [x] [minor] `:?` blocks `down` and the break-glass procedure didn't mention the key. Resolved: see the assumption tester's matching minor.
- [x] [minor] Generator races and scope: rejected creates, listing parameters, and prod use. Resolved: a rejected create exits non-zero without PATCH or retry, the listing uses compose-run's parameters (spec, D5, tests 1.2.3-1.2.4), and prod use is the existing accepted risk with no prod creds on this host (D5).
- [x] [minor] The `ALLOW` regex rejects the new binds. Resolved: see the assumption tester's matching major.
- [x] [minor] Transaction-hostile statements, edited files and out-of-order files aren't covered. Resolved: documented in docs/supabase.md (D3, task 3.4). Hashes and drift detection are out of scope.

## Scope and simplicity

- [x] [major] Task 2.5 required `make prod-check`, which this host can't run (no prod creds) and couldn't pass before O.1. Resolved: prod is checked statically (`check-envs.sh prod`, task 2.3), `prod-check` moves to O.1 at cutover, and the `:?` message names the real fix.
- [x] [major] Invariant 16 named only four app services. Resolved: see failure and abuse.
- [x] [major] Size is borderline (an estimated 330-430 lines) and there was no fallback. Resolved: deferring the init SQL and dropping `stage-migrate` cut the count. tasks.md gives a fallback split (generator and key first, then db, runner and checks) and measures against `origin/supabase-migration`.
- [x] [minor] Three invariant 16 clauses had no test case, and D7 disagreed with task 2.1. Resolved: D7 lists one case per clause, and task 2.1 points to it.
- [x] [minor] `PGPASSWORD` in D4 wasn't in the spec. Resolved: the value-based check covers every field and name, including `PGPASSWORD`.
- [x] [minor] The proposal said `checkResolved` changes and D7 said it didn't. Resolved: it does change now (the value-leak rule), and the proposal, D4 and D7 agree.
- [x] [minor] Task 1.1 understated the `readCreds` change, since the writer file has 2 keys and `readCreds` needs 5. Resolved: D5 describes the partial option plus `checkCredFile` and a two-key parse.
- [x] [minor] `package.json` was missing from Impact. Resolved: added to proposal Impact and task 1.2.
- [x] [minor] The generator spec's "https checks" on FILE were misplaced, and the Node clause was untested. Resolved: the spec is reworded (URL from `.env.infisical.<ENV>`, FILE ownership and permissions), with test 1.2.7 for Node 22.11.
- [x] [minor] The migrations-runner scenarios said `make dev-migrate`, but only `test_migrate.sh` tested them, and the read-only mount and no-prod clauses had no check. Resolved: the scenarios say "the migrations runner". Task 3.3 adds a `make dev-migrate` failing-file run and a Makefile grep. The wrapper's prod refusal is unit-tested (1.1.3), and invariant 4 checks the read-only mount.
- [x] [minor] Vendoring the init SQL in 1.2a was overstated and could be deferred. Resolved: deferred to 1.2b (see the assumption tester's critical finding).
- [x] [minor] `stage-migrate` is optional. Resolved: dropped (`stage-up` migrates), and listed under Non-goals.
- [ ] [minor] The generator could wait for 1.2b. Open for the owner: it contradicts the owner's 2026-09-30 choice of a committed generator (proposal Decisions), so the agent kept the generator; the fallback split keeps the size in budget.
- [x] [minor] The container-deployment delta wording "only starts when a target runs it" and "shared compose file" were design detail. Resolved: reworded to "`up` never starts. No prod target runs it", and the shared-file clause is dropped.

## Approval 2026-09-30
The owner approved v2 (with the panel resolutions above), including the agent decisions in the proposal: init SQL moves to 1.2b, and the prod key waits for cutover.
