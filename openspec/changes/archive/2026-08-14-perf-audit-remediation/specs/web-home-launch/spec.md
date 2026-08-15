# web-home-launch — delta

## MODIFIED Requirements

### Requirement: Session-card status polling is bounded

The recent-sessions list SHALL NOT run per-card session-status pollers for
background sessions: at most the **open session's** card (the session whose
`/sessions/:id` route the workspace currently displays) subscribes to the
per-session status query, and subscribing it SHALL add no status poller
beyond the workspace's own. Background cards SHALL derive
their live indication and timecode from the sessions-list poll's own row
fields (`is_rolling`, `rolling_timecode`), refreshing at that poll's cadence
and rendered in the list's `HH:MM:SS` form (no frame field).

The bound above is unchanged by this change. What that bound amounts to in practice was never
written down, and is recorded here for the first time rather than restated: at most one shared
`useSessionStatus` poller, whose `refetchInterval` fires at ~1.2 s only while the status it last
received reports the session rolling or holding a live recording lease, and is off otherwise —
and, because `refetchIntervalInBackground` is false, off as well while the tab is backgrounded.
That description is a clarification, not a new obligation; the normative bound remains the
subscription bound in the paragraph above.

That shared query now additionally declares `staleTime: 2s`, and what that does — and does not —
do SHALL be read precisely:

- It **does not** change the polling cadence. A `refetchInterval` fires regardless of
  staleness, so the open session's status keeps refreshing at the same ~1.2 s while
  rolling/recording, and WebSocket-driven invalidations still bypass staleness.
- It **only** suppresses a duplicate fetch when a **second observer** subscribes to the
  same query key shortly after the first. Under the app's global `staleTime: 0` default, the
  rail card mounting a commit after the workspace counted as a fresh observer of already-fresh
  data and triggered an immediate extra request. A 2 s window absorbs exactly that.

No claim beyond that is made: the staleTime is not a freshness guarantee, not a cadence
change, and not a substitute for the subscription bound above, which remains the requirement.

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
- **THEN** its card's timecode comes from the shared status query, refreshing at the
  workspace's existing rolling cadence — unaffected by the query's `staleTime`, which
  gates only observer-triggered fetches, not the interval

#### Scenario: A late same-key observer issues no extra request

- **WHEN** the rail's open-session card subscribes to the session-status query a commit
  after the workspace has already subscribed to the same key
- **THEN** no additional status request is issued for that subscription; the card reads the
  data the workspace's query already holds
