# web-session-console

## Purpose

The session workspace console: the sole owner of the workspace tab inventory/order/labels
(Event Feed, Transcript, Topics, Assistant, Dashboards), plus the console-level UX around
them — stopped-state logging visibility, the 1–9 logging hotkeys, a discoverable keyboard-
shortcut reference, transport tooltips, truthful recording indication from two scoped
sources, honest capability gating on generation features, the session-ID copy chip, and the
feed jump column.

## Requirements

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
When transcript, topic, or event generation returns HTTP 503 (feature not configured on
this deployment), the panel SHALL latch that state **per mounted panel** (persisting
across session switches within the mount; cleared by reload — the copy SHALL tell the
operator to reload after configuring): the generate control becomes non-actionable with
the reason reachable by keyboard and assistive technology (visible text or
`aria-describedby` on a focusable `aria-disabled` control — not solely a mouse `title`),
and the empty-state copy names the cause and the remedy (transcription: DeepGram API key
on the server, with the audio-egress consequence; topics and event generation: no
integration configured) plus the manual alternative. Generation errors SHALL render in
exactly one channel (inline in the panel), not duplicated as toasts.

#### Scenario: Unconfigured transcription discovered once
- **WHEN** Auto Generate returns 503 on the Transcript tab
- **THEN** the control becomes non-actionable with a keyboard-reachable reason, the empty
  state explains the DEEPGRAM_API_KEY requirement (and reload-after-configuring) and points
  at Insert, and no toast duplicates the message

#### Scenario: Non-503 generation failure
- **WHEN** generation fails with a non-503 error
- **THEN** the error renders once, inline in the panel toolbar, with the server's detail text

#### Scenario: Unconfigured event generation latches
- **WHEN** AUTO GENERATE on the event feed returns 503
- **THEN** the control latches non-actionable for the mounted panel with a
  keyboard-reachable reason naming the missing integration and the reload-after-configuring
  remedy, and manual logging remains available unchanged

### Requirement: AUTO GENERATE affordance on the event feed
The event feed tab SHALL provide an AUTO GENERATE control that starts one generation
run for the open session via the `auto-event-generation` endpoint (synchronous POST).
While the request is in flight the control SHALL be non-actionable with a running
indication; generated events appear in the feed live through the existing
`event.changed`-driven refetch (no new WS handling) — this feed-native liveness is the
run's progress display. On completion the run's outcome renders inline in the panel
toolbar — exactly one channel, no toast duplication: the created count (noting when
the per-run cap ended writing early) on success; the server's detail for pre-spawn
refusals (no anchored transcript, no instructions, aggregate bound) and failures; the
busy detail on `409` (retryable, not latched). Run/outcome state SHALL be scoped to
the session the run was started for: switching sessions mid-run leaves the run
completing server-side, and the control renders idle for the newly opened session (no
cross-session state leak through the mounted-hidden panel). When
`GET …/show-categories` reports `auto_instructions_present: false`, the control SHALL
be non-actionable with a keyboard-reachable reason pointing at the Settings
event-buttons table.

#### Scenario: Run shows live rows and a terminal count
- **WHEN** the user clicks AUTO GENERATE and the run creates events
- **THEN** the control shows a running state, new events appear in the feed as they
  are inserted, and on completion the toolbar shows the created count inline

#### Scenario: No instructions configured
- **WHEN** the open session's `show-categories` response has
  `auto_instructions_present: false`
- **THEN** the AUTO GENERATE control is non-actionable with a keyboard-reachable
  reason that points the user at the Settings event-buttons table

#### Scenario: Busy slot is retryable, not latched
- **WHEN** the generate request returns `409` because another AI turn holds the
  session's slot
- **THEN** the detail renders once inline, the control returns to actionable, and no
  503-style latch engages

#### Scenario: Session switch mid-run does not leak state
- **WHEN** the user starts a run on session A and switches to session B before it
  completes
- **THEN** session B's feed shows an idle AUTO GENERATE control, and returning to
  session A shows A's outcome (or idle state) without B ever displaying A's run state

### Requirement: Event feed Auto Generate menu

The event feed Auto Generate control SHALL be a dropdown whose trigger label is
**Auto Generate** (or **Generating…** while a run for this session is pending).
The menu SHALL offer:

1. **Generate All** when the loaded event list has no row with
   `metadata.auto_generated === true`; otherwise **Regenerate All**.
2. **Custom**, which opens a modal.

