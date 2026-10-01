# Design: catalog-pg-schema (ADR 0021 slice 4a)

## Context

The catalog is `DATA_DIR/catalog.db`. Its schema is built by `packages/catalog/migrations/0001-0005`
and applied at boot by `packages/storage/src/migrate.ts`. Slice 4 moves it to each stack's Postgres
(`docker/supabase-db.yaml`, `supabase/postgres:17.6.1.136`) in five PRs:
- 4a schema (this change);
- 4b postgres.js adapter;
- 4c wiring;
- 4d concurrency hazards;
- 4e retiring the SQLite catalog.

This one builds the schema, the app role, the app's network path and the test Postgres. The app
keeps using SQLite until 4c.

Owner decisions (2026-10-01):
- a faithful port now, with a typed schema after the migration;
- a dedicated app role;
- tests on a dockerised pinned image, with a template database cloned per test;
- `SERIALIZABLE` transactions with retry (that one is 4b's);
- **after the panel:** the app reaches Postgres over a two-member network (`db` and the app only),
  added in this change (D5).

## Assumptions and evidence

Probes ran throwaway containers of the pinned image (`docker run --rm … supabase/postgres:17.6.1.136@sha256:f371…`),
which were removed afterwards. A15-A24 come from the panel's probes (`panel.md`).

| # | Assumption | Command (abridged) | Observed |
|---|---|---|---|
| A1 | The image grants every new `public` table to `anon`/`authenticated`/`service_role` by default, so the catalog must not live in `public` | `select defaclrole::regrole, defaclnamespace::regnamespace, defaclacl from pg_default_acl` | `postgres\|public\|{…anon=arwdDxtm/postgres,authenticated=arwdDxtm/postgres,service_role=arwdDxtm/postgres}`, and the same for `supabase_admin` in `public`, `graphql` and `graphql_public` |
| A2 | PostgREST exposes only `public` | `grep PGRST_DB_SCHEMAS docker/supabase-services.yaml` | `PGRST_DB_SCHEMAS: public` |
| A3 | `postgres` (the migrate user) can create roles and databases but is not a superuser | `select rolsuper` / `select rolcreaterole, rolcreatedb, rolbypassrls from pg_roles where rolname='postgres'` | `f` / `t\|t\|t` |
| A4 | A role with only USAGE+DML on `catalog` can read and write rows but not create tables in `catalog` or `public` | as `probe_app`: `insert … ; create table catalog.u …; create table public.u …` | `INSERT 0 1`; `ERROR: permission denied for schema catalog`; `ERROR: permission denied for schema public` |
| A5 | `anon`, `authenticated`, `service_role` and `public` get nothing on a new schema without explicit grants | `has_schema_privilege`/`has_table_privilege` for each | all `f` (panel: `anon\|f\|f\|f\|f`, … `public\|f\|f\|f\|f`) |
| A6 | The image's default collation sorts differently from SQLite's bytewise BINARY, and `COLLATE "C"` matches BINARY | `select datcollate … where datname='postgres'`; `select 'B' < 'a' collate "default", 'B' < 'a' collate "C"` | `en_US.UTF-8\|en_US.UTF-8\|i`; `f\|t` |
| A7 | `pg_stat_statements` stores `ALTER ROLE … PASSWORD` in plain text, and `postgres` may turn utility tracking off inside the runner's transaction | probe and panel control | without the setting, 1 row with the password; with `set local … track_utility = off` under `--single-transaction`, 0 rows (supautils lists `pg_stat_statements.*` as privileged-role-settable) |
| A8 | The `postgres` database cannot be a template, because the pg_net and pg_cron workers stay connected to it | `select datname, usename, backend_type from pg_stat_activity` | `postgres\|supabase_admin\|pg_net 0.20.3 worker`, `postgres\|supabase_admin\|pg_cron launcher` |
| A9 | Cloning a small template database is cheap; dropping it is not | 20 × `create database … template`; 20 × `drop database` | 1.77 s; 9.0 s. Panel: 8 parallel clones all succeed |
| A10 | The image starts fast enough for a per-run globalSetup | `time (docker run -d … && until pg_isready -h localhost …)` | 5.5 s with the image cached. Cold CI pull: 29 layers, 367 MB compressed (panel) |
| A11 | migrate.sh runs in the test container as `postgres` (peer auth) against `postgres` and then a second database in one cluster | panel: `docker exec -u postgres … sh /migrate.sh`, then with `-e PGDATABASE=autologger_template` | both exit 0 with `applied 20261001000000` |
| A12 | The server's child processes get an allowlisted environment, but a same-uid child could still read `/proc/<node pid>/environ` | grep of the three spawn sites; panel `/proc` probe | env built from allowlists. `PGPASSWORD=s3cret` is readable through `/proc` (residual, D5) |
| A13 | `npm test` already needs the docker CLI, and CI's runner has a docker daemon | `grep -n docker docker/scripts/compose-run.test.mjs` | `compose config` is forwarded to the real docker (lines 35, 102). `ubuntu-latest` ships Docker Engine. The pinned digest is a multi-arch index (amd64 and arm64) |
| A14 | Nothing else in the SQLite schema needs a special Postgres type (no rowid, AUTOINCREMENT, `datetime()` or `json_*`) | `grep -rnE "AUTOINCREMENT\|rowid\|datetime\(\|json_" packages/catalog packages/storage/src` | no catalog hits |
| A15 | SQLite `INTEGER` is 8 bytes, and at least one column takes unbounded client input | `grep -n start_offset_frames packages/contract/src/schemas.ts`; `select 3000000000::integer` | `z.number().int().min(0).default(0)` (no maximum); `ERROR: integer out of range` |
| A16 | The image logs DDL for `postgres`: `log_statement` is `ddl`, not `none` | `show log_statement`; `grep -n log_statement /etc/postgresql/postgresql.conf` | `ddl`; `542:log_statement = 'ddl'`. The password reaches `docker logs` unless `log_min_messages=fatal` is set (panel) |
| A17 | `pg_isready` over the Unix socket succeeds against initdb's temporary server about 1 s before the real one | panel: polling a fresh container | `socket-ready 12:03:20.177`, `tcp-ready 12:03:21.274`, then `received fast shutdown request` |
| A18 | pg_hba trusts loopback inside the container, so a login test through `docker exec` proves nothing about the password | `grep -v '^#' /etc/postgresql/pg_hba.conf`; host connection via the published port | `host all all 127.0.0.1/32 trust`; host client is `172.17.0.1`, and a wrong password gives `FATAL: password authentication failed` |
| A19 | migrate.sh refuses a `DO` block whose `begin`/`end` start a line | panel: unindented `do $$\nbegin … end\n$$;` | `refusing: … transaction control … is not allowed`. Indented works |
| A20 | Objects the runner creates are owned by `postgres`, so default privileges `FOR ROLE postgres` cover later migrations | panel: a second migration's `catalog.later` ACL | `{postgres=arwdDxtm/postgres,autologger_app=arwd/postgres}` |
| A21 | PUBLIC gives every role `CONNECT` on databases and `TEMP` on `postgres` | panel: as a DML-only role, `create temp table …`; `has_database_privilege('public', …)` | `CREATE TABLE`; `t` |
| A22 | `postgres` is a member of `pg_read_all_data` | panel: role memberships | includes `pg_read_all_data`, `pg_monitor` |
| A23 | postgres.js 3.4.9 returns int8 as a string | panel: `typeof expires_at` | `string` |
| A24 | migrate.sh's `N applied` summary is always `0`: `$out` starts with the advisory-lock result, not `applied` | panel: two fresh files | `applied …`, `applied …`, then `0 applied` |

## D1. A faithful schema in `catalog`

One migration file, `supabase/migrations/20261001000000_catalog_schema.sql`, creates schema
`catalog` (owner `postgres`) in the end-state shape of SQLite migrations 0001-0005. It does not
replay 0001-0005: there is no `ALTER` and no data `UPDATE`.

| SQLite | Postgres | Why |
|---|---|---|
| `TEXT` | `text COLLATE "C"` | Bytewise comparison and ordering, as SQLite BINARY (A6) |
| `INTEGER` (every column) | `bigint` | SQLite INTEGER is 8 bytes, and `start_offset_frames` takes unbounded client input (A15); int4 would turn today's accepted values into 500s. 4b parses int8 into a JS number (A23) |
| `sessions.frame_rate REAL` | `double precision` | Postgres `real` is float4; 29.97 must round-trip |

Carried over:
- primary keys, which in Postgres imply NOT NULL; SQLite's text PKs are nullable but never get a
  NULL;
- `users.google_sub UNIQUE`;
- the foreign keys (`ON DELETE CASCADE` on memberships and prefs; `sessions.show_id` with no
  action);
- every default, and both named indexes (`idx_users_email`, `idx_sessions_show`).

SQLite's autoindexes have no names to carry over.

**Seeds and `_migrations`.** The two seed shows are inserted with `ON CONFLICT (id) DO NOTHING`,
with the values SQLite holds after 0005 (`title_suffix = 'episode'`). SQLite's `_migrations`
table is not ported; `supabase_migrations.schema_migrations` replaces it.

**Behaviour that differs from SQLite, recorded for 4c:**

| Difference | Decision |
|---|---|
| Postgres `text` refuses a NUL byte (`\u0000`), which SQLite stores | 4c chooses between 400 and stripping and adds a contract test |
| Foreign keys are always enforced. The SQLite catalog sets `foreign_keys = ON` in `openCatalogDb`, so this is the same | none |
| `ORDER BY name COLLATE NOCASE` (`showsStore.ts:178`) has no Postgres collation | 4c rewrites it and tests the store's real ordering |

## D2. Why `catalog` and not `public`

The pinned image grants every new `public` table to `anon`, `authenticated` and `service_role`
(A1). PostgREST serves `public` with the anon key (A2). In `public`, the catalog's users, emails
and invites would be readable through the gateway with the anon key until slice 6. A separate
schema with no grants to those roles (A5) shuts that door. The panel also confirmed that
pg_graphql, which isn't installed in the stack, shows nothing from `catalog` to `service_role`.

The migration revokes everything on schema `catalog` from `public`. `postgres` is a member of
`pg_read_all_data` (A22): anything holding `POSTGRES_PASSWORD` (`db`, `migrate`, `realtime`) can
read the catalog whatever the grants say. That is documented and left to slice 6.

## D3. The app role

The migration (with `begin`/`end` indented inside `DO` blocks, A19):
1. Creates `autologger_app` if it is missing. Roles are cluster-wide, and the test setup migrates
   two databases in one cluster.
2. Always runs `ALTER ROLE autologger_app NOCREATEDB NOCREATEROLE NOBYPASSRLS CONNECTION LIMIT
   20`. `postgres` is neither a superuser nor a replication role, so PG 17 refuses to let it
   alter `SUPERUSER` or `REPLICATION` (implementation: `permission denied to alter role`).
   Step 3 refuses a role that holds either. `LOGIN` is left as the runner set it. The role sets
   these for itself:
   - `statement_timeout = '30s'`;
   - `idle_in_transaction_session_timeout = '15s'` (4b's adapter deadline is 10 s);
   - `search_path = catalog`.

   A pre-existing role can't keep stronger attributes. The 20-connection cap leaves the cluster's
   other ~77 slots to the Supabase services and `migrate`.
3. Raises an exception if the role is a member of any role, a superuser or a replication role.
   Memberships come only in slice 6, as a deliberate grant.
4. Grants `USAGE` on schema `catalog` and `SELECT, INSERT, UPDATE, DELETE` on all its tables.
5. Runs `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA catalog GRANT SELECT, INSERT,
   UPDATE, DELETE ON TABLES TO autologger_app` (A20).

The role gets no `TRUNCATE`, `REFERENCES`, `TRIGGER` or `CREATE`. PUBLIC's `CONNECT` and `TEMP`
on databases still apply (A21). Revoking them from PUBLIC would change what the Supabase services
get, so it is left as a recorded residual: session-local temp tables and functions, and connects
that land on other databases with no grants. `LOGIN` and the password come from the runner (D4).

## D4. The password: `APP_DB_PASSWORD`, set by the runner

- **The key.** `APP_DB_PASSWORD` is a new Supabase-family key: at least 32 lowercase hex
  characters, created by `supabase-keys.mjs` like `POSTGRES_PASSWORD`. Its allowed services, per
  stack:

  | Stack | Services |
  | --- | --- |
  | dev | `app`, `migrate` |
  | stage, prod | `api`, `migrate` |

- **Pre-connect check.** `migrate.sh` refuses, naming the key and printing no value, when
  `APP_DB_PASSWORD` is unset, empty, or contains anything but `0-9a-f`, or is shorter than 32. It
  uses `case` and `${#…}`, never `grep`, so a multi-line value can't pass.
- **The step.** After the migrations, one `--single-transaction` psql run:

  ```
  \set apppw `printf %s "$APP_DB_PASSWORD"`
  set local log_statement = 'none';
  set local pg_stat_statements.track_utility = off;
  select exists (select from pg_roles where rolname = 'autologger_app') as has_role \gset
  \if :has_role
  alter role autologger_app with login password :'apppw';
  \echo app role password set
  \else
  \echo app role absent; password not set
  \endif
  ```

  - The value is read from the environment (the busybox `printf` builtin), never from argv.
  - `log_statement` is `ddl` for `postgres` on this image (A16). The step turns it off itself
    rather than relying on `log_min_messages=fatal`.
  - Turning utility tracking off keeps the plaintext out of `pg_stat_statements` (A7).
  - With no `autologger_app` role (the existing runner fixtures, an empty directory), the step
    reports that and succeeds.
- **The summary bug (A24).** The `N applied` count is fixed with
  `case $out in *"applied $v"*)`, because the runner's tests depend on it.
- **Rotation.** Change the key in Infisical, run `make dev-migrate` (or `stage-up`), then recreate
  the app container. There is no window in which both passwords work. 4c records the order its
  boot needs.
- **The migrate service** gets `APP_DB_PASSWORD: ${APP_DB_PASSWORD:?…}`. It already holds the
  superuser password. Every prod resolve needs the key, as with `POSTGRES_PASSWORD`. `make check`
  uses sentinels, and prod gets its keys at cutover.

## D5. The app's path: a two-member `catalog` network (owner, after the panel)

**Why not the shared `db` network.** The panel showed that putting the app on `db` lets the
Supabase services reach it:
- **Dev:** the anonymous dev app and the operator's Claude login, through `app-gate`, which shares
  the app's namespace.
- **Prod and stage:** `api` without the router. With `TRUST_PROXY=1`, a forged `X-Forwarded-For`
  gets past `IP_ALLOWLIST`.
- **And the reverse:** `api` could reach `rest`, `auth`, `realtime` and `storage` directly, past
  every gateway rule.

**Design.** A new network `catalog` per project:
- internal and host-isolated like `db`;
- pinned subnets: prod `172.28.15.0/24`, stage `172.28.25.0/24`, dev `172.28.34.0/24`;
- members: `db` and the app service only (dev `app`, stage/prod `api`). `db` joins
  `[db, catalog]`, and the Supabase services stay on `db` only.

The only new peer of the app is Postgres, which already holds every catalog row. Docker does not
route between networks through a container, so the app still can't reach the services on `db`.

**Defence in depth.** In dev, `app-gate` refuses any request whose remote IP is in the dev
`catalog` subnet, with a Caddy `remote_ip` matcher that aborts the connection. The subnet is set
as `GATE_DENY_SUBNET`, which defaults to `192.0.2.0/32` for the Companion gate. `make check`
asserts it equals the `catalog` network's subnet. Invariant 6 admits `PGPASSWORD` as the
`${APP_DB_PASSWORD:?…}` reference. That protects
against a future pg_net SSRF from `db`. pg_net is not created today, and if it ever is, the
image's own migration grants it to PUBLIC (panel).

**Environment.** The app gets, as literals in its own `environment`:
- `PGHOST: db`, `PGPORT: "5432"`, `PGDATABASE: postgres`, `PGUSER: autologger_app`;
- `PGPASSWORD: ${APP_DB_PASSWORD:?add APP_DB_PASSWORD with docker/scripts/supabase-keys.mjs (see docs/supabase.md)}`.

They are not in the shared allowlist (`docker/secrets-env.yaml` forbids Supabase secrets).
Invariant 15 treats them as literal pins.

**Spec edits.**
- **Invariant 16** amended:
  - `db` joins exactly `db` and `catalog`;
  - `catalog` has exactly `db` plus the stack's app service, and is internal, host-isolated and
    pinned;
  - no service other than `db`, `migrate` and the four Supabase services joins `db`;
  - a service with `network_mode: service:X` counts as a member of X's networks, and only
    `app-gate` may do so for `app`;
  - `APP_DB_PASSWORD` gets a sentinel and its per-stack scope.
- **Invariant 3's network clause:** the dev `app` joins exactly `dev` and `catalog`.
- **`compose-run.mjs`** adds the key to `SUPABASE_KEYS`, `KEY_FORMAT` and a per-stack
  `SECRET_SCOPE`.
- **Requirements that say the app gets secrets only through the shared allowlist** gain a
  carve-out for the five `PG*` literals.

**Residual.** A same-uid child of the server (yt-dlp, the Claude CLI) can read `PGPASSWORD` from
`/proc` (A12). A file would leak the same way, so the database-side limits (D3) and the
two-member network bound the damage. This is recorded in `docs/security.md`.

## D6. The test Postgres

**Layout.** The harness lives in `test/pg/` at the repo root, so `packages/storage` (4b) can use
it too; `package-architecture` forbids packages importing `server/src`. The server gets a third
vitest project, `pg`, which includes `src/**/*.pg.test.ts` and has
`globalSetup: ['../test/pg/globalSetup.ts']`. The existing `unit` and `integration` projects are
untouched, so they still run without docker until 4c moves the catalog.

**Setup** (`test/pg/globalSetup.ts`):
1. Check `docker info`. If it fails, throw "the catalog tests need a running docker daemon (they
   use the pinned supabase/postgres image)".
2. Reap stale containers. Each container is labelled `autologger-test-pg.pid=<pid>`, and only
   those whose pid is no longer alive on this host are removed, so concurrent runs never touch
   each other.
3. Read the pinned image from `docker/supabase-db.yaml`, and `docker pull` it with a 10-minute
   timeout. CI pulls cold (A10).
4. Run `docker run -d --rm` with:
   - `-p 127.0.0.1::5432`;
   - `-e POSTGRES_PASSWORD -e APP_DB_PASSWORD`, values random per run, passed only through the
     docker client's environment;
   - the migrations and `migrate.sh` mounted read-only;
   - the stack's exact `db` command (`postgres -c config_file=/etc/postgresql/postgresql.conf -c
     log_min_messages=fatal`) plus `-c max_connections=300`.
5. Wait until `pg_isready -h localhost` and then `select 1` over TCP succeed twice, 1 s apart. The
   socket-ready check alone fires before initdb's restart (A17).
6. `docker exec -u postgres -e APP_DB_PASSWORD`: create `autologger_template`, then run
   `/migrate.sh` on `postgres` and on `autologger_template` (A11).
7. Expose the host port and both passwords to tests through `project.provide`.

**Teardown.** `docker rm -f`.

**Per test** (`test/pg/testDb.ts`). `createTestDatabase()` connects as `postgres` from the host
with postgres.js (`max: 1`), runs `CREATE DATABASE t_<random> TEMPLATE autologger_template`, and
returns connection options for `autologger_app` and `postgres`. Callers end their pools in
`afterEach`. Clones are not dropped: dropping is slow (A9), and the container is discarded.

`postgres` (postgres.js 3.4.9) becomes a root devDependency. 4b adds it to `packages/storage`'s
dependencies.

**ADR wording.** ADR 0021's "rollback per test" is met as a database per test (owner decision),
recorded in the ADR. The code under test opens its own transactions.

## D7. Tests (written first)

**`server/src/test/pg/catalogSchema.pg.test.ts`** (pg project). Each case runs on a per-test clone
unless it names the `postgres` database.

- **Schema parity.**
  - Every table's column names and order match `PRAGMA table_info` of a SQLite catalog built by
    `applyMigrations` into a temp file. So do the primary keys, the unique constraint, the foreign
    keys (with their actions) and the two named indexes.
  - Nullability matches, except that PK columns are NOT NULL in Postgres.
  - Types and defaults are checked against a fixed expected table in the test, not compared as
    rendered text.
  - The parity test is deleted with the SQLite catalog in 4e.
- **Seed shows** read back with SQLite's post-0005 values.
- **Collation:** `ORDER BY name` over `B` and `a` returns `B` first.
- **Range:**
  - `kv.expires_at` round-trips `Date.now() + 86_400_000`;
  - `start_offset_frames` round-trips `3_000_000_000`;
  - `frame_rate` round-trips `29.97`.

  int8 values are compared after `Number(...)`, because 4b owns the parser (A23).
- **The app role, connected from the host as `autologger_app`:**
  - insert, select, update and delete work on every table, named without a schema;
  - each of these is refused: `CREATE TABLE` in `catalog` and in `public`, `TRUNCATE`, `DROP`,
    `set role postgres`, and reading `auth.users`;
  - `pg_roles` shows `rolconnlimit = 20`, its timeouts, and no memberships.
- **No exposure, on the `postgres` database:**
  - `has_schema_privilege` and `has_table_privilege` are false for `anon`, `authenticated`,
    `service_role` and `public` on `catalog` and each table;
  - `set role anon; select … from catalog.users` is refused.
- **Password step:**
  - from the host through the published port, `autologger_app` logs in with the run's password,
    and a wrong password is refused (A18);
  - queried as `postgres` on the `postgres` database, `extensions.pg_stat_statements` has no row
    containing the password;
  - `docker logs` of the container doesn't contain it.
- **Role guard:** running the migration's role block a second time leaves the attributes
  unchanged.

**`test/pg/globalSetup.test.ts`** (server unit project, injected `docker` stub):
- a failing `docker info` rejects with the daemon message;
- the `docker run` argv contains no password and publishes only on `127.0.0.1`;
- stale reaping removes only containers whose labelled pid is dead.

**`server/src/test/pg/harness.pg.test.ts`:** two tests each create a database, and a row inserted
in one is absent in the other.

**Tooling tests**, extending the existing suites:
- `docker/scripts/compose-run.test.mjs`:
  - the `APP_DB_PASSWORD` format is refused;
  - its value is refused in `rest`, and in `api` on dev or `app` on prod;
  - it is allowed in `app`/`migrate` on dev and `api`/`migrate` on prod.
- `docker/scripts/supabase-keys.test.mjs`: the generator creates a missing `APP_DB_PASSWORD` and
  keeps an existing one.
- `docker/scripts/test_check_envs.sh` (run by hand, needs docker). Each of these fails:
  - `APP_DB_PASSWORD` in `rest`;
  - the dev `companion` on `db` or on `catalog`;
  - `rest` on `catalog`;
  - the app on `db`;
  - a new service with `network_mode: service:app`;
  - `POSTGRES_PASSWORD` in `app`.

  The committed tree passes.
- `docker/supabase/test_migrate.sh` (by hand, needs docker):
  - `runner()` passes `APP_DB_PASSWORD`;
  - the runner refuses unset, `-e`, multi-line and short values before connecting;
  - the existing fixtures pass with "app role absent";
  - the `^N applied` summaries are now real.

## D8. Size

Counted (non-test) lines, estimated:

| Item | Lines |
|---|---|
| Migration SQL | ~130 |
| `migrate.sh` | ~25 |
| Compose files ×3 (the `catalog` network, `db`, the app) | ~40 |
| `dev-gate.Caddyfile` | ~5 |
| `compose-run.mjs` | ~10 |
| `check-envs.sh` | ~25 |
| `supabase-keys.mjs` | ~2 |
| Vitest config and `package.json` | ~10 |
| **Total** | **~250-300** |

`test/**`, `**/test/**`, `*.test.*`, `test_*` and `docs/` are excluded.
