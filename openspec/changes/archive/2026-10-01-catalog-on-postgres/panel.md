# Panel: catalog-on-postgres
Tier: 2 · Reviewers: assumption tester, failure and abuse, scope and simplicity · Date: 2026-10-01

Reviewers ran as separate subagents with fresh context. Their probes used throwaway `supabase/postgres:17.6.1.136` containers, which were removed afterwards. Logs are in the session scratchpad (`panel-at/`, `panel-fa/`).

## Scope and simplicity

- [x] [critical] The NUL delta listed team `id`, `display_name` and invite `email` as 422, but the frozen teams family says "validation errors `400`" (api-contract-freeze spec:239), and `teams.ts:26-35` maps ZodError to 400. Resolved: owner chose one rule (2026-10-01). Any NUL reaching a catalog statement is a 400 `{detail}`. The per-field 422 list is gone, and the spec has a teams 400 scenario (design D5).
- [x] [major] Three NUL layers are more than needed, and the hand-picked field list was already drifting (`event_palette_preset`). Resolved: owner chose the single adapter rule plus presence/OAuth special cases. `packages/contract` NUL edits dropped.
- [x] [major] "Starts empty" contradicted the seeded shows, and a one-off deploy note doesn't belong in a durable requirement. Resolved: removed from the catalog-database delta. It's kept in proposal and design ("only the migration's seed shows").
- [x] [major] Stripping the Google claims is an auth design choice, contrary to the recorded "reject". Resolved: owner decided (2026-10-01) that NUL in `sub`/`email` gives `token_invalid`, and NUL is stripped from names and picture.
- [x] [major] ADR 4c item `SUM`/`AVG` numeric was not addressed. Resolved: design A13, `grep` finds no SUM/AVG/TOTAL. The item is vacuous.
- [x] [major] The boot scenarios had no automated verification. Resolved: tasks 2.2 (waitForCatalog unit, budget and cutoff) and 2.3 (`bootOrder.int.test.ts` closed-port case exits 1 without listening).
- [x] [major] The Makefile order belongs to `local-container-environments`. Resolved: MODIFIED "Makefile entry points per environment" ("before starting the app"). Removed from catalog-database.
- [x] [minor] "Nothing SHALL be written" overpromises for non-transactional multi-statement routes. Resolved: the delta now says the statement isn't sent and its transaction writes nothing.
- [x] [minor] The kept scenario title "A broken connection stops a supervised server" reads oddly, and the KV no-join guarantee was dropped. Resolved: the KV sharing and no-join rule is restated under the Postgres adapter. The title stays because `openspec validate` refuses to drop a scenario from a MODIFIED block; its text says the server never uses the adapter.
- [x] [minor] The `catalogPool` test option can be cut. Resolved: removed. The integration container's limit of 200 covers the 4b defaults (design A20, D6).
- [ ] [minor] `waitForCatalog` overlaps with migrate-first plus restart. Kept: it covers db restarts on stage and dev `tsx watch` (R3), and it's bounded and tested.
- [x] [minor] Proposal and design disagreed on where the wait lives. Resolved: `server/src/waitForCatalog.ts` everywhere.
- [x] [minor] The task order cascaded (1.3 needed 2.1). Resolved: group 1 now has a red test, then wiring and harness in one green step.
- [x] [minor] The `PG*` refusal belonged in "Single-process development". Resolved: added there, with a scenario.
- [x] [minor] The 5.2 grep didn't prove the ADR edits. Resolved: it now greps "start empty", "live on dev and stage" and the new hazard numbers.
- [x] [minor] 6.2 couldn't create a session on an empty catalog. Resolved: it uses seed show `show-autolog-test`, or the admin API.
- [x] [minor] Size fits (about 180-220 counted lines). No split needed. Noted in 6.1.
- [x] [minor] Show order and README routes don't conflict with the frozen contract. Noted.

## Failure and abuse

