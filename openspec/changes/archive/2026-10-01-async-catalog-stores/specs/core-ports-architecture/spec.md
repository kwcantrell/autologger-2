## RENAMED Requirements

- FROM: `### Requirement: Catalog persistence is synchronous with no Cloudflare-shaped API`
- TO: `### Requirement: Catalog persistence is asynchronous with no Cloudflare-shaped API`

## MODIFIED Requirements

### Requirement: Catalog persistence is asynchronous with no Cloudflare-shaped API

The catalog persistence seam SHALL be the asynchronous `CatalogDb` port: promise-returning
`all()`, `first()`, `run()` and `tx()`, under the catalog transaction contract. It SHALL NOT
expose D1's `prepare().bind().all()/first()/run()` shape. `run()` SHALL return an affected-row
count (`{ changes }`) for callers that detect changes.

Every catalog store method that reaches the database SHALL return a promise, and every internal
call SHALL await it. The studio registry's memory-only getters (`studioNamesDict`,
`studioOrderTuple`, `isKnownStudio`, `listStudiosBrief`, `listStudiosBriefAllowed`) SHALL stay
synchronous, and are correct only after the catalog's `init()` has been awaited.

A store method or route that reads and then writes, or writes several rows, SHALL do so inside
one `tx()`. Its body SHALL run on stores bound to the transaction handle, so a store transaction
inside a route transaction joins it.

#### Scenario: No async costume in catalog stores
- **WHEN** the catalog stores in `@autologger/catalog` (`packages/catalog/src/`) are inspected
- **THEN** they reach the database only through the promise-returning `CatalogDb` port, never wrap a synchronous call in `async` themselves, expose `all()/first()/run()/tx()` rather than `prepare().bind()`, and no synchronous catalog adapter remains in production code

#### Scenario: Change-detecting callers still work
- **WHEN** a catalog operation that detects modification (removed membership, archived session) runs
- **THEN** it reads the affected-row count from `run()` and behaves identically to before

#### Scenario: Atomic multi-statement writes use tx()
- **WHEN** a catalog operation performs multiple writes atomically, or writes based on what it just read
- **THEN** it runs them inside a single `tx()`, with all-or-nothing semantics preserved under a mid-write failure

#### Scenario: A store transaction composes inside a route transaction
- **WHEN** a route's catalog transaction calls a store method that has its own transaction, and the route body then fails
- **THEN** the store method's writes are rolled back with the route's

