import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch } from '../../../api/client';
import type { SessionStatus } from '../../../api/types';
import { renderStrict } from '../../../test/renderStrict';
import { TopicsFeed } from './TopicsFeed';
import { TranscribeFeed } from './TranscribeFeed';

// --- Generate-503-latch behavior pin (code-health-tail task 4.4, finding 2.5) ---
//
// The latch itself is a DELIBERATE pattern (ui-refresh D9: honest capability
// gate — the server has no capability endpoint, so unavailability is learned
// on the first 503 and then latched until a full page reload). These tests pin
// that behavior for BOTH feeds before/after the `useGatedGenerate` +
// `GenerateToolbar` extraction, asserting only rendered semantics so the same
// assertions hold across the refactor:
//
//  1. a 503 from generate latches the control: the button stays focusable but
//     `aria-disabled`, an always-visible reason span appears (Transcribe's
//     carries the inline `<code>DEEPGRAM_API_KEY</code>`), and further clicks
//     no-op — the generate endpoint is never called again;
//  2. a non-503 error does NOT latch: it surfaces as a `role="alert"` inline
//     message and the button remains clickable (a retry re-calls generate).

vi.mock('../../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/client')>();
  return { ...actual, apiFetch: vi.fn() };
});

class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof window !== 'undefined' && typeof window.ResizeObserver === 'undefined') {
  window.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
}

const mockedApiFetch = vi.mocked(apiFetch);
const SESSION_ID = 'sess-gen-latch-1';

function statusFixture(): SessionStatus {
  return {
    is_rolling: false,
    timecode: '00:00:30:00',
    session_timecode: '00:00:30:00',
    master_timecode: '00:00:30:00',
    frame_rate: 24,
    current_take: 0,
    audio_recording_lease_alive: false,
    audio_recording_lease_holder_id: null,
    event_count: 0,
    logged_event_count: 0,
    title: 'Generate latch test session',
    deck_title: '',
    show_name: null,
    show_code: null,
    episode: '',
    session_created_at_utc: null,
    now_utc: '2026-07-26T00:00:30Z',
    notes: '',
    show_id: null,
    events_stream_revision: 1,
  };
}

/** Routes the non-generate reads both feeds issue; generate POSTs reject with
 * `generateError` and are counted via `generateCalls`. */
function mockRoutes(generateError: () => Error, generateCalls: { count: number }) {
  mockedApiFetch.mockImplementation(async (path: string) => {
    if (path.includes('/generate')) {
      generateCalls.count += 1;
      throw generateError();
    }
    if (path === 'transcript-generation/status') return { in_flight: false };
    // byo-ai-providers 6.2: a latched transcript feed watches the caller's providers.
    if (path === 'me/providers') return providersState;
    if (path.includes('/status')) return statusFixture();
    if (path.includes('/transcript-words')) return { words: [] };
    if (path.includes('/topics')) return { topics: [] };
    throw new Error(`unexpected apiFetch call: ${path}`);
  });
}

let providersState: { llm: unknown; stt: unknown; run_features_allowed: boolean };

function renderFeed(feed: 'transcribe' | 'topics') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  lastClient = client;
  return renderStrict(
    <QueryClientProvider client={client}>
      {feed === 'transcribe' ? (
        <TranscribeFeed sessionId={SESSION_ID} />
      ) : (
        <TopicsFeed sessionId={SESSION_ID} />
      )}
    </QueryClientProvider>,
  );
}

function generateButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Auto generate' });
}

let lastClient: QueryClient;

beforeEach(() => {
  mockedApiFetch.mockReset();
  providersState = { llm: null, stt: null, run_features_allowed: true };
});

interface FeedCase {
  feed: 'transcribe' | 'topics';
  /** Substring of the latched reason span's accessible text. */
  reasonText: RegExp;
}

const CASES: FeedCase[] = [
  // byo-ai-providers D7 category 7: the reason names Settings → Advanced, not a server setting.
  { feed: 'transcribe', reasonText: /Add a speech-to-text key in Settings → Advanced/ },
  // ai-sdk-agent-harness D9 category 2: the topics reason names the caller's language model.
  {
    feed: 'topics',
    reasonText: /Add a language model in Settings → Advanced to generate topics\./,
  },
];

