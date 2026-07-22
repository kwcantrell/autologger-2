# web-session-console (delta)

## ADDED Requirements

### Requirement: Workspace tab IA (single owner)
This capability is the sole owner of the session-workspace tab inventory, order, and labels.
The workspace SHALL present exactly five top-level tabs in one `Feed tabs` tablist, in order:
**Event Feed, Transcript, Topics, Assistant, Dashboards**, defaulting to Event Feed.
Transcript and Topics SHALL be top-level panels (not nested under an agent tab); the agent
surfaces carry the names "Assistant" (chat) and "Dashboards" (AI v2) — the labels "AI" and
"AI v2" SHALL NOT appear in the tab navigation (other capabilities' references to tab labels
are non-normative and defer here). All five panels SHALL stay mounted with visibility toggled
via the `hidden` attribute (the established mounted-hidden discipline), and the Dashboards
panel SHALL keep `key={sessionId}` at its mount site. (The Assistant panel is deliberately
NOT keyed by session — its cross-session conversation persistence is pre-existing behavior,
recorded as an accepted residual in design.)

#### Scenario: Tab inventory and default
- **WHEN** a session workspace mounts
- **THEN** the `Feed tabs` tablist contains exactly Event Feed, Transcript, Topics, Assistant,
  Dashboards, with Event Feed selected

#### Scenario: Chat survives tab switches (no unmount)
- **WHEN** the user switches from Assistant to any other tab and back
- **THEN** the chat panel's DOM node is the same object (never unmounted) and an in-flight
  stream is not aborted

#### Scenario: Tab strip on narrow viewports
- **WHEN** the viewport is under 768px wide
- **THEN** the tablist scrolls horizontally with single-line tab labels (no wrapping), and
  every tab remains reachable by keyboard

### Requirement: Stopped-state logging visibility
The category button strip SHALL be visible in the stop and play transport states (buttons
disabled), accompanied by inline hint copy naming why they are disabled and how to enable them
("press Roll"). While the live dock is shown (rolling or audio-recording) the strip SHALL
continue to dock into the live-log panel as before.

#### Scenario: Stopped session teaches the core loop
- **WHEN** a session is open with transport stopped
- **THEN** the category buttons render disabled in the capture strip with a visible hint that
  logging enables while timecode rolls

#### Scenario: Play state composes strip and playback panel
- **WHEN** recorded audio is playing (play transport state)
- **THEN** the disabled strip and the timeline playback panel are both visible without layout
  breakage

### Requirement: Logging hotkeys 1–9
While the live dock is shown (rolling or audio-recording — the same condition that enables the
live category tiles), digit keys `1`–`9` SHALL trigger the 1st–9th category buttons (identical
behavior to clicking, including dropdown/text modal flows), and the first nine live tiles
SHALL display their digit as a badge (`aria-hidden`). Hotkeys SHALL fire at most once per
physical keypress (auto-repeat ignored via `event.repeat`), and SHALL NOT fire: while a
text-entry element (input, textarea, select, contenteditable) has focus; while any
`[role="dialog"]` is open; or with Ctrl, Meta, or Alt held. Shift is deliberately permitted
(digits require Shift on some layouts).

#### Scenario: Hotkey logs an event
- **WHEN** the live dock is shown and the user presses `2` with no dialog open and focus
  outside any input
- **THEN** the second category button's action fires (e.g. a BUTTON-type category logs an
  event)

#### Scenario: Held key logs once
- **WHEN** the user holds a digit key so the OS auto-repeats it
- **THEN** exactly one activation fires for the physical keypress

#### Scenario: Hotkeys stay out of text entry
- **WHEN** focus is in an input, textarea, select, or contenteditable and the user presses a
  digit
- **THEN** no category action fires

### Requirement: Discoverable keyboard-shortcut reference
The workspace SHALL provide a keyboard-shortcut reference dialog listing the real shortcuts
with their real scopes (1–9 logging while the live dock is shown; Space play/pause; arrow
scrub 1s / Shift 10s **when the timeline playhead is focused**; +/− zoom; Esc; ?), opened by
the `?` key and by a visible labeled control in the Session Controls panel. The `?` key guard
is: not in text entry, no dialog open, no Ctrl/Meta/Alt — **Shift is permitted** (it is how
`?` is typed on most layouts).

