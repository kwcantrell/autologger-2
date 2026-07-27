# feed-row-seek

## Why

The session timeline and the three feeds (Event Feed, Transcript, Topics) are informationally
linked but interactively disconnected: a row shows a session time, but reaching that moment in the
audio means reading the timecode off the row and manually scrubbing the timeline to it. The review
loop that matters — *see an entry → hear that moment* — costs a manual translation step every time.

The jump itself is already built. `MarkerNav`'s prev/next buttons move the playhead, scroll the
timeline to it, and seek the audio player, through globals `Timeline`/`SessionWorkspace` already
publish. This change gives the feeds a second caller of that behavior rather than inventing one.

## What Changes

- **Each feed gains a dedicated leading jump column** — a narrow icon column in the Event,
  Transcript, and Topics feeds whose per-row control jumps the timeline to that row's session
  time. The column header is visually hidden, using `FeedTable`'s existing `ColumnDef.ariaLabel`
  affordance (present in the codebase, currently unused).
- **The control is a real button**, keyboard- and AT-reachable, with an accessible name naming the
  time it jumps to as that row displays it.
- **Activating it seeks the timeline and starts playback** from that point: playhead, scroll into
  view, audio seek, and play. This is the literal review loop the feature exists for — see an
  entry, hear that moment, in one gesture.
- **Marker navigation stays seek-only.** Its arrows keep today's behavior exactly: they reposition
  without starting playback, and they remain ungated by rolling.
- **The audio seek and playback are suppressed when no recording covers the target second.** The
  playhead still moves and scrolls. Issuing the seek anyway would reposition the player onto a
  *different* take, because the player resolves an uncovered target forward to the next playable
  clip (or backward to the last).
- **Gated to when timecode is not rolling**, and only once session status has loaded — an
  unresolved status counts as unavailable rather than as "not rolling".
- **Rows that can never jump carry no control at all.** Anchorless transcript words, topics with
  no parseable time, and events with no frame count render as they do today. `aria-disabled` is
  reserved for the transient, global rolling state, where all rows in a feed share **one** reason
  node rather than emitting one per row.
- **Session-time strings convert by frame arithmetic**, not by treating HH:MM:SS as literal
  seconds. Those strings are rendered by decomposing a frame count at the *rounded* frame rate, so
  at 23.976 / 29.97 / 59.94 the naive conversion drifts proportionally to elapsed time. The
  server's own event-edit path already implements this inverse.
- **Transcript rows resolve from their stored `session_time` when it parses**, falling back to
  `start_sec`. The string is authoritative because the user can edit it and `start_sec` is never
  recomputed when they do.
- **Inline editing is untouched.** The jump lives in its own column; no editable cell's contents,
  width, or containing block change.
- A shared module owns the jump. `MarkerNav` is refactored onto it with no behavior change.

Not a breaking change: no existing interaction is removed, retargeted, or given a new
precondition.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `web-session-console`: gains the feed jump column — its affordance and a11y states, the per-feed
  rules for resolving a row to a timeline second, the not-rolling gate, the positionless-row and
  uncovered-target exclusions, playback-on-jump, and the requirement that inline editing and
  marker-navigation behavior are unchanged.

This capability already owns console-level UX at exactly this granularity (the 1–9 logging
hotkeys, transport tooltips, honest capability gating, the session-ID copy chip). Minting a
top-level capability for one control would be sprawl — every other capability in the baseline is
subsystem- or area-scoped, and `ui-refresh`, the closest analogue, likewise put its UI-behavior
requirements into `web-session-console`.

## Non-Goals

- **No server change.** Rows resolve their timeline second client-side from data already on the
  wire.
- **NOT recomputing `TranscriptWord.start_sec` server-side.** This is the tempting fix for stale
  transcript positions and is deferred to its own change: `start_sec === 0` is a **load-bearing
  sentinel**, not merely a stale value. `ai-v2-dashboards`' requirement "Data unavailability is a
  rendered state, never a zero" is implemented as
  `words.every(w => w.start_sec === 0 && w.end_sec === 0)`; recomputing timings for hand-entered
  rows would flip a wholly-untimed transcript out of its honest "unavailable" state, and a
  *partial* recompute would make it report a fabricated measured duration. Fixing it correctly
  needs authorizing deltas against two capabilities. **Queued as a successor.**
- **NOT adding a numeric position to `SessionTopic`** — a frozen-contract JSON shape change.
- **No change to marker-navigation behavior**, including its seek-only semantics.
- **No viewport scrolling on jump.** Considered and dropped: on narrow viewports the workspace is
  block-flow with the timeline far above the feed, so scrolling it into view scrolls the tapped
  row off-screen and makes repeated jumping unusable.
- **No row-selection model**, and no row-wide click handler.
- **No change to `manualScrubSec` lifetime.** See Impact.
- **No changes to `companion/`.**

## Impact

**Contract impact: none.** No endpoint, JSON shape, status code, export body, header/range
semantic, or WebSocket message shape or emission semantic changes. No server file is touched.
Every input is already on the wire: `LogEvent.timecode_total_frames` / `frame_rate` / `timecode`,
`TranscriptWord.session_time` / `start_sec`, `SessionTopic.session_time`, and
`SessionStatus.is_rolling` / `frame_rate`.

**Affected code (all under `web/src/`):**

- New shared jump module + a hook owning the gate, coverage check, and position resolution.
- New frame-arithmetic session-time converter in `shared/utils/`.
- `components/FeedTable.tsx` — first consumer of `ColumnDef.ariaLabel` for the hidden column
  header.
- `components/EventLogSheet.tsx`, `TranscribeFeed.tsx`, `TopicsFeed.tsx` — the new column
  definition; own the hook and pass a stable handler down. `TranscribeRow` is `memo`-wrapped and
  its feed is virtualized, so the handler must be referentially stable.
- `components/EventLogRow.tsx`, `TranscribeRow.tsx`, `TopicsRow.tsx` — the jump cell.
  `EventLogRow`'s timecode cell carries a `!cursor-pointer` lock with no handler behind it; that
  vestige is reconciled.
- `components/AudioPlayer.tsx` + `SessionWorkspace.tsx` — a play-capable seek path for the feed
  jump. `seekToTimelineSec` only resumes when already playing, so starting playback needs an
  explicit capability. Marker navigation must keep calling the non-playing path.
- `components/MarkerNav.tsx` — refactored onto the shared module, behavior unchanged.

**Known pre-existing behavior this change does NOT fix**, recorded so it is not later mistaken for
a regression: `manualScrubSec` is cleared only on session switch or a timeline-track double-click,
so a jump performed *before* a roll leaves the playhead latched for that take. The not-rolling gate
prevents jumps *during* a roll but does not clear a pre-roll latch. Reachable today via marker
navigation. Separately, `Timeline`'s live `nowSec` still uses the naive literal-seconds parse, so
the rolling playhead disagrees with markers and clips by ~0.1% of elapsed time at non-integer
frame rates — pre-existing, out of scope, and not reachable through a gated feed jump.

**Testing:** `EventLogRow`, `TranscribeRow`, `TopicsRow`, `FeedTable`, and `MarkerNav` have no
dedicated tests. `EventLogSheet.test.tsx` does render real `EventLogRow`s, so it must keep passing
unchanged. `TopicsRow` additionally needs a `ResizeObserver` stub and a `QueryClientProvider`. The
existing visual fixtures screenshot **empty** transcript and topics feeds, so they must be seeded
with rows or the new column is invisible to every visual gate.
