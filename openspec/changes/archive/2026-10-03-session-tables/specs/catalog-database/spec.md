## MODIFIED Requirements

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

### Requirement: Row-level security is enabled on every catalog table
Every table in schema `catalog` SHALL have row-level security enabled. Every catalog table SHALL
have at least one policy for `catalog_system`. Every table except `kv` and the nine session tables
SHALL also have at least one policy for `catalog_user`. The session tables SHALL have no
`catalog_user` policy and `catalog_user` SHALL hold no privilege on them, so every statement a
user binding sends to them is refused (ADR 0021 slice 7b-1; slice 7b-2 adds their user
policies).

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
- **THEN** every table has row-level security enabled and a policy for `catalog_system`, every
  table other than `kv` and the session tables has at least one policy for `catalog_user`, and
  the session tables have none

#### Scenario: No user policy allows everything
- **WHEN** the `catalog_user` policies of schema `catalog` are listed with their `USING` and
  `WITH CHECK` expressions
- **THEN** none of them is the constant `true`

#### Scenario: Allow-all policies change nothing
- **WHEN** `catalog_system` inserts, selects, updates and deletes rows of every catalog table,
  including rows that name another user and rows of teams no user is a member of
- **THEN** every statement affects the same rows it would without row-level security

#### Scenario: A user binding is refused on the session tables
- **WHEN** `autologger_app`, switched to `catalog_user` with a user id, selects from, inserts
  into, updates or deletes from any session table
- **THEN** each statement is refused with `42501`

## ADDED Requirements

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
- `session_audio_segments` SHALL have an index on `(session_id, r2_key)`.

The server SHALL store session content only in these tables. It SHALL NOT create, open or write a
per-session SQLite file, and it SHALL leave existing `DATA_DIR/sessions/*.db` files untouched
(slice 11 imports them).

**Start empty (ADR 0021 slice 7b-1).** The migration that creates these tables SHALL import no
content, and SHALL reset the live projection columns of every existing `catalog.sessions` row to
the values of an empty session: `event_count` 0, `max_timecode_total_frames` null, `is_rolling`
0, `current_take` 0, `transport_elapsed_frames` 0 and `roll_started_at_utc` null.

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

If the projection cannot be written, the whole write SHALL fail: none of its changes persist and
none of its broadcasts are sent. A request that reads the session list after a write's response
arrives SHALL see that write's projection. Because writes to one session are serialized, the
projection of the last committed write is the one that remains.

#### Scenario: The list is current after the response
- **WHEN** a client logs an event and, as soon as the response arrives, lists the sessions
- **THEN** the session's `event_count` includes the new event

#### Scenario: Concurrent writes leave the last state
- **WHEN** two writes to one session from two server connections commit in order A then B
- **THEN** the catalog holds the projection of B's state

#### Scenario: A failed projection fails the write
- **WHEN** a session write's projection update fails
- **THEN** the write rejects, the session's events and transport are unchanged, and no
  `*.changed` broadcast is sent

## REMOVED Requirements

### Requirement: Session live projection is mirrored in order
**Reason**: The projection is written inside the session write's own transaction ("The session
live projection commits with the session write"), so there is no separate writer to order, no
failed write to log, and no stale projection for a later change to heal.
**Migration**: The in-process mirror, its call sites and its system binding are removed in the
same change; nothing outside the server calls them.
