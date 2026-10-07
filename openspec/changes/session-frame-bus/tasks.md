# Tasks

**Branch and commits**
- The first commit on `session-frame-bus` holds only `openspec/changes/session-frame-bus/`.
- The PR targets `supabase-migration`.
- The gates run with `GITHUB_BASE_REF=supabase-migration`.

**Logs and test-first**
- Logs go under the session scratchpad as `9a-<task>-<red|green>.log`, and every `Evidence:` line
  names its log.
- Each "test first" item is red before its change, or records why it already passes.
- Each task's text and its `Evidence:` stay in one block with no blank line.

**Commands**
- `cd server && npx vitest run --project unit --project integration --project pg`.
- `npx vitest run` in `packages/session-core`, `packages/storage` and `packages/catalog`.
- `cd web && npx vitest run`.
- `npm run typecheck`.
- `sh docker/supabase/test_migrate.sh`.

**Human-only steps.** Setting `FRAME_BUS_SECRET` in OpenBao, and running stage and prod, are the owner's.

## 1. Baselines

- [x] 1.1 Run the full suites on the base and record the counts. List the existing tests D8 categories 1-2 may touch: `grep -rn "closeSocketsAfterAccessLoss\|closeUserSockets\|connection limit" --include=*.test.ts server/src packages`. Known flakes (record if they recur): storage "8 contending", `catalogContention.pg` cross-team retry, `aiMcpServer` "Cap holds under concurrent calls".
  - Evidence: `cd server && npx vitest run --project unit --project integration --project pg` -> `Test Files 132 passed | 3 skipped (135)`, `Tests 1658 passed | 4 skipped (1662)` (log `9a-1.1-server.log`); `npx vitest run` in session-core -> `Tests 41 passed (41)`, storage -> `Tests 133 passed (133)`, catalog -> `Tests 50 passed (50)` (logs `9a-1.1-session-core.log`, `9a-1.1-storage.log`, `9a-1.1-catalog.log`); `cd web && npx vitest run` -> `Tests 1689 passed (1689)` (log `9a-1.1-web.log`); `npm run typecheck` -> 0 `error TS` (log `9a-1.1-typecheck.log`). No known flake recurred.
  - Evidence: the grep -> `server/src/routers/_helpers.test.ts:61` (`closeSocketsAfterAccessLoss`, category 1) and `server/src/test/session/SessionHub.int.test.ts:786-858` (`closeUserSockets`, unchanged by the move); no `connection limit` hit in tests, but `server/src/test/pg/catalogSchema.pg.test.ts:609` asserts `rolconnlimit: 20` (category 2; `:635` re-runs the old role block and keeps 20) (log `9a-1.1-grep.log`).

## 2. Connection limit (design D7)

- [x] 2.1 Test first, pg project: `rolconnlimit` for `autologger_app` is 45 (owner, after approval; first 60), the role snapshot test re-applies the migration and reads the role in one transaction, retrying once on "tuple concurrently updated" (D8 category 2), and the migration refuses when `max_connections` is below 100. Red, then add `supabase/migrations/20261013000000_app_role_connection_limit.sql`. Green, plus `sh docker/supabase/test_migrate.sh`.
  - Evidence: red, migration absent: `cd server && npx vitest run --project pg src/test/pg/appRoleConnectionLimit.pg.test.ts src/test/pg/catalogSchema.pg.test.ts` -> `Error: ENOENT: no such file or directory, open '…/20261013000000_app_role_connection_limit.sql'`, `Tests 3 failed | 24 passed (27)` (log `9a-2.1-red2.log`); green after adding it (limit 45) -> `Tests 27 passed (27)` (log `9a-2.1-green2.log`). Both tests share `server/src/test/pg/appRoleLimit.ts`: the migration and the role read in one transaction, rolled back, retried once on "tuple concurrently updated".
  - Evidence: `sh docker/supabase/test_migrate.sh` -> `test_migrate: 35 passed, 0 failed` (log `9a-2.1-migrate2.log`); full `npx vitest run --project pg` three times -> `Tests 107 passed | 1 skipped (108)` (logs `9a-2.1-pg-run1.log`, `9a-2.1-pg-run3.log`); run 2 hit the known `catalogContention.pg` cross-team retry flake (`1 failed | 106 passed`, log `9a-2.1-pg-run2.log`), rerun -> `107 passed | 1 skipped` (log `9a-2.1-pg-run2b.log`).

