/**
 * The one typed place the three timeline-jump globals live (design D8, feed-row-seek).
 *
 * `AutoLogger_setManualScrubSec` / `AutoLogger_scrollTimelineToSec` / `AutoLogger_seekAudio`
 * are already declared on `Window` via merged `declare global` blocks in Timeline.tsx,
 * useZoomRail.ts, and AppShell.tsx respectively — this module deliberately does NOT
 * redeclare them, to avoid a conflicting duplicate declaration.
 *
 * This is deliberately the ungated, uncoverage-checked, NON-PLAYING jump: it moves the
 * playhead, scrolls it into view, and seeks audio (without starting playback), and
 * nothing else. `MarkerNav` (phase 10) is refactored onto this exact function with no
 * behavior change — its seek-only, ungated-by-rolling, no-coverage-check semantics are
 * normative in the spec ("Marker navigation behavior is unchanged") and pinned by
 * MarkerNav.test.tsx. The gate, the clip-coverage check, and playback all belong one
 * level up, in the feed-facing hook (a later unit) — adding any of them here would
 * silently regress marker navigation.
 *
 * Each call is optional-chained: a missing global (not yet mounted, or unmounted) is a
 * silent no-op, never a throw.
 */
export function jumpTimelineToSec(sec: number): void {
  window.AutoLogger_setManualScrubSec?.(sec);
  window.AutoLogger_scrollTimelineToSec?.(sec);
  window.AutoLogger_seekAudio?.(sec);
}
