## MODIFIED Requirements

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

## ADDED Requirements

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
