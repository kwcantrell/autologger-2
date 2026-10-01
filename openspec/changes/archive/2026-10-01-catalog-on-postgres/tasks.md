# Tasks

The first commit on `supabase-4c-catalog-on-postgres` is `openspec/changes/catalog-on-postgres/`
only. The PR targets `supabase-migration`, and the gates run with
`GITHUB_BASE_REF=supabase-migration`.

Logs: keep the full output of every test and gate run under the session scratchpad as
`4c-<task>-<red|green>.log`, and name the log in each `Evidence:` line.

## 1. Wiring and the integration suite on Postgres (design D1, D6)

- [x] 1.1 Test first, in `server/src/node/config.test.ts`, with dummy `PG*` values (nothing
  connects, A14):
  - a missing `PGPASSWORD` throws naming it, and the lock is not held afterwards (a second
    `createBindings` with full env succeeds);
  - no `catalog.db` is created;
  - `close()` returns a promise;
  - the lock still refuses a second server.
  Red: today `PG*` is ignored and `catalog.db` is created.
  Evidence: `4c-1.1-red.log`: `npx vitest run --project unit src/node/config.test.ts` ->
  `× refuses each missing PG* setting by name…`, `× opens no catalog.db, and close() returns a
  promise`, `Tests  2 failed | 9 passed (11)`. `4c-1.1-green.log` -> `Tests  11 passed (11)`.
  The old SQLite "KV purge is a boot step" case is replaced by "opens no catalog connection"
  (TCP listener, 0 connections).
