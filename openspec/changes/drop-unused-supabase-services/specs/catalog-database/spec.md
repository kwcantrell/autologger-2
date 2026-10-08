## MODIFIED Requirements

### Requirement: The catalog is not exposed through the Supabase API roles
The roles `anon`, `authenticated` and `service_role`, and the `public` pseudo-role, SHALL have
no privilege on schema `catalog` or on any table in it. The Postgres image still creates these
roles, although no stack runs PostgREST any more, so neither PostgREST, if it is added back, nor
pg_graphql can serve catalog rows. No role other than `autologger_app` and `postgres` (which created them)
SHALL be a member of `catalog_user` or `catalog_system`, so `authenticator` and the API roles
cannot switch to them. `public` SHALL NOT be able to execute any function in schema `catalog`.
(The `postgres` role reads every table through its `pg_read_all_data` membership and owns the
tables with `BYPASSRLS`; that reach, held by `db` and `migrate`, is out of slice 6's scope.)

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
