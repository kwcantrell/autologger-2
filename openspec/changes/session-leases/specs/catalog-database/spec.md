## MODIFIED Requirements

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

## ADDED Requirements

### Requirement: Session leases are stored in the catalog
Session leases SHALL be stored in `catalog.session_leases` (ADR 0021 slice 8a), with these columns:
- `session_id`, non-null, referencing `catalog.sessions (id)` with no cascade;
- `kind`, non-null, checked by the named constraint `session_leases_kind_check` to `'recording'`;
- `holder_client_id`, non-null, non-empty, at most 256 characters;
- `holder_user_id`, null only when a reviewed system task holds the lease;
- `heartbeat_at_ms` and `expires_at_ms`, non-null `bigint` epoch milliseconds read from the Clock
  port.

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
