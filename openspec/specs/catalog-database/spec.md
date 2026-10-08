# catalog-database Specification

## Purpose
The catalog's Postgres home (ADR 0021 slice 4): the `catalog` schema, a faithful port of the
retired SQLite catalog, held to a recorded expectation; the least-privilege `autologger_app` role the app connects as; the limits that keep
the catalog away from the Supabase API roles; and the pinned-image Postgres that tests run against.

## Requirements

### Requirement: The catalog schema lives in Postgres schema `catalog`
Migrations in `supabase/migrations/` SHALL create the schema `catalog` with the catalog tables
`users`, `user_studio_memberships`, `user_prefs`, `studio_definitions`, `shows`, `app_settings`,
`sessions`, `kv`, `team_invites` and `show_grants`, and the nine session tables (catalog-database
"Session content tables"). Their columns, nullability, defaults, primary keys, unique
constraint, check constraints, foreign keys (every column) and index definitions SHALL equal a
recorded schema expectation that the catalog schema tests hold as literal values, under this
type mapping (the
expectation was first captured from the retired SQLite catalog's migrations 0001-0006, ADR 0021
slice 4e):
- every text column SHALL be `text` with `COLLATE "C"`, so comparison and ordering are bytewise;
- every integer column SHALL be `bigint` (8 bytes);
- `sessions.frame_rate` and every real-valued session column (frame rates, seconds, scores, the
  waveform floor) SHALL be `double precision`.

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

#### Scenario: The session tables match the recorded expectation
- **WHEN** the migrations are applied to a fresh database
- **THEN** the nine session tables exist in schema `catalog` with exactly the recorded columns,
  types, collations, nullability, defaults, primary keys, foreign keys and indexes, and none of
  them exists in schema `public`

### Requirement: The app connects as a least-privilege role
The migration SHALL create the role `autologger_app` and SHALL always reset it to no `CREATEDB`,
`CREATEROLE` or `BYPASSRLS`, a connection limit of 45 (three server processes of 14 connections each, ADR 0021 slice 9a; owner,
2026-10-07), a `statement_timeout` of 30 seconds and an
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

### Requirement: Settings defaults are race-free and never recreate a deleted team
Reading a team's settings SHALL NOT write anything: no insert, update or delete of any settings
row, whether the stored blob is present, missing or corrupt.
- A missing blob SHALL read as the default settings.
- A corrupt blob (not JSON, or not an object) SHALL read as the default settings and stay
  stored as it is.
- Reading the settings of a team that does not exist SHALL return the defaults.

Creating a team (the self-serve and the admin plane alike) SHALL store the team's default
settings in the same transaction that inserts the team definition. That row SHALL replace any
settings left under a reused id (team-management "Concurrent team writes"). Saving settings SHALL
store the saved blob, as before.

The migration that introduces this rule SHALL store default settings for every existing team that
has no settings row, and SHALL leave stored rows untouched. Those defaults SHALL have the shape
the server's own defaults have, with freshly generated category ids.

#### Scenario: Concurrent first loads
- **WHEN** five profile loads for a newly created team run at the same time
- **THEN** all succeed, every load returns the same category ids, and the team's one settings
  row is the row its creation stored

#### Scenario: A read writes nothing
- **WHEN** a team's settings row is missing, and a plain member loads `GET /api/profile`
- **THEN** the response is `200` with default settings for the team, and the team still has no
  settings row

#### Scenario: A corrupt blob is left as it is
- **WHEN** a team's stored settings are not valid JSON, and the settings are read
- **THEN** the read returns the default settings, and the stored value is unchanged

#### Scenario: A deleted team stays deleted
- **WHEN** a request reads team T's settings after T's deletion has committed
- **THEN** no settings row for T is written

#### Scenario: Team creation stores defaults
- **WHEN** a user creates team T, or the support plane creates it
- **THEN** exactly one settings row for T exists when the create commits, holding default
  settings

