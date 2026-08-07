# web-home-launch — delta (recent-sessions-single-poll)

## ADDED Requirements

### Requirement: Session-card status polling is bounded

The recent-sessions list SHALL NOT run per-card session-status pollers for
background sessions: at most the **open session's** card (the session whose
`/sessions/:id` route the workspace currently displays) subscribes to the
per-session status query, and subscribing it SHALL add no status poller
beyond the workspace's own. Background cards SHALL derive
their live indication and timecode from the sessions-list poll's own row
fields (`is_rolling`, `rolling_timecode`), refreshing at that poll's cadence
and rendered in the list's `HH:MM:SS` form (no frame field).

#### Scenario: Background rolling cards add no pollers

- **WHEN** the list shows several rolling sessions while one different session
  is open
- **THEN** only the open session's status query is subscribed (shared with the
  workspace), and the rolling cards still show a live badge and an `HH:MM:SS`
  timecode from the list data

#### Scenario: No open session means no pollers at all

- **WHEN** the user is on `/` (no session open) and the list shows rolling
  sessions
- **THEN** no session-status query is subscribed anywhere, and every rolling
  card shows its live badge and `HH:MM:SS` timecode from list data

#### Scenario: Open-session card stays fresh

- **WHEN** the open session is rolling
- **THEN** its card's timecode comes from the shared status query at the
  workspace's existing cadence
