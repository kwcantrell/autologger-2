# web-ui-system

## Purpose

The frontend's shared component vocabulary and cross-cutting UX baseline: one V5 glass
visual language for buttons, form controls, and dialogs; themed confirmations that replace
browser-native `confirm`/`prompt`; global single-key shortcut handling that yields to
dialogs and interactive targets; an AA contrast floor on rendered surfaces; reduced-motion
alternatives for looping animation; vector iconography on interactive control glyphs; an
honest save model in Settings; and progressive disclosure in the New Session modal.

It also carries the shared surfaces' **mount-cost and render-isolation discipline**: the Settings
modal costs nothing while closed and defers its inactive tab content; event-button rows defer their
type control until the user shows intent; the shell-to-workspace prop boundary stays memoizable;
the playback tick is fenced at named memo boundaries; and the Settings shows section names why it
has nothing to show rather than sitting on a loading skeleton.

## Requirements


### Requirement: Single V5 component vocabulary
The frontend SHALL present one component vocabulary: buttons, form controls, and dialogs render
in the V5 glass style (glass gradient surfaces, `--v5-border-strong` borders, uppercase tracked
label type for buttons, sky-tinted primary, red-tinted danger), and no surface renders the
legacy flat grey chrome. This is a steady-state requirement about the rendered result — the
migration mechanism (re-skinning the legacy class family in place versus porting consumers) is
a design decision (design D1), not a spec obligation, and later retiring the legacy class
family at zero consumers is compatible with this requirement.

#### Scenario: Export tab actions match the workspace vocabulary
- **WHEN** the Export feed tab renders its CSV/JSONL download actions
- **THEN** they render as V5 glass buttons (primary variants sky-tinted where applicable)
  with no flat legacy grey (`#2a2d36`) chrome

#### Scenario: Disabled buttons are visibly non-interactive without hover response
- **WHEN** any button in the shared vocabulary is disabled and hovered
- **THEN** it stays at reduced opacity with muted text and no hover border/background change


### Requirement: Themed confirmations replace browser chrome
Destructive or discard-style confirmations SHALL use a shared themed confirm dialog (built on
the app's Radix Dialog vocabulary, danger-variant confirm action where the action is
destructive; Escape, overlay dismissal, and mobile sheet drag-dismiss all resolve as decline).
The frontend SHALL invoke neither `window.confirm`/`window.prompt` nor the bare
`confirm()`/`prompt()` globals — including the admin-users page and hook-initiated flows.
If a pending themed confirmation is replaced by another or unmounted before the user decides,
the pending decision SHALL resolve as declined (no awaiting flow may hang).

#### Scenario: Deleting a log row
- **WHEN** the user activates a row's Delete action outside batch-edit mode
- **THEN** a themed dialog titled for the action offers Cancel and a danger-styled Delete, and
  the row is deleted only on explicit confirm

#### Scenario: No browser-native confirm/prompt remains
- **WHEN** the web source is checked for invocations of `window.confirm`/`window.prompt` or
  the bare `confirm()`/`prompt()` globals (comment prose and the `useConfirm` hook's own API
  are not matches)
- **THEN** there are zero occurrences

#### Scenario: Orphan-recording recovery warning is themed and race-safe
- **WHEN** a session opens with an orphan recording (recording event with no matching stop)
- **THEN** the synthetic-stop decision renders once per session mount in the themed confirm
  dialog (modal — workspace interaction paused as with any Radix modal); dismissal by any
  means is decline (nothing is posted); on accept the client SHALL re-validate the orphan
  against current events/status and the recording lease before posting, and SHALL no-op
  (dismissing the dialog) if the orphan no longer exists or the lease is alive; the posted
  `marked_at_utc` is accept-time, and the dialog copy SHALL NOT promise a specific timecode;
  a pending decision SHALL be dismissed (as decline) on session switch


