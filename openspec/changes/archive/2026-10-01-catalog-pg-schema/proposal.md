# Catalog Postgres schema: the catalog's tables, the app's database role and network path, and a test Postgres

Tier: 2
Tier reason: a database migration, a new database role and secret, compose network segmentation (invariants 3 and 16), and the test harness every later slice relies on.

Approved-by: Kalen 2026-10-01

## Why

ADR 0021 slice 4 moves the catalog from `DATA_DIR/catalog.db` (better-sqlite3) to each stack's
Postgres through postgres.js. The owner split it into five PRs (2026-10-01):
- 4a schema (this change);
- 4b adapter;
- 4c wiring;
- 4d concurrency hazards;
- 4e retiring the SQLite catalog.

This change lays the ground the other four stand on:
- the catalog's tables in Postgres;
- a least-privilege database role for the app, and a network path that reaches only Postgres;
- a Postgres that tests can use on the host and in CI.

The app keeps running on SQLite until 4c.

## What Changes

**The schema** (design D1-D2):
- The first file in `supabase/migrations/` creates schema `catalog` with the nine catalog tables,
  ported faithfully from `packages/catalog/migrations/0001-0005` (owner: a faithful port during
  the migration, revisited after it).
- Timestamps stay ISO-8601 text, flags 0/1 numbers and JSON text.
- The engine mappings:
  - every SQLite `INTEGER` becomes `bigint`. SQLite integers are 8 bytes, and
    `start_offset_frames` takes unbounded client input;
  - `frame_rate` becomes `double precision`;
  - every text column becomes `COLLATE "C"`, so ordering stays bytewise as in SQLite. The image
    defaults to `en_US.UTF-8`.
- The two seed shows are inserted as SQLite leaves them after 0005.
- Not `public`: the image grants every new `public` table to the anon, authenticated and
  service-role API roles, and PostgREST serves `public` with the anon key.

**The app role** (design D3). `autologger_app` has:
- no superuser, `CREATEDB`, `CREATEROLE`, `REPLICATION` or `BYPASSRLS`, and no role memberships;
- 20 connections at most;
- a 30 s `statement_timeout` and a 15 s `idle_in_transaction_session_timeout`;
- `search_path` `catalog`;
- only `USAGE` on `catalog` and DML on its tables (later migrations' tables included).

Migrations stay with the `migrate` runner as `postgres`.

**Its password** (design D4):
- A new Infisical key, `APP_DB_PASSWORD`, at least 32 lowercase hex characters, made by
  `supabase-keys.mjs`.
- After the migrations, the runner sets the role's password from it in one transaction, with
  statement logging and `pg_stat_statements` utility tracking off. Probes showed both would
  otherwise record the plaintext.
- The runner refuses a missing or malformed key before connecting.
- It also fixes the runner's always-zero `N applied` summary.

**The network path** (design D5, owner decision after the panel):
- A new internal, host-isolated network `catalog` per project, with exactly two members: `db`
  and the app service (dev `app`, stage/prod `api`).
- The Supabase services stay on `db` and cannot reach the app. The app cannot reach them.
- The dev gate also refuses connections from the `catalog` subnet.
- The app gets the `PG*` connection variables as literals: user `autologger_app`, and password
  `${APP_DB_PASSWORD}`.
- Invariants 3 and 16 and `compose-run.mjs`'s per-stack `SECRET_SCOPE` enforce all of this,
  counting a `network_mode: service:app` sidecar as a member.

**The test Postgres** (design D6, owner decision):
- `test/pg/` at the repo root, so packages can use it in 4b.
- A vitest `globalSetup` for a new server `pg` project (`*.pg.test.ts`):
  - pulls and runs the pinned `supabase/postgres` image with the stack's command, published only
    on `127.0.0.1`;
  - waits out the image's initdb restart;
  - applies `supabase/migrations` with the real `migrate.sh` to `postgres` and to a template
    database.
- Each test gets `CREATE DATABASE … TEMPLATE`.
- Passwords are random per run and never on argv. Stale containers are reaped only when their
  owning process has died.
- No docker: a clear failure.
- The existing `unit` and `integration` projects don't need docker until 4c.
- postgres.js becomes a root devDependency.

## Non-goals

- The postgres.js adapter (4b), wiring the app to Postgres (4c), the concurrency hazards (4d),
  and deleting the SQLite catalog (4e). The app does not connect to Postgres in this change.
- Behaviour differences that need a store or contract decision. Each is recorded for 4c with a
  test:
  - NUL bytes in text;
  - `COLLATE NOCASE` ordering;
  - int8 values arriving as strings, which 4b parses.
- A typed schema (`timestamptz`, `jsonb`, `boolean`) and any redesign of users, memberships or
  sessions (slices 5-7, and after the migration).
- RLS, `set local role authenticated`, the role's membership in `authenticated`, and the
  `postgres` role's `pg_read_all_data` reach (slice 6).
- Revoking PUBLIC's `CONNECT`/`TEMP` on databases (recorded residual).
- Importing `catalog.db` data (slice 11). `APP_DB_PASSWORD` reaches Infisical prod only at
  cutover.
- `docker/supabase/init/roles.sql` may leave `SUPABASE_ROLES_PASSWORD` in `pg_stat_statements`
  and the DDL log at init. This is recorded as a follow-up, not fixed here.

## Capabilities

### New Capabilities
- `catalog-database`: the catalog's Postgres schema, the app's database role, its exposure
  limits, and the test Postgres.

### Modified Capabilities
- `local-container-environments`:
  - the static invariant check: invariant 3's network clause, and invariant 16's `catalog`
    network and `APP_DB_PASSWORD` scope;
  - "Allowed names" gains the key;
  - the migrations runner sets the app role's password;
  - the generator creates the key;
  - the dev isolation requirement allows the `PG*` literals and the `catalog` network.
- `container-deployment`: in the compose topology, `api` joins the two-member `catalog` network
  and receives the `PG*` literals besides the shared allowlist. The scenario "Postgres is not
  reachable from the app or the host" keeps its name (archive keeps every scenario) and now
  states that the app reaches only `db`, as `autologger_app`.

## Impact

- **New:**
  - `supabase/migrations/20261001000000_catalog_schema.sql`
  - `test/pg/` (globalSetup, testDb and their unit test)
  - `server/src/test/pg/*.pg.test.ts`
- **Changed:**
  - `docker/supabase/migrate.sh` and `docker/supabase-db.yaml`
  - `compose.yaml`, `docker/compose.dev.yaml`, `docker/compose.stage.yaml` and
    `docker/dev-gate.Caddyfile`
  - `docker/scripts/compose-run.mjs`, `check-envs.sh` and `supabase-keys.mjs`, and their tests
  - `server/vitest.config.ts` and the root `package.json`
  - `docs/supabase.md`, `docs/infisical-secrets.md` and `docs/security.md`
  - ADR 0021: the slice 4 split, a database per test, the typed-schema and `roles.sql`
    follow-ups
- **Owner, before the next `make dev-up` / `stage-up`:** run
  `node docker/scripts/supabase-keys.mjs dev|stage --writer FILE` to create `APP_DB_PASSWORD`.
  Prod gets it at cutover.
- **Size:** about 250-300 counted lines. Tests, `test/`, `docs/` and `openspec/` are excluded.
