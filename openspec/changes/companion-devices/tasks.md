# Tasks

**Branch and commits**
- The first commit on `companion-devices` holds only `openspec/changes/companion-devices/`.
- The PR targets `supabase-migration`.
- The gates run with `GITHUB_BASE_REF=supabase-migration`.

**Logs and test-first**
- Logs live under the session scratchpad as `9d-<task>-<red|green>.log`, and each `Evidence:` line
  names its log.
- Each "test first" item is red before its change, or records why it already passes.
- Each task's text and its `Evidence:` stay in one block with no blank line.

**Commands**
- Targeted tests while working (ADR 0026): `cd server && npx vitest run --project <unit|integration|pg> <files>`.
- Packages: `npx vitest run` in `packages/ports` and `packages/contract`; `cd packages/storage && npx vitest run --project <unit|pg> <files>`; `cd companion && npx vitest run` (or the module's test command).
- `cd web && npx vitest run`.
- `npm run typecheck`.
- Migrations: `sh docker/supabase/test_migrate.sh`.
- The full pg/integration suites run in CI on the PR (ADR 0026; owner preference: no local full DB runs). Locally, only the targeted tests being written, plus the unit suites and typecheck.

**Changing tests.** Changing an existing test is allowed only for the categories in design D9.
Anything else is a stop: update the artifacts and ask the owner.

## 1. Baselines

- [x] 1.1 Run the unit suites (server, packages, web, companion) and typecheck on the base, and record the counts. The DB-suite baseline is the last full CI run (PR #92, run 37658455529: server pg+integration 1394, storage pg 92). List every existing test that D9 categories 1-6 may touch, using `grep -rln "COMPANION_BEARER\|API_TOKEN\|apiTokenAuth\|requestHasValidApiToken\|companion-token\|setCompanionPresence\|presence.upsert\|PresenceRegistry\|companion:last_command\|sweepLeasesOnce\|relname !== 'kv'\|table !== 'kv'\|toHaveLength(37)\|Event buttons'" --include=*.test.ts --include=*.test.tsx --include=*.sh server/src packages web/src companion docker/scripts`. Classify each hit by category, or as unchanged.
  - Evidence: base `615e496d` (code = `4986cdc1`). `cd server && npx vitest run --project unit` -> `Tests  348 passed | 3 skipped (351)`; `npx vitest run` in session-core -> `Tests  55 passed (55)`, ai-runtime -> `Tests  199 passed (199)`, transcription -> `Tests  70 passed (70)`, media-import -> `Tests  31 passed | 2 skipped (33)`, log-import -> `Tests  41 passed (41)`, ports -> `Tests  1 passed (1)`, contract -> `Tests  98 passed (98)`, catalog -> `Tests  51 passed (51)`, domain -> `Tests  50 passed (50)`; `cd packages/storage && npx vitest run --project unit` -> `Tests  60 passed (60)`; `cd web && npx vitest run` -> `Tests  1898 passed (1898)`; `cd companion && npx vitest run` -> `Tests  21 passed (21)`; `npm run typecheck` -> exit 0, 0 `error TS` (log `9d-1.1-baseline.log`). DB baseline: the last full run, PR #92 CI run 37658455529: server pg+integration `Tests 489 + 374 + 531 passed | 1 skipped` (1394), storage pg `Tests 92 passed (92)`.
  - Evidence: the grep matches 27 files (log `9d-1.1-grep.log`). Category 1 (Bearer setup -> `seedCompanionDevice`): `companion.int`, `companion-ws.int`, `apiToken.int` (the whole file, API_TOKEN scope -> device-token scope), `gate.int:90`, `authz.int` (wrong-token, outside-`/api/companion/` and encoded-spelling cases), `nulText.int:127` (state read), `versions.int`, `versionChecks.int`, `sessionHub.interleave.int`, `SessionHub.int`, `upgradeDispatch.int`, `catalogPolicies.int:616` (the bearer `/state` read); plus the non-test `test/helpers.ts` `COMPANION_BEARER` and `test/harness.ts` `API_TOKEN`. Category 2 (presence helpers gain `user_id`): every `setCompanionPresence` caller above, `access.int:302` and `catalogBinding.int:101` (`presence.upsert`), and `server/src/node/presence.test.ts` (replaced by storage pg tests). Category 3: `companion.int:238` (global pick across studios -> per-user), `authz.int:22` "reaches a session in a studio it is not a member of" and `catalogBinding.int:99` `system:companion-token` (-> device-as-user access), and the `aiV2.int:524-560` principal-less refusal block. Category 4: `catalogSystem.repo.test.ts:113`. Category 5 and 8: `catalogSchema.pg.test.ts` (snapshots; `relname !== 'kv'` at :716). Category 6: `upgradeDispatch.test.ts:36`, `aiV2.int.test.ts:327`. Category 7: `companion.int:335` (bearer `closing` post), `nulText.int:118` (bearer presence post). Category 8: `catalogPolicies.pg.test.ts:576` (`toHaveLength(37)`) and `:588` (`table !== 'kv'`). Category 9: `identity.test.ts` (`requestHasValidApiToken`), `_helpers.test.ts:28` (`apiTokenAuth`), `leaseSweeper.int:78` (`sweepLeasesOnce` deps), and the `aiV2.int` "API_TOKEN is inert" cases (:530, :906, :1333, :1380). Category 10: `SettingsView.test.tsx:132`. Category 12: `docker/scripts/test_router.sh`. Unchanged: `eventGenerateLatch.test.tsx:617` (Settings text only), `packages/ai-runtime/src/aiV2PendingQuestions.test.ts:161` (a title naming API_TOKEN; pure ai-runtime logic). For the owner, three spots near the edge of the categories: `companion.int:251` and `:346` read the kv key `companion:last_command`, which becomes per device (D3) and no category names it; `access.int:302` and `catalogPolicies.int:588` seed presence for a teammate/other user and read `/state` with a cookie, a premise decision 9 changes beyond adding a `user_id`; and the 9.1 completion grep over `packages/*/src` also matches the `aiV2PendingQuestions.test.ts:161` title. The companion module's `api.test.ts` is not a grep hit, and D7 may touch it in task 8.1.

## 2. Tables (design D1)

- [x] 2.1 Test first, in `catalogSchema.pg.test.ts` (D9 category 5) and new pg tests:
  - both tables and their columns, checks and indexes exist;
  - both tables are invisible to `catalog_user` (select, insert, delete give `42501`);
  - deleting a user cascades;
  - deleting a session nulls `session_id`;
  - the migration deletes the old global `companion:last_command` key.
  Red, then add `supabase/migrations/20261015000000_companion_devices.sql`. Green, plus `sh docker/supabase/test_migrate.sh`.
  - Evidence: red, `cd server && npx vitest run --project pg src/test/pg/companionTables.pg.test.ts src/test/pg/catalogSchema.pg.test.ts src/test/pg/catalogPolicies.pg.test.ts` -> `PostgresError: relation "catalog.companion_devices" does not exist`, `expected [ 'app_settings', 'kv', …(19) ] to deeply equal [ 'app_settings', …(22) ]`, `select count(*) from companion_devices: expected PostgresError: relation "companion_device…" to match object { code: '42501' }`, `× matches the recorded catalog schema`, `× creates both tables empty and deletes only the old global last-command kv entry`, `Test Files  3 failed (3)`, `Tests  16 failed | 52 passed (68)` (log `9d-2.1-red.log`); green, the same three files -> `Test Files  3 passed (3)`, `Tests  68 passed (68)`; `npm run typecheck` -> exit 0, 0 `error TS` (log `9d-2.1-green.log`); `sh docker/supabase/test_migrate.sh` -> `test_migrate: 35 passed, 0 failed` (log `9d-2.1-migrate.log`). DB tests ran locally against the test Postgres container (targeted files only, ADR 0026).
  - Evidence: `supabase/migrations/20261015000000_companion_devices.sql` creates both tables exactly as D1 (columns, `on delete cascade` / `on delete set null`, the name and client id checks, unique `token_hash`, `idx_companion_devices_user`, `idx_companion_presence_user (user_id, updated_at_ms)`), enables RLS with one `<table>_system_all` policy for `catalog_system`, `revoke all … from catalog_user` on both (the kv pattern), grants nothing to `anon`, `authenticated` or `public`, and ends with `delete from catalog.kv where key = 'companion:last_command'`; the header gives the rollback (`drop table` both, after reverting the code). New `server/src/test/pg/companionTables.pg.test.ts` (7 cases): no `catalog_user` privilege and only the allow-all system policy on each table; a `catalog_user` binding gets `42501` on select, insert, update and delete of both, even on its own rows; `catalog_system` reads and writes any user's rows; a deleted user takes their devices and presence; a deleted session nulls `session_id` and keeps the row; `23505` on a duplicate `token_hash`, `23514` on a blank or 81-character name and a blank or 257-character client id, `23503` on an unknown user or session; the migration replay keeps `companion:last_command:d1` and `other`, deletes only `companion:last_command`, and leaves both tables empty. Existing tests: D9 category 5, `catalogSchema.pg` `TABLES`, `KEY_COLUMN` and the recorded schema gain the two tables (columns, keys, `$unique`, `$checks`, `$indexes`), so the per-table "as catalog_system, reads and writes every catalog table" case gains one insert into each (its loop reads every table in `TABLES`); D9 category 8, `catalogSchema.pg:716` `relname !== 'kv'` becomes `!SYSTEM_ONLY.includes(relname)`, `catalogPolicies.pg` "every table except kv…" also checks the two tables and expects no `catalog_user` policy on all three, and its `toHaveLength(37)` is unchanged (the tables add no user policy; comment only).

## 3. Presence on Postgres (design D4)

- [ ] 3.1 Test first, storage pg tests for `PostgresPresence`:
  - upsert, then list within 15 s;
  - stale rows excluded;
  - upsert changes the user;
  - an upsert for another user's live client id changes nothing, a stale one is taken over;
  - `remove` deletes only the caller's own row;
  - `list(userId)` is inclusive at the 15 s edge and returns only that user's rows;
  - a null `session_id` is stored as NULL;
  - `deleteOlderThan`.
  Plus `startupPurge.test.ts` sweeper cases: the presence step runs first, warns on failure, and still runs when the recording listing fails.
  Plus the port change (`user_id`, `list` rows with `client_id`). Red, then add the port change, the storage implementation on `bindSystem('companion-presence')`, the wiring in `node/config.ts`, the deletion of `server/src/node/presence.ts`, and the sweeper step in `sweepLeasesOnce`. Green. Existing presence tests change only under D9 categories 2 and 4.

## 4. Device store and authentication (design D2)

- [ ] 4.1 Test first: unit tests for token generation and hashing. Storage pg tests for `CompanionDeviceStore`: lookup by hash joins an enabled user; a disabled user misses; a device idle past 90 days misses and a use renews it; the throttled `last_used_at_utc` update; list, create and delete scoped by `user_id`. Red, then add them on `bindSystem('companion-device')`. Green.
- [ ] 4.2 Test first, integration:
  - device auth on the five Companion routes;
  - 401 for an unknown token, a revoked device, a disabled user and the old `API_TOKEN` value;
  - the scope matrix: other routes 401, the WS upgrade refused, encoded spellings refused;
  - a Bearer present ignores a cookie;
  - a device idle past 90 days gets 401;
  - the audit log lines carry the user and device ids and never the token.
  Red, then change `authContext`, remove `API_TOKEN` (`Config`, `env.ts`, `identity.ts`, `.env.example`, `docker/.env*.example`), keep `API_TOKEN` in `docker/secrets-env.yaml` marked ignored, rename `apiTokenAuth` to `companionDevice`, and delete the AI v2 principal-less refusal. Add the `seedCompanionDevice` helper and move the existing Bearer tests to it (D9 categories 1, 3 and 6). Add the ALLOWLIST entry (D9 category 4). Green.

## 5. Companion routes as the device's user (design D3)

- [ ] 5.1 Test first, integration:
  - a device follows only its user's presence;
  - a cookie caller sees only their own presence rows;
  - a session the device's user lost access to gives the masked 409;
  - a cookie caller with a fresh own row on a session they can't access gets the masked no-active-session answer on all five routes (state, categories, log, transport, command);
  - `connected_clients` and `is_playing` are scoped;
  - `last_command` and `ack` are per device, and a cookie caller reads `null` and acks `{ok:false}`;
  - a device caller gets 403 on presence POST;
  - presence ownership: another user's post or `closing` for a live client id changes nothing and answers `200`;
  - a blank or NUL `client_id` gives 400, and a null `session_id` stores no session;
  - two processes: presence posted on app A, `/state` with the device on app B names the session.
  Red, then rewrite `companion.ts` (delete the `companion-token` callers, scope `primarySession`, per-device key, presence 403) and remove `companion-token` from the ALLOWLIST. Green. Existing companion tests change only under D9 categories 1-4.

## 6. Device management routes (design D5)

- [ ] 6.1 Test first: contract schema tests for the three routes' request and response shapes. Integration tests:
  - create returns 201 with a token, list omits it and shows `expired`, delete returns 204;
  - a name over 80 characters gives 422, and a NUL gives 400;
  - the 11th device gives 409, including under two concurrent creates;
  - another user's id gives 404;
  - a device token on these routes gives 401;
  - only the sha256 is stored.
  Red, then add `packages/contract` schemas and `server/src/routers/companionDevices.ts`, and mount it. Green.

## 7. Web Settings section (design D6)

- [ ] 7.1 Test first, web tests:
  - the list renders, with "Never" for an unused device;
  - Add shows the token once in a dialog with Copy and the warning, and it is gone after close and absent from the query cache;
  - Revoke asks for confirmation, deletes and refreshes;
  - the error `{detail}` is shown;
  - the types conform to the response shapes.
  Red, then add the hooks, types and `CompanionDevicesSection.tsx`, and register the section. Green.

## 8. Companion module (design D7)

- [ ] 8.1 Test first, module unit tests:
  - the upgrade script moves `config.token` into secrets, is a no-op when there is nothing to move or it already moved;
  - `init` and `configUpdated` read `secrets.token`;
  - the 401 status text.
  Red, then change `companion/src/{config,main,upgrades,api}.ts` and `HELP.md`, and bump the module version. Green, plus the module build and package (`npm run build && npm run package` in `companion`).

## 9. Docs and verify

- [ ] 9.1 README (endpoint table, Companion setup, dev Companion, module section, `API_TOKEN` rows, the token-only bullets), `docs/openbao-secrets.md`, and ADR 0021 (§5a, §6 decision 6, §9 9d). Also `docs/supabase.md`, the `compose.yaml` comment, and stale code comments (`useCompanionPresence.ts`, `aiV2PendingQuestions.ts`, the `fakeClock.ts` copies). Done when `grep -rn "API_TOKEN\|companion-token\|token-only\|node/presence" README.md docs compose.yaml web/src packages/*/src` prints only lines that say it is ignored or retired.
- [ ] 9.2 Unit suites, typecheck and `openspec validate --all --strict` locally. The pg/integration suites come from the PR's CI run. Compare the counts with 1.1 and explain every difference.
- [ ] 9.3 Latency (D10): device-auth lookup and presence upsert/list medians. Recorded only.
- [ ] 9.4 Live check on the dev stack, with the owner's temporary login row:
  - create a device in Settings and paste its token into the dev Companion connection (the owner does this in the Companion UI, or the module is checked with the token over HTTP);
  - with a second app process, a presence posted through A is followed by `/state` through B;
  - a Companion command reaches the browser;
  - after revoke, the next Companion request gets 401;
  - the old `API_TOKEN` gets 401.
- [ ] 9.5 `scripts/check-change.sh` (all gates) and the tier 2 `consistency-read`.
