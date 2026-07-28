import clsx from 'clsx';
import { type MutableRefObject, useState } from 'react';
import { FEED_GLASS_BTN, FEED_GLASS_BTN_PRIMARY } from './FeedTable';

// Shared SSE-turn machinery for the two AI rails (AiChat.tsx and
// AiV2Design.tsx), consolidated from their formerly duplicated copies
// (code-health-tail task 4.1, finding 2.1, design D5). The hook owns exactly
// the transport mechanics both rails shared verbatim: the POST + ReadableStream
// reader/decoder buffering over `parseSseFrames`, the delta-append reducer
// (merge into the trailing assistant message), abort-vs-connection-lost
// classification (per-path `connectionLostDetail` string), and the
// notConfigured-503 explainer branch. Everything vocabulary-specific stays with
// the caller as an event-handler map (`events`): chat-only `tool`, design-only
// `question`/`dashboard`, and the per-path `done`/`error` bodies. This is
// client-internal consolidation only — the SSE frames consumed, the request
// shapes sent, and the rendered DOM are unchanged.
//
// `SseTurnComposer` below is the byte-identical textarea + Stop/Send footer
// both rails render; its one variation point is a plain `placeholder` string
// computed by the caller.

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
 * (Moved here from AiChat.tsx by task 4.1; AiChat re-exports it for existing
 * importers.)
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

export async function extractErrorDetail(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: unknown };
    if (typeof body.detail === 'string' && body.detail.trim()) return body.detail;
  } catch {
    // Non-JSON or empty body — fall back below.
  }
  return fallback;
}

/** The message variants the hook itself produces. Each rail's own message
 * union (ChatMessage, AiV2Message) is structurally these three plus any
 * rail-specific extras (chat's `tool` chip), supplied as the `Extra` type
 * parameter below. */
export type SseTurnMessage =
  | { id: string; role: 'user'; text: string }
  | { id: string; role: 'assistant'; text: string }
  | { id: string; role: 'error'; detail: string };

function isAssistantMessage(m: {
  role: string;
}): m is { id: string; role: 'assistant'; text: string } {
  return m.role === 'assistant';
}

export interface UseSseTurnOptions<Extra extends { id: string; role: string } = never> {
  /** Absolute endpoint the turn POSTs to (caller computes it from API_ROOT +
   * sessionId). */
  url: string;
  /** Builds the JSON request body for one turn's message text (chat threads
   * its `claude_session_id` through here). */
  buildRequestBody: (text: string) => Record<string, unknown>;
  /** Per-path message pushed when the stream dies without a terminal event
   * and without a user-initiated abort. */
  connectionLostDetail: string;
  /** Per-path fallback detail for a non-503 non-ok HTTP response. */
  requestFailedDetail: (status: number) => string;
  isStreaming: boolean;
  onMessagesChange: (
    updater: (prev: (SseTurnMessage | Extra)[]) => (SseTurnMessage | Extra)[],
  ) => void;
  onStreamingChange: (streaming: boolean) => void;
  abortControllerRef: MutableRefObject<AbortController | null>;
  /** Runs once per accepted send, after the user message is pushed and before
   * the fetch (AiV2Design clears its pending question here). */
  onTurnStart?: () => void;
  /**
   * The caller's SSE event vocabulary beyond `delta` (which the hook owns as
   * the delta-append reducer). Handlers receive the frame's JSON-parsed data
   * (`undefined` when unparseable). Frame types with no handler are ignored
   * outright (additive-open wire contract — "Client ignores unknown event
   * types").
   */
  events: Record<string, (payload: unknown) => void>;
}

