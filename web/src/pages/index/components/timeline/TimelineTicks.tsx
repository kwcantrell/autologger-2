import { useMemo, useSyncExternalStore } from 'react';
import { fmtHmsFromSec } from '../../../../shared/utils/timecode';
import styles from '../Timeline.module.css';

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
    <div className={styles.timelineTicks} id="timeline-ticks">
      {labels.map((label, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: tick labels keyed by position
        <span key={i}>{label}</span>
      ))}
    </div>
  );
}
