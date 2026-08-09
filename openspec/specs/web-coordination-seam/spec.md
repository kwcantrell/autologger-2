# web-coordination-seam

## Purpose

The web app's mechanism for one-to-one cross-component coordination — a call from one
component to a single other component that owns the capability, such as an audio player
being told to seek, a transport being told to stop, or a timeline being scrolled to a
point. All such coordination travels through a single typed registry module that is the
sole declaration site for every handle's name and signature, exposing each handle to
callers as an exported, typed function so callers never need to know which component
owns it. The registry enumerates exactly seven handles (`seekAudio`,
`seekAudioAndPlay`, `stopTransportIfNeeded`, `setManualScrubSec`, `scrollTimelineToSec`,
`getTimelineZoom`, `invalidateEvents`); growing that list requires an authorizing
change. It replaced an earlier mechanism built on ad hoc `window`-global assignment,
and this capability's rules exist to keep that pattern from reappearing: registration is
explicit and reversible, absence of an owner is always a safe no-op (never a fabricated
default), ownership is observable and identity-scoped at teardown so a stale owner can
never clobber a newer one, and the registry is usable from React-external callers —
including synchronous module-scope code that must observe a call's effect before React
re-renders. `Window` augmentation and global-object coordination writes are banned
outright across `web/src`, not merely for the seven enumerated handles. The capability
also covers the web app's internal import-direction rule — production value imports
flow only `pages → api → shared`, and the `admin-users` and `index` page bundles never
import from each other — and requires that every check enforcing either rule prove
itself non-vacuous (self-locating walked root, non-zero file count asserted, a mutation
pair showing it fires on a violation and passes on conforming input).

## Requirements

### Requirement: One-to-one coordination has a single typed module home

**One-to-one request/response coordination** — a call from one component to a single other
component that owns the capability — SHALL travel
through a single registry module that declares the full contract in one place. That module SHALL
be the only declaration site for every handle's name and signature, and SHALL expose each handle
to callers as an exported, typed function. Callers SHALL NOT need to know which component owns a
handle.

**The registry holds exactly these seven handles:** `seekAudio`, `seekAudioAndPlay`,
`stopTransportIfNeeded`, `setManualScrubSec`, `scrollTimelineToSec`, `getTimelineZoom`, and
`invalidateEvents`. An eighth requires an authorizing change. This enumeration is the control
against silent accumulation: a handle that merely *has a caller* is not thereby justified — the
standard is that no simpler mechanism (a prop, a context already in scope, a client the caller
already holds) would serve.

This requirement governs one-to-one coordination only. It deliberately does **not** reach
broadcast-shaped coordination via custom DOM events, React context, imperative refs, or a shared
query client — all of which are live, legitimate, and outside this capability.

No file under `web/src` — production or test — SHALL contain a `declare global` block augmenting
the `Window` interface. A future need for one requires an authorizing change. This absolute form
is deliberate: a rule scoped to "coordination handles" can only enforce the names it was given,
so an eleventh handle would evade it silently.

#### Scenario: The contract has exactly one declaration site

- **WHEN** the web source is searched for a handle's name
- **THEN** its type is declared in exactly one module

#### Scenario: No `Window` augmentation exists anywhere under web/src

- **WHEN** every production and test file under `web/src` is scanned for `declare global` blocks
  augmenting `interface Window`
- **THEN** there are zero occurrences

#### Scenario: The retired globals are undefined at runtime

- **WHEN** the application has mounted and the owning components' effects have run
- **THEN** `AutoLogger_seekAudio`, `AutoLogger_seekAudioAndPlay`,
  `AutoLogger_stopTransportIfNeeded`, `AutoLogger_setManualScrubSec`,
  `AutoLogger_scrollTimelineToSec`, `AutoLogger_getTimelineZoom`,
  `AutoLogger_invalidateEvents`, `AutoLogger_closeSettingsModal`, `Home_reloadSessionList`,
  and `Home_clearSessionList` are each absent from `window`

#### Scenario: No coordination handle is reintroduced on the global object by any route

