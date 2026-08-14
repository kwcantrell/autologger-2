# Design: settings-modal-mount-cost

## Context

### Current state, measured on `main` @ `3eaca8f`

The request that opened this change framed the Settings-modal lag as "a large lag spike due to a
series of linear fetches", remediable "via async function". Measuring that framing's nouns against
the tree contradicts it, and the correction is the reason this change exists:

| Claim in the framing | Measured | Derivation |
| --- | --- | --- |
| Opening the modal runs a series of fetches | **False.** The open transition issues no request | `HomeSettingsModal` reads one query — `useProfile()` (key `['profile']`, `staleTime: 30_000`) — which `AppShell` already calls at boot (`AppShell.tsx:50`), so it is cache-satisfied before the modal can open. Its other two hooks are `useMutation`, which fire only on explicit `mutateAsync`. Across the whole render subtree — `EventButtonsTable`, `EventInstructionModal`, `EventOptionsModal`, `Select`, `FpsSelect`, `Popover`, `RadioGroup`, `ConfirmDialog`, `Dialog` — there is no other `useQuery`/`apiFetch`/`fetch(` call |
| The fetches are sequential (a waterfall) | **Not applicable.** There is no second fetch to be sequential with | as above |

What the open actually costs is synchronous mount work. The panel refined the initial reading
twice, and both refinements changed the fix:

- `HomeSettingsModal` is rendered unconditionally at `AppShell.tsx:332`. Radix keeps a closed
  dialog's children unmounted (`Dialog.tsx` uses no `forceMount`), so nothing below it exists
  until `isOpen` flips.
- All four tab panels are rendered on every pass and hidden with the `hidden` **attribute**
  (`HomeSettingsModal.tsx:560/729/769/784`), so the Event Buttons panel mounts even though the
  modal always opens on General.
- **The spike is a reopen phenomenon, not a first-open one.** `showDrafts` starts `{}` and the
  reset effect sets `initialized = false`, so on a *first* open `currentDraft` is `undefined` and
  the Event Buttons panel renders its "Select a show above to edit its event buttons" hint — the
  table mounts only on a second commit, after the init effect populates the drafts. `showDrafts`
  is **not** cleared on close (the reset effect clears only `initialized`, `initialSnapshot`, and
  `activeTab`), so every subsequent open mounts the fully-populated table inside the opening
  commit.
- **The dominant per-row cost is the `Select`, not the `Popover`.** Each row renders both
  (`EventButtonsTable.tsx:494` and `:536`), but they are not equivalent: `@radix-ui/react-select`
  renders `SelectContentFragment` when closed, portalling the **entire item subtree** into a
  detached `DocumentFragment` (`react-select/dist/index.mjs:284-298`), so a closed Select fully
  mounts Trigger + Viewport + every Item with its ItemText/ItemIndicator. The `Popover`'s content
  is `Presence`-gated and genuinely unmounted while closed. The row cost is therefore
  approximately "one full Select item tree", multiplied by the number of event buttons.

### The causal step, now measured (2026-08-13)

The draft carried this as inference. It has since been profiled against the **production** serve
path (`npm run build && npm run start`) on the reporter's own `server/data`, driving a real
Chromium via CDP with the React DevTools hook. Task 1.2's halt-gate **passes**: the dominant cost
is the modal's own mount, and specifically the Radix `Select` item trees.

| Measurement | Result |
| --- | --- |
| Long tasks while idle, 12 s (spans 2+ `useSessions` poll cycles) | **none** |
| Long task on the settings-open click | **one, 70 ms** |
| React work in that commit | **6,141 renders — 1,337 mounts + 4,804 re-renders — across 107 components**, byte-identical across two consecutive runs |
| Frame rate during the commit | avg 37 fps, **min 15**, 109 frames under 30 fps |
| `SelectTrigger` mounts | **12** — exactly the modal's twelve Selects (studio, show, suffix, FPS, copy-from-show, plus one per event-button row × 7 rows) |
| `SelectItem` / `SelectItemText` / `SelectItemIndicator` / `SelectItemProvider` / `SelectCollectionItemSlot`(+`.Slot`) | **60 mounts and 240 re-renders each** — ~360 mounts and ~1,440 re-renders of Select *item* internals alone |
| `SelectContentFragment` | 12 mounts, 60 re-renders — the closed-Select-mounts-its-items mechanism, observed live |
| `GET /api/sessions`, `GET /api/profile` server time | 1–2 ms — no server-side cost, the list reads the catalog index |

The `SelectTrigger` count matching the modal's Select inventory exactly is what pins attribution:
every Select mounted in that commit belongs to the modal, and the item-level components dominate
the mount count. **This measured with only 7 event-button rows and still cost 70 ms** — above the
50 ms jank threshold — so the cost grows from there with show size. D3 (lazy per-row control) is
therefore aimed at the measured dominant cost, not an inferred one.

**Caveat on attribution granularity:** a production build minifies app component names, so
first-party components appear as single letters in the profile and cannot be told apart by name.
Attribution above rests on the Radix component names (which survive via `displayName`) and on the
`SelectTrigger` inventory match, not on reading first-party names.

