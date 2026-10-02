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

- [ ] 1.1 Test first: in `server/src/test/pg/catalogSchema.pg.test.ts`, add `it('matches the
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
- [ ] 1.2 Remove the SQLite side of `catalogSchema.pg.test.ts`:
  - the `lite` setup, `LiteCol` and `PG_TYPE`;
  - the column parity test and the key parity test;
  - the SQLite seed-show test;
  - the `CATALOG_MIGRATIONS_DIR`, `applyMigrations`/`openCatalogDb` and `better-sqlite3` imports.

  Drop "as SQLite does" from the ordering test name, and rewrite the header comment. The file
  stays green on Postgres alone.

## 2. Shared error classes and KvStore tests on Postgres (design D1, D2)

- [ ] 2.1 Test first: add `packages/storage/src/kvStore.pg.test.ts`, following design D2:
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
- [ ] 2.2 Add `packages/storage/src/catalogErrors.ts` with `CatalogTxMisuseError`,
  `CatalogTxTimeoutError` and `CatalogAdapterBrokenError`, and re-export it from `index.ts`.
  Names, messages and `name` fields stay the same. Doc comments that describe SQLite connections
  are reworded.
  - Point `postgresCatalogStore.ts`, `test/catalogDbContract.ts`, `postgresCatalogStore.test.ts`
    and `postgresCatalogStore.pg.test.ts` at it.
  - Storage typecheck plus the unit and pg projects are green.

## 3. Delete the SQLite catalog (design D4, D6)

- [ ] 3.1 Delete `packages/storage/src/asyncCatalogStore.ts` and `asyncCatalogStore.test.ts`.
  Drop `pendingAfter` from `test/catalogDbContract.ts`: only the SQLite test imports it, and
  `server/src/test/gatedCatalog.int.test.ts` has its own local copy. Drop the export from
  `index.ts`.
  - Evidence: storage unit and pg projects green, plus
    `rg -n AsyncSqliteCatalogDb packages server web test` → no hits.
- [ ] 3.2 Delete:
  - `packages/storage/src/migrate.ts` and `migrate.test.ts`;
  - `server/src/test/migrations.int.test.ts`;
  - `packages/catalog/migrations/`;
  - `CATALOG_MIGRATIONS_DIR` and its `fileURLToPath` import in `packages/catalog/src/index.ts`.

  Drop the `migrate` export.
  - Evidence: `npm run typecheck` green, plus
    `rg -n "applyMigrations|openCatalogDb|CATALOG_MIGRATIONS_DIR|catalog/migrations" packages
    server web test docker` → only the hits task 4.1 removes.
- [ ] 3.3 Update the comments that name deleted code (design D6):
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

## 4. Dev image and compose (design D5)

- [ ] 4.1 Test first: add a guard case to `docker/scripts/test_check_envs.sh`. A dev config with a
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
- [ ] 4.2 Images:
  - `docker build -f docker/Dockerfile --target api .` builds. That target uses `api-src`, which
    `make dev-up` never builds. Run it once with dev's env, and `/api/health` is 200;
  - `make dev-up`: the dev image builds, the app boots on Postgres, `GET /api/health` is 200, and
    `POST /api/sessions` creates a session.

## 5. Docs and specs

- [ ] 5.1 Update:
  - README:
    - line 21 (better-sqlite3 now covers session hubs and the `DATA_DIR` lock);
    - the package map (lines 632-648: catalog, storage, the removed
      `migrate.ts`/`asyncCatalogStore.ts`);
    - line 1365 (the rollback note's forward-only pointer moves to `supabase/migrations/` and
      `docker/supabase/migrate.sh`);
  - `docs/supabase.md:12`.
- [ ] 5.2 ADR 0021:
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
- [ ] 5.3 Gates and review:
  - `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --stage hook` is green, apart from
    size (overridden by the label);
  - `openspec validate retire-sqlite-catalog --strict`;
  - the consistency read appended to `panel.md`.
