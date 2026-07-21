// ai-v2-dashboards — event_count_by_category catalog widget (task 4.3).
// Category ids are OPAQUE (server D2a: `events.category` is a catalog-DB-
// resolved id outside SessionHub's/this tool's scope) — bars render the raw
// id as honest text by default. `categoryLabels` is an optional, purely
// additive display-label map a future caller MAY supply once label
// resolution is wired; omitting it never fabricates a label. Nominal
// categories are never colored by value (brief) — every bar uses the single
// brand-sky mark.

import { VIZ_SINGLE } from './palette';
import type { EventCountsData } from './widgetTypes';

interface Props {
  data: EventCountsData;
  /** Optional, additive: category id -> display label. Falls back to the
   * raw id (never a fabricated label) when absent or missing an entry. */
  categoryLabels?: Record<string, string>;
}

export function EventCountByCategoryWidget({ data, categoryLabels }: Props) {
  const entries = Object.entries(data.byCategory).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    return (
      <p
        className="m-0 flex-1 text-[0.85rem] text-v5-muted"
        data-testid="aiv2-widget-event_count_by_category"
      >
        No events recorded for this session.
      </p>
    );
  }
  const max = Math.max(...entries.map(([, count]) => count));
  return (
    <div
      className="flex flex-1 min-h-0 flex-col justify-center gap-2 overflow-y-auto"
      data-testid="aiv2-widget-event_count_by_category"
    >
      {entries.map(([categoryId, count]) => (
        <div
          key={categoryId}
          className="grid grid-cols-[minmax(0,1fr)_3.2rem] items-center gap-2.5"
        >
          <span className="flex items-center gap-2 text-[0.8rem] text-v5-text">
            <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
              {categoryLabels?.[categoryId] ?? categoryId}
            </span>
            <span className="relative h-3.5 flex-[2] rounded-r-[4px]">
              <i
                aria-hidden="true"
                className="absolute inset-y-0 left-0 min-w-[2px] rounded-r-[4px] opacity-85"
                style={{ width: `${max > 0 ? (count / max) * 100 : 0}%`, background: VIZ_SINGLE }}
              />
            </span>
          </span>
          <span className="text-right text-[0.78rem] [font-variant-numeric:tabular-nums] text-v5-muted">
            {count}
          </span>
        </div>
      ))}
    </div>
  );
}
