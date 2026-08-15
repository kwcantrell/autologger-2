# web-session-console

## Purpose

The session workspace console: the sole owner of the workspace tab inventory/order/labels
(Event Feed, Transcript, Topics, Assistant, Dashboards, Export — six tabs), plus the
console-level UX around them — stopped-state logging visibility, the 1–9 logging hotkeys, a
discoverable keyboard-shortcut reference, transport tooltips, truthful recording indication
from two scoped sources, honest capability gating on generation features, and the
feed jump column.

It also owns the console's feed-scale and freshness behavior:

- the Event Feed's windowed row set — `The event feed renders a windowed row set`;
- the feed-owned draft store that keeps an in-progress inline edit alive across a
  virtualizer-driven unmount — `Unsaved inline edits survive row unmount`;
- the sticky gate that defers the transcript-words payload until a consumer is actually shown —
  `The transcript-words fetch is deferred until a consumer is shown`;
- the raw-diarization value space the Transcript feed's speaker column edits in —
  `Transcript speaker edits stay in raw diarization space`;
- the cache re-anchoring the client performs whenever the session WebSocket opens —
  `Caches re-anchor when the session socket opens`.
## Requirements


### Requirement: Workspace tab IA (single owner)
This capability is the sole owner of the session-workspace tab inventory, order, and labels.
The workspace SHALL present exactly six top-level tabs in one `Feed tabs` tablist, in order:
**Event Feed, Transcript, Topics, Assistant, Dashboards, Export**, defaulting to Event Feed.
Transcript and Topics SHALL be top-level panels (not nested under an agent tab); the agent
surfaces carry the names "Assistant" (chat) and "Dashboards" (AI v2) — the labels "AI" and
"AI v2" SHALL NOT appear in the tab navigation (other capabilities' references to tab labels
are non-normative and defer here). All six panels SHALL stay mounted with visibility toggled
via the `hidden` attribute (the established mounted-hidden discipline), and the Dashboards
panel SHALL keep `key={sessionId}` at its mount site. (The Assistant panel is deliberately
NOT keyed by session — its cross-session conversation persistence is pre-existing behavior,
recorded as an accepted residual in design.) The Export panel SHALL present the session's
download actions inline (not as a dialog) and SHALL NOT depend on a Timeline Export control.

The mounted-hidden discipline is **deliberately preserved** — it is what keeps the chat stream
alive across tab switches — but two consequences of it are now load-bearing and are recorded
here so a future reader does not reintroduce them:

1. **Mounted-hidden SHALL NOT mean re-rendered on every workspace render.** Keeping six feeds
   mounted is affordable only because a workspace-level render (a playback tick, a transport
   change) does not carry into them. That property — its mechanism, its prop-stability rule, and
   the honest caveat that it is comment-enforced with no test behind it — is owned entirely by
   the `web-ui-system` requirement **`The playback tick is fenced at named memo boundaries`**,
   which is also where the limits of the claim are stated. This requirement neither restates nor
   strengthens it; it records only that the mounted-hidden discipline **depends** on it, so a
   change that weakens the fencing there makes the tab IA here expensive rather than free.
2. **Mounted-hidden SHALL NOT mean fetching.** A panel being in the DOM is no longer sufficient
   cause for its data to be requested; the transcript-words payload in particular is gated by
   `The transcript-words fetch is deferred until a consumer is shown`. Adding a new
   always-mounted panel with an unconditional expensive fetch would silently undo that.

#### Scenario: Tab inventory and default
- **WHEN** a session workspace mounts
- **THEN** the `Feed tabs` tablist contains exactly Event Feed, Transcript, Topics, Assistant,
  Dashboards, Export, with Event Feed selected

#### Scenario: Chat survives tab switches (no unmount)
- **WHEN** the user switches from Assistant to any other tab and back
- **THEN** the chat panel's DOM node is the same object (never unmounted) and an in-flight
  stream is not aborted

#### Scenario: Tab strip on narrow viewports
- **WHEN** the viewport is under 768px wide
- **THEN** the tablist scrolls horizontally with single-line tab labels (no wrapping), and
  every tab remains reachable by keyboard

#### Scenario: Export tab is mounted-hidden like other feeds
- **WHEN** the user is on Event Feed (or any non-Export tab)
- **THEN** the Export tabpanel remains in the DOM with the `hidden` attribute set

#### Scenario: A mounted-hidden panel does not fetch its payload
- **WHEN** the Transcript, Topics, Export and Dashboards panels are mounted-hidden because the
  Event Feed is selected
- **THEN** those panels are present in the DOM and no `transcript-words` request has been issued


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
the `?` key and by a visible labeled control in the fused strip's controls column. The `?` key guard
is: not in text entry, no dialog open, no Ctrl/Meta/Alt — **Shift is permitted** (it is how
`?` is typed on most layouts).

#### Scenario: Opening the reference
- **WHEN** the user presses `?` (Shift+/) outside text entry with no dialog open, or activates
  the strip's keyboard-shortcuts button