export function useSseTurn<Extra extends { id: string; role: string } = never>({
  url,
  buildRequestBody,
  connectionLostDetail,
  requestFailedDetail,
  isStreaming,
  onMessagesChange,
  onStreamingChange,
  abortControllerRef,
  onTurnStart,
  events,
}: UseSseTurnOptions<Extra>) {
  const [input, setInput] = useState('');
  const [notConfigured, setNotConfigured] = useState(false);

  async function sendMessage(rawText: string) {
    const text = rawText.trim();
    if (!text || isStreaming) return;

    setInput('');
    // Reset unconditionally at send start: AiV2Design's external
    // `pendingStart` seam can trigger a new turn while the explainer is
    // showing (its pre-consolidation behavior); for AiChat this is
    // unobservable — its only send paths live in the composer, which is
    // unmounted while the explainer shows.
    setNotConfigured(false);
    onMessagesChange((prev) => [...prev, { id: crypto.randomUUID(), role: 'user', text }]);
    onTurnStart?.();

    const controller = new AbortController();
    abortControllerRef.current = controller;
    onStreamingChange(true);

    try {
      const res = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildRequestBody(text)),
        signal: controller.signal,
      });

      // 503 means the deployment isn't configured for this AI surface — a
      // distinct, in-place explainer rendered by the caller, not the generic
      // error path below (spec "Unconfigured chat is explained in place" /
      // "Configuration-gated AI v2 endpoints").
      if (res.status === 503) {
        setNotConfigured(true);
        return;
      }

      if (!res.ok || !res.body) {
        const detail = await extractErrorDetail(res, requestFailedDetail(res.status));
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
              if (last !== undefined && isAssistantMessage(last)) {
                return [
                  ...prev.slice(0, -1),
                  { id: last.id, role: 'assistant', text: last.text + delta },
                ];
              }
              return [...prev, { id: crypto.randomUUID(), role: 'assistant', text: delta }];
            });
          } else {
            const handler = events[frame.event];
            if (handler) handler(safeJsonParse(frame.data));
            // Any other event type is ignored outright (spec "Client ignores
            // unknown event types" — forward compatibility with new SSE types).
          }
        }
      }
    } catch {
      if (controller.signal.aborted) {
        // Stop was clicked: the server terminates the subprocess best-effort
        // and — per spec — a client-aborted stream is NOT guaranteed a
        // terminal event. Don't wait for one and don't render this as a
        // failure; `isStreaming` flipping back to false (below) is the
        // stopped-state UI signal.
      } else {
        onMessagesChange((prev) => [
          ...prev,
          { id: crypto.randomUUID(), role: 'error', detail: connectionLostDetail },
        ]);
      }
    } finally {
      onStreamingChange(false);
      abortControllerRef.current = null;
    }
  }

  function stop() {
    abortControllerRef.current?.abort();
  }

  return { input, setInput, notConfigured, sendMessage, stop };
}

export interface SseTurnComposerProps {
  input: string;
  onInputChange: (value: string) => void;
  /** Plain string computed by the caller (AiV2Design derives it from
   * `messages.length`/`pendingQuestion` at its call site) — the footer's one
   * variation point (design D5: not a function slot). */
  placeholder: string;
  isStreaming: boolean;
  onSend: () => void;
  onStop: () => void;
}

/** The textarea + Stop/Send footer both AI rails render — byte-identical DOM
 * to the two pre-consolidation copies. */
export function SseTurnComposer({
  input,
  onInputChange,
  placeholder,
  isStreaming,
  onSend,
  onStop,
}: SseTurnComposerProps) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSend();
      }}
      className="flex shrink-0 items-end gap-2 border-t border-v5-border p-3"
    >
      <textarea
        className="flex-1 resize-none rounded-v5-sm border border-v5-border bg-transparent px-3 py-2 text-sm text-v5-text [font-family:inherit] focus:border-[rgba(56,189,248,0.5)] focus:outline-none"
        rows={2}
        value={input}
        placeholder={placeholder}
        disabled={isStreaming}
        onChange={(e) => onInputChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            onSend();
          }
        }}
      />
      {isStreaming ? (
        <button type="button" className={FEED_GLASS_BTN} onClick={onStop}>
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
  );
}
