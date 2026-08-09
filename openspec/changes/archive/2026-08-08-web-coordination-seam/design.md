## Context

Campaign step 5, **reframed**. Steps 1–4b built a three-layer, test-enforced package graph for
the server (`domain`/`contract`/`ports` at L0; `session-core`/`catalog`/`storage` at L1;
`transcription`/`media-import`/`log-import`/`ai-runtime` at L2). The campaign named its final
step "web split" before anyone measured `web/`. Measurement does not support that name — see
D0.

**Current state, measured on `main` at `31aaba6` with a clean tree.** Method stated per
instrument, because this change's own scoping was wrong three times before it was right:

```
web/src production (*.ts/*.tsx, excluding *.test.*)
  pages/   103 files / 20,098 LOC     (index/ = the session workspace; admin-users/ = 4 files)
  api/      15 files /  1,760 LOC
  shared/   24 files /  2,348 LOC

internal edges — resolved per-file by an import-specifier parser handling both the relative
and the `@/api`|`@/shared`|`@/pages` alias forms. BOTH methodologies are published because an
earlier draft of this table mixed them (see the Panel & review log):

                    production-only    test-inclusive
  pages  → api            99                181
  pages  → shared         91                103
  api    → pages           0                  1   ← `types.conformance.test.ts`
  api    → shared          2                  3       imports from `pages/`
  shared → api            3                  4
  shared → pages           0                  0
```

The production-only column is the one D0's argument rests on, and the qualifier is load-bearing:
`api → pages` is zero **in production code**, and becomes 1 once test files are counted. A
runtime/bundle-boundary claim is about production code, so the argument holds — but it must be
stated with its scope, not as an unqualified "zero back-edges".

`api → shared`'s 2 production edges are **value** imports (`toast`, `getClientInstanceId`);
`shared → api`'s 3 are all `import type` (`LogEvent`, `SessionStatus`, `AudioSegment`), so the
runtime graph is acyclic while the type graph is not.

The coordination surface, comment lines excluded from every call-site count:

```
handle                            installs  readers  declare-global blocks
AutoLogger_seekAudio                   1        1        1
AutoLogger_seekAudioAndPlay            1        1        1
AutoLogger_stopTransportIfNeeded       1        1        2
AutoLogger_setManualScrubSec           1        2        1
AutoLogger_scrollTimelineToSec         1        2        1
AutoLogger_getTimelineZoom             1        1        2
AutoLogger_invalidateEvents            1        1        2
AutoLogger_closeSettingsModal          1        0        1
Home_reloadSessionList                 1        1        1
Home_clearSessionList                  1        0        1
                                      ──       ──       ──
                                      10       10        7 blocks / 7 files
```

Owners (4 files): `AppShell.tsx` (3 handles), `SessionWorkspace.tsx` (4), `useZoomRail.ts` (2),
`Timeline.tsx` (1). Consumers (6 files): `timelineJump.ts` (3), `useTimelineSeek.ts` (3),
`departureWatcher.ts` (1), `TimelineTicks.tsx` (1), `useRecoveryStopWarning.ts` (1),
`HomeSettingsModal.tsx` (1).

**Owners fall into three teardown shapes, not two** — the distinction matters to D3 and to the
registry's contract:

```
unconditional teardown   7 handles   SessionWorkspace ×4, Timeline ×1, useZoomRail ×2
                                     `return () => { window.X = undefined; }`
conditional ownership    (1 of the 7) SessionWorkspace's stopTransportIfNeeded also clears
                                     inline when ineligible, deps [sessionId, isRolling, blocksMedia]
NO teardown at all       3 handles   AppShell's closeSettingsModal, Home_reloadSessionList,
                                     Home_clearSessionList — installed in a mount-once effect
                                     whose only cleanup is removeEventListener('click', …)
```

Tests: **11 files, 48 occurrences** — counted by enumerating the ten exact handle names and
matching `window.<Handle>`, excluding comment-leading lines. Of the 48, **39 are assignments**
(tests installing stubs on `window`) and 9 are reads; `timelineJump.test.ts` is 16 of the 48.
A bare-identifier grep reports 60 because it also matches comments and `it(...)` description
strings — that instrument produced this design's original figure and was wrong.

**Not an external surface.** `AutoLogger_*` and `Home_*` have zero references in `e2e/`,
`companion/`, `server/`, `web-docs/`, and `playwright.config.ts`. The frozen HTTP/WS contract
does not reach window globals, and no external reader exists either — both checks clear
independently.

**No baseline requirement names the mechanism.** Searching all of `openspec/specs/` for
`AutoLogger_`, `Home_reloadSessionList`, and `Home_clearSessionList` returns **zero matches**.
The behaviors are specified mechanism-agnostically — `web-session-routing:139` says "SHALL
invoke the same stop-transport-if-needed behavior".

**Constraints inherited and verified, not re-derived:** frozen HTTP/WS contract; single Node
process; `web/src/api/types.ts` stays hand-written (step 1's gate ruling); boundary enforcement
lives in `server/src/packageBoundaries.repo.test.ts`, extended never forked, with deltas landing
in the unit that needs them; a check's walked root must follow the code it governs (step 4b's
D9); `web-docs` is a drift consumer of any module move and an unenrolled workspace's edges
vanish silently with `docs:check` green — `web` **is** enrolled in `WORKSPACE_REGIMES`
(`extractImports.ts:116`), verified by reading the constant.

## Goals / Non-Goals

**Goals:**

- One typed module owns the coordination contract; the seven `declare global` blocks and the
  `Window` augmentation are deleted outright.
- Seven handles move to explicit register/invoke with today's absence-is-a-no-op semantics
  preserved exactly; three leave entirely (two reader-less, one inlined), so `AppShell` ceases to
  be an owner.
- React-external callers stay first-class, preserving `web-session-routing`'s documented
  pre-commit ordering guarantee (D1).
- Tests drive the seam, not `window`.
- The three `AppShell` handles are resolved with evidence rather than carried forward (D4).
- The two duplicated custom-event name constants gain owning modules, with no normative rule (D6).
- `web/`'s already-holding import direction gains its first mechanical guard (D0).
- Every enforcement instrument ships proven non-vacuous (D8).

**Non-Goals:**

- Splitting `web/` into workspace packages (D0 — declined as poor value; a boundary guard is adopted instead).
- Decomposing `pages/index/`.
- Whether `web/` may depend on the `@autologger/*` package graph — independent of this change
  and still open (D7).
- A pub/sub abstraction for custom DOM events, and any normative rule about event names (D6).
- Any observable production behavior change. D3's identity scoping changes the **test** tier only, deliberately (D3).
- `server/`, `packages/`, `companion/`, `e2e/`.

## Decisions

### D0 — The workspace split is declined on measurement; a boundary guard is adopted instead (gate ruling E5)

The campaign's remainder line has read "web split (api-types free; admin-users free;
session-workspace blob needs the window-global-bus refactor first)" since step 1. That framing
treats the bus as the *blocker* and the package split as the *value*. Measurement inverts it.

**`web/src` is already separated by concern.** In production code `pages → api → shared` is
one-way and `api → pages` / `shared → pages` are both **zero** (test files add one `api → pages`
edge; see the table above). A workspace split would cost ~284 import-specifier rewrites
(test-inclusive — ~190 production-only) plus a three-site type-only cycle break (`shared → api`
for `LogEvent`/`SessionStatus`/`AudioSegment`).

**Two premises this decision originally rested on were false, and the correction matters.** An
earlier draft argued that `web/` "ships one bundle to one browser" and that "every page needs
`react` and `@tanstack/react-query` regardless, so no manifest confines anything." Both are
wrong, and the panel demonstrated it:

- `web/vite.config.ts` declares **two rollup inputs** (`index`, `admin-users`), each with its own
  `index.html`. Built output: `index-*.js` 468 KB, `admin-users-*.js` **6.7 KB**. `web/` is an
  MPA, not a single bundle.
- `pages/admin-users` (4 files, 351 LOC) imports `@tanstack/react-query` **zero** times, `wouter`
  zero times, and `pages/index` zero times. A lean manifest there would confine exactly what
  keeps that bundle at 6.7 KB — which is the *confinement* property the draft said packages could
  not buy here.