## 3. The port, the local bus and commands (design D1, D3, D4)

- [x] 3.1 Test first, `packages/session-core/src/frameBus.test.ts`, covering the D8 local-bus unit cases (including command validation and the rate limit). Red, then add `frameBus.ts` (`SessionFrameBus`, `BusMessage`, `LocalFrameBus`) and route `SessionHub.transaction` (publish on the raw handle `t`), `handleSocketMessage(raw, ws?)`/`broadcastCommand` and `SessionHubRegistry.deliver`/`closeAllSockets` through it, with the local bus as default. Export `SESSION_FRAME_TYPES` and `SESSION_COMMANDS` (from `companionCommandBodySchema`), and pass the socket from `server/src/routers/sessionWs.ts`. The tests cover two sockets with separate buckets, and the per-hub fallback with no socket. Green. The full session-core and server session suites pass unchanged.
  - Evidence: red: `cd packages/session-core && npx vitest run src/frameBus.test.ts` -> `Error: Cannot find module './frameBus'` (log `9a-3.1-red.log`); green -> `Tests 14 passed (14)` (log `9a-3.1-green.log`): delivery after commit in issue order, retried and failed transactions, contract-only commands, 11th command in 1 s dropped with separate per-socket buckets, the per-hub bucket without a socket, closes, `closeAllSockets`, and a supplied bus getting each attempt's raw handle, a failed publish failing the write.
  - Evidence: router: new `server/src/routers/sessionWs.commands.int.test.ts` red before `sessionWs.ts` passed the socket -> `AssertionError: expected [ 'record-toggle', …(11) ] to have a length of 10 but got 12` (log `9a-3.1-red-route.log`), green -> `Tests 1 passed (1)` (log `9a-3.1-green-route.log`).
  - Evidence: session-core `npx vitest run` -> `Tests 55 passed (55)` (41 + 14 new; log `9a-3.1-session-core.log`); `cd server && npx vitest run --project unit --project integration --project pg` -> `Test Files 134 passed | 3 skipped (137)`, `Tests 1661 passed | 4 skipped (1665)` (1658 + 2 from 2.1 + 1 route test, no existing test changed; log `9a-3.1-server.log`); `npm run typecheck` -> 0 `error TS` (log `9a-3.1-typecheck.log`).

## 4. The Postgres bus (design D2, D3, D6)

- [x] 4.1 Test first, the signing unit tests (D8): a valid message verifies; a tampered field, a wrong key, an unknown version, a bad frame type, an unknown command or a bad close code is dropped; the size is counted in bytes; sequence numbers are unique. Red, then implement the envelope and its verification in `packages/storage`. Green.
  - Evidence: red: `cd packages/storage && npx vitest run --project unit src/frameBusEnvelope.test.ts` -> `Error: Cannot find module './frameBusEnvelope'` (log `9a-4.1-red.log`); green after adding `packages/storage/src/frameBusEnvelope.ts` -> `Tests 6 passed (6)` (log `9a-4.1-green.log`).
  - Evidence: storage `npx vitest run` -> `Tests 139 passed (139)` (133 + 6; log `9a-4.1-storage.log`); `npm run typecheck` -> 0 `error TS` (log `9a-4.1-typecheck.log`); `cd server && npx vitest run --project unit src/packageBoundaries.repo.test.ts src/promiseHygiene.repo.test.ts` -> `Tests 107 passed (107)` (log `9a-4.1-repo.log`).
