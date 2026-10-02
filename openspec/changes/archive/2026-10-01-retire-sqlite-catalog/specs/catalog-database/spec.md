## MODIFIED Requirements

### Requirement: The catalog schema lives in Postgres schema `catalog`
Migrations in `supabase/migrations/` SHALL create the schema `catalog` with the catalog tables
`users`, `user_studio_memberships`, `user_prefs`, `studio_definitions`, `shows`, `app_settings`,
`sessions`, `kv` and `team_invites`. Their columns, nullability, defaults, primary keys, unique
constraint, foreign keys (every column) and index definitions SHALL equal a recorded schema
expectation that the catalog schema tests hold as literal values, under this type mapping (the
expectation was first captured from the retired SQLite catalog's migrations 0001-0006, ADR 0021
slice 4e):
- every text column SHALL be `text` with `COLLATE "C"`, so comparison and ordering are bytewise;
- every integer column SHALL be `bigint` (8 bytes);
- `sessions.frame_rate` SHALL be `double precision`.

A later migration that changes the catalog schema SHALL update the recorded expectation in the
same change.

Timestamps SHALL stay ISO-8601 text, flags 0/1 integers and JSON text (a faithful port; a typed
schema is a post-migration follow-up). The two seed shows `show-autolog-test` and
`show-the-something-podcast` SHALL exist with the recorded seed values. The catalog SHALL NOT be created in schema `public`.

#### Scenario: The Postgres schema matches the SQLite catalog
- **WHEN** the catalog migrations are applied to a fresh database
- **THEN** every catalog table has exactly the recorded columns, types, collations, nullability,
  defaults, primary keys, unique constraint, foreign keys and indexes, and the two seed shows
  have exactly the recorded values; no SQLite catalog is built to compare against

#### Scenario: Ordering is bytewise
- **WHEN** shows named `a` and `B` exist and are selected ordered by `name`
- **THEN** `B` comes first

#### Scenario: Large and fractional values round-trip
- **WHEN** a `kv` row stores an `expires_at` of the current epoch milliseconds plus one day, and
  a session stores a `start_offset_frames` of `3000000000` and a `frame_rate` of `29.97`
- **THEN** all three read back with the same numeric values