#### Scenario: Opening the reference
- **WHEN** the user presses `?` (Shift+/) outside text entry with no dialog open, or activates
  the Session Controls keyboard button
- **THEN** the shortcut reference dialog opens listing the shortcuts above

### Requirement: Transport tooltips
Each transport tile SHALL expose its action as a tooltip (matching its aria-label) on hover
and on keyboard focus.

#### Scenario: Hovering or focusing an enabled tile
- **WHEN** the pointer rests on, or keyboard focus reaches, an enabled transport tile
- **THEN** a tooltip names the action (e.g. "Roll timecode")

### Requirement: Truthful recording indication (two scoped sources)
Recording indication SHALL be truthful per its scope, and the two indicators have different,
deliberate sources: the shell's top-bar recording strip (pulsing dot, "Recording audio", live
duration) reflects **this client's** recorder phase — visible only while this browser's
microphone is actively recording (not during upload), hidden when recording stops **and when
the recorder unmounts mid-recording** (session close/switch, route change). The Session
Controls status line (red "Recording" with pulsing dot) reflects the **session-wide recording
lease** (any client). The duration counter SHALL NOT be announced repeatedly by assistive
technology (its per-second updates are excluded from the live region; only the strip's
appearance/disappearance announces). Both pulses are static under reduced motion.

#### Scenario: Recording strip lifecycle
- **WHEN** this client starts recording, then stops
- **THEN** the top-bar strip appears with a running duration during recording and is hidden
  after stop

#### Scenario: Unmount while recording clears the strip
- **WHEN** the recorder unmounts while recording (user navigates to /teams or closes the
  session)
- **THEN** the strip is hidden (no stale "Recording audio" indicator persists)

#### Scenario: Remote client recording
- **WHEN** another client holds the recording lease
- **THEN** the Session Controls status shows Recording (session truth) while the top-bar strip
  stays hidden (this client's microphone is not recording) — a deliberate divergence

### Requirement: Honest capability gating on generation features
When transcript or topic generation returns HTTP 503 (feature not configured on this
deployment), the panel SHALL latch that state **per mounted panel** (persisting across session
switches within the mount; cleared by reload — the copy SHALL tell the operator to reload
after configuring): the generate control becomes non-actionable with the reason reachable by
keyboard and assistive technology (visible text or `aria-describedby` on a focusable
`aria-disabled` control — not solely a mouse `title`), and the empty-state copy names the
cause and the remedy (transcription: DeepGram API key on the server, with the audio-egress
consequence; topics: no integration configured) plus the manual alternative. Generation
errors SHALL render in exactly one channel (inline in the panel), not duplicated as toasts.

#### Scenario: Unconfigured transcription discovered once
- **WHEN** Auto Generate returns 503 on the Transcript tab
- **THEN** the control becomes non-actionable with a keyboard-reachable reason, the empty
  state explains the DEEPGRAM_API_KEY requirement (and reload-after-configuring) and points
  at Insert, and no toast duplicates the message

#### Scenario: Non-503 generation failure
- **WHEN** generation fails with a non-503 error
- **THEN** the error renders once, inline in the panel toolbar, with the server's detail text

### Requirement: Session-ID copy chip
The Session Controls session-ID line SHALL be an explicit copy affordance: a button with a
copy glyph and "Copy session ID" labeling. On activation it copies the ID to the clipboard
and confirms via toast; when the Clipboard API is unavailable (e.g. non-secure LAN origins,
a documented deployment mode) it SHALL report failure or fall back — never a silent no-op.

#### Scenario: Copying the session ID
- **WHEN** the user activates the session-ID chip in a secure context
- **THEN** the session ID is written to the clipboard and a confirmation toast appears

#### Scenario: Clipboard unavailable
- **WHEN** the user activates the chip where `navigator.clipboard` is unavailable
- **THEN** the UI reports the failure (or provides a selectable fallback) — it does not
  silently do nothing
