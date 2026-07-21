import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import { AiV2Design, type AiV2Message, type AiV2PendingQuestion } from './AiV2Design';
import { DashboardEditor } from './aiV2/DashboardEditor';
import { DashboardGrid } from './aiV2/DashboardGrid';
import {
  type DashboardPersistencePort,
  localStorageDashboardPersistence,
} from './aiV2/dashboardPersistence';
import { renderCatalogWidgetPreview } from './aiV2/widgetRegistry';
import type { DashboardConfig } from './aiV2/widgetTypes';
import { FEED_GLASS_BTN, FEED_GLASS_BTN_PRIMARY } from './FeedTable';

interface Props {
  sessionId: string;
  /** DI seam for tests — defaults to the real (currently localStorage-
   * mocked, see dashboardPersistence.ts) boundary. Never used by app code
   * to reach a network endpoint; Phase 5 replaces the default export, not
   * this prop's presence. */
  persistence?: DashboardPersistencePort;
}

const STARTER_MESSAGE =
  'Give me a starting dashboard for this session: who talked, what about, and where the activity was.';

const EMPTY_DASHBOARD: DashboardConfig = { widgets: [], interactions: [] };

/**
 * AI v2 tab (ai-v2-dashboards, task 4.1; spec "AI v2 tab in the session
 * workspace"; design "UI design brief" — canvas + docked design rail
 * topology). Mirrors AiPanel's proven shape (ai-topics-chat, design D9):
 * the design conversation's messages/streaming-flag/AbortController AND its
 * pending question are all hoisted to THIS component, one level above
 * `AiV2Design` — so the parent `SessionWorkspace` mounting this panel
 * mounted-hidden (never conditionally) means switching away from "AI v2"
 * and back never unmounts it, never aborts an in-flight design turn, and
 * never clears the conversation or a pending question.
 *
 * Canvas seam (task 4.6, direct-manipulation editing): `dashboardConfig` is
 * this component's own state, loaded once on mount from the persistence
 * boundary (`aiV2/dashboardPersistence.ts` — a client-side, currently
 * localStorage-backed MOCK; Phase 5 replaces it with the real endpoint
 * behind the same `DashboardPersistencePort` interface, no call-site
 * changes). Two entry points create it (design D7a): "Design with AI" kicks
 * off a design turn via `AiV2Design` (unchanged from task 4.1/4.2 — this
 * component still doesn't assemble a design turn's output into a
 * `DashboardConfig`, since no wiring for that exists yet and it is outside
 * this task's scope); "Start blank" creates an EMPTY `DashboardConfig`
 * directly and drops straight into edit mode, per this task's brief.
 * Every subsequent add/remove/resize/reposition/retitle goes through
 * `DashboardEditor`, which calls `onChange` here — this component persists
 * that value via `persistence.save` and NEVER runs a design turn to do so
 * (spec "Dashboards are edited directly, not only by conversation").
 *
 * Preview slot (task 4.4): `renderOptionPreview` below fills Unit 1's seam by
 * rendering `renderCatalogWidgetPreview` — THE SAME `CatalogWidget` component
 * `DashboardGrid`/`DashboardEditor` render, on synthetic sample data, keyed
 * by the option's own catalog `widgetType` (spec "Previews reflect the
 * rendered result").
 */
