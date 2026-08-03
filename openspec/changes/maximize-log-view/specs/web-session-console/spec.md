## ADDED Requirements

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