So the honest statement is narrower: **a workspace split is poor value, not valueless.** Its
plausible beneficiary is `admin-users`, a 4-file page — and ~190 production import rewrites to
confine four files is bad value. The conclusion survives; the reasoning that reached it did not.

**The middle option the draft never priced, adopted at the gate (E5).** D0 originally offered the
gate a binary: full workspace split, or nothing. It also conceded that "what a split would buy is
direction enforcement — real, but already true by construction." *Already true by construction* is
the strongest possible argument for cheap enforcement, not against it: an invariant that already
holds costs nothing to guard and never needs a fix-up wave.

And this repo already owns the instrument. `web/src` contains four filesystem-walking policy
tests — `apiResponseShapes`, `cursorAdapters`, `noAgentAuthoredMarkup`, `queryKeyFactories`, each
`*.repo.test.ts`. A fifth pinning `pages → api → shared` as one-way and
`pages/admin-users ↛ pages/index` costs **one file and zero import rewrites**, and delivers the
direction enforcement the split was wanted for. Without it this campaign ends with **zero
enforced import boundary anywhere in `web/`**, while the server carries four.

*Consequence that must be stated, not discovered:* the campaign ends with `web/` unsplit and
`pages/index/` — 70% of web's LOC — still monolithic. That is the intended outcome. But the gate
chose it against three priced options, not two.

*Phase-5 fix wave 2 correction, recorded here rather than left standing.* The phase-5 review
defeated the boundary guard's admin-users/index carve-out with a two-hop re-export through a
third `pages/` subarea (no transitive-reachability check); fix wave 1 added one, built on the
same line-based, comment-stripping import extraction the original check used. The scoped
re-review that followed defeated *that* too — `webBoundaries.repo.test.ts` parsed imports one
line at a time and blanked any line starting with a comment marker, so a single, ordinary
lint-pragma line (`/* eslint-disable-next-line */ import { X } from '../index/Y';`) erased the
import before any of the three checks (layering, the admin-users/index carve-out, and the new
transitive check) ever saw it — the standing "rebuild on `ts.createSourceFile`" recommendation
had been applied to the check named in the finding but not to this file's own, separately
defective import scanner. `webBoundaries.repo.test.ts` is now AST-based throughout: real
`ImportDeclaration`/`ExportDeclaration` nodes, type-only classification read from the AST's own
`isTypeOnly` fields (whole-clause and per-specifier, including the mixed `import { type A, B }
from '...'` form) rather than re-derived from clause text. Comments are parser trivia under this
approach, not text the scan pattern-matches, so no comment placement can hide an import. Verified
by reproducing the comment-hiding attack against pre-fix code (passes — the import is invisible)
and against the fixed code (fails — the import is caught), for all three checks it had defeated
at once; full matrix in `.apply/phase-5-review.md`, "Phase 5 fix wave 2".

One wording correction alongside the fix: the transitive-reachability check's own code comment
describes it as mirroring `server/src/packageBoundaries.repo.test.ts`'s
`checkServiceTransitiveReachability`. That is true of the **traversal algorithm** — both are a
stack-based DFS over a `seen` set, cycle-safe, computing full transitive closure from a start
node — independently re-confirmed by a cyclic-graph regression test. It is **not** true of
**edge-inclusion policy**: the server precedent's graph counts every import specifier toward
reachability, `import type` included, because that check exists for manifest-declaration honesty
and dependency-cycle avoidance; this check excludes type-only edges at every hop, because it
exists to bound what Rollup actually bundles, and an erased-at-compile-time edge bundles nothing.
Both choices are correct for what each check protects — the divergence is deliberate, not an
unexamined copy — but "mirrors" without that distinction overclaims fidelity to the precedent by
one axis. Recorded here so the next reader does not read "mirrors" as "identical in every respect."

### D1 — A module-scoped registry, because React context is foreclosed

`departureWatcher.ts` is the constraint. Its header states the requirement in terms:

> NEVER wouter's route hook (design D1/D4: wouter is render-side only; its hooks fire during
> render, **too late to guarantee the stop call lands before `SessionWorkspace`'s effects clear
> or redefine** `window.AutoLogger_stopTransportIfNeeded` for the incoming route)
>
> This module never touches React lifecycles at all.

It installs at **module evaluation time** (`installDepartureWatcher()` is called at file scope,
line 96) and fires **synchronously** from the navigation wrapper and from `popstate`, both
pre-render and pre-commit. That ordering is what makes `web-session-routing`'s
"Originator-scoped transport stop on route departure" requirement satisfiable at all.

React context cannot serve it. Neither can a hook. So:

| candidate | verdict |
|---|---|
| React context / provider | **Foreclosed.** 4 of the 10 reader call sites are in React-free modules — `timelineJump.ts` ×3 and `departureWatcher.ts` ×1 (verified by absence of any `react` import; the other four consumer files all import from `react`). `departureWatcher` cannot consume a provider at all, and moving it into React regresses a documented guarantee. The foreclosure rests on `departureWatcher` alone and does not depend on this count. |
| Context for the 6 React sites + `window` for the rest | **Rejected.** Two mechanisms for one concern is worse separation than one bad mechanism. It also leaves the `Window` augmentation standing, forfeiting the main type-safety win. |
| Props threading | **Rejected.** The owners and consumers are not in an ancestor/descendant relationship (`useZoomRail` → `TimelineTicks` is, but `SessionWorkspace` → `departureWatcher` is not a React relationship at all). |
| **Module-scoped typed registry** | **Adopted.** Preserves synchronous invocation, module-scope reachability, and absence-is-no-op semantics exactly, while giving the contract one owner and removing `Window` augmentation. |

**Addendum — registration must not assume symmetric register/unregister pairs.** Surfaced by the
fact-check pass. `AppShell.tsx` installs three handles from a mount-once effect that never clears
them, which made its conversion a permanent registration with no matching unregister.

**Gate ruling E2 removed that instance**: `Home_reloadSessionList` is inlined rather than
converted (D4), so after this change *every* production owner tears down. The requirement
therefore stands as **forward-looking policy, not a claim about a live owner** — the spec says so
explicitly, because a SHALL whose only supporting instance the same change deletes is exactly the
"true only in one document" failure this campaign keeps hitting.

The policy is still worth having: any enforcement built on register/unregister pairing — a leak
check, a balanced-call assertion, a "no handler outlives its owner" rule — would forbid a
legitimate application-lifetime owner. Barring it now costs nothing and prevents a later reader
from tightening the contract into something the mechanism never required.

**What this is, stated honestly.** This is not converting a global into dependency injection.
It is a **service locator gaining a typed owner, a module identity, and a test seam**. The
separation-of-concerns improvement is real and specific — the contract currently has *no*
declaration owner and is duplicated across seven blocks — but it is narrower than "injected
service," and overselling it would invite a reviewer to find the gap for us.

**Seam note — the register/unregister same-reference contract (whole-branch audit, 2026-08-08).**
The registry's real undeclared seam is narrower than "the registration contract" in general: an
owning component MUST pass the exact same function reference to both `register(handle, fn)` and
`unregister(handle, fn)` — the `addEventListener`/`removeEventListener` idiom, where
`removeEventListener(type, () => {...})` silently does nothing because the listener passed to
`remove` is a different function object than the one passed to `add`. `unregister` compares by
reference, so a caller that reconstructs the handler inline at teardown (`unregister('x', (sec) =>
writeManualScrubSec(sec))` instead of storing and passing back the identical closure) unregisters
nothing, and the stale handler survives.

The compiler cannot see this. Both `register`'s and `unregister`'s second argument typecheck
against the same `HandlerMap` function-type member regardless of whether the two calls share a
reference — TypeScript's structural typing has no notion of "the same value passed earlier," so a
fresh closure with a matching signature is indistinguishable at the type level from the original.
Only a test that mounts the owner, asserts registration, unmounts it, and asserts the handle is no
longer registered can witness the property at all.

