## MODIFIED Requirements

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
