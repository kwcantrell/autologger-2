## MODIFIED Requirements

### Requirement: Server code never drops or misuses a promise

Production code under `server/src` SHALL NOT leave a promise unconsumed. Every promise-returning
call SHALL be awaited, returned, or explicitly discarded with `void`.

No code SHALL:
- use a promise as a condition, negate it, or compare it with `===`, `!==`, `==` or `!=`;
- serialise it into a response, whether as the body itself or as a field, shorthand field
  included;
- pass a promise-returning function where the parameter expects a function that returns no
  value. Such a callback's work would silently escape the caller's control, for example a write
  running after the transaction it was meant to be inside.

A documented await-free window (a section of a request handler that relies on no other request
interleaving) SHALL contain no storage call. Data the window needs from storage SHALL be read
before it opens.

#### Scenario: A dropped or misused promise fails the build
- **WHEN** server production code drops a promise-returning call, including one made through a port interface or a local alias, or uses a promise as a condition, a comparison operand or a response value
- **THEN** a repository test fails and names the file and line

#### Scenario: An async callback where no value is expected fails the build
- **WHEN** server production code passes an async function to a parameter typed as a function returning no value, such as a mutation run inside a catalog transaction
- **THEN** a repository test fails and names the file and line

#### Scenario: Event-generation word snapshot stays await-free
- **WHEN** `POST /api/sessions/{id}/events/generate` takes its transcript word snapshot
- **THEN** no storage call or other `await` occurs between the snapshot and the AI turn registration, and the show's categories were read before the snapshot

#### Scenario: Companion command is stored before it is broadcast
- **WHEN** `POST /api/companion/command` is accepted
- **THEN** the command is recorded as the last command before it is broadcast to the session's sockets, so an acknowledgement can always find it

#### Scenario: In-flight transcript redaction checks the named holder
- **WHEN** transcript generation is refused with `409` because another session holds the generation lock
- **THEN** the requester sees the holder's identifiers only if they may view the session those identifiers name, even if the lock changed hands while the refusal was built

#### Scenario: Responses are unchanged
- **WHEN** the existing route and WebSocket test suites run after this change
- **THEN** they pass with no change to expected status codes, bodies, headers or frames
