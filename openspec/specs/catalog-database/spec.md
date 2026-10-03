# catalog-database Specification

## Purpose
The catalog's Postgres home (ADR 0021 slice 4): the `catalog` schema, a faithful port of the
retired SQLite catalog, held to a recorded expectation; the least-privilege `autologger_app` role the app connects as; the limits that keep
the catalog away from the Supabase API roles; and the pinned-image Postgres that tests run against.

## Requirements

### Requirement: The catalog schema lives in Postgres schema `catalog`
Migrations in `supabase/migrations/` SHALL create the schema `catalog` with the catalog tables
`users`, `user_studio_memberships`, `user_prefs`, `studio_definitions`, `shows`, `app_settings`,
`sessions`, `kv`, `team_invites` and `show_grants`. Their columns, nullability, defaults, primary keys, unique
constraint, check constraints, foreign keys (every column) and index definitions SHALL equal a
recorded schema expectation that the catalog schema tests hold as literal values, under this
type mapping (the
expectation was first captured from the retired SQLite catalog's migrations 0001-0006, ADR 0021
slice 4e):
- every text column SHALL be `text` with `COLLATE "C"`, so comparison and ordering are bytewise;
- every integer column SHALL be `bigint` (8 bytes);
- `sessions.frame_rate` SHALL be `double precision`.

A later migration that changes the catalog schema SHALL update the recorded expectation in the
same change.

**Team roles (ADR 0021 slice 5c).** `user_studio_memberships.role` SHALL be constrained to
`owner`, `admin` or `member`, and a partial unique index on `studio_id` where `role = 'owner'`
SHALL allow at most one owner per team. No migration SHALL assign an owner.

**Show grants (ADR 0021 slice 6a).** `show_grants` SHALL hold one row per `(user_id, show_id)`
(its primary key), with `can_write` (a 0/1 flag like the other flags: `bigint`, not null,
default `1`), `granted_by_user_id` (text, nullable) and `granted_at_utc` (ISO-8601 text, not
null); every text column is `COLLATE "C"`. Its
`user_id` SHALL reference `users` and its `show_id` SHALL reference `shows`, both `on delete
cascade`, so deleting a user or a show deletes its grants; `granted_by_user_id` SHALL have no
foreign key, so a grant outlives the account that made it. An index led by `show_id` SHALL
exist. No migration SHALL insert a grant.

Timestamps SHALL stay ISO-8601 text, flags 0/1 integers and JSON text (a faithful port; a typed
schema is a post-migration follow-up). The two seed shows `show-autolog-test` and
`show-the-something-podcast` SHALL exist with the recorded seed values, and so SHALL the two
teams they belong to: `studio_definitions` rows `test-studios` ("Test Studio") and
`test-studio-2` ("Test Studio 2"), ordered before any team created later. The global
`app_settings` keys `active_studio_id` and `active_show_id` SHALL NOT exist after the migrations
run. The catalog SHALL NOT be created in schema `public`.

#### Scenario: The Postgres schema matches the SQLite catalog
- **WHEN** the catalog migrations are applied to a fresh database
- **THEN** every catalog table has exactly the recorded columns, types, collations, nullability,
  defaults, primary keys, unique constraint, check constraints, foreign keys and indexes, and the
  two seed shows and the two seed teams have exactly the recorded values; no SQLite catalog is
  built to compare against

#### Scenario: Ordering is bytewise
- **WHEN** shows named `a` and `B` exist and are selected ordered by `name`
- **THEN** `B` comes first

#### Scenario: Large and fractional values round-trip
- **WHEN** a `kv` row stores an `expires_at` of the current epoch milliseconds plus one day, and
  a session stores a `start_offset_frames` of `3000000000` and a `frame_rate` of `29.97`
- **THEN** all three read back with the same numeric values

#### Scenario: A second owner is refused by the database
- **WHEN** `autologger_app` inserts a second membership with `role = 'owner'` for a team that
  already has an owner, or a membership whose role is `superuser`