Generate All SHALL POST generate with no regenerate flag and no selection.
Regenerate All SHALL POST `{ regenerate: true }`. Existing 503 latch,
no-instructions gate, pending/outcome session scoping, and inline error
channels SHALL continue to apply to runs started from the menu.

#### Scenario: Menu flips to Regenerate All after auto events exist

- **WHEN** the session’s loaded events include at least one auto-generated row
- **THEN** the first menu item is labeled Regenerate All

#### Scenario: Custom opens modal without starting a run

- **WHEN** the operator chooses Custom
- **THEN** a selection modal opens and no generate request is sent until submit

### Requirement: Custom generate modal

The Custom modal SHALL list instruction-bearing buttons and, for DROPDOWN
buttons, each option that has a non-empty `auto_instruction`, as independently
selectable entries. Submit SHALL require at least one selected entry and SHALL
POST generate with `selection` only (`regenerate` false/absent). Cancel SHALL
close without generating.

#### Scenario: Custom submit sends selection

- **WHEN** the operator selects one button-level instruction and one option
  instruction and submits
- **THEN** the client POSTs generate with those two selection entries and
  without `regenerate: true`

### Requirement: Event filter checkmarks

In the event feed Filter popover, each toggled-on category (and Show internal
events when on) SHALL show a checkmark beside the label. Selected items SHALL
NOT use the selected background/text highlight tint used elsewhere for
`PopoverItem selected`.

#### Scenario: Visible category shows checkmark

- **WHEN** a show category is not hidden by the filter
- **THEN** its filter row shows a checkmark and is not highlighted via the
  selected tint

### Requirement: Generated events are visibly marked in the feed
Event rows whose metadata carries `auto_generated: true` SHALL render with a compact
visual marker (with an accessible name, e.g. "auto-generated") distinguishing them
from manual rows, so users can identify and clean up a run's output. The marker is
presentation-only: row editing, deletion, jump behavior, and exports are unchanged.

#### Scenario: A generated row is identifiable
- **WHEN** the feed renders an event whose metadata carries `auto_generated: true`
- **THEN** the row shows the auto marker with an accessible name, and a manual row
  shows none

### Requirement: Event refetches coalesce during broadcast bursts
The client SHALL coalesce `event.changed`-driven event refetches during bursts
(debounced to roughly one refetch per second while frames arrive continuously),
instead of one full refetch per frame — bounding the load a bulk generation run (or
any rapid event source) induces on the single server process and on every connected
client. The server's per-insert emission semantics are unchanged; a quiet period
SHALL still end with a refetch that reflects the final state.

#### Scenario: A burst of inserts does not stampede
- **WHEN** 60 `event.changed` frames arrive within a few seconds
- **THEN** the client issues a bounded number of coalesced refetches (not 60), and
  after the burst ends the feed reflects all 60 events

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

### Requirement: Feed jump column

The Event Feed, Transcript, and Topics feeds SHALL each present a dedicated jump column whose
per-row control synchronizes the session timeline to that row's session time. The column's header
SHALL be visually hidden while carrying an accessible label, and the column SHALL NOT reduce the
space available to any existing column's contents.

The control SHALL be a real button with an accessible name identifying the time it jumps to **as
that row displays it** — so in a feed showing wall-clock times the name SHALL name the wall-clock
time the user is pointing at, not an unrendered session time. Activation SHALL be equivalent by
pointer and by keyboard.

Rows that can never jump SHALL carry **no control at all** rather than a permanently inert one:
they render as they do today. `aria-disabled` is reserved for the transient, session-wide rolling
state; in that state all of a feed's rows SHALL reference a **single shared reason node** rather
than one per row, and the control SHALL NOT use the native `disabled` attribute, which removes it
from the accessibility tree.

#### Scenario: Activating the jump by pointer

- **WHEN** the session is not rolling and the user clicks a row's jump control
- **THEN** the timeline's manual scrub position is set to that row's resolved second and the
  timeline is scrolled to it

#### Scenario: Activating the jump by keyboard

- **WHEN** a user focuses a jump control and presses Enter or Space
- **THEN** the same synchronization occurs as for a pointer activation

#### Scenario: The control names what the row displays

- **WHEN** assistive technology reads a jump control in a feed whose time column is showing
  wall-clock times rather than session timecodes
- **THEN** the control's accessible name identifies the wall-clock time shown in that row

#### Scenario: A row that can never jump has no control

- **WHEN** a row has no resolvable position
- **THEN** that row renders no jump control, and no inert control appears in its tab order

#### Scenario: Rolling shares one reason

- **WHEN** the session is rolling and a feed's jump controls are unavailable
- **THEN** the controls are marked `aria-disabled` and reference one shared reason node for the
  feed, not a separate reason node per row

