# Catalog on Postgres: the server's catalog runs on `PostgresCatalogDb`

Tier: 2
Tier reason: switches the server's catalog persistence to Postgres, with SERIALIZABLE retries now live. It adds NUL-byte refusals (422/400) to the frozen HTTP contract and touches `packages/contract/**` and `server/src/routers/**`.

Approved-by: Kalen 2026-10-01

## Why

ADR 0021 slice 4 moves the catalog to Postgres. 4a merged the schema, role and network, and 4b
merged `PostgresCatalogDb` without wiring it in. This change, 4c, makes the server use it, so
the catalog stores and `KvStore` read and write Postgres. That clears the way for 4d (the
concurrency hazards) and 4e (removing the SQLite catalog).

## What Changes

- **Composition root.**
  - `createBindings` builds one `PostgresCatalogDb` from the `PG*` env that compose already
    passes (`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`). The catalog stores and
    `KvStore` share it.
  - The server no longer opens `DATA_DIR/catalog.db` and no longer runs SQLite catalog
    migrations.
  - `DATA_DIR` and its `.server.lock` stay, for sessions and blobs.
  - **BREAKING (operator):** the server refuses to boot without the `PG*` vars.
- **Boot and shutdown.**
  - The boot guard refuses a start without the `PG*` vars.
  - Before listening, the server waits up to 30 s for the catalog (connection and schema). If
    it isn't ready by then, it exits 1 and the supervisor restarts it.
  - `close()` becomes async, and shutdown awaits it within the existing 5 s failsafe.
  - The `onBroken` exit wiring goes away: the Postgres adapter retires a bad connection instead
    of breaking.
- **Ops order.**
  - `make dev-up` and `make stage-up` run the `migrate` service before starting the app.
  - `docs/supabase.md` documents rotating `APP_DB_PASSWORD`: update Infisical, run `migrate`,
    then recreate the app.
- **Starting state (owner, 2026-10-01).** Dev and stage start with an empty Postgres catalog.
  There is no import and no engine switch. The old `catalog.db` and `sessions/*.db` files stay
  untouched on the volumes for slice 11's importer.
- **Store dialect.**
  - The show list's `ORDER BY name COLLATE NOCASE` becomes `ORDER BY lower(name), name`. The
    order stays ASCII case-insensitive, with ties in byte order.
  - `INSERT OR IGNORE` becomes `INSERT … ON CONFLICT DO NOTHING`.
- **NUL bytes (owner: reject, one rule, after the panel).** Postgres text can't hold `U+0000`.
  - Any request value with NUL that would reach a catalog statement gets a `400 {detail}`, and
    the statement is never sent.
  - Companion presence refuses a NUL `session_id` with a 400.
  - The OAuth state with NUL is `state_invalid`.
  - A NUL in the Google `sub` or `email` claim is `token_invalid`; NUL is stripped from the
    name and picture claims.
  - The change amends `api-contract-freeze`.
- **Integers.** Session `start_offset_frames` is capped at `Number.MAX_SAFE_INTEGER` (a larger
  value is a 422), because Postgres `bigint` refuses what SQLite stored as REAL.
- **Error logs.** The generic 500 handler logs a Postgres error's code, constraint and table, not
  its `detail`, which would echo emails or Google subject ids.
- **Retry safety.** All 16 production `tx` bodies were audited, and each has only database
  effects, so a SERIALIZABLE retry is safe (design D7). `Catalog.tx` documents that its body
  may run more than once.
- **A `COMMIT` with an unknown outcome** returns the existing generic 500, with a distinct log
  line. The wire is unchanged.
- **Tests.** The server integration suite (39 files) runs on Postgres. Each test gets a
  database cloned from the 4a template, so the suite tests the engine production uses.

## Non-goals

- **The ADR 0021 slice 3 concurrency hazards are 4d.** They become live on dev and stage when
  this merges. Prod is on hold during the migration, so that's acceptable; 4d fixes them. The
  panel found two more, and the owner put both in 4d (2026-10-01):
  - a 500 after the session write has committed, when the catalog mirror write fails;
  - a deleted team id, recreated, inheriting memberships or invites from a concurrent invite.
- **No catalog data import.** That is slice 11.
- **No deletion of SQLite catalog code, migrations or the adapter.** That is 4e. `copyDataDir`
  and the SQLite migration tests stay.
- **No schema, role, network or secret changes.** The compose `PG*` env already exists (4a).
- **No typed schema.** It is a follow-up after the migration.
- **No new routes, and no change to existing success shapes.**

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `catalog-database`: ADDED "The server's catalog runs on Postgres". It covers:
  - one adapter;
  - the bounded readiness wait;
  - the rotation order;
  - the show order;
  - value-free error logs.
- `core-ports-architecture`:
  - MODIFIED "The SQLite catalog adapter serialises each connection": the server never uses it,
    and the "broken connection stops a supervised server" scenario now says so.
  - MODIFIED "The Postgres catalog adapter": it refuses NUL text, a `tx` body has only database
    effects, and the stores and KV share one instance.
- `api-contract-freeze`: ADDED "Text containing NUL is refused" and "Catalog integer fields are
  bounded".
- `web-frontend-platform`: MODIFIED "Single-process development": boot refuses missing `PG*`
  before taking the lock, and a second server is refused before it touches the catalog.
- `local-container-environments`: MODIFIED "Makefile entry points per environment": migrate
  runs before the app.
- `package-architecture`: MODIFIED "The catalog package owns the catalog schema migrations":
  only tests run the SQLite migrator until 4e.

## Impact

- **Changed code:**
  - `server/src/node/config.ts`, `server/src/main.ts` and `server/src/bootGuard.ts`;
  - new `server/src/waitForCatalog.ts`;
  - `server/src/app.ts`: the 400 mapping and the log redaction;
  - `server/src/routers/auth.ts`: the claim checks;
  - `server/src/auth/identity.ts`: the NUL state;
  - `server/src/routers/companion.ts`: presence;
  - `packages/contract/src/schemas.ts`: the `start_offset_frames` bound only;
  - `packages/catalog/src/{showsStore,authStore,catalog}.ts`;
  - `packages/storage/src/postgresCatalogStore.ts`: the NUL guard and error.
- **Tests:**
  - `server/src/test/harness.ts`: async, one clone per test;
  - new `server/src/test/pgIntegrationSetup.ts`, plus `server/vitest.config.ts`;
  - `config.test.ts`, `bootOrder.int.test.ts`, `migrations.int.test.ts` and the youtube-import
    reboot test are adapted.
- **Ops and docs:**
  - `Makefile`: migrate before up;
  - `docs/supabase.md`: rotation;
  - `README.md`: the `catalog.db` mentions;
  - `docs/decisions/0021-*.md`: 4c closed out, start empty, hazards 17-20 added to 4d.
- **Running the stack:** dev and stage need the `migrate` service applied and the image rebuilt
  (`make dev-up` / `make stage-up` do both). `npm test` needs docker for the integration suite as
  well.