- [x] 4.2 Test first, `server/src/test/session/frameBus.int.test.ts` with two `'postgres'` bindings: the six `core-ports-architecture` scenarios and an unchanged revision. The forged-message case uses a second database role without the secret. The 300-session case comes in 5.1. Red, then implement `PostgresFrameBus` (listener on its own connection, `application_name` `autologger-frame-bus`, backend pid exposed; publisher connection) and the `createBindings({frameBus})` option, with `config.ts` passing `SESSION_FRAME_TYPES` and `SESSION_COMMANDS` into the bus. Green, three runs in a row.
  - Evidence: red: `cd server && npx vitest run --project integration src/test/session/frameBus.int.test.ts` -> `TypeError: m.startFrameBus is not a function`, 6 failed (log `9a-4.2-red.log`); green after `packages/storage/src/postgresFrameBus.ts` and `createBindings(procEnv, { frameBus })` -> `Tests 6 passed (6)` (log `9a-4.2-green.log`), then three runs in a row -> `Tests 6 passed (6)` each (logs `9a-4.2-run1.log`, `9a-4.2-run2.log`, `9a-4.2-run3.log`). Cases: exactly once on B and on the writer A, an unchanged revision (one step per write, carried by the frame), 2×100 interleaved writes strictly increasing on four sockets, a rollback publishes nothing, a command A to B, forged unsigned and wrong-key `pg_notify` as `postgres` dropped and logged by both processes.
  - Evidence: `cd server && npx vitest run --project unit --project integration --project pg` -> `Test Files 135 passed | 3 skipped (138)`, `Tests 1667 passed | 4 skipped (1671)` (1661 + 6; log `9a-4.2-server.log`); storage `npx vitest run` -> known flake "8 contending" (`1 failed | 138 passed`, log `9a-4.2-storage.log`), rerun -> `Tests 139 passed (139)` (log `9a-4.2-storage2.log`); `npm run typecheck` -> 0 `error TS` (log `9a-4.2-typecheck.log`).
- [x] 4.3 Test first, the two `api-contract-freeze` `1012` scenarios. Terminate only this test's listener, by its exposed backend pid: sockets close with `1012` once, and after the reconnect a write through A reaches B. Red, then implement D6. Green.
  - Evidence: deviation: the D6 re-listen close landed with 4.2's `postgresFrameBus.ts` (from the draft), so red was shown by a mutation: with `closeAllSockets(1012)` removed from `onListen`, `cd server && npx vitest run --project integration src/test/session/frameBus.int.test.ts -t "1012|after the reconnect"` -> `Error: timeout waiting for frames`, `Tests 2 failed | 6 skipped (8)` (log `9a-4.3-red.log`); restored -> `Tests 8 passed (8)` (log `9a-4.3-green.log`), three runs in a row `Tests 8 passed (8)` (logs `9a-4.3-run1.log`..`9a-4.3-run3.log`). The cases serve B's bindings on a real server: B's two browser sockets close `[1012]` once, A's stays open, the reconnect opens, and a write through A reaches it.
  - Evidence: `cd server && npx vitest run --project unit --project integration --project pg` -> `Test Files 135 passed | 3 skipped (138)`, `Tests 1669 passed | 4 skipped (1673)` (log `9a-4.3-server.log`); `npm run typecheck` -> 0 `error TS` (log `9a-4.3-typecheck.log`).

## 5. Access-loss closes inside the revoke (design D5)

