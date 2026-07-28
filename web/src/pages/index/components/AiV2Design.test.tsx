import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderStrict } from '../../../test/renderStrict';
import {
  AiV2Design,
  type AiV2Message,
  type AiV2PendingQuestion,
  parsePendingQuestion,
} from './AiV2Design';

// --- AiV2Design (ai-v2-dashboards, tasks 4.1/4.2; spec "AI v2 tab in the
// session workspace" + "Design question round trip" + "Previews reflect the
// rendered result") ---
//
// AiV2Design is a controlled component — messages/pendingQuestion/isStreaming
// live one level up in AiV2Panel (task 4.1). `Harness` below reproduces that
// wiring with real `useState`/`useRef` (not mocked setters), same idiom as
// AiChat.test.tsx. `fetch` is stubbed with a hand-rolled ReadableStream
// reader that plays back literal SSE bytes matching Hono's `streamSSE`
// framing verbatim — "fake the wire, not the code".

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

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

function fakeJsonOkResponse(body: unknown = { ok: true }) {
  return {
    status: 200,
    ok: true,
    body: null,
    json: async () => body,
  };
}

function Harness({
  sessionId = 'sess-1',
  onDashboardProposed,
}: {
  sessionId?: string;
  onDashboardProposed?: (config: unknown, turnId: string | null) => void;
}) {
  const [messages, setMessages] = useState<AiV2Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const [pendingQuestion, setPendingQuestion] = useState<AiV2PendingQuestion | null>(null);

  return (
    <AiV2Design
      sessionId={sessionId}
      messages={messages}
      onMessagesChange={setMessages}
      isStreaming={isStreaming}
      onStreamingChange={setIsStreaming}
      abortControllerRef={abortControllerRef}
      pendingQuestion={pendingQuestion}
      onPendingQuestionChange={setPendingQuestion}
      renderOptionPreview={(widgetType) =>
        widgetType ? <span data-testid="preview-stub">{widgetType}</span> : null
      }
      onDashboardProposed={onDashboardProposed}
    />
  );
}

function renderHarness(
  sessionId = 'sess-1',
  onDashboardProposed?: (config: unknown, turnId: string | null) => void,
) {
  return renderStrict(<Harness sessionId={sessionId} onDashboardProposed={onDashboardProposed} />);
}

/** Like `fakeFetchResponse`, but `read()` blocks before delivering the chunk
 * at `gateIndex` until the returned `release()` is called — so a test can
 * assert intermediate UI state (e.g. a pending question) deterministically
 * before the stream's later frames arrive. */
