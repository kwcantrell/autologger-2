## MODIFIED Requirements

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