#### Scenario: Existing teams are backfilled
- **WHEN** the migration runs on a catalog where team A has no settings row and team B has one
- **THEN** A gets a default settings row whose shape matches the server's defaults, and B's row
  is unchanged

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

Each SHALL hold `USAGE` on schema `catalog`. `catalog_system` SHALL hold `SELECT`, `INSERT`,
`UPDATE` and `DELETE` on every catalog table. `catalog_user` SHALL hold the same, except:
- on `kv`, no privilege;
- on `users`, `SELECT`, and `UPDATE` of `given_name` and `family_name` only (no `INSERT`, no
  `DELETE`, no update of any other column);
- on `user_studio_memberships` and `team_invites`, no `INSERT`.

Both grants SHALL cover tables that later migrations create in the schema. Neither role SHALL hold anything else in the catalog except
`EXECUTE` on the functions named for it:
- `catalog.app_user_id()`, for both roles;
- the policy helpers (see "Policy helpers are reviewed definer functions"), for `catalog_user`
  only.

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

#### Scenario: The user role's narrowed privileges
- **WHEN** a transaction switched to `catalog_user` with user id `u-1`:
  - updates `email`, `google_sub`, `picture_url` or `disabled_at_utc` of `u-1`'s own `users`
    row;
  - inserts or deletes a `users` row;
  - inserts into `user_studio_memberships` or `team_invites` for a team in which `u-1` is the
    owner
- **THEN** each statement is refused with `42501`, while an update of `u-1`'s own `given_name`
  and `family_name` succeeds

#### Scenario: Key/value is closed to the user role
- **WHEN** a transaction switched to `catalog_user` with a user id selects from, inserts into,
  updates or deletes from `catalog.kv`
- **THEN** each statement is refused with `42501`, and the same statements as `catalog_system`
  succeed

### Requirement: Row-level security is enabled on every catalog table
Every table in schema `catalog` SHALL have row-level security enabled. Every catalog table SHALL
have at least one policy for `catalog_system`. Every table except `kv`, `companion_devices` and
`companion_presence` SHALL also have at least one policy for `catalog_user`, the nine session
tables included (ADR 0021 slice 7b-2): a user binding reads and writes session content only as
"User policies enforce the team permission model" allows. Those three tables are system-only:
they have no `catalog_user` policy and `catalog_user` SHALL have no privilege on them.
`companion_devices` is read and written only by the reviewed system task `companion-device`, and
`companion_presence` only by `companion-presence` (ADR 0021 slice 9d).

The `catalog_system` policies SHALL be permissive and allow every row for reading and writing.

The `catalog_user` policies SHALL be the ones "User policies enforce the team permission model"
defines; no `catalog_user` policy SHALL allow every row.

A migration that creates a catalog table SHALL, in the same migration:
- enable row-level security on it;
- give it a `catalog_system` policy;
- give it `catalog_user` policies, or revoke `catalog_user`'s privileges on it.

#### Scenario: No catalog table is left without row-level security
- **WHEN** the tables of schema `catalog` are listed with their row-level security flag and the
  roles their policies apply to
- **THEN** every table has row-level security enabled and a policy for `catalog_system`; every
  table other than `kv`, `companion_devices` and `companion_presence` has at least one policy for
  `catalog_user`, each session table exactly one; and those three have no `catalog_user` policy

#### Scenario: No user policy allows everything
- **WHEN** the `catalog_user` policies of schema `catalog` are listed with their `USING` and
  `WITH CHECK` expressions
- **THEN** none of them is the constant `true`

#### Scenario: Allow-all policies change nothing
- **WHEN** `catalog_system` inserts, selects, updates and deletes rows of every catalog table,
  including rows that name another user and rows of teams no user is a member of
- **THEN** every statement affects the same rows it would without row-level security

