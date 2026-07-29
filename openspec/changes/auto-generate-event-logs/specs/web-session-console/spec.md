# web-session-console — delta spec (auto-generate-event-logs)

The event feed tab gains the AUTO GENERATE affordance (synchronous run + feed-native
liveness); the honest-capability-gating requirement extends to event generation;
generated rows get a visible marker; event refetches coalesce during bursts.

## ADDED Requirements

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

## MODIFIED Requirements

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