### The session-data dependence, measured (2026-08-13) — a second, larger cost

> **WITHDRAWN (2026-08-13, post-apply).** This section's headline finding — a "defeated memo"
> causing +11,097 re-renders of the already-mounted workspace — **does not hold up**. The render
> counts below came from the `agent-browser react renders` instrument, which was independently
> found to over-count for this app (singleton components reported as `2 insts`, ancestors with
> `self: -` despite "9 renders", counts that scale with recording-window length rather than actual
> work). Ground truth — a `console.log` as the first statement of each render body, which cannot
> under-count — shows `SessionWorkspace` renders **zero** times on a settings click, with or
> without the `useCallback` fix below, and the fix did not move this section's own tool-reported
> totals either (17,238 before and after). **`WorkspaceStatic`'s memo was never actually defeated
> for this interaction.** See D0 (rewritten) and `.apply/phase2-diagnostic.md` for the full
> reconciliation. The section below is kept as the historical record of how the finding was
> reached — the mount-count and long-task numbers stand, but every re-render count, the "root
> cause" causal claim, and the "not settings-specific" generalization that follow **do not**.

The reporter observes the lag scaling with `server/data/sessions`, and notes it reproduces with
session `ed1413e0-…` open. The first profile was taken from `/` with **no session open**, so it
could not have exercised that path at all. Re-profiling with that session's workspace mounted
(66 events, **15,150 transcript words**, 1,049 paragraphs, 337 sentiment rows, 3.4 MB DB):

> **Timing correction (apply-time, task 1.3).** The millisecond figures in the two tables of this
> section were taken with the React DevTools hook enabled, which inflates render time. Re-measured
> without it: from `/` the settings click costs ~37 ms click→paint and produces **no long task at
> all**; with a session workspace open it produces a **67–143 ms long task on every run** (this
> long-task finding is real and independent of the withdrawal above — see D0.1). The render counts
> in the table below are **not** reliable per-component evidence — see the withdrawal notice at
> the top of this section — so no structural conclusion is drawn from them here. Full baseline:
> `.apply/profile-before.md`.

| Settings-open click | No session open | Session workspace open |
| --- | --- | --- |
| Long task (DevTools-inflated; see correction) | 70 ms | **101 ms** |
| Total renders | 6,141 | **17,238** |
| Mounts | 1,337 | **1,337 — identical** |
| Re-renders | 4,804 | **15,901 (+11,097)** |
| Components | 107 | 148 |
| Min FPS | 15 | **10** |

**The mount count is identical**, so the modal's own subtree costs the same in both. At the time
this was written, the entire +11,097 delta was read as *re-renders of the already-mounted
workspace* (`Tooltip` / `TooltipTrigger` / `TooltipPortal` / `TooltipProvider` at 142 instances,
639 re-renders each; event-row components at 132 instances, 594 re-renders, top change reason
`props.onDelete`). **That reading is withdrawn** — see the notice at the top of this section; the
instrument producing these per-component counts over-counts, and ground truth shows the workspace
does not re-render on this click at all.