#### Scenario: A user binding is refused on the session tables
- **WHEN** `autologger_app`, switched to `catalog_user` with the id of a user who has no access
  to session S's show (another team's owner, a member of S's team without a grant, or no user
  id), selects from, inserts into, updates or deletes from each session table for S
- **THEN** a user without access is refused: each select returns no row of S, each update and
  delete affects no row, and each insert fails with `42501`; the same statements with the id of
  the owner of S's team, or of a member with any grant on S's show, read and write S's rows

### Requirement: User policies enforce the team permission model
For a statement run as `catalog_user`, the database SHALL decide row by row from the
transaction's user id (`catalog.app_user_id()`), the user's memberships and roles, and the show
grants, as committed or as written earlier in the same transaction. A statement with no user id
SHALL see no row and write none. The app's gates stay the precise check (the 6a rules), and these
policies are the backstop behind them.

In the table below:
- a *member team* is a team in which the user has a membership of any role;
- a *managed team* is one in which the user is `owner` or `admin`;
- an *accessible show* is a show of a managed team, or a show of a member team for which the user
  holds a grant.

| table | read | insert | update | delete |
| --- | --- | --- | --- | --- |
| `users` | own row, and users with a membership in a member team | refused | own row, name columns only | refused |
| `user_studio_memberships` | rows of member teams | refused | rows of member teams | rows of member teams |
| `user_prefs` | own row | own row | own row | own row |
| `studio_definitions` | member teams | none | member teams | member teams |
| `shows` | shows of member teams | shows of managed teams | shows of managed teams | none |
| `sessions` | sessions of shows of member teams | sessions of accessible shows | sessions of accessible shows | none |
| `app_settings` | `studio_config:<id>` of member teams | `studio_config:<id>` of managed teams | `studio_config:<id>` of managed teams | `studio_config:<id>` of managed teams |
| `team_invites` | invites of member teams | refused | invites of member teams | invites of member teams |
| `show_grants` | grants on shows of member teams | grants on shows of member teams | grants on shows of member teams | grants on shows of member teams |
| the nine session tables | rows of sessions of accessible shows | rows of sessions of accessible shows | rows of sessions of accessible shows | rows of sessions of accessible shows |
| `kv` | refused | refused | refused | refused |

A session row's content is reachable exactly where `requireSession` admits the user (team-management
"Member content access"), whatever the grant's `can_write`; a member of the team without a grant
reads the session's `sessions` row (its title) and none of its content. The cost of this rule for
one statement SHALL NOT grow with the number of sessions the user can access.

The rules work as follows:
- An update SHALL require the rule both for the row as it was and for the row as written.
- A `SELECT … FOR SHARE` of a row SHALL succeed wherever the row's read and update rules both
  hold. In particular, it SHALL succeed on the user's own membership, on another membership row
  in a member team, and on the user's own grant in a member team.
- A read the rules refuse SHALL behave as if the row did not exist.
- An update or delete of a refused row SHALL affect no row and raise no error.
- An insert, or the inserted or updated row of an update, that the rules refuse SHALL fail with
  `42501`. This includes an insert with `ON CONFLICT DO NOTHING` or `ON CONFLICT DO UPDATE`.

The rules hold the team boundary; they do not hold the role inside a team. Within a member team,
the rules let a user update or delete membership, invite and grant rows whatever their role. That
precision belongs to the app's in-transaction role checks. The database adds one guard: at most
one `owner` per team.

New memberships and invites are added only through system bindings (team creation, invites,
sign-in, the bootstrap claim, the support plane).

The following SHALL succeed under these rules, as each user-bound path performs them:
- an ownership transfer, which demotes the caller and then promotes the target in one
  transaction;
- a team delete;
- a leave or a removal, which deletes the member's grants in the team and then the membership.

#### Scenario: The allow/deny matrix
- **WHEN** each table is read, inserted into, updated and deleted from as `catalog_user` by:
  - a team T's owner;
  - an admin of T;
  - a member of T with a grant on show S1;
  - a member of T without grants;
  - the owner of another team U who is not a member of T;
  - a transaction with no user id;

  on rows of T, of U and of the user's own
