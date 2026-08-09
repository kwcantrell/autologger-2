## Why

`web/` coordinates between distant components through **ten mutable `window` globals**, and the
coupling they create **produces no import edge**. `departureWatcher.ts` calls into
`SessionWorkspace.tsx`'s handler with zero import between the two files — invisible to the module
graph, to any static analysis, and to `web-docs`' `edges.snapshot.json`. That is the defect: real
dependencies that the architecture cannot see.

Two further costs compound it. **Tests mutate process-global state** — 39 of the 48 test
occurrences are assignments installing stubs on `window`, with no reset between tests. And the
handles live in the **ambient global namespace**, where anything anywhere can call or clobber
them.

What is *not* wrong with the status quo, stated because an earlier draft of this proposal claimed
it and it is false: the seven `declare global` blocks do **not** drift silently. TypeScript merges
them and rejects mismatched members with `TS2717`, naming both the declaring file and every
consumer — verified by mutation. The duplication costs discoverability, not type safety. Any
alternative justified only by "one declaration site" is therefore not worth doing.

This is the last place in the repository where components couple by construction rather than
through a declared seam. The four preceding campaign steps gave the server a layered,
test-enforced package graph; the equivalent defect on the web side is not a missing package — it
is a missing seam, and it is tractable: **ten reader call sites across six files** — though the
full production surface is 28 `window.<handle>` occurrences across 10 files once installs and
teardowns are counted, and 48 more across 11 test files.

The repository has already done this once. `web-session-routing`'s "Legacy selection spine
retired" requirement records the retirement of an earlier global family
(`window.V3_selectSession` / `window.V3_closeSession`) with a scenario asserting they are
undefined, pinned by a live `expect('V3_selectSession' in window).toBe(false)` assertion. This
change applies that pattern to the family that replaced it — while noting that the precedent's
assertion was meaningful only because those globals were AppShell-owned, which is not true of
most of these (see design D8).

## What Changes

- **A new typed coordination registry** at `web/src/pages/index/coordination/` becomes the single
  home of the one-to-one coordination contract. Owners register a handler and unregister on
  teardown; callers invoke exported typed functions that are a silent no-op when nothing is
  registered, preserving today's optional-chained semantics exactly.
- **All ten globals cease to exist** and the `Window` augmentation is deleted outright, along with
  all seven `declare global` blocks. **Seven handles move into the registry; three do not** —
  `AutoLogger_closeSettingsModal` and `Home_clearSessionList` are removed as reader-less, and
  `Home_reloadSessionList` is **inlined** at its call site, which already holds the same query
  client. `AppShell` ceases to be an owner at all.
- **React-external callers stay first-class.** `departureWatcher.ts` runs at module scope and fires
  synchronously pre-render/pre-commit — a documented ordering guarantee. React context is therefore
  foreclosed; a module-scoped registry preserves it (design D1).
- **Identity-scoped teardown ships as forward insurance, not repair.** All four panel reviewers
  refuted the hazard's reachability in the current tree. It costs ~3 lines and becomes live the
  moment `pages/index/` is decomposed — the acknowledged next step (design D3).
- **Tests drive a real seam.** Forty-eight occurrences across eleven test files are rewritten — 39
  of them assignments installing stubs on `window` — and the shared test setup gains a mandated
  registry reset, which identity-scoped teardown makes load-bearing rather than hygienic.
- **Two duplicated custom-event name constants gain owning modules**, following the pattern
  `revealEventInFeed.ts` and `perfDebug.ts` already use. **No normative rule and no pub/sub
  abstraction ship** (design D6).
- **A `web/src` boundary guard is added** pinning `pages → api → shared` as one-way and
  `pages/admin-users ↛ pages/index` — one file, zero import rewrites, delivering the direction
  enforcement the declined workspace split was wanted for (design D0).
- **Every enforcement instrument is proven non-vacuous** — root derived from `import.meta.url`, a
  non-zero examined-file assertion, and a mutation pair. All three of the draft's checks were
  defeated in review (design D8).

## Capabilities

### New Capabilities

- `web-coordination-seam`: cross-component coordination in the web app travels through a
  single typed registry with a declared owner, not through ambient `window` properties;
  registration lifecycle, absence semantics, React-external caller support, the negative assertion
  that the ten named globals are undefined, the mechanically-enforced `pages → api → shared`
  import direction, and the non-vacuity properties every check in this change must carry.

### Modified Capabilities