**Originally-claimed root cause — a defeated memo (withdrawn).** The reasoning below was the
change's working theory and motivated the D0 fix, but ground-truth measurement (`.apply/
phase2-diagnostic.md`) shows `WorkspaceStatic`'s memo bails correctly on this interaction and was
never actually defeated here — so **none of the causal claims in this paragraph or the next hold
as fact**, though they remain the record of the reasoning that led to the (still-correct, for
other reasons) fix in D0. `WorkspaceStatic` is `memo()`'d *expressly* to isolate the workspace
from this modal (its own comment says so). `SessionRoute` is not memoized, and `AppShell` rendered
it with `onOpenMobileNav={() => setRailOpen(true)}` — an inline arrow, fresh identity on every
`AppShell` render — which `SessionRoute` forwards unchanged into `WorkspaceStatic`. The
neighbouring callbacks (`handleOpenSettings`, `handleCloseSettings`, `handleOpenNewSession`) were
already `useCallback`'d; this one prop was left inline. Giving it the same treatment is a genuine
prop-stability fix (see D0) — it just is not established to have changed how often anything
re-renders.

The "not settings-specific — any `AppShell` state change would do the same" generalization
likewise inherits the same withdrawal and is not asserted as fact.

**Not investigated (and not needed):** the rail's own per-card cost. `V6Rail` is likewise
un-memoized with inline arrow props, so `SessionCard`s re-render on the same click; with one
session in the active show this contributed nothing measurable. Left as a note, not a task.

### Constraints

- **The Settings modal's drafts live in `HomeSettingsModal`'s own state** (`showDrafts`,
  `initialSnapshot`). `EventButtonsTable` holds transient UI state only (`dragIdx`, `dragOverIdx`,
  `openColorFor`, `openInstructionFor`, `editingOptsFor`, `copyFromId`), has **no `useEffect` at
  all**, and never populates parent state on mount. `handleSave` builds `show_updates` from
  `showsForStudio` + `showDrafts`, both modal-owned. Deferring the table cannot drop a save — the
  panel attacked this property from three directions and could not break it.
- **`web-session-console` pins the workspace feed panels as always-mounted**
  (`openspec/specs/web-session-console/spec.md:19`), echoed by `ai-v2-dashboards/spec.md:363`.
  Nothing in this change touches them, but the rule is recorded so the discipline written here is
  not later generalized onto them.
- **The frozen HTTP/WS contract is untouched.**

## Goals / Non-Goals

**Goals:**

- Opening the Settings modal — including reopening it — commits only the content the user is
  looking at.
- The Event Buttons tab click is attacked at the cost itself (the lazy per-row `Select`, D3)
  rather than merely inheriting the mount that deferral removed from the open. **Measured
  outcome (task 5.2):** the click did not get faster — 13.1 ms → 15.9 ms, a +2.8 ms regression —
  because deferral moves the table's mount onto that click and D3 only bounds the added cost, it
  does not eliminate it. Accepted as an expected residual; see the Outcome section.
- The deferral discipline is written down in a form that a future refactor cannot silently undo.

**Non-Goals:**

- Code-splitting / deferred module loading (split out to `web-boot-split-boundaries`).
- Any change to the six workspace feed panels.
- Any data-fetching change.
- Virtualizing the event-button rows; reworking the dirtiness derivation or the discard guard.
- Visual or behavioral redesign of any control.

## Decisions

### D0 — Keep the shell-to-workspace boundary memoizable (claim withdrawn and rescoped)

> **This decision was rewritten on 2026-08-13 after its evidence collapsed.** As originally
> written it claimed the largest measured win in the change: +11,097 re-renders and 70 ms → 101 ms,
> caused by `onOpenMobileNav`'s inline arrow defeating `WorkspaceStatic`'s `memo`. **Those render
> counts were an artifact of the `agent-browser react renders` instrument.** Ground truth
> (`console.log` as the first statement of the render body) shows `SessionWorkspace` renders
> **zero** times on a settings click, `AppShell` 1–2, `HomeSettingsModal` 3 — and the fix did not
> move the tool's numbers either (17,238 before and after). See `.apply/phase2-diagnostic.md`.

What survives is a genuine but modest defect: `AppShell` passed `SessionRoute` an inline
`onOpenMobileNav={() => setRailOpen(true)}` arrow, forwarded unchanged into the memo'd
`WorkspaceStatic`, so shallow comparison could never bail. Its three sibling handlers were already
`useCallback`'d; this one was not. Giving it the same treatment restores the boundary's ability to
bail out.

**The claim is now scoped to exactly that**: boundary props stay referentially stable across shell
renders. No performance consequence is asserted, because none has been measured on an instrument
this change trusts. The fix is kept rather than reverted because it is correct, one line, has a
mutation-checked test, and removes a real inconsistency — not because it is known to be faster.

**Alternatives considered.** *Revert it entirely*: defensible, and rejected only because the
underlying inconsistency is real and the test is cheap to keep. *Memoize `SessionRoute` too*:
unnecessary and unmotivated now that no re-render problem is known to exist there. *Restore the
performance framing once a better instrument is available*: that is a new investigation (see the
Dialog-open hypothesis below), not this decision.

**Residual: the YouTube import error modal trigger is spec'd but not tested.** The spec's second
scenario names five triggers (New Session, Batch Import, YouTube import error modal, settings
close, mobile rail toggle) because all five are genuinely `AppShell` state changes that cross the
same boundary and the requirement should describe the behavior the boundary owes, not the set a
test happens to cover. Task 2.1's test suite exercises four of the five and deliberately omits the
YouTube import error modal: reaching it requires overriding the shared `NewSessionModal`/YouTube-
mutation mocks to force a rejection, and it would exercise the *identical* mechanism (the same
`onOpenMobileNav`/`onNewSession` props, the same `AppShell` re-render, the same boundary check) as
the four triggers already covered — disproportionate scaffolding for a fifth exercise of the same
code path. Accepted as a residual gap between spec and test coverage, not silently narrowed away.

### D0.1 — The session-dependent cost is still unexplained

Independent of the withdrawn render-count story, one measurement stands because it never used the
DevTools tool: `PerformanceObserver` reports **67–143 ms long tasks on every settings click with a
session workspace open, and none at all from `/`**. The jank is real and it scales with the open
session, but it is **not** React re-renders of the workspace.

Leading hypothesis, **untested**: DOM-proportional work in Radix Dialog's open path — `hideOthers()`
aria-hiding every sibling, `FocusScope` walking the tabbable tree, `react-remove-scroll`'s
`getComputedStyle` forced reflow. All three scale with mounted DOM size, which is far larger with a
workspace open. Nothing in this change addresses it; it is queued as follow-on investigation.

### D1 — Fix the measured cause (mount cost), not the reported one (fetch latency)

The framing's remedy — "convert components to async" — would not have touched the cost.

**Alternatives considered.** *Implement the request as stated* (parallelize fetches): rejected —
there are no fetches to parallelize. *Report the misdiagnosis and stop*: rejected — the lag is
real and reproducible; only its cause was misattributed.

### D2 — Defer tab content via a visited-tabs set, reset **during render**

A `Set<TabId>` seeded with `'general'`, added to on tab activation. Panel wrappers keep rendering
with today's `id` / `role="tabpanel"` / `aria-labelledby` / `hidden`; only their children are
gated.

**The reset must not live in the `isOpen` effect.** The component never unmounts between opens
(`AppShell.tsx:332` is unconditional, deliberately — `teams-settings-nav` D1), so `activeTab` and
`visitedTabs` survive a close. Resetting them in the existing passive `useEffect` would sequence a
reopen as: commit with the stale tab → **the table mounts** → effect fires → re-render → table
unmounts. That is strictly worse than today (same mount, plus an unmount and an extra render), and
it violates this design's own "never unmount a visited tab" invariant. The reset therefore uses
React's adjust-state-during-render pattern:

```tsx
const [prevOpen, setPrevOpen] = useState(isOpen);
if (isOpen !== prevOpen) {
  setPrevOpen(isOpen);
  if (isOpen) { /* reset activeTab, visitedTabs, initialized, initialSnapshot */ }
}
```

React re-runs the render before committing, so the stale-tab commit never reaches the DOM. This
also fixes a latent version of the same problem for `initialized`/`initialSnapshot`, which today
are reset one commit late.

Keeping the wrappers is not cosmetic: each tab control carries `aria-controls` pointing at its
panel id (`HomeSettingsModal.tsx:544`), and dropping the element would strand that reference.

**Alternatives considered.** *Render only the active panel*: rejected — loses in-tab state on
every switch and re-pays the mount each time. *`content-visibility: auto`*: rejected — defers
layout and paint, not React mount or Radix root creation. *Gate only `EventButtonsTable` with a
single boolean instead of a set over all panels* (panel finding): genuinely simpler, and the other
three panels are cheap (Auto Sync is two `<p>`s; Debug is two `<p>`s plus an orphaned
`#v6-settings-perf-debug-mount` div that nothing currently writes to). Rejected anyway because the
general rule costs a few lines more and states a discipline that stays correct as tabs are added,
where the special case would have to be revisited every time. Recorded as a residual minor.

