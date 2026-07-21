# web-ui-system (delta)

## ADDED Requirements

### Requirement: Single V5 component vocabulary
The frontend SHALL present one component vocabulary: buttons, form controls, and dialogs render
in the V5 glass style (glass gradient surfaces, `--v5-border-strong` borders, uppercase tracked
label type for buttons, sky-tinted primary, red-tinted danger), and no surface renders the
legacy flat grey chrome. This is a steady-state requirement about the rendered result — the
migration mechanism (re-skinning the legacy class family in place versus porting consumers) is
a design decision (design D1), not a spec obligation, and later retiring the legacy class
family at zero consumers is compatible with this requirement.

#### Scenario: Export modal buttons match the workspace vocabulary
- **WHEN** the Export dialog renders its CSV/JSONL/Close actions
- **THEN** they render as V5 glass buttons (primary variants sky-tinted) with no flat legacy
  grey (`#2a2d36`) chrome

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
- **WHEN** the web source is checked for `\bwindow\.(confirm|prompt)\b` and for calls to the
  bare `confirm`/`prompt` globals (the shared `useConfirm` hook's own `confirm({...})` API and
  identifiers like `confirmElement` are not matches)
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
- **WHEN** the user edits any Settings field (show name/code/next-episode, categories,
  palette, default frame rate, account names) after open
- **THEN** Save becomes enabled, and after a successful save it returns to the saved state

#### Scenario: Close with unsaved changes warns
- **WHEN** the user closes the Settings modal (button, Escape, or overlay) with unsaved edits
- **THEN** a themed discard confirmation intervenes; declining keeps the modal open with edits
  intact

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