### Requirement: Global single-key handlers yield to dialogs and interactive targets
Global single-key shortcuts (Space play/pause, `+`/`−` zoom, `1–9` logging, `?`) SHALL NOT
fire while any `[role="dialog"]` is open, and SHALL NOT intercept a key when the event target
is a button or other interactive element that consumes that key (a focused button's Space
activation always wins over the global handler).

#### Scenario: Space activates a focused confirm button, not playback
- **WHEN** a themed confirm dialog is open in a session with recorded audio and the user
  presses Space with the confirm button focused
- **THEN** the button activates and audio playback does not toggle

#### Scenario: Zoom keys ignored behind dialogs
- **WHEN** any dialog is open and the user presses `+` or `−`
- **THEN** the timeline zoom does not change


### Requirement: AA contrast floor on rendered surfaces
Text and data labels SHALL meet WCAG AA (≥4.5:1, composited over the surface's effective base
color) on the surfaces they render on — including timeline tick timecodes, inactive feed-tab
labels, panel eyebrow labels, and input placeholder text. The chosen token values
(ticks `rgba(229,238,252,0.58)`, inactive tabs alpha 0.6, eyebrows alpha 0.62, placeholder
floor alpha 0.55) are the reference implementation evidence, not the requirement; any
replacement SHALL still clear the floor.

#### Scenario: Timeline ticks are legible
- **WHEN** the session timeline renders its tick timecodes
- **THEN** their computed contrast against the timeline lane is at least 4.5:1
  (the prior `rgba(229,238,252,0.36)` = 2.96:1 is a regression)

#### Scenario: Inactive tab labels are legible
- **WHEN** a feed tab is not selected
- **THEN** its label contrast against the tab surface is at least 4.5:1


### Requirement: Reduced-motion alternatives for looping animation
Every looping or attention-drawing animation SHALL have a `prefers-reduced-motion: reduce`
alternative. Specifically the timeline marker-message marquee SHALL stop (static, truncating
presentation) and status-pulse dots SHALL render static under reduced motion.

#### Scenario: Marker marquee under reduced motion
- **WHEN** `prefers-reduced-motion: reduce` is set and a marker message overflows its lane
- **THEN** the marquee animation does not run and the message renders statically (clipped),
  not scrolling


### Requirement: Vector iconography for interactive control glyphs
State-tinted glyphs on interactive controls (transport tiles, timecode state icons, in-row
actions) SHALL be inline SVG inheriting `currentColor`; emoji glyphs SHALL NOT be used in
interactive controls; the raster transport/timecode PNG assets are removed. Typographic
glyphs on secondary affordances (`⋮` row menus, `✕` close buttons) are an accepted residual
outside this requirement.

#### Scenario: Transport tiles use state-tinted SVG glyphs
- **WHEN** a transport tile renders in any transport state
- **THEN** its glyph is an inline SVG inheriting the tile's state accent, and no `<img>`-based
  or emoji glyph remains in the transport, timecode, or row-action components


### Requirement: Honest save model in Settings
The Settings modal SHALL make its save state legible: Save is disabled (and labeled as saved)
when there are no unsaved changes, enabled when any edit exists; closing with unsaved changes
SHALL warn through the themed confirm dialog before discarding. Dirtiness SHALL be derived by
comparing current form state against the initialized snapshot (not a hand-armed per-callsite
flag), so an un-instrumented mutation path can neither brick Save nor skip the discard guard.
The Add-Show flow SHALL collect the show name in a themed input dialog. Copy in the modal
SHALL match the actual save model (no "auto-saves" claims for draft-then-Save behavior).

#### Scenario: Editing any field enables Save
- **WHEN** the user edits any Settings field (show name/code/title suffix, categories,
  palette, default frame rate, account names) after open
- **THEN** Save becomes enabled, and after a successful save it returns to the saved state

#### Scenario: Close with unsaved changes warns
- **WHEN** the user closes the Settings modal (button, Escape, or overlay) with unsaved edits
- **THEN** a themed discard confirmation intervenes; declining keeps the modal open with edits
  intact


