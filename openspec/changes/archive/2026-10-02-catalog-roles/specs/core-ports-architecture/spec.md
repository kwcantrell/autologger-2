## MODIFIED Requirements

### Requirement: Catalog facade exposes only role-scoped stores

The `Catalog` type SHALL expose its domain stores (`shows`, `studios`, `auth`,
`sessions`, `profile`) as its API surface, plus two lifecycle members: `init()`, which loads the
studio registry, and `tx()`, which runs a body on a `Catalog` bound to one catalog transaction,
and three binding members (core-ports-architecture "Every catalog call is bound to a caller"):
`forUser(userId)`, which returns a catalog whose statements run for that signed-in user,
`system(reason)`, which returns a catalog whose statements run for the named system task, and
`unbound()`, which returns a catalog whose every statement is refused. Each binding member SHALL
return a catalog that carries this catalog's studio-registry snapshot without a query. A catalog
from `tx()` SHALL keep the binding of the catalog it was called on. The flat delegate methods that
forward to those stores SHALL be removed, and callers SHALL reach behavior through the store
fields.

#### Scenario: Delegate shim removed
- **WHEN** the catalog facade is inspected
- **THEN** it contains no flat delegate methods (e.g. `getShowRow`, `authGetUserById`) and callers use `catalog.shows.getShowRow(...)` etc.

### Requirement: Port types are interfaces in a dedicated package with app-level composition

The injectable port types (`Clock`, `IdentityVerifier`, `BlobStore`, `KvStore`,
`PresenceRegistry`, `CatalogDb`, and `CatalogRoot`, the unbound catalog adapter that hands out
bound `CatalogDb` handles) and the `Config` type SHALL live in
`@autologger/ports` as **interfaces/types only** — the package SHALL contain no runtime
implementations (`systemClock` lives with the composition root) and SHALL NOT import
from `server/src`, directly or transitively. Concrete implementations SHALL declare
conformance (`implements`) against the package interfaces from their own homes.

The app-env composition (`Ports`, `Variables`, and `AppEnv`) SHALL live in a single
app-level module (`server/src/appEnv.ts`) that composes the packages' types. The former
allowance for that module to name the concrete `SessionHubRegistry` and `Catalog`
classes is **retired**: `appEnv.ts` SHALL name no concrete persistence class —
`Ports.sessions` SHALL be typed as the session-core package's registry facade interface
and `Variables.catalog` as the catalog package's facade interface (the server-wide
concrete-naming and construction rules live in the "Persistence facades are consumed
through package-exported interfaces" requirement). The former `server/src/types.ts`
barrel SHALL remain removed with no permanent re-export shim. The per-request in-place
`env`-mutation identity contract (`@hono/node-ws` upgrade handshake) SHALL be
preserved.

#### Scenario: Ports package is interface-only and closed
- **WHEN** `@autologger/ports` is inspected
- **THEN** it contains no runtime implementations and no import that resolves into `server/src`, and each of the seven port types is an interface or type declaration

#### Scenario: God-barrel stays retired and the concrete-class allowance is gone
- **WHEN** the server source is searched for imports of `server/src/types` and `appEnv.ts` is inspected
- **THEN** no `types.ts` import remains, `server/src/types.ts` does not exist, and `appEnv.ts` names no concrete class — its persistence types are the facade interfaces exported by `@autologger/session-core` and `@autologger/catalog`

#### Scenario: Implementations conform to the package interfaces
- **WHEN** the concrete `BlobStore`, `KvStore`, `PresenceRegistry`, `CatalogRoot` and bound `CatalogDb` classes are inspected
- **THEN** each declares `implements` against its `@autologger/ports` interface, and `auth/identity.ts` imports the `KvStore` interface from the package (not from `node/`)

#### Scenario: WebSocket upgrades still complete after the type move
- **WHEN** a real WebSocket upgrade is driven end-to-end after the change
- **THEN** the upgrade completes and messages are delivered, confirming the env-identity contract survived

### Requirement: Persistence facades are consumed through package-exported interfaces

