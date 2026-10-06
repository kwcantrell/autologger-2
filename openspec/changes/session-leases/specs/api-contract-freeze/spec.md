## MODIFIED Requirements

### Requirement: The session revision advances once per session write
A session's revision SHALL advance by exactly one for each committed session write transaction
that changed at least one of the session's content rows, of any kind: events, transport, audio
segments, transcript words and enrichment, topics, dashboards, session metadata, and the recording
lease's state. For the recording lease, a claim that takes or refreshes the lease, a release, and an
expiry that frees it SHALL each count as a change; a heartbeat SHALL NOT, even though it extends the
lease. A transaction that changes no row, and every read, SHALL leave it unchanged. Two internal writes SHALL NOT count as changes: the seed a session's runtime writes
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

#### Scenario: A heartbeat leaves the revision unchanged
- **WHEN** a client claims the recording lease, reads the status, heartbeats three times, and reads
  the status again
- **THEN** `events_stream_revision` is the same in both reads

#### Scenario: Lease claims, releases and expiries each advance it once
- **WHEN** a client claims the lease, another client's claim is refused, the holder releases it, a
  client claims it again, and the lease then expires and is freed
- **THEN** the revision advanced by exactly one for the first claim, the release, the second claim
  and the expiry each, and not at all for the refused claim

## ADDED Requirements

### Requirement: The recording lease is held by one user and client
A session's recording lease (`POST /api/sessions/:id/audio-recording-lease`, `/heartbeat`,
`/release`, body `{"client_id": …}`) SHALL be held by one signed-in user together with one client
id. The request and response shapes are unchanged.

- **Client id.** The route trims `client_id`. An id that is empty after trimming, or that contains
  NUL, SHALL be treated as never matching: a claim answers the existing `409`, a heartbeat
  `{"ok":false}`, and a release `{"ok":true}` with no change. It SHALL never answer `500`.
- **Claim.** A claim SHALL succeed (`200 {"ok":true}`) when there is no lease, when the lease has
  expired, or when the same user and client already hold it. Otherwise it SHALL answer the existing
  `409 {"detail":"Another window, tab, or user is already recording audio for this session."}` and
  change nothing. This applies when another user holds the lease, and when the same user holds it
  with another client.
- **Heartbeat.** A heartbeat SHALL extend the lease (`200 {"ok":true}`) only for the same user and
  client, and only while the lease has not expired. Any other heartbeat SHALL answer
  `200 {"ok":false}` and change nothing. This includes a heartbeat after expiry, even when no
  process has freed the lease yet.
- **Release.** A release SHALL free the lease only for the same user and client. Every release SHALL
  answer `200 {"ok":true}`.
- **Expiry.** A lease SHALL expire 40 s after its last claim or heartbeat. After that any user with
  access to the session may claim it.
- **Status.** `audio_recording_lease_holder_id`, `audio_recording_lease_alive` and
  `audio_recording_lease_age_sec` in `GET /api/sessions/:id/status` keep their names and types.
  `audio_recording_lease_holder_id` SHALL be the holder's client id only for the holding user (or a
  system caller reading a system-held lease); every other caller SHALL get the fixed value
  `"another-client"`, which never equals a client id the web issues. It is unchanged when there is
  no lease. The lease is alive exactly when it has not expired, and the age is the time since the
  last claim or heartbeat. `GET /api/companion/state`'s `is_recording` still equals the lease being
  alive.

#### Scenario: Another user cannot take a live lease
- **WHEN** user A claims the lease with client `tab-a`, and user B, who has access to the session,
  claims it with client `tab-b`, and then with client `tab-a`
- **THEN** both of B's claims answer `409`, and the status still shows `tab-a` alive

#### Scenario: Another user cannot extend or release the lease
- **WHEN** user A holds the lease with client `tab-a`, and user B heartbeats and then releases with
  client `tab-a`
- **THEN** B's heartbeat answers `{"ok":false}`, B's release answers `{"ok":true}`, and the lease is
  still held by A with an unchanged expiry

#### Scenario: A heartbeat cannot revive an expired lease
- **WHEN** the holder's last heartbeat was more than 40 s ago and no process has freed the lease,
  and the holder heartbeats
- **THEN** the heartbeat answers `{"ok":false}`, the status reports the lease not alive, and another
  user's claim succeeds

#### Scenario: Other viewers do not learn the holder's client id
- **WHEN** user A holds the lease with client `tab-a`, A and user B read the session status, and
  the Companion reads `GET /api/companion/state`
- **THEN** A's status shows `tab-a` and B's shows `another-client`, both with
  `audio_recording_lease_alive` true, and the Companion's `is_recording` is true

#### Scenario: A blank or NUL client id is refused, never a server error
- **WHEN** a client claims, heartbeats and releases with a whitespace-only client id, and then with
  one containing NUL
- **THEN** each claim answers `409`, each heartbeat `{"ok":false}`, each release `{"ok":true}`, and
  nothing is stored

#### Scenario: Releasing lets another user claim
- **WHEN** user A releases the lease, and user B claims it
- **THEN** B's claim answers `200 {"ok":true}`, and the status shows B's client id alive
