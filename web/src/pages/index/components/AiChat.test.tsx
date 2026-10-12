import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { topicsQueryKey } from '../../../api/hooks/useTopics';
import { renderStrict } from '../../../test/renderStrict';
import { AiChat, buildChatHistory, type ChatMessage, parseSseFrames } from './AiChat';

// --- AiChat (ai-topics-chat, task 4.2; design D9; spec "AI tab and subtab
// arrangement" + "Ephemeral chat history") ---
//
// AiChat is a controlled component — messages/claudeSessionId/isStreaming
// live one level up in AiPanel (task 4.1). `Harness` below reproduces that
// wiring with real `useState`/`useRef` (not mocked setters) so these tests
// exercise the real controlled-component contract, not a stand-in. `fetch`
// is stubbed at the global boundary with a hand-rolled ReadableStream reader
// that plays back literal SSE bytes (`event: <type>\ndata: <json>\n\n`,
// matching Hono's `streamSSE` framing verbatim) — the same "fake the wire,
// not the code" idiom the server side uses for its own CLI fixture.

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Builds a fetch Response stand-in whose `body.getReader()` plays back
 * `chunks` one `read()` call at a time, then signals `done`. Deliberately
 * NOT a real `Response`/`ReadableStream` — only the surface AiChat actually
 * touches (`status`, `ok`, `body.getReader()`, `json()`) is implemented, so
 * this works regardless of whether jsdom's environment provides the real
 * Fetch API classes. */
function fakeFetchResponse(chunks: string[], opts: { status?: number } = {}) {
  const status = opts.status ?? 200;
  let index = 0;
  const encoder = new TextEncoder();
  return {
    status,
    ok: status >= 200 && status < 300,
    body: {
      getReader() {
        return {
          read: async () => {
            if (index >= chunks.length) return { done: true, value: undefined };
            const value = encoder.encode(chunks[index]);
            index += 1;
            return { done: false, value };
          },
          cancel: async () => {},
        };
      },
    },
    json: async () => ({}),
  };
}

function fakeJsonErrorResponse(status: number, detail: string) {
  return {
    status,
    ok: false,
    body: null,
    json: async () => ({ detail }),
  };
}

function Harness({ sessionId = 'sess-1' }: { sessionId?: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [claudeSessionId, setClaudeSessionId] = useState<string | undefined>(undefined);
  const [isStreaming, setIsStreaming] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  return (
    <AiChat
      sessionId={sessionId}
      messages={messages}
      onMessagesChange={setMessages}
      claudeSessionId={claudeSessionId}
      onClaudeSessionIdChange={setClaudeSessionId}
      isStreaming={isStreaming}
      onStreamingChange={setIsStreaming}
      abortControllerRef={abortControllerRef}
    />
  );
}

function renderHarness(sessionId = 'sess-1', client?: QueryClient) {
  const qc = client ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = renderStrict(
    <QueryClientProvider client={qc}>
      <Harness sessionId={sessionId} />
    </QueryClientProvider>,
  );
  return { ...result, qc };
}

async function sendViaUi(text: string) {
  const textarea = screen.getByPlaceholderText(/message the ai assistant/i);
  fireEvent.change(textarea, { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: /send/i }));
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseSseFrames', () => {
  it('parses a complete event/data frame', () => {
    const { frames, rest } = parseSseFrames(sseFrame('delta', { text: 'hi' }));
    expect(frames).toEqual([{ event: 'delta', data: JSON.stringify({ text: 'hi' }) }]);
    expect(rest).toBe('');
  });

  it('ignores `:`-prefixed comment/keepalive lines', () => {
    const { frames } = parseSseFrames(': keepalive\n\n');
    expect(frames).toEqual([]);
  });

  it('carries an incomplete trailing frame into `rest` across a chunk boundary', () => {
    const first = parseSseFrames('event: delta\ndata: {"te');
    expect(first.frames).toEqual([]);
    expect(first.rest).toBe('event: delta\ndata: {"te');

    const second = parseSseFrames(`${first.rest}xt":"hi"}\n\n`);
    expect(second.frames).toEqual([{ event: 'delta', data: JSON.stringify({ text: 'hi' }) }]);
    expect(second.rest).toBe('');
  });

  it('ignores unrecognized event types without dropping subsequent frames', () => {
    const buffer = sseFrame('thinking', { blob: 'secret' }) + sseFrame('delta', { text: 'ok' });
    const { frames } = parseSseFrames(buffer);
    // The unknown-type frame is still parsed structurally (the caller decides
    // to ignore it) — the point under test is that it doesn't corrupt parsing
    // of the frame that follows it.
    expect(frames.map((f) => f.event)).toEqual(['thinking', 'delta']);
  });
});

