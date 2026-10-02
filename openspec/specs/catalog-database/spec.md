# catalog-database Specification

## Purpose
The catalog's Postgres home (ADR 0021 slice 4): the `catalog` schema, a faithful port of the
SQLite catalog; the least-privilege `autologger_app` role the app connects as; the limits that keep
the catalog away from the Supabase API roles; and the pinned-image Postgres that tests run against.

## Requirements

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

### Requirement: The server's catalog runs on Postgres
The server SHALL keep its catalog only in the Postgres `catalog` schema: users, memberships,
preferences, teams, shows, settings, the session index, invites and key/value entries. It SHALL
connect as `autologger_app`, using the connection settings its compose stack passes (`PGHOST`,
`PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`). It SHALL NOT open, create or migrate a SQLite
catalog file. One catalog adapter per server process SHALL serve every catalog store and the
key/value store.

The server SHALL NOT apply catalog migrations; the stack's migrations service does.

**Boot.** Before listening, the server SHALL wait for the catalog to answer a query on the `kv`
table, for at most 30 seconds in total. Each attempt SHALL be bounded by the time remaining. It
SHALL log each distinct failure code once, as it first appears, and SHALL exit non-zero if the
catalog is not ready in time. The supervisor then retries.

**Password rotation.** Rotating the app role's password SHALL follow this order:
1. change the secret;
2. apply the migrations service, which sets the role's password;
3. recreate the app.

Between steps 2 and 3, new catalog connections fail.

**Show order.** Listing a team's shows SHALL order them by name, ignoring ASCII letter case.
Names that are equal in that order SHALL be sorted bytewise.

**Error logs.** When an unexpected catalog error is logged, the log SHALL name the error's code,
constraint and table, and SHALL NOT include the values involved.

#### Scenario: Catalog writes land in Postgres
- **WHEN** the server creates a team, a show and a session, and the app restarts
- **THEN** all three are read back after the restart, and no `catalog.db` file exists in a `DATA_DIR` that had none

#### Scenario: The server waits for the migrated catalog
- **WHEN** the server starts before the catalog schema exists, and the migrations service applies it within 30 seconds
- **THEN** the server begins listening after the schema appears, without a restart

#### Scenario: An unreachable catalog stops boot
- **WHEN** the catalog does not answer a query on `kv` within 30 seconds of start
- **THEN** the server exits non-zero within a few seconds after the 30 seconds, without having listened

#### Scenario: Shows sort case-insensitively
- **WHEN** a team has shows named `b`, `A` and `a`
- **THEN** listing them returns `A`, `a`, `b`

#### Scenario: A duplicate-key error logs no values
- **WHEN** an unexpected unique violation on a user's email reaches the server's error handler
- **THEN** the response is the generic `500`, and the log line names the code and constraint but not the email

### Requirement: Session live projection is mirrored in order
The catalog's copy of a session's live projection SHALL be written by one ordered writer per
session in the server process. Each write SHALL carry the session's state at the moment it is
sent, not when it was queued, so a slower earlier write never overwrites a later state. The
columns are:
- event count;
- latest timecode;
- rolling;
- current take;
- elapsed frames;
- roll start.

A write that fails SHALL be logged at warning level and SHALL NOT fail the request. When a write
times out on the client, the next write for that session SHALL wait until the timed-out
statement has finished on the server, so the order holds. A detached job that outlives its
request SHALL NOT use the request's catalog. After shutdown begins, the writer SHALL write
nothing.

#### Scenario: Out-of-order completion
- **WHEN** two changes to one session commit in order A then B, and A's mirror write would reach the database after B's
- **THEN** the catalog ends with the projection of B's state

### Requirement: Settings defaults are race-free and never recreate a deleted team
Reading a team's settings SHALL write the default settings only when none are stored and the team
exists. It SHALL do so with a statement that never overwrites settings a concurrent request
stored, and it SHALL NOT use a transaction that concurrent first reads can conflict on. A
corrupt stored blob SHALL be replaced only if it is still the blob that was read. Reading the
settings of a team that does not exist SHALL return defaults without storing them. A settings row
that a read racing a team delete still writes SHALL never reach a later team with the same id,
because team creation removes it (team-management "Concurrent team writes").

#### Scenario: Concurrent first loads
- **WHEN** five profile loads for a new team run at the same time
- **THEN** all succeed, and one settings row exists for the team

#### Scenario: A deleted team stays deleted
- **WHEN** a request reads team T's settings after T's deletion has committed
- **THEN** no settings row for T is written

### Requirement: Expired key/value rows are purged periodically
The server SHALL purge expired key/value rows at boot and every 10 minutes while running. A
failed purge SHALL only warn.

#### Scenario: Sign-in starts don't accumulate
- **WHEN** many sign-in starts are made and their states expire
- **THEN** within 10 minutes of expiry their rows are gone without a restart
