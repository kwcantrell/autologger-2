# Proposal: settings-modal-mount-cost

## Why

Opening the Settings modal costs a visible lag spike. The cause is not network latency — the
modal issues no request on open, reading only the already-cached `profile` query. It is
synchronous mount cost, and the panel measurement refined it twice:

- **All four tab panels render on every pass**, hidden with the `hidden` *attribute* rather than
  conditionally rendered. So the Event Buttons table mounts even though the modal always opens on
  the General tab.
- **The dominant per-row cost is the Radix `Select`, not the `Popover`.** A closed Radix `Select`
  still mounts its entire item subtree into a detached `DocumentFragment`
  (`SelectContentFragment`), while the `Popover`'s content is `Presence`-gated and genuinely
  unmounted. Every event-button row pays a full Select item tree whether or not anyone opens it.
- **The spike lands on *reopen*, not first open.** On a first open `showDrafts` is still empty, so
  the Event Buttons panel renders its "Select a show above" hint and the table mounts only on a
  second commit after the init effect. `showDrafts` is never cleared on close, so every
  *subsequent* open mounts the full table inside the opening commit.

Profiling on the reporter's own data then found a **second, larger cost** that only appears with a
session open — which is why the first profile (taken from `/`) missed it entirely. With session
`ed1413e0-…` mounted (15,150 transcript words), the same click goes from 6,141 to **17,238
renders** and 70 ms to **101 ms**. Mounts are identical; the entire delta is the already-mounted
workspace re-rendering. `WorkspaceStatic` is `memo()`'d expressly to prevent this, but `AppShell`
passes `SessionRoute` an inline `onOpenMobileNav={() => setRailOpen(true)}` arrow that it forwards
into the memo, so shallow comparison always misses and the guard never holds. That defect fires on
*every* shell state change, not just this modal.

## What Changes

- **The workspace render-isolation memo is restored** by giving `onOpenMobileNav` a stable
  identity, matching the three already-`useCallback`'d handlers beside it. Largest measured win,
  smallest diff, and it fixes the same defect for New Session, Batch Import, the YouTube error
  modal, and the mobile rail toggle.

- **Inactive tab content mounts on first activation** and stays mounted afterwards. The four panel
  wrapper elements keep rendering, so every `aria-controls` target and e2e-observable id survives.
- **The open-reset moves out of the passive effect into the render phase.** Resetting the active
  tab in a `useEffect` would let the reopen commit mount the stale tab's content and then unmount
  it — strictly worse than today. Adjusting state during render keeps that commit off the DOM.
- **Each event-button row's type `Select` becomes lazy**: an inert trigger with the same
  appearance and accessible name, upgraded to the real Radix `Select` on pointer or focus intent.
  This attacks the cost itself rather than relocating it, so the Event Buttons tab click gets
  faster too — deferral alone would simply move the spike onto that click.

No **BREAKING** changes.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `web-ui-system`: adds three requirements — shell state changes not re-rendering the mounted
  session workspace; the Settings modal's tab-panel mount discipline (deferred first mount, no
  unmount on switch, no transient mount on reopen, and the property that makes deferral safe: a
  save persists edits for shows on tabs the user never visited, because the drafts live in the
  modal's own state); and the lazy per-row type control.

## Impact

- **Contract impact: none.** No HTTP/WS endpoint, JSON shape, status code, export body,
  header/range semantic, or WebSocket message/emission changes. Render timing only.
- **Code**: `web/src/pages/index/AppShell.tsx` (one `useCallback`, restoring the workspace
  isolation memo), `web/src/pages/index/components/HomeSettingsModal.tsx` (tab deferral,
  render-phase reset), `web/src/pages/index/components/EventButtonsTable.tsx` (lazy per-row
  control),
  `web/src/pages/index/components/Select.tsx` (one additive, optional `defaultOpen` pass-through —
  required to mount the upgraded control already open; existing call sites untouched), and their
  tests. No change to `AppShell.tsx`.
- **Dependencies**: none added.
- **Gates**: `npm run typecheck`, `npm test`, `npm run e2e` + `npm run e2e:visual`,
  `npm run docs:check`, `npm run lint`.

## Non-Goals

- **Code-splitting / deferred module loading is out of scope entirely.** It was split out to
  `web-boot-split-boundaries` (queued draft) on the 2026-08-13 gate ruling: its dominant boundary
  optimizes a boot cost unrelated to this symptom, and it carries its own risk surface (a new
  independent chunk-failure mode with no error boundary anywhere in `web/src`, a
  `next/dynamic` implementation that differs between the test tier and the App Router build, and a
  measurement instrument that cannot see the change). None of that should block this fix.
- **No data-fetching changes.** The original "linear fetches" framing does not describe this code
  and is not acted on.
- **The six session-workspace feed panels are untouched.** `web-session-console` requires all six
  to stay mounted with visibility toggled; `ai-v2-dashboards` echoes it. Nothing here applies to
  them.
- **No visual, copy, layout, or interaction redesign.** The lazy per-row control must be visually
  and behaviorally indistinguishable from the Radix `Select` it stands in for.
- **No virtualization of the event-button rows**, and no rework of the modal's dirtiness
  derivation or discard guard. Both are recorded follow-up candidates, not scope.
- **Not a general performance campaign** — render cost outside this modal is untouched.
