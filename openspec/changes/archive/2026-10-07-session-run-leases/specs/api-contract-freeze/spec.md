## MODIFIED Requirements

### Requirement: The session revision advances once per session write
A session's revision SHALL advance by exactly one for each committed session write transaction
that changed at least one of the session's content rows, of any kind: events, transport, audio
segments, transcript words and enrichment, topics, dashboards, session metadata, and the recording
lease's state. For the recording lease, a claim that takes or refreshes the lease, a release, and an
expiry that frees it SHALL each count as a change; a heartbeat SHALL NOT, even though it extends the
lease. A transaction that changes no row, and every read, SHALL leave it unchanged. Two internal writes SHALL NOT count as changes: the seed a session's runtime writes
when it first opens the session, and the bookkeeping the event list's orphan relink check writes;
so listing events SHALL leave it unchanged unless the relink changes an event. A run lease
(kinds `ai-turn`, `transcript-generation` and `youtube-import`, ADR 0021 slice 8b) is not content:
claiming, renewing, releasing or overwriting one SHALL leave the revision unchanged. It SHALL never decrease, and two committed writes of one session SHALL never carry the
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

#### Scenario: A heartbeat leaves the revision unchanged
- **WHEN** a client claims the recording lease, reads the status, heartbeats three times, and reads
  the status again
- **THEN** `events_stream_revision` is the same in both reads

#### Scenario: Lease claims, releases and expiries each advance it once
- **WHEN** a client claims the lease, another client's claim is refused, the holder releases it, a
  client claims it again, and the lease then expires and is freed
- **THEN** the revision advanced by exactly one for the first claim, the release, the second claim
  and the expiry each, and not at all for the refused claim

#### Scenario: Run leases leave the revision unchanged
- **WHEN** a client reads the session status, runs an AI chat turn on the session that calls no
  write tool (the `ai-turn` lease is claimed, renewed and released around it), and reads the status
  again
- **THEN** `events_stream_revision` is the same in both reads