None. Every baseline requirement describing the *behavior* these globals implement is written
mechanism-agnostically and stays true verbatim — `web-session-routing:139` says "SHALL invoke
the same stop-transport-if-needed behavior", naming no global. Verified by searching all of
`openspec/specs/` for `AutoLogger_` / `Home_reloadSessionList` / `Home_clearSessionList`:
**zero matches.** The globals are implementation, not published behavior. Design D5 records
why the negative assertion lands in the new capability rather than by extending
`web-session-routing`'s "Legacy selection spine retired" requirement, and confirms that
requirement stays in force unchanged.

## Impact

**Contract impact: none.** No HTTP route, JSON shape, status code, export body, header/range
semantic, or WebSocket message shape or emission semantic is touched. This change does not
reach `server/`, `companion/`, `e2e/`, or `packages/` at all. The ten globals are **not an
external surface**: `AutoLogger_*` and `Home_*` have zero references in `e2e/`, `companion/`,
`server/`, `web-docs/`, and `playwright.config.ts`.

**Edit set** — measured on `main` at `31aaba6`, `*.ts`/`*.tsx` under `web/src`, comment lines
excluded from call-site counts:

| | count | detail |
|---|---|---|
| globals removed | 10 | 8 `AutoLogger_*` + 2 `Home_*` |
| install sites | 10 | across 4 owner files |
| reader call sites | 10 | across 6 consumer files |
| `declare global` blocks | 7 | 3 globals declared in 2 blocks each |
| reader-less globals | 2 | `AutoLogger_closeSettingsModal`, `Home_clearSessionList` |
| production files | 11 | 10 owners+consumers, plus `MarkerNav.tsx` for the event constants |
| test files | 11 | 48 occurrences (39 assignments, 9 reads) |
| new modules | 3 | the registry, the boundary guard, the coordination static check |
| duplicated event constants | 2 | across 4 files, all already in the set above except `MarkerNav.tsx` |

Production files: `AppShell.tsx`, `SessionWorkspace.tsx`, `Timeline.tsx`, `useZoomRail.ts`
(owners); `departureWatcher.ts`, `timelineJump.ts`, `useTimelineSeek.ts`, `TimelineTicks.tsx`,
`useRecoveryStopWarning.ts`, `HomeSettingsModal.tsx` (consumers). The event-constant work adds
`MarkerNav.tsx` — the eleventh production file — and re-touches `Timeline.tsx`,
`useZoomRail.ts`, and `TimelineTicks.tsx`, which are already in the set.

**Coverage gap carried into the change:** `HomeSettingsModal.tsx:379`'s
`Home_reloadSessionList?.()` call has **no test naming it** — `HomeSettingsModal.test.tsx`
mentions only the retired `V3_closeSession`. That path is rewritten with no existing test to
catch a regression; a characterization test lands with it.

**`web-docs/model/components.ts` IS edited** — an earlier draft said this change touched nothing
outside `web/`. Its `web-test-harness` globs enumerate the existing four `web/src/*.repo.test.ts`
files **by exact filename**, so each new one must be listed or `docs:check` fails as an orphan
(demonstrated twice in review). The archive commit additionally attaches the new capability there.
Note the coverage gate reads **git-tracked** files, so `docs:check` run before staging is a false
green. `web/` still gains no dependency and remains a single workspace.

## Non-Goals

- **Splitting `web/` into workspace packages.** Examined and declined as **poor value, not
  valueless** — its plausible beneficiary is `admin-users`, a 4-file page, and ~190 production
  import-specifier rewrites plus a three-site type-only cycle break is bad value for confining
  four files. A boundary guard delivers the direction enforcement instead, at one file (D0).
- **Decomposing `pages/index/`** (70% of web's LOC). Removing the globals is a precondition for
  it; doing it is not in this change.
- **Whether `web/` may depend on the `@autologger/*` package graph** — the step-5 question
  inherited from step 4b. It is independent of this change (the seam touches no package), and
  it stays open. `clientAggregates.ts`, its 254-LOC mirror, and its pinning test are untouched.
- **A typed pub/sub layer for custom DOM events, and any normative rule about event names.** Only
  the two *duplicated name constants* are given owners, as cleanup. An event bus is **deferred with
  a stated revisit condition, not declined** — it addresses the 1:N broadcast half of the coordination surface,
  which the registry structurally cannot serve, and that half is already live
  (`autologger:reveal-event` has two independent listeners). See design D6.
- **Any change to the behaviors the globals implement** — seek, scrub, zoom, marker
  navigation, feed jumps, transport stop, event invalidation, and session-list refetch all
  behave identically. The one candidate exception (D3's teardown identity) is an Open Question,
  not an assumed licence.
- `server/`, `packages/`, `companion/`, `e2e/`.
