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
- [ ] 4.2 Test first, `server/src/test/session/frameBus.int.test.ts` with two `'postgres'` bindings: the six `core-ports-architecture` scenarios and an unchanged revision. The forged-message case uses a second database role without the secret. The 300-session case comes in 5.1. Red, then implement `PostgresFrameBus` (listener on its own connection, `application_name` `autologger-frame-bus`, backend pid exposed; publisher connection) and the `createBindings({frameBus})` option, with `config.ts` passing `SESSION_FRAME_TYPES` and `SESSION_COMMANDS` into the bus. Green, three runs in a row.
- [ ] 4.3 Test first, the two `api-contract-freeze` `1012` scenarios. Terminate only this test's listener, by its exposed backend pid: sockets close with `1012` once, and after the reconnect a write through A reaches B. Red, then implement D6. Green.

## 5. Access-loss closes inside the revoke (design D5)

- [ ] 5.1 Test first, new cases in `sessionWs.access.int.test.ts` with two `'postgres'` apps:
  - a grant revoke through A closes M's socket on B with `4403`, and other sockets stay open;
  - removing a member of a 300-session team closes their socket on B;
  - an injected publish failure makes the revoke answer `500`, and the grant is still there;
  - on the local bus, every existing access-loss test keeps its observable closes (D8 category 1).
  Red, then add the catalog transaction `notify`, replace `closeSocketsAfterAccessLoss` with `publishAccessLossInTx` in the six call sites (`teams.ts`, `admin.ts`), and split closes at 150 ids. Green.

## 6. Wiring, secret and docs (design D1, D2, D7)

- [ ] 6.1 Test first, a boot test: with the Postgres bus, `main.ts`'s start-up refuses without a valid `FRAME_BUS_SECRET`, starts the listener before `listen()`, delivers a signed notify issued after boot, and ends both bus connections on shutdown. Red, then wire `main.ts` and add `FRAME_BUS_SECRET` to `docker/secrets-env.yaml` (dev, stage and prod pull it from there). Green. `check-envs.sh` passes.
- [ ] 6.2 Docs:
  - README: live updates through the frame bus; the "Single Node process" invariant rewritten (writes and frames hold across processes, the topology is still one replica); the per-process connection budget of 14 and the three-process ceiling (42 of 45); `pg_notification_queue_usage()`; secret rotation needs every process restarted together.
  - `docs/security.md`: the NOTIFY forgery threat and the HMAC defence.
  - ADR 0021: the live-updates decision (line ~60), step 9 (~1078), Consequences (~1096), the 6a follow-up (~463-466, resolved here), and the "until slice 9" broadcast-order notes (~825, ~869); a 9a entry.
  - ADR 0023: a status note deferring Realtime.

## 7. Verify

- [ ] 7.1 Full suites as 1.1. Compare the counts and explain every difference.
- [ ] 7.2 Latency bench per D9. Record the medians.
- [ ] 7.3 Live check on the dev stack. Prerequisites: the owner sets `FRAME_BUS_SECRET` in the dev OpenBao, and a second app process runs on the same database (a second `tsx` server inside the app container on another port, or a second container). Steps:
  - a browser socket on B, and an event logged through A: the frame arrives on B;
  - kill B's listener backend: B's socket closes `1012` after it re-listens, and the browser catches up;
  - a forged `pg_notify` from `psql` as `postgres` is dropped and logged.
  Login needs the owner's temporary session row.
- [ ] 7.4 `scripts/check-change.sh` (all gates) and the tier 2 `consistency-read`.