`@autologger/session-core` SHALL export explicit facade interfaces for the session hub
RPC surface and the hub registry, and `@autologger/catalog` SHALL export a facade
interface for `Catalog` and interfaces for its five stores (`shows`, `studios`, `auth`,
`sessions`, `profile`). Facade membership is determined by consumption, not
convenience: a public member is on a facade **iff** it is reached through
`Ports.sessions` / `Variables.catalog` by at least one consumer outside the package
(production call sites, plus the established integration-test paths — e.g. `evictIdle`
via `env.ports.sessions`). The registry facade surface is exactly `get(sessionId)`
(returning the hub facade), `evictIdle`, and `startSweeper`; coordination internals
(`lastTouchedMs`, `close`, `hasArmedAlarm`, `socketCount` on the hub; `closeAll` and
the hub map/sweeper internals on the registry) SHALL stay off the facades. Facade
interface members SHALL be authored as **property-style function types**
(`m: (args) => R`), not method syntax, so `strictFunctionTypes` checks parameters
contravariantly and drift between class and interface fails `tsc --noEmit`.

Concrete classes SHALL declare `implements` against their facade interfaces. Because
`Catalog` is constructed **per request** (in `middleware/auth.ts`, with `init()`
refreshing the studio registry once per request before registry reads),
`@autologger/catalog` SHALL export a factory (`createCatalog(root: CatalogRoot)` returning
the facade type, unbound until `forUser` or `system` binds it) as the sanctioned construction
path outside the composition root; the per-request construct-then-`init()` lifecycle SHALL be
preserved, with `init()` run on the request's system-bound catalog before the caller is resolved. Outside the
persistence packages themselves, production code SHALL otherwise reference the facade
interfaces only: the composition root (`server/src/node/config.ts`) is the sole production
module that names the concrete classes.

**The enforcing check's walked root SHALL follow the code it governs.** Scoping the walk to
`server/src` alone means that relocating a consumer into a service package **discharges its
obligation by the act of moving** — silently, with no gate objecting and no requirement left
to violate. The walk SHALL therefore cover the service packages' production sources as well as
`server/src`, so a package that consumes persistence is held to the same interface-only rule
it was held to before it became a package. A change that moves a persistence consumer into a
package SHALL widen the walk in the same unit rather than assert the property in a scenario
with no mechanism behind it.

The repo-invariant check that enforces the interface-only rule SHALL defeat the three
bypass classes named here. It SHALL match the package by **specifier prefix**, so a
deep-subpath import that resolves through the packages' `"./*"` export map (e.g.
`@autologger/session-core/SessionHub`) is caught exactly as the bare specifier is. It
SHALL scan **`export … from` re-export clauses as well as `import` clauses**, so a module
cannot launder a concrete identifier by re-exporting it. And it SHALL reject **wildcard
clauses** against those packages outright — `import * as sc from '@autologger/session-core'`
(followed by `sc.SessionHub`) and `export * from '@autologger/session-core'` name no
identifier in the clause at all, so an identifier-matching scan cannot see them, and the
packages' barrels re-export the concrete classes as values; a namespace or star import of
a concrete-bearing persistence package has no legitimate use in consuming production code.

The check is a **textual scan, and its limits SHALL be stated rather than papered over**:
it does not see dynamic `import()` of these packages, `createRequire` loads, laundering
through `server/src/test/**` or through a third package that re-exports, or production
code outside the walked roots. These SHALL be recorded as known residual
bypasses, not implied to be covered. Claiming shape-independent detection that a regex
scan cannot deliver would itself be the failure mode this requirement guards against —
a baseline that the next change inherits as false ground truth.

Because this check is itself being reshaped, and because an assertion that passes on a
clean tree passes equally when the check has become vacuous, it SHALL carry
**synthetic-tree mutation coverage** proving it fires on each rejected shape and does not
fire on compliant code.

