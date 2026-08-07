import { useQueryClient } from '@tanstack/react-query';
import { type MutableRefObject, useEffect, useRef } from 'react';
import { API_ROOT } from '../../../api/client';
import { topicsQueryKey } from '../../../api/hooks/useTopics';
import { SseTurnComposer, useSseTurn } from './useSseTurn';

// Real SSE-driven Chat subtab (ai-topics-chat, task 4.2; design D9; spec "AI
// tab and subtab arrangement" + "Ephemeral chat history"). Task 4.1 hoisted
// the conversation state, the echoed `claude_session_id`, the streaming flag,
// and the AbortController ref up to `AiPanel` (so a subtab/top-tab switch
// never unmounts this component and never aborts an in-flight turn); this
// file consumes that seam via controlled props rather than owning parallel
// local state for the conversation itself. Everything below is genuinely
// ephemeral — there is no localStorage/sessionStorage write anywhere in this
// file, so a page refresh clears the conversation (spec "Refresh clears the
// conversation").
//
// The server's real SSE surface (apply ledger, Phase 3): `delta{text}`,
// `tool{name}` (short name, `mcp__autologger__` already stripped server-side),
// `done{claude_session_id}`, `error{detail}` — additive-open, so any other
// event type (and any `:`-prefixed comment/keepalive line) is silently
// ignored here rather than erroring (spec "Client ignores unknown event
// types"). `fetch` + a ReadableStream reader is used instead of `EventSource`
// because `EventSource` cannot POST a request body — that transport now lives
// in the shared `useSseTurn` hook (code-health-tail task 4.1); this file
// supplies only the chat vocabulary (`tool`, and the `done`/`error` bodies).

// `parseSseFrames` moved to useSseTurn.tsx (code-health-tail task 4.1);
// re-exported here for existing importers.
export { parseSseFrames } from './useSseTurn';

export type ChatMessage =
  | { id: string; role: 'user'; text: string }
  | { id: string; role: 'assistant'; text: string }
  | { id: string; role: 'tool'; name: string }
  | { id: string; role: 'error'; detail: string };

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

const CONNECTION_LOST_DETAIL = 'Connection to AI chat was lost before the turn finished.';

export function AiChat({
  sessionId,
  messages,
  onMessagesChange,
  claudeSessionId,
  onClaudeSessionIdChange,
  isStreaming,
  onStreamingChange,
  abortControllerRef,
}: AiChatProps) {
  const queryClient = useQueryClient();
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const { input, setInput, notConfigured, sendMessage, stop } = useSseTurn<
    Extract<ChatMessage, { role: 'tool' }>
  >({
    url: `${API_ROOT}/sessions/${sessionId}/ai/chat`,
    buildRequestBody: (text) => ({
      message: text,
      ...(claudeSessionId ? { claude_session_id: claudeSessionId } : {}),
    }),
    connectionLostDetail: CONNECTION_LOST_DETAIL,
    requestFailedDetail: (status) => `AI chat request failed (${status}).`,
    isStreaming,
    onMessagesChange,
    onStreamingChange,
    abortControllerRef,
    events: {
      tool: (payload) => {
        const p = payload as { name?: unknown } | undefined;
        if (!p || typeof p.name !== 'string') return;
        const name = p.name;
        onMessagesChange((prev) => [...prev, { id: crypto.randomUUID(), role: 'tool', name }]);
        // Topics have no WS emission (design D9/D3) — this client-side
        // invalidation on the chatting client is the only liveness
        // mechanism for AI-created rows (spec "AI-created topics appear
        // during the turn").
        if (name === 'create_topic') {
          queryClient.invalidateQueries({ queryKey: topicsQueryKey(sessionId) });
        }
      },
      done: (payload) => {
        const p = payload as { claude_session_id?: unknown } | undefined;
        const id = p?.claude_session_id;
        // Always echo the LATEST done's id (spec "Ephemeral chat
        // history"): a later turn on this same conversation overwrites
        // whatever id an earlier turn issued.
        if (typeof id === 'string' && id) onClaudeSessionIdChange(id);
      },
      error: (payload) => {
        const p = payload as { detail?: unknown } | undefined;
        const detail = typeof p?.detail === 'string' ? p.detail : 'AI chat failed.';
        onMessagesChange((prev) => [...prev, { id: crypto.randomUUID(), role: 'error', detail }]);
      },
    },
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: keep the transcript pinned to the newest message as it grows
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  return (
    <div className="flex flex-1 flex-col min-h-0" data-testid="ai-chat-panel">
      {notConfigured ? (
        <div
          className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-v5-muted"
          data-testid="ai-chat-not-configured"
        >
          <p className="m-0 text-sm">
            Assistant isn't configured on this deployment. Ask an operator to set{' '}
            <code>CLAUDE_CLI_PATH</code> to the <code>claude</code> CLI to enable it.
          </p>
        </div>
      ) : (
        <>
          <div
            ref={scrollRef}
            className="flex flex-1 flex-col gap-2 overflow-y-auto px-4 pt-2 pb-4 min-h-0"
            aria-live="polite"
            data-testid="ai-chat-transcript"
          >
            {messages.length === 0 && (
              <p className="m-0 text-sm text-v5-muted">
                Ask about this session's transcript, or ask the assistant to create topics.
              </p>
            )}
            {messages.map((message) => (
              <ChatMessageRow key={message.id} message={message} />
            ))}
          </div>
          <SseTurnComposer
            input={input}
            onInputChange={setInput}
            placeholder="Message the AI assistant…"
            isStreaming={isStreaming}
            onSend={() => void sendMessage(input)}
            onStop={stop}
          />
        </>
      )}
    </div>
  );
}

function ChatMessageRow({ message }: { message: ChatMessage }) {
  if (message.role === 'tool') {
    return (
      <div
        className="self-start rounded-v5-sm border border-v5-border bg-[rgba(255,255,255,0.04)] px-2 py-1 text-[0.72rem] text-v5-muted"
        data-testid="ai-chat-tool-chip"
      >
        Using tool: {message.name}
      </div>
    );
  }
  if (message.role === 'error') {
    return (
      <div className="text-sm text-v5-danger" data-testid="ai-chat-error">
        {message.detail}
      </div>
    );
  }
  return (
    <div className="text-sm text-v5-text">
      <span className="mr-1 font-semibold text-v5-muted">
        {message.role === 'user' ? 'You:' : 'AI:'}
      </span>
      {/* Plain text only — no markdown rendering in v1 (spec "AI tab and
          subtab arrangement"); whitespace-pre-wrap preserves the assistant's
          line breaks/spacing without interpreting any markup. */}
      <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{message.text}</span>
    </div>
  );
}