#### Scenario: Concurrent first reads do not collide
- **WHEN** two calls that create a row only if it is missing (a user's preferences row, a new team) run interleaved
- **THEN** both complete without a constraint error, and exactly one row exists

### Requirement: Catalog facade exposes only role-scoped stores

The `Catalog` type SHALL expose its domain stores (`shows`, `studios`, `auth`,
`sessions`, `profile`) as its API surface, plus two lifecycle members: `init()`, which loads the
studio registry, and `tx()`, which runs a body on a `Catalog` bound to one catalog transaction. The flat delegate methods that forward to
those stores SHALL be removed, and callers SHALL reach behavior through the store fields.

#### Scenario: Delegate shim removed
- **WHEN** the catalog facade is inspected
- **THEN** it contains no flat delegate methods (e.g. `getShowRow`, `authGetUserById`) and callers use `catalog.shows.getShowRow(...)` etc.

### Requirement: Key/value and presence ports are asynchronous

The `KvStore` and `PresenceRegistry` port operations SHALL return promises, so a networked
backend can replace the embedded one without changing call sites. Every caller SHALL await them,
including the adapters' own internal calls.

The `KvStore` port SHALL offer `take(key)`, which removes and returns a live entry in one atomic
step and returns nothing for a missing or expired one. A one-shot credential, such as the OAuth
CSRF state, SHALL be consumed with `take`, so of several concurrent consumers exactly one succeeds.

The startup purge of expired key/value entries SHALL be attempted before the server accepts
connections. A failed purge SHALL be logged and SHALL NOT prevent boot, because reads still
treat expired entries as absent.

#### Scenario: Startup purge precedes listening
- **WHEN** the server boots
- **THEN** expired key/value entries are purged, and the purge completes before the server begins listening

#### Scenario: A failed purge does not block boot
- **WHEN** the startup purge fails
- **THEN** a warning is logged and the server still starts, and an expired entry still reads as absent

#### Scenario: Expired entries read as absent
- **WHEN** a key/value entry's expiry has passed and it is read
- **THEN** the read returns no value and the entry is removed

#### Scenario: Concurrent takes of one entry
- **WHEN** two callers take the same live key/value entry concurrently
- **THEN** exactly one receives its value, the other receives nothing, and the entry is gone

#### Scenario: A replayed OAuth state is refused under concurrency
- **WHEN** two OAuth callbacks carrying the same valid state arrive concurrently
- **THEN** at most one proceeds to sign-in and the other is redirected with `login_error=state_invalid`

### Requirement: Server code never drops or misuses a promise

Production code under `server/src` and `packages/catalog/src` SHALL NOT leave a promise
unconsumed. Every promise-returning
call SHALL be awaited, returned, or explicitly discarded with `void`.

No code SHALL:
- use a promise as a condition, negate it, or compare it with `===`, `!==`, `==` or `!=`;
- serialise it into a response, whether as the body itself or as a field, shorthand field
  included;
- pass a promise-returning function where the parameter expects a function that returns no
  value. Such a callback's work would silently escape the caller's control, for example a write
  running after the transaction it was meant to be inside.

A server test SHALL NOT pass a promise to an assertion except through `.resolves` or `.rejects`,
so a missed `await` cannot make an assertion pass vacuously.

A documented await-free window (a section of a request handler that relies on no other request
interleaving) SHALL contain no storage call. Data the window needs from storage SHALL be read
before it opens.

#### Scenario: A dropped or misused promise fails the build
- **WHEN** server or catalog-package production code drops a promise-returning call, including one made through a port interface or a local alias, or uses a promise as a condition, a comparison operand or a response value
- **THEN** a repository test fails and names the file and line

#### Scenario: An async callback where no value is expected fails the build
- **WHEN** server or catalog-package production code passes an async function to a parameter typed as a function returning no value, such as a mutation run inside a catalog transaction
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

#### Scenario: A test asserting on an unawaited promise fails the build
- **WHEN** a server test passes a promise-typed value to `expect()` without `.resolves` or `.rejects`
- **THEN** a repository test fails and names the file and line

### Requirement: The SQLite catalog adapter serialises each connection

Until the catalog moves to Postgres (ADR 0021 slice 4), the SQLite adapter SHALL run at most one
transaction at a time on a connection. Every adapter instance on that connection SHALL share one
lock. Root-handle statements and transactions SHALL wait until any open transaction ends, and
SHALL be served in the order they were called.

The adapter SHALL also:
- roll back and release a transaction that runs past its deadline;
- refuse to work on a connection left inside a transaction it did not open;
- after a rollback fails, refuse every later call instead of serving a connection that is still
  inside a transaction.

The catalog stores and `KvStore` SHALL share one instance of this adapter over the catalog
connection, so no statement on that connection bypasses the lock and a key/value call never joins
a catalog transaction.

In a supervised deployment (production and stage), a failed rollback SHALL stop the server with a
non-zero exit status, so its supervisor restarts it.

#### Scenario: Outside statements wait for an open transaction
- **WHEN** a root statement is issued while another transaction is awaiting
- **THEN** it runs only after that transaction ends, and sees its committed writes, or none of them if it rolled back

#### Scenario: Callers are served in call order
- **WHEN** a transaction, a root write and a second transaction are called in that order
- **THEN** their effects apply in that order

#### Scenario: Two adapters on one connection share the lock
- **WHEN** two adapter instances wrap the same connection and one opens a transaction
- **THEN** the other instance's statements wait for it

#### Scenario: A stalled transaction is released
- **WHEN** a transaction body does not settle before the deadline
- **THEN** the transaction rolls back, the caller receives a timeout error, and the next caller proceeds

#### Scenario: A failed rollback stops the adapter
- **WHEN** a rollback fails and the connection is still inside the transaction
- **THEN** the failing call rejects with its own first error, every later or queued call rejects with a broken-adapter error, and none writes to the connection

#### Scenario: A broken connection stops a supervised server
- **WHEN** a rollback fails and the adapter marks its connection broken in a supervised deployment
- **THEN** the server logs the failure at error level and shuts down through its graceful path with a non-zero exit status
