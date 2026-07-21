// ai-v2-dashboards — direct-manipulation dashboard editing (task 4.6; spec
// "Dashboards are edited directly, not only by conversation"; design D7a:
// "the agent's job is the first draft, not every edit... everything after is
// direct manipulation: add, remove, resize, reorder, retitle, without a
// turn"). This component owns NO network/agent call whatsoever — every
// mutating operation below computes a new `DashboardConfig` value in plain
// React state and hands it to the caller's `onChange`, which is expected to
// persist it through `./dashboardPersistence`'s `DashboardPersistencePort`
// (a client-side, currently-mocked boundary — see that module's header).
// There is no code path in this file that reaches `/ai/v2/design` or
// `/ai/v2/answer`, or imports anything from `AiV2Design.tsx` — the "a saved
// dashboard is modified end-to-end with no agent turn" gate is true by
// construction, not merely by test coverage (verified anyway in
// DashboardEditor.test.tsx).
//
// Keyboard operability (design brief accessibility: "keyboard-operable
// editing (arrow move, shift-arrow resize, Enter retitle, Del remove)
// rendered as visible hints in edit mode") is the PRIMARY, fully-tested
// interaction path — deterministic and exercised end-to-end below. Pointer
// drag/resize (mockup: "drag" handle + corner resize) is a progressive
// enhancement layered on top of the same `updateWidget` mutation the
// keyboard path uses; it is not meaningfully unit-testable under jsdom
// (`getBoundingClientRect` always reports a zero-sized layout there), so it
// degrades to a no-op rather than crashing when the grid has no real
// layout — see `cellMetrics()` below.
//
// Retitle-in-place renders the in-progress value as a controlled `<input>`;
// the committed title is written back as a plain string (trimmed, length-
// bounded to match the server schema's `MAX_TITLE_LEN`), never parsed as or
// interpolated into markup (spec "No agent-authored markup is ever
// rendered" — a title is USER-authored here, but the same text-only
// discipline applies uniformly, matching WidgetChrome's existing contract).

import { useRef, useState } from 'react';
import { CatalogPicker } from './CatalogPicker';
import type { CatalogWidgetData } from './widgetRegistry';
import { CatalogWidget, KNOWN_WIDGET_TYPES, WIDGET_TYPE_LABELS } from './widgetRegistry';
import type { DashboardConfig, WidgetLayout, WidgetType } from './widgetTypes';

const GRID_COLUMNS = 12;
const ROW_HEIGHT_REM = 5.4;
const DEFAULT_WIDGET_W = 4;
const DEFAULT_WIDGET_H = 3;
const MAX_TITLE_LEN = 200;
const MAX_H = 24;
const MAX_Y = 200;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

interface Props {
  config: DashboardConfig;
  onChange: (next: DashboardConfig) => void;
  /** Keyed by widget instance id — same shape `DashboardGrid` consumes. No
   * live session-data fetch happens in this component (Phase 5); a widget
   * with no entry renders the honest "no data provided" placeholder rather
   * than a fabricated value, exactly like `DashboardGrid`. */
  widgetData?: Record<string, CatalogWidgetData>;
  /** Threaded straight to `CatalogPicker` — see that module for the
   * disabled-with-reason contract. */
  unavailableTypes?: Partial<Record<WidgetType, string>>;
}

interface DragPreview {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export function DashboardEditor({ config, onChange, widgetData = {}, unavailableTypes }: Props) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [retitlingId, setRetitlingId] = useState<string | null>(null);
  const [retitleDraft, setRetitleDraft] = useState('');
  const [dragPreview, setDragPreview] = useState<DragPreview | null>(null);
  const gridRef = useRef<HTMLUListElement | null>(null);
  const previewRef = useRef<DragPreview | null>(null);

  function updateWidget(id: string, patch: Partial<WidgetLayout>) {
    onChange({
      ...config,
      widgets: config.widgets.map((w) => (w.id === id ? { ...w, ...patch } : w)),
    });
  }

  function removeWidget(id: string) {
    onChange({
      widgets: config.widgets.filter((w) => w.id !== id),
      interactions: config.interactions.filter(
        (i) => i.sourceWidgetId !== id && i.targetWidgetId !== id,
      ),
    });
  }

  function addWidget(type: WidgetType, label: string) {
    const y = config.widgets.reduce((max, w) => Math.max(max, w.y + w.h), 0);
    const widget: WidgetLayout = {
      id: crypto.randomUUID(),
      type,
      title: label,
      x: 0,
      y,
      w: DEFAULT_WIDGET_W,
      h: DEFAULT_WIDGET_H,
    };
    onChange({ ...config, widgets: [...config.widgets, widget] });
    setPickerOpen(false);
  }

