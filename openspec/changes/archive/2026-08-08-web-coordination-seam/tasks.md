# Tasks — web-coordination-seam

Gate rulings E1–E6 (2026-08-08) are folded in. `file:line` anchors are orientation only —
locate every quoted construct by content before editing.

**Standing per-unit gate** (every unit, before its commit): `npm run typecheck` +
`npm test -w web` + `npm run lint`. **No unit may be knowingly red.**

**Partition rule — read before dispatching.** Units are partitioned **per handle**, never per
file. The declaration graph and the ownership graph are different graphs: `AppShell.tsx`
declares six handles while installing three, so deleting a "`declare global` block for the file
being converted" strands consumers elsewhere. Demonstrated during review: deleting
`useZoomRail.ts`'s block alone produced **12 typecheck errors across 7 files, none owned by that
unit.** A unit is `{ install site + every read site + every declaring block + every test
occurrence }` for one handle or one tightly-coupled handle group.

**`docs:check` reads git-tracked files** (`web-docs/scripts/check.ts` → `listTrackedFiles`). A
new file that is not staged is invisible to the coverage gate, so `docs:check` returns a
meaningless green. **Stage new files before running it**, in every unit that adds one.

## 1. Registry module and its contract

- [x] 1.1 Create the registry at `web/src/pages/index/coordination/` (gate ruling E4 — all seven
      surviving handles are session-workspace-owned and live under `pages/index/`). Declare the
      seven handle names and signatures in exactly one place; expose typed invoke functions that
      no-op when unregistered and return `undefined` for value-shaped handles; `register` /
      `unregister` scoped to the registering owner's identity; `isRegistered` for observability;
      a `reset` for tests. **The module SHALL import no other application module** (cycle
      safety — `navigation.ts → departureWatcher.ts` calls in at module scope).
- [x] 1.2 Unit-test the registry directly: unregistered invoke is a silent no-op; value-handle
      absence yields `undefined`; re-registration replaces; teardown clears; `reset` clears all;
      StrictMode shape (register → unregister → register) leaves exactly one live handler;
      **unowned vs registered-to-a-no-op are distinguishable**; identity-scoped teardown (a stale
      owner's teardown does not clear a newer registration; a current owner's does).
- [x] 1.3 Add the registry `reset` to `web/src/test/setup.ts`'s `afterEach`. **Load-bearing, not
      hygiene:** under identity-scoped teardown a stub registered after its owner mounts is not
      the identity that owner tears down, so it survives unmount into the next test.
      `SessionWorkspace.audioClipsSeam.test.tsx` uses exactly that register-after-mount pattern,
      with a comment saying the ordering is deliberate. **This unit creates a new
      `web-test-harness → web-app` edge** — `edges.snapshot.json` carries `web-test-harness →
      web-shared` but not this one, so `docs:check` fails until the snapshot is regenerated.
      Regenerate it deliberately and review the diff (D9/E4 accepted this cost). Stage the new
      file **and** the regenerated snapshot before running `docs:check` — the coverage gate reads
      git-tracked files.

## 2. Per-handle conversions — each unit green at its commit

Each unit converts one handle group end-to-end: install site, all read sites, all declaring
blocks, and all test occurrences, together.

- [x] 2.1 **Zoom group** — `getTimelineZoom` + `scrollTimelineToSec`. Owner `useZoomRail.ts`;
      readers `TimelineTicks.tsx`, `timelineJump.ts`, `useTimelineSeek.ts`; blocks in
      `useZoomRail.ts` and `TimelineTicks.tsx`; tests `useZoomRail.test.tsx`,
      `timelineJump.test.ts`, `useTimelineSeek.test.tsx`, `feedRowSeek.clipLayoutParity.test.tsx`,
      **and `MarkerNav.test.tsx` + `EventLogSheet.jumpColumn.test.tsx`** — both assign
      `scrollTimelineToSec` and would fail typecheck inside this unit once its declaration is
      deleted. Both are touched again in 2.2 for other handles.
      Keep `TimelineTicks`'s `Number.isFinite(z) && z > 0 ? z : 1` **in the caller** — do not
      simplify to `z ?? 1`, which would let `0`/`NaN` propagate into the label math. Note
      `useZoomRail.test.tsx` independently reimplements `?? 1`.
