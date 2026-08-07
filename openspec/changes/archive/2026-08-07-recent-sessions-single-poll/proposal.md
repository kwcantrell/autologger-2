# recent-sessions-single-poll — proposal

## Why

Every rolling session card in RecentSessionsList mounts its own
`useSessionStatus` poller at 1.2s (`useSessionStatus(isActive || s.is_rolling ?
s.id : null)`), so N rolling sessions in the list cost N independent 1.2s
status-poll loops against the single-threaded server — solely to give
*background* cards a fresher timecode than the 5s sessions-list poll already
delivers (`s.rolling_timecode`). Recorded as an accepted residual by the PR#4
review; the owner elected to close it.

## What Changes

- Session cards SHALL run the per-session status query **only for the open
  session**, adding no status poller beyond the workspace's own (today
  implemented as a cache-shared read of the workspace's query — mechanism,
  not the contract). Background rolling cards SHALL derive
  their live badge and timecode from the 5s sessions-list poll's row fields
  (`is_rolling`, `rolling_timecode`) alone.
- Net: at most ONE status poller exists regardless of list size (the
  workspace's own), background card timecodes refresh at the list's 5s cadence
  instead of 1.2s **and render in the list's `HH:MM:SS` form — the frame field
  the status query used to supply is dropped for background cards** (frames at
  5s freshness are noise; the open card keeps full SMPTE). This also ends
  today's perpetual off-route polling: rolling sessions currently keep 1.2s
  status polls running from the home screen indefinitely.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `web-home-launch`: ADDED requirement (the baseline doesn't pin card-polling
  behavior — confirmed at fact-check; this adds a new requirement within the
  capability).

## Contract impact

None. No HTTP/WS surface, shape, or emission change — only which client-side
queries run. The status route's semantics are untouched.

## Non-Goals

- No new aggregate/status-batch endpoint.
- No WS-driven list updates.
- No change to the workspace's own status polling or the 5s list cadence.

## Impact

- `web/src/pages/index/components/RecentSessionsList.tsx` (the card's status
  gate + badge derivation); its tests.
