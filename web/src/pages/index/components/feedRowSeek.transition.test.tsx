import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../../../api/client';
import { sessionStatusKeys } from '../../../api/hooks/useSessionStatus';
import type {
  Category,
  EventsResponse,
  LogEvent,
  SessionStatus,
  SessionTopic,
  TranscriptWord,
} from '../../../api/types';
import { renderStrict } from '../../../test/renderStrict';
import { EventLogSheet } from './EventLogSheet';
import { TopicsFeed } from './TopicsFeed';
import { TranscribeFeed } from './TranscribeFeed';

// --- Cross-feed rolling -> not-rolling TRANSITION (feed-row-seek, task 9.1) ---
//
// Design D7 requires the not-rolling gate to reach rows as a real PROP, not be
// read through a ref: `TranscribeRow` is `memo`-wrapped and its feed is
// virtualized, so a ref-read gate would not re-render rows when the session
// stops rolling — controls would stay stale-unavailable until some unrelated
// render happened. "Unavailable while rolling" and "available while not
// rolling" are BOTH satisfied by a ref-stabilized implementation too, because
// each of those is a fresh mount with the terminal state already true — the
// ref just initializes correctly either way. Only a TRANSITION, driven on an
// already-mounted tree, tells the two implementations apart.
//
// The drive mechanism is `QueryClient.setQueryData` on the SAME client/
// component instance the assertions run against (never unmount + remount,
// which would trivially "pass" a ref bug too by re-initializing the ref with
// the fresh value on the new mount) — this mirrors the established
// `client.setQueryData(...)` + `await waitFor(...)` pattern used elsewhere
// (e.g. `SessionRoute.test.tsx`) for driving a background data change without
// touching component internals.
//
// `useTimelineSeek` reads its clip layout from `AudioClipsContext` (whole-
// branch audit fix wave, finding C1); none of these feeds are rendered under
// an `AudioClipsProvider` here, so they get the context's empty default —
// the same "no clip coverage" starting point the old `mockedUseAudioClips`
// stub gave every test in this file. Clip coverage isn't what's under test
// here, only the availability gate.
//
// `@tanstack/react-virtual` is mocked to render every row unconditionally:
// jsdom has no layout engine, so `TranscribeFeed`'s real virtualizer measures
// a zero-height scroll viewport and computes an empty visible range — a
// known test-infrastructure gap recorded in design.md's panel log. That gap
// is orthogonal to what this test drives (the gate, not virtualization), so
// it's bypassed here rather than routed around per-test.
//
// jsdom also has no `ResizeObserver`, and `TopicsRow` constructs one
// unconditionally in a `useLayoutEffect` (mirrors `TopicsRow.test.tsx`).

vi.mock('../../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/client')>();
  return { ...actual, apiFetch: vi.fn() };
});

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: () => number }) => {
    const size = estimateSize();
    return {
      getVirtualItems: () =>
        Array.from({ length: count }, (_, index) => ({
          index,
          start: index * size,
          end: (index + 1) * size,
          key: index,
        })),
      getTotalSize: () => count * size,
    };
  },
}));

class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof window !== 'undefined' && typeof window.ResizeObserver === 'undefined') {
  window.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
}

const mockedApiFetch = vi.mocked(apiFetch);

const SESSION_ID = 'sess-transition-1';

