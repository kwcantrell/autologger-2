// ai-v2-dashboards — degraded/unavailable widget state (task 4.7, spec "Data
// unavailability is a rendered state, never a zero"). Renders the mockup's
// dashed-ring "Data unavailable" badge + one-sentence reason
// (design/mockup.html `.unavail`/`.unavail__badge`/`.unavail__reason`), never
// a zero/empty-series/placeholder rendered as though it were measured.

interface Props {
  /** Verbatim reason text passed through from the aggregate's own `reason`
   * field — never fabricated here, never hardcoded per-widget-type. Rendered
   * as TEXT ONLY (spec "No agent-authored markup is ever rendered" — this
   * string ultimately traces back to server-authored diagnostic text, not
   * transcript content, but the same text-only discipline applies uniformly). */
  reason: string;
  /** Short badge label; defaults to "Data unavailable". A few widgets (e.g.
   * unresolved speaker names) use a more specific label per the mockup. */
  label?: string;
}

export function UnavailableState({ reason, label = 'Data unavailable' }: Props) {
  return (
    <div
      className="flex flex-1 min-h-0 flex-col items-start justify-center gap-2"
      data-testid="aiv2-widget-unavailable"
    >
      <span className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-[rgba(148,163,184,0.4)] px-2.5 py-0.5 text-[0.72rem] font-medium text-v5-soft">
        <svg viewBox="0 0 12 12" fill="none" aria-hidden="true" className="h-3 w-3">
          <circle cx="6" cy="6" r="5" stroke="currentColor" strokeDasharray="2.5 2" />
        </svg>
        {label}
      </span>
      <p className="m-0 max-w-[34ch] text-[0.82rem] text-v5-muted">{reason}</p>
    </div>
  );
}
