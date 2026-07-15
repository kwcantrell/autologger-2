import clsx from 'clsx';
import { useRef, useState } from 'react';
import { AiChat, type ChatMessage } from './AiChat';
import { feedTabButtonClassName } from './feedTabStyles';
import { TopicsFeed } from './TopicsFeed';
import { TranscribeFeed } from './TranscribeFeed';

type AiSubTab = 'chat' | 'transcribe' | 'topics';

interface Props {
  sessionId: string;
}

const AI_SUBTABS: ReadonlyArray<{ id: AiSubTab; label: string }> = [
  { id: 'chat', label: 'Chat' },
  { id: 'transcribe', label: 'Transcribe' },
  { id: 'topics', label: 'Topics' },
];

/**
 * AI tab (design D9): nested Chat | Transcribe | Topics subtabs, defaulting
 * to Chat. All three subtab panels stay mounted (hidden via the `hidden`
 * attribute) rather than conditionally rendered, and the chat's ephemeral
 * conversation state + stream/AbortController ownership are hoisted to this
 * component — the seam task 4.2 fills in on `AiChat` — so switching subtabs
 * (or the parent SessionWorkspace hiding this whole panel behind the Event
 * Feed tab) never unmounts the Chat panel, never aborts an in-flight turn,
 * and never clears the conversation.
 */
export function AiPanel({ sessionId }: Props) {
  const [aiTab, setAiTab] = useState<AiSubTab>('chat');

  // Hoisted chat state/stream ownership (design D9). Task 4.2 fills in the
  // real SSE-driven `AiChat` against this seam; this state's shape may grow
  // (e.g. tool-activity events) but its ownership should stay at this level.
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatSessionId, setChatSessionId] = useState<string | undefined>(undefined);
  const [isChatStreaming, setIsChatStreaming] = useState(false);
  const chatAbortControllerRef = useRef<AbortController | null>(null);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div
        className="flex shrink-0 items-end gap-[0.18rem] mx-4 -mb-px px-[0.65rem] pt-[0.45rem] relative z-[2]"
        role="tablist"
        aria-label="AI tabs"
      >
        {AI_SUBTABS.map((tab) => {
          const active = aiTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              className={feedTabButtonClassName(active)}
              onClick={() => setAiTab(tab.id)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Mounted-hidden (design D9): every subtab panel renders unconditionally
          and only the `hidden` attribute toggles, so switching subtabs never
          unmounts Chat's in-flight stream, and Transcribe/Topics keep their
          own data-fetch state warm across switches too. */}
      <div
        className={clsx('flex flex-col flex-1 min-h-0', aiTab !== 'chat' && 'hidden')}
        hidden={aiTab !== 'chat'}
        role="tabpanel"
        aria-label="Chat"
      >
        <AiChat
          sessionId={sessionId}
          messages={chatMessages}
          onMessagesChange={setChatMessages}
          claudeSessionId={chatSessionId}
          onClaudeSessionIdChange={setChatSessionId}
          isStreaming={isChatStreaming}
          onStreamingChange={setIsChatStreaming}
          abortControllerRef={chatAbortControllerRef}
        />
      </div>
      <div
        className={clsx('flex flex-col flex-1 min-h-0', aiTab !== 'transcribe' && 'hidden')}
        hidden={aiTab !== 'transcribe'}
        role="tabpanel"
        aria-label="Transcribe"
      >
        <TranscribeFeed sessionId={sessionId} />
      </div>
      <div
        className={clsx('flex flex-col flex-1 min-h-0', aiTab !== 'topics' && 'hidden')}
        hidden={aiTab !== 'topics'}
        role="tabpanel"
        aria-label="Topics"
      >
        <TopicsFeed sessionId={sessionId} />
      </div>
    </div>
  );
}
