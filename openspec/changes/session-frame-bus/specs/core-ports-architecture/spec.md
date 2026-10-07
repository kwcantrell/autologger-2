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
close a user's sockets) SHALL need no caller; relaying a command and closing a user's sockets
SHALL reach the sockets of every server process sharing the database (ADR 0021 slice 9a, "Session
frames reach every process in commit order"). Whatever the mechanism, the session hub
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
  This order SHALL hold on every socket of the session in every server process sharing the
  database, whichever processes made the writes.
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

### Requirement: Every catalog and session call is bound to a caller

Every catalog statement the server sends SHALL run for a caller: a signed-in user (the user
binding) or a named system task (the system binding). A catalog with neither SHALL refuse every
statement and transaction, including `init()`, with a distinct unbound-catalog error, before
anything is sent; reaching it is a programming error, which the server answers with its generic
`500` and an error log line naming the error. The database refuses the app's login role on every
catalog table (catalog-database "The app connects as a least-privilege role"), so a path that
bypasses the adapter's bindings fails closed too.

**Request binding.** The authentication middleware SHALL resolve the caller (the session lookup
and the user read) and load the request's studio registry on a catalog bound to the system task
`auth-resolve`. After resolution, the catalog the routes receive SHALL be bound to the signed-in
user, or unbound when there is none, and SHALL carry the registry snapshot loaded during
resolution. A route that serves a request with no user and needs the catalog SHALL ask for a
system binding explicitly.

**One binding per transaction.** A transaction SHALL run under the binding of the catalog that
started it, and a body SHALL NOT switch bindings: a statement or transaction on any other handle
while a transaction is open is refused (core-ports-architecture "The catalog transaction
contract").

**Session hub calls carry their caller.** Every session hub storage call (every read and write
of session content, the row lock and the live projection included) SHALL run under the binding
of the caller that made it, chosen per call, not per hub: one hub serves every caller of its
session. A hub resolved from the registry SHALL expose its storage operations only through a view
bound to a session caller; there SHALL be no unbound path to them. A session caller SHALL be
either:
- a user: the signed-in user of the request that makes the call, or, for work a request started
  and that outlives it (an AI turn's tool calls, a log-import job), the user who started it; or
- a named system task, for calls no user makes: opening a hub (its seed rows and stale-lease
  cleanup), the recording lease alarm, token-only Companion calls (for any session id, until the
  Companion has its own credential), operator scripts, and a request's undo steps, which remove
  only what that same request wrote or the snapshot it is replacing, after one of its later steps
  failed or was refused.

Socket fan-out (attach, detach, relayed commands, closing a user's sockets) and broadcasts need no
caller. The frame bus (ADR 0021 slice 9a) sends its `pg_notify` statements either inside the
write or revoke transaction that issued them, under that transaction's binding, or on its own
publisher and listener connections, which run no catalog or session statement and read no row.

**System reasons are reviewed.** Every system binding and every system session caller in
production code SHALL name its reason as a string literal. A repository test SHALL list every
system binding and system session caller in the production sources of `server/src`,
`server/scripts` and the packages with its file and reason, and SHALL fail when the list differs
from a reviewed allowlist in either direction (a new call site, a new reason, a reason moved to
another file, or an allowlist entry no longer used), or when a reason is not a string literal. The
catalog's user binding SHALL be created only by the authentication middleware, and a user session
caller only in the reviewed files that take it from the request's signed-in user or from the user
recorded on a job the request started, and the session storage only in the composition root and
the operator scripts; the repository test SHALL fail on either elsewhere, and on a caller written as
an object literal outside the modules that implement the bindings. Tests are exempt.

The allowlisted reasons in this slice are: `auth-resolve`, `boot-wait`, `kv` (login sessions,
OAuth state, the Companion's last command and the expiry purges), `session-open` (a hub's open:
its seed rows and stale-lease cleanup, after a gate or in work a gated request started),
`session-lease-alarm` (the recording lease alarm), `session-undo` (a request's undo steps),
`merge-audio-script` (the operator's audio merge script),
`log-import-job` (the job's catalog reads and its per-sheet re-check; its hub calls run as its
creator), `oauth-callback`, `bootstrap-claim`, `support-plane` (`/api/admin/*`),
`companion-token` (token-only Companion calls, catalog and hub), `access-loss-check`,
`team-invite` and `team-create`. The `session-mirror` reason was retired with the mirror (ADR 0021
slice 7b-1) and the `session-hub` reason with the per-call caller (slice 7b-2).

#### Scenario: A signed-in request runs as its user
- **WHEN** a signed-in user loads `GET /api/profile`
- **THEN** the session lookup and the user read run under the system binding (`kv`,
  `auth-resolve`), and every statement the route itself sends runs as `catalog_user` with that
  user's id

#### Scenario: A request with no user fails closed
- **WHEN** a request with no signed-in user reaches a handler that queries the request catalog
  without asking for a system binding
- **THEN** the response is `500` `{"detail": "Internal Server Error"}`, the log names the
  unbound-catalog error, and no statement reaches the database

#### Scenario: Unchanged behaviour
- **WHEN** the server's unit, integration and `pg` suites run after the bindings are introduced
- **THEN** they pass with no change to any HTTP status, body or WebSocket message they assert

#### Scenario: A new system call site needs review
- **WHEN** a production file gains a system binding whose file and reason are not on the
  allowlist, or uses a reason held in a variable
- **THEN** the repository test fails and names the file and the reason

#### Scenario: A stale allowlist entry fails
- **WHEN** an allowlisted system binding is removed from the code but not from the allowlist
- **THEN** the repository test fails and names the stale entry

#### Scenario: A system handle inside a user transaction is refused
- **WHEN** a body of a user-bound transaction issues a statement through a system-bound catalog
- **THEN** the call rejects with the misuse error and the transaction rolls back

#### Scenario: Session hub statements run as their caller
- **WHEN** a signed-in user logs an event in a session whose hub is already open
- **THEN** the route's own catalog reads and every statement of the hub's write, the row lock and
  the projection update included, run as `catalog_user` with that user's id

#### Scenario: Two users on one hub keep their own bindings
- **WHEN** two signed-in users with access to one session write to it concurrently through the
  same open hub
- **THEN** each write's statements run as `catalog_user` with its own user's id, and the writes
  are serialized in one order

#### Scenario: Calls no user makes run as their reviewed system task
- **WHEN** a hub is opened for a session, its lease alarm fires, a token-only Companion call logs
  an event, and an audio upload whose blob write failed removes its segment row
- **THEN** the open runs as `catalog_system` under `session-open`, the alarm under
  `session-lease-alarm`, the Companion write under `companion-token`, and the removal under
  `session-undo`

#### Scenario: Background work runs as the user who started it
- **WHEN** an AI turn started by user A calls a tool that creates an event, and a log-import job
  started by user A writes events
- **THEN** each of those hub statements runs as `catalog_user` with A's id

#### Scenario: A user session caller outside the reviewed files fails the scan
- **WHEN** a production file other than the reviewed ones makes a user session caller or builds
  the session storage, a caller is written as an object literal outside the implementing modules,
  or a system session caller's reason is not a literal or not on the allowlist
- **THEN** the repository test fails and names the file

### Requirement: The Postgres session adapter

A Postgres implementation of the session storage seam SHALL meet "Session runtime is an
asynchronous, per-session serialized port on Postgres", proven by a session storage contract test
suite that runs against the pinned Postgres image.

It SHALL run on the catalog adapter's own connections and machinery ("The Postgres catalog
adapter"): one adapter instance per server process serves the catalog stores, the key/value store
and the session hubs, with the same connection set, deadline, bindings, statement rules (`?`
placeholders, 64-bit integers as numbers, the affected-row count, NUL refused before sending),
connection-loss and unconfirmed-end rules and `close()`. Session transactions and snapshots SHALL
run on a separate, smaller set of the adapter's single-connection clients (the session
connections), with their own wait queue, so that session work never occupies a connection the
catalog's transactions or root statements need: heavy session traffic can slow only session calls.
The root, transaction and session connections, together with the frame bus's listener and
publisher connections, SHALL stay within a per-process budget of 14, so that up to four server
processes fit the app role's connection limit (catalog-database "The app connects as a
least-privilege role"). Each session transaction and snapshot SHALL run under the binding of the
caller the call names (core-ports-architecture "Every catalog and session call is bound to a
caller"), chosen per call: a user caller as `catalog_user` with the user's id, a system caller as
`catalog_system` with its reason.

Transactions:
- a session write transaction SHALL run at the `READ COMMITTED` isolation level and SHALL lock
  the session's `catalog.sessions` row (`FOR UPDATE`) before its body runs, the lock sent with the
  transaction's begin and binding so it adds no round trip;
- when the lock returns no row, the transaction SHALL roll back and reject, with no retry and
  without running its body: under a system binding with the missing-session error; under a user
  binding with the missing-access error when the session exists (asked through a definer
  function that sees every session, catalog-database "Policy helpers are reviewed definer
  functions") and with the missing-session error when it does not;
- a session write transaction that fails on a deadlock SHALL roll back and run its body again,
  with the catalog's backoff, at most five runs in total; no other failure SHALL be retried;
- a snapshot SHALL run as one `REPEATABLE READ READ ONLY` transaction and SHALL NOT be retried;
  under a user binding it SHALL first check, with a statement sent with its begin and binding,
  that the caller has access to the session, and SHALL reject as a refused lock does when not;
- one deadline SHALL cover a session transaction or snapshot as it covers a catalog transaction:
  the wait for a connection, the row-lock wait, every run and the commit.

Values:
- a `double precision` value SHALL read back exactly as it was written.

#### Scenario: The session contract holds on Postgres
- **WHEN** the session storage contract suite runs against the adapter on the pinned image
- **THEN** commit, rollback (including a caught statement error), joins, misuse, the row lock before the body, the missing-session refusal, the missing-access refusal of writes and snapshots, one-state snapshots, a refused write in a snapshot, the deadlock re-run, the deadline, NUL refusal and exact float round trips all hold

#### Scenario: A user binding sees only accessible content
- **WHEN** a snapshot for the owner of a session's team and one for a member without a grant read
  the session's events, and a write transaction for each inserts an event
- **THEN** the owner's snapshot returns the events and its write commits; the member's snapshot and
  write both reject with the missing-access error before their bodies run

#### Scenario: The lock is held before the body runs
- **WHEN** one connection holds a session write transaction open and another starts a session write transaction for the same session
- **THEN** the second body does not run until the first transaction ends

#### Scenario: An unconfirmed end retires the connection
- **WHEN** a session transaction's rollback is not confirmed by the server
- **THEN** the call rejects, the connection is closed and replaced, and the next session call succeeds

#### Scenario: Saturated session connections do not delay the catalog
- **WHEN** every session connection is held by a slow session snapshot and a signed-in user updates their profile
- **THEN** the profile update completes promptly, and a further session call waits for a session connection, then completes once one frees or fails with the timeout error at its deadline

#### Scenario: The connection count stays within the role's limit
- **WHEN** the server runs with session hubs open
- **THEN** it holds no more database connections than its root, transaction and session connections, together fewer than the app role's limit of 20

## ADDED Requirements

### Requirement: Session frames reach every process in commit order
Every frame a session's write transaction issues (`event.changed`, `transport.changed`,
`audio.changed`, `lease.changed`) SHALL reach every `/api/sessions/:id/ws` socket attached to that
session in any server process sharing the database (ADR 0021 slice 9a), through a Postgres
`NOTIFY` channel that every process listens on.

- **Published with the commit.** A transaction's frames SHALL be published inside the
  transaction, so a transaction that rolls back, or an attempt that is retried, publishes nothing.
  Every process, including the one that made the write, SHALL deliver frames only from the channel,
  so each socket receives a session's frames in commit order and, within one transaction, in issue
  order. Each published message SHALL carry a sequence number unique within its transaction, so
  Postgres never folds two equal frames into one.
- **Signed.** Every message SHALL carry an HMAC-SHA256 over its content, keyed by the server-only
  `FRAME_BUS_SECRET`. A receiver SHALL drop, and log, a message whose signature does not verify,
  whose version is unknown, whose frame type is not one of the five session frame types, or whose
  command is not a contract command. A database role without the secret therefore cannot inject a
  frame, a command or a close.
- **Commands.** A relayed command SHALL be checked against the contract's command values before it
  is published, at most 10 per second per socket (excess dropped), and published on the bus's own
  publisher connection, never on a catalog or session connection.
- **Access-loss closes.** The close for a user who lost access SHALL be published inside the
  transaction that removes the access, split across as many messages as the payload limit needs.
  A revoke whose close cannot be published SHALL fail and change nothing.
- **The frames are unchanged.** Shapes, types, revisions, and where each frame is emitted are as
  before.

The Postgres bus is used by the server's production entry point. Test harnesses and a registry
built without a bus deliver in process, after commit, as before this change.

#### Scenario: A write through one process reaches a socket on another
- **WHEN** a browser has a socket on session S through process B and a client logs an event through
  process A
- **THEN** the socket on B receives that write's `event.changed` with its revision, exactly once

#### Scenario: Interleaved writes arrive in commit order everywhere
- **WHEN** processes A and B each log 100 events on session S concurrently, and sockets on S are
  attached through both
- **THEN** every socket receives 200 `event.changed` frames whose revisions strictly increase

#### Scenario: A rolled-back write publishes nothing
- **WHEN** a write transaction on S issues a frame and then fails
- **THEN** no socket in any process receives that frame

#### Scenario: A command reaches a browser on another process
- **WHEN** a socket on session S through process A sends `{type:"command", command:"record-start"}`
  while another browser socket on S is attached through process B
- **THEN** the socket on B receives the `command` frame

#### Scenario: A forged message is dropped
- **WHEN** a database role without the secret calls `pg_notify` on the channel with a well-formed
  command frame for session S
- **THEN** no socket in any process receives it, and the receiving processes log the drop

#### Scenario: A large team's revoke still closes every socket
- **WHEN** a member of a team with 300 sessions is removed through process A while they hold a
  socket on one of those sessions through process B
- **THEN** that socket closes with code `4403`