- [x] 1.2 Implement it all in one step:
  - `createBindings`: `PG*` checked before the lock, one `PostgresCatalogDb`, no SQLite
    catalog or `onBroken`, async `close()`;
  - add `server/src/test/pgIntegrationSetup.ts` (shared setup, then the connection limit raised
    to 200) and wire it into the `integration` project;
  - make `resetTestEnv`/`teardownTestEnv` async with a clone per test;
  - adapt `migrations.int.test.ts` (SQLite runner only) and the youtube-import reboot test
    (async, awaits `close()`).
  Green:
  - 1.1 passes;
  - `npx vitest run --project integration` passes every file (record the wall time against
    A8's 6.6 s);
  - `npx vitest run --project pg` still passes (`rolconnlimit: 20`);
  - `npm run typecheck` is clean.
  Evidence: the first run, `npx vitest run --project integration` -> `Tests  125 failed | 471
  passed (596)`. JSON reporter: 100 failures are `PostgresError: syntax error at or near "OR"`
  (seeding memberships), and 25 are 500s logged as `42704 collation "nocase"`, i.e. task 3.1's
  dialect sites, which were fixed next. After 3.1:
  `4c-1.2-green.log` -> `Test Files  40 passed (40)`, `Tests  598 passed (598)`, `wall 31.72 s`
  (baseline 6.61 s, A8). `4c-1.2-pg.log`: `npx vitest run --project pg` -> `Tests  16 passed
  (16)` (`rolconnlimit: 20` intact). `docker ps -qf label=autologger-test-pg.pid | wc -l` after
  the runs -> `0`. `4c-1.2-typecheck.log`: `npm run typecheck` -> exit 0. `main.ts` lost
  `onBroken` and awaits `close()` here already, which typecheck needed (part of 2.3's code).

## 2. Boot (design D2)

- [x] 2.1 Test first, in `bootGuard.test.ts` and `bootOrder.int.test.ts`: a valid stack and
  `DATA_DIR` with `PGPASSWORD` unset exits 1, naming `PGPASSWORD`, printing no value, and
  creating nothing. Red, then add the `PG*` check to `checkBootEnv`. Green.
  Evidence: `4c-2.1-red.log`: `npx vitest run --project unit src/bootGuard.test.ts` -> `× refuses
  each missing or empty catalog connection setting…`, `Tests  1 failed | 5 passed (6)`. The
  `bootOrder` PGPASSWORD case already passed (`Tests  3 passed (3)`), because task 1.2's
  `createBindings` refuses before the lock. `4c-2.1-green.log` -> `Tests  17 passed (17)`
  (bootGuard + config), `Tests  3 passed (3)` (bootOrder). `CATALOG_PG_VARS` now lives in
  `bootGuard.ts`, and `config.ts` imports it.
- [x] 2.2 Test first, in `server/src/waitForCatalog.test.ts` (fake clock and fake db):
  - `ECONNREFUSED`, `42P01`, then success resolves;
  - a failure on every attempt rejects at the 30 s budget;
  - an attempt that never settles is cut off at the remaining budget;
  - each distinct code is logged once, with no message text.
  Red, then implement. Green.
  Evidence: `4c-2.2-red.log` -> `Error: Cannot find module './waitForCatalog'`, `Tests  no tests`.
  `4c-2.2-green.log` -> `Tests  4 passed (4)` (vitest fake timers).
- [x] 2.3 `main.ts`:
  - await `waitForCatalog` before `purgeExpiredAtBoot`, and exit 1 if it rejects;
  - remove `onBroken`;
  - shutdown awaits `close()`.
  Test first, in `bootOrder.int.test.ts`: `PGHOST=127.0.0.1` with a closed port exits 1 without
  ever listening (about 30 s, timeout 45 s). Red (today the server listens on SQLite), green
  after.
  Evidence: `4c-2.3-red.log`: `npx vitest run --project integration src/bootOrder.int.test.ts -t
  unreachable` -> `AssertionError: expected +0 to be 1` (45270 ms). `4c-2.3-green.log` -> `Tests  4
  passed (4)`, `tests 34.53s` (the 30 s wait plus spawn). `onBroken` is removed and shutdown
  awaits `close()` (done in 1.2). `npx vitest run --project unit src/startupPurge.test.ts` ->
  `Tests  3 passed (3)`.

## 3. Store dialect (design D4)

- [x] 3.1 Test first, in a server integration test:
  - shows `b`, `A`, `a` list as `A`, `a`, `b` (red: `42704 collation "nocase"`);
  - re-adding an existing membership through `authAddMemberships`, and through the invite
    path, succeeds with no duplicate (red: syntax error at `OR`).
  Then rewrite `showsStore.ts:178` and `authStore.ts:185,274`. Green on Postgres, and the
  `packages/catalog` tests stay green on SQLite.
  Evidence: `4c-3.1-red.log`: `npx vitest run --project integration
  src/test/catalogDialect.int.test.ts` -> `PostgresError: collation "nocase" for encoding "UTF8"
  does not exist`, `PostgresError: syntax error at or near "OR"`, `Tests  2 failed (2)`.
  `4c-3.1-green.log` -> `Tests  2 passed (2)`. `4c-3.1-catalog-sqlite.log`: `npm test -w
  packages/catalog` -> `Tests  34 passed (34)`.

## 4. NUL, integers and logs (design D5, D8, D9)

- [x] 4.1 Test first, in `postgresCatalogStore.test.ts` (stub client): a root `run` with a NUL
  bind rejects with `CatalogInvalidTextError` and sends nothing. Also a `pg` case in
  `postgresCatalogStore.pg.test.ts`: a NUL bind inside a `tx`, after a write, rejects, and the
  write is rolled back. Red, then add the guard and the export. Green.
  Evidence: `4c-4.1-red.log`: `npx vitest run --project unit src/postgresCatalogStore.test.ts`
  (packages/storage) -> `× a root statement with a NUL bind rejects…`, `AssertionError: promise
  resolved "{ changes: 1 }" instead of rejecting`, `× inside a transaction…`. `4c-4.1-green.log`:
  `npx vitest run` (unit + pg) -> `Test Files  7 passed (7)`, `Tests  97 passed (97)`.
  `npx vitest run --project pg -t NUL` -> `Tests  1 passed`. The pg case was not run red on its
  own; without the guard, Postgres's `22021` PostgresError is not a `CatalogInvalidTextError`
  (A1), so it fails the `toBeInstanceOf` assertion.
- [x] 4.2 Test first, in server integration tests:
  - `POST` show with a NUL `name` gives 400 `detail`, and no show exists;
  - `POST /api/teams` with a NUL `display_name` gives 400;
  - a team route with `%00` in the id gives 400;
  - presence with a NUL `session_id` gives 400, and `GET /api/companion/state` shows no such
    presence;
  - an OAuth callback with `state=a%00b` gives `state_invalid`;
  - first sign-in with a NUL `email` gives `token_invalid` and no user;
  - with a NUL `given_name`, the user is created and the stored name is stripped.
  Red, then:
  - add the `app.onError` mapping;
  - refuse NUL in the presence route;
  - refuse NUL in `takeOauthState`;
  - add the claim checks in `auth.ts`.
  Green.
  Evidence: `4c-4.2-red.log`: `npx vitest run --project integration
  src/routers/nulText.int.test.ts` -> `Tests  8 failed (8)`: `expected 500 to be 400` ×3,
  `expected 500 to be 302` ×4, `expected 200 to be 400` (presence), `unhandled error
  CatalogInvalidTextError` ×7. `4c-4.2-green.log` -> `Tests  8 passed (8)`.
- [x] 4.3 Test first, in a server integration test: creating a session with
  `start_offset_frames: 1e20` gives 422, and none is created (red: 500 `22003`). Add `.max(MAX_SAFE_INTEGER)`
  on create and update. Green.
  Evidence: `4c-4.3-red.log`: `-t MAX_SAFE` -> `unhandled error PostgresError: value
  "100000000000000000000" is out of range for type bigint`, `expected 500 to be 422`.
  `4c-4.3-green.log`: `src/routers/sessions.int.test.ts` -> `Tests  33 passed (33)` (update case
  uses `2 ** 53`).
- [x] 4.4 Test first, in a unit test on the error handler: a thrown error shaped like
  postgres.js's `{name, code: '23505', constraint_name, table_name, detail: 'Key (email)=(x@y)…'}`
  gives a 500, and the captured log has the code and constraint but not `x@y`. Red, then
  redact. Green.
  Evidence: `4c-4.4-red.log`: `src/unhandledErrorLog.test.ts` (through the real `wireApp`) ->
  `expected 'unhandled error {"name":"PostgresErro…' not to match /x@y\.example/`.
  `4c-4.4-green.log` -> `Tests  2 passed (2)`. Whole server suite `4c-4-server-all.log`: `npx
  vitest run` -> `Test Files  67 passed | 2 skipped (69)`, `Tests  879 passed | 3 skipped (882)`;
  `npm run typecheck` -> exit 0.

## 5. Ops, docs and the retry note (design D3, D7)

- [x] 5.1 Reorder `dev-up` and `stage-up` in the `Makefile`. Document the rotation (D3) in
  `docs/supabase.md`. Verify with `make -n dev-up` and `make -n stage-up`: the migrate step
  comes before `up`.
  Evidence: `make -n dev-up` -> `… compose-run.mjs dev resolved 'compose run --rm migrate' 'compose
  up -d --build' urls`; `make -n stage-up` -> `… stage resolved 'compose run --rm migrate' 'compose
  up -d --build' urls`. `make check` -> `check-envs: ok (all)`. The rotation and the server's
  catalog boot behaviour are in `docs/supabase.md` "The catalog schema"; the test section names
  the integration project and its connection-limit raise.
- [x] 5.2 Doc comments: `Catalog.tx` and the port's `tx` (the body may re-run and must stay
  database-only), plus the `harness.ts`, `config.ts` and `auth.int.test.ts:521` comments.
  Update the `catalog.db` lines in `README.md`. In ADR 0021, record:
  - the 4c items closed;
  - start empty;
  - the hazards live on dev and stage;
  - hazards 17-20 added to 4d.
  Verify with `grep -n "catalog\.db" README.md` (only the slice 11 import and legacy
  mentions remain) and
  `grep -n "start empty\|live on dev and stage\|17\.\|20\." docs/decisions/0021-*.md`.
  Evidence: `grep -n "start empty\|live on dev and stage\|   17\.\|   20\." docs/decisions/0021-*.md`
  -> `169: 17. handlers commit to the session hub…`, `178: 20. getStudioSettingsBlob…`, `181: Since 4c
  these hazards are live on dev and stage…`, `215: - start empty (owner, 2026-10-01)…`.
  `grep -n "catalog\.db" README.md` -> 81 (pre-4c history), 477 (legacy file, not opened), 883
  (legacy file untouched), and 1079-1356 (prod host backup and cutover runbook; prod runs `main` on
  SQLite until cutover). `Catalog.tx` notes the re-run rule (the port already had it from 4b).
  Comments are refreshed in `auth.int.test.ts` and `startupPurge.ts`.

## 6. Integration checks

- [x] 6.1 `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --stage hook` is green,
  including size (the panel estimates 180-260 counted lines).
  Evidence: `4c-6.1-hook.log` -> exit 0; `PASS  risk-floor  8 high-risk path(s) touched`, `PASS
  evidence`, `PASS  size  248/400 changed lines`, `PASS  commands  ran ['typecheck', 'test']`.
- [x] 6.2 Dev stack:
  - Record `catalog.db`'s mtime and size first, then run `make dev-up` (migrate first, image
    rebuilt).
  - The app is healthy, and the app logs have no catalog errors.
  - Create a session for the migration's seed show `show-autolog-test` with `POST
    /api/sessions` (as the 3d live checks did; if dev's access rules refuse it, first create a
    team and show through the admin API with dev's `ADMIN_TOKEN`), then `GET` it.
  - `make dev-restart`, and the session is still listed.
  - `catalog.db`'s mtime and size are unchanged.
  Evidence: before `stat /data/catalog.db` -> `98304 1790887796`. `make dev-up` -> exit 0;
  `4c-6.2-devup.log` shows the migrate run (`skipped 20261001000000`, `0 applied`) before the
  containers start. The app is `healthy`, and its log has `AutoLogger (Node) listening` with no
  catalog errors. `GET /api/studio` -> `test-studios`, and `GET /api/shows?studio_id=test-studios`
  lists `show-autolog-test`. `POST /api/sessions` -> `{"id":"0475a376-…","title":"ATS_4c-live",…}`;
  `GET /api/sessions/<id>` -> `200`. `make dev-restart` -> exit 0, `healthy`, and the session is
  still listed. `psql … select id, title from catalog.sessions` -> `0475a376-…|ATS_4c-live`. After:
  `stat` -> `98304 1790887796` (unchanged).
- [x] 6.3 Stage: `make stage-up`, and the api env has `PG*`. Then
  `docker/scripts/test_router.sh stage` passes all cases.
  Evidence: `make stage-up` -> exit 0 (`4c-6.3-stageup.log`), `Container autologger-stage-api
  Healthy`. `docker exec autologger-stage-api env | grep ^PG` -> `PGHOST=db`,
  `PGUSER=autologger_app`, `PGDATABASE=postgres`, `PGPORT=5432`, `PGPASSWORD=<set>`. The api log
  has `AutoLogger (Node) listening on http://0.0.0.0:8787` with no catalog errors.
  `docker/scripts/test_router.sh stage` -> `test_router: 67 passed, 0 failed` (`4c-6.3-router.log`).
- [x] 6.4 Run `consistency-read` over the artifacts against the shipped code, then archive.
  Evidence: `panel.md` "Consistency read 2026-10-01": edits since `4a54603` are tasks.md only, no
  scope change, every requirement maps to a test or check, 1 minor finding resolved.
  `scripts/check-change.sh --only panel` -> `PASS  panel  42 finding(s), no open criticals`.
  The archive follows in its own commit.