This contract is satisfied **independently by four owners** — `SessionWorkspace`, `Timeline`,
`useZoomRail`, and formerly `AppShell` — each of which must get it right on its own with no shared
enforcement. Finding I-2 (`Timeline.tsx` and `useZoomRail.ts` lacking the teardown coverage phase 2
added only for `SessionWorkspace`) is this seam's direct consequence: the property held in
production in all three owners, but two of the three had no test capable of catching a regression.

**The phase-2 partition's rejection of `sec` as a declared seam was correct, but for a narrower
reason than the ledger recorded at the time.** The recorded reason was that both `sec`-passing
callers converted within the same dispatch unit, so no independent later satisfaction existed to
miss. That is true as far as it goes, but it would have been the *wrong* reason under a different
partition — if the two callers had landed in separate units, the same reasoning would have wrongly
declared a seam safe that still isn't the real one. The durable reason `sec` is safe is that the
registry's `HandlerMap` is a **single, compiler-checked declaration site** for every handle's
signature: a caller and an owner disagreeing about `sec`'s type or presence is a type error, not a
silent seam. The same-reference contract has no such backstop — nothing about `HandlerMap` or
`register`'s signature forces two calls to share a reference — which is exactly why it, and not
`sec`, is the seam this change should have declared.

### D2 — Read-shaped handles return "unavailable"; the fallback policy stays in the caller

`TimelineTicks.tsx:22-25` today reads
`const z = window.AutoLogger_getTimelineZoom?.()` and then applies
`Number.isFinite(z) && z > 0 ? z : 1`. The `?: 1` is a **caller policy**, not a registry
default.

The registry therefore returns `undefined` for an unregistered value-handle, and
`TimelineTicks` keeps its own fallback verbatim. **A third site carries the same assumption**
and is easy to miss: `useZoomRail.test.tsx:56` independently reimplements `?? 1`. It is test
code, so it is not bound by this decision, but the implementer converting `TimelineTicks` must
not assume the `?: 1` pattern exists in only one place. Moving the `1` into the registry would make
"no owner mounted" indistinguishable from "zoom is genuinely 1" for every future caller —
exactly the fabricated-default failure the `ai-v2-dashboards` capability already legislates
against ("Data unavailability is a rendered state, never a zero").

### D3 — Identity-scoped teardown is forward insurance, not repair (gate ruling E1)

**Every owner that tears down at all does so with an unconditional assignment** — and three
handles do not tear down at all:

```
7 handles:  return () => { window.AutoLogger_seekAudio = undefined; };   ← unconditional
3 handles:  AppShell's mount-once effect installs closeSettingsModal,
            Home_reloadSessionList, Home_clearSessionList and NEVER clears them
```

The draft asserted "every owner", which the fact-check pass falsified.

**The hazard the draft claimed is unreachable in this tree. All four panel reviewers refuted it
independently, two by running React 19 probes.** The mechanism-level hazard is real — two owners
of one handle spanning separate commits produce `setup:A, setup:B, cleanup:A` — but every shape
*this* tree can produce is cleanup-first:

- each handle has exactly one owner rendered at exactly one position (`SessionWorkspace` ←
  `WorkspaceStatic.tsx`, **unkeyed**; `Timeline` ← `MaximizeLogStrip.tsx`; `useZoomRail` ← one
  call site in `Timeline.tsx`; `AppShell` is the root);
- `SessionRoute` gates the workspace mount on `query.data`, so an uncached session switch renders
  a loading state first — A unmounts in commit N, B mounts in commit N+1;
- a cached switch is a **same-instance prop change**, not a remount, because `WorkspaceStatic` is
  unkeyed — so `stopTransportIfNeeded`'s `[sessionId, isRolling, blocksMedia]` re-run is
  cleanup-then-setup on one instance, which React guarantees;
- `web/src` contains no `Suspense`, no `React.lazy`, no `startTransition`/`useTransition`/
  `useDeferredValue`, no Offscreen boundary, and the production entry does not wrap in
  `StrictMode`.

**Ruled at the gate: adopt it as forward insurance.** It costs ~3 lines and becomes live the
moment any precondition changes — a second owner, an owner at two positions, adoption of a
concurrent-rendering boundary, or **decomposition of `pages/index/`, which D0 names as the
acknowledged next step**. The spec's justification is written as a latent hazard; an earlier draft
stated it in the past tense ("the newer owner's handler *was* destroyed"), which would have
archived a false claim about this repo's history into the durable baseline.

**Two supporting claims the draft made do not survive checking.** `departureWatcher.ts`'s comment
about child-first cleanup argues against firing the stop *from* a cleanup — it is not anxiety
about one owner clobbering another, and citing it as corroboration was a misreading. And
`SessionWorkspace`'s dependency-change re-run, named as "the most exposed" site, is structurally
incapable of clobbering for the unkeyed-instance reason above.

**The real behavior change runs the other way, and the draft priced it backwards.** Identity
scoping is what *introduces* a difference — in the test tier. A stub registered *after* its owner
mounts is no longer the identity that owner tears down, so it survives unmount into the next test.
`SessionWorkspace.audioClipsSeam.test.ts` uses exactly that pattern with a comment calling the
ordering deliberate. Hence the mandated registry `reset` in `web/src/test/setup.ts` (task 1.3),
which is load-bearing rather than hygienic.

**Consequence for the ineligible-ownership path.** `SessionWorkspace`'s ineligible branch
(`!sessionId || blocksMedia || !isRolling`) never registered a handler on that run, so it has no
identity to match. Two reviewers showed that an unconditional `clear(handle)` would re-admit the
exact clobber this decision forbids, through a second door, at the one site the draft called most
exposed. The registry therefore provides **no unconditional clearing primitive**: the ineligible
path unregisters *this owner's* handler, which is a no-op when it holds none. And because
"unowned" and "registered to a no-op" are observationally identical through a register/invoke-only
API — so the spec scenario would be satisfied by the implementation the tasks forbid — the
registry exposes `isRegistered`, restoring the observability the old
`expect(window.X).toBeUndefined()` had.

### D4 — All three `AppShell` handles leave; `AppShell` stops being an owner (gate rulings E2, E3)

`AutoLogger_closeSettingsModal` and `Home_clearSessionList` are each installed once and invoked
**nowhere** — not in production, tests, `e2e/`, `companion/`, `server/`, `web-docs/`, or
`playwright.config.ts`.

The repo's frozen-surface rule — *surface with no current in-repo caller stays frozen, because it
exists for stale or external clients* — is explicitly scoped to the **published HTTP/WS
contract**. A window global on a page the server itself serves has no deployed consumer that lags
the repo the way a Companion install does, so the rule does not reach these. **Precedent found by
the panel:** the 2026-07-27 full-repo review already removed three dead globals of this exact
family (`AutoLogger_getManualScrubSec`, `AutoLogger_getSelectedEventId`,
`AutoLogger_resetZoom`) with no fallout; all three are confirmed absent today.

**The evidence is stronger than the draft stated, on both.** `closeSettingsModal` wraps
`setShowSettings(false)` — and `AppShell` already threads `onClose` to the very same direct child.
`Home_clearSessionList` is assigned the **identical `refetchSessions` closure** as its twin: a
pure duplicate alias.

**The third handle is not converted either (E2).** Two reviewers independently found that
`Home_reloadSessionList` is a global round-trip to a client the caller already holds:
`HomeSettingsModal` is `AppShell`'s **direct child** (already receiving two callbacks from it),
already calls `useQueryClient()`, and already calls `invalidateQueries` on the three lines
immediately following the global's invocation. `AppShell` itself uses the identical inline form
elsewhere. The draft's D1 rejected props threading on the grounds that owners and consumers "are
not in an ancestor/descendant relationship" — true for the session-workspace handles, **false for
this pair**, and D1 never named it.

