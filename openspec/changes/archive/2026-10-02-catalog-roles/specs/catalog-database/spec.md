## MODIFIED Requirements

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

## ADDED Requirements

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
