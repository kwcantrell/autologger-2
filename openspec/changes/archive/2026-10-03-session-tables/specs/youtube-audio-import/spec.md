## MODIFIED Requirements

### Requirement: Import is refused while a recording is live

If the session's transport is actively rolling (a live recording in progress) when a
`youtube-import` request would proceed, the server SHALL refuse it with `409 {detail}` and
SHALL NOT synthesize a take or advance/clobber the live roll. This protects the in-flight
recording, which the import's transport advance would otherwise silently end and corrupt. The
check SHALL also hold for a take that starts while the import is in flight: the transaction that
anchors the imported take SHALL re-check the transport and, if it is rolling, write nothing, and
the request SHALL be refused with the same `409 {detail}`, with the attached segment rolled back
as the earlier rolling refusal rolls it back (ADR 0021 slice 7b-1).

#### Scenario: Import during a live recording is refused

- **WHEN** a `youtube-import` request is made for a session whose transport `is_rolling` is
  true
- **THEN** the response is `409 {detail}`, no subprocess/synthesis clobbers the live roll,
  and the recording continues unaffected

#### Scenario: A take started during the import is not clobbered

- **WHEN** a `youtube-import` passes its rolling checks, and a take starts before the imported
  take is anchored
- **THEN** the response is the same `409 {detail}`, the session gains no audio segment and no
  `Recording N` events, and the transport is still rolling with its take unchanged
