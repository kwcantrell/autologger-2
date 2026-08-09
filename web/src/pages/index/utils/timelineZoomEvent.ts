/**
 * Custom event `useZoomRail.ts` dispatches (via `window.dispatchEvent`) whenever the
 * timeline zoom level mutates; `TimelineTicks.tsx` listens to redraw its tick labels
 * (web-coordination-seam D6 — the one-owning-module fix for the second restated-event-name
 * defect this change is named for).
 */
export const TIMELINE_ZOOM_EVENT = 'autologger:timeline-zoom-changed';
