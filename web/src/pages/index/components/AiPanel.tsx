import { memo, useRef, useState } from 'react';
import { AiChat, type ChatMessage } from './AiChat';
import { FEED_SHEET_CLASS } from './FeedShell';

interface Props {
  sessionId: string;
}

/**
 * Assistant tab (ui-refresh IA, design D5: formerly the "AI" tab with nested
 * Chat | Transcribe | Topics subtabs — Transcript/Topics are session data and
 * now sit beside the Event Feed as top-level tabs in SessionWorkspace, so this
 * panel is the chat surface alone).
 *
 * The chat's ephemeral conversation state + stream/AbortController ownership
 * stay hoisted here (design D9, preserved verbatim by D5) — the parent
 * SessionWorkspace hides this whole panel behind the `hidden` attribute
 * rather than unmounting it, so switching tabs never aborts an in-flight
 * turn or clears the conversation.
 */
// Render-isolation memo (the WorkspaceStatic/TranscribeRow idiom). INVARIANT: every
// prop passed here must stay referentially stable across a SessionWorkspace render —
// today that is `sessionId` alone, memoized into `feedPanels` — or the playback-tick
// (~60/s) render isolation this buys reopens.
export const AiPanel = memo(function AiPanel({ sessionId }: Props) {
  // Hoisted chat state/stream ownership (design D9). This state's shape may
  // grow (e.g. tool-activity events) but its ownership should stay at this
  // level.
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatSessionId, setChatSessionId] = useState<string | undefined>(undefined);
  const [isChatStreaming, setIsChatStreaming] = useState(false);
  const chatAbortControllerRef = useRef<AbortController | null>(null);

  return (
    <div className={FEED_SHEET_CLASS}>
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
  );
});