#### Scenario: Routers and middleware see interfaces only
- **WHEN** production modules under `server/src/` other than the composition root are searched for imports of the concrete persistence classes (`SessionHub`, `SessionHubRegistry`, `Catalog`, and the five catalog store classes) as values or types
- **THEN** none remain — they import the package-exported facade interfaces (and `middleware/auth.ts` the `createCatalog` factory), and only `server/src/node/config.ts` names the concrete classes

#### Scenario: Interface-only consumption is continuously enforced
- **WHEN** a production file under `server/src/` other than `node/config.ts` imports one of the concrete persistence class identifiers from `@autologger/session-core` or `@autologger/catalog` (tests exempt) and the boundary repo test runs
- **THEN** the test fails — the retirement is enforced by the repo-invariant test, not by one-time inspection

#### Scenario: A service package consuming persistence is held to the same rule
- **WHEN** a production file in a service package imports one of the concrete persistence class identifiers, by bare specifier, deep subpath, re-export clause, or wildcard clause, and the boundary repo test runs
- **THEN** the test fails exactly as it would for a file under `server/src/`, and the walked-root widening is demonstrated by confirming the check reports the violation from the package location — proving the rule was not discharged by the relocation

#### Scenario: Deep-subpath imports do not bypass the enforcement
- **WHEN** a production file under `server/src/` other than `node/config.ts` imports a concrete persistence identifier through a package subpath specifier (e.g. `@autologger/session-core/SessionHub`) rather than the package's bare specifier, and the boundary repo test runs
- **THEN** the test fails, and this negative case is demonstrated once during implementation and recorded in the apply ledger

#### Scenario: Re-export clauses do not bypass the enforcement
- **WHEN** a production file under `server/src/` other than `node/config.ts` re-exports a concrete persistence identifier (`export { SessionHub } from '@autologger/session-core'`) rather than importing it, and the boundary repo test runs
- **THEN** the test fails, and this negative case is demonstrated once during implementation and recorded in the apply ledger

#### Scenario: Wildcard clauses do not bypass the enforcement
- **WHEN** a production file under `server/src/` other than `node/config.ts` uses a wildcard clause against one of those packages — `import * as sc from '@autologger/session-core'` (reaching the class as `sc.SessionHub`) or `export * from '@autologger/session-core'` — and the boundary repo test runs
- **THEN** the test fails on the clause itself, without needing to see the concrete identifier, because a namespace or star import of a concrete-bearing persistence package is a violation by construction

#### Scenario: The check is mutation-covered, not merely green
- **WHEN** the enforcing check is exercised against synthetic file trees rather than only against the live repository
- **THEN** it returns no violation for compliant code (including facade imports such as `SessionHubFacade` and `export type` clauses), and returns a violation for each rejected shape — bare, deep-subpath, `export … from`, and wildcard — so a refactor that renders the check vacuous fails instead of passing silently; no permanent violation fixture is added to the real tree

#### Scenario: Per-request catalog lifecycle preserved
- **WHEN** requests are served after the factory change
- **THEN** each request constructs a fresh catalog facade via `createCatalog` and runs `init()` before registry reads, and the user-bound (or unbound) catalog the routes receive carries that snapshot — request-scoped studio-registry snapshot isolation is unchanged

#### Scenario: Facade conformance is compiler-checked
- **WHEN** a concrete class member drifts from its facade signature — including a **narrowed parameter type** on a facade member
- **THEN** `tsc --noEmit` fails: the facades' property-style function-type members are checked contravariantly under `strictFunctionTypes` (method-syntax bivariance is the reason method syntax is not used)

#### Scenario: Narrowing excludes coordination internals
- **WHEN** the hub and registry facade interfaces are inspected, and a `Ports.sessions`-typed expression references an excluded member
- **THEN** the hub facade excludes at minimum `lastTouchedMs`, `close`, `hasArmedAlarm`, and `socketCount`, the registry facade excludes `closeAll` and internals, and the excluded-member reference fails `tsc --noEmit`

#### Scenario: No passthrough on the facades
- **WHEN** the facade interfaces' member declarations are inspected
- **THEN** no member's declared parameter or return type names a concrete persistence class, a store class, the registry, or `better-sqlite3`'s `Database` — the facades cannot hand out concrete handles

