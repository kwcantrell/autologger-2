# Spec Delta

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
  `session_id`, and every index SHALL lead with `session_id`, except the four search indexes below;
- `session_audio_segments` SHALL have an index on `(session_id, r2_key)`;
- `session_topics` and `session_events` SHALL have a stored generated `search_tsv` column (catalog-search), each with a GIN index on that column alone, and a trigram GIN index on the phrase-normalised `summary` and `message` respectively. These four indexes are the only content-table indexes that don't lead with `session_id`;
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

#### Scenario: Search columns are the only additions
- **WHEN** the columns and indexes of `session_topics` and `session_events` are listed after the catalog-search migration
- **THEN** each table has exactly one column more than before, `search_tsv`, and exactly two indexes more: a GIN index on `search_tsv` and a trigram GIN index on the phrase-normalised text

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

### Requirement: Search extensions, normaliser and indexes
- **Extensions:** the catalog SHALL use the `pg_trgm` and `unaccent` extensions, installed in schema `extensions` and referenced schema-qualified.
- **Schema access:** `catalog_user` and `catalog_system` SHALL have `USAGE` on schema `extensions`, so writes whose index expressions call extension functions succeed.
- **Text-search configuration:** `catalog.search_english` SHALL be English stemming with accent folding. Every search vector and query SHALL use it.
- **Normaliser:** `catalog.search_norm(text)` SHALL return its input with accents removed and lowercased (non-ASCII letters included), and SHALL be immutable.
- **Function privileges:** every function this change adds SHALL be not executable by `public`, as "Catalog functions are not executable by public" requires.
  - `search_norm` SHALL be executable by `catalog_user` and `catalog_system`.
  - The search function SHALL be executable by `catalog_user` only.
  - The chunk refresh and trigger functions SHALL be executable by no application role.
- **Generated search columns:** the following columns SHALL exist, each with a GIN index, and their values SHALL always reflect the current row:
  - `sessions.search_meta` (title and episode);
  - `sessions.search_notes` (notes);
  - `session_topics.search_tsv` (summary);
  - `session_events.search_tsv` (message);
  - `session_transcript_chunks.search_tsv` (text).
- **Trigram indexes:** the normalised session title, show name and studio display name SHALL each have a trigram GIN index.
- **Phrase normaliser:** `catalog.search_phrase_norm(text)` SHALL return `search_norm` of its input with every whitespace run (tabs and newlines included) turned into one space, then characters other than letters, digits and spaces removed, then spaces collapsed and trimmed. It SHALL be immutable, and executable by `catalog_user` and `catalog_system` only.
- **Phrase indexes:** the phrase-normalised text of transcript chunks, topic summaries and event messages SHALL each have a trigram GIN index.

#### Scenario: The normaliser folds accents and case
- **WHEN** `catalog.search_norm('Ångström CAFÉ Straße')` is evaluated
- **THEN** it returns `angstrom cafe strasse`

#### Scenario: The phrase normaliser drops punctuation
- **WHEN** `catalog.search_phrase_norm('I''m like, Why did he   DO that?')` is evaluated
- **THEN** it returns `im like why did he do that`

#### Scenario: Whitespace separates words before punctuation is removed
- **WHEN** `catalog.search_phrase_norm(E'tab\there — now')` is evaluated
- **THEN** it returns `tab here now`

#### Scenario: Ordinary writes still succeed
- **WHEN** an owner, as `catalog_user`, updates a session's title and notes, a topic's summary, an event's message, a show's name and a studio's name
- **THEN** every statement succeeds

#### Scenario: New functions are not public
- **WHEN** `has_function_privilege` is checked for `public`, `catalog_user` and `catalog_system` on each function this change adds
- **THEN** `public` has none, and the other roles have exactly the grants listed above

#### Scenario: Search columns follow edits
- **WHEN** a topic's summary is updated from "budget talk" to "wedding plans"
- **THEN** a full-text match for `wedding` finds the topic and a match for `budget` no longer does

### Requirement: Transcript chunks
`catalog.session_transcript_chunks` SHALL hold each session's transcript in blocks of 40 words.

- **Membership:** a block `b` holds the non-empty words whose `ordinal` is in `[40b, 40b+40)`, joined by single spaces in ordinal order.
- **Per-block values:**
  - `start_sec` is the smallest positive word `start_sec` in the block, or null if none is positive;
  - `end_sec` is the largest word `end_sec`;
  - `speaker` is the speaker of the block's first word.
- **Empty blocks:** a block with no non-empty words SHALL have no row.
- **References:** the table SHALL reference `catalog.sessions (id)` with no cascade, and its primary key SHALL be `(session_id, bucket)`.

The database SHALL keep the chunks equal to that rule after every committed statement that inserts, updates or deletes `session_transcript_words`. Only the affected blocks SHALL be rebuilt, and rebuilds of one session's chunks SHALL be serialised, so concurrent word writes in the same block can't fail or leave a stale chunk. The migration SHALL backfill every existing session's chunks.

Row-level security:
- **Read:** `catalog_user` SHALL be able to read a chunk only when the session's show is in `accessible_shows(app_user_id())`, as for the other session content tables.
- **Write:** `catalog_user` SHALL have no insert, update or delete privilege on chunks, so a direct write fails with `42501`.
- **System role:** `catalog_system` SHALL have the usual allow-all policy.

#### Scenario: Bulk replace rebuilds chunks
- **WHEN** a session's 90 words are replaced through the bulk transcript write
- **THEN** the session has exactly 3 chunks, holding words 0–39, 40–79 and 80–89 in order

#### Scenario: A single-word edit rebuilds one chunk
- **WHEN** word 45 of that session is changed from "cat" to "dog"
- **THEN** chunk 1's text has "dog" in place of "cat", and the rows for chunks 0 and 2 are unchanged

#### Scenario: Chunks follow the content policy
- **WHEN** an owner, a granted member and an ungranted member of the session's team each select from `session_transcript_chunks` as `catalog_user`
- **THEN** the owner and granted member see the session's chunks, and the ungranted member sees none

#### Scenario: Users can't write chunks directly
- **WHEN** an owner, as `catalog_user`, inserts or updates a row in `session_transcript_chunks`
- **THEN** each statement fails with `42501`, and the chunks are unchanged

#### Scenario: Concurrent edits in one block
- **WHEN** two transactions each update a different word of the same 40-word block of a session and both commit
- **THEN** neither fails, and the chunk's text holds both new words

#### Scenario: The backfill matches the rule
- **WHEN** the migration is applied to a database with existing transcript words
- **THEN** each session's chunks equal the chunks the rule produces from its words