### D3 — Make the per-row `Select` lazy, rather than only relocating its cost

Deferral alone moves the table's mount from the modal-open click to the Event Buttons tab click.
For a user who opens Settings *to edit event buttons* — the tab's whole purpose — that is not an
improvement; it is the same spike, one click later. The design's own anti-relocation principle
demands the cost be attacked, not moved.

So each row's type control renders an inert trigger — same classes, same accessible name, role, and
ARIA state, same displayed value — and upgrades to the real Radix `Select` on intent.

**The upgrade cannot rely on the upgraded control receiving the triggering gesture.** Radix's
`SelectTrigger` opens on `onPointerDown` for mouse (`react-select/dist/index.mjs:208-217`, which
also calls `event.preventDefault()`), not on click. If the inert trigger's own pointerdown is what
swaps in the real control, the freshly-mounted Radix trigger never sees that pointerdown, and
whether the menu opens then depends on browser-specific click retargeting after the DOM node under
the cursor changed mid-gesture — undocumented and not something to build on.

The deterministic technique is to mount the upgraded control **already open**:
`RadixSelect.Root` accepts `open` / `defaultOpen` / `onOpenChange` (`index.mjs:47-48,67-69`), so an
activation-triggered upgrade renders the real `Select` with `defaultOpen`. This also covers touch
taps and assistive-technology synthetic activations, which deliver no prior hover or focus event —
a hover-only upgrade path would strand exactly those users. Hover and focus remain *additional*
cheap pre-warm triggers, not the mechanism; note `pointerenter` is desktop-only and contributes
nothing on touch.

Two consequences the spec pins:

- **Scope reaches `Select.tsx`.** The shared wrapper does not currently forward `defaultOpen`, so
  it gains an optional pass-through. That file is shared with `FpsSelect`, the copy-from-show
  select, and the suffix select, so the prop is additive and optional — existing call sites are
  untouched. The alternative — reimplementing `RadixSelect.Root`/`Trigger`/`Portal`/`Content`
  locally in `EventButtonsTable.tsx` — is exactly the wholesale duplication this approach exists
  to avoid.
- **Focus must be transferred explicitly.** Removing a focused element from the DOM blurs to
  `document.body`; nothing transfers focus to a same-position replacement automatically. A
  focus-triggered upgrade must `.focus()` the new trigger via a ref, or a keyboard user tabbing
  onto the control loses focus entirely.

**Alternatives considered.** *Deferral only, accept the trade*: rejected at the gate (2026-08-13).
*Deferral plus idle-warming of unvisited tab content*: rejected — it makes the cost invisible on
fast machines rather than smaller, and it is strictly more machinery than removing the cost.
*Virtualize the rows with `@tanstack/react-virtual`* (already a dependency, already used in
`TranscribeFeed`): a real alternative that would bound the cost regardless of show size. Not
chosen because it changes the table's scroll/layout behavior inside a modal that is already
`overflow: auto`, and because it caps cost per *viewport* rather than removing the per-row waste.
Recorded as the follow-up if D3's measurement is insufficient for very large shows.

