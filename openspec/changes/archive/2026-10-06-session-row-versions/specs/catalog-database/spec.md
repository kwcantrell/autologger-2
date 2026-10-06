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
`session_meta` key `events_stream_revision` is retired: the server SHALL NOT read or write it.
Existing rows with that key are left in place for a later cleanup migration.

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

## ADDED Requirements

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
