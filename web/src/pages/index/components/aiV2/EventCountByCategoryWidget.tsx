// ai-v2-dashboards — event_count_by_category catalog widget (task 4.3;
// labels wired task 5.6, design D2a). Category ids are OPAQUE
// (`events.category` is a catalog-DB-resolved id outside SessionHub's
// scope). `categoryLabels` is the caller-resolved id -> label map (task 5.6:
// `useAiV2WidgetData.ts` builds it from the web's existing
// `useShowCategories` source plus the well-known `internal` system
// category). Two distinct "no real label" states, deliberately different:
//   - `categoryLabels` OMITTED entirely (preview/sample data, older tests) —
//     falls back to the raw id, matching the original task-4.3 placeholder.
//   - `categoryLabels` SUPPLIED but missing this specific id (a real
//     resolution attempt that came up empty — deleted category, or the
//     label source hasn't loaded yet) — renders the honest
//     `UNRESOLVED_CATEGORY_LABEL` text, NEVER the bare opaque id, which
//     would otherwise read to a user as though it were a real name (D2a:
//     "never a fabricated label, never show a bare UUID as if it were a
//     name").
// Nominal categories are never colored by value (brief) — every bar uses the
// single brand-sky mark.

import { VIZ_SINGLE } from './palette';
import type { EventCountsData } from './widgetTypes';

/** Rendered in place of a real label when a resolution attempt was made
 * (`categoryLabels` supplied) but came up empty for this specific id — never
 * the raw opaque id, which would look like a fabricated name to a user. */
export const UNRESOLVED_CATEGORY_LABEL = 'Labels unavailable';

interface Props {
  data: EventCountsData;
  /** Category id -> display label. Omit entirely to keep the pre-5.6
   * raw-id fallback (preview/sample data); supply it (even `{}`) once a real
   * label source is wired, so any id it doesn't cover renders the honest
   * `UNRESOLVED_CATEGORY_LABEL` instead of the id. */
  categoryLabels?: Record<string, string>;
}

function resolveLabel(categoryId: string, categoryLabels?: Record<string, string>): string {
  if (!categoryLabels) return categoryId;
  return categoryLabels[categoryId] ?? UNRESOLVED_CATEGORY_LABEL;
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
            <span
              className={
                categoryLabels && !categoryLabels[categoryId]
                  ? 'min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap italic text-v5-soft'
                  : 'min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap'
              }
            >
              {resolveLabel(categoryId, categoryLabels)}
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