#### Scenario: Behavior reachable through the app is unchanged
- **WHEN** the full server test suite and the frozen-surface conformance fixtures run after the interface narrowing and factory introduction
- **THEN** they pass unchanged — no HTTP/WS-observable behavior differs

### Requirement: The Postgres catalog adapter

A Postgres implementation of the catalog port SHALL meet "The catalog transaction contract",
proven by the catalog transaction contract test suite. That suite SHALL include a
statement the body starts without awaiting: if it fails, the transaction fails.

Bindings (ADR 0021 slice 6b-1):
- the adapter itself SHALL offer no statement or transaction method; it SHALL hand out handles
  bound to a user (`catalog_user`, with that user's id) or to a named system task
  (`catalog_system`, with no user id), which share its connections;
- binding to an empty or non-string user id, or to a reason that is not a short lowercase
  identifier (`[a-z][a-z0-9-]*`), SHALL throw at once;
- every transaction of a bound handle SHALL, right after it begins and before the body's first
  statement, switch to the handle's role and set its user id (or clear it) for that transaction
  only, and SHALL do so again on every run after a retry;
- the role and user id SHALL be sent pipelined with the transaction's begin, without waiting for
  the begin's reply, so a binding adds no round trip;
- the adapter SHALL NOT change the role or the user id for longer than one transaction, and a
  connection SHALL serve another call only after its transaction was confirmed committed or
  rolled back, so no role or user id carries over to the next caller;
- a permission error from the database (`42501`) SHALL reach the caller as a distinct forbidden
  error that names the table and the binding's kind and reason (never the user id), is never
  retried, and fails a transaction it occurs in.

Statements:
- it SHALL accept the `?` placeholders the catalog stores use, and leave quoted text and comments
  unchanged;
- it SHALL return 64-bit integer values as numbers;
- `run()` SHALL return the affected-row count;
- a statement with a text parameter containing U+0000 (NUL) SHALL be refused with a distinct
  invalid-text error before it is sent; inside a transaction, that refusal fails the transaction.

Transactions:
- every transaction started with `tx()` SHALL run at the `SERIALIZABLE` isolation level (a
  statement outside one runs as a short `READ COMMITTED` transaction, core-ports-architecture
  "Root catalog statements are time-bounded");
- a transaction that fails on a serialization failure or a deadlock SHALL roll back and run its
  body again, at most five runs in total. The caller SHALL then receive the last serialization
  error;
- before running the body again after its `n`th run, the adapter SHALL wait a random delay of at
  least 0 and less than `20 × 2^(n−1)` milliseconds, holding no connection while it waits and
  never waiting past the transaction's deadline. If the deadline has passed when a run would
  start, the caller SHALL receive the timeout error, with no statement sent;
- no other failure SHALL be retried;
- because a body may run more than once, a transaction body SHALL have no effect outside the
  catalog database;
- a transaction SHALL resolve only when the server confirms its commit;
- when a commit's reply never arrives, the caller SHALL receive a distinct "outcome unknown"
  error, and the adapter SHALL NOT retry or roll back after it.

Time:
- one deadline SHALL cover the whole transaction: waiting for a connection, every run, and the
  commit;
- when the deadline passes, any statement in flight SHALL be cancelled, the transaction SHALL end
  on the server, and the caller SHALL receive a timeout error;
- no step SHALL wait on the server without a bound.

Connections:
- transactions and root statements SHALL each run on adapter-owned single-connection clients
  (the transaction connections and the root connections), never on a connection lent out by a
  shared pool;
- a connection SHALL serve another transaction only after its previous transaction was confirmed
  committed or rolled back, with no cancel pending;
- any other connection SHALL be closed and replaced;
- after a transaction's connection is lost, no statement of that transaction SHALL be sent
  anywhere, and the process SHALL keep running.

Sharing:
- in the server, the catalog stores and the key/value store SHALL share one instance of this
  adapter, and a key/value call SHALL never join a catalog transaction.

Closing:
- the adapter SHALL have an asynchronous `close()`;
- after `close()`, waiting and new calls SHALL reject, no connection SHALL be opened, and
  `close()` SHALL resolve once the adapter's connections have closed.

#### Scenario: The shared contract holds on Postgres
- **WHEN** the catalog transaction contract suite runs against a user-bound and against a system-bound handle of the Postgres adapter, logged in as the app's least-privilege role
- **THEN** every case passes

#### Scenario: A dropped failing statement fails the transaction
- **WHEN** a transaction body starts a write that violates a unique key without awaiting it, and returns
- **THEN** the caller receives the unique-violation error, and no write persists

#### Scenario: Concurrent read-modify-write transactions both commit
- **WHEN** two transactions read the same row, both wait until each has read it, and then each increments it
- **THEN** both calls resolve, the row has been incremented twice, and the bodies ran three times in total

#### Scenario: Retries are bounded and selective
- **WHEN** a body hits a serialization failure on every run, or a deadlock on its first run only, or a unique violation
- **THEN** its body runs exactly five times and the caller receives the serialization failure; or runs twice and commits; or runs once and the caller receives the unique violation

#### Scenario: Contending writers back off and all commit
- **WHEN** eight transactions concurrently read and then increment the same row
- **THEN** all eight commit and the row has been incremented eight times

#### Scenario: A backoff that reaches the deadline times out without another run
- **WHEN** a transaction's backoff wait ends at or after its deadline
- **THEN** the caller receives the timeout error, no statement of a new run is sent, and no connection is taken or opened for it

#### Scenario: A stalled statement is cancelled at the deadline
- **WHEN** a transaction's statement is still running at the deadline
- **THEN** the caller receives a timeout error promptly, the server session running it ends within seconds, none of the transaction's writes persist, and the next transaction commits

#### Scenario: A queued transaction times out cleanly
- **WHEN** every transaction connection is busy and a waiting transaction reaches its deadline
- **THEN** it receives a timeout error, and once the busy transactions end, as many new transactions as there are connections all commit

#### Scenario: A lost connection leaks nothing
- **WHEN** a transaction's server connection is terminated while its body is awaiting, and the body then issues another write
- **THEN** that write is refused without being sent, the transaction rejects, no write of the transaction persists, the process keeps running, and later transactions, more than the adapter's concurrent-transaction limit, all commit

#### Scenario: A commit with no reply is reported as unknown
- **WHEN** the connection is lost, or the time bound passes, after the commit was sent and before its reply
- **THEN** the caller receives the outcome-unknown error, no rollback or retry is attempted, and that connection is replaced

#### Scenario: An unconfirmed rollback retires the connection
- **WHEN** a rollback on a transaction's connection fails
- **THEN** that connection is closed and replaced, and the next transaction runs on the replacement

#### Scenario: Closing with work in flight
- **WHEN** `close()` is called while one transaction runs and another waits for a connection
- **THEN** the running one settles, the waiting one rejects, and no connection of the adapter remains on the server once `close()` resolves

#### Scenario: Placeholders and integers
- **WHEN** a statement contains a `?` inside a quoted string and one outside it, and selects a row count
- **THEN** only the outer `?` is bound, and the count is a number

#### Scenario: NUL text is refused before it is sent
- **WHEN** a statement binds a string containing NUL, at the root or inside a transaction
- **THEN** the call rejects with the invalid-text error, no statement is sent for it, and a transaction it was part of writes nothing

#### Scenario: A bound handle runs as its role
- **WHEN** a handle bound to user `u-1` and a handle bound to the system task `test` each select
  `current_user` and `catalog.app_user_id()`, once outside a transaction and once inside one
- **THEN** the user handle reads `catalog_user` and `u-1` both times, and the system handle reads
  `catalog_system` and null both times

#### Scenario: A retry re-applies the role
- **WHEN** a user-bound transaction hits a serialization failure on its first run and commits on
  its second
- **THEN** the second run also reads `catalog_user` and the user's id

#### Scenario: No role carries over to the next caller
- **WHEN** user-bound and system-bound transactions and statements commit, roll back and fail on
  the adapter's connections, and then each connection is inspected directly
- **THEN** every connection reports `current_user` `autologger_app` and no user id

#### Scenario: A permission error is a distinct error
- **WHEN** a bound statement is refused by the database with `42501`
- **THEN** the caller receives the forbidden error naming the table and the binding's kind and
  reason, not the user id, and a transaction it was part of rolls back without a retry

#### Scenario: A malformed binding is refused
- **WHEN** a handle is bound to an empty user id, or to the reason `Not A Reason`
- **THEN** the binding throws, and no connection is used

### Requirement: Root catalog statements are time-bounded
A catalog statement outside a transaction SHALL run as its own short transaction at the
`READ COMMITTED` isolation level, on one of the adapter's root connections (single-connection
clients it owns, separate from the transaction connections): it begins, switches to the
handle's role and user id (core-ports-architecture "The Postgres catalog adapter", Bindings),
runs the one statement, and commits, or rolls back if the statement fails. The begin, the role
and user id, the statement and the commit SHALL be sent pipelined, without waiting for a reply in
between. It SHALL NOT be retried, and it SHALL NOT be run at `SERIALIZABLE`.