- [x] [major] A deleted team id, recreated, can inherit memberships or invites from a concurrent invite (cross-tenant). This is not in the ADR hazard list. Resolved: owner put it in 4d (2026-10-01) as hazard 18 (foreign key or purge on create). Recorded in design R1, and ADR 0021 by task 5.2.
- [x] [major] A 500 after the hub commit when the catalog mirror write fails, and a retry duplicates the effect (Companion toggle, log events, youtube anchor). Resolved: owner put it in 4d (2026-10-01) as hazard 17. Recorded in design R1, and ADR 0021 by task 5.2.
- [x] [major] Large integers (`start_offset_frames: 1e20`) went from 200 to 500 with no authorizing delta. Resolved: design D9 bounds it to `MAX_SAFE_INTEGER`, which gives a 422. ADDED "Catalog integer fields are bounded", task 4.3.
- [x] [major] `app.onError` logs a postgres.js error's `detail`, which echoes emails and Google subject ids. Resolved: design D8 logs only code, constraint and table. Added to the catalog-database requirement, task 4.4.
- [x] [minor] The rotation doc overstated safety: reconnects fail between migrate and recreate. Resolved: rotation is one `make <env>-up`, and the window is documented (D3, spec).
- [x] [minor] Root statements have no client-side deadline. Resolved: recorded as 4d hazard 19 (design R1).
- [x] [minor] The readiness wait hid permanent misconfiguration until 30 s. Resolved: each distinct code is logged once as it appears (D2, spec, task 2.2).
- [x] [minor] Stripping NUL from email could make two addresses match, and a NUL `sub` would give a 400 mid-redirect. Resolved: owner decision, `token_invalid` for both.
- [x] [minor] Shutdown can end on the 5 s failsafe with exit 1. Resolved: recorded as R7. Harmless, because Postgres rolls back server-side.
- [x] [minor] `getStudioSettingsBlob` default writes contend under SERIALIZABLE and can exhaust retries. Resolved: recorded as 4d hazard 20 (design R1).
- [ ] [minor] Log-import progress lines show raw catalog error text to the user. Deferred to 4d's error-surface pass (design R8).
- [x] [minor] About 600 never-dropped clones use about 4.4 GB inside the test container per run. Resolved: noted in R5. The space is freed when the container is removed at teardown.

## Assumption tester

- [x] [major] Team-family fields would be 400, not 422. Resolved: covered by the scope critical above (one 400 rule).
- [x] [major] Companion presence `session_id` is stored in memory, then poisons every Companion request with a 400. Resolved: the presence route refuses NUL itself (D5, spec scenario, task 4.2).
- [x] [major] The generic 500 log leaks bind values. Resolved: design D8, task 4.4.
- [x] [major] `package-architecture` "The catalog package owns the catalog schema migrations" says the server applies the SQLite migrations at start. Resolved: MODIFIED delta, so only tests run the migrator until 4e.
- [x] [minor] `waitForCatalog` could run to about 35 s (5 s `connect_timeout`). Resolved: each attempt is raced against the remaining budget (D2, task 2.2).
- [x] [minor] Shutdown failsafe versus the 10 s transaction deadline. Resolved: R7.
- [x] [minor] The `PG*` check order versus the lock wasn't stated. Resolved: D1 checks `PG*` before the lock, and test 1.1 asserts the lock isn't held after a refusal.
- [x] [minor] The youtube reboot test must await `close()`. Resolved: D6 and task 1.2.
- [x] [minor] A6 was verified on dev only, and the running stage api is stale (no `PG*`, not on `catalog`). Resolved: `stage-up` recreates it, and task 6.3 checks the api env.
- [x] [minor] README still describes `DATA_DIR/catalog.db`. Resolved: task 5.2 updates README, which is listed in Impact.
- [x] [minor] The rotation window. Resolved with the failure-and-abuse rotation finding.

## Consistency read 2026-10-01
Edits since approval (`4a54603`): tasks.md only. The changes are ticks, `Evidence:` lines, and blank lines removed inside items so the evidence gate reads each item whole. proposal, design and the spec deltas are unchanged.
Scope change: no

Each requirement was checked against the shipped code and its tests:
- **catalog-database "The server's catalog runs on Postgres":**
  - writes land and persist: the integration suite on Postgres clones (1.2), plus the dev live check with a restart (6.2);
  - the wait for the migrated catalog: `waitForCatalog.test.ts` (`42P01` then success);
  - an unreachable catalog stops boot: `bootOrder.int.test.ts`;
  - the show order: `catalogDialect.int.test.ts`;
  - the value-free log: `unhandledErrorLog.test.ts`;
  - the rotation order: documented (5.1).
- **core-ports-architecture:** the SQLite adapter's existing suite is unchanged. The Postgres NUL guard: 4.1, unit and pg.
- **api-contract-freeze:** NUL, all six scenarios, in `nulText.int.test.ts` (plus a `sub` case). The integer bound: 4.3 (create and update).
- **web-frontend-platform:** the `PG*` refusal: `bootGuard.test.ts` and `bootOrder.int.test.ts`. Lock-before-catalog: `config.test.ts`.
- **local-container-environments:** `make -n dev-up` and `make -n stage-up` (5.1).
- **package-architecture:** `migrations.int.test.ts` runs the SQLite migrator directly.
- **Non-goals:** none crossed. There are no schema, role, network or secret changes. `packages/contract` changes only the `start_offset_frames` bound the spec authorizes. There is no import and no SQLite deletion.
- **Design against specs:** no contradictions (D2 budget and logging, D5 single 400 rule, D8 log fields, D9 bound).

- [x] [minor] "One adapter per process, shared by the stores and KV" (core-ports Sharing) has no dedicated test. Resolved: `createBindings` builds one `PostgresCatalogDb` and passes it to both `catalog` and `KvStore` (`server/src/node/config.ts`); `config.test.ts`'s no-connection case covers the construction. A test asserting object identity would only restate the wiring.