describe('AiChat — streaming deltas', () => {
  it('renders assistant deltas merged in order as they arrive', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      fakeFetchResponse([
        sseFrame('delta', { text: 'Hello ' }),
        sseFrame('delta', { text: 'world' }),
        sseFrame('done', { claude_session_id: 'cs-1' }),
      ]) as unknown as Response,
    );

    renderHarness();
    await sendViaUi('Hi there');

    expect(await screen.findByText('Hi there')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Hello world')).toBeTruthy());

    // Merged into ONE assistant entry, not two separate delta renders.
    const transcript = screen.getByTestId('ai-chat-transcript');
    expect(within(transcript).getAllByText(/Hello world/)).toHaveLength(1);
  });

  it('splits a delta frame across two read() chunks and still renders it whole', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      fakeFetchResponse([
        'event: delta\ndata: {"te',
        'xt":"chunked"}\n\n',
        sseFrame('done', { claude_session_id: 'cs-1' }),
      ]) as unknown as Response,
    );

    renderHarness();
    await sendViaUi('go');

    await waitFor(() => expect(screen.getByText('chunked')).toBeTruthy());
  });

  it('ignores unknown event types and comment lines without breaking the stream', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      fakeFetchResponse([
        ': keepalive\n\n',
        sseFrame('thinking', { text: 'should never render' }),
        sseFrame('delta', { text: 'visible' }),
        sseFrame('done', { claude_session_id: 'cs-1' }),
      ]) as unknown as Response,
    );

    renderHarness();
    await sendViaUi('go');

    await waitFor(() => expect(screen.getByText('visible')).toBeTruthy());
    expect(screen.queryByText(/should never render/)).toBeNull();
  });
});

describe('AiChat — create_topic liveness', () => {
  it('invalidates the topics query when a tool event names create_topic', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      fakeFetchResponse([
        sseFrame('tool', { name: 'create_topic' }),
        sseFrame('done', { claude_session_id: 'cs-1' }),
      ]) as unknown as Response,
    );

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const key = topicsQueryKey('sess-1');
    qc.setQueryData(key, { topics: [] });
    expect(qc.getQueryState(key)?.isInvalidated).toBe(false);

    renderHarness('sess-1', qc);
    await sendViaUi('add a topic please');

    await waitFor(() => expect(qc.getQueryState(key)?.isInvalidated).toBe(true));
    const chip = await screen.findByTestId('ai-chat-tool-chip');
    expect(chip.textContent).toContain('create_topic');
  });

  it('does not invalidate topics for other tool names', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      fakeFetchResponse([
        sseFrame('tool', { name: 'list_topics' }),
        sseFrame('done', { claude_session_id: 'cs-1' }),
      ]) as unknown as Response,
    );

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const key = topicsQueryKey('sess-1');
    qc.setQueryData(key, { topics: [] });

    renderHarness('sess-1', qc);
    await sendViaUi('list topics please');

    await screen.findByTestId('ai-chat-tool-chip');
    expect(qc.getQueryState(key)?.isInvalidated).toBe(false);
  });
});

describe('AiChat — multi-turn continuity', () => {
  it('echoes the LATEST done claude_session_id on the next turn', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      fakeFetchResponse([
        sseFrame('done', { claude_session_id: 'cs-turn-1' }),
      ]) as unknown as Response,
    );
    fetchMock.mockResolvedValueOnce(
      fakeFetchResponse([
        sseFrame('done', { claude_session_id: 'cs-turn-2' }),
      ]) as unknown as Response,
    );

    renderHarness();
    await sendViaUi('first turn');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const firstBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(firstBody.claude_session_id).toBeUndefined();

    await sendViaUi('second turn');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const secondBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(secondBody.claude_session_id).toBe('cs-turn-1');
  });
});