So the honest disposition is a **third fate the draft's decision structure did not offer**. Every
handle was to be either carried into the registry or deleted as reader-less; this one is *inlined*
— it has a reader, and it should still not exist. A "every retained handle has a reader" check is
structurally blind to that distinction, which is why the gate cut it (E6's companion ruling): it
cannot tell *has a reader* from *should not exist*.

**Result: the registry holds seven handles**, all session-workspace-owned, all under
`pages/index/`. `AppShell` owns nothing and its `declare global` block — which declared six
handles while installing three — is deleted entirely.

### D5 — The negative assertion lands in the new capability, not by extending `web-session-routing`

`web-session-routing` already carries "Legacy selection spine retired", which asserts
`window.V3_selectSession` / `window.V3_closeSession` are undefined and is pinned by a live test
(`AppShell.test.tsx:396-397`, `expect('V3_selectSession' in window).toBe(false)`). That is a
direct in-repo precedent for both the spec shape and the test shape, and this change follows it.

It is **not** extended, for two reasons. First, the ten handles span three capabilities'
subject matter — routing (`stopTransportIfNeeded`), the session console (seek/scrub/zoom/feed
jumps), and home (`Home_*`) — so no existing capability owns them; putting them under a routing
requirement would misfile seven of the ten. Second, editing a MODIFIED block risks the content
loss this campaign has hit repeatedly (step 4b's panel found a MODIFIED block that replaced all
six baseline scenario names and silently dropped three).

`web-session-routing` stays **unchanged and in force**. Its `V3_*` assertion is not subsumed,
restated, or weakened.

### D6 — Event-name ownership only; no pub/sub abstraction

Four custom DOM events coordinate between components. Two already do it correctly:
`revealEventInFeed.ts` and `perfDebug.ts` each declare and export their event name, and every
user imports it. Two do not:

```
autologger:timeline-zoom-changed   declared in useZoomRail.ts:15  AND  TimelineTicks.tsx:19
autologger:timeline-sec            literal   in Timeline.tsx:451   AND  const in MarkerNav.tsx:54
```

That is the same defect as the seven `declare global` blocks — a contract restated at each use
site — in a second mechanism, and three of the four files are already being edited for the
handles work.

**Only the name constants get owners.** The fix is the pattern two sibling modules already
demonstrate: one declaring module, an exported constant, every dispatcher and listener
importing it. Dispatch and subscription are untouched.

**Gate ruling E6: the two name constants land as cleanup; the normative requirement does not
ship.** The draft also proposed a durable requirement — *"Each custom coordination event name has
one owning module"* — plus two scenarios. Two reviewers judged it a rider failing this repo's
own four-part test (unambiguous, cheap, reuses existing primitives, **directly exercised by this
change**). It fails the fourth: the registry work touches no dispatch or subscription path;
`useZoomRail.ts` is opened to delete a `declare global` block, which is adjacency, not exercise.
And `MarkerNav.tsx` is not otherwise in the edit set at all.

The cost is not the four file edits — it is a requirement quantified over **every future custom
DOM event repo-wide**, governing a mechanism this change declares a Non-Goal, shipped with no
enforcing gate. It is also already false on arrival: `EventLogSheet.test.tsx` restates
`'autologger:reveal-event'` as a bare literal even though `revealEventInFeed.ts` exports it and
every other user imports it — a file in neither edit-set list. Requirements are forever;
opportunistic cleanups are not. The bus change owns the rule when it arrives.

**The event bus is deferred with a stated revisit condition, not declined.** An earlier draft
of this decision rejected it as YAGNI. That framing was wrong, and the correction is worth
recording because it changes what a successor should do.

This app has **two distinct coordination shapes**, and the registry serves exactly one:

```
1:1 request/response   the 10 handles     ONE owner per handle; callers invoke it
                                          → this change gives it a typed owner

1:N broadcast          the 4 DOM events   one dispatcher, N listeners
                                          → untouched here; the registry CANNOT absorb it
```

The registry is one-owner-per-handle by construction — that is what makes its teardown
identity (D3) and its "every retained handle has a reader" requirement meaningful. Any
coordination needing multiple independent listeners is structurally outside it. So the bus is
not leftover scope from this change; it is **the other half of the same problem**.

And the 1:N shape is already load-bearing, not hypothetical — measured listener counts:

| event | dispatchers | listeners |
|---|---|---|
| `autologger:timeline-zoom-changed` | 1 | 1 (`TimelineTicks.tsx:27`) |
| `autologger:timeline-sec` | 1 | 1 (`MarkerNav.tsx:103`) |
| **`autologger:reveal-event`** | 1 | **2** (`SessionWorkspace.tsx:164`, `EventLogSheet.tsx:421`) |
| `autologger:debug-session-transport` | 1 | 1 (`useDebugTransportOverride.ts:11`) |

**Why not now, stated as a condition a successor can evaluate rather than a judgment they must
re-litigate.** Three of the four events are 1:1 today and would gain nothing from a bus beyond
what D6's constant-ownership already gives them. The one genuine 1:N case has two listeners,
both of which subscribe directly and correctly. Designing a typed pub/sub layer now would mean
reviewing a second mechanism against a surface of one real instance — and doing it *before* the
1:1 side has an owner, so neither mechanism could be cut against the other.

**Revisit when any of these holds:**

- a third listener joins any event, or a second event becomes 1:N — the point at which
  "subscribe directly" stops being obviously right;
- `pages/index/` decomposition (the acknowledged next step, D0) creates cross-module
  notification needs that have no owner-shaped answer;
- the asymmetry becomes a correctness problem rather than an aesthetic one — e.g. a listener
  needs replay, ordering, or unsubscribe-safety guarantees that raw `addEventListener` does not
  give, which is exactly where an untyped DOM event starts producing bugs.

Recorded so the next reader finds a decidable trigger rather than a closed door. This design
takes no position on the bus's eventual shape.

*Stale comment found in passing, fixed with the constant:* `TimelineTicks.tsx:18` says "Custom
event **session.js** dispatches whenever timelineZoom mutates". `session.js` does not exist
anywhere in the repo; the dispatcher is `useZoomRail.ts:124`. No gate reads comments — this is
the fourth edit-set instrument class step 4b's panel identified (normative or provenance prose
that no code instrument sees).

### D7 — The step-5 package question is untouched and stays open

Step 4b left `web/`'s 254-LOC `clientAggregates.ts` mirror and its pinning test deliberately
intact, and recorded re-pointing that test's path literal onto `packages/` as a
**non-precedential relocation of a test-only reader** — explicitly not a ruling that `web/` may
import the package graph.

This change touches none of it. Two findings are recorded for whichever change takes the
question up, because both were established here and would otherwise be re-derived:

- **`clientAggregates.ts`'s stated justification is half-stale.** Its header (lines 17-30)
  gives two reasons for mirroring. The first — the parameter types live in modules that are not
  dependency-free — **survives in substance** (they are now
  `packages/session-core/src/{transcriptStore,topicStore}.ts`, and `session-core` is L1 with a
  `better-sqlite3` peerDependency); only the paths are stale. The second — "loosening Vite's
  dev-server `server.fs.allow`" — is **materially dead**: a workspace package resolves through
  a `node_modules` symlink and raises no `fs.allow` question. The campaign removed that obstacle
  as a side effect and no gate noticed.
- **The row DTOs are interleaved with their implementations**, so "move the DTOs to L0" is a
  **split of three L1 files**, not a move. `TranscriptWord` is declared at
  `transcriptStore.ts:8` and `wordRow(r: Row)` — needing `Row`/`SessionCore` from
  `./sessionCore` — begins at line 20.
- **Importing the row DTOs would retire no part of `web/src/api/types.ts`.** The wire type and
  the row DTO are *different types*: web's `TranscriptWord` carries `session_id`, which the
  server's row DTO does not (the router adds it via
  `words.map((w) => ({ ...w, session_id: sessionId }))`, one of four such spreads in
  `routers/transcribe.ts`). Step 1's hand-written-types ruling is
  therefore not in tension with the question at all — the two are cleanly separable, and the
  prize is ~254 LOC, not the 629-LOC types file.

**The residual stays open**: `web/`'s cross-workspace relative reach into
`packages/ai-runtime/src/aggregates.ts` (a top-level `await import()` six levels up, in
`clientAggregates.pinning.test.ts`) is covered by no check. The boundary test flags the
*package → web* direction (`packageBoundaries.repo.test.ts:584`) and nothing flags *web →
package*.

### D10 — `invalidateEvents` is converted, not inlined — and the reason is recorded