### Deliberate invariants a future reader might "helpfully" undo

- **The four Settings panel wrappers render unconditionally.** They look redundant next to the
  gated children; removing them strands `aria-controls` and the e2e id surface.
- **Deferred tabs are never unmounted once visited.** Turning the visited-set into "render only the
  active tab" looks like a simplification and is a behavior regression (D2).
- **The open-reset runs during render, not in an effect.** Moving it "back where resets belong"
  reintroduces the transient reopen mount this change exists to remove (D2). The spec's
  zero-mounts-on-reopen scenario is the tripwire.
- **The lazy trigger must be a true visual/a11y stand-in.** Letting it differ "just until it
  upgrades" produces a flash and a screen-reader discrepancy on every row.

## Risks / Trade-offs

- **The lazy trigger diverges from the real control** (styling, accessible name, keyboard entry)
  → the spec pins appearance, role, accessible name, and single-interaction opening; tests assert
  the keyboard path, which is the one most likely to be missed.
- **The upgrade swallows the first interaction** → explicit scenario and test: one click opens.
- **Render-phase state adjustment is unfamiliar** and can loop if written carelessly (it must be
  guarded by the `prevOpen` comparison, and must set state only when the guard trips) → the
  pattern is written out above verbatim; a loop would surface immediately as a hang in tests.
- **Deferral hides a save regression** if a save ever comes to depend on a mounted
  `EventButtonsTable` → the "saving persists shows whose tab was never visited" scenario is the
  standing test.
- **Mounting a tab arms dirtiness** → confirmed impossible today (`EventButtonsTable` has zero
  effects; all seven `onChange` calls sit in user event handlers), and pinned by the
  discard-guard scenario so it stays impossible.
- **The Debug tab's `#v6-settings-perf-debug-mount` becomes conditionally present.** It is an
  orphan today — `initPerfDebugUI()` is called from `AppShell.tsx:107` with no `mount` option, so
  nothing writes to it — but if the embedded variant is ever wired, deferral makes the node absent
  at that moment. Recorded so the next person does not rediscover it.
- **Trade-off accepted**: a first activation of the Event Buttons tab still mounts the table's
  non-Select structure. D3 removes the dominant per-row cost, not all of it.

### Outcome, measured after implementation (task 5.2, 2026-08-13)

Like-for-like 7-trial medians, click→painted, `/` with no session open, 7 event-button rows;
pre-change on `main` @ `a8648b6`, post-change on the branch. `agent-browser react renders` counts
deliberately not used (see D0). Full data: `.apply/profile-after.md`.

| Path | Before | After | Δ |
| --- | --- | --- | --- |
| Settings open (cold) | 28.7 ms | **16.8 ms** | **−41 %** |
| Settings reopen | 27.9 ms | **19.1 ms** | **−32 %** |
| First Event Buttons tab activation | 13.1 ms | 15.9 ms | +2.8 ms |

The modal-mount cost D2 and D3 targeted is delivered on both open paths. The tab-activation path
regressed by 2.8 ms, which is inherent to deferral — before the change that click merely flipped a
`hidden` attribute because the table was already mounted; after it, that click is where the table
mounts. **What D3 is established to hold the line on is structural, not the +2.8 ms figure
itself**: the phase-4 test (`EventButtonsTable.lazyTypeSelect.test.tsx`, scenario a) shows no
row mounts a `RadixSelect.Root` (an inert trigger only), and the mounted-`Root` count does not
grow with row count. **No deferral-only variant (tab content deferred, per-row `Select` left
eager) was ever built or timed**, so the claim that D3 specifically is "what holds the regression
to +2.8 ms" — as opposed to some other or larger number a deferral-only build would have
produced — is an unmeasured counterfactual and is not asserted (whole-branch audit finding I3).