function gatedFakeFetchResponse(chunks: string[], gateIndex: number) {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let index = 0;
  const encoder = new TextEncoder();
  const response = {
    status: 200,
    ok: true,
    body: {
      getReader() {
        return {
          read: async () => {
            if (index === gateIndex) await gate;
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
  return { response, release };
}

async function sendViaUi(text: string) {
  const textarea = screen.getByPlaceholderText(/ask for a starting dashboard|ask for a change/i);
  fireEvent.change(textarea, { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: /send/i }));
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parsePendingQuestion', () => {
  it('parses a well-formed question payload', () => {
    const parsed = parsePendingQuestion({
      requestId: 'r1',
      turnId: 't1',
      questions: [
        {
          question: 'How should talk time be shown?',
          header: 'Talk time',
          multiSelect: false,
          options: [
            {
              label: 'Bars by speaker',
              description: 'One row per speaker',
              widgetType: 'talk_time_by_speaker',
            },
          ],
        },
      ],
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.requestId).toBe('r1');
    expect(parsed?.turnId).toBe('t1');
    expect(parsed?.questions).toHaveLength(1);
    expect(parsed?.questions[0].options[0]).toEqual({
      label: 'Bars by speaker',
      description: 'One row per speaker',
      widgetType: 'talk_time_by_speaker',
      raw: {
        label: 'Bars by speaker',
        description: 'One row per speaker',
        widgetType: 'talk_time_by_speaker',
      },
    });
  });

  it('returns null for a payload missing requestId/turnId', () => {
    expect(parsePendingQuestion({ questions: [] })).toBeNull();
  });

  it('returns null for a payload with no usable questions', () => {
    expect(parsePendingQuestion({ requestId: 'r1', turnId: 't1', questions: [] })).toBeNull();
  });

  it('treats an option with no widgetType as unselectable but still parses it', () => {
    const parsed = parsePendingQuestion({
      requestId: 'r1',
      turnId: 't1',
      questions: [
        {
          question: 'Q?',
          header: '',
          multiSelect: false,
          options: [{ label: 'No type here' }],
        },
      ],
    });
    expect(parsed?.questions[0].options[0].widgetType).toBeUndefined();
  });
});

describe('AiV2Design — streaming deltas', () => {
  it('renders assistant deltas merged in order as they arrive', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      fakeFetchResponse([
        sseFrame('delta', { text: 'Built ' }),
        sseFrame('delta', { text: 'an overview.' }),
        sseFrame('done', {}),
      ]) as unknown as Response,
    );

    renderHarness();
    await sendViaUi('Give me an overview');

    expect(await screen.findByText('Give me an overview')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Built an overview.')).toBeTruthy());

    const transcript = screen.getByTestId('aiv2-design-messages');
    expect(within(transcript).getAllByText(/Built an overview\./)).toHaveLength(1);
  });

  it('ignores unknown event types without breaking the stream', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      fakeFetchResponse([
        ': keepalive\n\n',
        sseFrame('thinking', { text: 'should never render' }),
        sseFrame('delta', { text: 'visible' }),
        sseFrame('done', {}),
      ]) as unknown as Response,
    );

    renderHarness();
    await sendViaUi('go');

    await waitFor(() => expect(screen.getByText('visible')).toBeTruthy());
    expect(screen.queryByText(/should never render/)).toBeNull();
  });
});

describe('AiV2Design — question round trip', () => {
  function questionSse(overrides: Partial<Record<string, unknown>> = {}) {
    return sseFrame('question', {
      requestId: 'req-1',
      turnId: 'turn-1',
      questions: [
        {
          question: 'How should talk time be shown?',
          header: 'Talk time',
          multiSelect: false,
          options: [
            {
              label: 'Bars by speaker',
              description: '3 speakers',
              widgetType: 'talk_time_by_speaker',
            },
            {
              label: 'Share of session',
              description: 'Stacked bar',
              widgetType: 'event_count_by_category',
            },
          ],
          ...overrides,
        },
      ],
    });
  }

  it('renders the question view with option cards + free-text fallback when a `question` event arrives', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      fakeFetchResponse([
        questionSse(),
        // Stream stays open (no terminal event) — matches the server never
        // sending done/error while a question blocks the turn.
      ]) as unknown as Response,
    );

    renderHarness();
    await sendViaUi('Give me an overview');

    const card = await screen.findByTestId('aiv2-question-card');
    expect(within(card).getByText('How should talk time be shown?')).toBeTruthy();
    expect(within(card).getByText('Bars by speaker')).toBeTruthy();
    expect(within(card).getByText('Share of session')).toBeTruthy();
    expect(within(card).getByPlaceholderText(/minutes, not percentages/i)).toBeTruthy();
  });

  it('renders the preview slot per option via the injected renderOptionPreview', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(fakeFetchResponse([questionSse()]) as unknown as Response);

    renderHarness();
    await sendViaUi('go');

    const card = await screen.findByTestId('aiv2-question-card');
    const previews = within(card).getAllByTestId('preview-stub');
    expect(previews.map((p) => p.textContent)).toEqual([
      'talk_time_by_speaker',
      'event_count_by_category',
    ]);
  });

  it('selecting an option POSTs the answer with the widgetType echoed verbatim, never matched by label', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(fakeFetchResponse([questionSse()]) as unknown as Response);
    fetchMock.mockResolvedValueOnce(fakeJsonOkResponse() as unknown as Response);

    renderHarness();
    await sendViaUi('go');

    const card = await screen.findByTestId('aiv2-question-card');
    fireEvent.click(within(card).getByText('Share of session'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [url, init] = fetchMock.mock.calls[1];
    expect(String(url)).toContain('/ai/v2/answer');
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body).toEqual({
      turnId: 'turn-1',
      requestId: 'req-1',
      answers: [{ kind: 'option', widgetType: 'event_count_by_category' }],
    });

    await waitFor(() => expect(screen.queryByTestId('aiv2-question-pending')).toBeNull());
  });

  it('submitting free text POSTs the distinct { kind: "text" } answer shape', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(fakeFetchResponse([questionSse()]) as unknown as Response);
    fetchMock.mockResolvedValueOnce(fakeJsonOkResponse() as unknown as Response);

    renderHarness();
    await sendViaUi('go');

    const card = await screen.findByTestId('aiv2-question-card');
    const freeTextInput = within(card).getByPlaceholderText(/minutes, not percentages/i);
    fireEvent.change(freeTextInput, { target: { value: 'minutes, not percentages' } });
    fireEvent.keyDown(freeTextInput, { key: 'Enter' });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const body = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect(body.answers).toEqual([{ kind: 'text', text: 'minutes, not percentages' }]);
  });

  it('disables and marks options with no widgetType as unselectable', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      fakeFetchResponse([
        sseFrame('question', {
          requestId: 'req-2',
          turnId: 'turn-2',
          questions: [
            {
              question: 'Pick one',
              header: '',
              multiSelect: false,
              options: [{ label: 'No type' }],
            },
          ],
        }),
      ]) as unknown as Response,
    );

    renderHarness();
    await sendViaUi('go');

    const card = await screen.findByTestId('aiv2-question-card');
    const button = within(card).getByText('No type').closest('button');
    expect(button).not.toBeNull();
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('AiV2Design — dashboard proposal', () => {
  it('fires onDashboardProposed with the parsed config and the frame turnId', async () => {
    const fetchMock = vi.mocked(fetch);
    const onDashboardProposed = vi.fn();
    fetchMock.mockResolvedValueOnce(
      fakeFetchResponse([
        sseFrame('dashboard', {
          turnId: 'turn-9',
          config: {
            widgets: [
              { id: 'w1', type: 'session_duration', title: 'Duration', x: 0, y: 0, w: 4, h: 2 },
            ],
            interactions: [],
          },
        }),
        sseFrame('done', {}),
      ]) as unknown as Response,
    );

    renderHarness('sess-1', onDashboardProposed);
    await sendViaUi('propose a dashboard');

    await waitFor(() => expect(onDashboardProposed).toHaveBeenCalledTimes(1));
    expect(onDashboardProposed).toHaveBeenCalledWith(
      {
        widgets: [
          { id: 'w1', type: 'session_duration', title: 'Duration', x: 0, y: 0, w: 4, h: 2 },
        ],
        interactions: [],
      },
      'turn-9',
    );
  });

  it('drops a malformed dashboard frame without firing the callback', async () => {
    const fetchMock = vi.mocked(fetch);
    const onDashboardProposed = vi.fn();
    fetchMock.mockResolvedValueOnce(
      fakeFetchResponse([
        sseFrame('dashboard', { turnId: 'turn-9', config: { widgets: [], interactions: [] } }),
        sseFrame('delta', { text: 'still fine' }),
        sseFrame('done', {}),
      ]) as unknown as Response,
    );

    renderHarness('sess-1', onDashboardProposed);
    await sendViaUi('propose a dashboard');

    await waitFor(() => expect(screen.getByText('still fine')).toBeTruthy());
    expect(onDashboardProposed).not.toHaveBeenCalled();
  });
});

