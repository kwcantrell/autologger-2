import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { topicsQueryKey } from '../../../api/hooks/useTopics';
import { renderStrict } from '../../../test/renderStrict';
import { AiChat, type ChatMessage, parseSseFrames } from './AiChat';

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