describe('AiChat — Stop control', () => {
  it('aborts the in-flight fetch and returns to the idle (Send) state without a terminal event', async () => {
    const fetchMock = vi.mocked(fetch);
    let capturedSignal: AbortSignal | undefined;
    fetchMock.mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          capturedSignal = (init as RequestInit)?.signal ?? undefined;
          capturedSignal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }) as unknown as Promise<Response>,
    );

    renderHarness();
    await sendViaUi('long running turn');

    const stopButton = await screen.findByRole('button', { name: /stop/i });
    expect(capturedSignal?.aborted).toBe(false);

    fireEvent.click(stopButton);

    expect(capturedSignal?.aborted).toBe(true);
    // Stopped state reflected: Send button reappears, no terminal-event wait,
    // and no error is rendered for a user-initiated abort.
    await screen.findByRole('button', { name: /send/i });
    expect(screen.queryByTestId('ai-chat-error')).toBeNull();
  });
});

describe('AiChat — 503 not-configured', () => {
  it('shows the not-configured explainer instead of a generic error', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      fakeJsonErrorResponse(
        503,
        'AI chat is not configured on this deployment.',
      ) as unknown as Response,
    );

    renderHarness();
    await sendViaUi('hello?');

    expect(await screen.findByTestId('ai-chat-not-configured')).toBeTruthy();
    expect(screen.queryByTestId('ai-chat-error')).toBeNull();
  });
});

describe('AiChat — error rendering', () => {
  it('renders a terminal SSE error event', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      fakeFetchResponse([sseFrame('error', { detail: 'upstream-failed' })]) as unknown as Response,
    );

    renderHarness();
    await sendViaUi('hello?');

    const errorEl = await screen.findByTestId('ai-chat-error');
    expect(errorEl.textContent).toContain('upstream-failed');
  });

  it('renders a generic error for a non-503 non-ok HTTP response', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      fakeJsonErrorResponse(409, 'An AI chat turn is already in progress.') as unknown as Response,
    );

    renderHarness();
    await sendViaUi('hello?');

    const errorEl = await screen.findByTestId('ai-chat-error');
    expect(errorEl.textContent).toContain('An AI chat turn is already in progress.');
  });
});

// --- ai-sdk-agent-harness task 8.2 (design D6, D8; ai-topics-chat "AI tab and subtab
// arrangement", "Chat request contract") ---