describe('AiV2Design — terminal events clear an actually-pending question', () => {
  function pendingQuestionFrame() {
    return sseFrame('question', {
      requestId: 'req-9',
      turnId: 'turn-9',
      questions: [
        {
          question: 'Pick one',
          header: '',
          multiSelect: false,
          options: [{ label: 'A', widgetType: 'session_duration' }],
        },
      ],
    });
  }

  it('clears the pending question when the turn ends in a terminal error', async () => {
    const fetchMock = vi.mocked(fetch);
    const { response, release } = gatedFakeFetchResponse(
      [pendingQuestionFrame(), sseFrame('error', { detail: 'turn blew up' })],
      1,
    );
    fetchMock.mockResolvedValueOnce(response as unknown as Response);

    renderHarness();
    await sendViaUi('go');

    // The question is genuinely pending before the terminal frame arrives.
    await screen.findByTestId('aiv2-question-pending');

    release();

    const errorEl = await screen.findByTestId('aiv2-design-error');
    expect(errorEl.textContent).toContain('turn blew up');
    expect(screen.queryByTestId('aiv2-question-pending')).toBeNull();
  });

  it('clears the pending question when the turn ends in done', async () => {
    const fetchMock = vi.mocked(fetch);
    const { response, release } = gatedFakeFetchResponse(
      [pendingQuestionFrame(), sseFrame('done', {})],
      1,
    );
    fetchMock.mockResolvedValueOnce(response as unknown as Response);

    renderHarness();
    await sendViaUi('go');

    await screen.findByTestId('aiv2-question-pending');

    release();

    await waitFor(() => expect(screen.queryByTestId('aiv2-question-pending')).toBeNull());
    expect(screen.queryByTestId('aiv2-design-error')).toBeNull();
  });
});

