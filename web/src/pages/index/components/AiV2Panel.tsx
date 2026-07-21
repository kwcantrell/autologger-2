import clsx from 'clsx';
import { useRef, useState } from 'react';
import { AiV2Design, type AiV2Message, type AiV2PendingQuestion } from './AiV2Design';
import { FEED_GLASS_BTN, FEED_GLASS_BTN_PRIMARY } from './FeedTable';

interface Props {
  sessionId: string;
}

const STARTER_MESSAGE =
  'Give me a starting dashboard for this session: who talked, what about, and where the activity was.';

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
 * Canvas seam (Unit 2, tasks 4.3-4.7): the dashboard grid, direct-manipulation
 * editing, catalog picker, and degraded-state rendering all land in the
 * `data-testid="aiv2-canvas-seam"` region below. This unit builds only the
 * shell (canvas region + docked rail, per the mockup) plus the "Design with
 * AI" entry point (design D7a: agent proposes, user adjusts) so the tab is
 * usable end-to-end before the grid exists — the other D7a entry point,
 * "Start blank", needs the editing grid itself and is Unit 2's to add
 * alongside it rather than a non-functional stub here.
 */
export function AiV2Panel({ sessionId }: Props) {
  const [messages, setMessages] = useState<AiV2Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const [pendingQuestion, setPendingQuestion] = useState<AiV2PendingQuestion | null>(null);

  // Controlled "start a turn from the canvas" seam — set once by the empty
  // state's CTA, consumed exactly once by AiV2Design.
  const [pendingStart, setPendingStart] = useState<string | null>(null);

  const hasActivity = messages.length > 0 || isStreaming || pendingQuestion !== null;

  return (
    <div className="flex flex-1 min-h-0 gap-3" data-testid="aiv2-panel">
      <section
        className="flex flex-1 min-w-0 flex-col items-center justify-center gap-3 rounded-v5-lg border border-v5-border glass-face p-8 text-center"
        aria-label="Dashboard canvas"
        data-testid="aiv2-canvas-seam"
      >
        {hasActivity ? (
          <p className="m-0 max-w-[40ch] text-sm text-v5-muted">
            The dashboard grid renders here once it ships. The design conversation on the right
            keeps running independently of this placeholder.
          </p>
        ) : (
          <>
            <h2 className="m-0 text-base font-semibold text-v5-text">
              No dashboard for this session yet
            </h2>
            <p className="m-0 max-w-[36ch] text-sm text-v5-muted">
              A dashboard turns this session's transcript, topics, and events into a visual record.
              Design one with AI to get a starting layout.
            </p>
            <button
              type="button"
              className={clsx(FEED_GLASS_BTN, FEED_GLASS_BTN_PRIMARY)}
              onClick={() => setPendingStart(STARTER_MESSAGE)}
            >
              Design with AI
            </button>
          </>
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
        />
      </aside>
    </div>
  );
}
