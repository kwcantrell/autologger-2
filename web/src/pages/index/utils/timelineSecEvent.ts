/**
 * Custom event `Timeline.tsx` dispatches (on `document.body`) whenever the displayed
 * playhead position changes; `MarkerNav.tsx` listens to keep its prev/next side hints in
 * lockstep (web-coordination-seam D6 — the one-owning-module fix for the second
 * restated-event-name defect this change is named for).
 */
export const TIMELINE_SEC_EVENT = 'autologger:timeline-sec';