- **THEN** the shortcut reference dialog opens listing the shortcuts above


### Requirement: Transport tooltips
Each transport tile SHALL expose its action as a tooltip (matching its aria-label) on hover
and on keyboard focus.

#### Scenario: Hovering or focusing an enabled tile
- **WHEN** the pointer rests on, or keyboard focus reaches, an enabled transport tile
- **THEN** a tooltip names the action (e.g. "Roll timecode")


### Requirement: Truthful recording indication (two scoped sources)
Recording indication SHALL be truthful per its scope, and the two indicators have different,
deliberate sources: the fused strip's status area (mic level meter + live recording
duration — the AudioRecorder targets; the retired AppShell "Recording audio" pill's
successor) reflects **this client's** recorder phase — revealed only while this browser's
microphone is actively recording (not during upload, not while merely rolling), hidden when
recording stops **and when the recorder unmounts mid-recording** (session close/switch,
route change). The strip's session status value (red "Recording") reflects the
**session-wide recording lease** (any client). The duration counter SHALL NOT be announced
repeatedly by assistive technology (its per-second updates are excluded from the live
region; only the indication's appearance/disappearance announces). Pulsing indication is
static under reduced motion.

#### Scenario: Recording indication lifecycle
- **WHEN** this client starts recording, then stops
- **THEN** the strip status area reveals the mic level meter with a running duration during
  recording and hides them after stop

#### Scenario: Unmount while recording clears the indication
- **WHEN** the recorder unmounts while recording (user navigates to /teams or closes the
  session)
- **THEN** the meter and duration are hidden (no stale recording indication persists)

#### Scenario: Remote client recording
- **WHEN** another client holds the recording lease
- **THEN** the strip's session status shows Recording (session truth) while this client's
  mic-level indication stays hidden (this browser's microphone is not recording) — a
  deliberate divergence


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

1. **Generate All** when the events list response reports
   `has_auto_generated: false`; **Regenerate All** when it reports `true`. The
   label SHALL derive from the server-computed `has_auto_generated` field of
   the events list response — never from scanning loaded rows — so it stays
   truthful for sessions whose auto rows lie beyond any client-side page or
   the server's list clamp. Until the events list response for the session is
   available, the first item SHALL read **Generate All** (the non-destructive
   default; a click in that window POSTs plain generate).
2. **Custom**, which opens a modal.

Generate All SHALL POST generate with no regenerate flag and no selection.
Regenerate All SHALL POST `{ regenerate: true }`. Existing 503 latch,
no-instructions gate, pending/outcome session scoping, and inline error
channels SHALL continue to apply to runs started from the menu.

#### Scenario: Menu flips to Regenerate All after auto events exist

- **WHEN** the session has at least one auto-generated row (reported via
  `has_auto_generated: true`)
- **THEN** the first menu item is labeled Regenerate All

#### Scenario: Auto rows beyond the loaded page still flip the label

- **WHEN** a session's only auto-generated rows lie beyond the rows the feed
  has loaded (e.g. past the 2000-row workspace clamp)
- **THEN** the first menu item is labeled Regenerate All, because the label
  reads the server-computed field rather than the loaded rows

#### Scenario: Loading state defaults to the non-destructive label

- **WHEN** the session's events list response has not yet arrived
- **THEN** the first menu item reads Generate All, and activating it POSTs
  plain generate (no `regenerate` flag)

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


### Requirement: Caches re-anchor when the session socket opens

The session WebSocket replaced the client's poll loops, so a socket that is down is a period
in which changes are neither polled for nor received. On **every** `open` of the session
socket — the first connect and every reconnect alike — the client SHALL re-anchor the caches
those polls used to refresh: session status, events, and audio segments.

This is a **different trigger** from the one governed by `Event refetches coalesce during
broadcast bursts`, which bounds refetches driven by `event.changed` frames on an already-open
socket and says nothing about connection open. Neither requirement satisfies the other: the
coalescing window is scoped to the socket-subscription lifetime rather than to one socket, and
an open's re-anchor SHALL fire regardless of whether a coalescing window is currently open.

**The events cache SHALL be invalidated unconditionally on open, with no freshness gate.** No
cache in hand at the moment of open can prove it was populated by a fetch that *started* after
the socket opened: react-query exposes only a resolution timestamp (`dataUpdatedAt`), never a
fetch-start time, and the response's server-side snapshot is strictly earlier than its
resolution. An event inserted in the gap between that snapshot and `open` is therefore absent
from the response, unreceivable as a frame (the socket was not yet open when it was broadcast),
and invisible to any freshness comparison — which would mark the cache permanently fresh. The
consequence is not self-healing: the events query has no poll, so on a session that then goes
quiet nothing re-anchors it and the row is missing until a manual reload.

**The status and audio-segment caches MAY use a freshness gate** — skipping queries whose data
resolved at or after the current connect attempt began — because their misses do self-heal
through later frames: status through subsequent transport/lease frames and the rolling status
poll, and audio segments through subsequent chunk uploads, sync-from-disk, and later
`audio.changed` frames. Recorded residual, not specified away: a missed idle→rolling transition
on a session producing no audio can leave a stale transport reading until the next transport
frame.

**A query fetching with no data yet SHALL be cancelled before the invalidation, not merely
invalidated.** `invalidateQueries`' refetch cancellation only pre-empts a fetch that already
holds data; a fetch with none is *joined* rather than restarted, and when it resolves its
success state clears the invalidation — so the pre-open snapshot sticks. The cancellation
SHALL be scoped to **active** queries, so an observer-less prefetch that no invalidation would
re-drive is never left cancelled and unfetched.

#### Scenario: An event inserted during the handshake still appears

- **WHEN** the session socket opens while the events cache already holds data that resolved
  after this connect attempt began
- **THEN** the events query is invalidated anyway, and a refetch is issued

#### Scenario: A pre-open fetch is restarted, not joined

- **WHEN** the socket opens while a resync target's query is fetching for the first time (no
  data yet)
- **THEN** that in-flight fetch is cancelled before the invalidation, so a genuinely fresh
  fetch is issued rather than the pre-open one resolving and clearing the invalidation

#### Scenario: A reconnect re-anchors the gated caches

- **WHEN** the socket drops and reconnects after a period in which status or audio changed
- **THEN** the status and audio-segment caches, last updated before the drop, are invalidated
  on the new connection's open


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
lose, or change a handler *on account of the jump column*, become read-only, require a new
gesture, or have its containing block or width altered. How edits begin and commit, and keyboard
access to editing, SHALL be unchanged by the jump column. Activating a jump SHALL NOT focus an
editable field.

This guarantee is about the jump column and is unchanged. What has changed since it was written
is the **mechanism** underneath it: inline editing in the Event Feed and the Transcript feed is
now mediated by the shared draft store required by `Unsaved inline edits survive row unmount`
— controls remain uncontrolled, but every keystroke is additionally written through to a
feed-owned store — and, in the Event Feed alone, by that requirement's focus record, which makes
the edited row's caret pinned and restorable.
The observable begin/commit behavior described here is what that machinery exists to preserve
across a virtualizer-driven unmount; it is not a licence to read this requirement as "no handler
on an editable field may ever change for any reason".

#### Scenario: Fields still edit exactly as before

- **WHEN** the user clicks or tabs into any editable field in a feed row and then blurs it
- **THEN** the edit begins and commits exactly as it did before this change

#### Scenario: Jumping does not start an edit

- **WHEN** the user activates a row's jump control
- **THEN** no editable field in that row receives focus, and no edit is begun

#### Scenario: Draft mediation is invisible to the operator

- **WHEN** the user edits an inline field in a virtualized feed and commits it by blurring,
  without the row ever unmounting
- **THEN** the commit is the same request with the same values it would have been before the
  draft store existed, and no additional gesture, control, or confirmation is involved


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

Marker navigation's prev/next jump SHALL keep its current observable behavior while the
session is neither rolling nor recording: available whenever markers exist, targeting
grouped marker seconds, issuing its audio seek unconditionally without a clip-coverage
check, and never starting playback. While the session is rolling or recording, the
maximize-log strip SHALL disable marker prev/next (this change's "Strip contents when
rolling" scenario) — superseding the earlier including-while-rolling availability from
feed-row-seek; the not-rolling gate on feed jumps is unchanged.

#### Scenario: Marker navigation still works while idle

- **WHEN** the session is neither rolling nor recording and the user activates the
  previous- or next-marker button
- **THEN** the marker jump performs the same scrub, scroll, and audio seek it performed
  before this change

#### Scenario: Marker navigation is disabled while rolling or recording

- **WHEN** the session is rolling or local mic recording is active
- **THEN** the marker prev/next controls are disabled and no scrub, scroll, or seek is
  issued


### Requirement: Sole fused transport strip
The session workspace SHALL render one fused horizontal transport strip in place of any
twin glass-panel deck. There SHALL NOT be a Maximize log / Default view layout toggle or a
persisted layout preference that switches decks. Rolling and recording SHALL NOT replace
the strip with a twin-panel layout.

#### Scenario: Idle session shows the strip
- **WHEN** a session workspace is open and the session is idle
- **THEN** the fused strip is shown and the default twin panels are not

#### Scenario: Rolling keeps the strip
- **WHEN** the open session is rolling
- **THEN** the fused strip remains displayed (no twin-panel deck)

#### Scenario: Recording keeps the strip
- **WHEN** the open session’s recording lease is alive
- **THEN** the fused strip remains displayed (no twin-panel deck)


### Requirement: Maximize-log fused transport strip
The strip SHALL include a left controls column and a right timeline column. The left
column SHALL stack: session details (show · session name; date via hover/focus tooltip;
no session-id chip),
session status above the timecode (while a YouTube import is pending the status value
SHALL read `Importing YouTube Audio` instead of the transport status), the session timecode
stacked above transport controls, marker prev/next buttons inline with transport, and a
keyboard-shortcuts `?` control. The timeline column SHALL show a scrubber/waveform/markers
lane **or** (while rolling/recording) a same-height category-button row, with the current
marker readout overlaid at the top-left inset of that lane while idle/playing. While
rolling or recording, the marker readout SHALL NOT be shown. The strip SHALL omit twin
glass panel containers and the retired AppShell “Recording audio” pill. The
scrubber lane height SHALL be approximately **80% of the `#timeline-clips` lane height**.
While rolling/recording, the category-button lane SHALL size to the category-button
height token (not clipped to the shorter scrubber lane). While local mic recording is
active, the strip status area SHALL reveal the mic level meter and recording duration
(AudioRecorder targets).

#### Scenario: Strip contents when idle
- **WHEN** maximize-log layout is displayed and the session is idle
- **THEN** the operator can read session show/name/date, use marker nav, scrub the
  timeline, read status and timecode, use transport controls, and open shortcuts from `?`

#### Scenario: Strip contents when rolling
- **WHEN** the session is rolling
- **THEN** the scrubber lane is replaced by category log buttons at the same height,
  status reads Rolling, the marker readout is not shown, and marker prev/next controls
  are disabled

#### Scenario: Strip contents when recording audio
- **WHEN** local mic recording is active
- **THEN** status reads Recording and the status row shows mic level and recording
  duration


### Requirement: Recording intervals lay out multi-chunk segments contiguously

Timeline clip layout SHALL treat segments sharing a `recording_ordinal` as a **chunk
group** (segments with a null `recording_ordinal` are each their own group, preserving
legacy behavior exactly): interval matching (greedy wall-clock matching and the legacy
ordinal path alike) SHALL consume one recording interval per *group*, never scattering a
group's members across other intervals or letting a group claim another recording's
interval. When multiple intervals share an ordinal (same-N re-run cycles, which interval
building explicitly supports), same-N segments split into per-cycle groups by wall-clock
adjacency (each segment belongs to the cycle whose start event most nearly precedes its
`started_at_utc`), FIFO per ordinal. A group whose recording has no paired interval
(e.g. a crash left a `Recording N Started` with no `Stopped`) SHALL keep the pre-existing
unmatched-segment behavior and never consume another recording's interval.

Within a matched interval, each member's position SHALL be **event-wall-time derived**:
`interval start + max(0, (started_at_utc(member) − wall_time_utc(interval's start
event)) / 1000)` seconds when both timestamps are parseable — so a chunk's placement
never depends on which sibling chunks survived. Fallbacks preserving pre-change behavior
exactly: when the start event's wall time is unparseable, the group's base
(lowest-ordinal member — the single-flight upload pipeline keeps segment ordinals in
capture order) sits at the interval start and follow-ons derive from the base's
`started_at_utc`; members lacking a parseable `started_at_utc` keep the pre-existing
fallback behavior (a singleton group's member sits at the interval start as today;
otherwise placeholder / end-of-timeline chaining). Each chunk's clip SHALL extend to the
next chunk's position; the last chunk extends to **at least** the interval end, and
beyond it by its own probed duration when the audio genuinely runs longer than the
interval span (e.g. a paused-transport recording, or a last chunk whose captured audio
outlasts its `Recording N Stopped` bracket) — preserving the pre-change over-run
behavior for existing sessions. So the interval stays covered from the first surviving
chunk onward by construction — including when a chunk's duration probe fails — and the
existing jump/seek coverage requirements are unaffected there; any lead gap before the
first surviving chunk (mic-open latency, normally ~0–2 s, or a discarded leading chunk)
is truthfully uncovered and takes the existing no-coverage jump behavior. For every
pre-change session (one segment per recording, `started_at_utc` equal to its start
event's wall time) the derived delta is 0, and the clip width matches the pre-change
`Math.max(intervalEnd, startSec + d)` floor exactly, so layout SHALL be exactly as
before this change.

#### Scenario: A three-chunk recording renders inside one interval
- **WHEN** a recording interval has three segments sharing its `recording_ordinal`, each
  with sequential `started_at_utc` values
- **THEN** three clips render inside that one interval, positioned by their wall-clock
  start deltas and extending to their successor's position, leaving the interval fully
  covered, and no other interval or the timeline tail receives any of them

#### Scenario: Single-segment sessions are unchanged
- **WHEN** an existing session where every recording has exactly one segment is laid out
- **THEN** clip positions and interval matching are identical to the pre-change behavior

#### Scenario: A probe failure does not uncover the interval
- **WHEN** a middle chunk's duration probe fails
- **THEN** its clip still spans from its wall-clock position to the next chunk's
  position, and feed jumps into that span still start playback per the existing jump
  requirements

#### Scenario: A discarded first chunk does not shift the survivors
- **WHEN** a three-chunk recording's first chunk was permanently lost and discarded, so
  only chunks 2 and 3 exist as segments
- **THEN** chunks 2 and 3 render at their true wall-clock deltas from the interval's
  start event (leaving the missing lead truthfully uncovered), not shifted to the
  interval start

#### Scenario: Same-N re-run cycles keep their own intervals
- **WHEN** a session has two distinct `Recording 1` cycles with segments in each
- **THEN** each cycle's segments group to their own interval by wall-clock adjacency, and
  neither cycle's interval is starved into a placeholder by the other's segments

#### Scenario: A crashed recording's chunks never steal another interval
- **WHEN** a session has one completed recording (paired events) and one crashed
  recording (`Started` without `Stopped`) with two uploaded chunks
- **THEN** the completed recording's interval receives only its own segment(s), and the
  crashed recording's chunks take the pre-existing unmatched behavior

#### Scenario: Playback and seeks treat chunk clips like any other clips
- **WHEN** a feed-row jump resolves to a second covered by a follow-on chunk's clip
- **THEN** playback starts within that chunk at the correct offset, using the existing
  jump/seek requirements without modification


### Requirement: The event feed renders a windowed row set

The Event Feed SHALL mount only a window of its rows — the rows the scroll viewport can show,
plus a fixed overscan — rather than one `<tr>` per row in the filtered, sorted set. The window
SHALL be produced by `@tanstack/react-virtual`'s `useVirtualizer` using the **padding-row idiom
`TranscribeFeed` established**: a top spacer `<tr>` and a bottom spacer `<tr>`, each carrying a
computed height, inside the feed's real `<table>`. The feed SHALL NOT be re-expressed as a
`div` grid — the `<table>`, its `colgroup`, its column widths, and the surrounding sheet chrome
SHALL be unaffected by virtualization.

The virtualizer's scroll element SHALL be the OverlayScrollbars viewport that `FeedTable`
publishes through its `scrollRef` callback, and the total scrollable height SHALL correspond to
the **full** row count (spacer heights plus mounted rows), not to the mounted subset — so the
scrollbar, its thumb size, and the reachable scroll extent read the same as an unvirtualized
list.

Row height SHALL be a fixed estimate rather than per-row measurement, because every cell in the
row is `whitespace-nowrap` and therefore does not vary in height with content. The shipped
constant is `ROW_HEIGHT = 31` (measured against the compiled CSS in headless Chromium: a 30.44px
row dominated by the 24px jump button plus cell padding and the 1px border), with `overscan =
10`; both match `TranscribeFeed`. Where a row is genuinely shorter (an unresolvable timecode
renders no jump control), over-estimating SHALL be the accepted direction — extra scroll extent
is harmless, a short window is not.

Virtualization SHALL NOT change any behavior the feed already had: sorting, category and
internal-row filtering, the jump column (`Feed jump column`), inline and batch editing, and the
pagination sentinel that grows the loaded page SHALL behave as they did before. The sentinel
SHALL sit **after** the bottom spacer so it still marks the true end of the list.

**Reveal-in-feed SHALL keep working for a row outside the mounted window.** A timeline-marker
reveal targets an event by id; a row outside the window has no DOM node at all, so a poll for
`tr[data-event-id=…]` would never find it. The feed SHALL therefore park the requested id and,
in a following effect, scroll the virtualizer to that event's index **computed against the
rendered order** — the filtered, sorted list, never the raw event list — so that a descending
sort or a hidden category cannot scroll to the wrong row. Mounting the row SHALL be what lets
the workspace's existing scroll-and-flash retry loop find and flash it; the reveal path SHALL
continue to grow the loaded page first when the target is outside the fetched slice, and a
target that never renders (filtered out) SHALL park harmlessly rather than erroring.

#### Scenario: Only a window of rows is in the DOM

- **WHEN** a session with 66 events renders its Event Feed at the audited viewport
- **THEN** the number of event `<tr>` elements in the document is the visible window plus
  overscan (measured: 18) rather than 66, while the table's scrollable height still corresponds
  to all 66 rows

#### Scenario: Revealing an event outside the mounted window

- **WHEN** a timeline marker reveals an event whose row is not currently mounted
- **THEN** the feed scrolls the virtualizer to that event's index in the rendered order, the row
  mounts, and the existing scroll-and-flash retry finds it and flashes it

#### Scenario: Reveal follows the rendered order, not the raw list

- **WHEN** the feed's sort direction is changed (or a category is hidden) and a marker then
  reveals an event
- **THEN** the row that is scrolled to and flashed is that event's row, because the index was
  resolved against the filtered, sorted order

**A pending first fetch SHALL be a distinct state from an empty result.** The Event Feed SHALL
pass its events query's pending flag to `FeedTable` as `isLoading`, so while the first fetch is
in flight the table body renders the shared loading row rather than an empty `<tbody>` — matching
the `TranscribeFeed`/`TopicsFeed` idiom, where `isEmpty` is consulted only when not loading. The
previous form suppressed the empty state during the fetch (`isEmpty={sorted.length === 0 &&
!isPending}`) without putting anything in its place, so the sheet rendered a bodyless table until
rows arrived. The two states SHALL stay distinct in both directions: an empty-result message SHALL
never be shown for a fetch that has not settled, and a pending fetch SHALL show something.

#### Scenario: The first events fetch shows a loading row, not an empty sheet

- **WHEN** the Event Feed mounts and its events query is still pending
- **THEN** the table body contains the shared loading row and no empty-state message, rather than
  being empty until rows arrive

#### Scenario: Table chrome is unchanged by virtualization

- **WHEN** the Event Feed renders with virtualization active
- **THEN** the rows are `<tr>`s inside the feed's real `<table>` between two spacer rows, the
  column widths and header chrome are unchanged, and the pagination sentinel still sits at the
  end of the list


### Requirement: Unsaved inline edits survive row unmount

The Event Feed's and the Transcript feed's inline edit controls are **uncontrolled**, and both
feeds are virtualized — so the only copy of an in-progress edit used to live in a DOM node the
virtualizer could remove without React ever firing a blur, silently discarding the operator's
typing. Both feeds SHALL therefore back their inline edits with a **feed-owned draft store**
(`web/src/pages/index/utils/draftStore.ts`), one shared primitive rather than two per-feed
implementations, so the two cannot drift on the rule that is easy to get wrong: when a draft
stops being live.

A row SHALL write its raw control text through to the store on **every keystroke**, keyed by row
id, and a remounting row SHALL re-seed its controls from the store rather than from the server
value. Drafts SHALL be held in a mutable store behind stable callbacks (not React state), so a
keystroke does not re-render the feed and every other mounted row with it.

The two feeds reach inline edit by different routes, and this requirement binds both. In the
**Event Feed**, inline controls are live while the session is rolling **or** an audio recording
lease is alive, and batch-edit mode is off — batch edit being the stopped-state editing surface,
whose entry ends inline edit and drops every inline draft. That window is the one under render
budget pressure (the playback tick is running and new events are arriving), which is why the
store-not-state rule bites hardest there; it is not what makes the rule required. In the
**Transcript feed** the row controls carry no transport gate at all: they are editable whenever
the feed is shown, rolling or stopped. Nothing here narrows `Inline editing is untouched by the
jump column`, and the editing gate is independent of the jump gate in
`Feed jumps are gated to when timecode is not rolling` — in the Transcript feed both can be
available at once.

Every comparison that decides whether a draft is spent SHALL be made in **draft space** — raw
control text against the raw text the controls would render from the current server row — never
in value space (trimmed, parsed, or normalized), because a half-typed date has no parsed form at
all and a trimmed message hides trailing whitespace, so a value-space match reports "unchanged"
for text the control is still displaying.

A clear SHALL name the fields it covers. The store's `clearMatching(id, reference, covered)`
takes an **explicit covered-field set** separate from the reference text: which fields a clear
speaks for is decided by what the save actually persisted, while what to compare them against
must be read from something wider than a partial patch. A one-field PATCH SHALL NOT discard a
sibling field's unsaved text. A covered field whose recorded text has **diverged** from the
reference SHALL be kept, and a field outside `covered` SHALL be left untouched.

A draft SHALL be cleared only once its save has **round-tripped**, never when the save is
issued, so a **failed** save leaves the operator's text recoverable on the next remount instead
of silently reverting. The clear SHALL re-read the store at resolution time (never a value
captured before the await), so keystrokes typed during the round trip survive.

The focus half SHALL be handled too — **in the Event Feed only**. The clauses below are scoped to
that feed and describe what shipped there; the Transcript feed shares the draft store above but
has no focus record, no `rangeExtractor` pin, and no caret restore, so an unsaved Transcript edit
survives a remount as *text* while its caret does not. That asymmetry is recorded here as a known
bound of what shipped, not asserted away. In the Event Feed, the feed SHALL record which row is
being inline-edited and where its caret sits, in a ref-backed store (a caret move must not
re-render the feed), and:

- The edited row's index SHALL be **pinned into the virtual window** through the virtualizer's
  `rangeExtractor` seam, so incoming events that shift the row down the list do not unmount the
  focused input out from under the operator. Because the two-spacer idiom requires the rendered
  index range to be **contiguous**, the pin SHALL be a contiguous clamp — the window is extended
  to reach the pinned index — and SHALL be **bounded** (shipped: 50 extra rows), past which the
  pin is dropped rather than rendering an unbounded slab of gap rows.
- When a remount happens anyway, the remounting row SHALL restore focus and caret. The restore
  SHALL use `focus({ preventScroll: true })` so it can never yank the viewport of an operator
  who is scrolling rather than editing; SHALL apply only while focus is currently nowhere
  (`<body>`/`<html>`, or a disconnected node), never stealing focus the operator has moved
  elsewhere; and SHALL be refused once the record is **stale** (shipped bound: 30 s since the
  operator last touched that edit, re-stamped by the store on every focus or selection change).
- The feed SHALL additionally drop the focus record on the first interaction **outside** the
  edited row — a `focusin` outside it, or an outside `pointerdown` whose focus outcome one tick
  later is outside it — so an abandoned edit cannot pull the caret back later. Dropping the
  caret record SHALL NOT drop the draft: abandoning the caret is not abandoning the text, which
  stays recoverable until it is saved or superseded.

#### Scenario: Typing survives scrolling past the overscan

- **WHEN** the operator types into an inline field, scrolls the feed far enough that the row
  unmounts, and scrolls back
- **THEN** the remounted row displays the typed text, not the server value

#### Scenario: A one-field save keeps a sibling field's unsaved text

- **WHEN** a save persists one field of a row while another field of the same row holds unsaved
  text
- **THEN** the save's clear removes only the persisted field's draft, and the unsaved sibling
  text is still present when the row next remounts

#### Scenario: A failed save keeps the text recoverable

- **WHEN** an inline save is submitted and the request fails
- **THEN** the draft is not cleared, and the operator's text is what the row shows on its next
  remount

#### Scenario: The edited Event Feed row stays mounted as events arrive

- **WHEN** the operator is inline-editing an Event Feed row and new events arrive that shift it
  within the rendered order by fewer than the pin bound
- **THEN** the edited row remains mounted and focused, because the rendered range is extended
  contiguously to include it

#### Scenario: A restore cannot steal focus or scroll

- **WHEN** an edited Event Feed row remounts while the operator has focused something else, or
  more than the staleness bound has elapsed since the edit was last touched
- **THEN** no focus restore occurs; and when a restore does occur, it does not scroll the
  viewport

#### Scenario: A Transcript edit survives as text, not as a caret

- **WHEN** the operator types into a Transcript feed row and that row unmounts and remounts
- **THEN** the typed text is restored from the shared draft store, and the caret is not — the
  focus record and window pin are Event Feed machinery and do not exist in this feed


### Requirement: Transcript speaker edits stay in raw diarization space

A transcript word's `speaker` is stored as the diarization id the transcriber emitted (a bare
base-10 integer string), but the feed renders it as `Person N`, offset by the feed-wide
convention correction that makes a 0-based transcript read from 1. That display transform makes
the speaker column the one editable field in the console with two value spaces, and mixing them
corrupts data silently.

**Every layer SHALL hold RAW (storage-space) text**: the stored row, the row's in-progress edit
state, the resolved values it renders from, the feed-owned draft store required by `Unsaved
inline edits survive row unmount`, the same-value dirty check that decides whether a blur
commits, the PATCH body, and the draft-space reference a completed save clears against. **The
only display-space string SHALL be the rendered `value` of the speaker input**, produced by
`formatSpeaker` and converted straight back at that same element's change and blur edges — so
no field-generic handler downstream ever sees a `Person N` label. Storing display space instead
would break two things at once that both compare against raw: the same-value guard would never
fire, and the save's draft clear would compare against the wrong space.

The transform pair SHALL have a **single definition** shared by feed display and transcript
export, so the two labelings and the inverse cannot drift. `formatSpeaker` renders a stored
value as `Person <id + offset>` only when that value is a bare base-10 integer; anything else is
a label the operator typed and renders verbatim. `parseSpeaker` SHALL be inverse **by
construction** — a candidate raw id is re-formatted and must reproduce the given string
byte-for-byte — rather than by lookalike matching, so `Person one`, `person 1`, a stray trailing
space, and `Speaker 1` are all custom labels returned verbatim.

**A blur that did not change the rendered text SHALL commit nothing.** The inbound conversion
SHALL be anchored on the row's committed raw value: text byte-identical to what that value
renders as maps back to the committed value itself, and only text differing from the rendering
the operator was shown counts as an edit. A bare `parseSpeaker` on the input is insufficient
and was the shipped defect — it cannot tell "the operator retyped this label" from "the operator
typed nothing", so tabbing through a row whose stored label is the literal string `Person 2`
converted it to the diarization id `2`, merging a hand-named speaker into a diarized one on a
field nobody edited. The anchor SHALL be the committed value (a prop) rather than a focus-time
snapshot, because this feed is virtualized and backed by a draft store: a row can unmount and
remount mid-edit, and any component-local snapshot dies with it.

Two consequences are recorded as accepted limits rather than specified away:

- A row whose stored label is literally `Person N` **cannot be converted to the one diarization
  id that renders identically**. That input is byte-identical to the committed rendering, so it
  pins, and typing away and back re-pins on the final keystroke. The ambiguity is inherent — from
  the input's side, "retyped the label shown" and "meant the id that renders the same" are the
  same string — and pinning is the right side of it: leaving stale-but-stable data alone beats
  rewriting rows nobody touched. Such a row can still be **reassigned** to a different speaker,
  because that text is not what its committed value renders as. Rows already corrupted by the
  old bug are therefore not healed by tabbing through them, and no keystroke heals them in
  place; they keep their literal value and render exactly as they always did.
- Typing an out-of-range label such as `Person 0` under a +1 offset yields the consistent
  inverse (a negative raw id), which is stable for that row but drags the feed-wide offset
  minimum below zero and so re-labels every sibling row. That is preferred over storing the
  display string literally, which would freeze one row's label out of sync with its siblings
  permanently.

#### Scenario: An untouched speaker field commits nothing

- **WHEN** the operator focuses and blurs a transcript row's speaker input without changing its
  text, on a row whose stored value is a custom label that happens to look generated
- **THEN** no PATCH is issued and the stored value is unchanged

#### Scenario: A genuine edit is converted to storage space

- **WHEN** the operator replaces a speaker input's text with a different label the display
  transform would have produced
- **THEN** the value committed to the draft store and sent in the PATCH is the corresponding raw
  diarization id, not the `Person N` string

#### Scenario: A custom name is stored verbatim

- **WHEN** the operator types a name the display transform would never produce
- **THEN** that text is stored as-is and renders back unchanged, tracking no offset


### Requirement: The transcript-words fetch is deferred until a consumer is shown

The transcript word list is the largest payload the session workspace pulls. Because all six
workspace panels stay mounted (see `Workspace tab IA (single owner)`), four always-mounted
consumers used to request it on session mount whether or not the operator ever opened those
tabs. The workspace SHALL therefore publish a **sticky per-session gate**
(`TranscriptWordsGateContext`), and `useTranscriptWords` SHALL accept an `enabled` option that
its gated consumers pass.

The gate SHALL open on the first activation of a **words-dependent tab** — Transcript, Topics,
or Export. Once open it SHALL stay open for that session, so switching back to the Event Feed
neither cancels an in-flight fetch nor causes a re-issue on the next visit. It SHALL **reset on
session change**, so session B never inherits session A's activation; because the workspace does
not remount per session, the reset SHALL be a render-time comparison of the current session id
against the previous one, applied **before** re-latching from the currently selected tab (so
landing on session B while Transcript is already selected opens B's gate immediately).

The Dashboards panel SHALL require **two** conditions, not one: its displayed dashboard config
must contain a words-derived widget **and** the Dashboards tab must be currently shown. The
gate context therefore publishes a second, non-sticky field — whether Dashboards is the selected
tab — which the dashboards-side words trigger ANDs with its own config check. A saved dashboard
containing a words widget SHALL NOT pull the payload while the operator sits on the Event Feed.

Panel lifecycles SHALL be untouched: this gate changes only an `enabled` flag on a query, never
what is mounted. The context's defaults SHALL be **fail-open** (`true`): a consumer rendered
outside a provider — a colocated feed test, or any future standalone mount — behaves exactly as
it did before the gate existed, because the worst case of failing open is the previously shipped
unconditional fetch, whereas failing closed would be a silent data regression.

A load-bearing consequence SHALL be respected by every gated consumer: **a disabled pending
react-query query reports `isLoading === false`** (v5 computes it as `isPending && isFetching`).
A consumer that hides content while loading MUST therefore gate on `isPending` **and** its own
enabled flag, not on `isLoading`, or it will render an empty/"no data" state for data nobody has
fetched. (The related offline case is why the stronger signal is kept even though the
enabling-render flash did not reproduce on react-query v5: an offline-*paused* query genuinely
diverges.)

Measured outcome on the production build, same session, two distinct transactions:

- **At session open** (every API response the workspace's initial queries pull): before, ~5.3 MB
  of **uncompressed** transfer, of which the transcript-words response alone was 4.15 MB
  uncompressed; after, **172 KB on the wire**. Three independent changes produce that figure, and
  it is not this gate's isolated win: transcript-words is no longer fetched at open at all, the
  responses that remain are now served compressed, and the profile, audio-segments and
  sync-from-disk payloads shrank on their own.
- **When the words are first needed** (a later, separate transaction — not part of the 172 KB
  above): the transcript-words response costs **614 KB gzip**.

The two bullets are therefore in different units and count different requests; the open-time
figures do not subtract to the deferred one.

#### Scenario: Opening a session on the Event Feed fetches no words

- **WHEN** a session workspace is opened and the Event Feed is the selected tab
- **THEN** no `transcript-words` request is issued

#### Scenario: Activating a words-dependent tab issues exactly one fetch

- **WHEN** the operator activates the Transcript tab for the first time in that session
- **THEN** exactly one `transcript-words` request is issued for that session

#### Scenario: The gate is sticky within a session

- **WHEN** the operator returns to the Event Feed after the words have been fetched
- **THEN** the query stays enabled — the fetch is neither cancelled nor re-issued, and returning
  to Transcript triggers no new request

#### Scenario: A saved words widget waits for its own tab

- **WHEN** a session whose persisted dashboard contains a words-derived widget is opened and the
  operator stays on the Event Feed
- **THEN** no `transcript-words` request is issued; it is issued only once the Dashboards tab is
  shown

#### Scenario: Switching sessions resets the gate

- **WHEN** the operator navigates from a session whose gate is open to a different session,
  while a non-words tab is selected
- **THEN** the new session's gate is closed and no `transcript-words` request is issued for it
