# Design

## Context

The server builds exactly one catalog adapter, `PostgresCatalogDb`, in `server/src/node/config.ts`.
That adapter also backs `KvStore`. What remains of the SQLite catalog:

| Artifact | Lines | Who uses it |
| --- | --- | --- |
| `packages/storage/src/asyncCatalogStore.ts` (`AsyncSqliteCatalogDb`, lock, deadline, `onBroken`, and the three shared error classes) | 311 | its own test, `kvStore.test.ts`; the error classes are also used by the Postgres adapter and its tests |
| `packages/storage/src/migrate.ts` (`openCatalogDb`, `applyMigrations`) | 45 | `migrate.test.ts`, `migrations.int.test.ts`, `catalogSchema.pg.test.ts` |
| `packages/catalog/migrations/0001-0006*.sql` plus `CATALOG_MIGRATIONS_DIR` | 175 + 10 | the two server tests above |
| `catalogSchema.pg.test.ts`, SQLite side (`lite`, column and key parity, seed-show parity) | ~110 | itself |
| dev image mount point, dev compose mount, `check-envs.sh` allow rule and check 5 | ~6 | the dev stack |

`better-sqlite3` remains a dependency for three things that this change doesn't touch:
- session hubs, in `session-core`;
- the `DATA_DIR/.server.lock` lock, in `storage/dataDirLock.ts`;
- the server's data-copy and audio-merge scripts.

## Goals / Non-Goals

**Goals:**
- The catalog has one implementation, and no source, test, image or mount builds or reads a
  SQLite catalog.
- No test coverage is lost:
  - the KvStore cases move to Postgres;
  - the schema parity check becomes a recorded Postgres expectation that equals the retired SQLite
    schema.
- The public `@autologger/storage` error names stay the same.

**Non-Goals:** as listed in proposal.md: session hubs, the `DATA_DIR` lock, the legacy
`catalog.db`, the slice 11 runbook, the `?` rewriter, `supabase/migrations/`, and a typed schema.

## Decisions

**D1. The shared error classes move to `packages/storage/src/catalogErrors.ts`.**
- `CatalogTxMisuseError`, `CatalogTxTimeoutError` and `CatalogAdapterBrokenError` are defined in
  the SQLite adapter file today, and the Postgres adapter imports them from there.
- They keep the same names, messages and `name` fields. Doc comments that describe SQLite
  connections are reworded to the port's meaning. `index.ts` re-exports the
  new module, so `@autologger/storage` consumers see no change.
- Alternative: define them in `postgresCatalogStore.ts`. Rejected, because the contract suite
  imports them and they describe the port's contract, not one adapter.

**D2. KvStore tests move to `kvStore.pg.test.ts` in the storage `pg` project.**
- Each case gets a fresh cloned database (`src/test/pgDb.ts` `createTestDatabase`), connected as
  `autologger_app` through `PostgresCatalogDb`, and closed in `afterEach`.
