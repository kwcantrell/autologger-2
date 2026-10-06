## MODIFIED Requirements

### Requirement: Session runtime is an asynchronous, per-session serialized port on Postgres

The session spine SHALL depend on a `SessionRuntime` port exposing the session's id, its storage,
socket fan-out, an alarm/scheduler, and a clock — as an **interface**, so tests can supply a
runtime whose storage is wrapped (one that yields between statements or injects a failure)
without touching `SessionCore`. The port's normative home is `@autologger/session-core`
(alongside `SessionCore`), not `@autologger/ports` — it is the session package's internal
substitution seam, consumed by the package's stores and by test wrappers. Its storage is supplied
by the composition root (the Postgres session adapter, "The Postgres session adapter"); the
session package SHALL NOT open a database itself.

The storage seam SHALL be asynchronous and scoped to one session, and every call SHALL name its
session caller (core-ports-architecture "Every catalog and session call is bound to a caller"),
whose binding its statements run under:
- `tx(caller, fn)` runs a write transaction: the session's catalog row is locked under the
  caller's binding before `fn` runs, so writes to one session are serialized across every
  connection and process; a session with no catalog row SHALL reject with an error naming the
  missing session, and a session the caller has no access to SHALL reject with a distinct error
  naming missing access, both before `fn` runs;
- `snapshot(caller, fn)` runs a read: every statement in `fn` sees one committed state, and a
  write inside it fails; for a user caller without access to the session it SHALL reject with the
  missing-access error before `fn` runs, rather than read the session as empty;
- `fn` receives a handle with promise-returning `all(sql, ...binds)` (rows) and
  `run(sql, ...binds)` (`{ changes }`, the affected-row count), and `tx` on that handle joins the
  enclosing transaction or snapshot.

A transaction SHALL be all-or-nothing: any error inside it — a statement error, a joined body's
error, or the body's own error, even one the body catches — SHALL roll it back and reject with the
first error. A handle used after its transaction ended SHALL reject. A transaction body MAY run
more than once (a deadlock is retried), so it SHALL have only database effects: the broadcasts it
issues and the alarm it sets SHALL take effect once, for the run that committed.

Every statement the session spine sends SHALL be scoped to its session: a statement SHALL NOT
read, change or delete another session's rows.

