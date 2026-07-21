import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { type FormEvent, type MutableRefObject, useEffect, useRef, useState } from 'react';
import { API_ROOT } from '../../../api/client';
import { topicsQueryKey } from '../../../api/hooks/useTopics';
import { FEED_GLASS_BTN, FEED_GLASS_BTN_PRIMARY } from './FeedTable';

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
// because `EventSource` cannot POST a request body.

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

interface SseFrame {
  event: string;
  data: string;
}

/**
 * Splits a growing text buffer into complete SSE frames (`event:`/`data:`
 * lines terminated by a blank line), tolerating `:`-prefixed comment/keepalive
 * lines, unknown fields (`id:`, `retry:`, or anything newer), and — the whole
 * point of taking a running `buffer` rather than one chunk at a time — a
 * frame whose bytes are split across two `reader.read()` chunks. Returns the
 * parsed frames plus whatever incomplete tail remains, so a caller does
 * `buffer = rest` and feeds the next chunk in without losing a partial frame.
 * Exported so chunk-boundary and comment/unknown-field handling can be
 * exercised directly, not just observed indirectly through a mocked fetch.
 */
export function parseSseFrames(buffer: string): { frames: SseFrame[]; rest: string } {
  let rest = buffer.replace(/\r\n/g, '\n');
  const frames: SseFrame[] = [];
  let boundary = rest.indexOf('\n\n');
  while (boundary !== -1) {
    const raw = rest.slice(0, boundary);
    rest = rest.slice(boundary + 2);

    let event = 'message';
    const dataLines: string[] = [];
    for (const line of raw.split('\n')) {
      if (line === '' || line.startsWith(':')) continue; // blank filler / comment-keepalive
      if (line.startsWith('event:')) {
        event = line.slice('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).replace(/^ /, ''));
      }
      // Any other field name is tolerated and ignored (additive-open wire
      // contract) — the server does not send `id:`/`retry:` today, but a
      // client that broke on them would be needlessly brittle.
    }
    if (dataLines.length > 0) frames.push({ event, data: dataLines.join('\n') });
    boundary = rest.indexOf('\n\n');
  }
  return { frames, rest };
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

async function extractErrorDetail(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: unknown };
    if (typeof body.detail === 'string' && body.detail.trim()) return body.detail;
  } catch {
    // Non-JSON or empty body — fall back below.
  }
  return fallback;
}

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
  const [input, setInput] = useState('');
  const [notConfigured, setNotConfigured] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: keep the transcript pinned to the newest message as it grows
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  async function sendMessage(rawText: string) {
    const text = rawText.trim();
    if (!text || isStreaming) return;

    setInput('');
    onMessagesChange((prev) => [...prev, { id: crypto.randomUUID(), role: 'user', text }]);

    const controller = new AbortController();
    abortControllerRef.current = controller;
    onStreamingChange(true);

    try {
      const res = await fetch(`${API_ROOT}/sessions/${sessionId}/ai/chat`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          ...(claudeSessionId ? { claude_session_id: claudeSessionId } : {}),
        }),
        signal: controller.signal,
      });

      // Spec "Configuration-gated AI chat endpoint": 503 means the deployment
      // has no CLAUDE_CLI_PATH set. This is a distinct, in-place explainer —
      // not the generic error path below (spec "Unconfigured chat is
      // explained in place").
      if (res.status === 503) {
        setNotConfigured(true);
        return;
      }

      if (!res.ok || !res.body) {
        const detail = await extractErrorDetail(res, `AI chat request failed (${res.status}).`);
        onMessagesChange((prev) => [...prev, { id: crypto.randomUUID(), role: 'error', detail }]);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseFrames(buffer);
        buffer = parsed.rest;

        for (const frame of parsed.frames) {
          if (frame.event === 'delta') {
            const payload = safeJsonParse(frame.data) as { text?: unknown } | undefined;
            if (!payload || typeof payload.text !== 'string') continue;
            const delta = payload.text;
            onMessagesChange((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === 'assistant') {
                return [...prev.slice(0, -1), { ...last, text: last.text + delta }];
              }
              return [...prev, { id: crypto.randomUUID(), role: 'assistant', text: delta }];
            });
          } else if (frame.event === 'tool') {
            const payload = safeJsonParse(frame.data) as { name?: unknown } | undefined;
            if (!payload || typeof payload.name !== 'string') continue;
            const name = payload.name;
            onMessagesChange((prev) => [...prev, { id: crypto.randomUUID(), role: 'tool', name }]);
            // Topics have no WS emission (design D9/D3) — this client-side
            // invalidation on the chatting client is the only liveness
            // mechanism for AI-created rows (spec "AI-created topics appear
            // during the turn").
            if (name === 'create_topic') {
              queryClient.invalidateQueries({ queryKey: topicsQueryKey(sessionId) });
            }
          } else if (frame.event === 'done') {
            const payload = safeJsonParse(frame.data) as
              | { claude_session_id?: unknown }
              | undefined;
            const id = payload?.claude_session_id;
            // Always echo the LATEST done's id (spec "Ephemeral chat
            // history"): a later turn on this same conversation overwrites
            // whatever id an earlier turn issued.
            if (typeof id === 'string' && id) onClaudeSessionIdChange(id);
          } else if (frame.event === 'error') {
            const payload = safeJsonParse(frame.data) as { detail?: unknown } | undefined;
            const detail = typeof payload?.detail === 'string' ? payload.detail : 'AI chat failed.';
            onMessagesChange((prev) => [
              ...prev,
              { id: crypto.randomUUID(), role: 'error', detail },
            ]);
          }
          // Any other event type is ignored outright (spec "Client ignores
          // unknown event types" — forward compatibility with new SSE types).
        }
      }
    } catch (err) {
      if (controller.signal.aborted) {
        // Stop was clicked: the server terminates the subprocess best-effort
        // and — per spec — a client-aborted stream is NOT guaranteed a
        // terminal event. Don't wait for one and don't render this as a
        // failure; `isStreaming` flipping back to false (below) is the
        // stopped-state UI signal.
      } else {
        onMessagesChange((prev) => [
          ...prev,
          { id: crypto.randomUUID(), role: 'error', detail: CONNECTION_LOST_DETAIL },
        ]);
      }
    } finally {
      onStreamingChange(false);
      abortControllerRef.current = null;
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    void sendMessage(input);
  }

  function handleStop() {
    abortControllerRef.current?.abort();
  }

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
            className="flex flex-1 flex-col gap-2 overflow-y-auto p-4 min-h-0"
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
          <form
            onSubmit={handleSubmit}
            className="flex shrink-0 items-end gap-2 border-t border-v5-border p-3"
          >
            <textarea
              className="flex-1 resize-none rounded-v5-sm border border-v5-border bg-transparent px-3 py-2 text-sm text-v5-text [font-family:inherit] focus:border-[rgba(56,189,248,0.5)] focus:outline-none"
              rows={2}
              value={input}
              placeholder="Message the AI assistant…"
              disabled={isStreaming}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void sendMessage(input);
                }
              }}
            />
            {isStreaming ? (
              <button type="button" className={FEED_GLASS_BTN} onClick={handleStop}>
                Stop
              </button>
            ) : (
              <button
                type="submit"
                className={clsx(FEED_GLASS_BTN, FEED_GLASS_BTN_PRIMARY)}
                disabled={!input.trim()}
              >
                Send
              </button>
            )}
          </form>
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
