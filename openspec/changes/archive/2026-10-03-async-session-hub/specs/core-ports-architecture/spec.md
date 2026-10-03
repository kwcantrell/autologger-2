## ADDED Requirements

### Requirement: Session runtime is an asynchronous, per-session serialized, substitutable port

The session spine SHALL depend on a `SessionRuntime` port exposing SQL, socket fan-out, an
alarm/scheduler, and a clock — as an **interface**, so a fake runtime can be supplied in tests
without touching `SessionCore`. The port's normative home is `@autologger/session-core`
(alongside `SessionCore`), not `@autologger/ports` — it is the session package's internal
substitution seam, consumed by the package's stores and by test fakes, and moving it to L0 would
drag session-internal types into the ports package for no consumer benefit.

The SQL seam SHALL be asynchronous: `all()`, `run()` and `exec()` return promises, and `tx()`
passes its body a handle scoped to the transaction, with the same interface. A `tx()` called on
that handle SHALL join the enclosing transaction. A transaction SHALL be all-or-nothing: any
error inside it — a statement error, a joined body's error, or the body's own error, even one the
body catches — SHALL roll it back and reject with the first error. A handle used after its
transaction ended SHALL reject. Only the adapter wraps a synchronous database call in a promise.

The hub's storage operations SHALL return promises; its socket operations (attach, detach, relay a
command, close a user's sockets) SHALL stay synchronous. Whatever the mechanism, the session hub
SHALL guarantee these observables:
- **No dirty or lost reads:** no read SHALL observe a write that is not yet committed or that
  later rolls back.
- **Atomic mutations:** every mutating operation SHALL run in one transaction, and every
  read-then-write sequence whose outcome depends on what it read (an anchored insert, a recording
  ordinal and the segment that uses it, a take toggle, an event update that merges the stored
  metadata, a transcript replace remapped against the session's recording anchors, a
  duplicate-checked imported event) SHALL be one hub operation, so concurrent requests produce a
  result some serial order of them would produce.
- **Broadcast order:** a session's `*.changed` broadcasts SHALL be sent only after the
  transaction that issued them commits, in the order the session's transactions committed and,
  within one transaction, in the order issued; a transaction that fails SHALL send none of them.
  A broadcast issued outside the session's transaction (a relayed Companion command) SHALL be sent
  at once and SHALL NOT be held or dropped by a transaction it does not belong to.
- **No self-deadlock:** a storage operation called from inside an open transaction of the same
  session's hub SHALL reject promptly instead of waiting for that transaction.
- **No obscure failure on a closed hub:** an operation on a hub that has been closed SHALL reject
  with an error naming the closed hub, which the routes answer with their existing generic server
  error.

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
- **THEN** that call rejects promptly, with no deadlock, and a call on another session's hub succeeds

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

#### Scenario: SQL seam exposes a domain shape, not the Durable Object cursor API
- **WHEN** the session SQL seam is inspected
- **THEN** it exposes promise-returning `all(sql, ...binds)` returning rows, `run(sql, ...binds)` returning an affected-row count (`{ changes }`) and `tx(fn)`, and does not expose the `exec() → { toArray(), rowsWritten }` cursor shape

#### Scenario: run() preserves change-detection for its readers
- **WHEN** `setAudioSegmentWaveform`, `deleteTopic`, or `deleteTranscriptWord` runs against a non-existent id
- **THEN** it observes zero affected rows and returns the "not found" result, so the routers still respond `404` and no `audio.changed` broadcast fires on a no-op write

#### Scenario: Schema init retains a multi-statement path
- **WHEN** `initSchema` executes multi-statement DDL
- **THEN** a distinct `void`-returning multi-statement `exec` path serves it, separate from the `all`/`run` seam

#### Scenario: SessionCore is testable with a fake runtime
- **WHEN** a test constructs `SessionCore` with an in-memory SQL + fake sockets + fake clock
- **THEN** it exercises the domain stores without a real database, socket, or wall-clock

#### Scenario: Responses and frames are unchanged for serial requests
- **WHEN** the existing route, WebSocket and companion test suites run after the hub becomes asynchronous
- **THEN** they pass with no change to expected status codes, bodies, headers or frames

## MODIFIED Requirements

### Requirement: Persistence facades are consumed through package-exported interfaces

`@autologger/session-core` SHALL export explicit facade interfaces for the session hub
RPC surface and the hub registry, and `@autologger/catalog` SHALL export a facade
interface for `Catalog` and interfaces for its five stores (`shows`, `studios`, `auth`,
`sessions`, `profile`). Facade membership is determined by consumption, not
convenience: a public member is on a facade **iff** it is reached through
`Ports.sessions` / `Variables.catalog` by at least one consumer outside the package
(production call sites, plus the established integration-test paths — e.g. `evictIdle`
via `env.ports.sessions`). The registry facade surface is exactly `get(sessionId)`
(returning a promise that resolves to the opened hub facade), `evictIdle`, and `startSweeper`,
plus the synchronous `closeUserSockets`; the hub facade's storage members return promises and
its socket members stay synchronous; coordination internals
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


### Requirement: AI tool bodies consume the session facade directly; no tool port is interposed