### Requirement: Generation instruction fields in Settings
The Settings event-buttons table SHALL let the user view and edit each BUTTON,
DROPDOWN, and TEXT button's optional `auto_instruction` (multi-line-capable text
entry, max 2000 chars, clearable to absent), and, for DROPDOWN buttons, each dropdown
option's optional `auto_instruction` in the options modal alongside the existing
label/needs-context fields — plus the whole-button instruction, which remains editable
for DROPDOWN buttons. ON_OFF buttons SHALL NOT offer the field (they are excluded from
generation), and switching a button's type to ON_OFF drops its instructions from the
draft. Instruction edits SHALL participate in the existing draft-then-Save model
(enable Save, discard-guard on close) via the snapshot comparison — no new per-field
dirty flag. An **instruction-bearing** button (per `auto-event-generation`'s
definition: its own instruction non-empty, or any of its options') SHALL be visibly
distinguishable in the table (a compact indicator or summary) so users can tell which
buttons participate in AUTO GENERATE without opening each editor — an option-only
DROPDOWN lights the indicator. The Copy-Buttons-From flow SHALL carry instruction
fields with the copied buttons.

#### Scenario: Editing an instruction arms Save
- **WHEN** the user types an instruction on a button and closes the modal via Escape
  without saving
- **THEN** Save had become enabled and the themed discard confirmation intervenes

#### Scenario: Dropdown options carry their own instructions
- **WHEN** the user opens the options editor for a DROPDOWN button
- **THEN** each option row offers its own instruction field, the whole-button
  instruction is also editable, and saved values round-trip on reopen

#### Scenario: Copy from show preserves instructions
- **WHEN** the user copies buttons from another show whose buttons carry instructions
- **THEN** the copied drafts include the button- and option-level instruction fields

#### Scenario: ON_OFF buttons offer no instruction field
- **WHEN** the user views an ON_OFF button's row, or switches an instruction-bearing
  BUTTON to ON_OFF
- **THEN** no instruction field is offered, and the switched button's draft carries no
  instructions

#### Scenario: Option-only instructions light the indicator
- **WHEN** a DROPDOWN button has instructions only on its options
- **THEN** the table row shows the instruction-bearing indicator


### Requirement: New Session progressive disclosure
The New Session modal SHALL present the core flow (show, episode with a pressed-state bonus
toggle, notes, create) directly, with YouTube import and timecode settings (frame rate, start
offset) behind collapsed disclosures whose summaries show the current values; defaults SHALL
be safe without opening either disclosure. The bonus control SHALL expose its on/off state
(`aria-pressed` and visually).

#### Scenario: Creating a session without touching disclosures
- **WHEN** the user opens New Session, picks a show, and submits
- **THEN** the session is created with the profile-default frame rate and zero offset, without
  either disclosure having been opened


### Requirement: The shell-to-workspace render boundary stays memoizable
Every prop the shell passes across the render-isolation boundary to the mounted session workspace
SHALL hold a stable identity across shell renders, so that the boundary's memoization is able to
bail out. A shell state change SHALL NOT be the reason a boundary prop changes identity.

This requirement is deliberately scoped to prop stability — the property that is observable and
testable at the boundary. It makes no claim about how often the workspace renders in practice: the
change that introduced it originally asserted a large re-render reduction, and that assertion was
withdrawn when the render counts supporting it proved to be a profiling-tool artifact.

The boundary is **two hops**, and this requirement is normative over both: the shell (`AppShell`)
passes props to `SessionRoute`, which forwards them unchanged into `WorkspaceStatic` — the `memo()`
that is the render-isolation boundary proper.

**Which half the scenarios below observe.** They observe the **upstream** hop only — the props the
shell offers, captured on a mocked `SessionRoute` — and that half is mechanically pinned for every
shell state change named below **except the YouTube-import-error modal**, which no test drives. The
**downstream** half is pinned by nothing: neither `SessionRoute`'s unchanged forwarding nor
`WorkspaceStatic`'s comparator is exercised, because every test that reaches `WorkspaceStatic`
mocks it away with a non-memoized stand-in. Inserting a wrapper object or a fresh closure between
the two hops, or deleting the `memo()` outright, would fail no test. The obligation is unchanged by
that; what this paragraph records is the evidence behind it, consistent with the honest-limits note
under `The playback tick is fenced at named memo boundaries`.

#### Scenario: Opening the settings modal does not disturb the boundary props
- **WHEN** a session workspace is mounted and the user opens the settings modal
- **THEN** every prop passed across the shell-to-workspace boundary is referentially identical to
  what it was before the click

#### Scenario: The boundary holds for every shell state change
- **WHEN** the user opens the New Session modal, the Batch Import modal, or the YouTube import
  error modal, closes the settings modal, or toggles the mobile navigation rail, while a session
  workspace is mounted
- **THEN** the boundary props remain referentially identical across each of those state changes


### Requirement: The Settings modal costs nothing while closed
While the Settings modal is closed it SHALL perform no form-initialisation work, SHALL issue no
shows request, and SHALL render no element tree.

The modal initialises in **two independent scopes**, and both SHALL be gated on the modal being
open. The **account scope** — the studio pointer, the default frame rate, and the account names —
initialises from the profile, which is already in hand before the modal can open; it SHALL NOT run
merely because the profile query resolved while the modal is closed. The **shows scope** hydrates
the per-show drafts and the show selection from the **per-studio shows query** whose states
`The Settings shows section says why it has nothing to show` governs — not from the profile, whose
`shows[]` carries only the brief shape; that query SHALL be disabled while the modal is closed, so
a closed modal fetches no draft source at all. The modal SHALL render nothing while closed rather
than building a tree the dialog primitive then declines to show.

The shell SHALL mount the modal **only while it is open**, gated on `showSettings` — a piece of
shell state. The modal is one of the split surfaces enumerated by `web-frontend-platform`'s
`The client island is route-split behind recoverable boundaries`, which owns the split-point
inventory, the chunk-boundary mechanics, and the idle prefetch that warms this chunk; this
requirement does not restate them. The previous mechanism (an unconditional mount relying on the
dialog primitive to render nothing while `open` was false) SHALL NOT be restored: behind that lazy
chunk it would download the modal's bytes on every page load, which is the cost the split exists to
remove.

Route-change survival is unchanged and remains normative: the gate SHALL be shell state and SHALL
NEVER be the URL or a route branch, so an open modal survives a route change instead of
desynchronising `showSettings` from what is rendered. Beyond the mount gate this SHALL be
behaviour-neutral — it SHALL NOT change what an open modal shows, and the deferred-initialisation
discipline inside the modal SHALL remain in force (the modal still gates its own hydration on
`isOpen`, so the guarantee does not depend on the mount gate alone).

The chunk boundary is an **overlay** boundary with a `null` fallback — that fallback discipline is
`web-frontend-platform`'s — so while a cold settings chunk is in flight, nothing is rendered on
screen and the invoking control offers no busy affordance. This is a known, unclosed gap recorded
in the `perf-audit-remediation` proposal, not a property of this requirement.

#### Scenario: Initialisation is deferred until the modal opens
- **WHEN** the app loads with the modal closed and the profile query resolves
- **THEN** neither scope initialises — no account fields are hydrated from the profile, no shows
  query is issued, and no show drafts are built — and that work happens on the first open instead:
  the account scope initialises once per open, not once on profile resolution and again after the
  open-reset

#### Scenario: A closed modal renders nothing
- **WHEN** the shell renders with the modal closed
- **THEN** the modal contributes no elements — it is not mounted at all, and its module is not
  fetched by the initial page load

#### Scenario: A cold first open traverses the chunk boundary
- **WHEN** the user opens the modal before the idle prefetch has completed
- **THEN** the lazy chunk is fetched, the boundary's `null` fallback renders nothing for the
  duration of that fetch, and the modal appears once the chunk resolves

#### Scenario: An open modal is unaffected
- **WHEN** the user opens the modal, and while it is open the route changes
- **THEN** the modal opens on the General tab fully initialised, and it stays open and functional
  across the route change exactly as before


### Requirement: Settings modal defers inactive tab content
The Settings modal SHALL mount a tab panel's content on that tab's first activation, not on modal
open, and SHALL NOT unmount it on a subsequent tab switch. Each tab control's `aria-controls`
target SHALL resolve to a present element whether or not that panel's content has mounted.

Each open of the modal SHALL restart this discipline together with the existing reset to the
General tab, and SHALL do so without ever committing the previously-active tab's content to the
DOM — a reset applied after the opening commit would mount that content and then remove it, which
is the cost this requirement exists to remove.

Deferral SHALL NOT change what a save writes, and SHALL NOT arm the modal's unsaved-changes state:
because the modal owns the show drafts and the comparison snapshot, saving SHALL persist edits for
every show of the active team regardless of which tabs were visited, and mounting a tab's content
SHALL NOT by itself make the modal read as dirty.

#### Scenario: Opening the modal mounts only the active tab's content
- **WHEN** the user opens the Settings modal, which opens on the General tab
- **THEN** the Event Buttons, Auto Sync, and Debug panel contents are not mounted, and every tab
  control's `aria-controls` target resolves to a present element

#### Scenario: Activating a tab mounts its content and keeps it mounted
- **WHEN** the user selects the Event Buttons tab and then switches back to General
- **THEN** the Event Buttons content mounts on that first activation and remains mounted across the
  switch back, so its in-tab state (such as an open color popover or an in-progress drag order)
  survives the round trip

#### Scenario: Reopening never transiently mounts the previous tab's content
- **WHEN** the user activates the Event Buttons tab, closes the modal, and reopens it
- **THEN** the modal is on the General tab with the Event Buttons content unmounted, and that
  content is not mounted at any point during the reopen — observable as zero mounts of the panel's
  content between close and the settled reopened state, not merely as its absence afterwards

#### Scenario: Saving persists shows whose tab was never visited
- **WHEN** the user opens the Settings modal, edits a field on the General tab, and saves without
  ever activating the Event Buttons tab
- **THEN** the save submits the same show updates it would have submitted before deferral, and the
  modal returns to its saved state

#### Scenario: Mounting a deferred tab does not arm the discard guard
- **WHEN** the user opens the Settings modal, activates the Event Buttons tab, edits nothing, and
  closes the modal
- **THEN** no unsaved-changes confirmation intervenes and the modal closes directly


### Requirement: Event-button rows defer their type control
Each event-button row's button-type control SHALL NOT mount a listbox-style overlay component
until the user shows intent to use that control (pointer or keyboard focus). Rendering the row
SHALL cost only an inert trigger.

The deferred trigger SHALL be indistinguishable from the mounted control in appearance, accessible
name, role, and the ARIA state that role obliges — including its expanded and disabled state — so
that automated accessibility checks pass identically before and after the upgrade.

The upgrade SHALL NOT cost the user an interaction. An activation gesture SHALL both upgrade the
control and open it, and SHALL NOT depend on the upgraded control receiving the same physical
gesture that triggered the upgrade — that gesture is already consumed. This SHALL hold for a
mouse click, for a touch tap, and for a synthesized activation from assistive technology, none of
which are guaranteed to deliver the hover or focus events that a pointer-based upgrade would
otherwise rely on.

When the upgrade is triggered by keyboard focus, focus SHALL end on the upgraded control.

#### Scenario: Rendering rows does not mount per-row overlay components
- **WHEN** the Event Buttons tab's content mounts for a show with many event buttons
- **THEN** no row has mounted a listbox-style overlay component, and the count of such components
  mounted does not grow with the number of rows

#### Scenario: A single activation upgrades and opens
- **WHEN** the user activates a row's button-type control for the first time — by mouse click, by
  touch tap, or by an assistive-technology activation that delivers no prior hover or focus event
- **THEN** the control opens and is operable from that one activation, with the same options,
  selected value, and keyboard behavior as before this change

#### Scenario: Keyboard focus upgrades without losing focus
- **WHEN** the user tabs to a row's button-type control
- **THEN** focus ends on the upgraded control — not on the document body or the next element — and
  the control exposes the same accessible name, role, and ARIA state as before this change and is
  operable by keyboard without any pointer event


### Requirement: The playback tick is fenced at named memo boundaries
Audio playback drives a `requestAnimationFrame` loop that pushes the absolute timeline second into
session-workspace state — `audioPlaybackSec`, a `useState` at the top of `SessionWorkspace` — on
every frame.

**What this requirement does not claim.** Because that state lives at the top of the workspace,
`SessionWorkspace` re-renders on every playback frame **by design**, and so does every part of its
tree that is not behind a memo boundary: the maximise strip and the Timeline that read the second,
and alongside them the headless audio components (`AudioRecorder`, `AudioPlayer` — bare
`forwardRef`s), the shortcuts dialog, the chunk-rescue banner, the tab strip, the six tabpanel
wrapper elements, and the surrounding section chrome. This requirement asserts nothing about how
often any component renders, and no sentence in it may be read as a per-component re-render
assertion — the instrument that would verify such a claim is not available here (see *Evidence and
instrument* below).

**What SHALL hold** is prop stability and memo bail-out at named boundaries, so the expensive
subtrees stay out of the per-frame path even though their parent is in it — the point of the
fencing is the 66-event feed row set and the marker list, not the chrome:

- Each of the six feed panels (`EventLogSheet`, `TranscribeFeed`, `TopicsFeed`, `AiPanel`,
  `AiV2Panel`, `ExportFeed`) SHALL be `memo()`-wrapped and SHALL take `sessionId` as its only
  prop, and the map of panel elements SHALL be memoised on `sessionId` alone — so a tick-driven
  render of the workspace hands each wrapper the referentially identical element it held on the
  previous frame, carrying an unchanged prop set.
- `TimelineMarkers` SHALL be `memo()`-wrapped, and every prop it receives SHALL hold a stable
  identity across a tick-driven render: its four mouse handlers are `useCallback`-stable in
  `Timeline`, and `events` / `status` / `totalSec` / `selectedEventId` are query-derived. The
  Timeline around it re-renders each frame to move the playhead; the marker list's inputs do not
  move with it.

**Deliberate invariant a future reader might undo.** Every prop crossing one of these memo
boundaries SHALL hold a stable identity across a tick-driven render. Adding an inline handler, an
object or array literal, or any per-frame value to the props of a fenced component silently
reopens the cascade — the component keeps its `memo()` wrapper and stops bailing out, with no test
failure and no type error to signal it.

**Evidence and instrument.** The outcome claimed for the shipped fencing is a **frame-timing**
one: **zero long tasks during steady playback** on a 66-event session. Render counts are **not** a
valid instrument for anything in this requirement — the profiling tool's React render counts
over-count badly in this app, which is why the re-render assertion recorded under this
capability's `The shell-to-workspace render boundary stays memoizable` was withdrawn. Any future
edit here SHALL keep the claim on the frame-timing and prop-identity side of that line.

Honest limits: the fencing is currently **comment-enforced only** — no test pins the fenced prop
sets, and `WorkspaceStatic` (the outermost render-isolation memo) has no characterization test at
all, because every test that touches it mocks it away. A future change that widens one of these
prop sets will not be caught mechanically.

#### Scenario: Steady playback stays inside the frame budget
- **WHEN** audio plays back on a 66-event session at the audited viewport, with no session change
  and no query result changing
- **THEN** that playback stretch records no long task and no dropped frame attributable to the
  workspace render

#### Scenario: The fenced components' props do not move with the tick
- **WHEN** the playback second advances from one frame to the next
- **THEN** each feed panel's element and its `sessionId` prop, and every prop passed to
  `TimelineMarkers`, are referentially identical to what they were on the previous frame

#### Scenario: A genuine input change still reaches the affected panel
- **WHEN** a feed panel's own input changes — the session id changes, or a query it owns returns
  new data
- **THEN** that panel updates to reflect it; the fencing withholds nothing that a changed input
  should produce


### Requirement: The Settings shows section says why it has nothing to show

The Settings modal's shows section is fed by a per-studio shows query, and its readiness flag only
ever flips on success. Two non-success outcomes therefore used to be rendered as "Loading shows…"
forever: a **failed** fetch, whose answer has already come back, and an **offline-paused** fetch,
which under react-query's default `networkMode: 'online'` is held rather than run — so `isPending`
stays true and `isError` stays false indefinitely.

The section SHALL distinguish three states, not two: loading, unavailable-because-failed, and
unavailable-because-offline. The offline state SHALL be identified by the query's own
`fetchStatus === 'paused'` (ANDed with `isPending`, so a paused *background* refetch over drafts
already on screen — which withholds nothing — says nothing), and SHALL be suppressed entirely for
a disabled query (an account with no team never fetches, so it neither errors nor pauses). Each
state SHALL carry copy of its own in both the show picker and the show-fields placeholder: the
picker shows `— Offline —`, `— Unavailable —`, or `Loading shows…`, and the placeholder says
`You’re offline — can’t load shows.`, `Couldn’t load shows.`, or `Loading shows…`.

**A Retry SHALL be offered on the error state and SHALL NOT be offered on the offline hold.** On
error it is the only way out without reopening the modal, since the readiness flag never flips on
an errored query. On the offline hold it would be a dead control: `refetch()` on a paused query
reaches `Query#fetch` with `fetchStatus === 'paused'` and `data === undefined`, which takes the
`retryer.continueRetry()` branch — that only clears the retry-cancelled flag and returns the
still-pending promise, starting no fetch. What resumes a paused query is `onlineManager` firing on
reconnect, with or without a click, so the offline branch SHALL instead state that recovery is
automatic (`Shows will load on their own once you’re back online.`).

Both unavailable states SHALL scope to the **shows** section only. Neither reaches the readiness
flag, so the shows scope contributes nothing to the modal's dirty state and a save omits
`show_updates` — while the **account scope stays fully editable and saveable throughout**. The
Add-Show control and the show picker stay disabled/hidden while shows are unavailable, because
there is no studio-scoped show list to act on.

#### Scenario: A failed shows fetch is named and retryable

- **WHEN** the shows query for the selected team fails
- **THEN** the picker reads `— Unavailable —`, the placeholder reads `Couldn’t load shows.`, and a
  Retry control is offered that re-issues the query

#### Scenario: An offline hold is not shown as loading, and offers no dead Retry

- **WHEN** the browser goes offline while the shows query is pending, so the fetch is paused
- **THEN** the picker reads `— Offline —`, the placeholder reads `You’re offline — can’t load
  shows.`, no Retry is offered, and the section states that shows will load on their own once
  connectivity returns

#### Scenario: The account scope is unaffected by an unavailable shows query

- **WHEN** the shows query is failed or offline-paused and the user edits an account field
- **THEN** Save arms and a save succeeds, carrying the account edit and omitting `show_updates`

#### Scenario: A team-less account sees neither unavailable state

- **WHEN** the modal is open for an account with no team, so no shows query is issued
- **THEN** the section reports neither the error nor the offline state — the disabled query is not
  an unavailable one
