# maximize-log-view — proposal

## Why

During logging and feed review, the session deck (Timeline + Session Controls glass
panels) consumes a large share of vertical space. Operators want a **Maximize log**
layout that collapses that chrome into a short fused transport strip so the feed tabs
dominate — while keeping a durable preference, and always restoring the full deck when
the open session is rolling or recording (live category dock and recording affordances
need the default chrome).

## What Changes

- **Layout preference** (`default` | `maximize-log`), persisted in the browser across
  sessions (localStorage). Preference is never overwritten by forced-default display.
- **Displayed layout**:
  - Prefer maximize-log when preference is maximize-log **and** the open session is
    neither rolling nor recording (lease alive).
  - Otherwise show the **default** two-panel deck (today’s Timeline + Session Controls).
- **Maximize-log chrome**: one fused horizontal strip whose height is about **80% of the
  `#timeline-clips` lane height** (the waveform/clips row in the default Timeline) —
  timeline scrub/markers/waveform area + timecode + transport controls + the Session
  Controls **`?` shortcuts button** (no session title cluster, marker-nav pills, panel
  eyebrows, session-ID chip, or twin tall glass cards).
- **Toggle** at the **right end of the Feed tabs** tablist (not a new tab):
  - Preference default → labeled **Maximize log**
  - Preference maximize-log → labeled **Default view**
  - While the open session is rolling or recording: layout is forced default;
    **Maximize log** is non-actionable with a keyboard-reachable reason; preference
    unchanged.
- **Cross-session**: preference remembered; opening a rolling/recording session shows
  default; navigating to an idle session restores maximize-log if that is the saved
  preference.
- Unit/component tests for preference persistence + force-default; visual e2e baseline
  update if the tab strip / deck chrome is captured.

## Capabilities

### New Capabilities

- (none — extends session workspace console UX)

### Modified Capabilities

- `web-session-console`: maximize-log layout mode, preference persistence, force-default
  while rolling/recording, fused strip chrome, feed-tablist toggle

## Non-Goals

- New permanent app top bar for this mode (recording strip already exists in AppShell)
- Server/API/contract changes
- Changing feed tab inventory/order/labels
- Redesigning transport semantics, hotkeys, or live category-dock behavior in default mode
- Companion module UI

## Contract impact

None — web-only presentation and client-side preference.