const NOT_CONFIGURED = 'Add a language model in Settings → Advanced to use the assistant.';
const SAVED_LLM = {
  kind: 'llm',
  provider: 'anthropic',
  base_url: null,
  model: 'claude-sonnet-4-5',
  key_last4: '1234',
  updated_at: '2026-10-12T10:00:00.000Z',
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Routes the chat POST to `chat()` and the providers read to `providers`. */
function routeFetch(chat: () => unknown, providers: () => unknown) {
  const chatBodies: Record<string, unknown>[] = [];
  vi.mocked(fetch).mockImplementation((async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/me/providers')) return jsonResponse(providers());
    if (String(url).endsWith('/ai/chat')) {
      chatBodies.push(JSON.parse(String(init?.body)));
      return chat();
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch);
  return chatBodies;
}

describe('AiChat — not configured points to Settings → Advanced (ai-sdk-agent-harness D8)', () => {
  it('reads the new copy and names no server setting', async () => {
    routeFetch(
      () => fakeJsonErrorResponse(503, NOT_CONFIGURED),
      () => ({ llm: null, stt: null, run_features_allowed: true, claude_cli_allowed: false }),
    );
    renderHarness();
    await sendViaUi('hello?');
    const state = await screen.findByTestId('ai-chat-not-configured');
    expect(state.textContent).toContain(NOT_CONFIGURED);
    expect(state.textContent).not.toMatch(/CLAUDE_CLI_PATH|operator|deployment|reload/i);
  });

  it('saving a language model clears the state without a reload', async () => {
    let llm: unknown = null;
    routeFetch(
      () => fakeJsonErrorResponse(503, NOT_CONFIGURED),
      () => ({ llm, stt: null, run_features_allowed: true, claude_cli_allowed: false }),
    );
    const { qc } = renderHarness();
    await sendViaUi('hello?');
    await screen.findByTestId('ai-chat-not-configured');
    // Settings › Advanced saves a language model; its save invalidates the providers query.
    await waitFor(() => expect(qc.getQueryData(['providers'])).toBeTruthy());
    llm = SAVED_LLM;
    await qc.invalidateQueries({ queryKey: ['providers'] });
    await waitFor(() => expect(screen.queryByTestId('ai-chat-not-configured')).toBeNull());
    expect(screen.getByPlaceholderText(/message the ai assistant/i)).toBeTruthy();
  });

  it('a latch while a language model is already saved does not clear itself', async () => {
    routeFetch(
      () => fakeJsonErrorResponse(503, NOT_CONFIGURED),
      () => ({ llm: SAVED_LLM, stt: null, run_features_allowed: true, claude_cli_allowed: false }),
    );
    const { qc } = renderHarness();
    await sendViaUi('hello?');
    await screen.findByTestId('ai-chat-not-configured');
    await waitFor(() => expect(qc.getQueryData(['providers'])).toBeTruthy());
    await qc.invalidateQueries({ queryKey: ['providers'] });
    expect(screen.getByTestId('ai-chat-not-configured')).toBeTruthy();
  });
});

describe('AiChat — history (ai-sdk-agent-harness D6)', () => {
  it('posts the earlier user and assistant messages, excluding error rows and tool chips', async () => {
    let turn = 0;
    const bodies = routeFetch(
      () => {
        turn += 1;
        if (turn === 1)
          return fakeFetchResponse([
            sseFrame('tool', { name: 'list_topics' }),
            sseFrame('delta', { text: 'First reply' }),
            sseFrame('done', { claude_session_id: null }),
          ]);
        if (turn === 2)
          return fakeFetchResponse([sseFrame('error', { detail: 'upstream-failed' })]);
        return fakeFetchResponse([sseFrame('done', { claude_session_id: null })]);
      },
      () => ({ llm: null, stt: null, run_features_allowed: true, claude_cli_allowed: false }),
    );
    renderHarness();
    await sendViaUi('first turn');
    await screen.findByText('First reply');
    await screen.findByRole('button', { name: /send/i });
    await sendViaUi('second turn');
    await screen.findByTestId('ai-chat-error');
    await screen.findByRole('button', { name: /send/i });
    await sendViaUi('third turn');
    await waitFor(() => expect(bodies).toHaveLength(3));

    expect(bodies[0]?.history).toBeUndefined();
    expect(bodies[1]?.history).toEqual([
      { role: 'user', text: 'first turn' },
      { role: 'assistant', text: 'First reply' },
    ]);
    expect(bodies[2]?.history).toEqual([
      { role: 'user', text: 'first turn' },
      { role: 'assistant', text: 'First reply' },
      { role: 'user', text: 'second turn' },
    ]);
    // A null done id is never echoed.
    expect(bodies[2]?.claude_session_id).toBeUndefined();
    expect(bodies[2]?.message).toBe('third turn');
  });
});

describe('buildChatHistory — trimmed to the bounds from the oldest end (D6)', () => {
  const user = (i: number, text = `u${i}`): ChatMessage => ({ id: `u${i}`, role: 'user', text });
  const bot = (i: number, text = `a${i}`): ChatMessage => ({
    id: `a${i}`,
    role: 'assistant',
    text,
  });

  it('keeps at most the 40 newest entries, starting on a user entry', () => {
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 25; i += 1) messages.push(user(i), bot(i));
    const history = buildChatHistory(messages);
    expect(history.length).toBeLessThanOrEqual(40);
    expect(history[0]).toEqual({ role: 'user', text: 'u5' });
    expect(history.at(-1)).toEqual({ role: 'assistant', text: 'a24' });
    // An odd cut drops the orphaned assistant entry at the old end.
    const odd = buildChatHistory([bot(0), ...messages.slice(1)]);
    expect(odd[0]?.role).toBe('user');
  });

  it('keeps at most 64 000 characters in total, dropping the oldest entries', () => {
    const big = 'x'.repeat(8000);
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 10; i += 1) messages.push(user(i, big), bot(i, big));
    const history = buildChatHistory(messages);
    expect(history.reduce((n, e) => n + e.text.length, 0)).toBeLessThanOrEqual(64_000);
    expect(history).toHaveLength(8);
    expect(history[0]?.role).toBe('user');
  });

  it('trims each entry, skips blank ones and cuts an entry to 8000 characters', () => {
    const history = buildChatHistory([
      user(0, '  hello  '),
      bot(0, '   '),
      user(1, 'y'.repeat(9000)),
      { id: 't', role: 'tool', name: 'create_topic' },
      { id: 'e', role: 'error', detail: 'nope' },
    ]);
    expect(history).toEqual([
      { role: 'user', text: 'hello' },
      { role: 'user', text: 'y'.repeat(8000) },
    ]);
  });
});
