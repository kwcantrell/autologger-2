## ADDED Requirements

### Requirement: Session content rows carry their version
Every event, transcript word and topic in a JSON response SHALL carry `version`, a positive
integer: the row's current version as of the response (ADR 0021 slice 7c-1). The field SHALL be
added to the existing row shapes without removing or renaming any field. Its responses are:
- events: the event list (`GET /api/sessions/:id/events`), create (`POST …/events`), update
  (`PUT …/events/:eventId`) and Companion `POST /api/companion/log`;
- transcript words: the list, create, update (`PATCH`) and generate responses;
- topics: the list, create, update (`PATCH`) and generate responses.

A row's version SHALL be 1 when it is created and SHALL grow by exactly one with each committed
change to the row, whoever makes it (a user edit, generation, the transcript replace, an import,
the log import or Companion). The CSV and JSONL exports SHALL NOT change: they carry no version.

#### Scenario: A created row starts at version 1
- **WHEN** a client creates an event, a transcript word and a topic
- **THEN** each response carries `version: 1`, and the lists return the same rows with `version: 1`

#### Scenario: Every change advances the version
- **WHEN** a transcript word is patched twice without a version, and the transcript is then
  regenerated
- **THEN** the two `PATCH` responses show versions 2 and 3, and the regenerated words start at
  version 1 (the replace creates new rows)

#### Scenario: Exports are unchanged
- **WHEN** a session with events is exported as CSV and as JSONL
- **THEN** both bodies are byte-identical to the bodies before this change, with no version column
  or key

### Requirement: Opt-in version checks on session content edits
The edit routes for events (`PUT` and `DELETE /api/sessions/:id/events/:eventId`), transcript
words (`PATCH` and `DELETE …/transcript-words/:wordId`) and topics (`PATCH` and `DELETE
…/topics/:topicId`) SHALL accept an optional expected version:
- `PUT` and `PATCH` take `version` (an integer from 1 to 9007199254740991) and `overwrite` (a
  boolean) in the JSON body;
- `DELETE` takes `?version=<n>` (decimal digits, same range) and `&overwrite=1`.

`overwrite` without `version`, a `version` outside the range, and a non-numeric `version` query
SHALL be refused with the existing validation answer, `422 {"detail": [...]}`.

A request without `version` SHALL behave exactly as before this change (last writer wins), apart
from the `version` field in its response.

