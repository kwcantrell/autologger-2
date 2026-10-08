## MODIFIED Requirements

### Requirement: The Companion presence heartbeat outlives tab backgrounding

While a page holds a session, the client SHALL keep its Companion presence entry fresh for as
long as the page is alive, **regardless of tab visibility**. The server ignores a presence entry
older than a fixed freshness window (`PRESENCE_FRESH_MS`, 15 s, defined in the presence port) and
deletes it after 60 s; Companion's active-session resolution requires a fresh entry, so a client
that stops reporting is dropped as a Companion target while its tab, its WebSocket, and possibly
an in-progress recording are all still alive. Presence is stored in the catalog and shared by
every server process (core-ports-architecture "Companion presence is shared by every process"),
and each entry records the signed-in user who posted it, so a Companion device follows only its
own user's pages (api-contract-freeze "Companion routes run as the caller's user"). The page
posts presence with its session cookie; the reporting cadence and the request body are unchanged
by that.

The reporting interval SHALL stay strictly under that window in every visibility state. It is
currently 5 s while visible and 10 s while hidden — the hidden cadence is a traffic reduction,
**not** a pause, and SHALL NOT be widened to or past the freshness window. A visibility change
SHALL additionally report immediately, so a hide or show is observable to Companion at once
rather than at the next tick, and a change to whether audio is playing SHALL likewise report
once without restarting the interval.

The interval SHALL NOT depend on a main-thread timer. Chrome applies intensive throttling to
main-thread timers in a tab hidden longer than five minutes, coalescing them to roughly one
wakeup per minute — four times the freshness window — and an open WebSocket does not exempt the
page. The clock therefore runs off the main thread (a dedicated worker created from a Blob URL,
which intensive throttling does not apply to). Where a dedicated worker cannot be created — no
`Worker`, no Blob URL, or a Content-Security-Policy that denies `blob:` workers — the
implementation SHALL fall back to a main-thread timer and SHALL treat the sub-window guarantee as
not holding on that path, documented at the call site rather than silently assumed. A worker that
fails **asynchronously** (the CSP case: the constructor returns and the failure arrives as an
error event) SHALL be detected and SHALL re-arm the fallback, because a worker that never ticks
is strictly worse than the main-thread timer it replaced.

This is a property a future reader is likely to "optimize" away: pausing the heartbeat while
hidden looks like an obvious saving and silently costs the operator Companion control of a
backgrounded tab. A fake-timer test cannot observe browser throttling, so tests SHALL NOT be read
as evidence that a main-thread cadence is sufficient.

#### Scenario: A backgrounded tab stays a valid Companion target
- **WHEN** a page holding a session is hidden for longer than the server's presence freshness
  window, including beyond the five-minute intensive-throttling threshold
- **THEN** presence reports continue at a cadence under that window, and Companion commands
  addressed to that session continue to resolve rather than failing with no-active-session

#### Scenario: Visibility and playback changes report immediately
- **WHEN** the tab is hidden or shown, or the playing state changes
- **THEN** a presence report is sent at once carrying the new state, and the periodic interval
  is not restarted by it

#### Scenario: A worker-less environment degrades to a documented weaker guarantee
- **WHEN** a dedicated worker cannot be created, or an already-created worker fails
  asynchronously
- **THEN** reporting continues on a main-thread timer, and the sub-window guarantee is recorded
  as not holding on that path rather than being claimed