It SHALL resolve only after the server confirms the commit. A commit that fails (a deferred
constraint, for example) SHALL reject the call with that error, and none of its write persists.

It SHALL reject with a timeout error when it hasn't completed within the adapter's root deadline
(5 seconds by default), including any time spent waiting for a root connection. Each root
connection SHALL carry one such transaction at a time.
- A statement that times out before its transaction was sent SHALL be withdrawn and SHALL never
  run.
- For one already sent, the adapter SHALL NOT send a cancel; the role's statement and
  idle-in-transaction timeouts end it on the server. Such a write may still apply after the
  caller's timeout, so its outcome is unknown, and the adapter SHALL NOT retry it.
- The timeout error SHALL expose when the statement's transaction has ended on the server (or its
  connection was closed), so a caller that orders its writes can wait for it.
- A root connection SHALL serve another call only after its transaction was confirmed committed
  or rolled back. When its connection is lost, or its commit's reply does not arrive within
  the adapter's bound (the root deadline, or for a call already timed out, the role's timeouts
  plus a grace), the call SHALL reject, nothing more SHALL be sent on that connection, the connection
  SHALL be closed and replaced, and the process SHALL keep running.

#### Scenario: A paused database
- **WHEN** a root statement is sent while the database does not answer
- **THEN** the caller receives the timeout error within about the root deadline, and later statements succeed once the database answers