#### Scenario: Existing columns keep their space

- **WHEN** a feed renders with the jump column present
- **THEN** each existing column still displays its full content — in particular a session time of
  the form `HH:MM:SS:FF` is not truncated

### Requirement: Inline editing is untouched by the jump column

Adding the jump column SHALL NOT change inline editing in any feed. No editable field SHALL gain,
lose, or change a handler, become read-only, require a new gesture, or have its containing block
or width altered. How edits begin and commit, and keyboard access to editing, SHALL be unchanged.
Activating a jump SHALL NOT focus an editable field.

#### Scenario: Fields still edit exactly as before

- **WHEN** the user clicks or tabs into any editable field in a feed row and then blurs it
- **THEN** the edit begins and commits exactly as it did before this change

#### Scenario: Jumping does not start an edit

- **WHEN** the user activates a row's jump control
- **THEN** no editable field in that row receives focus, and no edit is begun

### Requirement: Feed rows resolve to a timeline second by frame arithmetic

A row's timeline second SHALL be resolved in the coordinate space used by timeline markers and
audio clips.

A session-time string SHALL be converted by **frame arithmetic**: its hours/minutes/seconds fields
are multiplied out at the session's **rounded** frame rate, the frame field is added, and the
resulting total frame count is divided by the session's **actual** frame rate. Converting such a
string by treating its hours/minutes/seconds as literal seconds SHALL NOT be used — those strings
are produced by decomposing a frame count at the rounded rate, so at non-integer rates (23.976,
29.97, 59.94) the literal reading drifts proportionally to elapsed time.

The converter SHALL accept frame fields of one to three digits, because at frame rates of 100 and
above the renderer emits three-digit frame fields. It SHALL reject a frame field greater than or
equal to the rounded frame rate, and reject minutes or seconds above 59, treating such strings as
unresolvable rather than converting them.

Per feed:

- **Event Feed** rows SHALL resolve from the event's `timecode_total_frames / frame_rate`, and
  SHALL treat an absent frame count as unresolvable rather than substituting a parsed or default
  value.
- **Transcript** rows SHALL resolve from the word's **stored** (last committed) `session_time`
  when it parses, falling back to `start_sec`. The stored string is authoritative because it is
  user-editable and `start_sec` is not recomputed when it is edited.
- **Topics** rows SHALL resolve from the topic's stored `session_time`.

#### Scenario: Non-integer frame rate

- **WHEN** a row in a 23.976 fps session displays the session time `00:59:56:10`
- **THEN** it resolves to approximately 3600.0 seconds — the position where the timeline draws
  that moment's marker and clip boundaries — and not to approximately 3596.4 seconds, the value a
  literal-seconds reading produces

#### Scenario: Three-digit frame field at high frame rates

- **WHEN** a row in a 119.88 fps session displays a session time whose frame field is 100 or
  greater
- **THEN** it resolves successfully rather than failing to parse

#### Scenario: Frame field exceeds the frame rate

- **WHEN** a row's session time carries a frame field greater than or equal to the rounded frame
  rate, such as `00:00:00:99` in a 24 fps session
- **THEN** the row is unresolvable, rather than resolving to a second later than the time the row
  displays

#### Scenario: Session time omits the frame field

- **WHEN** a row's session time is `HH:MM:SS`, or `H:MM:SS` with a single-digit hour
- **THEN** it resolves successfully, with zero frames contributed

#### Scenario: A two-field time is rejected rather than guessed

- **WHEN** a row's session time has only two fields, such as `05:30`
- **THEN** it is unresolvable, because the leading field cannot be distinguished between minutes
  and hours — the two readings differ by more than five hours, and resolving to the wrong one
  would jump into an unrelated part of the session

#### Scenario: A corrected transcript timecode jumps to the corrected position

- **WHEN** the user edits a transcript word's `session_time`, commits it, and jumps from that row
- **THEN** the jump targets the newly entered time, not the word's stale `start_sec`

#### Scenario: A hand-inserted transcript row jumps to its typed time

- **WHEN** the user inserts a transcript word, types a session time into it, commits, and jumps
  from that row
- **THEN** the jump targets the typed time and the playhead is NOT driven to `0`

### Requirement: Rows with no resolvable position

A row whose session time does not resolve to a finite, non-negative timeline second SHALL be
treated as having no position, and SHALL therefore carry no jump control. This includes, at
minimum: transcript words stored anchorless (empty `session_time` with zeroed `start_sec`), topics
whose `session_time` is empty or unparseable, events with no `timecode_total_frames`, and any row
whose session time is rejected by the converter.

