import { scrollTimelineToSec, seekAudio, setManualScrubSec } from '../coordination/registry';

/**
 * The one typed place the three timeline-jump handles live (design D8, feed-row-seek).
 *
 * `setManualScrubSec` / `scrollTimelineToSec` / `seekAudio` are owned by Timeline.tsx,
 * useZoomRail.ts, and SessionWorkspace.tsx respectively, and reached through the
 * coordination registry (web-coordination-seam) rather than through `window`.
 *
 * This is deliberately the ungated, uncoverage-checked, NON-PLAYING jump: it moves the
 * playhead, scrolls it into view, and seeks audio (without starting playback), and
 * nothing else. `MarkerNav` (phase 10) is refactored onto this exact function with no
 * behavior change — its seek-only, ungated-by-rolling, no-coverage-check semantics are
 * normative in the spec ("Marker navigation behavior is unchanged") and pinned by
 * MarkerNav.test.tsx. The gate, the clip-coverage check, and playback all belong one
 * level up, in the feed-facing hook (`useTimelineSeek`) — adding any of them here would
 * silently regress marker navigation.
 *
 * Each call is a registry invoke: a missing owner (not yet mounted, or unmounted) is a
 * silent no-op, never a throw.
 */
export function jumpTimelineToSec(sec: number): void {
  setManualScrubSec(sec);
  scrollTimelineToSec(sec);
  seekAudio(sec);
}