The Fable review asked whether `AutoLogger_invalidateEvents` survives **E2's own razor**: a handle
that is a global round-trip to a client the caller already holds should not exist. Its sole
reader, `useRecoveryStopWarning.ts`, is a React hook under the query provider that already imports
from the module exporting `eventsKeys`, and the owner's handler is one line of the same form
`useEvents.ts` already uses four times. On E2's stated test, it looks inlinable.

**It is converted rather than inlined, because inlining would change behavior.** The global
resolves the handler *at call time*, and the call site is inside a `.finally()` after a network
request — the one invocation in this change that can land after its owner has re-registered or
unregistered. Today that yields two specific outcomes: after a session switch the invoke runs the
**new** session's handler, and after unmount it is a silent no-op. Inlining with the hook's own
`sessionId` would invalidate the departed session instead — arguably a fix, and precisely
therefore a behavior change this change has declared out of scope.

Recorded because the alternative was live and unexamined: E2 established a **third fate** for
handles, and D4 set the standard that each handle's disposition be "resolved with evidence rather
than carried forward". This one was carried forward without a recorded reason until review caught
it. Inlining remains available to a later change willing to own the corner-case shift; it would
drop the registry to six handles, all of which are then pure imperative timeline/transport
commands.

### D8 — Every enforcement instrument is proven non-vacuous, because all three were defeated in review

The draft shipped three checks. The panel defeated all three, and the failures were not variations
on one mistake:

- **The runtime absence assertion was 60–70% theatre.** It was to extend `AppShell.test.tsx`'s
  `V3_*` block — but that file module-mocks `SessionRoute` and `HomeSettingsModal`, so the owners
  of seven handles never mount there. Demonstrated: six of ten assertions pass on unconverted
  `main`. And the four that *do* fail today fail for an unrelated reason — the file's own
  `afterEach` assigns `window.X = undefined`, and assigning `undefined` **creates** the property,
  so `'X' in window` is `true`. The `V3_*` precedent works only because those globals were
  AppShell-owned. Copying its shape to handles owned by mocked-out components copies the syntax
  and drops the semantics.
- **The static check was defeated by five mutations, all typechecking cleanly.** The strongest —
  `declare global { var X }` plus bare-identifier assignment — defeats *both* halves at once and
  restores a fully working, correctly typed global bus. Bracket access through a cast alias,
  `Object.assign(globalThis, …)`, an aliased `globalThis`, and a bare-identifier *read* also
  survive. Decisively, **a brand-new eleventh handle name is invisible**, because the check
  enumerates the ten retired names — which is the entire point of the change, unguarded. This is
  the repo's own standing lesson landing on this change: *a guard that enumerates the attacks it
  was shown is not a guard.*
- **The "nothing was lost" comparison could not run.** Its before-image counted `window.<Handle>`
  occurrences; after the change that instrument returns **zero everywhere by construction**. Worse,
  39 of the 48 occurrences are stub *installs* — the actual assertions run against local mock
  variables that appear in no occurrence count. The mechanism guarding the change's highest-risk
  failure mode was measuring the wrong thing.

**Ruling: the spec makes non-vacuity a requirement rather than leaving it to implementation.** All
three are rebuilt on the properties `web/src/queryKeyFactories.repo.test.ts` already demonstrates —
root derived from `import.meta.url`, an explicit non-zero examined-file assertion, and a
real-filesystem mutation pair proving the guard fires and does not always fire. The precedent
`walk()` swallows `readdirSync` errors and returns its accumulator, so a wrong root yields zero
files and a green pass; that is the specific trap the non-vacuity assertion exists to catch.

The write scan becomes an **AST-based scan (`ts.createSourceFile`, no type-checker) over every
assignment and mutation whose target resolves to a global object** — `window`, `globalThis`,
`self`, `top`, or a local alias of any of those (including a transitive alias-of-alias chain),
through dot access, bracket access (literal or computed key), `Object.assign`/
`Object.defineProperty`/`Reflect.set` (reached directly or through a destructured/aliased
reference), and every assignment operator `ts.isAssignmentOperator` recognizes — including the
logical-assignment forms `??=`/`||=`/`&&=` — allowlisting known platform builtins.