- **THEN** each read returns exactly the rows the table above allows, and each write affects the
  rows the table allows. A refused update or delete affects no row; a refused insert, or a
  refused new row of an update, fails with `42501`

#### Scenario: A member reads titles of an ungranted show's sessions but cannot change them
- **WHEN** a member of T without a grant on S1 selects the sessions of S1, then updates one of
  them
- **THEN** the select returns them, and the update affects no row

#### Scenario: A member without a grant sees no session content
- **WHEN** a member of T without a grant on S1 selects the events, transport, transcript words
  and meta of a session of S1, and inserts an event into it; and the member is then granted S1
  and repeats both
- **THEN** before the grant the selects return no row and the insert fails with `42501`; after
  the grant the selects return the session's rows and the insert succeeds

#### Scenario: Locking a session row needs show access
- **WHEN** a session of S1 is selected `FOR UPDATE` by T's owner, by a granted member of S1, by a
  member without a grant, and by the owner of another team
- **THEN** the first two lock the row, and the last two get no row and no error

#### Scenario: A non-member sees nothing of another team
- **WHEN** the owner of team U, who has no membership in T, selects from `users`, `shows`,
  `sessions`, `user_studio_memberships`, `studio_definitions`, `app_settings`, `team_invites` and
  `show_grants`
- **THEN** no row of T, and no user who is only in T, is returned

#### Scenario: Locked reads of own and target rows work
- **WHEN** inside a transaction a member of T selects their own membership in T `FOR SHARE`,
  then another member's membership in T `FOR SHARE`, and a granted member selects their own
  grant `FOR SHARE`
- **THEN** each returns the row; the same reads by a non-member of T return no row

#### Scenario: The owner's multi-step writes succeed
- **WHEN** the owner of T transfers ownership to an admin of T; and, separately, the owner of a
  team V with no shows deletes V as the team delete does; and a granted member of T leaves T
- **THEN** after the transfer T has one owner (the former admin) and the former owner is an
  admin; V's invites, definition, settings and memberships are all gone; and the leaving
  member's grants in T and membership in T are gone

#### Scenario: Cross-team conflicts are retried, not surfaced
- **WHEN** the owners of two different teams each run a catalog transaction through the
  server's adapter that reads their membership and writes a session, a show and their team's
  definition, interleaved so that each reads before the other commits, on a database with
  planner statistics
- **THEN** either transaction may abort with `40001`, the adapter retries it, and both
  transactions commit within the adapter's retry budget, with both teams' writes stored

#### Scenario: A member cannot make themselves a second owner
- **WHEN** a member of team T, which has an owner, updates their own membership's role to
  `owner` as `catalog_user`
- **THEN** the update fails with a unique violation (`23505`), and T still has one owner

### Requirement: Policy helpers are reviewed definer functions
The membership facts the policies need SHALL be read through `SECURITY DEFINER` functions in
schema `catalog`. They SHALL be owned by the migrations' role and SHALL pin `search_path` to
`pg_catalog, pg_temp`. They SHALL be executable by `catalog_user` only: not by `PUBLIC`,
`catalog_system`, `autologger_app` or any API role. They bypass row-level security, so each
function's own `WHERE` clause SHALL be its whole check. The functions SHALL be:
- `member_studios(uid)`: the ids of the user's member teams;
- `manager_studios(uid)`: the ids of the user's managed teams;
- `accessible_shows(uid)`: the ids of the user's accessible shows;
- `member_shows(uid)`: the ids of the shows of the user's member teams;
- `co_members(uid)`: the ids of the users with a membership in one of the user's member teams,
  the user included;
- `studio_exists(id)`: whether a team definition with that id exists;
- `show_exists(id)`: whether a show with that id exists;
- `session_exists(id)`: whether a session with that id exists.

