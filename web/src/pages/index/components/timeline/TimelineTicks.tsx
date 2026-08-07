import { useMemo, useSyncExternalStore } from 'react';
import { fmtHmsFromSec } from '../../../../shared/utils/timecode';

// Overlay on the scrub track's bottom border (centered vertically on that edge)
// so the strip doesn't spend a full row on tick labels. Text-shadow keeps labels
// readable across the dark lane and the chrome below.
// Centered on the track's bottom border; sibling of the track (not inside it)
// so track overflow:hidden can't clip. Parent reserves 0.5rem hang-space.
const TICKS =
  'pointer-events-none absolute inset-x-0 top-full z-[7] flex w-full -translate-y-1/2 justify-between gap-[0.5rem] px-[0.35rem] [font-family:"Inter",var(--font-poppins),system-ui,sans-serif] text-[0.62rem] font-semibold leading-none tracking-[0.06em] [font-variant-numeric:tabular-nums] text-[rgba(229,238,252,0.88)] [text-shadow:0_1px_1px_rgba(2,8,23,0.95),0_0_6px_rgba(2,8,23,0.75),0_-1px_1px_rgba(2,8,23,0.55)]';

declare global {
  interface Window {
    AutoLogger_getTimelineZoom?: () => number;
  }
}

/** Custom event session.js dispatches whenever timelineZoom mutates. */
const TIMELINE_ZOOM_EVENT = 'autologger:timeline-zoom-changed';

function getZoom(): number {
  const z = window.AutoLogger_getTimelineZoom?.();
  return Number.isFinite(z) && (z as number) > 0 ? (z as number) : 1;
}

function subscribeZoom(cb: () => void): () => void {
  window.addEventListener(TIMELINE_ZOOM_EVENT, cb);
  return () => window.removeEventListener(TIMELINE_ZOOM_EVENT, cb);
}

function useTimelineZoom(): number {
  return useSyncExternalStore(subscribeZoom, getZoom, () => 1);
}

/** Matches repo md breakpoint (≤767px). */
const MOBILE_MQ = '(max-width: 767.9px)';

function subscribeMobile(cb: () => void): () => void {
  const m = window.matchMedia(MOBILE_MQ);
  m.addEventListener('change', cb);
  return () => m.removeEventListener('change', cb);
}

function useIsMobile(): boolean {
  return useSyncExternalStore(
    subscribeMobile,
    () => window.matchMedia(MOBILE_MQ).matches,
    () => false,
  );
}

interface Props {
  totalSec: number;
}

export function TimelineTicks({ totalSec }: Props) {
  const zoom = useTimelineZoom();
  const isMobile = useIsMobile();
  const labels = useMemo(() => {
    const base = Math.min(29, Math.max(7, Math.round(5 + zoom * 3)));
    // Phones: half the density so labels don't collide in the narrow scrubber.
    const tickCount = isMobile ? Math.max(4, Math.round(base / 2)) : base;
    const span = totalSec > 0 ? totalSec : 0;
    const step = span / Math.max(1, tickCount - 1);
    return Array.from({ length: tickCount }, (_, i) => fmtHmsFromSec(Math.floor(i * step)));
  }, [zoom, totalSec, isMobile]);

  return (
    <div className={TICKS} id="timeline-ticks">
      {labels.map((label, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: tick labels keyed by position
        <span key={i}>{label}</span>
      ))}
    </div>
  );
}