- [x] 2.2 **Scrub + seek group** — `setManualScrubSec`, `seekAudio`, `seekAudioAndPlay`. Owners
      `Timeline.tsx`, `SessionWorkspace.tsx`; readers `timelineJump.ts`, `useTimelineSeek.ts`;
      blocks in `Timeline.tsx`, `useTimelineSeek.ts`, and `AppShell.tsx`'s (for `seekAudio`);
      tests `timelineJump.test.ts` (16 occurrences), `useTimelineSeek.test.tsx`,
      `MarkerNav.test.tsx`, `EventLogSheet.jumpColumn.test.tsx`,
      `feedRowSeek.clipLayoutParity.test.tsx`, `SessionWorkspace.audioClipsSeam.test.tsx`.
      Preserve `timelineJump`'s seek-only/ungated/no-coverage-check semantics and
      `useTimelineSeek`'s play-capable branch — they are deliberately NOT layered on each other.
      **Preserve the negative guard** at `feedRowSeek.clipLayoutParity.test.tsx`'s
      `.not.toHaveBeenCalled()`: it is the only test holding baseline `web-session-console`'s
      "a jump with no covering recording moves the playhead only".
- [x] 2.3 **Transport stop** — `stopTransportIfNeeded`. Owner `SessionWorkspace.tsx` (conditional
      ownership on `[sessionId, isRolling, blocksMedia]`); readers `departureWatcher.ts`; blocks
      in `SessionWorkspace.tsx` and `AppShell.tsx`; tests `departureWatcher.test.tsx`,
      `TransportControls.test.tsx`, `AppShell.test.tsx`. The ineligible branch
      (`!sessionId || blocksMedia || !isRolling`) must **unregister this owner's handler**, not
      register a no-op and not clear unconditionally. **Do not move `departureWatcher` into
      React** — its module-scope install and synchronous pre-commit firing are what
      `web-session-routing`'s originator-scoped stop depends on, and it must resolve the handle at
      **call** time, never capture it at import time.
- [x] 2.4 **Event invalidation** — `invalidateEvents`. Owner `SessionWorkspace.tsx`; reader
      `useRecoveryStopWarning.ts` (inside a `.finally()` after the stop POST — the one handle
      whose invoke can land after its owner unregisters); blocks in `useRecoveryStopWarning.ts`
      and `AppShell.tsx`; test `useRecoveryStopWarning.test.tsx`.

## 3. AppShell stops being an owner (gate rulings E2 + D4)

- [x] 3.1 **(red-first TDD test, not a characterization test — dispatch as one unit with 3.2.)**
      Pinned to the post-inline shape, this test is necessarily **red against pre-change code**:
      today the `['sessions']` invalidation happens only through `AppShell`'s closure, and
      `AppShell` mounts in no environment where `HomeSettingsModal` is testable. Write it for the
      settings-modal session-list refetch, pinned to
      the **shared query client** (`invalidateQueries` with the `['sessions']` key) — *not* to
      `window.Home_reloadSessionList`. A test asserting the mechanism under replacement must be
      rewritten alongside the code it characterizes and protects nothing. Note
      `HomeSettingsModal.test.tsx` module-mocks `@tanstack/react-query` with a shared
      `invalidateQueriesMock`, and `AppShell` does not mount there — so the observable must be
      chosen accordingly. Verify the test fails if the refetch is removed.
- [x] 3.2 Inline `Home_reloadSessionList` at `HomeSettingsModal.tsx` as a direct
      `queryClient.invalidateQueries({ queryKey: ['sessions'] })` — the component already holds
      the same client and already calls it on the following lines; `AppShell.tsx` uses the
      identical inline form elsewhere. Delete `AutoLogger_closeSettingsModal` (a duplicate of the
      `onClose` prop already threaded to the same direct child) and `Home_clearSessionList` (the
      identical closure to its twin). Delete `AppShell.tsx`'s `declare global` block — **the last
      `Window` augmentation**. 3.1 stays green throughout.

## 4. Custom event name ownership (gate ruling E6 — constants only, no normative rule)

- [x] 4.1 Give `autologger:timeline-zoom-changed` one owning module with an exported constant;
      import it in `useZoomRail.ts` (dispatcher) and `TimelineTicks.tsx` (listener). Follow the
      shape `revealEventInFeed.ts` and `perfDebug.ts` already use. Fix `TimelineTicks.tsx`'s
      stale comment naming `session.js` as dispatcher — `session.js` does not exist in this repo;
      the dispatcher is `useZoomRail.ts`.