A null or unknown `uid` SHALL give empty sets. The helpers SHALL be configured not to plan
sequential scans (`enable_seqscan = off`), so that where an index applies, the predicate locks a
`SERIALIZABLE` transaction takes in them cover index ranges rather than whole tables. Conflicts
that remain are retried by the adapter.

#### Scenario: Each helper returns exactly its set
- **WHEN** each helper is called for an owner, an admin, a granted member, an ungranted member,
  a user with no membership, and null
- **THEN** each returns exactly the expected ids or booleans, including empty sets for the last
  two

#### Scenario: Only the user role can call the helpers
- **WHEN** `has_function_privilege` is checked for `public`, `catalog_system`, `autologger_app`,
  `anon`, `authenticated` and `service_role` on each helper, and for `catalog_user`
- **THEN** every check is false except `catalog_user`'s, and each helper is `SECURITY DEFINER`
  with `search_path=pg_catalog, pg_temp` and `enable_seqscan=off` in its configuration

### Requirement: Session content tables
Each session's live content SHALL be stored in schema `catalog`, in nine tables that port the
retired per-session SQLite schema faithfully: `session_events`, `session_transport`,
`session_audio_segments`, `session_transcript_words`, `session_topics`,
`session_transcript_paragraphs`, `session_transcript_sentiment`, `session_dashboards` and
`session_meta`. They SHALL keep the per-session schema's columns, nullability and defaults under
the catalog's type mapping (timestamps as ISO-8601 text, flags as 0/1 integers, JSON as text),
with these changes only:
- every table SHALL have a non-null `session_id` that references `catalog.sessions (id)` with no
  cascade, so a content row for a session that does not exist is refused (`23503`);
- every primary key SHALL lead with `session_id` (`(session_id, id)`; `session_meta`'s
  `(session_id, key)`), `session_transport` SHALL hold at most one row per session, keyed by
  `session_id`, and every index SHALL lead with `session_id`;
- `session_audio_segments` SHALL have an index on `(session_id, r2_key)`;
- `session_events`, `session_transcript_words` and `session_topics` SHALL have a non-null
  `version bigint` column with default 1 (ADR 0021 slice 7c-1); every statement that updates one
  of their rows SHALL set its version to the stored version plus one in that same statement.

The session's revision SHALL be the non-null `revision bigint` column of its `catalog.sessions`
row, default 0 (api-contract-freeze "The session revision advances once per session write"). The
`session_meta` keys `events_stream_revision` (ADR 0021 slice 7c-1), `lease_holder` and
`lease_seen_ms` (slice 8a) are retired: the server SHALL NOT read or write them. Existing rows with
those keys are left in place for a later cleanup migration. The recording lease is stored in
`catalog.session_leases` ("Session leases are stored in the catalog").

The server SHALL store session content only in these tables. It SHALL NOT create, open or write a
per-session SQLite file, and it SHALL leave existing `DATA_DIR/sessions/*.db` files untouched
(slice 11 imports them).

**Start empty (ADR 0021 slice 7b-1).** The migration that creates these tables SHALL import no
content, and SHALL reset the live projection columns of every existing `catalog.sessions` row to
the values of an empty session: `event_count` 0, `max_timecode_total_frames` null, `is_rolling`
0, `current_take` 0, `transport_elapsed_frames` 0 and `roll_started_at_utc` null.

**Carry the revision over (ADR 0021 slice 7c-1).** The migration that adds the revision column
SHALL set each session's `revision` to its `events_stream_revision` meta value (0 when it has
none or the value is not a non-negative integer), SHALL leave those meta rows unchanged, and SHALL
give every existing row of the three versioned tables version 1.

#### Scenario: A content row needs its session
- **WHEN** `catalog_system` inserts an event row whose `session_id` names no session
- **THEN** the insert fails with `23503` and no row is stored

