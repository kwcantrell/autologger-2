import { useMemo, useSyncExternalStore } from 'react';
import { fmtHmsFromSec } from '../../../../shared/utils/timecode';

// --- converted class strings (were Timeline.module.css) ---
// .timelineTicks base + `.timelineInner .timelineTicks { margin-top: 0.22rem }` +
// `.v4TlTrackLive .timelineTicks` (font-size 0.58rem) + #v4-log-session v5 rule (Inter,
// 0.62rem, v5 color, tabular-nums) — the #v4-log-session rule wins, so this is the
// session-context look Timeline always renders.
// ui-refresh: tick color was rgba(229,238,252,0.36) = 2.96:1 — time data failing
// the app's own AA bar. 0.58 clears 4.5:1 on the timeline lane.
const TICKS =
  'flex justify-between gap-[0.5rem] w-full flex-shrink-0 mt-[0.22rem] [font-family:"Inter",var(--font-poppins),system-ui,sans-serif] text-[0.62rem] font-medium tracking-[0.06em] [font-variant-numeric:tabular-nums] text-[rgba(229,238,252,0.58)]';

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

interface Props {
  totalSec: number;
}

export function TimelineTicks({ totalSec }: Props) {
  const zoom = useTimelineZoom();
  const labels = useMemo(() => {
    const tickCount = Math.min(29, Math.max(7, Math.round(5 + zoom * 3)));
    const span = totalSec > 0 ? totalSec : 0;
    const step = span / Math.max(1, tickCount - 1);
    return Array.from({ length: tickCount }, (_, i) => fmtHmsFromSec(Math.floor(i * step)));
  }, [zoom, totalSec]);

  return (
    <div className={TICKS} id="timeline-ticks">
      {labels.map((label, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: tick labels keyed by position
        <span key={i}>{label}</span>
      ))}
    </div>
  );
}
