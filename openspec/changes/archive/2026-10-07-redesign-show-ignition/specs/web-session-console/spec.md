# Spec Delta

## ADDED Requirements

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

When the performance-debug transport override is active, the tint and label SHALL follow the overridden state, as the strip does.

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


### Requirement: Feed count matches the rows shown
The event feed's heading count SHALL equal the number of events the feed's active filters (including whether internal events are shown) select from the session's fetched events — the whole filtered set, not the portion of it currently paged into the windowed list. When the session has more events than the workspace fetches, the count SHALL be shown with a trailing `+` rather than as an exact figure. It SHALL NOT be taken from a count that covers a different row set; the session's `logged_event_count`, which excludes internal events, is one such count. A filter change SHALL update the count in the same render. The workspace tab strip carries no count. The server's `logged_event_count` field and its meaning are unchanged.

#### Scenario: Internal events shown
- **WHEN** a session has 2 logged events and 8 internal events and the feed shows internal events
- **THEN** the heading reads 10

#### Scenario: Internal events hidden
- **WHEN** the user hides internal events in the same session
- **THEN** the heading reads 2 in the same render

#### Scenario: Paging does not cap the count
- **WHEN** a session has 450 events, all shown by the filters, and only the first 200 are paged into the windowed list
- **THEN** the heading reads 450

#### Scenario: More events than the workspace fetches
- **WHEN** a session has more events than the workspace's fetch limit
- **THEN** the heading shows the fetched filtered count followed by `+`

## MODIFIED Requirements

### Requirement: AUTO GENERATE affordance on the event feed
The event feed tab SHALL provide an AUTO GENERATE control that starts one generation run for the open session through the `auto-event-generation` endpoint (synchronous POST).

**While running.** While the request is in flight the control SHALL be non-actionable, with a running indication. Generated events appear in the feed live through the existing `event.changed`-driven refetch, with no new WS handling. This feed-native liveness is the run's progress display.

**Outcome.** On completion the run's outcome renders inline in the panel toolbar, in exactly one channel with no toast duplication:
- **success:** the created count, noting when the per-run cap ended writing early;
- **pre-spawn refusals** (no anchored transcript, no instructions, aggregate bound) **and failures:** the server's detail;
- **`409`:** the busy detail, which is retryable and not latched.

**Session scope.** Run and outcome state SHALL be scoped to the session the run was started for. Switching sessions mid-run leaves the run completing server-side, and the control renders idle for the newly opened session, with no cross-session state leak through the mounted-hidden panel.

**No instructions.** When `GET …/show-categories` reports `auto_instructions_present: false`, the control SHALL be non-actionable, with a keyboard-reachable reason pointing at Settings › Event buttons.

#### Scenario: Run shows live rows and a terminal count
- **WHEN** the user clicks AUTO GENERATE and the run creates events
- **THEN** the control shows a running state, new events appear in the feed as they are inserted, and on completion the toolbar shows the created count inline

#### Scenario: No instructions configured
- **WHEN** the open session's `show-categories` response has `auto_instructions_present: false`
- **THEN** the AUTO GENERATE control is non-actionable, with a keyboard-reachable reason that points the user at Settings › Event buttons

#### Scenario: Busy slot is retryable, not latched
- **WHEN** the generate request returns `409` because another AI turn holds the session's slot
- **THEN** the detail renders once inline, the control returns to actionable, and no 503-style latch engages

#### Scenario: Session switch mid-run does not leak state
- **WHEN** the user starts a run on session A and switches to session B before it completes
- **THEN** session B's feed shows an idle AUTO GENERATE control, and returning to session A shows A's outcome (or idle state) without B ever displaying A's run state