- [x] 4.2 Same for `autologger:timeline-sec` — a bare literal in `Timeline.tsx` (dispatcher) and
      a named constant in `MarkerNav.tsx` (listener). No dispatch or subscription mechanics
      change.

## 5. Enforcement — every check proven non-vacuous

Model all three on `web/src/queryKeyFactories.repo.test.ts`, which already carries the required
properties: root derived from `import.meta.url`, and a `describe('detection predicate (mutation
check — proves the guard actually fires)')` with a real-filesystem does-fire / does-not-always-fire
pair. Copy those **properties**, not just the file shape — the precedent `walk()` swallows
`readdirSync` errors and returns the accumulator, so a wrong root silently yields zero files and
a green pass.

- [x] 5.1 Static check: **no `declare global` block augmenting `interface Window` anywhere under
      `web/src`** (production and test), and no write to a non-builtin global-object property.
      The write scan must be a **blind scan of every `window.<Identifier>` / `globalThis.<Identifier>`
      allowlisting known platform builtins** — not an enumeration of the ten retired names. The
      following mutations were demonstrated during review to typecheck cleanly and must all be
      caught: `declare global { var X }` + bare-identifier assignment; bare-identifier read;
      bracket access through a cast alias; `Object.assign(globalThis, {...})`; aliased
      `globalThis`; **and a brand-new eleventh handle name**. Assert a non-zero examined-file
      count. Exclude `shared/utils/loadingVideo.ts`'s `AutoLogger_Small.webm` asset import by
      matching global-object *writes*, not the `AutoLogger_` prefix.
- [x] 5.2 Runtime absence assertion, placed where owners **actually mount**. `AppShell.test.tsx`
      module-mocks `SessionRoute` and `HomeSettingsModal`, so seven handles' owners never mount
      there — demonstrated during review: six of ten assertions pass unchanged on unconverted
      `main`, and the four that "fail" do so only because that file's `afterEach` assigns
      `undefined`, which *creates* the property. Every assertion needs a demonstrated
      red-before-green.
- [x] 5.3 Add `web/src/webBoundaries.repo.test.ts` (gate ruling E5): pin `pages → api → shared`
      as one-way in production code, and `pages/admin-users ↛ pages/index`. Same non-vacuity and
      mutation-pair properties as 5.1.
- [x] 5.4 Add each new root-level `web/src/*.repo.test.ts` to `web-docs/model/components.ts`'s
      `web-test-harness` globs, which enumerate the existing four **by exact filename**. An
      unlisted fifth is a hard `docs:check` orphan failure — demonstrated twice during review.
      Stage, then run `docs:check`.

## 6. Assertion-preservation audit

- [x] 6.1 Verify no assertion was lost across the test rewrites by comparing, per test file, the
      **list of assertion targets and `it(...)` names — list-wise, preserving duplicates, never
      set-wise** (a set comparison cannot detect a lost duplicate; step 4b's lesson) before and
      after — *not* `window.<Handle>`
      occurrence counts, which are zero after the change by construction and which counted stub
      installs rather than assertions. 39 of the 48 pre-change occurrences were installs; the real
      assertions run against local mock variables that appear in no occurrence count.

## 7. Prose and final gates

- [x] 7.1 Update the **~19 comment lines across 12 source and test files** that describe the
      window-global mechanism — derived by `git grep`, not from memory. These live in the files
      this change is already editing, including `departureWatcher.ts`'s header (the sentence D1
      quotes as its constraint), `timelineJump.ts`'s "declared on `Window` via merged
      `declare global` blocks in …", and `useTimelineSeek.ts`'s "declared in AppShell.tsx … same
      pattern as the other `AutoLogger_*` globals" (doubly stale — that handle is declared in
      `AppShell` but written by `SessionWorkspace`). `CLAUDE.md` and `README.md` are **silent** on
      the bus — confirmed by the fact-check pass — so no edit is expected there.
- [x] 7.2 Root gates, output recorded rather than claimed: `npm run typecheck`, `npm test`,
      `npm run lint`, `npm run docs:check` — **with all new files staged first.**
- [x] 7.3 `npm run e2e` (chromium + login-gate) and `npm run e2e:visual`. Baselines were last regenerated 2026-08-07 (`d23e8b9`) and this change alters no UI, so any visual diff is branch-induced signal and
      must be explained, not re-blessed.
- [x] 7.4 Attach the new `web-coordination-seam` capability in `web-docs/model/components.ts` at
      archive, per CLAUDE.md — an unaccounted baseline capability is a hard `docs:check` failure.