describe.each(CASES)('$feed feed — generate 503 latch (ui-refresh D9)', ({ feed, reasonText }) => {
  it('toolbar buttons are glass Buttons with lucide icons (shadcn-port-workspace D6)', async () => {
    mockRoutes(() => new ApiError(503, 'Service Unavailable'), { count: 0 });
    renderFeed(feed);
    const gen = await screen.findByRole('button', { name: 'Auto generate' });
    expect(gen.getAttribute('data-variant')).toBe('glass');
    expect(gen.querySelector('svg.lucide-sparkles')).not.toBeNull();
    const insert = screen.getByRole('button', { name: 'Insert' });
    expect(insert.getAttribute('data-variant')).toBe('glass');
    expect(insert.querySelector('svg.lucide-plus')).not.toBeNull();
  });

  it('latches on the first 503: aria-disabled + visible reason, further clicks never re-call generate', async () => {
    const calls = { count: 0 };
    mockRoutes(() => new ApiError(503, 'Service Unavailable'), calls);
    renderFeed(feed);

    fireEvent.click(await screen.findByRole('button', { name: 'Auto generate' }));

    // Latched: still a real focusable button (no `disabled` attribute), marked
    // aria-disabled, described by the always-visible reason span.
    await waitFor(() => expect(generateButton().getAttribute('aria-disabled')).toBe('true'));
    const latched = generateButton();
    expect(latched.hasAttribute('disabled')).toBe(false);
    const reasonId = latched.getAttribute('aria-describedby');
    expect(reasonId).toBeTruthy();
    const reason = document.getElementById(reasonId as string);
    expect(reason?.textContent).toMatch(reasonText);
    expect(calls.count).toBe(1);

    // The latch persists and the click handler no-ops: no second network call.
    fireEvent.click(latched);
    fireEvent.click(latched);
    expect(calls.count).toBe(1);
    // No one-off error message for the 503 — the latch replaces it.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does NOT latch on a non-503 error: inline alert shown, retry re-calls generate', async () => {
    const calls = { count: 0 };
    mockRoutes(() => new ApiError(500, 'generation exploded'), calls);
    renderFeed(feed);

    fireEvent.click(await screen.findByRole('button', { name: 'Auto generate' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('generation exploded');
    expect(generateButton().getAttribute('aria-disabled')).toBeNull();
    expect(calls.count).toBe(1);

    // Not latched: a retry goes back to the network.
    fireEvent.click(generateButton());
    await waitFor(() => expect(calls.count).toBe(2));
  });
});

// byo-ai-providers task 6.2 (web-session-console "Honest capability gating on generation features"):
// the transcript latch points at Settings → Advanced, names no server setting, and clears without a
// reload once the user saves a speech-to-text key.
describe('transcribe feed — the latch points at Settings → Advanced (byo-ai-providers 6.2)', () => {
  it('the reason and the empty state name Settings → Advanced and Insert, and never DEEPGRAM_API_KEY', async () => {
    mockRoutes(
      () =>
        new ApiError(
          503,
          'Add a speech-to-text key in Settings → Advanced to generate transcripts.',
        ),
      {
        count: 0,
      },
    );
    renderFeed('transcribe');
    fireEvent.click(await screen.findByRole('button', { name: 'Auto generate' }));
    await waitFor(() => expect(generateButton().getAttribute('aria-disabled')).toBe('true'));
    const reasonId = generateButton().getAttribute('aria-describedby') as string;
    expect(document.getElementById(reasonId)?.textContent).toMatch(/Settings → Advanced/);
    const empty = await screen.findByText(/Add a DeepGram key in Settings → Advanced/);
    expect(empty.textContent).toMatch(/Insert/);
    expect(document.body.textContent).not.toMatch(/DEEPGRAM_API_KEY|server setting/);
  });

  it('saving a speech-to-text key clears the latch without a reload', async () => {
    const calls = { count: 0 };
    mockRoutes(() => new ApiError(503, 'needs a key'), calls);
    renderFeed('transcribe');
    fireEvent.click(await screen.findByRole('button', { name: 'Auto generate' }));
    await waitFor(() => expect(generateButton().getAttribute('aria-disabled')).toBe('true'));

    // The user saves a key in Settings → Advanced, whose save invalidates the providers query.
    providersState = {
      llm: null,
      stt: {
        kind: 'stt',
        provider: 'deepgram',
        base_url: null,
        model: 'nova-3',
        key_last4: 'abcd',
        updated_at: 'x',
      },
      run_features_allowed: true,
    };
    await lastClient.invalidateQueries({ queryKey: ['providers'] });
    await waitFor(() => expect(generateButton().getAttribute('aria-disabled')).toBeNull());
    fireEvent.click(generateButton());
    await waitFor(() => expect(calls.count).toBe(2));
  });
});

// ai-sdk-agent-harness task 8.2 (design D8; web-session-console "Honest capability gating on
// generation features"): the topics latch points at Settings → Advanced and clears without a reload
// once the user saves a language model.
describe('topics feed — the latch names the language model (ai-sdk-agent-harness D8)', () => {
  const SAVED_LLM = {
    kind: 'llm',
    provider: 'anthropic',
    base_url: null,
    model: 'claude-sonnet-4-5',
    key_last4: '1234',
    updated_at: '2026-10-12T10:00:00.000Z',
  };

  it('the empty state names Settings → Advanced and Insert, and no server setting or reload', async () => {
    mockRoutes(
      () => new ApiError(503, 'Add a language model in Settings → Advanced to generate topics.'),
      { count: 0 },
    );
    renderFeed('topics');
    fireEvent.click(await screen.findByRole('button', { name: 'Auto generate' }));
    await waitFor(() => expect(generateButton().getAttribute('aria-disabled')).toBe('true'));
    const empty = await screen.findByText(/Add a language model in Settings → Advanced/, {
      selector: 'td *, td',
    });
    expect(empty.textContent).toMatch(/Insert/);
    expect(document.body.textContent).not.toMatch(
      /CLAUDE_CLI_PATH|server setting|on this server|[Rr]eload/,
    );
  });

  it('saving a language model clears the latch without a reload', async () => {
    const calls = { count: 0 };
    mockRoutes(() => new ApiError(503, 'needs a model'), calls);
    renderFeed('topics');
    fireEvent.click(await screen.findByRole('button', { name: 'Auto generate' }));
    await waitFor(() => expect(generateButton().getAttribute('aria-disabled')).toBe('true'));
    await waitFor(() => expect(lastClient.getQueryData(['providers'])).toBeTruthy());

    providersState = { ...providersState, llm: SAVED_LLM };
    await lastClient.invalidateQueries({ queryKey: ['providers'] });
    await waitFor(() => expect(generateButton().getAttribute('aria-disabled')).toBeNull());
    fireEvent.click(generateButton());
    await waitFor(() => expect(calls.count).toBe(2));
  });

  it('a latch while a language model is already saved stays until a new save', async () => {
    providersState = { ...providersState, llm: SAVED_LLM };
    mockRoutes(() => new ApiError(503, 'needs a model'), { count: 0 });
    renderFeed('topics');
    fireEvent.click(await screen.findByRole('button', { name: 'Auto generate' }));
    await waitFor(() => expect(generateButton().getAttribute('aria-disabled')).toBe('true'));
    await waitFor(() => expect(lastClient.getQueryData(['providers'])).toBeTruthy());
    await lastClient.invalidateQueries({ queryKey: ['providers'] });
    expect(generateButton().getAttribute('aria-disabled')).toBe('true');

    providersState = { ...providersState, llm: { ...SAVED_LLM, updated_at: 'later' } };
    await lastClient.invalidateQueries({ queryKey: ['providers'] });
    await waitFor(() => expect(generateButton().getAttribute('aria-disabled')).toBeNull());
  });
});