A request with `version` SHALL be answered in this order:
1. the existing `404 {"detail":"Session not found"}` for a session the caller cannot reach;
2. `422` for an invalid body or query;
3. the event update's existing `400`s;
4. the route's existing `404` when the row does not exist (`Event not found.`, `Transcript word
   not found.`, `Topic not found.`);
5. `409 {"detail":"Version conflict.","current":<row>}` when the row's current version differs
   from `version`, where `<row>` is the row as that route's success response would return it,
   with its current `version`; nothing is written;
6. otherwise the existing success answer, with the new version (a delete answers as today).

The check and the write SHALL be atomic: of several requests that carry the same current version
for one row, at most one SHALL succeed and the others SHALL be answered `409`.

The Companion routes, the generate routes and every other writer SHALL accept no version and SHALL
never answer this `409`.

#### Scenario: A request without a version is unchanged
- **WHEN** a client updates an event whose version is 4 without sending a version
- **THEN** the update succeeds with the existing status and body plus `version: 5`

#### Scenario: A current version succeeds
- **WHEN** a client patches a topic whose version is 2 with `version: 2`
- **THEN** the response is `200` with the topic at `version: 3`

#### Scenario: A stale version is refused with the current row
- **WHEN** two clients read a transcript word at version 1, the first patches it with `version: 1`,
  and the second then patches it with `version: 1`
- **THEN** the second gets `409` with `detail` `Version conflict.` and `current` equal to the
  word's `PATCH` response shape at `version: 2` showing the first client's change, and the word is
  unchanged by the second request

#### Scenario: A stale delete is refused
- **WHEN** a client deletes an event with `?version=1` after another client updated it to version 2
- **THEN** the response is `409` with `current` at `version: 2`, and the event still exists

#### Scenario: A deleted row answers 404, not 409
- **WHEN** a client patches or deletes a topic with a version after another client deleted it
- **THEN** the response is the existing `404 {"detail":"Topic not found."}`

#### Scenario: Two edits with the same version
- **WHEN** two clients send `PUT` for one event with the same current version concurrently
- **THEN** exactly one gets `200` and the other gets `409` whose `current` is the winner's result

#### Scenario: Overwrite needs a version
- **WHEN** a client sends `overwrite: true` without `version`
- **THEN** the response is `422` and nothing is written

#### Scenario: Validation comes before the version check
- **WHEN** a client sends a stale `version` with an event update whose category the session's
  profile does not define
- **THEN** the response is the existing `400 Unknown category for this studio profile.`, not `409`

### Requirement: Overwrites are audited
A versioned edit sent with `overwrite: true` (`overwrite=1` on `DELETE`) that passes the version
check and changes the row SHALL, in the same transaction as the write, record one overwrite: the signed-in user, the
session, the row's table and id, the time, the version it replaced, the row before the write and
the row after it (none for a delete). An overwrite that fails the check SHALL be answered `409` and
record nothing. An overwrite that changes nothing (a `PATCH` with no fields) SHALL record nothing.
An edit without `overwrite` SHALL record nothing. Recording SHALL NOT change the
response: an overwrite answers exactly as the same edit without `overwrite` would.

#### Scenario: An overwrite after a conflict is recorded
- **WHEN** a client gets `409` for an event update and re-sends it with the `current.version` it
  received and `overwrite: true`
- **THEN** the update succeeds, and one overwrite record names the client's user, the event, the
  replaced version, the event as it was before and as it is after

#### Scenario: A stale overwrite is refused and not recorded
- **WHEN** a third client changes the event between the `409` and the overwrite
- **THEN** the overwrite gets `409` with the third client's row, and no overwrite is recorded

#### Scenario: A failed write records nothing
- **WHEN** an overwrite's transaction rolls back after the record was written
- **THEN** neither the write nor the record persists

### Requirement: The session revision advances once per session write
A session's revision SHALL advance by exactly one for each committed session write transaction
that changed at least one of the session's content rows, of any kind: events, transport, audio
segments, transcript words and enrichment, topics, dashboards and session metadata (including the
recording lease's state). A transaction that changes no row, and every read, SHALL leave it
unchanged. Two internal writes SHALL NOT count as changes: the seed a session's runtime writes
when it first opens the session, and the bookkeeping the event list's orphan relink check writes;
so listing events SHALL leave it unchanged unless the relink changes an event. It SHALL never decrease, and two committed writes of one session SHALL never carry the
same value.

The existing fields carry this revision, with their names and shapes unchanged:
- `revision` in the `event.changed` WebSocket frame, which is the revision of the transaction that
  emitted the frame;
- `events_stream_revision` in `GET /api/sessions/:id/status` and `GET /api/companion/state`.

`event.changed` SHALL still be emitted only where it was emitted before; a write that changes no
event SHALL still emit none. A transaction that changes several events (an imported take's
`Recording N` events) SHALL advance the revision by one, not by one per event.

#### Scenario: A transcript edit advances the revision
- **WHEN** a client reads the session status, patches a transcript word, and reads the status again
- **THEN** `events_stream_revision` grew by exactly one, and no `event.changed` frame was sent

#### Scenario: A read leaves the revision unchanged
- **WHEN** a client lists the events (first page, so the orphan relink check runs), the words and
  the topics of a session twice
- **THEN** `events_stream_revision` is the same before and after

#### Scenario: Frames carry their transaction's revision
- **WHEN** a client logs two events one after the other while a socket is attached
- **THEN** the two `event.changed` frames carry consecutive revisions, and the status read after
  the second shows the second frame's revision

#### Scenario: Existing revisions carry over
- **WHEN** the migration is applied to a session whose `events_stream_revision` was 17
- **THEN** its status reports 17, and its next write reports 18