- **THEN** the first insert fails with a unique violation (`23505`), the second with a check
  violation (`23514`), and the team still has one owner

#### Scenario: The seed teams own the seed shows
- **WHEN** the catalog migrations are applied to a fresh database
- **THEN** `test-studios` and `test-studio-2` are `studio_definitions` rows with no members,
  each seed show's `studio_id` names one of them, and `app_settings` holds no `active_studio_id`
  or `active_show_id` row

#### Scenario: A grant goes with its user or its show
- **WHEN** `autologger_app` inserts grants for user U on shows A and B, then deletes show A, then
  deletes user U
- **THEN** after the first delete only U's grant on B remains, and after the second no grant
  remains; a grant naming a user or show that does not exist fails with `23503`

### Requirement: The app connects as a least-privilege role
The migration SHALL create the role `autologger_app` and SHALL always reset it to no `CREATEDB`,
`CREATEROLE` or `BYPASSRLS`, a connection limit of 20, a `statement_timeout` of 30 seconds and an
`idle_in_transaction_session_timeout` of 15 seconds. The migration SHALL fail if the role is a
superuser or a replication role (the migrations user, not a superuser, cannot reset those two
attributes).

**Memberships (ADR 0021 slice 6b-1).** `autologger_app` SHALL be a member of exactly two roles,
`catalog_user` and `catalog_system` (catalog-database "Catalog roles for user and system
callers"), each granted with `INHERIT FALSE` and `SET TRUE` and without the admin option, so it
can switch to either role but holds none of their privileges while it has not. Every migration
that checks the role SHALL fail when `autologger_app` holds any other membership, or one of these
two with `INHERIT TRUE` or the admin option; the migration that creates the two roles SHALL also
fail unless both memberships exist exactly so. These checks SHALL pass when the migrations are
applied to a second database of the same cluster, where the role and its memberships already
exist.

Its only privilege of its own SHALL be `USAGE` on schema `catalog`; it SHALL hold no privilege on
any catalog table, including tables later migrations create there, so a statement it sends
without switching to a catalog role is refused. Its `search_path` SHALL be `catalog`. The
migration SHALL hold no password. Creating the role SHALL be safe when the role already exists in
the cluster.

#### Scenario: The app role reads and writes catalog rows
- **WHEN** `autologger_app`, after switching to `catalog_user` and again after switching to
  `catalog_system`, inserts, selects, updates and deletes a row in each catalog table, naming the
  tables without a schema
- **THEN** each statement succeeds

#### Scenario: The app role cannot change the schema
- **WHEN** `autologger_app` runs `CREATE TABLE` in `catalog` or `public`, `TRUNCATE` or `DROP`
  on a catalog table, `set role postgres`, or reads `auth.users`
- **THEN** each statement is refused with a permission error

#### Scenario: The app role alone is refused
- **WHEN** `autologger_app`, without switching role, selects from, inserts into, updates or
  deletes from each catalog table
- **THEN** each statement is refused with `42501`

#### Scenario: Only the two memberships pass the role check
- **WHEN** the migrations' role check runs while the checked role holds a third membership, or
  holds `catalog_user` with `INHERIT TRUE`, or holds `catalog_system` with the admin option
- **THEN** the check raises an error and the migration fails

#### Scenario: A second database in the cluster migrates cleanly
- **WHEN** the catalog migrations are applied to one database and then to a second database in
  the same cluster
- **THEN** both runs succeed, and `autologger_app` still holds exactly the two memberships

### Requirement: The catalog is not exposed through the Supabase API roles
The roles `anon`, `authenticated` and `service_role`, and the `public` pseudo-role, SHALL have
no privilege on schema `catalog` or on any table in it, so neither PostgREST nor pg_graphql can
serve catalog rows. No role other than `autologger_app` and `postgres` (which created them)
SHALL be a member of `catalog_user` or `catalog_system`, so `authenticator` and the API roles
cannot switch to them. `public` SHALL NOT be able to execute any function in schema `catalog`.
(The `postgres` role reads every table through its `pg_read_all_data` membership and owns the
tables with `BYPASSRLS`; that reach, held by `db`, `migrate` and `realtime`, is out of slice 6's
scope.)

#### Scenario: The anon role cannot read users
- **WHEN** a session in the `postgres` database runs `set role anon` and selects from
  `catalog.users`
- **THEN** the select is refused with a permission error

#### Scenario: No API role holds a catalog privilege
- **WHEN** `has_schema_privilege` and `has_table_privilege` are checked for `anon`,
  `authenticated`, `service_role` and `public` on `catalog` and each of its tables
- **THEN** every check is false

#### Scenario: No API role can assume a catalog role
- **WHEN** the members of `catalog_user` and `catalog_system` are listed, and `authenticator`,
  `anon`, `authenticated` and `service_role` are checked with `pg_has_role(…, 'SET')`
- **THEN** the only members are `autologger_app` and `postgres`, and every check is false

#### Scenario: Catalog functions are not executable by public
- **WHEN** the execute privilege of `public` is checked on every function in schema `catalog`
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

### Requirement: Catalog roles for user and system callers
The migrations SHALL create two roles, `catalog_user` (statements made for a signed-in user) and
`catalog_system` (statements made for a named system task). Each SHALL be `NOLOGIN`, without
`BYPASSRLS`, `CREATEDB`, `CREATEROLE`, `REPLICATION` or superuser, and a member of no role.
Creating them SHALL be safe when they already exist in the cluster, and SHALL reset those
attributes.

Each SHALL hold `USAGE` on schema `catalog` and `SELECT`, `INSERT`, `UPDATE` and `DELETE` on
every catalog table, including tables later migrations create there, and nothing else in the
catalog except `EXECUTE` on the functions named for them.

The function `catalog.app_user_id()` SHALL return the user id the current transaction set
(`app.user_id`), or null when none is set or it is empty. Only the two catalog roles SHALL be
able to execute it.

A role switch and a user id SHALL hold for one transaction only: after the transaction commits,
rolls back or fails, the connection is back to `autologger_app` with no user id.

#### Scenario: The roles exist as designed
- **WHEN** the catalog migrations have been applied
- **THEN** `catalog_user` and `catalog_system` exist with `rolcanlogin`, `rolbypassrls`,
  `rolsuper`, `rolcreatedb`, `rolcreaterole` and `rolreplication` all false, and neither is a
  member of any role

#### Scenario: The user id is read per transaction
- **WHEN** `autologger_app` begins a transaction, switches to `catalog_user` for that
  transaction, sets the transaction's user id to `u-1`, and calls `catalog.app_user_id()`, then
  commits and calls nothing else
- **THEN** the call returns `u-1`, and after the commit `current_user` is `autologger_app` and
  the transaction's user id is no longer set

#### Scenario: A failed transaction does not leak its role
- **WHEN** a transaction switches to `catalog_system` and then fails with an error, and the same
  connection runs a new statement without switching
- **THEN** `current_user` is `autologger_app`, and a catalog table read is refused with `42501`

### Requirement: Row-level security is enabled on every catalog table
Every table in schema `catalog` SHALL have row-level security enabled, and for each of
`catalog_user` and `catalog_system` at least one policy SHALL apply. Until slice 6b-2 replaces
them, each table's policies SHALL be permissive and allow every row for reading and writing, so
the catalog answers every statement exactly as it did before row-level security. A migration
that creates a catalog table SHALL enable row-level security on it and give it its policies in
the same migration.

#### Scenario: No catalog table is left without row-level security
- **WHEN** the tables of schema `catalog` are listed with their row-level security flag and the
  roles their policies apply to
- **THEN** every table has row-level security enabled and at least one policy for
  `catalog_user` and one for `catalog_system`

#### Scenario: Allow-all policies change nothing
- **WHEN** `catalog_user` with user id `u-1` and `catalog_system` each insert, select, update
  and delete rows of every catalog table, including rows that name another user
- **THEN** every statement affects the same rows it would without row-level security
