# Tasks

The first commit on `supabase-4e-retire-sqlite-catalog` contains only
`openspec/changes/retire-sqlite-catalog/`. The PR targets `supabase-migration`, and the gates run
with `GITHUB_BASE_REF=supabase-migration`. The PR needs the owner's `size-override` label: about
600 counted lines, mostly deletions (owner, 2026-10-01).

Logs:
- Keep the full output of every test and gate run under the session scratchpad as
  `4e-<task>-<red|green>.log`, and name the log in each `Evidence:` line.
- Each "test first" item is red before its change (record the failure line) and green after.
- A deletion task is evidenced by the suite that still covers the behaviour, plus a grep showing
  the deleted name is gone.

## 1. Record the schema before SQLite goes (design D3)

- [x] 1.1 Test first: in `server/src/test/pg/catalogSchema.pg.test.ts`, add `it('matches the
  recorded catalog schema')`. It asserts a literal `EXPECTED_SCHEMA`:
  - per table: ordered columns with `data_type`, `collation_name`, `is_nullable` and
    `column_default`;
  - primary key columns;
  - foreign keys with every column, as `cols->table.cols ON_DELETE`;
  - the unique constraint;
  - each `idx_*` index's full `indexdef`;
  - `it('seeds the recorded shows')` with the two literal `row_to_json` rows.
  Steps:
  1. Run once with an empty literal (red: the diff shows the actual schema).
  2. Fill the literal from that output.
  3. Run the whole file in one vitest invocation. The new tests and the existing SQLite parity
     tests are green in that same run, which is the evidence log, so the literal equals the
     SQLite catalog (migrations 0001-0006).
  Evidence: `4e-1.1-red.log`: `npx vitest run --project pg src/test/pg/catalogSchema.pg.test.ts`
  with empty literals -> `× matches the recorded catalog schema`, `× seeds the recorded shows`,
  `Tests  2 failed | 14 passed (16)`. `4e-1.1-green.log`: the same single invocation after
  filling the literals (4 `CREATE INDEX` defs, full `FOREIGN KEY` defs) -> `Tests  16 passed (16)`,
  the SQLite parity tests and the literal tests green together.
- [x] 1.2 Remove the SQLite side of `catalogSchema.pg.test.ts`:
  - the `lite` setup, `LiteCol` and `PG_TYPE`;
  - the column parity test and the key parity test;
  - the SQLite seed-show test;
  - the `CATALOG_MIGRATIONS_DIR`, `applyMigrations`/`openCatalogDb` and `better-sqlite3` imports.
  Drop "as SQLite does" from the ordering test name, and rewrite the header comment. The file
  stays green on Postgres alone.
  Evidence: `4e-1.2-green.log`: `npx vitest run --project pg src/test/pg/catalogSchema.pg.test.ts`
  -> `Tests  13 passed (13)`; `npx tsc --noEmit -p server` -> no output; `rg -n "lite|SQLite"
  server/src/test/pg/catalogSchema.pg.test.ts` -> only the D3 provenance comments.

## 2. Shared error classes and KvStore tests on Postgres (design D1, D2)

- [x] 2.1 Test first: add `packages/storage/src/kvStore.pg.test.ts`, following design D2:
  - each case runs on a `createTestDatabase()` clone through `PostgresCatalogDb` as
    `autologger_app`;
  - every case uses a plain mutable-`now` clock (no `vi.useFakeTimers()`, no `makeFakeClock`);
  - the adapter is closed in `afterEach`.
  Port every behaviour of `kvStore.test.ts`, with the two TTL blocks merged and these
  restatements:
  - the guarded expiry delete, with a wrapper that re-puts between `get`'s `SELECT` and
    `DELETE`;
  - two concurrent takes, with no held transaction: exactly one gets the value;
  - a key/value write made while a catalog transaction is open survives that transaction's
    rollback, and the transaction's own row does not.
  Red check: temporarily break the code, and each matching case fails. Then restore it, and the
  cases pass:
  - drop `replaceIf`'s `WHERE value = ?`;
  - make `take` skip its delete;
  - drop the expiry delete's `expires_at <= ?` guard.
  Then delete `kvStore.test.ts`.
  Evidence: `4e-2.1-green.log`: `npx vitest run --project pg src/kvStore.pg.test.ts` (in
  packages/storage) -> `Tests  13 passed (13)`. Red checks, each restored after:
  `4e-2.1-red-replaceIf.log` -> `× replaces only when the stored value is the expected one`,
  `Tests  2 failed | 11 passed`; `4e-2.1-red-take.log` -> `× two concurrent takes: exactly one gets
  the value`, `Tests  3 failed | 10 passed`; `4e-2.1-red-guard.log` -> `× a key re-put between an
  expired get's read and its delete survives`, `Tests  1 failed | 12 passed`. `kvStore.test.ts`
  removed with `git rm`.