#### Scenario: Existing sessions start empty
- **WHEN** the migration is applied to a database whose sessions have non-zero live projections
- **THEN** every session's projection columns read as an empty session's, and every session's
  events, transcript, topics, audio list and dashboards read as empty

#### Scenario: No session file is written
- **WHEN** the server creates a session, logs an event in it, and is restarted
- **THEN** the event is read back after the restart, and no file exists under
  `DATA_DIR/sessions/` that did not exist before

#### Scenario: The revision moves into the sessions row
- **WHEN** the 7c-1 migration is applied to a database where session A's `events_stream_revision`
  meta value is `17`, session B has none, and A has events, words and topics
- **THEN** A's `revision` is 17, B's is 0, A's `events_stream_revision` meta row still reads
  `17`, and every existing event, word and topic has version 1

#### Scenario: The server no longer touches the retired key
- **WHEN** a session is opened, an event is logged and the status is read
- **THEN** the session's `events_stream_revision` meta row, if any, is unchanged and no new one is
  written

#### Scenario: An update advances the stored version
- **WHEN** `catalog_system` runs any of the server's update statements on an event, a word or a
  topic
- **THEN** the row's version is one more than before, in the same statement

#### Scenario: The server no longer touches the lease keys
- **WHEN** a session has `lease_holder` and `lease_seen_ms` meta rows, and a client claims,
  heartbeats and releases the recording lease
- **THEN** both meta rows are unchanged, and no new lease meta row is written

### Requirement: The session live projection commits with the session write
The catalog's copy of a session's live projection SHALL be written inside the session write that
changes it, in the same transaction. A write that changes the session's events or transport
SHALL set the six columns to the session's state as of its own commit:
- event count;
- latest timecode;
- rolling;
- current take;
- elapsed frames;
- roll start.

The session's `revision` column SHALL be advanced the same way: inside the write transaction that
changes the session's content, once per transaction, so it commits or fails with the write.

If the projection or the revision cannot be written, the whole write SHALL fail: none of its
changes persist and none of its broadcasts are sent. A request that reads the session list after a
write's response arrives SHALL see that write's projection. Because writes to one session are
serialized, the projection of the last committed write is the one that remains.

#### Scenario: The list is current after the response
- **WHEN** a client logs an event and, as soon as the response arrives, lists the sessions
- **THEN** the session's `event_count` includes the new event

#### Scenario: Concurrent writes leave the last state
- **WHEN** two writes to one session from two server connections commit in order A then B
- **THEN** the catalog holds the projection of B's state, and B's revision is one more than A's

#### Scenario: A failed projection fails the write
- **WHEN** a session write's projection update fails
- **THEN** the write rejects, the session's events and transport are unchanged, and no
  `*.changed` broadcast is sent

#### Scenario: A rolled-back write leaves the revision
- **WHEN** a session write advances the revision and then fails
- **THEN** the session's `revision` is unchanged

### Requirement: Session overwrites are recorded in the catalog
Schema `catalog` SHALL hold `session_overwrites`, one row per audited overwrite
(api-contract-freeze "Overwrites are audited"), with: an id; `session_id`, non-null and referencing
`catalog.sessions (id)` with no cascade; the table name, one of `session_events`,
`session_transcript_words` and `session_topics`; the row id; the user id, non-null; the time as
ISO-8601 text; the replaced version; the row before as JSON text; and the row after as JSON text,
null for a delete. Its primary key and every index SHALL lead with `session_id`.

It SHALL have row-level security enabled, with an allow-all `catalog_system` policy, and one
`catalog_user` policy for insert only, whose check admits a row only when its user id is the
binding's user (`app.user_id`) and its session belongs to one of that user's accessible shows (the
session content rule). `catalog_user` SHALL hold only the insert privilege on it: a user binding
SHALL NOT read, update or delete overwrite rows. `catalog_system` keeps the catalog's default
privileges.

