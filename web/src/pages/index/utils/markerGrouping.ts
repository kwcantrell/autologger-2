import type { LogEvent, SessionStatus } from '../../../api/types';
import { eventTimelineSec } from '../../../shared/utils/audioClips';

// Same-second marker grouping, single-sourced for Timeline (current-nav-marker
// readout) and MarkerNav (prev/next jump targets) — code-health-tail task 4.3,
// finding 2.6. The two components previously carried outcome-equivalent,
// phrasing-different copies; drift between them would silently desync the
// side-nav hints from where the timeline actually jumps.
//
// Grouping contract (pinned by markerGrouping.test.ts):
// - events whose timeline position is non-finite or negative are dropped;
// - events collapse into one marker per millisecond bucket (`sec.toFixed(3)`);
// - within a bucket, first event wins EXCEPT that an internal-category holder
//   is replaced by the first non-internal arrival ("internal loses");
// - result is sorted ascending by sec.
export interface TimelineMarkerGroup {
  sec: number;
  event: LogEvent;
  isInternal: boolean;
}

export function groupTimelineMarkers(
  events: LogEvent[],
  status: SessionStatus | null | undefined,
): TimelineMarkerGroup[] {
  const grouped = new Map<string, TimelineMarkerGroup>();
  for (const e of events) {
    const sec = eventTimelineSec(e, status);
    if (!(Number.isFinite(sec) && sec >= 0)) continue;
    const key = sec.toFixed(3);
    const isInternal = String(e.category ?? '').toLowerCase() === 'internal';
    const existing = grouped.get(key);
    if (!existing || (existing.isInternal && !isInternal)) {
      grouped.set(key, { sec, event: e, isInternal });
    }
  }
  return Array.from(grouped.values()).sort((a, b) => a.sec - b.sec);
}