#### Scenario: Anchorless transcript word

- **WHEN** a transcript row's word has an empty `session_time` and a zeroed `start_sec`
- **THEN** that row carries no jump control, and its inline editing is unaffected

#### Scenario: Topic with an empty or unparseable session time

- **WHEN** a Topics row's `session_time` is empty, or is text that does not parse as a timecode
- **THEN** that row carries no jump control

### Requirement: Topic jumps require an anchored transcript

Topic session times are authored by a generation model rather than derived from recorded audio.
When the session's transcript is **wholly anchorless** — no word carries a session time — the model
has no timeline positions to draw from and any time it emits is invented. Because such invented
times parse successfully and would therefore appear jumpable, Topics rows SHALL carry no jump
control while the session's transcript is wholly anchorless, regardless of whether their own
`session_time` parses.

#### Scenario: Topics generated against an anchorless transcript

- **WHEN** every word in the session's transcript has an empty session time, and topics carry
  parseable session times
- **THEN** no Topics row presents a jump control, rather than presenting controls that would
  navigate to invented positions

#### Scenario: Topics with an anchored transcript are unaffected

- **WHEN** the session's transcript has anchored words
- **THEN** Topics rows present jump controls according to their own resolvability

### Requirement: Feed jumps are gated to when timecode is not rolling

The feed jump SHALL be available only while the session is not rolling, as reported by the session
status `is_rolling` field, and SHALL require a **loaded** status: while status has not resolved,
the jump SHALL be unavailable rather than assumed available. The jump SHALL also be unavailable
while a feed is in an explicit batch-editing mode, in which the user has deliberately entered a
bulk-editing surface.

#### Scenario: Rolling suppresses the jump

- **WHEN** the session is rolling
- **THEN** every feed row's jump control is unavailable and activating it does nothing

#### Scenario: Status not yet loaded

- **WHEN** a feed renders before the session status has resolved
- **THEN** jump controls are unavailable rather than treated as available

#### Scenario: Batch-edit mode suppresses the jump

- **WHEN** a feed is in batch-edit mode
- **THEN** its jump controls are unavailable

#### Scenario: Rolling stops

- **WHEN** the session transitions from rolling to not rolling
- **THEN** jump controls become available without a remount or reload

### Requirement: A feed jump starts playback from that point

Activating a feed jump SHALL start audio playback from the resolved second, so that seeing an
entry and hearing that moment is a single gesture. Where the player is already playing it SHALL
continue from the new position rather than restarting or stopping.

This applies to feed jumps only. **Marker navigation SHALL NOT start playback** — it repositions
without altering play state, as it does today.

#### Scenario: Jump while paused

- **WHEN** the audio player is paused and the user jumps to a second a recording covers
- **THEN** playback begins from that second

#### Scenario: Jump while playing

- **WHEN** the audio player is playing and the user jumps to a second a recording covers
- **THEN** playback continues from the new second

#### Scenario: Marker navigation does not start playback

- **WHEN** the audio player is paused and the user activates the previous- or next-marker button
- **THEN** the playhead moves and the player remains paused

### Requirement: A jump with no covering recording moves the playhead only

When no audio clip covers the resolved second — between recordings, past the end of all
recordings, or inside a missing-audio strip — the jump SHALL move the timeline playhead and scroll
to that position, and SHALL NOT issue the audio seek or start playback. Issuing it would
reposition the player onto a **different** recording, because the player resolves an uncovered
target forward to the next playable clip, or backward to the last one.

#### Scenario: Jump into a gap between recordings

- **WHEN** the user jumps to a second falling between two recordings
- **THEN** the playhead moves and the timeline scrolls there, no playback starts, and the player
  is not repositioned onto another recording

#### Scenario: Jump past the end of all recordings

- **WHEN** the user jumps to a second past the end of the last recording
- **THEN** the playhead moves there and the player does not rewind to an earlier recording

### Requirement: Marker navigation behavior is unchanged

Marker navigation's prev/next jump SHALL keep its current observable behavior: available whenever
markers exist, **including while the session is rolling** — the not-rolling gate applies to feed
jumps only — targeting grouped marker seconds, issuing its audio seek unconditionally without a
clip-coverage check, and never starting playback.

#### Scenario: Marker navigation still works while rolling

- **WHEN** the session is rolling and the user activates the previous- or next-marker button
- **THEN** the marker jump performs the same scrub, scroll, and audio seek it performed before
  this change
</content>