#### Scenario: A user records their own overwrite
- **WHEN** `autologger_app`, switched to `catalog_user` with the id of a user with access to session
  S, inserts an overwrite row for S naming that user
- **THEN** the row is stored

#### Scenario: A user cannot record for someone else or another show
- **WHEN** the same binding inserts a row naming another user, or a row for a session it cannot
  access
- **THEN** each insert fails with `42501` and stores nothing

#### Scenario: A user cannot read or change overwrite rows
- **WHEN** a user binding selects, updates or deletes `session_overwrites` rows, including its own
- **THEN** each statement is refused with `42501`

### Requirement: Session leases are stored in the catalog
Session leases SHALL be stored in `catalog.session_leases` (ADR 0021 slices 8a and 8b), with these
columns:
- `session_id`, non-null, referencing `catalog.sessions (id)` with no cascade;
- `kind`, non-null, checked by the named constraint `session_leases_kind_check` to one of
  `'recording'`, `'ai-turn'`, `'transcript-generation'` and `'youtube-import'` (slice 8b);
- `holder_client_id`, non-null, non-empty, at most 256 characters;
- `holder_user_id`, null only when a reviewed system task holds the lease;
- `heartbeat_at_ms` and `expires_at_ms`, non-null `bigint` epoch milliseconds read from the Clock
  port;
- `started_at_ms`, a nullable `bigint` epoch milliseconds read from the Clock port, with no
  default: a run-lease claim sets it when it inserts the row or takes over another holder's row,
  and keeps it when the same holder renews; recording leases leave it null (run-status-and-sweeper
  D4).

The primary key SHALL be `(session_id, kind)`, so a session has at most one lease of each kind.

Row-level security SHALL be enabled with these policies:
- `catalog_system` SHALL be allowed every command.
- `catalog_user` SHALL be allowed to select, insert, update and delete only rows of sessions in
  shows it can access.
- An inserted or updated row SHALL carry the user's own id as `holder_user_id`.
- `catalog_user` SHALL delete only rows it holds.
- The update policy's row filter SHALL be the access rule alone, without the holder. A refused or
  takeover claim written as `INSERT … ON CONFLICT DO UPDATE … WHERE` therefore skips or replaces
  the row instead of failing with `42501`.
- `anon`, `authenticated` and `public` SHALL have no privileges on the table.

Row-level security SHALL NOT be relied on to tie a live lease to its holder: the access rule cannot
judge expiry, so a user with access could rewrite a live lease to itself with a direct `UPDATE`. The
server's lease statements are the only writers, and they enforce the holder.

The migration that widens the kind check (slice 8b) SHALL change no row and no policy.

The migration that adds `started_at_ms` (run-status-and-sweeper) SHALL change no policy and SHALL
backfill nothing: rows that exist before it keep a null `started_at_ms`. Its rollback drops the
column after the code is reverted.

The migration that creates the table SHALL copy no lease. It SHALL leave the `lease_holder` and
`lease_seen_ms` meta rows unchanged.

#### Scenario: A user writes only leases held by itself
- **WHEN** a `catalog_user` binding for user U inserts a lease naming U, then one naming another
  user, then one in a session of a show U cannot access
- **THEN** the first succeeds, and the other two fail with `42501`

#### Scenario: A takeover claim needs no holder-scoped update
- **WHEN** user V runs the claim upsert against a lease held by user U, first while it is live and
  then after it expired
- **THEN** the first changes no row and raises no error, and the second replaces the row with V as
  holder

#### Scenario: A user cannot delete another user's lease
- **WHEN** a `catalog_user` binding for user V deletes a lease held by user U
- **THEN** no row is deleted

#### Scenario: RLS alone does not protect a live lease
- **WHEN** a `catalog_user` binding for user V runs a direct `UPDATE` setting itself as holder of a
  live lease held by user U, in a session V can access
- **THEN** the update succeeds; this is accepted, because only the server's statements write leases