- **Time.** Every case uses a plain mutable-`now` clock. It does not use `vi.useFakeTimers()`,
  which would also freeze postgres.js's socket and deadline timers. It does not use
  `makeFakeClock` either, because its `tick()` calls `vi.advanceTimersByTime` and throws without
  fake timers.
  - `KvStore` reads time only through `clock.now()` (A4).
  - The two overlapping TTL blocks (the main block's expiry cases and "KV TTL with a fake clock")
    merge into one.
- Row-count checks that used `db.prepare` become `catalogDb.get('SELECT count(*) AS n FROM kv')`.
- **Cases that leaned on the SQLite lock's ordering** are restated so they hold on a pooled
  adapter, whose root statements run on any of 3 connections in no guaranteed order:
  - *Guarded expiry delete* (was "an expired key re-put between get's read and its expiry delete
    survives"):
    - A small wrapping `CatalogDb` in the test runs one `put('k','fresh')` after `get`'s `SELECT`
      returns and before its `DELETE` is sent.
    - `get` returns `null`, and the fresh value survives.
    - This is deterministic, and it is red if the delete loses its `expires_at <= ?` guard.
  - *Concurrent takes* (was "two takes queued behind a held transaction"): two `take()` calls in
    `Promise.all`, with no held transaction. Exactly one gets the value, and the row is gone.
  - *A key/value write never joins a catalog transaction* (was the SQLite lock block, lines
    161-193):
    1. A `catalogDb.tx` body inserts `in-tx`, then waits on a gate.
    2. Meanwhile `kv.put('k','v')` from outside resolves.
    3. The gate opens, and the body throws.
    4. Then `get('k') === 'v'` and `get('in-tx')` is `null`.

    This makes the core-ports "a key/value call SHALL never join a catalog transaction" testable
    on Postgres. The "lands after the transaction" ordering half is SQLite-only and is dropped.
- Alternative: keep an in-memory fake `CatalogDb`. Rejected, because it would test the fake
  instead of the SQL `KvStore` sends.

**D3. Parity becomes a recorded expectation, captured before SQLite is removed.**
- Task order matters:
  1. While `applyMigrations` still exists, add a literal expectation to `catalogSchema.pg.test.ts`
     covering:
     - per table: ordered columns, data type, collation, nullability and default text;
     - primary keys;
     - foreign keys with every column (not only `conkey[1]`);
     - the one unique constraint;
     - each `idx_*` index's full `pg_indexes.indexdef`.

     The literal is stricter than the old parity test, which compared index names and first FK
     columns only.
     - the two seed show rows.
  2. Generate the literal from the Postgres schema.
  3. Run the whole file in one vitest invocation. The parity tests and the literal tests must be
     green together, so the literal equals SQLite for every property parity compared. The
     evidence log is that single run.
  4. Only then delete the SQLite side.
- The table-set, bytewise-order and round-trip tests stay unchanged. Only their "as SQLite does"
  wording goes.
- Defaults are compared as Postgres's own `column_default` text, which is exactly what a later
  migration would change.
- Alternative: a vitest file snapshot. Rejected, because `-u` regenerates it silently, while a
  literal in the test is a reviewable diff.

**D4. The SQLite migrations are deleted, with their location recorded (owner).**
- The SQL is kept in two places:
  - `c783b99` (the `supabase-migration` head this branch starts from) contains 0001-0006;
  - `main` contains 0001-0005.

  If this branch is rebased, the ADR records the deletion commit's parent instead.
- Prod's legacy `catalog.db` was built by `main`, whose `packages/catalog/migrations/` holds
  0001-0005 (A5). Its `_migrations` table is expected to list exactly those. Nothing in the repo
  can confirm that. 0006 (indexes only) exists only on the integration branch and never reached
  prod.
- The slice 11 import reads that file read-only, as it is. It needs no migrator. The ADR entry
  tells slice 11 to:
  - refuse a source whose `_migrations` is not exactly 0001-0005. A file below 0005 lacks the
    0004 admin backfill and the 0005 `title_suffix` backfill;
  - copy every column explicitly. Otherwise Postgres's `title_suffix` default `'date'` would
    silently replace the backfilled `'episode'`.
- ADR 0021's 4e entry repeats these facts.

**D5. The dev mount is removed together with its guard.**
- `compose.dev.yaml` drops the `packages/catalog/migrations` bind.
- `check-envs.sh`:
  - check 4's allow pattern narrows from `packages/*/(src|migrations)` to `packages/*/src`, and
    its message drops the path;
  - check 5's "migrations is mounted" assertion is deleted. Leaving it would fail the env check
    on purpose.
- The Dockerfile's `api-src` `COPY` and the dev stage's `mkdir` of the mount point go too.
  `api-src` feeds the prod/stage `api` target (`Dockerfile:144-145`), and `make dev-up` never
  builds it. So verification builds `--target api` and boots it to its healthcheck route
  (`/api/profile`), as well as
  running `make dev-up`.
- `docker/scripts/test_check_envs.sh` gains a regression case: a dev config with a read-only
  bind of an existing non-`src` package path (`packages/catalog/package.json`) is refused by
  check 4's ALLOW rule. A re-added `packages/catalog/migrations` mount wouldn't do: after the
  deletion, the existence loop refuses it whatever the pattern says.
- The spec delta (local-container-environments) removes the "SHALL include" line, so spec, compose
  and checker agree.

**D6. Comment-only edits stay inside this change's scope.**
- Comments that name the deleted symbols are updated:
  - `ports/catalogDb.ts`;
  - storage `index.ts`;
  - `postgresCatalogStore.ts` (lines 2, 147, 338);
  - `catalog/index.ts`;
  - `showsStore.ts:47`;
  - the three `fixturesDir.ts` "pattern" notes (reworded to describe the `import.meta.url`
    pattern itself);
  - the boundary test's "both adapters run" exemption note;
  - `storage/kvStore.ts` (lines 3-5 and 31-32, "the catalog connection's lock" and "separate lock
    acquisitions");
  - `ports/kvStore.ts:4`;
  - `showsStore.ts:179` ("SQLite's NOCASE did", reworded so it still explains the SQL);
  - `showsStore.ts:48,198` and `authStore.ts:422`, which name deleted `.sql` files (they now cite
    the migration by number, as history);
  - `session-core/src/fakeClock.test.ts:6`;
  - README `:1365`: the upgrade-rollback note's "forward-only" pointer moves to
    `supabase/migrations/` and `docker/supabase/migrate.sh`.
- The verification grep must find no deleted name, and no "async catalog adapter" wording,
  outside:
  - `openspec/` and `docs/`;
  - the applied `supabase/migrations/` files (non-goal);
  - the README slice 11 runbook.

## Assumptions

| # | Assumption | Command | Observed |
| --- | --- | --- | --- |
| A1 | No production code uses the SQLite catalog | `rg -n -l "AsyncSqliteCatalogDb\|applyMigrations\|openCatalogDb\|CATALOG_MIGRATIONS_DIR" packages server web test docker scripts` | Only the files this change deletes or edits: storage `asyncCatalogStore`/`migrate` and their tests, `kvStore.test.ts`, `index.ts`, `postgresCatalogStore.ts` (comment), `ports/catalogDb.ts` (comment), `catalog/src/index.ts`, the 3 `fixturesDir.ts` (comments), `migrations.int.test.ts`, `catalogSchema.pg.test.ts`. No router, node or main file. |
| A2 | The three error classes are used only inside storage | `rg -l "CatalogTxMisuseError\|CatalogTxTimeoutError\|CatalogAdapterBrokenError" packages server web` | `catalogDbContract.ts`, `asyncCatalogStore{,.test}.ts`, `postgresCatalogStore{,.test,.pg.test}.ts`. Nothing in server or web. |
| A3 | Unqualified `kv` resolves for the app role in a cloned test database | `rg -n search_path supabase/migrations` | `20261001000000_catalog_schema.sql:136: alter role autologger_app set search_path = catalog;` |
| A4 | `KvStore` reads time only through its injected clock | `rg -n "Date\.now\|setTimeout\|clock" packages/storage/src/kvStore.ts` | Only `this.clock.now()` (lines 29, 40, 62, 72, 80); no `Date.now` or timers. |
| A5 | Prod's catalog was built with 0001-0005 only | `git ls-tree --name-only main packages/catalog/migrations/` | `0001_init.sql` … `0005_show_title_suffix.sql` (5 files). |
| A6 | The 4d `studio_id` indexes keep a Postgres-only test after parity goes | `rg -n studio_id server/src/test/pg/teamIndexes.pg.test.ts` | Checks `pg_index` for an index whose first column is `studio_id`, independent of SQLite. |
| A7 | The env checker passes today, so a failure after the edit is caused by the edit | `bash docker/scripts/check-envs.sh; echo $?` | `0` |
| A8 | The boundary test's storage exemptions don't name the deleted files | `sed -n 1508-1515p server/src/packageBoundaries.repo.test.ts` | Exempts `fakeClock.ts`, `catalogDbContract.ts`, `pgDb.ts`. Only the comment ("both adapters run") changes. |

## Risks / Trade-offs

- **Slower storage tests.**
  - Risk: the KvStore cases now need docker and clone a database each.
  - Mitigation: host `npm test` already needs docker (since 4a), and the storage `pg` project
    already clones per test. About 15 cases add a few seconds.
- **A schema drift that parity would have caught.**
  - Risk: after 4e, nothing compares Postgres to SQLite.
  - Mitigation: SQLite is no longer the reference. The recorded expectation (D3) catches an
    unplanned change to columns, keys, foreign keys, the unique constraint, index definitions or
    seed shows. CHECKs, triggers and grants are outside it; grants have their own role tests.
    A planned change updates the expectation in its own change.
- **The slice 11 import needs the old schema.**
  - Risk: the import may need to know the old schema.
  - Mitigation: git `c783b99` and `main` keep it, and the import reads prod's real `catalog.db`,
    which carries its own schema.
- **Size.** About 600 counted lines, over the budget; the owner chose one PR with
  `size-override`. Most of it is pure deletion.