  function startRetitle(widget: WidgetLayout) {
    setRetitlingId(widget.id);
    setRetitleDraft(widget.title);
  }

  function commitRetitle() {
    const trimmed = retitleDraft.trim().slice(0, MAX_TITLE_LEN);
    if (retitlingId && trimmed) updateWidget(retitlingId, { title: trimmed });
    setRetitlingId(null);
  }

  function cancelRetitle() {
    setRetitlingId(null);
  }

  function handleWidgetKeyDown(e: React.KeyboardEvent, widget: WidgetLayout) {
    switch (e.key) {
      case 'ArrowLeft':
        e.preventDefault();
        if (e.shiftKey) updateWidget(widget.id, { w: Math.max(1, widget.w - 1) });
        else updateWidget(widget.id, { x: Math.max(0, widget.x - 1) });
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (e.shiftKey) {
          updateWidget(widget.id, { w: clamp(widget.w + 1, 1, GRID_COLUMNS - widget.x) });
        } else {
          updateWidget(widget.id, { x: clamp(widget.x + 1, 0, GRID_COLUMNS - widget.w) });
        }
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (e.shiftKey) updateWidget(widget.id, { h: Math.max(1, widget.h - 1) });
        else updateWidget(widget.id, { y: Math.max(0, widget.y - 1) });
        break;
      case 'ArrowDown':
        e.preventDefault();
        if (e.shiftKey) updateWidget(widget.id, { h: clamp(widget.h + 1, 1, MAX_H) });
        else updateWidget(widget.id, { y: clamp(widget.y + 1, 0, MAX_Y) });
        break;
      case 'Enter':
        e.preventDefault();
        startRetitle(widget);
        break;
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        removeWidget(widget.id);
        break;
      default:
        break;
    }
  }

