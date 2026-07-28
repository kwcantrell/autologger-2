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
    timecode_total_frames: 720,
    frame_rate: 24,
    start_offset_frames: 0,
    current_take: 0,
    audio_recording_lease_alive: false,
    audio_recording_lease_holder_id: null,
    event_count: 0,
    logged_event_count: 0,
    audio_segment_count: 0,
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
    if (path.includes('/status')) return statusFixture();
    if (path.includes('/transcript-words')) return { words: [] };
    if (path.includes('/topics')) return { topics: [] };
    throw new Error(`unexpected apiFetch call: ${path}`);
  });
}

function renderFeed(feed: 'transcribe' | 'topics') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
  return screen.getByRole('button', { name: 'Auto Generate' });
}

beforeEach(() => {
  mockedApiFetch.mockReset();
});

interface FeedCase {
  feed: 'transcribe' | 'topics';
  /** Substring of the latched reason span's accessible text. */
  reasonText: RegExp;
}

const CASES: FeedCase[] = [
  { feed: 'transcribe', reasonText: /Transcription isn.t configured on this server/ },
  { feed: 'topics', reasonText: /Topic generation isn.t available on this server/ },
];

describe.each(CASES)('$feed feed — generate 503 latch (ui-refresh D9)', ({ feed, reasonText }) => {
  it('latches on the first 503: aria-disabled + visible reason, further clicks never re-call generate', async () => {
    const calls = { count: 0 };
    mockRoutes(() => new ApiError(503, 'Service Unavailable'), calls);
    renderFeed(feed);

    fireEvent.click(await screen.findByRole('button', { name: 'Auto Generate' }));

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

    fireEvent.click(await screen.findByRole('button', { name: 'Auto Generate' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('generation exploded');
    expect(generateButton().getAttribute('aria-disabled')).toBeNull();
    expect(calls.count).toBe(1);

    // Not latched: a retry goes back to the network.
    fireEvent.click(generateButton());
    await waitFor(() => expect(calls.count).toBe(2));
  });
});

describe('transcribe feed — latched reason carries the inline <code> element', () => {
  it('renders DEEPGRAM_API_KEY inside a <code> element in the reason span', async () => {
    const calls = { count: 0 };
    mockRoutes(() => new ApiError(503, 'Service Unavailable'), calls);
    renderFeed('transcribe');

    fireEvent.click(await screen.findByRole('button', { name: 'Auto Generate' }));
    await waitFor(() => expect(generateButton().getAttribute('aria-disabled')).toBe('true'));
    const reasonId = generateButton().getAttribute('aria-describedby') as string;
    const code = document.getElementById(reasonId)?.querySelector('code');
    expect(code?.textContent).toBe('DEEPGRAM_API_KEY');
  });
});