- [x] 5.1 Test first, new cases in `sessionWs.access.int.test.ts` with two `'postgres'` apps:
  - a grant revoke through A closes M's socket on B with `4403`, and other sockets stay open;
  - removing a member of a 300-session team closes their socket on B;
  - an injected publish failure makes the revoke answer `500`, and the grant is still there;
  - on the local bus, every existing access-loss test keeps its observable closes (D8 category 1).
  - leaving a team through A closes the leaver's sockets on B (the sessions are listed before the membership delete, D5).
  Red, then add the catalog transaction `notify`, replace `closeSocketsAfterAccessLoss` with `publishAccessLossInTx` in the six call sites (`teams.ts`, `admin.ts`; leave pre-lists its sessions; the support-plane delete is wrapped in `catalog.tx`), and split closes at 150 ids. Green.
  - Evidence: red: `cd server && npx vitest run --project integration src/routers/sessionWs.access.int.test.ts` -> the four new two-process cases fail (`Error: timeout` for the revoke, 300-session removal and leave on B; `AssertionError: expected 200 to be 500` for the injected publish failure), `Tests 4 failed | 7 passed (11)` (log `9a-5.1-red.log`); `npx vitest run --project unit src/routers/_helpers.test.ts` -> `TypeError: publishAccessLossInTx is not a function`, 5 failed (log `9a-5.1-red-unit.log`); catalog `npx vitest run src/catalog.test.ts` -> `TypeError: cat.notify is not a function` (log `9a-5.1-red-catalog.log`).
  - Evidence: green after `Catalog.notify`, `publishAccessLossInTx`/`publishClosesInTx` in `_helpers.ts` (closes of at most 150 ids; `Ports.frameBus` is the registry's bus; local bus delivers via `afterCommit` after COMMIT), the six call sites in `teams.ts`/`admin.ts` (leave pre-lists; the support-plane delete in `catalog.tx`) -> access `Tests 11 passed (11)` three runs (logs `9a-5.1-green.log`, `9a-5.1-run2.log`, `9a-5.1-run3.log`), `_helpers.test.ts` `Tests 8 passed (8)` (log `9a-5.1-green-unit.log`), catalog `Tests 8 passed (8)` (log `9a-5.1-green-catalog.log`). The 300-session removal shows B receiving two closes of 150 ids each.
  - Evidence: D8 category 1: `_helpers.test.ts`'s three fail-closed tests of `closeSocketsAfterAccessLoss` are replaced by five `publishAccessLossInTx` tests (the fallback is removed by D5); `catalogSystem.repo.test.ts` drops the now unused `access-loss-check` allowlist entry (the binding left with the old helper). The existing access-loss route cases are unchanged except the helpers taking an optional port, and keep their closes on the local bus.
  - Evidence: `cd server && npx vitest run --project unit --project integration --project pg` -> `Test Files 135 passed | 3 skipped (138)`, `Tests 1675 passed | 4 skipped (1679)` (1669 + 4 route + 5 unit - 3 replaced; log `9a-5.1-server2.log`); session-core `Tests 55 passed (55)`, catalog `Tests 51 passed (51)` (logs `9a-5.1-session-core.log`, `9a-5.1-catalog.log`); `npm run typecheck` -> 0 `error TS` (log `9a-5.1-typecheck.log`).

## 6. Wiring, secret and docs (design D1, D2, D7)

- [x] 6.1 Test first, a boot test: with the Postgres bus, `main.ts`'s start-up refuses without a valid `FRAME_BUS_SECRET`, starts the listener before `listen()`, delivers a signed notify issued after boot, and ends both bus connections on shutdown. Red, then wire `main.ts` and add `FRAME_BUS_SECRET` to `docker/secrets-env.yaml` (dev, stage and prod pull it from there). Green. `check-envs.sh` passes.
  - Evidence: red: new `server/src/bootFrameBus.int.test.ts` (spawns `main.ts` on the test database) -> `cd server && npx vitest run --project integration src/bootFrameBus.int.test.ts` -> `Tests 3 failed (3)` (the refusals time out because `main.ts` boots; `AssertionError: expected false to be true` for the listener before listen) (log `9a-6.1-red.log`); green after `main.ts` passes `{ frameBus: 'postgres' }`, refuses `FrameBusSecretError` with exit 1 before `DATA_DIR` is touched, awaits `startFrameBus()` before `serve()`, and `close()` ends both bus connections -> with `bootOrder.int.test.ts` `Tests 7 passed (7)` (log `9a-6.1-green2.log`): missing and short secret exit 1 naming it (never the value), the `LISTEN` connection exists when it listens, a signed notify reaches a browser socket, and no `autologger-frame-bus` connection is left after SIGTERM.
  - Evidence: D8 category 3: `bootOrder.int.test.ts` "with an unreachable catalog" gets `FRAME_BUS_SECRET: 'b'.repeat(40)`; before it, that case failed `expected 'autologger: FRAME_BUS_SECRET must be …' to match /catalog not ready/` (log `9a-6.1-green.log`). `docker/secrets-env.yaml` gains `FRAME_BUS_SECRET:`; no value is set anywhere.
  - Evidence: `sh docker/scripts/check-envs.sh all` -> `check-envs: ok (all)` (log `9a-6.1-check-envs.log`); `node --test docker/scripts/compose-run.test.mjs` -> `pass 72`, `fail 0` (log `9a-6.1-compose-run.log`); `sh docker/scripts/test_check_envs.sh` -> `48 passed, 1 failed`, the same on the base with these changes stashed (invariant 4 in its clean-tree case; logs `9a-6.1-test-check-envs.log`, `9a-6.1-test-check-envs-base.log`).
  - Evidence: `cd server && npx vitest run --project unit --project integration --project pg` -> `Test Files 136 passed | 3 skipped (139)`, `Tests 1678 passed | 4 skipped (1682)` (1675 + 3; log `9a-6.1-server.log`); storage `Tests 139 passed (139)` (log `9a-6.1-storage.log`); `npm run typecheck` -> 0 `error TS` (log `9a-6.1-typecheck.log`).
- [x] 6.2 Docs:
  - README: live updates through the frame bus; the "Single Node process" invariant rewritten (writes and frames hold across processes, the topology is still one replica); the per-process connection budget of 14 and the three-process ceiling (42 of 45); `pg_notification_queue_usage()`; secret rotation needs every process restarted together.
  - `docs/security.md`: the NOTIFY forgery threat and the HMAC defence.
  - ADR 0021: the live-updates decision (line ~60), step 9 (~1078), Consequences (~1096), the 6a follow-up (~463-466, resolved here), and the "until slice 9" broadcast-order notes (~825, ~869); a 9a entry.
  - ADR 0023: a status note deferring Realtime.
  - Evidence: `grep -n` over the edited docs -> README `Live updates go through the session frame bus`, `Connections per process: 14`, `three processes (42 of 45)`, `pg_notification_queue_usage()`, `restarting **every process together**`, the invariant `Writes and frames hold across processes; the topology is still one replica`, and a `FRAME_BUS_SECRET` row in the env table; `docs/security.md` `NOTIFY forgery on the session frame bus` (threat, HMAC defence, residuals incl. replay) and the role's `45 connections`; ADR 0021 `Amended by slice 9a` (live updates), the 6a follow-up `Resolved by slice 9a`, both "until slice 9" broadcast-order notes, a step 9 `9a session-frame-bus` entry, Consequences; ADR 0023 `Status note` deferring Realtime (log `9a-6.2-docs.log`). Also `docs/supabase.md`'s role row said `at most 20 connections`; it now says 45 (14 per process).

## 7. Verify

- [ ] 7.1 Full suites as 1.1. Compare the counts and explain every difference.
- [ ] 7.2 Latency bench per D9. Record the medians.
- [ ] 7.3 Live check on the dev stack. Prerequisites: the owner sets `FRAME_BUS_SECRET` in the dev OpenBao, and a second app process runs on the same database (a second `tsx` server inside the app container on another port, or a second container). Steps:
  - a browser socket on B, and an event logged through A: the frame arrives on B;
  - kill B's listener backend: B's socket closes `1012` after it re-listens, and the browser catches up;
  - a forged `pg_notify` from `psql` as `postgres` is dropped and logged.
  Login needs the owner's temporary session row.
- [ ] 7.4 `scripts/check-change.sh` (all gates) and the tier 2 `consistency-read`.