**5.2 amendment (whole-branch audit, 2026-08-13).** Task 5.2 as originally worded required this
path to *improve*; it regressed. Ruled **not a defect**: the criterion measured a workload the
change deliberately redefined (this click previously flipped a `hidden` attribute on an
already-mounted table; now it *is* the mount), `profile-before.md` itself framed the number as a
regression guard with a "must not regress meaningfully" bar rather than an improvement target,
and +2.8 ms sits at or below the double-`rAF` instrument's floor with heavily overlapping trial
ranges (before `[10.1–15.8]`, after `[12.8–17.3]`). Task 5.2 is amended (see `tasks.md`) to
require the modal-mount paths to improve and the first tab activation to **not regress
meaningfully past the 12.5–13.1 ms baseline** (`profile-before.md`'s no-session baseline and
`profile-after.md`'s before-median). The +2.8 ms is recorded here as an accepted, expected
residual of deferral, not reinterpreted or hidden. `profile-after.md`'s "+21 %" framing is
dropped — the percentage implies precision the instrument does not have (see `.apply/
profile-after.md`). Taken together, open + first-tab-activation went **41.8 ms → 32.7 ms**
(28.7 + 13.1 before; 16.8 + 15.9 after) — the combined path the user experiences when opening
Settings specifically to edit event buttons is faster, even though the second leg alone is not.

### Residuals (whole-branch audit, 2026-08-13)

Findings recorded rather than discharged, carried forward as known gaps:

- **M7 — `dirty`'s double `JSON.stringify` over the full draft set.** The panel log ("Minors
  accepted as residual") promised "task 1.1's profile will attribute it or rule it out." No
  artifact records either outcome — neither `profile-before.md` nor `profile-after.md` isolates
  `dirty`'s cost. Left open; a future profile should attribute or rule it out before further
  Settings-modal performance work relies on either answer.
- **M8 — accessibility-check requirement has no gate.** `spec.md`'s "Event-button rows defer
  their type control" requirement says "automated accessibility checks pass identically before
  and after the upgrade," but the repo has no axe/jest-axe tooling anywhere, so nothing
  mechanically checks this. What is actually gated, by the phase-4 tests, is role, accessible
  name, and `aria-expanded` parity between the inert trigger and the upgraded control — those
  properties are asserted; the broader "automated accessibility checks" claim is not. Recorded as
  a gap between the spec's wording and the test suite's actual coverage, not silently narrowed.
- **M9 — commit `ce62a8c`'s message still asserts the withdrawn `+11,097` figure.** History is
  immutable — the commit is not rewritten — but recorded here so a future `git log` reader is not
  misled by a claim this change itself withdrew (see D0 and `phase2-diagnostic.md`).

## Migration Plan

Single-phase, `web/`-only, no data migration and no server change. Rollback is a revert. Evidence
is a Performance profile of (a) the reopen path and (b) the first Event-Buttons activation, taken
against the production serve path (`npm run build && npm run start`) — dev-mode compile cost masks
the number, and dev is also a candidate confound in its own right (see the panel log).

## Open Questions

- **Does the rail add a session-count-proportional cost to the same click?** The reporter observes
  the lag scaling with `server/data/sessions`; the profile could not exercise that (active show had
  one session) and the un-memoized `V6Rail` gives a plausible mechanism. Deliberately **not** in
  this change's scope: it is a different component, a different fix (memoization + per-card Radix
  cost), and confirming it requires changing the active show. If it is confirmed, it belongs in its
  own change. See the measured-context section for the mechanism.

The two questions carried by the pre-gate draft were closed at the 2026-08-13 gate: the warming
trigger died with the code-splitting phase, and the `WorkspaceStatic` characterization test moved
with it to `web-boot-split-boundaries`.

## Panel & review log

### 2026-08-13 — Pre-panel fact-check pass (light tier)

Mechanical fetch-and-compare of the stated checkable claims against the live tree at `main` @
`3eaca8f`. Each claim was posed as a **property to verify**, not a line to confirm; claims about
what a function does required reading the whole function plus callees on the claim-relevant path.

**23 claims checked. 21 CONFIRMED, 1 CORRECTED, 1 left UNVERIFIED.**

**Corrected in place (major):** "The only code-split boundary in `web/` today is the island
wrapper." False — `BatchImportModal.tsx:146` already does
`await import('../batchImport/logImportClient')` inside its submit handler. Independently
re-verified by the orchestrator. (That correction now lives with the code-splitting work in
`web-boot-split-boundaries`.)

**Sharpened in place (minors):** the "zero fetches on open" claim was literally imprecise —
`HomeSettingsModal` does call `useProfile()`, but `AppShell` already calls it at boot, so the
`isOpen` transition adds no request; the per-row Radix description attached "with its own Portal"
only to `Popover` when `Select` has one too; the nine swatches were confirmed via
`PALETTE_SLOT_INDICES` (a nine-element tuple) rather than by counting JSX.

**Left UNVERIFIED:** the causal claim that the mount commit is what the user perceives as the lag.
No profile taken. Reached the panel un-vouched, and is now a halt-gate (task 1.2).

Notable CONFIRMED-with-full-read results: `handleSave` reads nothing `EventButtonsTable` owns;
`Dialog.tsx` uses no `forceMount`; no e2e assertion touches Event Buttons content without first
clicking `#v6-settings-tab-event-buttons` (whole `e2e/` tree swept for table-specific markers).

This pass was an **aid, not a warrant** — the panel prompt said so explicitly and preserved the
reviewers' full skeptical mandate, which is what produced the findings below.

### 2026-08-13 — Adversarial panel (4 reviewers: requirements / assumptions / failure & abuse / scope & simpler design)

The panel materially changed this change: it found two defects in the proposed fix, corrected the
diagnosis twice, and split the work in two. Synthesis below; conflicts between reviewers are
resolved in the disposition.

**Blockers/majors fixed in place:**