#### Scenario: A root statement is one short transaction
- **WHEN** a bound handle runs one statement outside a transaction, once successfully and once
  with a statement that fails with a unique violation
- **THEN** each runs inside its own `READ COMMITTED` transaction under the handle's role, the
  first commits, the second rolls back and rejects with the unique violation after one run, and
  neither is retried

#### Scenario: A root statement resolves only after its commit
- **WHEN** a bound handle runs, outside a transaction, an insert whose deferred foreign key fails
  at commit
- **THEN** the call rejects with the foreign-key violation, and the row does not exist

#### Scenario: A lost root connection is replaced
- **WHEN** the server connection of a root statement's transaction is terminated while the
  statement runs, and another root statement follows
- **THEN** the first call rejects, the process keeps running, the connection is replaced, and the
  second call succeeds on a fresh connection outside any transaction

#### Scenario: A root commit with no confirmation never reaches another caller
- **WHEN** a root statement's commit fails, or its reply never arrives, and later root statements
  run
- **THEN** the first call rejects, its connection is closed and replaced, and no later statement
  runs inside its transaction or under its role

## ADDED Requirements

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
OAuth state, the Companion's last command and the expiry purges), `session-mirror`,
`log-import-job`, `oauth-callback`, `bootstrap-claim`, `support-plane` (`/api/admin/*`),
`companion-token` (token-only Companion calls), `access-loss-check`, `team-invite` and
`team-create`.

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
