## ADDED Requirements

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