1. **The proposed fix would have made reopen worse** (found independently by two reviewers).
   Resetting `activeTab`/`visitedTabs` in the passive `isOpen` effect lets the reopen commit mount
   the stale tab's content before the reset lands, then unmount it. Both the existing reopen test
   and the drafted scenario asserted only settled state, so neither would have caught it. Fixed:
   D2 now specifies the render-phase reset, and the spec's reopen scenario demands **zero mounts**
   during the transition rather than absence afterwards. Verified by the orchestrator against
   `HomeSettingsModal.tsx`.
2. **The diagnosis named the wrong open.** On a *first* open `showDrafts` is empty, so the panel
   renders its "Select a show" hint and the table mounts on a later commit; `showDrafts` survives
   close, so the expensive commit is on *reopen*. Fixed: Context rewritten; measurement tasks now
   profile the reopen path explicitly.
3. **The diagnosis named the wrong widget.** A closed Radix `Select` mounts its whole item subtree
   into a `DocumentFragment` (`SelectContentFragment`), while `Popover` is `Presence`-gated. The
   per-row cost is the Select. Verified by the orchestrator in
   `node_modules/@radix-ui/react-select/dist/index.mjs:284-298`. Fixed: Context corrected, and it
   is the basis of the new D3.
4. **Deferral relocates the cost onto the Event Buttons tab click** (found by three reviewers) —
   the users who lose are exactly the ones the tab exists for. Escalated to the gate; see below.
5. **`everOpened`'s stated justifications were both false** (the mount site is outside the route
   branch, so a plain conditional survives route changes; and both lazy mechanisms cache the
   resolved module, so there is no re-fetch to avoid). Moot here — the latch belonged to the
   code-splitting phase and left with it.

**Escalated to the gate — decided 2026-08-13:**

- **Relocation vs. root cause.** Options priced: deferral only / deferral + idle-warm the tabs /
  deferral + make the per-row control lazy. **Ruled: make the per-row control lazy** (D3), so the
  tab click improves rather than inheriting the spike.
- **Boundary count for the code-splitting work.** A reviewer built all six boundaries in a scratch
  tree and ran a real production build: **−350,963 B raw (−60.7%)** off the index boot chunk, of
  which `SessionWorkspace` is 74.9% and `HomeSettingsModal` 13.8%, while **`TeamsRoute` produced
  no chunk at all (0 bytes)** and the remaining three totalled ~29 KB. **Ruled: audit first, let
  the measured per-seam table select the boundary list** — carried to
  `web-boot-split-boundaries` along with the numbers (to be re-measured there, not inherited as
  fact).
