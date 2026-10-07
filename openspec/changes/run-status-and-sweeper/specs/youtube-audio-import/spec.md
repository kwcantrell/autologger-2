## REMOVED Requirements

### Requirement: Global concurrency ceiling

**Reason**: The process-wide ceiling it required is removed on `AI_PROVIDER=claude_cli` (run-status-and-sweeper D2), so its title and ceiling scenarios no longer describe the behaviour. Restated under "No global import ceiling on claude_cli".

### Requirement: Per-session single-flight

**Reason**: The process-wide ceiling it required is removed on `AI_PROVIDER=claude_cli` (run-status-and-sweeper D2), so its title and ceiling scenarios no longer describe the behaviour. Restated under "Per-session single-flight across processes".

## ADDED Requirements

### Requirement: No global import ceiling on claude_cli

On `AI_PROVIDER=claude_cli`, the default and only accepted value, import runs SHALL have no
global concurrency ceiling, in process or deployment-wide: an import request for a session SHALL
NOT be refused on account of imports running for other sessions, in this or any other process
(run-status-and-sweeper D1, D2). Aggregate resource use is then bounded only by the per-session
single-flight and each run's timeout, duration and byte-size bounds, which the owner accepts for
development. A deployment-wide ceiling, a count of live `youtube-import` run leases, is deferred to
the change that adds other providers.

#### Scenario: Imports on other sessions do not refuse an import

- **WHEN** `AI_PROVIDER` is `claude_cli`, imports are running for two sessions, and a
  `youtube-import` request arrives for a third session
- **THEN** it is admitted and its subprocess is spawned; no `409` is returned on account of the
  other imports

#### Scenario: A finished run releases only its session slot

- **WHEN** an in-flight import run completes (success or failure)
- **THEN** only its session's single-flight slot is released; no global count exists to release

### Requirement: Per-session single-flight across processes

At most one import run per session SHALL be in flight at a time, across every server process
sharing the database (its `youtube-import` run lease). When an import request arrives for a
session that already has a run in progress, in this or another process, the server SHALL respond
`409 {detail}` and SHALL NOT spawn a second subprocess or make a second outbound request.
The guard SHALL be released when the run finishes (success or failure), so a later import
for the same session is permitted.

#### Scenario: Concurrent import for the same session is rejected

- **WHEN** a `youtube-import` request arrives for a session whose previous import is still
  running
- **THEN** the response is `409 {detail}`, and no additional subprocess is spawned and no
  additional outbound request is made

#### Scenario: Guard is released after a run finishes

- **WHEN** an import run for a session completes (whether it succeeded or failed)
- **THEN** a subsequent import request for that session is no longer rejected as concurrent

#### Scenario: Different sessions import concurrently

- **WHEN** imports are requested for three different sessions at the same time on
  `AI_PROVIDER=claude_cli`
- **THEN** none is rejected as concurrent on account of the others, since no ceiling applies