- [x] 2.2 Add `packages/storage/src/catalogErrors.ts` with `CatalogTxMisuseError`,
  `CatalogTxTimeoutError` and `CatalogAdapterBrokenError`, and re-export it from `index.ts`.
  Names, messages and `name` fields stay the same. Doc comments that describe SQLite connections
  are reworded.
  Evidence: `4e-2.2-tsc.log`: `npx tsc --noEmit` (packages/storage) -> exit 0;
  `4e-2.2-green.log`: `npx vitest run` (packages/storage, unit + pg) -> `Test Files  7 passed (7)`,
  `Tests  98 passed (98)`. The SQLite adapter imports the moved classes until 3.1 deletes it.
  - Point `postgresCatalogStore.ts`, `test/catalogDbContract.ts`, `postgresCatalogStore.test.ts`
    and `postgresCatalogStore.pg.test.ts` at it.
  - Storage typecheck plus the unit and pg projects are green.

## 3. Delete the SQLite catalog (design D4, D6)

- [x] 3.1 Delete `packages/storage/src/asyncCatalogStore.ts` and `asyncCatalogStore.test.ts`.
  Drop `pendingAfter` from `test/catalogDbContract.ts`: only the SQLite test imports it, and
  `server/src/test/gatedCatalog.int.test.ts` has its own local copy. Drop the export from
  `index.ts`.
  - Evidence: storage unit and pg projects green, plus
    `rg -n AsyncSqliteCatalogDb packages server web test` → no hits.
  Evidence: `4e-3.1-green.log`: `npx vitest run` (packages/storage) -> `Test Files  6 passed (6)`,
  `Tests  72 passed (72)`; `npx tsc --noEmit` -> exit 0. `rg -n AsyncSqliteCatalogDb packages server
  web test` -> no hits once 3.3's comment edits landed (before them: 3 comment-only hits).
- [x] 3.2 Delete:
  - `packages/storage/src/migrate.ts` and `migrate.test.ts`;
  - `server/src/test/migrations.int.test.ts`;
  - `packages/catalog/migrations/`;
  - `CATALOG_MIGRATIONS_DIR` and its `fileURLToPath` import in `packages/catalog/src/index.ts`.
  Drop the `migrate` export.
  - Evidence: `npm run typecheck` green, plus
    `rg -n "applyMigrations|openCatalogDb|CATALOG_MIGRATIONS_DIR|catalog/migrations" packages
    server web test docker` → only the hits task 4.1 removes.
  Evidence: `4e-3.2-tsc.log`: `npm run typecheck` -> exit 0. `4e-3.x-npmtest-2.log`: `npm test`
  -> exit 0; server `Tests  910 passed | 3 skipped (913)`, storage, web and the rest green. The
  first full run (`4e-3.x-npmtest.log`) had one failure, `× concurrent same-clock creates for the
  same show never duplicate a title`: a 500 from `PostgresError` `40001` once the 3 runs were
  spent. That path changed by comment only. The test passes 8/8 alone (`4e-flake-1..8.log`); it is
  the 4d retry-exhaustion residual on ADR 0021's revisit list, reported to the owner. The grep's
  remaining hits are README (5.1) and docker (4.1) only.
- [x] 3.3 Update the comments that name deleted code (design D6):
  - `packages/ports/src/catalogDb.ts` and `ports/src/kvStore.ts:4`;
  - storage `index.ts` header and `kvStore.ts` (lines 3-5 and 31-32);
  - `postgresCatalogStore.ts` (lines 2, 147, 338);
  - the `catalog/src/index.ts` header;
  - `showsStore.ts` (lines 47-48, 179, 198) and `authStore.ts:422`;
  - the three `fixturesDir.ts` notes;
  - `session-core/src/fakeClock.test.ts:6`;
  - the `packageBoundaries.repo.test.ts` exemption note.
  - Evidence: the repo tests green, plus
    `rg -n -i "AsyncSqlite|asyncCatalogStore|async catalog adapter|applyMigrations|openCatalogDb|CATALOG_MIGRATIONS_DIR|catalog/migrations|migrate\.ts|connection's lock" packages server web test docker README.md`
    → no hits outside the README slice 11 runbook.
  Evidence: the same `npm test` run (`4e-3.x-npmtest-2.log`, repo tests included) -> exit 0. The
  grep (without README and docker, which are tasks 4.1/5.1) -> no hits. Also fixed
  `sessionIndexStore.ts:180` ("holds the connection's lock" -> SERIALIZABLE with retry), which the
  grep found.

## 4. Dev image and compose (design D5)

