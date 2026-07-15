import type { MutableRefObject } from 'react';

// Placeholder for the AI chat panel — task 4.2 (design D9) fills in the real
// SSE-driven chat UI (message rendering, Stop control, tool-activity chips,
// 503/error states). Task 4.1 establishes the mount discipline (AiPanel keeps
// this component mounted-hidden across subtab/top-tab switches — see
// SessionWorkspace.tsx and AiPanel.tsx) and the hoisted-state seam below:
// AiPanel owns the ephemeral conversation state and the stream/AbortController
// so a subtab/top-tab switch never unmounts this component and never aborts an
// in-flight turn. 4.2 consumes these props directly; it should not need to
// move where the state lives.

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface AiChatProps {
  sessionId: string;
  messages: ChatMessage[];
  onMessagesChange: (updater: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => void;
  claudeSessionId: string | undefined;
  onClaudeSessionIdChange: (id: string | undefined) => void;
  isStreaming: boolean;
  onStreamingChange: (streaming: boolean) => void;
  abortControllerRef: MutableRefObject<AbortController | null>;
}

export function AiChat(_props: AiChatProps) {
  return (
    <div
      className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-v5-muted"
      data-testid="ai-chat-panel"
    >
      <p className="m-0 text-sm">AI chat is coming soon.</p>
    </div>
  );
}