*Phase-5 correction, recorded here rather than left standing:* the original wording above this
paragraph called the scan "blind... every global-object property write." That claim was false —
task 5.1's implementation was a per-line regex scan, not a blind one, and the phase-5 review
demonstrated seven concrete, non-exotic write shapes that evaded it (`Reflect.set`, a
logical-assignment bracket write, a destructured `Object.assign` alias, a `.mts` file the
walker's extension filter excluded, `self`/`top` as unrecognized global aliases, a computed
bracket key, and a multi-line `Object.assign` call the per-line scan couldn't see whole). The
AST rebuild above is what makes "blind to write *shape*, not just to handle *name*" true rather
than aspirational — verified by re-running all seven survivors plus the original six D8
mutations against the rebuilt check (`.apply/phase-5-review.md`, "Phase 5 fix wave": 14 of 14
caught, each demonstrated red-before-green on the real tree). It still does not resolve a
global reference reached only through a function call's return value, a function-parameter
default, or `eval`/`Function`/`createRequire`-style indirection — none has a live instance in
`web/src` today, and the residual is stated rather than left implicit, matching this repo's own
precedent (`server/src/packageBoundaries.repo.test.ts` discloses the identical class of gap for
the identical reason). This is the same instrument the fact-check pass used to find the
`Home_*` family that prefix-anchored search had missed.

*Phase-5 fix wave 2 correction (recorded here for the same reason as the paragraph above — the
prior correction's own residual list was itself incomplete, the third occurrence of this shape
of defect in this change; see the process-observations ledger).* The re-review that scored fix
wave 1 "14 of 14 caught" found three more write-shape survivors on its very next pass, none
exotic: a write target selected by a ternary or short-circuit expression (`(cond ? window :
globalThis).X = fn`, `(maybeWindow() || window).X = fn` — `unwrap()` never peeled
`ConditionalExpression`/`BinaryExpression`), and a global reference exported from one file and
written to through an imported binding in another (`export const w = window;` in file A, `w.X =
fn;` in file B). All three are now closed: the write-target check peels conditional/short-circuit
branches (flagging the write if *either* branch resolves to a global) at every write site and
inside alias resolution itself, and the cross-file case is closed **at its source** — a module
that exports a name resolving to a global object is itself the violation, in the file the AST
scan can see, rather than attempting cross-file import resolution none of this instrument's
sibling `*.repo.test.ts` files perform. A fourth, self-invented attack during the fix
(`Object.defineProperties(window, {...})`, the multi-property sibling of `Object.defineProperty`,
absent from the original operation set) was also closed.

**Residuals, stated precisely rather than reused verbatim from the paragraph above** (the prior
statement of "call-return / parameter-default / `eval`/`Function`/`createRequire`" residuals is
still accurate and still current): closing the cross-file export case introduced its own new,
narrower residual — the export check resolves an exported name against its own file's alias set,
so it does not follow an alias re-exported under a second name through an intermediate file
(`a.ts: export const w = window;` / `b.ts: export { w as w2 } from './a';` / `c.ts: w2.X = fn;`);
`a.ts`'s own export is still flagged, so the *file* is still caught, just not at the final hop.
Separately, one more self-invented attack was found and **left as a disclosed, unfixed residual**
rather than patched: a `let`/`var` export declared without an initializer and reassigned to a
global in a later bare statement (`export let w: any; w = window;`) is invisible to alias
tracking, because that tracking only harvests declarations that already carry an initializer, and
a bare-identifier assignment target is not one of the write shapes the scanner checks. Closing it
would mean tracking every bare-identifier reassignment in a file as a potential alias source, a
materially larger change with its own new false-positive surface; none of these four residuals
(three original plus this one) has a live instance in `web/src` today. Full attack matrix, every
caught/survives result, and the real-tree red-before-green demonstrations live in
`.apply/phase-5-review.md`'s "Phase 5 fix wave 2" section.

**One further residual, recorded at the third re-review rather than deferred.** A CommonJS
`require('../index/AppShell')` inside a `.cjs`/`.js`/`.mjs` file **survives the boundary guard**.
Those extensions are walked by `CODE_EXTENSIONS` but never typechecked (the web workspace has no
`allowJs`), so such a violation is invisible to *every* gate, not merely to this one. No live
instance exists in `web/src` today. It is recorded here because incomplete residual disclosure has
recurred three times in this change — an accurate small gap is worth more than a clean-sounding
claim. (By contrast `import X = require(...)` is moot: `tsc` rejects it outright.)

**Fourth-round correction — the guard's claim, reframed (whole-branch audit, 2026-08-08).** The
guard has now been defeated in four independent rounds: the adversarial panel, the phase-5 review,
the phase-5 fix wave's own re-review, and this audit, which planted three live `AutoLogger_*`
writes through a property-chain alias and a parameter alias with the guard, `tsc`, and `biome` all
staying green. Closing those two classes would require whole-program alias analysis — tracking a
value across casts, function parameters, and property chains — which is disproportionate for a
repository-hygiene test. The ruling is to stop patching and fix the disclosure instead.

**What the check actually defends against.** It exists to catch **drift**: a future edit that
reintroduces `window.X = fn` because that is the path of least resistance, not because anyone is
trying to evade review. Against that threat — an ordinary, undisguised global write — the check is
complete and stays complete; every mutation that has defeated it across four rounds required
*deliberately* constructing an indirection the guard does not resolve. It is not, and was never
going to be, a defence against deliberate obfuscation.

**Every bypass known today, gathered in one place rather than scattered across four review
rounds:** a property-chain alias (`(window.self as unknown as Bag).X = fn`, `globalThis.window.X`,
`frames.X`, `document.defaultView.X`); a parameter alias (a function that receives `window` as an
argument and writes through the parameter); call-return indirection (a function returning a
global, written through immediately); a parameter-default alias (a global supplied as a
parameter's default value); `export let w; w = window;` reassigned later, and its non-exported
sibling `let g; g = window; g.X = fn`; a chained re-export hop (an alias re-exported under a
second name through an intermediate file); CommonJS `require()` inside a `.cjs`/`.js`/`.mjs`
file, walked but never typechecked because the web workspace has no `allowJs`; and, for the
sibling import-boundary guard rather than this write-ban guard, a dynamic `import()`.; and code-generation routes (`eval`, `new Function`, `createRequire`), disclosed earlier in this section and repeated here so this list is not read as shorter than it is

**No claim of exhaustiveness stands, here or anywhere else in this document.** Three successive
review rounds each found new survivors, and this fourth round found three more that are
typecheck-clean and lint-clean in minutes. The defensible claim is "catches the broad, undisguised
classes of global write" — never "proven complete," "catches every write," or "an eleventh handle
must fail it" (the Invariants section below carried that last phrase; it has been corrected to
match).

**Import-freedom test nuance, found at the audit fix re-review.** The test enforcing
"the registry module imports no other application module" uses `ts.isImportDeclaration`, which
matches **type-only** imports as well as value imports. That is stricter than the stated
cycle-safety rationale — a type-only import cannot create a runtime cycle. It can therefore only
produce a false red, never a false green, which is the same trade already accepted for the
over-broad `declare global` ban (R11). Recorded rather than narrowed.

### D9 — The registry lives under `pages/index/` (gate ruling E4)

The draft left this "to the phase" as requirement-neutral. It is neither.

All seven surviving handles, all their owners, and all their consumers live under
`web/src/pages/index/`. `web/src/shared/` has zero would-be consumers of this module and is
reachable from the `admin-users` entry, so placing a session-workspace coordination registry there
widens the shared surface — and the admin bundle — for nothing.

The cost is visible and accepted: because the test reset lands in `web/src/test/setup.ts`
(component `web-test-harness`), a `pages/index/` home creates a **new `web-test-harness → web-app`
edge** absent from `edges.snapshot.json`, requiring a deliberate snapshot regeneration.
`shared/` would have reused an existing edge. Choosing module placement to avoid a snapshot edit
would be the tail wagging the dog; the edge is regenerated and reviewed instead.

## Risks / Trade-offs

- [A no-behavior-change refactor that silently changes behavior] → D3 is escalated rather than
  adopted; the spec pins the behaviors as scenarios; the 48 test occurrences are rewritten to
  drive the same assertions through the new seam rather than deleted and re-authored.
- [`HomeSettingsModal.tsx:379` has no covering test] → `HomeSettingsModal.test.tsx` names only
  the retired `V3_closeSession`. A **characterization test lands before** that call site is
  reshaped, per the artifact rule that an untested seam is not covered by "existing suites
  pass". **General process rule (moved here from the delta spec — spec durability correction,
  I-3):** any seam lacking a covering test before this change SHALL receive a characterization
  test pinned to an observable that survives the conversion — never to the mechanism being
  replaced, since such a test must be rewritten alongside the code it characterizes and therefore
  protects nothing. This is an apply-time obligation, not a durable property of the shipped
  capability, so it belongs here rather than in the spec that syncs to the baseline.
- [Registry becomes a dumping ground] → **no mechanical mitigation ships.** The draft's
  "every retained handle has a reader" check was cut at the gate: it is structurally blind to the
  third fate E2 established — a handle that *has* a reader and should still not exist. Membership
  is review-enforced, and the standard is D4's, not "does something call it". Recorded as an open
  residual rather than a solved problem.
- [Rewriting 48 test occurrences masks a lost assertion] → the count of assertions per test file
  is verified **list-wise, not set-wise**, before and after. Step 4b's lesson: a set comparison
  cannot detect a lost duplicate.
