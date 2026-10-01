## ADDED Requirements

### Requirement: The catalog schema lives in Postgres schema `catalog`
A migration in `supabase/migrations/` SHALL create the schema `catalog` with the catalog tables
`users`, `user_studio_memberships`, `user_prefs`, `studio_definitions`, `shows`, `app_settings`,
`sessions`, `kv` and `team_invites`. Their columns, nullability, defaults, primary keys, unique
constraint, foreign keys and indexes SHALL match the SQLite catalog that
`packages/catalog/migrations` builds, with these types:
- every text column SHALL be `text` with `COLLATE "C"`, so comparison and ordering are bytewise
  as in SQLite;
- every integer column SHALL be `bigint`, as SQLite integers are 8 bytes;
- `sessions.frame_rate` SHALL be `double precision`.

Timestamps SHALL stay ISO-8601 text, flags 0/1 integers and JSON text (a faithful port; a typed
schema is a post-migration follow-up). The two seed shows `show-autolog-test` and
`show-the-something-podcast` SHALL exist with the values SQLite holds after its migration 0005.
The catalog SHALL NOT be created in schema `public`.

#### Scenario: The Postgres schema matches the SQLite catalog
- **WHEN** the catalog migration is applied to a fresh database and `applyMigrations` builds a
  SQLite catalog
- **THEN** every table has the same columns, nullability, defaults, keys and indexes, under the
  type mapping above

#### Scenario: Ordering is bytewise
- **WHEN** shows named `a` and `B` exist and are selected ordered by `name`
- **THEN** `B` comes first, as in SQLite

#### Scenario: Large and fractional values round-trip
- **WHEN** a `kv` row stores an `expires_at` of the current epoch milliseconds plus one day, and
  a session stores a `start_offset_frames` of `3000000000` and a `frame_rate` of `29.97`
- **THEN** all three read back with the same numeric values

### Requirement: The app connects as a least-privilege role
The migration SHALL create the role `autologger_app` and SHALL always reset it to no `CREATEDB`,
`CREATEROLE` or `BYPASSRLS`, a connection limit of 20, a `statement_timeout` of 30 seconds and an
`idle_in_transaction_session_timeout` of 15 seconds. The migration SHALL fail if the role is a
superuser, a replication role, or a member of any role (the migrations user, not a superuser,
cannot reset those two attributes). Its only privileges SHALL be `USAGE` on schema
`catalog` and `SELECT`, `INSERT`, `UPDATE` and `DELETE` on the catalog's tables, including tables
later migrations create there. Its `search_path` SHALL be `catalog`. The migration SHALL hold no
password. Creating the role SHALL be safe when the role already exists in the cluster.

#### Scenario: The app role reads and writes catalog rows
- **WHEN** `autologger_app` inserts, selects, updates and deletes a row in each catalog table,
  naming the tables without a schema
- **THEN** each statement succeeds

#### Scenario: The app role cannot change the schema
- **WHEN** `autologger_app` runs `CREATE TABLE` in `catalog` or `public`, `TRUNCATE` or `DROP`
  on a catalog table, `set role postgres`, or reads `auth.users`
- **THEN** each statement is refused with a permission error

### Requirement: The catalog is not exposed through the Supabase API roles
The roles `anon`, `authenticated` and `service_role`, and the `public` pseudo-role, SHALL have
no privilege on schema `catalog` or on any table in it, so neither PostgREST nor pg_graphql can
serve catalog rows. (The `postgres` role reads every table through its `pg_read_all_data`
membership; that reach, held by `db`, `migrate` and `realtime`, is left to slice 6.)

#### Scenario: The anon role cannot read users
- **WHEN** a session in the `postgres` database runs `set role anon` and selects from
  `catalog.users`
- **THEN** the select is refused with a permission error

#### Scenario: No API role holds a catalog privilege
- **WHEN** `has_schema_privilege` and `has_table_privilege` are checked for `anon`,
  `authenticated`, `service_role` and `public` on `catalog` and each of its tables
- **THEN** every check is false

### Requirement: Catalog tests run against the pinned Postgres image
Tests that need Postgres SHALL get it from a vitest global setup kept in `test/pg/` at the
repository root, which runs the image pinned in `docker/supabase-db.yaml` with that stack's `db`
command, published only on `127.0.0.1`, waits until the server accepts TCP queries after the
image's initialization restart, and applies `supabase/migrations` with
`docker/supabase/migrate.sh` to the `postgres` database and to a template database. Each test
that asks for a database SHALL get its own copy of the template. Superuser and app passwords
SHALL be random per run and SHALL NOT appear on any command line. A run SHALL remove only
leftover test containers whose owning process has exited. When no docker daemon is reachable,
the run SHALL fail with a message that says the tests need one.

#### Scenario: Each test gets an isolated database
- **WHEN** two tests each create a test database and one inserts a user
- **THEN** the other test's database has no such user

#### Scenario: No docker, a clear failure
- **WHEN** the Postgres tests run where `docker info` fails
- **THEN** the run fails with a message saying the catalog tests need a running docker daemon

#### Scenario: Secrets stay off the docker command line
- **WHEN** the global setup builds its `docker run` and `docker exec` commands
- **THEN** no argument contains either password, and the only published address is `127.0.0.1`