- **One change or two.** **Ruled: two.** This change ships the lag fix; code-splitting becomes its
  own queued change. Rationale: the splitting work's dominant boundary optimizes a boot cost
  unrelated to the reported symptom, and it carries a risk surface — a new independent
  chunk-failure mode with **no error boundary anywhere in `web/src`** and no `error.page.tsx`
  (React caches a `lazy` rejection permanently, so a failed chunk replaces the whole document with
  Next's fatal error page), an App Router `next/dynamic` that resolves to a **different
  implementation than the vitest tier sees** (`create-compiler-aliases.js:226` →
  `app-dynamic` → `React.lazy`/`Suspense`, no `.preload()`, `error` hardcoded `null`), overlay
  fallbacks that would render inline in `<main>` rather than as overlays, and a First Load JS
  measurement instrument structurally blind to boundaries inside the already-dynamic island
  chunk. All three mechanism claims were independently verified by the orchestrator. None of it
  should block this fix.

**Minors accepted as residual:**

- The general visited-set over four panels is broader than the measured problem (only Event
  Buttons has real cost; Auto Sync and Debug are a handful of `<p>`s). Accepted: the general rule
  is a few lines more and stays correct as tabs are added — recorded in D2's alternatives.
- `#v6-settings-perf-debug-mount` is an orphaned mount node; deferral is safe today and would need
  attention if the embedded perf-debug variant is ever wired. Recorded in Risks.
- Two pre-existing draft-loss paths this change reaches near but does not close:
  `handleStudioChange` discards the previous studio's drafts with no discard guard, and
  `AppShell`'s `needsOnboarding` early return unmounts an open modal with unsaved drafts. Both
  pre-date this change and are out of scope; recorded here so the next reader does not assume the
  modal's lifecycle was audited clean.
- `dirty` deep-compares the full draft set via double `JSON.stringify` on every render — a
  plausible contributor to "settings feels laggy" that this change does not touch. Task 1.1's
  profile will attribute it or rule it out.
- The proposal described its delta as "extending" an existing requirement when the operation is
  `ADDED`. Fixed in the rewrite.

**Panel findings that belong to the split-out work** (recorded here for traceability, since the
queued `web-boot-split-boundaries` draft attributes them to this panel): focus capture and
un-cancellable opens across the async gap (failure & abuse); `SessionWorkspace`'s coordination
handles being unregistered during the load window (assumptions); and the measurement that idle
warming re-fetches ~96% of the deferred bytes, making the win *scheduling* rather than elimination
(scope). All three are carried in that draft's risk surface.

### 2026-08-13 — Post-gate measurement (halt-gate) and the phase-2 addition

Profiling on the reporter's data (method and numbers in Context) passed task 1.2's halt-gate for
D2/D3 **and** appeared to surface a larger, independent cost that no artifact had contemplated: a
defeated `WorkspaceStatic` memo re-rendering the entire session workspace on every shell state
change (+11,097 re-renders, 70 ms → 101 ms). This became D0 / phase 2, with its own requirement.

> **That second finding was withdrawn during apply** — the render counts came from an instrument
> later shown to over-count, and ground truth puts `SessionWorkspace` at **zero** renders on a
> settings click. D0 and its requirement were rescoped to prop stability only. See the WITHDRAWN
> notice in Context, D0 as rewritten, and the fix-wave entry below. The halt-gate pass for D2/D3 is
> unaffected — it rests on mount counts and the `SelectTrigger` inventory match, not on re-renders.

Two honest notes on process:

- **The first profile was taken from `/` with no session open**, so it could not have exercised
  this path. The reporter's "it scales with `server/data/sessions`" observation is what redirected
  the measurement; an earlier orchestrator hypothesis (the rail's per-`SessionCard` cost) was
  measured and **not** supported — the rail contributed nothing with one session in the active
  show — and was discarded rather than kept as a hedge.
- **D0 and its requirement post-date the panel and the consistency read below.** They rest on
  measurement rather than argument, and the fix restores an isolation boundary that already exists
  rather than adding a mechanism — but they have not been through an adversarial pass. Flagged for
  the whole-branch review, which per the phase-risk rule covers phase 2 anyway (it changes render
  semantics around a memo boundary).

### 2026-08-13 — Post-gate consistency read (light tier, widened)

Read all four artifacts as a set plus the split-out queued draft. Widened beyond a pure
consistency read to also scrutinize D3 and the "Event-button rows defer their type control"
requirement, which were added **after** the panel and so had never been adversarially reviewed.

**Consistency: clean.** No stale two-phase / six-boundary / `next/dynamic` / warming language
survives in any normative section; every remaining mention is an explicit backward reference in
Non-Goals or the panel log. D1/D2/D3 cross-references resolve. Spec-to-task coverage is 1:1 in both
directions — every scenario has a test task, every task traces to a requirement or a gate. No
rename residue, no reference to the deleted `web-frontend-platform` delta, and every panel risk for
the splitting work survived into the queued draft.

**Findings on the new content, fixed in place:**

1. **BLOCKER — "a single click opens it" was not achievable as described.** Radix's `SelectTrigger`
   opens on `onPointerDown` for mouse (and calls `preventDefault()`), not on click, so upgrading
   *on* pointerdown means the fresh trigger never receives the gesture, and any resulting open
   would depend on browser-specific click retargeting after a mid-gesture DOM swap. Verified by the
   orchestrator at `react-select/dist/index.mjs:200-217`. Fixed: D3 now names the deterministic
   technique — mount the upgraded control with `defaultOpen` (`RadixSelect.Root` accepts
   `open`/`defaultOpen`/`onOpenChange`, `index.mjs:47-48,67-69`) — which also covers touch taps and
   assistive-technology synthetic activations that deliver no prior hover or focus. The reviewer
   correctly flagged that the artifacts asserted both "no duplication" and "no scope beyond
   `EventButtonsTable.tsx`", which were jointly unsatisfiable: `Select.tsx` now appears in the
   proposal's Impact and as its own task (3.2), as one additive optional prop.
2. **MAJOR — keyboard upgrade dropped focus.** Removing a focused node blurs to `document.body`;
   nothing transfers focus to a replacement. Fixed: the spec now requires focus to end on the
   upgraded control, and task 3.3 specifies the ref-based `.focus()`.
3. **MAJOR — assistive-technology activation was unpinned.** Rotor/explore-by-touch activations
   deliver a synthesized click with no preceding pointer or focus events, reproducing the
   swallowed-interaction failure for exactly the users least able to work around it. Fixed: the
   requirement and task 3.1(b) now name mouse, touch, and AT activation explicitly.
4. **MINOR — ARIA-state parity was under-specified.** Pinning only "appearance, accessible name,
   and role" would permit an inert `role="combobox"` with no `aria-expanded`, which fails
   `aria-required-attr`. Fixed: the requirement now pins expanded and disabled state and demands
   identical automated-accessibility results.
5. **MINOR — `pointerenter` is desktop-only.** Recorded in D3 so no future reader treats hover as
   the mechanism.

**Also confirmed clean by this read:** no `<form>`/submit path in `EventButtonsTable`, so the inert
trigger cannot alter submission semantics; the row's other controls (drag handle, name input, color
popover, options button) are independent siblings with no dependency on the Select's mount state;
`updateButton`'s `onChange` wiring is unchanged; and a repo-wide sweep of `openspec/specs/` found no
existing requirement about per-row Select mount behavior, so neither "Honest save model in Settings"
nor "Generation instruction fields in Settings" is contradicted.
