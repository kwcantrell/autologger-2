// ai-v2-dashboards — the grid renderer (task 4.3), driven entirely by the
// layout DSL from packages/contract/src/aiV2Catalog.ts (`WidgetLayout`'s x/y/w/h +
// `DashboardInteraction`'s named `kind`/source/target). A 12-column grid with
// 5.4rem auto-rows, matching design/mockup.html's `.grid`/`.widget` — the
// mockup is the visual spec (design.md "UI design brief"), so this fixes the
// column count/row height to what it shows rather than making them
// dashboard-configurable (only widget x/y/w/h are).
//
// Interactions: only `highlight_speaker` has an implemented visual effect in
// this unit (a source `talk_time_by_speaker` widget selecting a speaker dims
// non-matching speakers in every target widget). `filter_by_topic` and
// `scroll_to_time` are accepted (never crash/reject a valid config) but are
// currently inert — no widget in this unit's catalog wires a visual response
// to them yet. This is safe/honest (an inert interaction never fabricates a
// behavior) and is flagged in this unit's report as a residual for whichever
// later unit gives those kinds their first real target.
//
// This component takes fixture/caller-supplied `widgetData` — it does NOT
// fetch or read a session data source itself (deferred to Phase 5); the
// caller is responsible for supplying one `CatalogWidgetData` entry per
// widget id, matching that widget's own `type`.

import { useState } from 'react';
import { CatalogWidget, type CatalogWidgetData, KNOWN_WIDGET_TYPES } from './widgetRegistry';
import type { DashboardInteraction, WidgetLayout } from './widgetTypes';

interface Props {
  widgets: WidgetLayout[];
  interactions?: DashboardInteraction[];
  /** Keyed by widget instance id. A missing entry, or one whose own
   * `widgetType` doesn't match the widget's configured `type`, renders a
   * "no data provided" placeholder rather than crashing or rendering a zero. */
  widgetData: Record<string, CatalogWidgetData>;
}

/** Render-side backstop (ai-v2-dashboards task 5.3, spec "Dashboard
 * persistence"). The server's write-time validation
 * (`validateDashboardConfig`, packages/contract/src/aiV2Catalog.ts) already caps a
 * dashboard at `MAX_WIDGETS_PER_DASHBOARD` (64) widgets, but this component
 * has no way to KNOW a config it's handed actually passed through that path
 * — a stored row edited directly on disk, an older row from before a bound
 * tightened, or a future second write path are all reachable without going
 * through the route. Mapping an unbounded `widgets` array straight into DOM
 * nodes would let any of those hang the browser; this cap makes that
 * impossible regardless of how the array got this large, independent of
 * whatever the server currently enforces. Mirrors
 * `MAX_WIDGETS_PER_DASHBOARD` in packages/contract/src/aiV2Catalog.ts (kept as a
 * literal, not an import — web never imports from server/src, see
 * widgetTypes.ts's module header on the two staying in sync by hand). */
const MAX_RENDERED_WIDGETS = 64;

export function DashboardGrid({ widgets, interactions = [], widgetData }: Props) {
  const truncated = widgets.length > MAX_RENDERED_WIDGETS;
  const renderedWidgets = truncated ? widgets.slice(0, MAX_RENDERED_WIDGETS) : widgets;
  // Shared `highlight_speaker` state: any configured source widget setting it
  // affects every configured target widget (deliberately shared/simple — see
  // module header). No dashboard in v1 is expected to need per-interaction
  // isolation between multiple simultaneous highlight_speaker wires.
  const [highlightedSpeaker, setHighlightedSpeaker] = useState<string | null>(null);

  const highlightSources = new Set(
    interactions.filter((i) => i.kind === 'highlight_speaker').map((i) => i.sourceWidgetId),
  );
  const highlightTargets = new Set(
    interactions.filter((i) => i.kind === 'highlight_speaker').map((i) => i.targetWidgetId),
  );

  return (
    <>
      {truncated ? (
        <p
          role="status"
          data-testid="aiv2-dashboard-truncated"
          className="m-0 shrink-0 rounded-v5-md border border-dashed border-v5-border-strong px-3 py-2 text-[0.8rem] text-v5-soft"
        >
          Showing the first {MAX_RENDERED_WIDGETS} of {widgets.length} widgets in this dashboard.
        </p>
      ) : null}
      <ul
        className="grid list-none gap-3.5 p-0 m-0"
        style={{ gridTemplateColumns: 'repeat(12, minmax(0, 1fr))', gridAutoRows: '5.4rem' }}
        aria-label="Dashboard widgets"
        data-testid="aiv2-dashboard-grid"
      >
        {renderedWidgets.map((widget) => {
          // Defensive: reject/ignore an unrecognized type. Can't occur when
          // driven by a config that already passed `validateDashboardConfig`
          // server-side, but the grid never assumes its input was validated.
          if (!KNOWN_WIDGET_TYPES.has(widget.type)) {
            console.warn(`DashboardGrid: skipping unknown widget type "${widget.type}"`);
            return null;
          }

          const data = widgetData[widget.id];
          const style = {
            gridColumn: `${widget.x + 1} / span ${widget.w}`,
            gridRow: `${widget.y + 1} / span ${widget.h}`,
          };

          if (!data || data.widgetType !== widget.type) {
            return (
              <li
                key={widget.id}
                style={style}
                className="flex items-center justify-center rounded-v5-md border border-dashed border-v5-border-strong p-3 text-[0.8rem] text-v5-soft"
                data-testid="aiv2-widget-no-data"
              >
                No data provided for this widget.
              </li>
            );
          }

          const wired = wireInteractions(data, widget.id, {
            highlightSources,
            highlightTargets,
            highlightedSpeaker,
            setHighlightedSpeaker,
          });

          return (
            <li key={widget.id} style={style} className="min-h-0 min-w-0">
              <CatalogWidget title={widget.title} data={wired} />
            </li>
          );
        })}
      </ul>
    </>
  );
}

function wireInteractions(
  data: CatalogWidgetData,
  widgetId: string,
  ctx: {
    highlightSources: Set<string>;
    highlightTargets: Set<string>;
    highlightedSpeaker: string | null;
    setHighlightedSpeaker: (speakerId: string | null) => void;
  },
): CatalogWidgetData {
  if (data.widgetType === 'talk_time_by_speaker') {
    return {
      ...data,
      onSpeakerSelect: ctx.highlightSources.has(widgetId)
        ? (speakerId: string) =>
            ctx.setHighlightedSpeaker(ctx.highlightedSpeaker === speakerId ? null : speakerId)
        : undefined,
      highlightSpeaker: ctx.highlightTargets.has(widgetId) ? ctx.highlightedSpeaker : undefined,
    };
  }
  if (data.widgetType === 'transcript_excerpt' && ctx.highlightTargets.has(widgetId)) {
    return { ...data, highlightSpeaker: ctx.highlightedSpeaker };
  }
  return data;
}
