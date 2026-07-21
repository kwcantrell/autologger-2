import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import { AiV2Design, type AiV2Message, type AiV2PendingQuestion } from './AiV2Design';
import { DashboardEditor } from './aiV2/DashboardEditor';
import { DashboardGrid } from './aiV2/DashboardGrid';
import {
  type DashboardPersistencePort,
  fetchDashboardPersistence,
} from './aiV2/dashboardPersistence';
import { renderCatalogWidgetPreview } from './aiV2/widgetRegistry';
import type { DashboardConfig } from './aiV2/widgetTypes';
import { FEED_GLASS_BTN, FEED_GLASS_BTN_PRIMARY } from './FeedTable';

interface Props {
  sessionId: string;
  /** DI seam for tests — defaults to the real `fetch`-backed boundary (task
   * 5.2, dashboardPersistence.ts), which calls
   * `/api/sessions/:sessionId/ai/v2/dashboard`. Tests inject a fake port here
   * instead of mocking `fetch` at the network boundary. */
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
 * boundary (`aiV2/dashboardPersistence.ts` — the real `fetch`-backed
 * `DashboardPersistencePort` as of task 5.2, calling
 * `/api/sessions/:sessionId/ai/v2/dashboard`). Two entry points create it
 * (design D7a): "Design with AI" kicks off a design turn via `AiV2Design`
 * (unchanged from task 4.1/4.2 — this component still doesn't assemble a
 * design turn's output into a `DashboardConfig`, since no wiring for that
 * exists yet and it is outside this task's scope); "Start blank" creates an
 * EMPTY `DashboardConfig` directly and drops straight into edit mode, per
 * this task's brief. Every subsequent add/remove/resize/reposition/retitle
 * goes through `DashboardEditor`, which calls `onChange` here — this
 * component persists that value via `persistence.save` and NEVER runs a
 * design turn to do so (spec "Dashboards are edited directly, not only by
 * conversation"). A save/load failure (a rejected `DashboardPersistencePort`
 * call — e.g. a 422 over a persistence bound, or a network error) is
 * surfaced as an inline banner (`dashboardError` below, task 5.2: "Surface
 * save errors in the UI") rather than failing silently — the prior fire-
 * and-forget shape (Phase 4) had no error path at all.
 *
 * Preview slot (task 4.4): `renderOptionPreview` below fills Unit 1's seam by
 * rendering `renderCatalogWidgetPreview` — THE SAME `CatalogWidget` component
 * `DashboardGrid`/`DashboardEditor` render, on synthetic sample data, keyed
 * by the option's own catalog `widgetType` (spec "Previews reflect the
 * rendered result").
 */
export function AiV2Panel({ sessionId, persistence = fetchDashboardPersistence }: Props) {
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
  // Task 5.5 (design D10): a design turn's proposed dashboard, received on
  // the `dashboard` SSE event — distinct from `dashboardConfig` (the SAVED
  // dashboard) until the user explicitly keeps it. Rendered through the same
  // `DashboardGrid`/`CatalogWidget` components a saved dashboard uses (spec
  // "No agent-authored markup is ever rendered" — there is no separate
  // "proposal renderer"), with a Keep/Discard offer rather than an automatic
  // save (spec "A design turn seeds rather than replaces": the agent's
  // output is a starting point the user then adjusts or accepts).
  const [proposedDashboard, setProposedDashboard] = useState<DashboardConfig | null>(null);
  // Task 5.2: "Surface save errors in the UI" — the Phase 4 boundary was
  // fire-and-forget with no error path at all. Covers BOTH the initial load
  // and every subsequent save; cleared on the next successful save so a
  // resolved error doesn't linger.
  const [dashboardError, setDashboardError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDashboardLoaded(false);
    setDashboardError(null);
    persistence
      .load(sessionId)
      .then((loaded) => {
        if (cancelled) return;
        setDashboardConfig(loaded);
        setDashboardLoaded(true);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Fail open: show the empty/no-dashboard state rather than an
        // infinite loading spinner, alongside the error banner.
        setDashboardLoaded(true);
        setDashboardError(
          err instanceof Error ? err.message : 'Failed to load the saved dashboard.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, persistence]);

  function persistDashboard(next: DashboardConfig) {
    persistence
      .save(sessionId, next)
      .then(() => setDashboardError(null))
      .catch((err: unknown) => {
        setDashboardError(err instanceof Error ? err.message : 'Failed to save the dashboard.');
      });
  }

  function handleDashboardChange(next: DashboardConfig) {
    setDashboardConfig(next);
    // Persisted through the boundary — NEVER through a design turn (spec
    // "Dashboards are edited directly, not only by conversation").
    persistDashboard(next);
  }

  function startBlank() {
    setDashboardConfig(EMPTY_DASHBOARD);
    setEditingDashboard(true);
    persistDashboard(EMPTY_DASHBOARD);
  }

  // Task 5.5 (design D10): the agent's proposal is shown immediately (real
  // components, no markup) but is NOT auto-saved — the user explicitly keeps
  // or discards it, matching design D7a ("the agent's job is the first
  // draft... everything after is direct manipulation").
  function keepProposedDashboard() {
    if (!proposedDashboard) return;
    setDashboardConfig(proposedDashboard);
    persistDashboard(proposedDashboard);
    setProposedDashboard(null);
  }

  function discardProposedDashboard() {
    setProposedDashboard(null);
  }

  const hasActivity = messages.length > 0 || isStreaming || pendingQuestion !== null;
  // What the canvas actually shows: a pending proposal takes priority over
  // the saved dashboard until kept or discarded.
  const displayConfig = proposedDashboard ?? dashboardConfig;

  return (
    <div className="flex flex-1 min-h-0 gap-3" data-testid="aiv2-panel">
      <section
        className="flex flex-1 min-w-0 flex-col gap-3 rounded-v5-lg border border-v5-border glass-face p-4"
        aria-label="Dashboard canvas"
        data-testid="aiv2-canvas-seam"
      >
        {dashboardError ? (
          <div
            role="alert"
            data-testid="aiv2-dashboard-error"
            className="shrink-0 rounded-v5-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-[0.8rem] text-red-200"
          >
            {dashboardError}
          </div>
        ) : null}
        {!dashboardLoaded ? null : displayConfig ? (
          <>
            {proposedDashboard ? (
              <div
                className="flex shrink-0 items-center gap-2 rounded-v5-md border border-v5-border-strong glass-face px-3 py-2 text-[0.8rem] text-v5-text"
                data-testid="aiv2-dashboard-proposal-banner"
              >
                <span className="flex-1">
                  Draft — the agent proposed this dashboard. Keep it to save, or discard it.
                </span>
                <button
                  type="button"
                  className={clsx(FEED_GLASS_BTN, FEED_GLASS_BTN_PRIMARY)}
                  data-testid="aiv2-dashboard-keep"
                  onClick={keepProposedDashboard}
                >
                  Keep
                </button>
                <button
                  type="button"
                  className={FEED_GLASS_BTN}
                  data-testid="aiv2-dashboard-discard"
                  onClick={discardProposedDashboard}
                >
                  Discard
                </button>
              </div>
            ) : (
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
            )}
            <div className="min-h-0 flex-1 overflow-y-auto">
              {!proposedDashboard && dashboardConfig && editingDashboard ? (
                <DashboardEditor config={dashboardConfig} onChange={handleDashboardChange} />
              ) : (
                <DashboardGrid
                  widgets={displayConfig.widgets}
                  interactions={displayConfig.interactions}
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
          onDashboardProposed={setProposedDashboard}
        />
      </aside>
    </div>
  );
}
