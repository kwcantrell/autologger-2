## MODIFIED Requirements

### Requirement: One lease and one event pair per recording

Chunk boundaries SHALL be invisible outside the recorder: the client claims the recording
lease once before capture starts, heartbeats it on the existing cadence for the whole
take, and releases it once after the final chunk's capture stops. If a heartbeat is refused
(`{"ok":false}`, the lease lapsed or was lost) while capture is running, the client SHALL re-claim
the lease at once with its own client id. While a re-claim is refused with `409`, the client SHALL
keep capturing (no data is discarded), SHALL show one warning that another window, tab, or user now
holds the recording lease (not one per attempt), and SHALL send a claim instead of a heartbeat on
each later tick, returning to heartbeats once a claim succeeds. At most one claim or heartbeat
SHALL be in flight at a time, and every response SHALL be acted on only for the take that sent it:
the final release SHALL wait for an in-flight claim to settle, and a claim that succeeds after its
take stopped SHALL be released at once; exactly one
`Recording N Started` / `Recording N Stopped` internal event pair is logged per recording
regardless of chunk count. Mid-take chunk uploads SHALL NOT change the recorder's
recording phase, interrupt heartbeats, or alter phase-derived UI (recording indication,
duration counter, save overlay) — the full-screen saving presentation appears only for
the final drain after capture stops. The HTTP/WS surface SHALL be unchanged (existing
endpoints, statuses, shapes only).

#### Scenario: A three-chunk recording logs one Started/Stopped pair
- **WHEN** a recording rolls over twice before stopping
- **THEN** the event feed contains exactly one `Recording N Started` and one
  `Recording N Stopped` for it, and the client sent lease heartbeats continuously from
  claim to the final stop without a mid-take release

#### Scenario: Mid-take uploads do not disturb the recording indication
- **WHEN** a rollover chunk uploads while capture continues
- **THEN** the recording indication and duration counter stay lit, heartbeats continue,
  and no full-screen saving overlay appears

#### Scenario: A refused heartbeat re-claims the lease
- **WHEN** a heartbeat answers `{"ok":false}` during capture and the lease is free
- **THEN** the client claims it again with its own client id, capture continues, and later
  heartbeats succeed

#### Scenario: A re-claim that loses warns and keeps recording
- **WHEN** a heartbeat answers `{"ok":false}` during capture, the re-claim answers `409`, the next
  two ticks' claims answer `409`, and the one after succeeds
- **THEN** exactly one warning is shown, capture continues throughout, the ticks after the loss send
  claims and no heartbeats, and heartbeats resume after the successful claim

#### Scenario: Stopping during a re-claim leaves no lease behind
- **WHEN** the user stops recording while a re-claim is in flight, and the re-claim then succeeds
- **THEN** the client's release is sent after the claim settles, and the lease ends up free
