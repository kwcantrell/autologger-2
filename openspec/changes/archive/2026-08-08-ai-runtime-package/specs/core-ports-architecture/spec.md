## MODIFIED Requirements

### Requirement: Wall-clock time is read through a single Clock port

Every decision-making time read SHALL obtain the current time from a single injected
synchronous `Clock` port rather than calling `Date.now()` directly — covering
recording-lease staleness/expiry and alarm scheduling, session live-timecode derivation,
key/value TTL expiry (login sessions, OAuth CSRF), Companion presence freshness, the
identity JWKS cache TTL, the log-import job store's terminal-job TTL and finished-at
stamping, and the AI runtime's process-group kill-ladder deadline. The lease **alarm
scheduler and the clock SHALL share one time base**, so an alarm scheduled from clock time
and an expiry check reading clock time cannot diverge (no real-`setTimeout`-vs-fake-clock
skew).

A time read that falls **outside every class enumerated above**, and on which no control
flow, expiry decision, ordering, or persisted state depends, is not a decision-making read
and **need not** be converted to the port. Such a value MAY be rendered in a message or
serialized into a response field. Establishing that a read is of this kind SHALL require
reading every consumer of the value, not only its producer, and each such read SHALL be
**named in the delta of the change that establishes it** — recording the reasoning only in a
design document does not survive archive. This exemption never narrows the enumeration
above: a read that serves live-timecode derivation, lease or TTL expiry, freshness, or alarm
scheduling remains covered even where its computed result is only serialized.

`transcriptGenerationLock.tryAcquire`'s `startedAtMs` is such a read: the lock never expires
by time and is cleared in a `finally`, nothing branches on the value, and it is serialized
as the frozen `started_at` field — which makes converting it a contract risk taken for no
requirement.

**One** `Date.now()` site is a known standing exception: `SessionHub`'s `DEFAULT_CLOCK`
fallback in package production code, which never fires on the production path and is
deliberately local so the hub does not depend on the composition root. The AI runtime's
process-group kill ladder — previously recorded here as a second standing exception, owned by
the change that packages the AI runtime — is **discharged by that change** and is no longer an
exception.

**A `Clock` injected into a path that must not throw SHALL be a required parameter, not an
optional field on an options object.** The kill ladder's entry point is documented as never
throwing, and it is awaited inside `finally` blocks whose *remaining* statements release a
concurrency slot, abandon pending questions, dispose an MCP turn token, and delete a directory
holding copied operator credentials. A throw there leaks a slot for the process lifetime,
leaves a turn token valid, orphans a process group, and escapes as a `500` on an otherwise
successful request. An optional clock makes a missed construction site typecheck; a required
one makes it a compile error. The entry point SHALL remain total.

Where a `Clock` is injected into a loop that also **sleeps**, the sleep SHALL be controlled by
the same test-time mechanism as the clock. `Clock` exposes `now()` only, so a polling loop
whose deadline reads an injected clock while its sleep uses a real timer will, under a fake
clock that never advances, spin forever rather than fail — converting a would-be assertion
failure into a hung suite, in **existing** tests as well as new ones. Injecting a clock into
such a loop without also controlling its sleep is half a seam and SHALL NOT be described as
complete.

#### Scenario: A named exemption is recorded where it survives
- **WHEN** a change declines to convert a time read on the grounds above
- **THEN** the delta spec names the read and the property that exempts it, so a later reader inspecting the durable baseline can distinguish an examined exemption from an overlooked violation

#### Scenario: Lease expiry is deterministic through the hub
- **WHEN** a test claims a lease, advances a fake clock past the stale threshold, and triggers expiry through the hub
- **THEN** the lease is freed without any real time passing, and the alarm neither busy-refires nor fails to fire

#### Scenario: TTL and freshness are testable without real elapsed time
- **WHEN** a test advances a fake clock past a KV entry's TTL (or the presence freshness window, or the JWKS cache TTL)
- **THEN** the entry is treated as expired/stale without any real time passing