- **WHEN** the web source is scanned for writes to a global-object property that is not a known
  platform builtin — including `window.X`, `globalThis.X`, bracket access, aliased references,
  `Object.assign`, `Object.defineProperty`, and `declare global { var X }` with bare-identifier
  assignment
- **THEN** no such write exists in production or test code, including for a handle name this
  capability does not enumerate

### Requirement: Registration is explicit, reversible, and absence is a no-op

An owning component SHALL register a handler for a handle by an explicit call, not by assignment
to a shared mutable object reachable by name from unrelated code, and SHALL unregister it when
the owner tears down.

Invoking a handle with no registered handler SHALL be a silent no-op and SHALL NOT throw. A
value-returning handle SHALL yield an explicit "not available" result — never a fabricated
default — so a caller can distinguish "no owner mounted" from a genuine value. A caller's own
fallback policy SHALL remain in the caller.

Registering while a handler is already registered SHALL replace it, so repeated registration
under React StrictMode's double-invocation leaves exactly one live handler and issues no
duplicate effects.

**The registry serves one owner per handle, by construction.** A handle SHALL NOT fan out to
multiple concurrently-registered handlers. Coordination requiring multiple independent listeners
is outside this mechanism and SHALL NOT be forced into it.

**Unregistering is a capability, not an obligation.** An owner whose lifetime is the
application's lifetime MAY register permanently and never unregister. No requirement, test, or
check SHALL **forbid a deliberately permanent registration** — no balanced-call assertion, no
"every registration must be matched" rule. This is forward-looking policy: after this change every
production owner does tear down, but the contract SHALL NOT be tightened to require it. A guard
that identifies an *unintended* leak remains permitted.

#### Scenario: Calling an unregistered handle is a silent no-op

- **WHEN** a caller invokes a handle while no owner has registered a handler
- **THEN** the call returns without throwing, and no side effect occurs

#### Scenario: A read-shaped handle reports unavailability rather than a default

- **WHEN** a caller invokes a value-returning handle while no owner is registered
- **THEN** the result is an explicit unavailable value the caller can test, not a fabricated
  number, and the caller's own fallback produces the same value it produced before this change

#### Scenario: StrictMode double-invocation leaves one live handler

- **WHEN** an owning component mounts under React StrictMode, so its registering effect runs, is
  cleaned up, and runs again
- **THEN** exactly one handler is registered afterwards, and invoking the handle produces exactly
  one effect

#### Scenario: A handle does not fan out to multiple handlers

- **WHEN** two owners register handlers for the same handle without an intervening teardown
- **THEN** invoking the handle runs exactly one handler — the most recent registration

#### Scenario: Teardown removes the handler

- **WHEN** an owning component unmounts, or its registering effect's dependencies change such
  that it should no longer own the handle
- **THEN** the handle has no registered handler afterwards, and invoking it is a no-op

### Requirement: Ownership state is observable

The registry SHALL expose a way to ask whether a handle currently has a registered handler.

Without it, "the handle is unowned" and "the handle is registered to a handler that does nothing"
are observationally identical through a register/invoke-only API — so a scenario requiring the
former is satisfiable by the latter. The mechanism being replaced *was* observable this way
(`expect(window.X).toBeUndefined()`); the replacement SHALL NOT lose that.

#### Scenario: Unowned and registered-to-a-no-op are distinguishable

- **WHEN** a handle has no registered handler, and separately when it is registered to a handler
  that performs no action
- **THEN** the two states are distinguishable through the registry's API

### Requirement: Conditional ownership is expressible without a sentinel assignment

An owner whose eligibility depends on component state SHALL be able to express "I do not own this
handle right now" directly.

Doing so SHALL clear only a handler **this owner** registered. It SHALL NOT clear a handler
registered by a different owner. The registry SHALL provide no unconditional clearing primitive,
so the ineligible path cannot become a second route to the clobber the identity-scoped teardown
requirement forbids.

#### Scenario: An ineligible owner leaves the handle unowned

- **WHEN** an owning component's state makes it ineligible to serve a handle — for example no
  active session, media blocked, or transport not rolling
- **THEN** the handle has no handler registered by that owner, invoking it performs no action,
  and the registry reports the handle as unowned

#### Scenario: Eligibility regained re-registers

