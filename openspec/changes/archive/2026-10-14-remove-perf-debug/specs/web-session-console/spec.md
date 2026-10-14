# Spec Delta

## MODIFIED Requirements

### Requirement: Transport state tints the shell
The shell SHALL reflect the open session's transport state, using the same sources and precedence as the transport strip:
- **recording:** the session-wide audio recording lease is held by any client (the strip's "Recording" status, per "Truthful recording indication (two scoped sources)").
- **rolling:** the session's timecode is rolling and no audio recording lease is held.
- **playback:** this client is playing the session's recorded audio while the session is neither recording nor rolling.
- **stopped:** every other case, including no session open.

| State | Top bar, rail and transport strip | Status label |
| --- | --- | --- |
| recording | tinted toward the accent at full strength, with a soft glow | **REC** |
| rolling | tinted toward the accent at full strength, with a soft glow | **ROLLING** |
| playback | tinted at a softer strength | **PLAY** |
| stopped | the muted accent tint | **STOPPED** |

The label SHALL always be present, so colour is never the only channel. It SHALL be exposed to assistive technology as the transport's status, announced when the state changes and not on every timecode tick.

Under `prefers-reduced-motion: reduce` the tint SHALL change instantly and the live indicator SHALL NOT blink. The tint SHALL follow the open session even while the Settings view is shown over it. The state SHALL be derived from those existing sources; this requirement adds no request and no WebSocket message.

#### Scenario: Recording tints the shell and says REC
- **WHEN** any client starts recording audio in the open session
- **THEN** the top bar, rail and transport strip take the full tint and glow, and the status label reads REC

#### Scenario: Rolling without audio says ROLLING
- **WHEN** the open session's timecode is rolling and no client is recording audio
- **THEN** the shell takes the full tint and glow and the status label reads ROLLING

#### Scenario: Playback is softer and says PLAY
- **WHEN** this client plays the session's recorded audio while it is neither recording nor rolling
- **THEN** the shell takes the softer playback tint and the status label reads PLAY

#### Scenario: Stopped and no-session read STOPPED
- **WHEN** the session is not recording, rolling or playing, or no session is open
- **THEN** the shell shows the muted tint and the status reads STOPPED (or that no session is open)

#### Scenario: Reduced motion
- **WHEN** the user prefers reduced motion and recording starts
- **THEN** the tint changes without a transition and the live indicator does not blink

#### Scenario: Settings over a live session
- **WHEN** the Settings view is open over a session that is recording or rolling
- **THEN** the top bar and rail keep the full tint and the REC or ROLLING status


#### Scenario: No client-side override of the transport state
- **WHEN** the browser still holds a value saved by the removed performance-debug panel
- **THEN** the tint and status label follow only the sources above, and no performance-debug control is shown anywhere in the app