#### Scenario: No decision-making Date.now() remains
- **WHEN** the server source **and the workspace packages under `packages/`** are inspected for direct `Date.now()` calls in staleness, TTL, expiry, freshness, alarm-scheduling, live-timecode, or process-kill-deadline logic
- **THEN** none remain; those paths read the injected `Clock` (the `systemClock` implementation, which lives with the composition root, is the sole sanctioned `Date.now()` site **for decision-making reads**; `SessionHub`'s `DEFAULT_CLOCK` is the only other)

#### Scenario: The kill ladder's deadline is deterministic and its sleep is controlled
- **WHEN** a test drives the process-group kill ladder against a group that does not exit, with both the injected clock and the poll's sleep under test control
- **THEN** the SIGTERM→SIGKILL escalation occurs exactly when the injected clock passes the grace deadline, without real elapsed time, and the test terminates rather than hanging

#### Scenario: Existing ladder tests survive the injection
- **WHEN** the pre-existing kill-ladder tests that drive a genuinely live process group are run after the clock is injected
- **THEN** each terminates and asserts the same escalation behavior as before — a mechanical substitution of a frozen fake clock that leaves the poll's real timer in place is not an acceptable conversion, and any test-scoped timer control is scoped so that helpers awaited *before* the code under test are not themselves stalled

#### Scenario: The kill ladder entry point remains total
- **WHEN** the process-group kill entry point and its callers are inspected after the clock is threaded
- **THEN** the clock is a required parameter at every level rather than an optional options field, the entry point has gained no path that throws, and the `finally` blocks that await it still run their remaining cleanup statements

#### Scenario: Job lifecycle expiry is testable without real elapsed time
- **WHEN** a test creates log-import jobs through the injected clock, drives some to a terminal status, advances the clock past the terminal-job TTL, and then reads a job back
- **THEN** the expired terminal jobs are pruned and the jobs that are still queued or running survive, without any real time passing

#### Scenario: Size-cap eviction is unchanged and reads no time
- **WHEN** the job store exceeds its size cap
- **THEN** eviction removes terminal jobs in map insertion order and never a queued or running job — behavior that depends on no time value and is exercised by exceeding the cap rather than by advancing a clock

#### Scenario: Job status observed through the app is unchanged
- **WHEN** a log-import job is created, progresses, and reaches a terminal status through the real app after the clock is injected
- **THEN** the status endpoint's JSON shape, status codes, and creator-scoping behavior are identical to before the change, and no job time value is observable on the wire (`systemClock` reads the same source the direct call did)

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
`@autologger/catalog` SHALL export a factory (`createCatalog(db: CatalogDb)` returning
the facade type) as the sanctioned construction path outside the composition root; the
per-request construct-then-`init()` lifecycle SHALL be preserved exactly. Outside the
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
- **THEN** each request constructs a fresh catalog facade via `createCatalog` and runs `init()` before registry reads, exactly as `new Catalog(db)` + `init()` did — request-scoped studio-registry snapshot isolation is unchanged

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

## ADDED Requirements

### Requirement: Host-environment discovery belongs to the composition root

A service package SHALL **receive** its deployment configuration rather than discover it from
the host environment. Translating a host environment into configuration values — probing
`PATH` for an executable, or resolving a path under the operating user's home directory —
is the composition root's defining job, SHALL be performed in the composition root's binding
construction, and the resolved value SHALL be carried on `Config` and passed to the service.
The composition root decides *where*; the service decides *what to do with it*.

Accordingly, the AI runtime's design-turn credential seeding SHALL receive the credential
source path as a parameter rather than computing it from the operating user's home directory.
That path SHALL be a **required** `Config` field and SHALL have **no environment override**.
Both constraints are load-bearing rather than stylistic: an override would turn the field into
an arbitrary-file-read primitive, since the value names a file copied into a subprocess's
configuration directory; and an optional field invites a defensive early return that silently
disables the login-credential fallback, degrading a working design turn into a scrubbed
authentication error with nothing to notice it.

This requirement is **declaration of intent for new and relocated code, not a sweep**, and
the reads it does not close SHALL be named here rather than left to be rediscovered as
violations. Two residual classes stand, covering three reads:

- **Child-process environment builders** that accept an injected process-environment map and
  fall back to the ambient one — `@autologger/ai-runtime`'s AI-chat and Agent-SDK spawn paths,
  and `@autologger/media-import`'s yt-dlp path. The fallback survives because the whitelist
  these builders compute is derived from the **raw host environment**: closing it means either
  plumbing that raw map from the composition root through the app — relocating the read rather
  than removing it — or moving whitelist computation from per-turn to boot, which changes when
  the environment is sampled. Neither buys the property this requirement is about.
- **Scratch-directory allocation** derived from the platform temporary directory, in
  `@autologger/ai-runtime`'s AI-chat working-directory root and its design-turn working and
  configuration directories. The platform temporary directory is environment-derived, so it
  falls inside this requirement's forbidden class as stated; it is nonetheless a residual
  rather than a violation to close, because what is being located is **ephemeral scratch space
  the service itself creates and deletes**, not a fact about where the deployment keeps its
  data. Naming it is required precisely because the distinction is arguable.

A change that adds or relocates a host-environment read into a service package SHALL either
close it or add it to this list.

#### Scenario: The credential source path arrives as a required parameter

- **WHEN** the production sources of `@autologger/ai-runtime` are inspected for reads of the operating user's home directory
- **THEN** none remains; the credential-seeding function takes the source path as a parameter, the composition root resolves it into a required `Config` field with no environment override, and the router passes it at the single call site

#### Scenario: A login-fallback design turn still finds operator credentials

- **WHEN** a design turn runs through the real app with no workspace API key configured, on a loopback bind, with an operator credential file present at the composition-root-resolved path
- **THEN** the credential file is copied into the turn's isolated configuration directory exactly as before, and a turn with a configured key still copies nothing — characterized through the router before the seam is reshaped, because this path has no test coverage today and an optional-field regression would be silent

#### Scenario: Named residuals are legible from the baseline

- **WHEN** a change leaves a host-environment read inside a service package
- **THEN** its delta names the read and the property that prevents closing it, and the read appears in this requirement's residual list — so a later reader can distinguish an examined residual from an overlooked violation without consulting a design document

### Requirement: AI tool bodies consume the session facade directly; no tool port is interposed

The AI runtime's MCP tool bodies SHALL obtain session data through
`@autologger/session-core`'s exported `SessionHubRegistryFacade`, resolving the hub **at call
time** rather than holding it across an `await`. No intermediate "session tool port" SHALL be
interposed between the tool bodies and that facade.

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
- **THEN** each obtains its hub by calling the injected registry facade's getter inside the tool body, and none holds a hub reference across an `await`

#### Scenario: The deferral is legible from the baseline alone

- **WHEN** a reader inspects the durable baseline for whether a session tool port exists
- **THEN** the absence is stated as a decision with its reason and its re-derivation requirement, rather than being inferable only from the absence of a requirement