- **WHEN** that component's state changes so it becomes eligible
- **THEN** the handle has a registered handler again and invoking it performs the action

#### Scenario: An ineligible owner does not clear another owner's handler

- **WHEN** an owner becomes ineligible while a different owner holds the registration
- **THEN** the other owner's handler remains registered

### Requirement: React-external callers are first-class

The registry SHALL be usable from modules that never participate in a React lifecycle, including
at module evaluation time and from synchronous event handlers running before React renders or
commits. Invoking a handle SHALL be synchronous, so a caller that must act before React
re-renders observes its call's effect before returning.

The registry module SHALL import no other application module, so it cannot participate in an
import cycle with the navigation modules that call into it at module scope.

This preserves the ordering guarantee `web-session-routing`'s "Originator-scoped transport stop
on route departure" depends on: the departure watcher subscribes to the navigation wrapper and to
`popstate`, both firing synchronously before React renders, and must reach the transport-stop
handle at that moment.

#### Scenario: A module-scope caller reaches a handle

- **WHEN** a module that uses no React hook or context invokes a handle
- **THEN** the registered handler runs, with no React provider in the call path

#### Scenario: The handle is resolved at call time, not import time

- **WHEN** a module-scope caller is evaluated before any owner has registered, and an owner
  registers afterwards
- **THEN** a later invocation from that caller runs the newly registered handler

#### Scenario: Departure stop fires before re-render

- **WHEN** the originating client navigates away from its rolling session's route
- **THEN** the transport-stop handle is invoked synchronously during the navigation call, before
  React re-renders, exactly once for the departure

### Requirement: The registry is the test seam and does not leak between tests

Tests SHALL drive coordination through the registry's API rather than by assigning to `window`.
The registry SHALL expose a reset that clears all registrations, and the shared web test setup
SHALL invoke it after each test.

This is load-bearing rather than hygienic: under identity-scoped teardown a stub registered after
an owner mounts is not the identity that owner tears down, so without an explicit reset it
survives the owner's unmount into the next test.

#### Scenario: A test registers a handler without touching the global object

- **WHEN** a test needs a handle served by a stub
- **THEN** it registers the stub through the registry API, and `window` is not mutated

#### Scenario: Registrations do not leak across tests

- **WHEN** a test registers a stub after its owner has mounted, and a subsequent test runs
- **THEN** the subsequent test observes no handler registered by the earlier test

### Requirement: Handler ownership is identity-scoped at teardown

A teardown SHALL clear a handle only if the handler being torn down is still the registered one.
A stale owner's teardown SHALL NOT clear a handler a newer owner has since registered.

**This is forward insurance against a latent hazard, not repair of an observed defect.** No such
interleave is reachable in the component tree as it stands: each handle has exactly one owner
rendered at exactly one position, the session workspace is unkeyed so a session switch is a
same-instance dependency change, and the application uses no `Suspense`, `React.lazy`, transition
API, or Offscreen boundary that could keep two owners alive across commits. React runs all
passive destroys for a commit before any passive creates, so single-owner shapes are always
cleanup-first.

The hazard is real at the mechanism level — two owners of one handle spanning separate commits
can produce cleanup-after-newer-setup — and becomes reachable if any of those preconditions
changes: a second owner for a handle, an owner rendered at two positions, adoption of a
concurrent-rendering boundary, or decomposition of the session workspace into independently
mounted regions.

#### Scenario: A stale teardown does not clear a newer registration

- **WHEN** owner A registers a handler, owner B registers a replacement for the same handle, and
  only then does owner A's teardown run
- **THEN** owner B's handler remains registered, and invoking the handle runs owner B's handler

#### Scenario: A current owner's teardown does clear

- **WHEN** an owner registers a handler and its teardown runs with no intervening registration
- **THEN** the handle has no registered handler afterwards

### Requirement: The coordinated behaviors are observably intact

The behaviors these handles serve SHALL hold, independent of which mechanism coordinates them:
audio seek without playback, seek with playback, transport stop on departure, manual scrub,
timeline scroll, timeline zoom read, and event invalidation.

Behavior that a removed handle mediated SHALL remain reachable through the owner's own state,
props, or the shared query client, with observable behavior unchanged.

