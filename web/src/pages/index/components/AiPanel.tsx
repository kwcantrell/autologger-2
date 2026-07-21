import { useRef, useState } from 'react';
import { AiChat, type ChatMessage } from './AiChat';

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
export function AiPanel({ sessionId }: Props) {
  // Hoisted chat state/stream ownership (design D9). This state's shape may
  // grow (e.g. tool-activity events) but its ownership should stay at this
  // level.
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatSessionId, setChatSessionId] = useState<string | undefined>(undefined);
  const [isChatStreaming, setIsChatStreaming] = useState(false);
  const chatAbortControllerRef = useRef<AbortController | null>(null);

  return (
    <div className="flex flex-col flex-1 min-h-0">
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
}