The hub's storage operations SHALL return promises and SHALL be reached only through a view of
the hub bound to a session caller; views for different callers SHALL share the hub's one
serialization, broadcasts and alarm. Its socket operations (attach, detach, relay a command,
close a user's sockets) SHALL stay synchronous and need no caller. Whatever the mechanism, the session hub
SHALL guarantee these observables:
- **No dirty or lost reads:** no read SHALL observe a write that is not yet committed or that
  later rolls back, and a read that runs several statements SHALL see one committed state.
- **Atomic mutations:** every mutating operation SHALL run in one transaction, and every
  read-then-write sequence whose outcome depends on what it read (an anchored insert, a recording
  ordinal and the segment that uses it, a take toggle, an event update that merges the stored
  metadata, a transcript replace remapped against the session's recording anchors, a
  duplicate-checked imported event, an imported take anchored only while the transport is not
  rolling) SHALL be one hub operation, so concurrent requests produce a
  result some serial order of them would produce — including requests served by different
  server processes.
- **Broadcast order:** a session's `*.changed` broadcasts SHALL be sent only after the
  transaction that issued them commits, in the order the session's transactions committed and,
  within one transaction, in the order issued; a transaction that fails SHALL send none of them.
  A broadcast issued outside the session's transaction (a relayed Companion command) SHALL be sent
  at once and SHALL NOT be held or dropped by a transaction it does not belong to.
- **No self-deadlock:** a storage operation of any session's hub called from inside an open hub
  transaction SHALL reject promptly instead of waiting; a call on the same session's hub SHALL
  leave the open transaction usable, and a call on another session's hub SHALL fail the open
  transaction (production code never nests hub calls).
- **No stuck session:** a transaction that does not finish within its deadline SHALL end with a
  timeout error, and later operations on that session SHALL run.
- **No obscure failure on a closed hub:** an operation on a hub that has been closed SHALL reject
  with an error naming the closed hub, which the routes answer with their existing generic server
  error.

#### Scenario: Storage seam exposes transactions and snapshots, not a cursor API
- **WHEN** the session storage seam is inspected
- **THEN** it exposes promise-returning `tx(caller, fn)` and `snapshot(caller, fn)` whose handles offer `all(sql, ...binds)` returning rows, `run(sql, ...binds)` returning `{ changes }` and a joining `tx`, and it exposes neither a multi-statement DDL path nor the `exec() → { toArray(), rowsWritten }` cursor shape

#### Scenario: Writes from two processes equal a serial order
- **WHEN** two server processes toggle one session's take concurrently, many times
- **THEN** the transport ends as that many serial toggles leave it, with no toggle lost

#### Scenario: A multi-statement read sees one state
- **WHEN** an event list read (page, counts and revision) runs while another connection commits a new event between its statements
- **THEN** the page, the counts and the revision all describe the same committed state

#### Scenario: Sessions are isolated
- **WHEN** every mutating hub operation runs on session A while session B has rows in every session table
- **THEN** session B's rows are unchanged, and no read on session A returns a row of session B

#### Scenario: A write to an unknown session is refused
- **WHEN** a hub is opened, or a write runs, for a session id with no catalog row
- **THEN** it rejects with an error naming the missing session and stores nothing

#### Scenario: No access is told apart from no session
- **WHEN** a user caller without access to an existing session writes to it or reads it, and the
  same caller writes to a session id with no catalog row
- **THEN** the first two reject with the missing-access error and the third with the
  missing-session error; no body runs and nothing is stored

#### Scenario: Callers on one hub interleave under one serialization
- **WHEN** two user callers with access, and the lease alarm, call storage operations of one
  session's hub concurrently
- **THEN** the calls run one at a time in arrival order, each under its own binding, and the
  broadcasts follow commit order as for a single caller

#### Scenario: A retried transaction announces once
- **WHEN** a hub write's first run fails with a deadlock after issuing a broadcast and setting the alarm, and its second run commits
- **THEN** the caller receives one result, each broadcast of the committed run is sent once, none of the first run's is sent, and the alarm is armed once

#### Scenario: A take started before an import's anchor is not clobbered
- **WHEN** a take starts after a local or YouTube import's rolling check and before its imported take is anchored
- **THEN** the anchor writes nothing, the route answers its existing `409` rolling detail with the imported segment rolled back as that route's rolling refusal does, and the transport is still rolling with its take unchanged

#### Scenario: A hung transaction does not lock the session
- **WHEN** a hub transaction does not finish within its deadline
- **THEN** it rejects with a timeout error, the session's row is unlocked, and the next operation on the session completes

#### Scenario: Responses and frames are unchanged for serial requests
- **WHEN** the existing route, WebSocket and companion test suites run on the Postgres session storage
- **THEN** they pass with no change to expected status codes, bodies, headers or frames, apart from the failure paths the slice's contract deltas name, and apart from what the 7c-1 deltas add: the `version` field on event, transcript word and topic bodies, and revision values that advance once per session write (api-contract-freeze "Session content rows carry their version" and "The session revision advances once per session write")

#### Scenario: A read never sees an open or rolled-back write
- **WHEN** a read on a session is called while a write on that session is open, and the write then commits or rolls back
- **THEN** the read returns either the state before the write or its committed state, and never the write's uncommitted rows

#### Scenario: Broadcasts follow commit order
- **WHEN** two mutating operations on one session run concurrently and both commit
- **THEN** every broadcast of the transaction that committed first is sent before any broadcast of the other

#### Scenario: A failed write leaves no rows and no broadcasts
- **WHEN** a mutating operation's body awaits a statement and then throws, or catches a failed statement and goes on writing
- **THEN** none of its writes persist, none of its broadcasts are sent, and the caller receives the first error

#### Scenario: A nested transaction joins the outer one
- **WHEN** a hub transaction body runs a nested transaction on its transaction handle and the nested body fails
- **THEN** the whole transaction rolls back, including writes made before the nested call

#### Scenario: Calling the hub from inside its own transaction is refused
- **WHEN** a hub transaction body calls a storage operation of the same session's hub
- **THEN** that call rejects promptly, with no deadlock, and the body's own writes can still commit

#### Scenario: Calling another session's hub from inside a transaction is refused
- **WHEN** a hub transaction body calls a storage operation of another session's hub
- **THEN** that call rejects promptly with a misuse error, with no deadlock, and the open transaction rolls back

#### Scenario: A relayed command is not held by a transaction
- **WHEN** a Companion command is relayed over a session's socket while a transaction on that session is open, and the transaction then rolls back
- **THEN** the command frame is sent at once and is not withdrawn

#### Scenario: Concurrent take toggles equal a serial order
- **WHEN** two Companion transport toggles on one session run concurrently from a stopped transport
- **THEN** the transport ends stopped after exactly one start and one stop, as two serial toggles leave it

#### Scenario: Concurrent event edits keep both metadata merges serial
- **WHEN** two updates of one event run concurrently, each merging the stored metadata with its own category snapshot
- **THEN** the stored event equals the result of applying the two updates in some serial order

#### Scenario: Concurrent imports never share a recording ordinal
- **WHEN** two local audio imports into one session run concurrently
- **THEN** their segments, and their `Recording N` events, carry two different consecutive ordinals

#### Scenario: A transcript replace sees one set of recording anchors
- **WHEN** a transcript generation's replace runs concurrently with an imported take that adds recording anchors
- **THEN** the stored words are remapped against the anchors either before or after the take, never a mixture

#### Scenario: Concurrent log imports skip duplicates
- **WHEN** two sheet log imports of the same rows into one session run concurrently
- **THEN** each row is stored once, and the two imports' created counts sum to the number of distinct rows

#### Scenario: A closed hub rejects instead of failing obscurely
- **WHEN** an operation is called on a hub that has been closed
- **THEN** it rejects with an error naming the closed hub, and the route answers with its existing generic server error

#### Scenario: Lease expiry is ordered with the session's operations
- **WHEN** the recording lease alarm fires while an operation on that session is in flight
- **THEN** the expiry neither observes nor interrupts that operation's open transaction, and still frees a stale lease and announces `lease.changed`

#### Scenario: run() preserves change-detection for its readers
- **WHEN** `setAudioSegmentWaveform`, `deleteTopic`, or `deleteTranscriptWord` runs against a non-existent id
- **THEN** it observes zero affected rows and returns the "not found" result, so the routers still respond `404` and no `audio.changed` broadcast fires on a no-op write

## ADDED Requirements

### Requirement: Version checks are atomic with the session write
The session hub's update and delete operations for events, transcript words and topics SHALL take
an optional expected version and an overwrite flag (ADR 0021 slice 7c-1). When an expected version
is given, the operation SHALL read the row's version and either write or refuse inside one hub
write transaction, after the session's row lock is held. A refusal SHALL be a result, not an
error: it SHALL carry the row as stored and SHALL write nothing, advance nothing and broadcast
nothing. A missing row SHALL keep each operation's existing not-found result. An operation without
an expected version SHALL behave exactly as before, apart from advancing the row's version.

An overwrite that passes the check SHALL write its audit row in the same transaction, bound to the
same user caller. The overwrite flag SHALL be accepted only from a user caller; a system caller
with an overwrite flag SHALL be refused with a misuse error before any statement runs.

The session's revision SHALL be advanced by the hub's write path, not by each store: once per
write transaction, by the first store statement of the transaction that changes a session row
(the hub-open seed and the event list's relink bookkeeping do not count), and every
frame and result of that transaction that names the revision SHALL carry the advanced value. A
transaction body that runs more than once (a retried deadlock) SHALL advance it once, for the run
that committed.

#### Scenario: Concurrent same-version edits from two processes
- **WHEN** two server processes update one event concurrently, many times, each with the version it
  last read
- **THEN** every update either commits and advances the version by one or is refused with the
  stored row, and the final version equals one plus the number of committed updates

#### Scenario: A refusal writes nothing
- **WHEN** a versioned topic update is refused
- **THEN** the topic, the session's revision and the overwrite table are unchanged, and no frame is
  sent

#### Scenario: A system caller cannot overwrite
- **WHEN** a hub view bound to a system caller calls an update with the overwrite flag
- **THEN** it rejects with a misuse error and runs no statement

#### Scenario: One revision per transaction
- **WHEN** one hub write transaction inserts two events and changes the transport
- **THEN** the session's revision advances by one, and both `event.changed` frames it sends carry
  that value

#### Scenario: A retried transaction advances the revision once
- **WHEN** a hub write's first run advances the revision and fails with a deadlock, and its second
  run commits
- **THEN** the session's revision is one more than before the write
