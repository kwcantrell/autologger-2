## REMOVED Requirements

### Requirement: Authentication and authorization are distinct, single seams

**Reason**: Its "API_TOKEN machine clients bypass studio membership" scenario states the opposite of the new behaviour: `API_TOKEN` is retired and a Companion device acts as its user with that user's access (companion-devices owner decisions 1, 4). Restated, with the device token in place of `API_TOKEN`, under "Authentication and authorization are distinct seams for every caller".

## MODIFIED Requirements

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
  cleanup), the recording lease alarm, operator scripts, and a request's undo steps, which remove
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
`companion-device` (the `CompanionDeviceStore` of `packages/storage`, on
`bindSystem('companion-device')` and wired as `Bindings.ports.companionDevices`, not a catalog
facade store: the device-token lookup, its last-used update, and the management routes' list,
create and revoke, each scoped by user id in SQL),
`companion-presence` (the shared Companion presence table), `access-loss-check`,
`team-invite` and `team-create`. The `session-mirror` reason was retired with the mirror (ADR 0021
slice 7b-1), the `session-hub` reason with the per-call caller (slice 7b-2), and the
`companion-token` reason with `API_TOKEN` (slice 9d): a Companion call runs as the device's user.

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
- **WHEN** a hub is opened for a session, its lease alarm fires, and an audio upload whose blob
  write failed removes its segment row
- **THEN** the open runs as `catalog_system` under `session-open`, the alarm under
  `session-lease-alarm`, and the removal under `session-undo`

#### Scenario: A Companion device call runs as its user
- **WHEN** a Companion device logs an event in its user's active session
- **THEN** the device lookup runs under the system binding `companion-device` through
  `Bindings.ports.companionDevices`, and the route's
  catalog reads and every statement of the hub's write run as `catalog_user` with the device's
  user's id

#### Scenario: Background work runs as the user who started it
- **WHEN** an AI turn started by user A calls a tool that creates an event, and a log-import job
  started by user A writes events
- **THEN** each of those hub statements runs as `catalog_user` with A's id

#### Scenario: A user session caller outside the reviewed files fails the scan
- **WHEN** a production file other than the reviewed ones makes a user session caller or builds
  the session storage, a caller is written as an object literal outside the implementing modules,
  or a system session caller's reason is not a literal or not on the allowlist
- **THEN** the repository test fails and names the file

## ADDED Requirements

### Requirement: Authentication and authorization are distinct seams for every caller

Request **authentication** (resolving identity from the session cookie, or from a Companion
device token) SHALL be performed once in middleware; a device token SHALL be honoured only on
paths under `/api/companion/`, where it resolves to the device's user (see `api-contract-freeze`
"Companion device tokens authenticate only the Companion surface"). `API_TOKEN` SHALL NOT be read.
The middleware's path decisions (login required, device-token scope) SHALL use the same
percent-decoded path the router matches, so a request that reaches an `/api/*` handler is always
judged as an `/api/*` request. Resource **authorization** (existence + show access + admin-token checks; show access is the
team-management "Member content access" rule: the owner or an admin of the show's team, or a
member holding a grant for the show) SHALL be consolidated behind `requireSession` and its
show-level sibling rather than re-deriving the login decision; no session-scoped route SHALL
check access any other way. The login-required check SHALL NOT be duplicated between
middleware and per-route helpers. Route helpers MAY assert that a principal is present; a
missing principal behind the middleware is an internal error (500), not a second login
decision. The consolidation SHALL preserve these exact behaviors,
each locked by a scenario below. (Replacing the `apiRequestRequiresLogin` URL-prefix matcher
with an explicit per-route policy is **deferred** — see the archived change's design D6 —
so its default-deny requirements are out of scope for this capability.)

#### Scenario: Login check is not duplicated
- **WHEN** a session-scoped route is exercised
- **THEN** the unauthenticated-401 decision is made exactly once, in the middleware, and `requireSession` performs only resolve + authorize (at most asserting that a principal is present, which is never a `401`)

#### Scenario: Companion device callers are authorized as their user
- **WHEN** a request authenticated by a Companion device token on a path under `/api/companion/` resolves a session in a studio where the device's user has no membership, and then one of a show the user holds a grant for
- **THEN** the first is answered as when there is no active session and the second is allowed: the device's user is scoped exactly like a signed-in user, with no system bypass

#### Scenario: A device token is not an identity outside the Companion surface
- **WHEN** a request bearing only a live Companion device token accesses a session-scoped route outside `/api/companion/`
- **THEN** it is rejected by the single middleware login decision with `401`, and `requireSession` is never reached

#### Scenario: Percent-encoded API prefix is gated like the literal one
- **WHEN** `GET /%61pi/sessions` or `GET /%61pi/companion/state` is sent with no session cookie and no `Authorization` header
- **THEN** the response is `401` `{"detail": "Login required."}`, exactly as for `/api/sessions` and `/api/companion/state`, and no handler runs