describe('AiV2Design — Stop control', () => {
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
    await screen.findByRole('button', { name: /send/i });
    expect(screen.queryByTestId('aiv2-design-error')).toBeNull();
  });
});

describe('AiV2Design — 503 not-configured', () => {
  it('shows the not-configured explainer instead of a generic error', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      fakeJsonErrorResponse(
        503,
        'AI v2 is not configured on this deployment.',
      ) as unknown as Response,
    );

    renderHarness();
    await sendViaUi('hello?');

    expect(await screen.findByTestId('aiv2-design-not-configured')).toBeTruthy();
    expect(screen.queryByTestId('aiv2-design-error')).toBeNull();
  });
});

describe('AiV2Design — error rendering', () => {
  it('renders a terminal SSE error event and clears any pending question', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      fakeFetchResponse([sseFrame('error', { detail: 'upstream-failed' })]) as unknown as Response,
    );

    renderHarness();
    await sendViaUi('hello?');

    const errorEl = await screen.findByTestId('aiv2-design-error');
    expect(errorEl.textContent).toContain('upstream-failed');
    expect(screen.queryByTestId('aiv2-question-pending')).toBeNull();
  });

  it('renders an error when the answer submission itself fails', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      fakeFetchResponse([
        sseFrame('question', {
          requestId: 'req-3',
          turnId: 'turn-3',
          questions: [
            {
              question: 'Pick one',
              header: '',
              multiSelect: false,
              options: [{ label: 'A', widgetType: 'session_duration' }],
            },
          ],
        }),
      ]) as unknown as Response,
    );
    fetchMock.mockResolvedValueOnce(
      fakeJsonErrorResponse(404, 'No question is pending.') as unknown as Response,
    );

    renderHarness();
    await sendViaUi('go');

    const card = await screen.findByTestId('aiv2-question-card');
    fireEvent.click(within(card).getByText('A'));

    const errorEl = await screen.findByTestId('aiv2-design-error');
    expect(errorEl.textContent).toContain('No question is pending.');
  });
});