#### Scenario: Only known kinds are stored
- **WHEN** `catalog_system` inserts a lease with kind `x`
- **THEN** the insert fails with `23514`

#### Scenario: The run kinds are stored
- **WHEN** a `catalog_user` binding for user U inserts leases of kinds `ai-turn`,
  `transcript-generation` and `youtube-import` naming U, in a session U can access
- **THEN** all three succeed, and their rows coexist with a `recording` lease of the same session

#### Scenario: The start time is kept on renewal and reset on takeover
- **WHEN** user U claims a `transcript-generation` lease, U renews it as the same holder 10 s
  later, the lease then expires, and user V claims it
- **THEN** the renewal leaves `started_at_ms` at U's claim time, and V's claim sets it to V's claim
  time

#### Scenario: Recording leases carry no start time
- **WHEN** a client claims a session's `recording` lease
- **THEN** the stored row's `started_at_ms` is null

### Requirement: Companion devices and presence are stored in the catalog
The migration `20261015000000_companion_devices.sql` SHALL create two catalog tables (ADR 0021
slice 9d), and the recorded schema expectation of "The catalog schema lives in Postgres schema
`catalog`" SHALL gain both in the same change. Every text column SHALL be `text` with
`COLLATE "C"`.

`catalog.companion_devices` holds each user's Companion devices:
- `id`, the primary key (a UUID string);
- `user_id`, non-null, referencing `catalog.users (id)` `on delete cascade`, with an index on it;
- `name`, non-null, checked to 1 to 80 characters;
- `token_hash`, non-null and unique, the hex SHA-256 of the device's token; the token itself
  SHALL NOT be stored;
- `created_at_utc`, non-null ISO-8601 text, and `last_used_at_utc`, nullable ISO-8601 text.

`catalog.companion_presence` holds one row per browser tab:
- `client_id`, the primary key, checked to 1 to 256 characters;
- `user_id`, non-null, referencing `catalog.users (id)` `on delete cascade`;
- `session_id`, nullable, referencing `catalog.sessions (id)` `on delete set null`;
- `visible` and `is_playing`, non-null booleans;
- `updated_at_ms`, non-null `bigint` epoch milliseconds read from the Clock port;
- an index on `(user_id, updated_at_ms)`.

Row-level security SHALL be enabled on both, and both SHALL be system-only, like `kv`:
- `catalog_system` SHALL have a permissive policy allowing every command on each;
- neither SHALL have a `catalog_user` policy, and `catalog_user`'s privileges on both SHALL be
  revoked. One system store serves both the device-token lookup and the management routes, and
  every one of its statements is scoped by user id in SQL (api-contract-freeze "Companion device
  management routes"); the server writes a cookie caller's presence row after its own checks;
- `anon`, `authenticated` and `public` SHALL have no privileges on either table.

The same migration SHALL delete the former deployment-wide Companion last-command entry
(`catalog.kv` key `companion:last_command`), which has no expiry and is no longer read.

Rollback drops both tables after the code is reverted; device tokens are then lost.

#### Scenario: Devices are invisible to users
- **WHEN** a `catalog_user` binding selects from, inserts into or deletes from `companion_devices`
- **THEN** each is refused with `42501`

#### Scenario: Presence is invisible to users
- **WHEN** a `catalog_user` binding selects from or inserts into `companion_presence`
- **THEN** both are refused with `42501`

#### Scenario: A deleted user takes their devices and presence
- **WHEN** a user with two devices and a presence row is deleted
- **THEN** their device rows and presence row are gone

#### Scenario: A deleted session clears the presence row's session
- **WHEN** a session named by a presence row is deleted
- **THEN** the row remains with a null `session_id`

#### Scenario: A token hash is unique
- **WHEN** `catalog_system` inserts a second device with an existing `token_hash`
- **THEN** the insert fails with a unique violation (`23505`)