#### Scenario: Cross-studio access is masked as 404, not 403
- **WHEN** an authenticated user who is not a member of a session's studio requests that session
- **THEN** the response is `404` "Session not found" (not `403`), identical before and after

#### Scenario: Admin token distinguishes unset from wrong
- **WHEN** an `/api/admin/*` route is called with `ADMIN_TOKEN` unset versus with an invalid token
- **THEN** it returns `503` (unset) versus `401` (invalid) respectively, and a session cookie alone grants no admin access

#### Scenario: A member without a grant is masked as 404, not 403
- **WHEN** an authenticated member of a session's studio who holds no grant for the session's show
  requests that session through any session-scoped route
- **THEN** the response is `404` "Session not found" (not `403`), identical to the cross-studio
  response

#### Scenario: Every session-scoped route goes through the one gate
- **WHEN** the registered route table is enumerated
- **THEN** every route whose path names a session id, and the show-scoped log import, denies a
  member without a grant with the masked `404` before reading its body, and a route added later
  without the gate fails that check


### Requirement: Companion presence is shared by every process
Companion presence SHALL be stored in the catalog table `catalog.companion_presence`
(catalog-database "Companion devices and presence are stored in the catalog"), so every server
process sharing the database sees the same presence (ADR 0021 slice 9d, owner decision 3). No
process SHALL keep presence in memory.

- **Port.** The `PresenceRegistry` port SHALL be asynchronous and SHALL be exactly:
  - `upsert(clientId, meta)`, where `PresenceMeta` carries the posting user's id (`user_id`)
    beside its session id (nullable), visibility and playing state;
  - `remove(clientId, userId)`;
  - `list(userId)`, returning that user's fresh rows, each with its `client_id` and metadata;
  - `deleteOlderThan(cutoffMs)`.

  The freshness window `PRESENCE_FRESH_MS` (15 s) SHALL be a constant of the port module.
- **Postgres implementation.** The storage package SHALL implement the port on
  `bindSystem('companion-presence')`:
  - `upsert` SHALL insert the row, or update the existing row for that client id only when it
    belongs to the same user or was last updated more than `PRESENCE_FRESH_MS` ago; a fresh row
    of another user SHALL be left unchanged (ownership, api-contract-freeze "Companion routes run
    as the caller's user"), so a tab reused after another user signs in posts as that user once
    the old row is stale;
  - `remove` SHALL delete the row for that client id only when it belongs to that user;
  - `list` SHALL return only that user's rows updated at or after `now - PRESENCE_FRESH_MS`
    (inclusive at the edge);
  - `deleteOlderThan` SHALL delete rows last updated before the cutoff.

  Every time it reads or writes SHALL come from the `Clock` port. The composition root SHALL wire
  this implementation, and the in-memory registry SHALL be deleted.
- **Sweeping.** Each lease sweeper tick ("Expired leases are swept by every process") SHALL run
  `deleteOlderThan(now - 60 s)` as its first step, before the expired-recording listing whose
  failure ends the tick early. A failure SHALL only log a warning, like the sweeper's other steps,
  and the tick SHALL go on.
- **Session deletion.** A row whose session is deleted SHALL keep no session id, and SHALL then
  make no session active.

#### Scenario: Presence written by one process is listed by another
- **WHEN** process A upserts a presence row for user U and process B, sharing the database, lists
  U's presence
- **THEN** B's list contains that row with its client id, user id and session id

#### Scenario: Freshness follows the clock
- **WHEN** a test upserts a presence row and advances the fake clock past `PRESENCE_FRESH_MS`
- **THEN** the row is no longer listed, without any real time passing; at exactly
  `PRESENCE_FRESH_MS` it is still listed

#### Scenario: List is scoped to the user
- **WHEN** users A and B each upsert a fresh row and A's presence is listed
- **THEN** the list holds only A's row

#### Scenario: A fresh row of another user is not taken over
- **WHEN** a client id is upserted for user A, and within `PRESENCE_FRESH_MS` upserted for user B,
  and B removes that client id
- **THEN** one row exists for that client id, it still names A with A's session and update time,
  and B's remove deletes nothing

#### Scenario: A stale row of another user moves to the new user
- **WHEN** a client id is upserted for user A, the clock advances past `PRESENCE_FRESH_MS`, and it
  is upserted for user B
- **THEN** one row exists for that client id, and it names B

#### Scenario: The sweeper removes old presence rows first
- **WHEN** a sweeper tick runs while one presence row was last updated 61 s ago and another 5 s
  ago, and the expired-recording listing fails
- **THEN** the first row is deleted and the second is unchanged, and the listing failure is logged
