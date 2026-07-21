// ai-v2-dashboards — shared widget card chrome (title + meta + body), one
// layer under `CatalogWidget` (widgetRegistry.tsx). Direct-manipulation
// affordances (drag/resize handles, retitle-in-place, remove) are task 4.6's
// job (editing mode) — this unit renders the read-only card shell the design
// brief's "saved"/"draft"/"degraded" states use.

import type { ReactNode } from 'react';

interface Props {
  /** Agent- or user-authored title — TEXT ONLY, always (spec "No
   * agent-authored markup is ever rendered"). Rendered as a plain string
   * child; never interpolated into markup/href/src/style. */
  title: string;
  meta?: string;
  children: ReactNode;
}

export function WidgetChrome({ title, meta, children }: Props) {
  return (
    <article
      className="relative flex min-h-0 min-w-0 flex-col rounded-v5-md border border-v5-border bg-[linear-gradient(180deg,rgba(255,255,255,0.045)_0%,rgba(255,255,255,0)_46%),linear-gradient(180deg,rgba(22,30,52,0.75),rgba(13,19,34,0.72))] p-3.5"
      data-testid="aiv2-widget-card"
    >
      <div className="mb-2 flex shrink-0 items-baseline gap-2">
        <h3 className="m-0 overflow-hidden text-ellipsis whitespace-nowrap text-[0.8rem] font-medium text-v5-muted">
          {title}
        </h3>
        {meta && (
          <span className="ml-auto whitespace-nowrap text-[0.72rem] text-v5-soft">{meta}</span>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </article>
  );
}