- [`departureWatcher`'s ordering guarantee regresses invisibly] → it is pinned by
  `departureWatcher.test.tsx` and by four `web-session-routing` scenarios; the registry must be
  synchronous, and the spec states so as a SHALL rather than leaving it to the implementation.
- [StrictMode double-invocation double-registers] → spec'd as a scenario. Note the existing
  `web-session-routing` scenario "StrictMode double-invoke does not stop anything" already
  guards the highest-consequence instance.
- [A `declare global` block survives in a test file] → the spec's no-`declare global` scenario
  is scoped to **production and test** files under `web/src`, not production alone.
- [`web-docs` drift] → no module leaves `web/src`, and `web` is enrolled in
  `WORKSPACE_REGIMES`; the new module is a new file in an enrolled workspace, so its component
  glob coverage and `edges.snapshot.json` are **verified by running `docs:check`**, not assumed
  — step 4b's lesson that a report's gate-line is not evidence.
- [Scope drifted three times during drafting] → the final scope (10 handles + 2 event
  constants) was reached only after prefix-anchored search missed a second global family and a
  comment-inclusive grep over-counted call sites by two. The fact-check pass should re-derive
  the surface with an instrument that is **not** anchored on the `AutoLogger_` prefix.

## Migration Plan

Pure source restructuring inside one workspace. No data migration, no deployment step, no
schema or `DATA_DIR` change, no rollback concern beyond reverting the branch. The frozen
contract is untouched by construction — this change reaches no route module, no schema, and no
WebSocket frame.

## Open Questions

All six escalations were ruled at the 2026-08-08 gate (E1–E6; see the Panel & review log). What
remains open:

- **Open, and deliberately not settled here: may `web/` depend on the `@autologger/*` package
  graph?** D7 records three findings that move the evidence without deciding it. Independent of
  this change; `clientAggregates.ts`, its mirror, and its pinning test are untouched.
- **Open, with a decidable trigger: should the 1:N broadcast half get a typed bus?** D6 states
  three conditions under which the answer flips. Not a question for this change.
- **Named but not closed:** `scrollTimelineToSec`'s `totalSec?` parameter and
  `setManualScrubSec`'s `null` argument have no external caller — dead surface one level below
  handle granularity, surfaced by the panel and deliberately left. `EventLogSheet.test.tsx`
  restates `'autologger:reveal-event'`'s literal despite `revealEventInFeed.ts` exporting it;
  left for the bus change, since E6 cut the rule that would have governed it.

## Invariants a future reader must not "helpfully" undo

- **The registry is synchronous.** `web-session-routing`'s originator-scoped transport stop
  depends on the stop call landing before React re-renders. An async or batched invoke path
  breaks a requirement that does not mention the registry.
- **`departureWatcher.ts` stays outside React.** Its module-scope installation is deliberate
  (module evaluation happens once regardless of StrictMode's double-invocation); moving it into
  an effect reintroduces the double-registration and ordering problems its header documents.
- **The read-handle fallback stays in the caller** (D2). A default inside the registry makes
  "unmounted" indistinguishable from a real value.
- **`web-session-routing`'s "Legacy selection spine retired" is not subsumed.** The `V3_*`
  assertion and its live test remain in force independently (D5).
- **No `declare global` block for coordination returns**, in production *or* test code — the
  test direction is the one a future change will reach for first.
- **The campaign's "web split" was declined on measurement (D0), not deferred** — and declined as
  *poor value, not valueless*. A successor reading the campaign remainder line should read D0
  before proposing it, and should not repeat the falsified "single bundle" premise: `web/` is a
  two-entry MPA.
- **Identity-scoped teardown is forward insurance against a hazard that is unreachable today**
  (D3). Do not restate it as a defect that occurred. Its preconditions — one owner per handle at
  one render position, an unkeyed workspace, no concurrent-rendering boundary — are properties of
  the current tree, and `pages/index/` decomposition is expected to break them.
- **The registry has no unconditional clearing primitive.** The ineligible-ownership path
  unregisters *this owner's* handler. Adding a `clear(handle)` re-admits the clobber D3 forbids
  through a second door (D3).
- **`web/src/test/setup.ts` resets the registry after every test.** Under identity scoping a stub
  registered after its owner mounts survives that owner's unmount; this is load-bearing, not
  hygiene.
- **Every enforcement instrument carries a non-vacuity assertion and a mutation pair** (D8). All
  three of this change's draft checks were defeated in review; two of the three failed *silently*.
- **The coordination write-scan targets drift, not deliberate evasion.** It is a scan for
  undisguised global writes with a builtin allowlist, never an enumeration of the ten retired
  names — an ordinary eleventh handle, written the same way the first ten were, fails it. It does
  not resolve every alias shape a deliberately obfuscated write could use; the known bypasses are
  listed in D8 and are not exhaustive (D8).

## Panel & review log

- **2026-08-08 — adversarial panel** (4 heavyweight reviewers, distinct mandates — requirements /
  assumptions / failure & abuse / scope & simpler design — skeptical calibration, empirical probes
  run against the repo's real toolchain). **All four returned "do not gate as-is."** No reviewer
  challenged the change's premise; all four judged the registry the right mechanism. The damage
  was to the **justifications**, the **plan of record**, and **all three enforcement instruments**.

  **The escalated question, settled.** D3's reachability was refuted by **all four** reviewers
  independently, two by running React 19 probes. The mechanism-level hazard is real
  (`setup:A, setup:B, cleanup:A` across commits); every shape *this* tree produces is
  cleanup-first. Structural grounds: one owner per handle at one render position, `WorkspaceStatic`
  unkeyed so a session switch is a same-instance dependency change, `SessionRoute` gating the mount
  on `query.data`, and no `Suspense`/`lazy`/transition API/Offscreen anywhere in `web/src`.

  **Blockers/majors fixed in place:**
  - *The proposal's motivating defect was false* (scope, by mutation). `declare global` blocks
    **merge**, and TypeScript rejects mismatched members with `TS2717`, naming the declaring file
    and every consumer. "A change to one side is invisible to the other" was wrong; the duplication
    costs discoverability, not type safety. The Why is rewritten on the three grounds that survive
    — chiefly that **the coupling produces no import edge**, which no reviewer's cheaper
    alternative addresses and which the artifacts had never stated.
  - *D0's two premises were false* (scope + assumptions, both demonstrated). `web/` is a two-entry
    MPA (`index` 468 KB, `admin-users` 6.7 KB), and `pages/admin-users` imports react-query zero
    times — so a manifest *would* confine there. D0 is re-argued: the split is **poor value, not
    valueless**.
  - *The phase 3/4 partition stranded every handle* (scope + failure & abuse, demonstrated).
    Deleting `useZoomRail.ts`'s block per task 3.1 produced **12 typecheck errors across 7 files,
    none owned by that unit**. Root cause, sharper than "partition by role": **the declaration
    graph and the ownership graph are different graphs** — `AppShell.tsx` declares six handles and
    installs three. Repartitioned **per handle**.
  - *The 48 test-occurrence rewrites were assigned to no task at all* (scope). Phases 3–5 described
    only production edits. Now inside each per-handle unit.
  - *All three enforcement instruments were defeated* — see D8. The runtime assertion was 60–70%
    vacuous on unconverted `main`; the static check fell to five clean-typechecking mutations
    including a brand-new handle name; the "nothing was lost" comparison returns zero by
    construction and counted stub installs rather than assertions.
  - *`web-docs/model/components.ts` was missing from the edit set* (failure & abuse + assumptions,
    both produced the orphan failure). Its `web-test-harness` globs enumerate the four existing
    `*.repo.test.ts` files **by exact filename**; a fifth is a hard `docs:check` failure. Worse,
    the coverage gate reads **git-tracked** files, so `docs:check` run before staging is a
    meaningless green — and task 7.1 told an implementer to do exactly that.
  - *Requirement 1 was over-quantified* (requirements). Read literally it forbade
    `AudioClipsProvider`, `audioPlayerRef`, and the shared query client — all live and all
    deliberately untouched. Scoped to 1:1 handles with an explicit carve-out.
  - *The ineligible-ownership path re-admitted the clobber* (requirements + failure & abuse). The
    branch never registered a handler, so it has no identity to match; an unconditional
    `clear(handle)` would reintroduce the defect D3 forbids at the site D3 called most exposed.
    The registry now provides **no unconditional clearing primitive**.
  - *"Unowned" and "registered to a no-op" were observationally identical* through the mandated
    API, so the ineligibility scenario was satisfiable by the implementation the tasks forbid.
    Added `isRegistered`, restoring what `expect(window.X).toBeUndefined()` gave.
  - *The characterization test was pinned to the mechanism under replacement* (requirements +
    assumptions) — it would have to be rewritten alongside the code it characterized, protecting
    nothing. Also unsatisfiable as scoped: `HomeSettingsModal.test.tsx` module-mocks
    `@tanstack/react-query` with `AppShell` unmounted, so the `['sessions']` invalidation does not
    occur there at all. Now pinned to the shared query client.
  - *Identity-scoped teardown's real behavior change runs opposite to the priced one* (assumptions).
    It changes the **test tier**: a stub registered after mount is not the identity the owner tears
    down, so it survives unmount. `web/src/test/setup.ts` — in no task — now carries a mandated
    registry reset.
  - *The prose instrument was aimed at an empty target* (assumptions). Task 7.3 targeted
    `CLAUDE.md`/`README.md`, which the fact-check had already proven silent, while **~19 comment
    lines across 12 files** in the code being edited describe the mechanism — including the very
    sentence D1 quotes as its constraint. The change learned instrument-class-4 and aimed it wrong.
  - *Two supporting claims in D3 were misreadings* — `departureWatcher.ts`'s child-first comment
    argues against firing the stop *from* a cleanup, not about one owner clobbering another; and
    the "most exposed" dependency-change site is structurally incapable of clobbering.
  - *Two stale "60"s survived inside the document that recorded the correction to 48* (assumptions).
    Fixed. The campaign's signature failure mode, inside its own fix.
  - *Minor corrections folded:* `Timeline.tsx`'s event name is a bare literal, not a declaration;
    `web-session-routing:133` is the requirement header, the quoted sentence is at :139;
    `transcribe.ts` carries four `session_id` spreads, not two; a bare `AutoLogger_` grep
    false-positives on the `AutoLogger_Small.webm` asset import; the "ten call sites" figure
    understates a production surface of 28 occurrences across 10 files.

  **Escalated to the gate, with rulings (2026-08-08):**
  - **E1 — D3's disposition.** RULED: **adopt identity-scoped teardown as forward insurance**, with
    the spec's past-tense defect narrative rewritten as a latent hazard, and a mandated registry
    reset in the shared test setup. Three options were put to the gate (strike / adopt / strike +
    dev-mode duplicate warning) rather than the draft's two, because refutation created a third.
  - **E2 — `Home_reloadSessionList`.** RULED: **inlined, not converted.** Its reader is `AppShell`'s
    direct child, already holding the same query client and already calling `invalidateQueries` on
    the following lines. This is a **third fate** the draft's decision structure never offered —
    a handle that has a reader and should still not exist. Registry drops to **seven** handles;
    `AppShell` ceases to be an owner; its six-handle `declare global` block is deleted outright.
  - **E3 — reader-less handles.** RULED: **removed.** Evidence stronger than the draft stated —
    `closeSettingsModal` duplicates an `onClose` prop already threaded to the same child, and
    `Home_clearSessionList` is the identical closure to its twin. Precedent: the 2026-07-27
    full-repo review removed three globals of this exact family with no fallout.
  - **E4 — registry location.** RULED: **`web/src/pages/index/coordination/`**, and the decision is
    **not** requirement-neutral as the draft claimed — it determines whether the test-harness edge
    already exists in `edges.snapshot.json`. The new `web-test-harness → web-app` edge is
    regenerated deliberately rather than choosing module placement to avoid a snapshot edit.
  - **E5 — D0.** RULED: **re-argue on true premises AND adopt a boundary guard.** The draft offered
    the gate a binary (full split or nothing) while conceding that direction enforcement was the
    split's real value and was "already true by construction" — which is the strongest argument for
    cheap enforcement, not against it. A fifth `web/src/*.repo.test.ts` costs one file and zero
    import rewrites. Without it the campaign ends with **zero enforced import boundary anywhere in
    `web/`** while the server carries four.
  - **E6 — D6's normative requirement.** RULED: **cut the requirement, keep the constants.** It
    failed the fourth prong of this repo's rider test, governed every future custom DOM event
    repo-wide for a mechanism this change declares a Non-Goal, shipped with no enforcing gate, and
    was already false on arrival (`EventLogSheet.test.tsx` restates an owned event's literal). The
    revisit condition in D6 stands verbatim.

  **Minors accepted as residual:** the "every retained handle has a reader" requirement is cut
  (structurally blind to E2's third fate); two policy-shaped scenarios with no observable trigger
  are cut; `scrollTimelineToSec`'s `totalSec?` parameter and `setManualScrubSec`'s `null` argument
  have no external caller — dead surface one level below handle granularity, not closed here;
  task 6.1's "every retained handle" static analysis would be brittle under import aliasing, so it
  is not built; `EventLogSheet.test.tsx`'s bare `reveal-event` literal is left for the bus change.

- **2026-08-08 — pre-panel fact-check pass** (light-tier reviewer, against live `main`
  `31aaba6`, clean tree). **43 claims enumerated as properties to verify: 30 CONFIRMED, 5
  CORRECTED, 1 FAILED, 6 UNVERIFIED-judgment, 1 UNVERIFIABLE-mechanically.** (The
  corrections list below enumerates seven items — the five tallied CORRECTED claims, the one
  FAILED claim, and two sub-findings the reviewer reported outside the tally.)

  Method notes worth keeping. The reviewer was explicitly instructed **not** to anchor on the
  `AutoLogger_` prefix, because that instrument had already missed a second global family during
  drafting. It instead ran a blind frequency scan of every `window.<Identifier>` /
  `globalThis.<Identifier>` occurrence in `web/src` and classified all 33 distinct identifiers
  found (23 DOM/BOM builtins, 1 retired `V3_closeSession`, 10 handles), then separately checked
  bracket access, destructuring, and `(window as any).X`. That closed the specific hole the
  drafting process fell into. It did **not** close a different one — see the CORRECTED items.

  **Corrections folded into all four artifacts:**
  - *The test-occurrence count was wrong: 60 → **48**.* The 60 came from a bare-identifier grep
    that also matched comments and `it(...)` description strings. Re-derived by enumerating the
    ten exact handle names and matching `window.<Handle>` with comment-leading lines excluded.
    **Method correction, found by the requirements reviewer:** an earlier version of this entry
    attributed the 52-vs-48 gap to prefix-matching in my own grep. That was wrong. A
    boundary-correct, non-prefix-matching grep returns **52 with comment lines included and 48
    with them excluded** — the gap is exactly 4 comment lines. A correction that mis-states its
    own method is worth recording as such. `timelineJump.test.ts`
    is 16 of the 48, not 21 of 60. Newly recorded and more useful than the total: **39 of the 48
    are assignments** — tests installing stubs on `window` — which is precisely what the
    registry's test seam replaces.
  - *The internal edge table mixed two methodologies under one "production" heading.* The two
    large cells (`pages→api 181`, `pages→shared 103`) only reproduce **test-inclusive**; the four
    small cells only reproduce **production-only**. Under the method that produces 181/103,
    `api→pages` is **1**, not 0 (`api/types.conformance.test.ts` imports from
    `pages/index/batchImport/`). Both columns are now published side by side, and D0's
    "zero back-edges" claim carries its production-code scope explicitly. The argument survives —
    a bundle-boundary claim is about production code — but it was stated without its qualifier.
  - **FAILED — D3's premise was false.** The draft asserted "every owner today tears down with an
    unconditional assignment". `AppShell.tsx`'s mount-once effect installs
    `AutoLogger_closeSettingsModal`, `Home_reloadSessionList`, and `Home_clearSessionList` and
    **never clears any of them** — its only cleanup is
    `removeEventListener('click', handleModalDismiss)`. Verified by reading the whole effect.
    **Three of ten handles have no teardown at all**, a third shape the design did not model.
    This does not weaken D3's corrective proposal (AppShell mounts once, so nothing competes to
    clobber), but it produced a real gap in the registry's contract — see the next item.
  - *D1's "5 of 10 call sites are in plain modules" was 4.* Only `timelineJump.ts` (×3) and
    `departureWatcher.ts` (×1) are React-free; the other four consumer files all import `react`.
    The `revealEventInFeed`-style clause counted a different mechanism. D1's conclusion is
    unaffected — the foreclosure rests on `departureWatcher` alone.
  - *D6 described `Timeline.tsx:451` as "declaring" the `autologger:timeline-sec` name.* It is a
    bare inline literal; only `MarkerNav.tsx:54` has a named constant. The defect and the fix are
    unchanged; the description was wrong.
  - *`web-session-routing:133` is the requirement header, not the quoted sentence* (line 139).
    `design.md` cited it correctly; `proposal.md` did not. Both now agree.
  - *`routers/transcribe.ts` carries four `session_id` spreads, not two* (D7's supporting
    detail).

  **The highest-value finding was outside the enumerated claims.** The registry's contract must
  not assume symmetric `register`/`unregister` pairs: `AppShell`'s conversion of
  `Home_reloadSessionList` is a **permanent registration with no matching unregister**, and any
  leak check, balanced-call assertion, or "no handler outlives its owner" rule would fail on the
  one production owner that is correct by construction. Folded into D1 as an addendum and — because
  `design.md` does not sync — into the spec as a normative SHALL plus a scenario, so a later
  reader cannot tighten it back into a pairing requirement.

  Also carried: `useZoomRail.test.tsx:56` independently reimplements the `?? 1` zoom fallback, so
  D2's "the fallback lives in the caller" is true of production but the pattern exists in a third
  place; and **no prose in `CLAUDE.md`, `README.md`, or `docs/` describes the window-global bus**,
  so task 7.3 is likely a no-op — its instruction to derive the list from `git grep` rather than
  memory already guards this.

  **Passed through un-vouched (judgment, not pre-checked — the panel retains full mandate):**
  D0's decline of the package split; D1's choice of a service locator given context is
  foreclosed; **D3's reachability against the live component tree** (the design itself flags this
  as unsettled); D4's removal of the reader-less handles and the argument that the frozen-surface
  rule does not reach window globals; D6's scope; and the `~284` rewrite estimate, which the
  reviewer declined to bless while the edge instrument was inconsistent (now resolved:
  test-inclusive 284, production-only ~190).

  **Process note.** The pass was asked to re-derive the handle set with a non-prefix-anchored
  instrument and did so successfully — while a *different* wrong-scoping bug (test-inclusion
  inconsistency) survived into the same document and had to be caught by the same pass. Fixing
  the instrument you know is wrong does not make the document right.
