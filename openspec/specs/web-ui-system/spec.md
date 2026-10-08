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
The frontend SHALL present one component vocabulary, **Show Ignition**:
- flat dark surfaces, with no glass gradients;
- one accent colour for primary actions, selection and focus;
- one corner radius and height for controls (buttons, inputs, selects, logging buttons, menus' triggers) and one corner radius for cards and panels;
- sentence-case button labels in the UI face, with uppercase tracked type reserved for labels, tab names, table column headers and status pills;
- a red-tinted danger variant;
- **one selected state:** an accent tint with a 1px inset accent line, used for the active session row, the current Settings section, the chosen item in single-choice (radio) menus and pressed segmented controls. A selected state SHALL NOT use a coloured side stripe wider than 1px. Multi-select checkbox menu items (for example the event filter) keep their checkmark-only treatment (web-session-console "Event filter checkmarks").

No surface SHALL render the legacy flat grey chrome or the retired V5 glass surfaces. This is a steady-state requirement about the rendered result. Retiring the V5 token family and legacy class hooks is a design decision, not a spec obligation. A shared component layer that new surfaces build on SHALL render this same vocabulary by default, so a surface ported onto it does not change appearance class. (The requirement keeps its historical name.)

#### Scenario: Export tab actions match the workspace vocabulary
- **WHEN** the Export feed tab renders its CSV/JSONL download actions
- **THEN** they render as Show Ignition buttons (sentence-case labels, control radius, the primary variant accent-tinted where applicable) with no flat legacy grey (`#2a2d36`) chrome and no glass gradient

#### Scenario: Disabled buttons are visibly non-interactive without hover response
- **WHEN** any button in the shared vocabulary is disabled and hovered
- **THEN** it stays at reduced opacity with muted text and no hover border/background change

#### Scenario: Shared-layer button renders the V5 vocabulary
- **WHEN** a button from the shared component layer renders in its default, primary, and destructive variants
- **THEN** each renders a sentence-case label at the shared control height and radius on a flat surface, the primary variant accent-tinted and the destructive variant red-tinted, and its disabled state shows no hover response

#### Scenario: One selected state everywhere
- **WHEN** the active session row, the current Settings section, the chosen item in a single-choice menu and a pressed segmented control are rendered
- **THEN** all four use the same accent tint and 1px inset accent line, and none uses a side stripe wider than 1px

### Requirement: Themed confirmations replace browser chrome
Destructive or discard-style confirmations SHALL use a shared themed confirm (an alert dialog
on desktop and a bottom sheet on mobile, danger-variant confirm action where the action is
destructive; Escape, overlay dismissal, and mobile sheet drag-dismiss all resolve as decline).
The frontend SHALL invoke neither `window.confirm`/`window.prompt` nor the bare
`confirm()`/`prompt()` globals — including hook-initiated flows.
If a pending themed confirmation is replaced by another or unmounted before the user decides,
the pending decision SHALL resolve as declined (no awaiting flow may hang).
A themed decision MAY be **three-way**: confirm, cancel, and dismiss. In a three-way decision, the
cancel button is an action of its own, and dismissal (Escape, overlay, drag-dismiss, replacement,
or unmount) SHALL resolve as **dismiss**, distinct from cancel. Two-way confirmations are
unchanged. The version-conflict dialog is three-way.

#### Scenario: Deleting a log row
- **WHEN** the user activates a row's Delete action outside batch-edit mode
- **THEN** a themed dialog titled for the action offers Cancel and a danger-styled Delete, and
  the row is deleted only on explicit confirm

#### Scenario: No browser-native confirm/prompt remains
- **WHEN** the web source is checked for invocations of `window.confirm`/`window.prompt` or
  the bare `confirm()`/`prompt()` globals (comment prose and the `useConfirm` hook's own API
  are not matches)
- **THEN** there are zero occurrences, and a repo test fails the build on any new occurrence

#### Scenario: Orphan-recording recovery warning is themed and race-safe
- **WHEN** a session opens with an orphan recording (recording event with no matching stop)
- **THEN** the synthetic-stop decision renders once per session mount in the themed confirm
  dialog (modal — workspace interaction paused as with any Radix modal); dismissal by any
  means is decline (nothing is posted); on accept the client SHALL re-validate the orphan
  against current events/status and the recording lease before posting, and SHALL no-op
  (dismissing the dialog) if the orphan no longer exists or the lease is alive; the posted
  `marked_at_utc` is accept-time, and the dialog copy SHALL NOT promise a specific timecode;
  a pending decision SHALL be dismissed (as decline) on session switch

#### Scenario: A three-way decision tells dismissal from cancel

- **WHEN** a three-way themed decision is dismissed by Escape, an overlay click, or unmount
- **THEN** it resolves as dismiss, not as its cancel action, and two-way confirmations still
  resolve such dismissal as decline

### Requirement: Global single-key handlers yield to dialogs and interactive targets
Global single-key shortcuts (Space play/pause, `+`/`−` zoom, `1–9` logging, `?`) SHALL NOT
fire while any dialog, alert dialog, or menu is open (`role` `dialog`, `alertdialog`, or `menu`),
and SHALL NOT intercept a key when the event target
is a button or other interactive element that consumes that key (a focused button's Space
activation always wins over the global handler).

#### Scenario: Space activates a focused confirm button, not playback
- **WHEN** a themed confirm dialog is open in a session with recorded audio and the user
  presses Space with the confirm button focused
- **THEN** the button activates and audio playback does not toggle

#### Scenario: Zoom keys ignored behind dialogs
- **WHEN** any dialog is open and the user presses `+` or `−`
- **THEN** the timeline zoom does not change

#### Scenario: Shortcuts yield to an open confirm
- **WHEN** a themed confirm is open as an alert dialog and the user presses Space, `+`, a digit
  `1`–`9`, or `?` with focus outside any control that consumes the key
- **THEN** no global shortcut fires

### Requirement: AA contrast floor on rendered surfaces
Text and data labels SHALL meet WCAG AA (≥4.5:1, composited over the surface's effective base color) on the surfaces they render on. That includes:
- timeline tick timecodes;
- inactive feed-tab labels;
- panel and section labels;
- input placeholder text;
- recent-session row metadata;
- the timeline total-duration readout;
- secondary actions in Settings rows;
- primary button labels;
- dialog and side-panel close buttons;
- the login page's secondary sign-in link;
- the transport status label in every transport state (stopped, rolling, recording, playback) over the tinted surfaces that state produces.

The chosen token values are the reference implementation evidence, not the requirement; any replacement SHALL still clear the floor. Disabled controls are exempt (WCAG 1.4.3 incidental text). Colors chosen by users as data (for example category colors) are outside this requirement.

#### Scenario: Timeline ticks are legible
- **WHEN** the session timeline renders its tick timecodes
- **THEN** their computed contrast against the timeline lane is at least 4.5:1 (the prior `rgba(229,238,252,0.36)` = 2.96:1 is a regression)

#### Scenario: Inactive tab labels are legible
- **WHEN** a feed tab is not selected
- **THEN** its label contrast against the tab surface is at least 4.5:1

#### Scenario: Recent-session metadata is legible
- **WHEN** the recent-sessions list renders a row's date/event-count line and duration
- **THEN** each has contrast of at least 4.5:1 against the row surface, including the selected row's tinted surface while recording

#### Scenario: Timeline total duration is legible
- **WHEN** the timeline renders its total-duration readout
- **THEN** its contrast against the timeline surface is at least 4.5:1, with no extra opacity reduction

#### Scenario: Event-button secondary action labels are legible
- **WHEN** a Settings row renders a secondary action (for example an event button's Edit)
- **THEN** its label contrast against the row surface is at least 4.5:1

#### Scenario: Primary button labels are legible
- **WHEN** a primary (accent-tinted) button renders, e.g. New Session's "Create & open"
- **THEN** its label contrast against the button's tinted surface is at least 4.5:1

#### Scenario: Placeholders and dialog close buttons are legible
- **WHEN** a dialog or side panel renders an empty text field with a placeholder and its close button
- **THEN** the placeholder and the close glyph each have contrast of at least 4.5:1 against their surfaces

#### Scenario: Login secondary link is legible
- **WHEN** the signed-out login page renders "Create an account with Google"
- **THEN** its label contrast against the link surface is at least 4.5:1

#### Scenario: The transport status label is legible in every state
- **WHEN** the transport status renders STOPPED, ROLLING, REC and PLAY over the surfaces each state tints
- **THEN** each label's contrast against its own pill surface is at least 4.5:1

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
The Settings view SHALL make its save state legible in both of its editing patterns.

**Inline sections** (Account, Team details, Show details, and the Event buttons palette):
- A section-level save bar SHALL offer Save, which is disabled and labeled as saved when there are no unsaved changes and enabled when any edit exists.
- Leaving the section or closing the view with unsaved inline edits SHALL warn through the themed confirm dialog before discarding.

**Side panels** (a member, a show, an event button):
- Each panel SHALL offer Cancel and Save, with Save disabled until the panel has a change and a valid required field.
- Closing a panel with unsaved changes, by Cancel, its close control, Escape or a click outside it, SHALL warn through the themed confirm dialog before discarding.
- Save SHALL apply the panel's changes and close it. If any part of the save fails, the panel SHALL stay open with a message naming what did not apply.

**In both patterns:**
- Every Settings save that writes the profile SHALL carry the active `active_studio_id` and SHALL echo the currently active `active_show_id`, so saving any section or panel never changes the active team or show as a side effect (the profile write rejects a missing team and treats a missing show as "pick the first").
- Dirtiness SHALL be derived by comparing current form state against the initialized snapshot, not by a hand-armed per-callsite flag. An un-instrumented mutation path can then neither brick Save nor skip the discard guard.
- The Add-Show flow SHALL collect the show's details in a themed side panel.
- Copy SHALL match the actual save model: there are no "auto-saves" claims for draft-then-Save behavior.

#### Scenario: Editing any field enables Save
- **WHEN** the user edits any inline Settings field (account names, team name, default frame rate, show name/code/title suffix, palette preset) after open
- **THEN** that section's Save becomes enabled, after a successful save it returns to the saved state, and the active team and show are unchanged

#### Scenario: Close with unsaved changes warns
- **WHEN** the user switches section or closes the Settings view (its back control or Escape) with unsaved inline edits
- **THEN** a themed discard confirmation intervenes, and declining keeps the user where they were with edits intact

#### Scenario: Closing a panel with unsaved changes warns
- **WHEN** the user edits a field in a side panel and then cancels, presses Escape, or clicks outside the panel
- **THEN** a themed discard confirmation intervenes, and declining keeps the panel open with edits intact

#### Scenario: A partly failed panel save stays open
- **WHEN** a panel's Save issues several requests (for example a role change and two grant changes) and one of them fails
- **THEN** the panel stays open, names the change that did not apply, and the changes that did apply are reflected without a reload

### Requirement: Generation instruction fields in Settings
The event-button side panel in Settings › Event buttons SHALL let the user view and edit each BUTTON, DROPDOWN and TEXT button's optional `auto_instruction`: multi-line-capable text entry, max 2000 chars, clearable to absent.

For DROPDOWN buttons:
- the panel SHALL also let the user edit each dropdown option's optional `auto_instruction`, alongside the option's label and needs-context fields;
- the whole-button instruction SHALL remain editable.

For ON_OFF buttons:
- the panel SHALL NOT offer the field, because they are excluded from generation;
- switching a button's type to ON_OFF SHALL drop its instructions from the draft.

Instruction edits SHALL participate in the panel's draft-then-Save model (enable Save, discard-guard on close) through the snapshot comparison, with no new per-field dirty flag.

An **instruction-bearing** button is one whose own instruction is non-empty, or any of whose options' instructions are (per `auto-event-generation`'s definition). Each such button SHALL be visibly distinguishable in the Event buttons list, through a compact indicator or summary, so users can tell which buttons take part in AUTO GENERATE without opening each panel. A DROPDOWN whose instructions are only on its options lights the indicator.

The Copy-Buttons-From flow SHALL carry instruction fields with the copied buttons.

#### Scenario: Editing an instruction arms Save
- **WHEN** the user types an instruction in a button's panel and presses Escape without saving
- **THEN** the panel's Save had become enabled and the themed discard confirmation intervenes

#### Scenario: Dropdown options carry their own instructions
- **WHEN** the user opens the panel for a DROPDOWN button
- **THEN** each option row offers its own instruction field, the whole-button instruction is also editable, and saved values round-trip on reopen

#### Scenario: Copy from show preserves instructions
- **WHEN** the user copies buttons from another show whose buttons carry instructions
- **THEN** the copied buttons include the button- and option-level instruction fields

#### Scenario: ON_OFF buttons offer no instruction field
- **WHEN** the user views an ON_OFF button's panel, or switches an instruction-bearing BUTTON to ON_OFF in its panel
- **THEN** no instruction field is offered, and the switched button's draft carries no instructions

#### Scenario: Option-only instructions light the indicator
- **WHEN** a DROPDOWN button has instructions only on its options
- **THEN** its row in the Event buttons list shows the instruction-bearing indicator

### Requirement: New Session progressive disclosure
The New Session modal SHALL present the core flow (show, episode, notes, create) directly, with
YouTube import and timecode settings (frame rate, start offset) behind collapsed disclosures
whose summaries show the current values; defaults SHALL be safe without opening either
disclosure. The episode control follows the show's title-suffix preference (session-title-suffix
"New Session modal respects suffix"); the modal SHALL NOT offer a bonus-episode control.

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
While the Settings view is closed it SHALL do no form-initialisation work, issue no shows request, and render no element tree. (The requirement keeps its historical name.)

The view initialises in **two independent scopes**, and both SHALL be gated on the view being open:
- **The account scope** initialises from the profile, which is already in hand before the view can open. This scope covers the account names and the active team's settings (the default frame rate). It SHALL NOT run merely because the profile query resolved while the view is closed.
- **The shows scope** hydrates the per-show drafts from the **per-studio shows query** whose states `The Settings shows section says why it has nothing to show` governs. It does not hydrate from the profile, whose `shows[]` carries only the brief shape. That query SHALL be disabled while the view is closed, so a closed view fetches no draft source at all.

The shell SHALL mount the view **only while it is open**, gated on shell state that records whether Settings is open and which section it shows. The view is one of the split surfaces enumerated by `web-frontend-platform`'s `The client island is route-split behind recoverable boundaries`. That requirement owns the split-point inventory, the chunk-boundary mechanics and the idle prefetch that warms this chunk, and this requirement does not restate them. An unconditional mount that relies on a primitive to render nothing SHALL NOT be used: behind the lazy chunk it would download the view's bytes on every page load.

Route-change survival remains normative. The open gate SHALL be shell state and SHALL NEVER be the URL or a route branch, so an open view survives a route change instead of desynchronising from what is rendered. The one route that opens the view, `/teams`, does so by setting that shell state (team-management "Teams management page"). The view still gates its own hydration on being open, so the guarantee does not depend on the mount gate alone.

The chunk boundary is an **overlay** boundary with a `null` fallback, a discipline `web-frontend-platform` owns. So while a cold settings chunk is in flight, nothing is rendered on screen and the invoking control offers no busy affordance. This is a known, unclosed gap recorded in the `perf-audit-remediation` proposal, not a property of this requirement.

#### Scenario: Initialisation is deferred until the modal opens
- **WHEN** the app loads with Settings closed and the profile query resolves
- **THEN** neither scope initialises: no account fields are hydrated from the profile, no shows query is issued, and no show drafts are built. That work happens on the first open instead, and the account scope initialises once per open.

#### Scenario: A closed modal renders nothing
- **WHEN** the shell renders with Settings closed
- **THEN** the view contributes no elements: it is not mounted at all, and its module is not fetched by the initial page load

#### Scenario: A cold first open traverses the chunk boundary
- **WHEN** the user opens Settings before the idle prefetch has completed
- **THEN** the lazy chunk is fetched, the boundary's `null` fallback renders nothing for the duration of that fetch, and the view appears once the chunk resolves

#### Scenario: An open modal is unaffected
- **WHEN** the user opens Settings, and while it is open the route changes
- **THEN** the view stays open, on the same section, and functional across the route change

### Requirement: Settings modal defers inactive tab content
The Settings view SHALL mount a section's content on that section's first visit, not on open, and SHALL NOT unmount it on a later section switch while the view stays open. Each navigation control's `aria-controls` target SHALL resolve to a present element whether or not that section's content has mounted. (The requirement keeps its historical name.)

The view's sections are:
- **You:** Account, Companion devices.
- **Team:** Members, Shows, Team details.
- **Show:** Show details, Event buttons.

There is no Auto Sync section and no Debug section.

Each open SHALL restart this discipline on the section the open names: the section the invoking control asks for, otherwise the section last visited during this page load, initially Show details. The open SHALL never commit a previously visited section's content to the DOM. A reset applied after the opening commit would mount that content and then remove it, which is the cost this requirement exists to remove.

Deferral SHALL NOT change what a save writes, and SHALL NOT arm the unsaved-changes state. The view owns the show drafts and the comparison snapshot, so an inline section's save SHALL persist that section's edits regardless of which other sections were visited. Mounting a section's content SHALL NOT by itself make the view read as dirty.

#### Scenario: Companion devices is listed in the You group
- **WHEN** the Settings view is open for any role
- **THEN** the "You" group's navigation lists Account and then Companion devices, and the
  Companion devices content mounts only on its first visit

#### Scenario: Opening the modal mounts only the active tab's content
- **WHEN** the user opens Settings from the rail
- **THEN** only the named section's content is mounted, the other sections' contents are not, and every navigation control's `aria-controls` target resolves to a present element

#### Scenario: Activating a tab mounts its content and keeps it mounted
- **WHEN** the user visits Event buttons and then switches to Show details
- **THEN** the Event buttons content mounts on that first visit and remains mounted across the switch, so its in-section state (such as a scroll position or a palette preview) survives the round trip

#### Scenario: Reopening never transiently mounts the previous tab's content
- **WHEN** the user visits Event buttons, closes Settings, and reopens it on Members
- **THEN** the Event buttons content is not mounted at any point during the reopen. This is observable as zero mounts of that content between close and the settled reopened state, not merely as its absence afterwards.

#### Scenario: Removed sections are gone
- **WHEN** the Settings view is open for any role
- **THEN** no Auto Sync and no Debug section or navigation control is present

#### Scenario: Saving persists shows whose tab was never visited
- **WHEN** the user opens Settings on Show details, edits the show's name, and saves without ever visiting Event buttons
- **THEN** the save submits the same show update (the show's name together with its unchanged categories and palette) it would have submitted had Event buttons been visited, and the section returns to its saved state

#### Scenario: Mounting a deferred tab does not arm the discard guard
- **WHEN** the user opens Settings, visits Event buttons, edits nothing, and closes Settings
- **THEN** no unsaved-changes confirmation intervenes and the view closes directly

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

The Settings view's show-backed sections (Shows, Show details and Event buttons) are fed by a per-studio shows query whose readiness flag only ever flips on success. Two non-success outcomes therefore used to be rendered as "Loading shows…" forever:
- a **failed** fetch, whose answer has already come back;
- an **offline-paused** fetch. Under react-query's default `networkMode: 'online'` such a fetch is held rather than run, so `isPending` stays true and `isError` stays false indefinitely.

Each show-backed section SHALL distinguish three states, not two: loading, unavailable-because-failed, and unavailable-because-offline.
- **Offline:** identified by the query's own `fetchStatus === 'paused'`, ANDed with `isPending`. A paused *background* refetch over drafts already on screen withholds nothing, so it says nothing.
- **Disabled query:** the states SHALL be suppressed entirely. An account with no team never fetches, so it neither errors nor pauses.
- **Copy:** each state SHALL carry its own placeholder: `You’re offline — can’t load shows.`, `Couldn’t load shows.`, or `Loading shows…`.

**A Retry SHALL be offered on the error state and SHALL NOT be offered on the offline hold.**
- **On error,** Retry is the only way out without reopening Settings, since the readiness flag never flips on an errored query.
- **On the offline hold,** Retry would be a dead control. `refetch()` on a paused query reaches `Query#fetch` with `fetchStatus === 'paused'` and `data === undefined`, which takes the `retryer.continueRetry()` branch. That only clears the retry-cancelled flag and returns the still-pending promise, starting no fetch. What resumes a paused query is `onlineManager` firing on reconnect, with or without a click. The offline branch SHALL instead state that recovery is automatic (`Shows will load on their own once you’re back online.`).

Both unavailable states SHALL be scoped to the show-backed sections only.
- Neither reaches the readiness flag, so show drafts contribute nothing to dirty state and a save omits `show_updates`.
- **The Account and Team details sections stay fully editable and saveable throughout.**
- The Add-show control and the top bar's show menu stay disabled while shows are unavailable, because there is no studio-scoped show list to act on.

#### Scenario: A failed shows fetch is named and retryable

- **WHEN** the shows query for the active team fails
- **THEN** the show-backed sections read `Couldn’t load shows.` and offer a Retry control that re-issues the query

#### Scenario: An offline hold is not shown as loading, and offers no dead Retry

- **WHEN** the browser goes offline while the shows query is pending, so the fetch is paused
- **THEN** the show-backed sections read `You’re offline — can’t load shows.`, no Retry is offered, and they state that shows will load on their own once connectivity returns

#### Scenario: The account scope is unaffected by an unavailable shows query

- **WHEN** the shows query is failed or offline-paused and the user edits an account field
- **THEN** the Account section's Save arms and a save succeeds, carrying the account edit and omitting `show_updates`

#### Scenario: A team-less account sees neither unavailable state

- **WHEN** Settings is open for an account with no team, so no shows query is issued
- **THEN** no section reports the error or the offline state, because the disabled query is not an unavailable one

### Requirement: Top bar names the active team, show and transport state
On every signed-in route the shell SHALL render a top bar whose leading items read, in order: the active team's name, the active show's name, and the open session's transport status. The bar has no wordmark and no "Team"/"Show" labels.

**Team menu.** Activating the team name SHALL open a menu of the user's teams. Each entry shows the user's role in it and the team's show count (from the profile's brief show list). Choosing a team SHALL make it the active team immediately, with no separate Save step. It SHALL persist through the existing profile write of `active_studio_id`, omitting `active_show_id` so the server selects the new team's first show, exactly as the Settings modal's mid-switch save did. The same no-open-session guard and close-session path apply as for any active-team change (web-session-routing "Legacy selection spine retired").

**Refresh after a switch.** After a successful team or show switch the app SHALL refetch the session list, events, session status and show categories, as the Settings modal's save did (web-coordination-seam "The settings modal still refetches the session list").

**Show menu.** Activating the show name SHALL open a menu of the active team's shows (names only; no per-show counts, which no endpoint serves). Choosing one SHALL persist `active_show_id` immediately.

**Status.** The status SHALL show STOPPED, ROLLING, REC or PLAY (web-session-console "Transport state tints the shell"), with the open session's name, as a control that returns to that session's console from anywhere in the shell (including over the Settings view). With no session open it SHALL read that no session is open and SHALL NOT be actionable.

**Errors and access.**
- A failed team or show switch SHALL leave the previous selection shown and name the failure.
- Shows the user cannot access stay listed in the show menu, as the rail lists them (web-home-launch "Session actions follow show access").

**Keyboard and narrow screens.** The menus SHALL be keyboard-operable (open, move, choose, Escape to dismiss). The bar SHALL remain on one line at phone widths, truncating names rather than wrapping.

#### Scenario: Switching team from the top bar
- **WHEN** a user on `/` opens the team menu and chooses another team
- **THEN** that team and the show the server selects become active without a Save step, the rail lists that show's sessions without waiting for any stale time, and a reload keeps the new selection

#### Scenario: Switching team while a session is open
- **WHEN** a user on `/sessions/<id>` chooses another team from the top bar
- **THEN** the app follows the close-session path to `/`, exactly as the close-session control does

#### Scenario: Status returns to the open session
- **WHEN** a session is recording and the user, inside Settings, activates the top bar's REC status
- **THEN** Settings closes and that session's console is shown

#### Scenario: No session open
- **WHEN** the user is on `/` with no session open
- **THEN** the status reads that no session is open and activating it does nothing

#### Scenario: Phone width keeps one line
- **WHEN** the top bar renders at a 390px-wide viewport with long team and show names
- **THEN** team, show and status stay on one line, the names are truncated with an ellipsis, and the page does not scroll horizontally

### Requirement: The Settings view is modal to the console
While the Settings view is open it SHALL be exposed as a modal dialog (`role="dialog"`, `aria-modal="true"`, labelled by its heading), so every console hotkey that yields to open overlays — logging 1–9, Space play/pause, zoom, and the shortcut reference — does nothing while it is open, even though the session workspace stays mounted beneath it. Focus SHALL move into the view on open and return to the invoking control on close. The view's own keys (`[` to toggle the sidebar excepted, which the shell owns) SHALL NOT reach the console.

#### Scenario: Digits do not log while Settings is open over a live session
- **WHEN** Settings is open over a session that is rolling, focus is on a Settings navigation control, and the user presses 1 and then Space
- **THEN** no event is logged and the transport does not change

#### Scenario: Hotkeys resume after closing
- **WHEN** the user closes Settings and presses 1 with focus back in the console
- **THEN** the first category is logged as before

### Requirement: Shell-level sidebar shortcut
The shell SHALL own a single key listener that toggles the sidebar on `[` on every signed-in route, whether or not a session is open. It SHALL ignore the key while focus is in a text-entry control (input, textarea, select, contenteditable) and while a dialog, alert dialog or menu other than the Settings view is open. The sidebar's built-in Ctrl/⌘+B toggle remains.

#### Scenario: Toggle on the home view
- **WHEN** a user on `/` with no session open presses `[`
- **THEN** the sidebar collapses, and pressing `[` again expands it

#### Scenario: Typing a bracket does not toggle
- **WHEN** focus is in the rail search input and the user types `[`
- **THEN** the character is entered and the sidebar does not toggle

### Requirement: Settings manages the user's Companion devices
The Settings view SHALL have a **Companion devices** section, in the "You" group after Account
(see "Settings modal defers inactive tab content"), available to every
signed-in user whatever their team role (ADR 0021 slice 9d, owner decision 4). It SHALL use the
existing Settings parts and the shared component vocabulary, and it SHALL show and change only the
signed-in user's own devices, through the routes of api-contract-freeze "Companion device
management routes".

- **List.** The section SHALL list the user's devices with name, created time, and last-used time
  or "Never". A device the server reports as `expired` (unused for 90 days, api-contract-freeze
  "Companion device tokens authenticate only the Companion surface") SHALL be marked "Expired"
  and still offer Revoke.
- **Add.** A name field and an Add button SHALL create a device. On success a dialog SHALL show
  the new token in a read-only field with a Copy control and the line "Copy this token now. It
  won't be shown again." The token SHALL live only in that dialog's component state: it SHALL NOT
  be written to the query cache or any storage, and closing the dialog SHALL drop it. The list
  SHALL then show the new device.
- **Revoke.** Each device SHALL offer Revoke, which SHALL ask through the themed confirm dialog
  and then delete the device and refresh the list.
- **Errors.** A failed list, add or revoke SHALL show the response's `detail` (for example the
  ten-device limit) and change nothing else.

The section acts immediately; it has no save bar and no unsaved state, so "Honest save model in
Settings" does not apply to it.

#### Scenario: Adding a device shows its token once
- **WHEN** the user enters a device name, presses Add, copies the token, closes the dialog and
  reopens the section
- **THEN** the dialog showed the token with Copy and the one-time warning, the token was copied,
  the list shows the new device with last used "Never", and the token is shown nowhere afterwards

#### Scenario: Revoking asks first
- **WHEN** the user presses Revoke on a device and declines the confirmation, then presses it
  again and confirms
- **THEN** after declining the device is still listed and no request was sent; after confirming
  the device is deleted and no longer listed

#### Scenario: The device limit is explained
- **WHEN** a user who holds 10 devices adds another
- **THEN** the section shows the server's detail naming the ten-device limit, and the list is
  unchanged

#### Scenario: An expired device is marked
- **WHEN** the list response includes a device with `expired: true`
- **THEN** that device is listed with an "Expired" marker and a Revoke control, and the other
  devices carry no marker

#### Scenario: A member manages their own devices
- **WHEN** a plain member of a team, with no grants, opens Settings
- **THEN** the Companion devices section is enabled, and it lists only that member's devices
