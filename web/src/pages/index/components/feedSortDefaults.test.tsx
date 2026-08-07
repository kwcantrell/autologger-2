import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { apiFetch } from '../../../api/client';
import type { SessionStatus } from '../../../api/types';
import { TooltipProvider } from '../../../shared/ui/Tooltip';
import { renderStrict } from '../../../test/renderStrict';
import { TopicsFeed } from './TopicsFeed';
import { TranscribeFeed } from './TranscribeFeed';

// --- Default sort: oldest-first (owner decision 2026-08-06, PR#4 review) ---
//
// All three feeds default to ascending session time — the log reads top-down
// like a sheet. EventLogSheet's default (including row order) is pinned in
// EventLogSheet.test.tsx; this file pins the Transcript and Topics feeds via
// the sorted column's aria-sort, which FeedTable derives from the live sort
// state. A silent flip back to newest-first would otherwise ship with every
// gate green (visual shots mask timestamps).

vi.mock('../../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/client')>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);
const SESSION_ID = 'sess-sort-default-1';

class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof window !== 'undefined' && typeof window.ResizeObserver === 'undefined') {
  window.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
}

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
    title: 'Sort default test session',
    deck_title: '',
    show_name: null,
    show_code: null,
    episode: '',
    session_created_at_utc: null,
    now_utc: '2026-08-06T00:00:30Z',
    notes: '',
    show_id: null,
    events_stream_revision: 1,
  };
}

beforeEach(() => {
  mockedApiFetch.mockReset();
  mockedApiFetch.mockImplementation(async (path: string) => {
    if (path === 'transcript-generation/status') return { in_flight: false };
    if (path.includes('/status')) return statusFixture();
    if (path.includes('/transcript-words')) {
      return {
        words: [
          {
            id: 'w-1',
            session_id: SESSION_ID,
            session_time: '00:00:01:00',
            speaker: '1',
            word: 'hello',
            ordinal: 1,
          },
        ],
      };
    }
    if (path.includes('/topics')) {
      return {
        topics: [
          {
            id: 't-1',
            session_time: '00:00:01:00',
            duration_sec: 10,
            topic_level: 1,
            summary: 'First topic',
            ordinal: 1,
            created_at_utc: '2026-08-06T00:00:01Z',
          },
        ],
      };
    }
    throw new Error(`unexpected apiFetch call: ${path}`);
  });
});

function renderFeed(feed: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const memory = memoryLocation({ path: `/sessions/${SESSION_ID}` });
  return renderStrict(
    <Router hook={memory.hook}>
      <QueryClientProvider client={client}>
        <TooltipProvider delayDuration={400}>{feed}</TooltipProvider>
      </QueryClientProvider>
    </Router>,
  );
}

describe('feed default sort direction', () => {
  it('TranscribeFeed defaults to Session Time ascending', async () => {
    renderFeed(<TranscribeFeed sessionId={SESSION_ID} />);
    const header = await screen.findByRole('columnheader', { name: 'Session Time' });
    expect(header.getAttribute('aria-sort')).toBe('ascending');
  });

  it('TopicsFeed defaults to Session Time ascending', async () => {
    renderFeed(<TopicsFeed sessionId={SESSION_ID} />);
    const header = await screen.findByRole('columnheader', { name: 'Session Time' });
    expect(header.getAttribute('aria-sort')).toBe('ascending');
  });
});