  function cellMetrics(): { colWidth: number; rowHeight: number } | null {
    const el = gridRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0) return null; // jsdom / not-yet-laid-out — no-op drag
    const rootFontSize =
      Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    return { colWidth: rect.width / GRID_COLUMNS, rowHeight: ROW_HEIGHT_REM * rootFontSize };
  }

  function startPointerDrag(e: React.PointerEvent, widget: WidgetLayout, mode: 'move' | 'resize') {
    e.preventDefault();
    e.stopPropagation();
    const metrics = cellMetrics();
    if (!metrics) return;
    const { colWidth, rowHeight } = metrics;
    const startX = e.clientX;
    const startY = e.clientY;
    const origin = { x: widget.x, y: widget.y, w: widget.w, h: widget.h };

    function onMove(ev: PointerEvent) {
      const dxCols = Math.round((ev.clientX - startX) / colWidth);
      const dyRows = Math.round((ev.clientY - startY) / rowHeight);
      const next: DragPreview =
        mode === 'move'
          ? {
              id: widget.id,
              x: clamp(origin.x + dxCols, 0, GRID_COLUMNS - origin.w),
              y: clamp(origin.y + dyRows, 0, MAX_Y),
              w: origin.w,
              h: origin.h,
            }
          : {
              id: widget.id,
              x: origin.x,
              y: origin.y,
              w: clamp(origin.w + dxCols, 1, GRID_COLUMNS - origin.x),
              h: clamp(origin.h + dyRows, 1, MAX_H),
            };
      previewRef.current = next;
      setDragPreview(next);
    }
    function onUp() {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (previewRef.current) {
        const { id, ...patch } = previewRef.current;
        updateWidget(id, patch);
      }
      previewRef.current = null;
      setDragPreview(null);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-testid="aiv2-dashboard-editor">
      <ul
        ref={gridRef}
        className="grid list-none gap-3.5 p-0 m-0"
        style={{ gridTemplateColumns: 'repeat(12, minmax(0, 1fr))', gridAutoRows: '5.4rem' }}
        aria-label="Dashboard widgets — editing"
        data-testid="aiv2-dashboard-editor-grid"
      >
        {config.widgets.map((widget) => {
          const live = dragPreview?.id === widget.id ? dragPreview : widget;
          const style = {
            gridColumn: `${live.x + 1} / span ${live.w}`,
            gridRow: `${live.y + 1} / span ${live.h}`,
          };
          const data = widgetData[widget.id];
          const isRetitling = retitlingId === widget.id;

          return (
            // Plain, non-interactive `<li>` for grid positioning (satisfies
            // biome's noNoninteractiveTabindex/noRedundantRoles — a list item
            // is not itself the focusable control). The focusable, keyboard-
            // operable surface is the `role="group"` div below, one level
            // in.
            <li key={widget.id} style={style} className="min-h-0 min-w-0">
              {/* biome-ignore lint/a11y/useSemanticElements: <fieldset> is not the right semantic here — this is a draggable/resizable dashboard widget (drag/resize/retitle/remove), not a form field group */}
              <div
                className="relative h-full w-full transition-[grid-column,grid-row] duration-200 ease-out motion-reduce:transition-none"
                // biome-ignore lint/a11y/noNoninteractiveTabindex: this IS the composite, keyboard-operable editing surface the design brief requires (arrow move, shift-arrow resize, Enter retitle, Del remove) — it must be focusable; no native interactive element models "focusable group of drag/resize/retitle/remove controls"
                tabIndex={0}
                role="group"
                aria-label={`${widget.title} — editing`}
                data-testid="aiv2-editor-widget"
                data-widget-id={widget.id}
                onKeyDown={(e) => {
                  if (!isRetitling) handleWidgetKeyDown(e, widget);
                }}
              >
                <span
                  aria-hidden="true"
                  className="absolute -top-1 -left-1 z-10 h-3 w-3 cursor-grab rounded-full border border-v5-border-strong bg-[rgba(56,189,248,0.35)]"
                  data-testid="aiv2-editor-drag-handle"
                  onPointerDown={(e) => startPointerDrag(e, widget, 'move')}
                />
                <button
                  type="button"
                  aria-label="Remove widget"
                  data-testid="aiv2-editor-remove"
                  className="absolute -top-2 -right-2 z-10 flex h-5 w-5 items-center justify-center rounded-full border border-v5-border-strong bg-[rgba(13,19,34,0.9)] text-[0.65rem] text-v5-muted hover:text-v5-danger"
                  onClick={() => removeWidget(widget.id)}
                >
                  ✕
                </button>
                <span
                  aria-hidden="true"
                  data-testid="aiv2-editor-resize-handle"
                  className="absolute -bottom-1 -right-1 z-10 h-3 w-3 cursor-nwse-resize rounded-full border border-v5-border-strong bg-[rgba(56,189,248,0.35)]"
                  onPointerDown={(e) => startPointerDrag(e, widget, 'resize')}
                />
                <div className="h-full w-full rounded-v5-md border border-[rgba(56,189,248,0.28)]">
                  {isRetitling ? (
                    <div className="flex h-full flex-col gap-2 p-3.5">
                      <input
                        ref={(el) => el?.focus()}
                        value={retitleDraft}
                        data-testid="aiv2-editor-retitle-input"
                        aria-label="Widget title"
                        maxLength={MAX_TITLE_LEN}
                        onChange={(e) => setRetitleDraft(e.target.value)}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            commitRetitle();
                          } else if (e.key === 'Escape') {
                            e.preventDefault();
                            cancelRetitle();
                          }
                        }}
                        onBlur={commitRetitle}
                        className="w-full rounded-v5-sm border border-[rgba(56,189,248,0.5)] bg-transparent px-2 py-1 text-[0.8rem] text-v5-text focus:outline-none"
                      />
                    </div>
                  ) : data && KNOWN_WIDGET_TYPES.has(widget.type) ? (
                    <CatalogWidget title={widget.title} data={data} />
                  ) : (
                    <div className="flex h-full items-center justify-center rounded-v5-md p-3 text-center text-[0.8rem] text-v5-soft">
                      {widget.title}
                      <span className="sr-only"> — no data provided for this widget yet</span>
                    </div>
                  )}
                </div>
              </div>
            </li>
          );
        })}

        <li style={{ gridColumn: 'span 4', gridRow: 'span 2' }}>
          <button
            type="button"
            data-testid="aiv2-editor-add-widget"
            aria-label="Add widget"
            className="flex h-full w-full items-center justify-center gap-1.5 rounded-v5-md border border-dashed border-v5-border-strong text-[0.85rem] text-v5-muted transition-colors hover:border-[rgba(56,189,248,0.5)] hover:text-v5-text"
            onClick={() => setPickerOpen(true)}
          >
            <span aria-hidden="true">＋</span> Add widget
          </button>
        </li>
      </ul>

      <div
        className="flex flex-wrap gap-x-4 gap-y-1 rounded-v5-sm border border-v5-border bg-[rgba(255,255,255,0.02)] px-3 py-1.5 text-[0.72rem] text-v5-soft"
        data-testid="aiv2-editor-hints"
      >
        <span>
          <kbd>drag</kbd> move · <kbd>corner</kbd> resize
        </span>
        <span>
          <kbd>←↑↓→</kbd> move · <kbd>Shift</kbd>+<kbd>←→</kbd> resize
        </span>
        <span>
          <kbd>Enter</kbd> retitle · <kbd>Del</kbd> remove
        </span>
      </div>

      {pickerOpen && (
        <CatalogPicker
          unavailableTypes={unavailableTypes}
          onPick={(type) => addWidget(type, WIDGET_TYPE_LABELS[type])}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}