beforeAll(() => {
  if (typeof window.matchMedia === 'function') return;
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

function categoryFixture(): Category {
  return {
    id: 'general',
    label: 'General',
    color: '#4488ff',
    type: 'BUTTON',
    dropdown_options: [],
    on_label: '',
    off_label: '',
  };
}

/** Resolves to exactly 10s in every feed: 240 frames / 24fps, or
 *  `00:00:10:00` parsed via the D3 converter at 24fps. */
function statusFixture(overrides: Partial<SessionStatus> = {}): SessionStatus {
  return {
    is_rolling: true,
    timecode: '00:00:30:00',
    session_timecode: '00:00:30:00',
    master_timecode: '00:00:30:00',
    frame_rate: 24,
    current_take: 0,
    audio_recording_lease_alive: false,
    audio_recording_lease_holder_id: null,
    event_count: 1,
    logged_event_count: 1,
    title: 'Transition test session',
    deck_title: '',
    show_name: null,
    show_code: null,
    episode: '',
    session_created_at_utc: null,
    now_utc: '2026-07-26T00:00:30Z',
    notes: '',
    show_id: null,
    events_stream_revision: 1,
    ...overrides,
  };
}

function eventFixture(overrides: Partial<LogEvent> = {}): LogEvent {
  return {
    event_id: 'ev-1',
    category: 'general',
    category_label: 'General',
    category_color: '#4488ff',
    message: 'Row',
    timecode: '00:00:10:00',
    timecode_total_frames: 240,
    frame_rate: 24,
    wall_time_utc: '2026-07-26T00:00:10Z',
    metadata: {},
    ...overrides,
  };
}

function wordFixture(overrides: Partial<TranscriptWord> = {}): TranscriptWord {
  return {
    id: 'w-1',
    session_time: '00:00:10:00',
    speaker: '0',
    word: 'hello',
    start_sec: 0,
    end_sec: 0,
    ordinal: 0,
    ...overrides,
  };
}

function topicFixture(overrides: Partial<SessionTopic> = {}): SessionTopic {
  return {
    id: 'topic-1',
    session_time: '00:00:10:00',
    duration_sec: 30,
    topic_level: 1,
    summary: 'A summary',
    ordinal: 0,
    created_at_utc: '2026-07-26T00:00:00Z',
    ...overrides,
  };
}

function eventsFixture(events: LogEvent[]): EventsResponse {
  return {
    events,
    total: events.length,
    logged_event_count: events.length,
    offset: 0,
    limit: 200,
    has_auto_generated: false,
  };
}

/** Mutable so `flipToNotRolling` below can change what a future `/status`
 *  fetch would return too — belt-and-braces alongside the direct
 *  `setQueryData` call, which is what actually drives the transition. */
let currentStatus: SessionStatus;

function mockApi() {
  mockedApiFetch.mockImplementation(async (path: string) => {
    if (path === 'transcript-generation/status') return { in_flight: false };
    if (path.includes('/status')) return currentStatus;
    if (path.includes('/show-categories')) {
      return { categories: [categoryFixture()], show_name: '', show_code: '' };
    }
    if (path.includes('/transcript-words')) return { words: [wordFixture()] };
    if (path.includes('/topics')) return { topics: [topicFixture()] };
    if (path.includes('/events')) return eventsFixture([eventFixture()]);
    throw new Error(`unexpected apiFetch call: ${path}`);
  });
}

let queryClient: QueryClient;

beforeEach(() => {
  mockedApiFetch.mockReset();
  vi.clearAllMocks();
  currentStatus = statusFixture({ is_rolling: true });
  mockApi();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

/** Flips the session-status query's cached data in place — the same
 *  mechanism a WS `transport.changed` invalidation + refetch would produce —
 *  WITHOUT unmounting anything the test has already rendered. */
function flipToNotRolling() {
  currentStatus = statusFixture({ is_rolling: false });
  queryClient.setQueryData(sessionStatusKeys.bySession(SESSION_ID), currentStatus);
}

const FEEDS: [string, () => ReactElement][] = [
  ['Event Feed', () => <EventLogSheet sessionId={SESSION_ID} />],
  ['Transcript feed', () => <TranscribeFeed sessionId={SESSION_ID} />],
  ['Topics feed', () => <TopicsFeed sessionId={SESSION_ID} />],
];

describe.each(FEEDS)('%s — rolling to not-rolling transition (task 9.1)', (_name, renderFeed) => {
  it('flips the jump control from unavailable to available without a remount', async () => {
    renderStrict(<QueryClientProvider client={queryClient}>{renderFeed()}</QueryClientProvider>);

    const btn = await screen.findByRole('button', { name: /Jump to/ });
    expect(btn.getAttribute('aria-disabled')).toBe('true');

    flipToNotRolling();

    await waitFor(() => expect(btn.getAttribute('aria-disabled')).toBeNull());
    // Same DOM node reference proves this was a re-render of the mounted row,
    // not an unmount/remount — a remount would trivially "pass" a
    // ref-stabilized gate bug too, since the ref would simply initialize
    // with the fresh (correct) value on the new mount.
    expect(screen.getByRole('button', { name: /Jump to/ })).toBe(btn);
  });
});
