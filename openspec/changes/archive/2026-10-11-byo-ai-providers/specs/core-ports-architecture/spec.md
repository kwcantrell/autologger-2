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
`companion-presence` (the shared Companion presence table),
`provider-credentials` (the `ProviderCredentialStore` of `packages/storage`, on
`bindSystem('provider-credentials')` and wired as `Bindings.ports.providerCredentials`, not a
catalog facade store: the provider routes' read, save and delete, and the credential lookup for a
request or a log-import job, each scoped by user id in SQL; and the boot check of the provider-key
check value), `access-loss-check`,
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

#### Scenario: A provider credential lookup runs under its reviewed reason
- **WHEN** a signed-in user generates a transcript with their own speech-to-text credential
- **THEN** the credential read runs under the system binding `provider-credentials` through
  `Bindings.ports.providerCredentials`, scoped by that user's id, and the hub's writes run as
  `catalog_user` with that user's id
