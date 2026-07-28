import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../../../api/client';
import type { SessionStatus, SessionTopic } from '../../../api/types';
import { renderStrict } from '../../../test/renderStrict';
import { TopicsFeed } from './TopicsFeed';

// --- I1 regression (whole-branch audit fix wave) ---
//
// `transcriptAnchored` used to be computed as
// `!transcriptWhollyAnchorless(words ?? [])`. Before `useTranscriptWords`
// resolves, `words` is `undefined`, coerced to `[]` by `?? []`, and
// `transcriptWhollyAnchorless([])` is `false` (its own deliberate
// empty-transcript exception, so a hand-entered-topics-no-transcript session
// isn't wrongly treated as anchorless) — so `transcriptAnchored` read as TRUE
// for the entire loading window, and PERMANENTLY if the request errors.
// Every Topics row with a parseable `session_time` would render a LIVE jump
// control against what might be a model-invented time (the exact hazard
// task 8.3 exists to guard against — under design D1 activating it PLAYS
// audio at that invented position). This test holds the transcript-words
// request pending indefinitely — never resolving it — while Topics data has
// already loaded, and asserts no jump control renders in that window.

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
const SESSION_ID = 'sess-anchor-guard-1';

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
    title: 'Anchor guard test session',
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

function topicFixture(overrides: Partial<SessionTopic> = {}): SessionTopic {
  return {
    id: 'topic-1',
    session_id: SESSION_ID,
    session_time: '00:00:10:00',
    duration_sec: 30,
    topic_level: 1,
    summary: 'A summary',
    ordinal: 0,
    created_at_utc: '2026-07-26T00:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  mockedApiFetch.mockReset();
});

function renderFeed() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderStrict(
    <QueryClientProvider client={client}>
      <TopicsFeed sessionId={SESSION_ID} />
    </QueryClientProvider>,
  );
}

describe('TopicsFeed — transcript-anchored guard fails CLOSED while loading (finding I1)', () => {
  it('renders no jump control while useTranscriptWords is still pending, even though Topics/status have already loaded', async () => {
    let resolveWords: (() => void) | undefined;
    const wordsPromise = new Promise<{ words: [] }>((resolve) => {
      resolveWords = () => resolve({ words: [] });
    });
    mockedApiFetch.mockImplementation(async (path: string) => {
      if (path.includes('/status')) return statusFixture();
      if (path.includes('/transcript-words')) return wordsPromise;
      if (path.includes('/topics')) return { topics: [topicFixture()] };
      throw new Error(`unexpected apiFetch call: ${path}`);
    });
    renderFeed();

    // Topics data (and session status) have loaded; transcript words stay
    // pending throughout this assertion.
    await screen.findByDisplayValue('00:00:10:00');
    expect(screen.queryByRole('button', { name: /Jump to/ })).toBeNull();

    // Resolving the pending request — to a LOADED-but-EMPTY transcript —
    // flips the guard available, proving the absence above was genuinely the
    // loading gate (and preserving the deliberate empty-transcript
    // exception: a loaded `[]` still counts as anchored).
    resolveWords?.();
    await waitFor(() => expect(screen.getByRole('button', { name: /Jump to/ })).toBeTruthy());
  });
});
