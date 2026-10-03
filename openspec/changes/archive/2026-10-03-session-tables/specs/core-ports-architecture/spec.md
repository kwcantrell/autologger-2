## ADDED Requirements

### Requirement: Session runtime is an asynchronous, per-session serialized port on Postgres

The session spine SHALL depend on a `SessionRuntime` port exposing the session's id, its storage,
socket fan-out, an alarm/scheduler, and a clock — as an **interface**, so tests can supply a
runtime whose storage is wrapped (one that yields between statements or injects a failure)
without touching `SessionCore`. The port's normative home is `@autologger/session-core`
(alongside `SessionCore`), not `@autologger/ports` — it is the session package's internal
substitution seam, consumed by the package's stores and by test wrappers. Its storage is supplied
by the composition root (the Postgres session adapter, "The Postgres session adapter"); the
session package SHALL NOT open a database itself.

The storage seam SHALL be asynchronous and scoped to one session:
- `tx(fn)` runs a write transaction: the session's catalog row is locked before `fn` runs, so
  writes to one session are serialized across every connection and process; a session with no
  catalog row SHALL reject with an error naming the missing session before `fn` runs;
- `snapshot(fn)` runs a read: every statement in `fn` sees one committed state, and a write inside
  it fails;
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

The hub's storage operations SHALL return promises; its socket operations (attach, detach, relay a
command, close a user's sockets) SHALL stay synchronous. Whatever the mechanism, the session hub
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
- **THEN** it exposes promise-returning `tx(fn)` and `snapshot(fn)` whose handles offer `all(sql, ...binds)` returning rows, `run(sql, ...binds)` returning `{ changes }` and a joining `tx`, and it exposes neither a multi-statement DDL path nor the `exec() → { toArray(), rowsWritten }` cursor shape

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
- **THEN** they pass with no change to expected status codes, bodies, headers or frames, apart from the failure paths the slice's contract deltas name

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
The root, transaction and session connections together SHALL stay within the app role's
connection limit. Its handles SHALL be bound to the system task `session-hub` (core-ports-architecture "Every catalog
call is bound to a caller").

Transactions:
- a session write transaction SHALL run at the `READ COMMITTED` isolation level and SHALL lock
  the session's `catalog.sessions` row (`FOR UPDATE`) before its body runs, the lock sent with the
  transaction's begin and binding so it adds no round trip;
- when that row does not exist, the transaction SHALL roll back and reject with a distinct
  missing-session error, with no retry;
- a session write transaction that fails on a deadlock SHALL roll back and run its body again,
  with the catalog's backoff, at most five runs in total; no other failure SHALL be retried;
- a snapshot SHALL run as one `REPEATABLE READ READ ONLY` transaction and SHALL NOT be retried;
- one deadline SHALL cover a session transaction or snapshot as it covers a catalog transaction:
  the wait for a connection, the row-lock wait, every run and the commit.

Values:
- a `double precision` value SHALL read back exactly as it was written.

#### Scenario: The session contract holds on Postgres
- **WHEN** the session storage contract suite runs against the adapter on the pinned image
- **THEN** commit, rollback (including a caught statement error), joins, misuse, the row lock before the body, the missing-session refusal, one-state snapshots, a refused write in a snapshot, the deadlock re-run, the deadline, NUL refusal and exact float round trips all hold

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

## MODIFIED Requirements

### Requirement: Every catalog call is bound to a caller

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

**System reasons are reviewed.** Every system binding in production code SHALL name its reason
as a string literal. A repository test SHALL list every system binding in the production sources
of `server/src` and the packages with its file and reason, and SHALL fail when the list differs
from a reviewed allowlist in either direction (a new call site, a new reason, a reason moved to
another file, or an allowlist entry no longer used), or when a system binding's reason is not a
string literal. The user binding SHALL be created only by the authentication middleware. Tests
are exempt.

The allowlisted reasons in this slice are: `auth-resolve`, `boot-wait`, `kv` (login sessions,
OAuth state, the Companion's last command and the expiry purges), `session-hub` (every session
hub statement, until slice 7b-2 binds hub calls to their caller), `log-import-job`,
`oauth-callback`, `bootstrap-claim`, `support-plane` (`/api/admin/*`), `companion-token`
(token-only Companion calls), `access-loss-check`, `team-invite` and `team-create`. The
`session-mirror` reason is retired with the mirror (ADR 0021 slice 7b-1).

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

#### Scenario: Session hub statements run as the session-hub system task
- **WHEN** a signed-in user logs an event in a session
- **THEN** the route's own catalog reads run as `catalog_user` with that user's id, and every
  statement of the hub's write, the projection update included, runs as `catalog_system`
  under the reason `session-hub`

## REMOVED Requirements

### Requirement: Session runtime is an asynchronous, per-session serialized, substitutable port
**Reason**: Session storage moves to Postgres (ADR 0021 slice 7b-1). The seam loses its
multi-statement DDL path (there is no per-session schema to initialize) and gains read snapshots
and the session row lock, and the in-memory SQLite fake runtime leaves the package with
`better-sqlite3`. OpenSpec refuses a MODIFIED block that drops a scenario, so the requirement is
replaced by "Session runtime is an asynchronous, per-session serialized port on Postgres", which
keeps its observables and its other scenarios.
**Migration**: The session hub's callers are unchanged. Tests that built a hub over a SQLite file
or the in-memory fake run on a Postgres clone in the server's integration project, wrapping the
session storage where they need a slow or failing statement.
