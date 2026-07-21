// ai-v2-dashboards — the "Add a widget" catalog picker (task 4.6, design
// brief: "editing (drag/resize handles, retitle-in-place, remove,
// near-opaque catalog picker with unavailable types disabled-with-reason,
// keyboard hints)", modelled on design/mockup.html's `.picker`/`.picker-item`
// dialog). Offers exactly the closed catalog (`WIDGET_TYPES`) — never an
// arbitrary/derived type — and disables an entry with a stated reason when
// the caller marks it unavailable, rather than hiding it silently (so a user
// understands WHY a type can't be added, per the mockup's "Filler words"
// example).
//
// All labels/reasons rendered here are either this module's own fixed
// `WIDGET_TYPE_LABELS` strings or caller-supplied reason text — always as
// plain text children, never markup/href/src/style (spec "No agent-authored
// markup is ever rendered").

import { renderCatalogWidgetPreview, WIDGET_TYPE_LABELS } from './widgetRegistry';
import { WIDGET_TYPES, type WidgetType } from './widgetTypes';

interface Props {
  /** Keyed by catalog type; a present entry disables that type and renders
   * its string value as the stated reason (design brief: "disabled-with-
   * reason"). A type absent from this map is selectable. Omitted entirely
   * (or an empty object) means every catalog type is currently available —
   * Phase 5/a future session-data seam is expected to supply real
   * availability, matching each widget's own degraded-state `reason` (task
   * 4.7); this unit does not fetch that data itself. */
  unavailableTypes?: Partial<Record<WidgetType, string>>;
  onPick: (type: WidgetType) => void;
  onClose: () => void;
}

export function CatalogPicker({ unavailableTypes, onPick, onClose }: Props) {
  return (
    <div
      role="dialog"
      aria-label="Add a widget"
      className="fixed inset-0 z-20 flex items-center justify-center bg-[rgba(6,9,16,0.55)] p-4"
      data-testid="aiv2-catalog-picker"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div className="flex max-h-[80vh] w-full max-w-[36rem] flex-col gap-3 overflow-hidden rounded-v5-lg border border-v5-border-strong bg-[rgba(13,19,34,0.97)] p-4 shadow-2xl">
        <div className="flex shrink-0 items-center gap-2">
          <h3 className="m-0 text-sm font-semibold text-v5-text">Add a widget</h3>
          <button
            type="button"
            aria-label="Close"
            className="ml-auto rounded-v5-sm px-2 py-1 text-v5-muted hover:text-v5-text"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2 overflow-y-auto">
          {WIDGET_TYPES.map((type) => {
            const reason = unavailableTypes?.[type];
            const disabled = Boolean(reason);
            return (
              <button
                key={type}
                type="button"
                disabled={disabled}
                aria-disabled={disabled}
                data-testid={`aiv2-picker-item-${type}`}
                onClick={() => {
                  if (!disabled) onPick(type);
                }}
                className={
                  disabled
                    ? 'flex cursor-not-allowed flex-col gap-1 rounded-v5-sm border border-v5-border bg-[rgba(255,255,255,0.02)] p-2 text-left opacity-50'
                    : 'flex flex-col gap-1 rounded-v5-sm border border-v5-border-strong bg-[rgba(255,255,255,0.03)] p-2 text-left transition-colors hover:border-[rgba(56,189,248,0.4)]'
                }
              >
                {/* Fixed catalog label — never agent/config-authored text. */}
                <span className="text-[0.82rem] font-medium text-v5-text">
                  {WIDGET_TYPE_LABELS[type]}
                </span>
                {disabled ? (
                  // Caller-supplied reason string — plain text child only.
                  <span className="text-[0.72rem] text-v5-soft">Unavailable: {reason}</span>
                ) : (
                  <div className="pointer-events-none scale-[0.85] origin-top-left opacity-90">
                    {renderCatalogWidgetPreview(type, WIDGET_TYPE_LABELS[type])}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