The three feed-jump and marker-navigation scenarios below are **non-normative references**:
`web-session-console` owns those behaviors and remains their single normative home. They appear
here only to keep this capability's preservation obligation legible, and a future change to
feed-jump behavior edits `web-session-console` alone.

#### Scenario: Marker navigation is unchanged (non-normative — defers to `web-session-console`)

- **WHEN** a user navigates by marker
- **THEN** the playhead moves, the timeline scrolls it into view, and audio seeks **without**
  starting playback

#### Scenario: A feed jump starts playback where a recording covers the point (non-normative — defers to `web-session-console`)

- **WHEN** a user jumps from a feed row to a point covered by a recording
- **THEN** the playhead moves, the timeline scrolls, and playback starts

#### Scenario: A feed jump with no covering recording does not start playback (non-normative — defers to `web-session-console`)

- **WHEN** a user jumps from a feed row to a point no recording covers
- **THEN** the playhead moves and the timeline scrolls, and playback is **not** started

#### Scenario: Event invalidation still fires after a synthetic stop

- **WHEN** the recovery-stop flow completes its transport-stop request
- **THEN** the event feed is refetched; and if no owner is registered at that moment, the
  invocation is a silent no-op

#### Scenario: The settings modal still refetches the session list

- **WHEN** the settings modal completes the action that refreshed the session list before this
  change
- **THEN** the session list is refetched, asserted against the shared query client rather than
  against any coordination mechanism

#### Scenario: Timeline ticks read the live zoom

- **WHEN** the timeline ticks render while the zoom rail is mounted
- **THEN** they read the current zoom value, and a non-finite or non-positive reading still
  yields the caller's existing fallback

### Requirement: The web app's internal import direction is mechanically enforced

Within `web/src`, production **value** imports SHALL flow only downward through
`pages → api → shared`. `api` and `shared` SHALL NOT value-import from `pages`. The `admin-users`
page SHALL NOT import from the `index` page, in either direction.

**Type-only upward edges are permitted and SHALL NOT be flagged.** Three exist today —
`shared/utils/{recording,timecode,audioClips}.ts` each `import type` from `api/types` — and they
erase at compile time, so the runtime graph stays acyclic while the type graph does not. The
boundary this requirement protects is the runtime and bundle structure, not the type graph.
Forbidding them would force import rewrites this rule was explicitly adopted to avoid.

This direction already holds; the requirement exists because it held only by convention. `web/`
builds two independent entry bundles, and the smaller one depends on none of the larger one's
libraries — a property nothing currently protects.

#### Scenario: The layering direction is enforced, not merely observed

- **WHEN** production files under `web/src` are scanned for **value** imports crossing the
  `pages` / `api` / `shared` boundaries
- **THEN** no value import from `api` or `shared` targets `pages`, and the existing type-only
  `shared → api` edges are not reported

#### Scenario: The two entry bundles stay independent

- **WHEN** production files under `web/src/pages/admin-users` are scanned for imports
- **THEN** none targets `web/src/pages/index`

### Requirement: Enforcement checks are proven non-vacuous

A check enforcing this capability — whether it enforces the coordination seam or the import
direction above — SHALL derive its walked root from its own module location rather than a
hard-coded relative path, SHALL assert that it examined a non-zero number of files, and SHALL
ship a mutation pair demonstrating that it fires on a violating input and does not fire on a
conforming one.

A negative runtime assertion that a handle is absent from the global object SHALL be made in a
context where that handle's owning component actually mounts. An assertion placed where the owner
is module-mocked passes identically before and after the change and enforces nothing.

#### Scenario: The static check fires on a violation and passes on conforming input

- **WHEN** the check runs against a fixture containing a global-object coordination write, and
  separately against one containing none
- **THEN** it reports a violation for the first and none for the second

#### Scenario: The check cannot pass by examining nothing

- **WHEN** the check's walked root does not resolve to the intended tree
- **THEN** the check fails rather than reporting success over zero files

#### Scenario: Runtime absence assertions run where owners mount

- **WHEN** a runtime assertion claims a retired handle is absent from the global object
- **THEN** it executes in a test where that handle's owning component is rendered, not
  module-mocked
