## ADDED Requirements

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

Socket fan-out (attach, detach, relayed commands, closing a user's sockets) and broadcasts send
no statement and need no caller.

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

## MODIFIED Requirements

### Requirement: Policy outcomes keep each route's status
Row-level policies (catalog-database "User policies enforce the team permission model") SHALL
NOT change any status, body or message a route returns for a request that a serial order of
requests can produce. The app's gates decide first. Where a policy can hide a row or refuse a
write, the route SHALL answer as follows.

**Existence probes.** A route whose status distinguishes a missing entity from another team's
entity SHALL ask an existence check that sees every row, not a user-scoped read:
- `POST /api/shows` SHALL answer `404 Unknown studio id.` for a team that exists but in which the
  caller has no membership. It SHALL answer `400 Unknown studio id.` for a team that does not
  exist. That includes a team whose deletion commits while the create is in flight.
- `POST /api/sessions` SHALL answer `400 Show does not belong to the active team.` for a show
  that exists in a team other than the caller's active team, member or not. It SHALL answer
  `400 Unknown show_id.` for a show that does not exist.

**Writes refused in a race.** A write whose access is revoked after the route's early gate and
before the write SHALL be answered with the status the route already gives for missing access,
and SHALL leave the row unchanged:
- `PUT /api/sessions/:id`, `POST /api/sessions/:id/archive`, `POST …/restore` and
  `DELETE /api/sessions/:id` SHALL answer `404 Session not found` when the write changed no row.
- `PUT /api/profile` with team settings or show updates SHALL re-check the caller's role, with
  the membership row locked `FOR SHARE`, in the same transaction as those writes and before the
  first of them. A caller who is no longer `owner` or `admin` there SHALL get
  `403 Admin role required.` with nothing written, prefs and names included. Outcomes for
  requests no demotion races stay as before, including the `400` for a show entry outside the
  selected team after the earlier entries were saved.
- The ownership transfer SHALL answer `404 Member not found` when the target's user row cannot be
  read.

**Session hub calls refused in a race.** A session hub call made for a user whose access to the
session's show (a membership or a grant) is lost after the route's gate (`requireSession`) SHALL be
refused before it reads or writes any session content, with an error that names missing access,
distinct from the error for a session that does not exist, and whose message names neither the
session nor the user. The route SHALL answer it with the status it already gives for missing
access, SHALL send no broadcast for the refused call, and SHALL leave none of its own writes: a
write the same request made before the refusal SHALL be removed by the route's existing undo steps,
which run as the reviewed system task `session-undo` and remove only what that request wrote (or,
for an event regenerate, the snapshot it is replacing):
- every route under `/api/sessions/:id` SHALL answer `404 Session not found`, including a route
  whose other failures are wrapped into a different status (the YouTube import's `502`);
- with a session cookie, `GET /api/companion/state` SHALL answer `200` as when the caller cannot
  see the active session (`active_session_id: null`, `session: null`, `last_command: null` when it
  names that session, `connected_clients` unchanged), and `GET /api/companion/categories`,
  `POST /api/companion/log`, `POST /api/companion/transport` and `POST /api/companion/command` SHALL
  answer the `409` with the no-active-session detail and change nothing;
- work a request started and that outlives it SHALL report the refusal through its existing
  failure path: an AI tool call returns its tool error and creates nothing; a log-import sheet is
  reported failed, and the job's per-sheet access re-check stops it before the next sheet.

No new status, body or message SHALL be introduced for these refusals.

**A refusal after an in-transaction gate is a bug.** Where the route checked the caller's role or
access inside the same transaction, with the rows read `FOR SHARE`, a `42501` cannot come from a
concurrent change. These routes are:
- the team writes;
- `PUT /api/profile`'s settings and show writes;
- `POST /api/shows`;
- `POST /api/sessions`;
- the grant writes.

On any of them, a `42501` SHALL stay the generic `500` `{"detail": "Internal Server Error"}`, with
a log line naming `CatalogForbiddenError`, its table and its binding. Elsewhere, an unmapped
`42501` SHALL be answered the same way.

**Multi-statement writes run in an order the policies admit.** A store method that removes a
team SHALL delete the team's memberships last, after its invites, definition and settings. While
the caller is still a member, each of those deletes passes the member-team rules.

#### Scenario: A foreign team stays 404 on show create
- **WHEN** a signed-in user who is not a member of existing team U sends `POST /api/shows` with
  `studio_id` U
- **THEN** the response is `404` `{"detail": "Unknown studio id."}`, as before row-level policies

#### Scenario: A team deleted during show create stays 400
- **WHEN** a show create for team T has passed its existence read, and the deletion of T commits
  before the show is inserted
- **THEN** the create gets `400 Unknown studio id.`, and no show references T

#### Scenario: Another team's show on session create stays the team error
- **WHEN** a signed-in user sends `POST /api/sessions` for a show of a team they are not a member
  of, and separately for a show id that does not exist
- **THEN** the first gets `400 Show does not belong to the active team.` and the second
  `400 Unknown show_id.`

#### Scenario: A session update racing a revoke changes nothing
- **WHEN** a granted member's `PUT /api/sessions/:id` has passed `requireSession`, and the
  revocation of the member's grant commits before the update runs
- **THEN** the response is `404 Session not found` and the session row is unchanged

#### Scenario: A session content write racing a revoke changes nothing
- **WHEN** a granted member's `POST /api/sessions/:id/events`, a transport start, a transcript
  word edit and a dashboard save have each passed `requireSession`, and the revocation of the
  member's grant commits before the hub call runs
- **THEN** each response is `404 Session not found`, the session's events, transport, transcript,
  dashboards and live projection are unchanged, and no `*.changed` frame is sent

#### Scenario: A session content read racing a revoke is masked
- **WHEN** a granted member's `GET /api/sessions/:id/events` has passed `requireSession`, and the
  revocation of the member's grant commits before the hub read runs
- **THEN** the response is `404 Session not found`, not an empty list

#### Scenario: A Companion call with a cookie racing a revoke stays the no-active-session answer
- **WHEN** a granted member's `POST /api/companion/log` and `GET /api/companion/state` with a
  session cookie have passed their access check, and the revocation commits before the hub call
  runs
- **THEN** the log answers `409` with the no-active-session detail and no event is stored, and the
  state answers `200` with `active_session_id: null` and `session: null`

#### Scenario: An import refused in a race is undone and answers 404
- **WHEN** a granted member's local audio import and YouTube import have stored their segment and
  blob, and the revocation commits before their anchor runs
- **THEN** each response is `404 Session not found` (not `502`), and the segment and its blob are
  removed by the route's undo, run as `session-undo`

#### Scenario: Background writes after a revoke are refused
- **WHEN** user A's AI turn calls `create_event` after A's grant on the session's show is revoked,
  and A's log-import job reaches a session's hub write after the same revoke
- **THEN** the tool call returns a tool error whose text names neither the session nor the user
  and creates no event, and the job stores no event in that session and reports the sheet failed

#### Scenario: A settings save racing a demotion is refused
- **WHEN** an admin's `PUT /api/profile` with team settings and a show update has passed its
  early role check, and the admin's demotion to member commits before the request's transaction
- **THEN** the response is `403 Admin role required.`, and the stored settings, the show, the
  admin's prefs and names are unchanged

#### Scenario: A team delete removes every row under policies
- **WHEN** the owner of a team with no shows deletes it through `DELETE /api/teams/:id`
- **THEN** the response is `200`, and the team's invites, definition, settings and memberships
  are all gone

#### Scenario: A forbidden error after an in-transaction gate is a 500
- **WHEN** a statement in a team write's transaction is refused with `42501` after the caller's
  role was read `FOR SHARE`
- **THEN** the response is `500` `{"detail": "Internal Server Error"}`, and the log line names
  `CatalogForbiddenError`, the table and the binding `user`, but not the user id

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
connection limit. Each session transaction and snapshot SHALL run under the binding of the
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

## REMOVED Requirements

### Requirement: Every catalog call is bound to a caller
**Reason**: Slice 7b-2 binds every session hub call to its caller, so the requirement's
`session-hub` reason and its scenario "Session hub statements run as the session-hub system task"
no longer hold, and OpenSpec refuses a MODIFIED block that drops a scenario.
**Migration**: Replaced by "Every catalog and session call is bound to a caller", which keeps
every other rule and scenario of this requirement and adds the per-call session caller.