The AI runtime's MCP tool bodies SHALL obtain session data through
`@autologger/session-core`'s exported `SessionHubRegistryFacade`, resolving the hub **at call
time**, inside the tool body, and never from a reference captured when the turn was registered.
Within one tool invocation the body MAY use the hub it resolved across that hub's own awaited
operations; it SHALL NOT keep the reference beyond the invocation. No intermediate "session tool
port" SHALL be interposed between the tool bodies and that facade.

This is a decision, not an omission. An earlier change deferred such a port so its surface
could be cut against a real consumer rather than speculatively, and named the change that
packages the AI runtime as its owner. That consumer was removed as superseded before this
change ran, and none replaced it; the reason to defer is therefore stronger, not weaker. A
service package importing an L1 persistence facade is an ordinary allowed edge, so extraction
never required the port. The deferral is recorded **here**, in the durable baseline, because
its previous home was a design document that does not survive archive — leaving a promise
whose named owner had come and gone.

Should a future change interpose such a port, the binding study recorded in the
`package-split-foundation` change's design SHALL be **re-derived against the code as it then
stands** rather than adopted as written. Freezing a study's conclusions as durable law for a
seam nobody has built is how a baseline goes stale silently; the study's value is its
reasoning, not its conclusions.

The facade-consumption half of this requirement is enforced by the interface-only-consumption
check, whose walked root covers the service packages. The call-time-resolution half is **not
machine-checked** and is verified by review.

#### Scenario: Tool bodies resolve the hub at call time through the facade

- **WHEN** the AI runtime's MCP tool bodies are inspected
- **THEN** each obtains its hub by awaiting the injected registry facade's getter inside the tool body, uses that reference only for the invocation's own hub operations, and none keeps a hub reference from the turn's registration or from an earlier invocation

#### Scenario: The deferral is legible from the baseline alone

- **WHEN** a reader inspects the durable baseline for whether a session tool port exists
- **THEN** the absence is stated as a decision with its reason and its re-derivation requirement, rather than being inferable only from the absence of a requirement

### Requirement: Server code never drops or misuses a promise

Production code under `server/src`, `packages/catalog/src`, `packages/session-core/src`, and the
hub-calling packages `packages/log-import/src`, `packages/transcription/src` and
`packages/ai-runtime/src` SHALL NOT leave a promise unconsumed. Every promise-returning
call SHALL be awaited, returned, or explicitly discarded with `void`.

No code SHALL:
- use a promise as a condition, negate it, or compare it with `===`, `!==`, `==` or `!=`;
- serialise it into a response, whether as the body itself or as a field, shorthand field
  included;
- pass a promise-returning function where the parameter expects a function that returns no
  value. Such a callback's work would silently escape the caller's control, for example a write
  running after the transaction it was meant to be inside.
- return a promise without `await` from inside a `try` block that has a `catch` or `finally`.
  The `finally` (or the catch's protection) would run before the promise settles, for example
  releasing a lock before the write it guards has committed.

A server or session-core test SHALL NOT pass a promise to an assertion except through
`.resolves` or `.rejects`, so a missed `await` cannot make an assertion pass vacuously.

A documented await-free window (a section of a request handler that relies on no other request
interleaving) SHALL contain no storage call. Data the window needs from storage SHALL be read
before it opens.

#### Scenario: A dropped or misused promise fails the build
- **WHEN** production code in any of the scanned roots drops a promise-returning call, including one made through a port interface, the session hub facade or a local alias, or uses a promise as a condition, a comparison operand or a response value
- **THEN** a repository test fails and names the file and line

#### Scenario: An async callback where no value is expected fails the build
- **WHEN** production code in any of the scanned roots passes an async function to a parameter typed as a function returning no value, such as a mutation run inside a catalog transaction
- **THEN** a repository test fails and names the file and line

#### Scenario: Event-generation word snapshot stays await-free
- **WHEN** `POST /api/sessions/{id}/events/generate` takes its transcript word snapshot
- **THEN** once the snapshot read has resolved, no storage call or other `await` occurs before the per-session AI slot is acquired, and the show's categories were read before the snapshot

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
- **WHEN** a server or session-core test passes a promise-typed value to `expect()` without `.resolves` or `.rejects`
- **THEN** a repository test fails and names the file and line

#### Scenario: Every scanned root is actually scanned
- **WHEN** the promise-hygiene repository test runs
- **THEN** it fails unless its scanned files include the session hub, the session core, the log-import runner, the transcript generator and the AI runtime's MCP server

#### Scenario: A promise returned from inside try without await fails the build
- **WHEN** production code in any of the scanned roots writes `return somePromise` inside a `try` block that has a `catch` or `finally`
- **THEN** a repository test fails and names the file and line, and `return await somePromise` passes

## REMOVED Requirements

### Requirement: Session runtime is a synchronous, substitutable port

**Reason**: The session hub becomes asynchronous (ADR 0021 slice 7a) so that slice 7b can move
the session tables to Postgres, where every statement is I/O. A synchronous port and zero-`await`
hub bodies cannot survive that move.

**Migration**: Replaced by "Session runtime is an asynchronous, per-session serialized,
substitutable port", which keeps the substitutable `SessionRuntime` seam, its domain-shaped SQL
surface, the multi-statement `exec` path, change detection through `run()` and the fake-runtime
testability, and replaces "zero `await`, one synchronous transaction" with per-session
serialization and an explicit transaction contract.
