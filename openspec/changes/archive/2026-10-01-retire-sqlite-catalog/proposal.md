# Retire the SQLite catalog: one catalog implementation, on Postgres

Tier: 2
Tier reason: removes a catalog adapter and the catalog schema migrations (a migration surface), amends the ports contract and four capability specs, and changes the dev compose mounts and their `check-envs.sh` guard.

Approved-by: Kalen 2026-10-01

## Why

Since 4c the server's catalog and KV run only on Postgres (`PostgresCatalogDb`). Nothing in
production opens the SQLite catalog any more. Its adapter, migrator, six `.sql` migrations and
parity test survive only because tests still run them. Each later slice (5-7) would otherwise
have to keep two catalog implementations in step. ADR 0021 slice 4e removes them, so the catalog
has exactly one implementation.

## What Changes

- **Adapter removed.**
  - `AsyncSqliteCatalogDb` (`packages/storage/src/asyncCatalogStore.ts`, with its lock, deadline
    and `onBroken`) and its test are deleted.
  - The three error classes the Postgres adapter shares (`CatalogTxMisuseError`,
    `CatalogTxTimeoutError`, `CatalogAdapterBrokenError`) move to `catalogErrors.ts`, still
    exported from `@autologger/storage` under the same names.
  - The catalog contract suite keeps one runner, Postgres.
- **KvStore unit tests move to Postgres.** They ran on in-memory SQLite; they now run in the
  storage `pg` project against a cloned test database. Every behaviour is kept:
  - three cases that leaned on the SQLite lock's ordering are restated so they hold on a pool:
    - the guarded expiry delete;
    - concurrent takes;
    - a key/value write surviving a rolled-back catalog transaction;
  - the two overlapping TTL blocks merge.
- **SQLite catalog migrations removed.** The following are deleted:
  - `packages/catalog/migrations/0001-0006*.sql`;
  - `CATALOG_MIGRATIONS_DIR`;
  - the migrator `openCatalogDb`/`applyMigrations` (`packages/storage/src/migrate.ts`);
  - their tests (`migrate.test.ts`, `server/src/test/migrations.int.test.ts`).

  Git history keeps the old schema; the design records where (owner).
- **The schema parity test becomes a fixed expectation.** `catalogSchema.pg.test.ts` no longer
  builds a SQLite catalog. Columns, types, collation, nullability, defaults, keys, foreign keys,
  indexes and the two seed shows are asserted against literal values. Those values are captured
  while the parity test still passes, so they equal the SQLite catalog on the day it is removed.
- **Images and dev compose.**
  - The `api-src` stage no longer copies `packages/catalog/migrations`. That stage feeds the
    prod/stage `api` image, so that image loses the (unused) directory.
  - The dev image no longer creates the mount point.
  - `compose.dev.yaml` drops its read-only mount.
  - `check-envs.sh` stops allowing and requiring it, with a regression case in
    `test_check_envs.sh`.
- **Docs.**
  - README package map and stack line, plus the upgrade-rollback note, which names the deleted
    migrator.
  - `docs/supabase.md`.
  - ADR 0021 gets its 4e entry.
  - Comments that describe the deleted adapter, or name the deleted `.sql` files, are updated in
    the ports, storage and catalog sources.
  - ADR 0021's revisit list gains the stale SQLite wording in the frozen `api-contract-freeze`
    spec.

No HTTP/WS behaviour changes. No Postgres migration is added or edited.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `core-ports-architecture`:
  - removes "The SQLite catalog adapter serialises each connection";
  - "The Postgres catalog adapter" no longer cites the SQLite adapter as its reference.
- `catalog-database`: "The catalog schema lives in Postgres schema `catalog`":
  - states the schema (full foreign keys and index definitions) and the seed shows as a recorded
    expectation, instead of "matches the SQLite catalog";
  - says "Migrations" instead of "A migration" (4d added a second one).
- `package-architecture`:
  - removes "The catalog package owns the catalog schema migrations";
  - the layer-graph requirement describes `@autologger/storage` as the Postgres catalog, KV,
    data-directory lock and filesystem adapters.
- `local-container-environments`: "Dev isolates data and secrets…" no longer requires the
  `packages/catalog/migrations` mount.

## Non-goals

- **Session hubs.** The per-session `sessions/*.db` hubs stay on SQLite until slice 7, so
  `better-sqlite3` stays a dependency of session-core, storage (the `DATA_DIR` lock) and server.
- **The `DATA_DIR/.server.lock` lock** (`dataDirLock.ts`) is unchanged.
- **The legacy `catalog.db` file**, `server/scripts/copyDataDir.ts`, and the README cutover,
  import and backup steps stay as they are. They belong to slice 11. The one exception is the
  rollback note, which names the deleted migrator.
- **The `?` placeholder rewriter** in the Postgres adapter stays. Moving the stores to `$n` is not
  part of this slice.
- **No change to `supabase/migrations/`.** Comments in the applied
  `20261001000000_catalog_schema.sql` that cite the old SQLite files stay unedited.
- **No typed schema.** That stays a post-migration follow-up.

## Impact

- **Deleted.** `packages/storage/src/{asyncCatalogStore,migrate}.ts` and their tests;
  `packages/catalog/migrations/`; `server/src/test/migrations.int.test.ts`.
- **Changed.**
  - `packages/storage/src/{index,postgresCatalogStore}.ts`, a new `catalogErrors.ts`, and
    `test/catalogDbContract.ts`;
  - `kvStore.test.ts`, which becomes `kvStore.pg.test.ts`;
  - `packages/catalog/src/index.ts`;
  - `packages/ports/src/catalogDb.ts` (a comment);
  - `server/src/test/pg/catalogSchema.pg.test.ts`;
  - `docker/Dockerfile`, `docker/compose.dev.yaml` and `docker/scripts/check-envs.sh`;
  - README, `docs/supabase.md` and ADR 0021.
- **Size.** About 600 counted lines, mostly deletions, over the 400 budget. The owner chose one PR
  with the `size-override` label.
- **Tests.** Host `npm test` already needs docker (since 4a). The storage `pg` project gains the
  KvStore cases.