- [x] 4.1 Test first: add a guard case to `docker/scripts/test_check_envs.sh`. A dev config with a
  read-only bind of the existing non-`src` path `packages/catalog/package.json` is expected to
  fail `invariant 4] dev` on the ALLOW rule. The path exists, so the existence loop can't be what
  refuses it.
  - The case pins the rule against widening.
  - Red check: temporarily widen ALLOW to `packages/[a-z0-9-]+/.*`, and the case fails. Restore
    it.
  Then:
  - drop the mount from `compose.dev.yaml`;
  - delete check 5's migrations assertion;
  - narrow check 4's allow pattern to `packages/*/src` and update its message;
  - remove the Dockerfile `api-src` `COPY` and the dev `mkdir` entry.
  Green: `check-envs.sh` exits 0, and `test_check_envs.sh` passes, including the new case.
  Evidence: `4e-4.1-baseline.log` (before the docker edits, after group 3 deleted the dir) ->
  `FAIL clean tree passes ... read-only source mount names a path that does not exist:
  packages/catalog/migrations`. After: `4e-4.1-checkenvs.log`: `sh docker/scripts/check-envs.sh
  all` -> `check-envs: ok (all)`; `4e-4.1-green.log`: `sh docker/scripts/test_check_envs.sh` ->
  `ok   a package bind outside src is caught`, `test_check_envs: 38 passed, 0 failed`. Red check
  (ALLOW widened to `packages/[a-z0-9-]+/.*`, restored after): `4e-4.1-red.log` -> `FAIL a package
  bind outside src is caught (wanted fail ..., got ok)`, `37 passed, 1 failed`.
- [ ] 4.2 Images:
  - `docker build -f docker/Dockerfile --target api .` builds. That target uses `api-src`, which
    `make dev-up` never builds. Boot it (`make stage-up`; the owner runs or allows it), and its
    healthcheck route `/api/profile` answers 200;
  - `make dev-up`: the dev image builds, the app boots on Postgres, `GET /api/profile` (the healthcheck route) is 200, and
    `POST /api/sessions` creates a session.

## 5. Docs and specs

- [x] 5.1 Update:
  - README:
    - line 21 (better-sqlite3 now covers session hubs and the `DATA_DIR` lock);
    - the package map (lines 632-648: catalog, storage, the removed
      `migrate.ts`/`asyncCatalogStore.ts`);
    - line 1365 (the rollback note's forward-only pointer moves to `supabase/migrations/` and
      `docker/supabase/migrate.sh`);
  - `docs/supabase.md:12`.
  Evidence: `git diff README.md docs/supabase.md`: line 21 now lists postgres.js for the catalog and
  better-sqlite3 for session DBs + the lock; the package map names `postgresCatalogStore.ts`,
  `catalogErrors.ts`, `dataDirLock.ts` and drops `migrate.ts`/`asyncCatalogStore.ts`/
  `catalog/migrations/`; the rollback note points at `supabase/migrations/` + `migrate.sh`.
  `rg -n -i "AsyncSqlite|asyncCatalogStore|applyMigrations|openCatalogDb|CATALOG_MIGRATIONS_DIR|catalog/migrations|storage/src/migrate\.ts" packages server web test docker README.md`
  -> no hits (exit 1).
- [x] 5.2 ADR 0021:
  - a 4e entry recording the decisions:
    - one PR, `size-override`;
    - migrations deleted, kept in `c783b99` (0001-0006) and `main` (0001-0005);
    - prod's `_migrations` is expected to be 0001-0005, to be confirmed against the real file;
      0006 never reached prod;
    - slice 11 refuses a source with any other `_migrations` set, and copies every column
      explicitly;
    - the parity test replaced by a recorded expectation;
  - line 244's "until 4e" wording;
  - a revisit-list item: the stale SQLite wording in the frozen `api-contract-freeze` spec
    (`SQLITE_FULL` at :596, the `shows.next_episode` column at :895).
  Evidence: `git diff docs/decisions/0021-migrate-to-self-hosted-supabase.md`: the 4e entry
  (one PR + `size-override`; `c783b99`/`main`; expected prod `_migrations` 0001-0005 and the
  slice 11 refusal + explicit columns; recorded schema; KvStore on Postgres; dev mount and `api`
  copy gone), 0006 wording "both retired in 4e", and two revisit items (the `api-contract-freeze`
  SQLite wording; the observed session-create retry exhaustion).
- [x] 5.3 Gates and review:
  - `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --stage hook` is green, apart from
    size (overridden by the label);
  - `openspec validate retire-sqlite-catalog --strict`;
  - the consistency read appended to `panel.md`.
  Evidence: `4e-5.3-hook.log`: `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --stage
  hook` -> exit 0; `PASS  openspec`, `PASS  evidence`, `PASS  commands ran ['typecheck', 'test']`,
  `WARN  size  689 changed lines > budget 400` (owner's `size-override`). `openspec validate
  retire-sqlite-catalog --strict` -> `Change 'retire-sqlite-catalog' is valid`. Consistency read
  appended to `panel.md` (scope change: no); `--only panel` -> `29 finding(s), no open criticals`.