export function AiV2Panel({ sessionId, persistence = localStorageDashboardPersistence }: Props) {
  const [messages, setMessages] = useState<AiV2Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const [pendingQuestion, setPendingQuestion] = useState<AiV2PendingQuestion | null>(null);

  // Controlled "start a turn from the canvas" seam — set once by the empty
  // state's CTA, consumed exactly once by AiV2Design.
  const [pendingStart, setPendingStart] = useState<string | null>(null);

  const [dashboardConfig, setDashboardConfig] = useState<DashboardConfig | null>(null);
  const [dashboardLoaded, setDashboardLoaded] = useState(false);
  const [editingDashboard, setEditingDashboard] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDashboardLoaded(false);
    void persistence.load(sessionId).then((loaded) => {
      if (cancelled) return;
      setDashboardConfig(loaded);
      setDashboardLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId, persistence]);

  function handleDashboardChange(next: DashboardConfig) {
    setDashboardConfig(next);
    // Persisted through the boundary — NEVER through a design turn. Fire-
    // and-forget: the mocked boundary is synchronous-fast (localStorage);
    // Phase 5's real endpoint owns retry/error surfacing for its own wire
    // contract, out of this task's scope.
    void persistence.save(sessionId, next);
  }

  function startBlank() {
    setDashboardConfig(EMPTY_DASHBOARD);
    setEditingDashboard(true);
    void persistence.save(sessionId, EMPTY_DASHBOARD);
  }

  const hasActivity = messages.length > 0 || isStreaming || pendingQuestion !== null;

  return (
    <div className="flex flex-1 min-h-0 gap-3" data-testid="aiv2-panel">
      <section
        className="flex flex-1 min-w-0 flex-col gap-3 rounded-v5-lg border border-v5-border glass-face p-4"
        aria-label="Dashboard canvas"
        data-testid="aiv2-canvas-seam"
      >
        {!dashboardLoaded ? null : dashboardConfig ? (
          <>
            <div className="flex shrink-0 items-center gap-2">
              <h2 className="m-0 text-sm font-semibold text-v5-text">Session overview</h2>
              <span className="ml-auto" />
              {editingDashboard ? (
                <button
                  type="button"
                  className={clsx(FEED_GLASS_BTN, FEED_GLASS_BTN_PRIMARY)}
                  data-testid="aiv2-dashboard-done"
                  onClick={() => setEditingDashboard(false)}
                >
                  Done
                </button>
              ) : (
                <button
                  type="button"
                  className={FEED_GLASS_BTN}
                  data-testid="aiv2-dashboard-edit"
                  onClick={() => setEditingDashboard(true)}
                >
                  Edit
                </button>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {editingDashboard ? (
                <DashboardEditor config={dashboardConfig} onChange={handleDashboardChange} />
              ) : (
                <DashboardGrid
                  widgets={dashboardConfig.widgets}
                  interactions={dashboardConfig.interactions}
                  widgetData={{}}
                />
              )}
            </div>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
            {hasActivity ? (
              <p className="m-0 max-w-[40ch] text-sm text-v5-muted">
                The dashboard renders here once the design turn finishes. The design conversation on
                the right keeps running independently of this placeholder.
              </p>
            ) : (
              <>
                <h2 className="m-0 text-base font-semibold text-v5-text">
                  No dashboard for this session yet
                </h2>
                <p className="m-0 max-w-[36ch] text-sm text-v5-muted">
                  A dashboard turns this session's transcript, topics, and events into a visual
                  record. Design one with AI, or start from a blank grid.
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className={clsx(FEED_GLASS_BTN, FEED_GLASS_BTN_PRIMARY)}
                    onClick={() => setPendingStart(STARTER_MESSAGE)}
                  >
                    Design with AI
                  </button>
                  <button
                    type="button"
                    className={FEED_GLASS_BTN}
                    data-testid="aiv2-start-blank"
                    onClick={startBlank}
                  >
                    Start blank
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </section>

      <aside
        className="flex w-[22.5rem] max-w-full flex-col rounded-v5-lg border border-v5-border glass-face"
        aria-label="Design conversation"
      >
        <AiV2Design
          sessionId={sessionId}
          messages={messages}
          onMessagesChange={setMessages}
          isStreaming={isStreaming}
          onStreamingChange={setIsStreaming}
          abortControllerRef={abortControllerRef}
          pendingQuestion={pendingQuestion}
          onPendingQuestionChange={setPendingQuestion}
          pendingStart={pendingStart}
          onPendingStartConsumed={() => setPendingStart(null)}
          renderOptionPreview={(widgetType, option) =>
            widgetType ? renderCatalogWidgetPreview(widgetType, option.label) : null
          }
        />
      </aside>
    </div>
  );
}
