import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../../../api/client';
import type { SessionStatus } from '../../../api/types';
import { renderStrict } from '../../../test/renderStrict';
import { setNavigationImplForTesting } from '../navigation';
import { TranscribeFeed } from './TranscribeFeed';

// --- Transcript generation lock banner (transcript-gen-lock-status phase 2) ---
//
// Pins the Transcribe tab toolbar banner: busy copy with title/id + live
// elapsed, cross-session link to `/sessions/:id`, and same-session busy
// treating Auto Generate like a pending mutation.

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
const CURRENT_SESSION_ID = 'sess-current-1';
const BUSY_SESSION_ID = 'sess-busy-2';

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
    title: 'Lock banner test session',
    deck_title: '',
    show_name: null,
    show_code: null,
    episode: '',
    session_created_at_utc: null,
    now_utc: '2026-07-28T12:00:30Z',
    notes: '',
    show_id: null,
    events_stream_revision: 1,
  };
}

function mockRoutes(
  generationStatus: {
    in_flight: boolean;
    session_id?: string;
    session_title?: string | null;
    started_at?: string;
  } = { in_flight: false },
) {
  mockedApiFetch.mockImplementation(async (path: string) => {
    if (path === 'transcript-generation/status') return generationStatus;
    if (path.includes('/status')) return statusFixture();
    if (path.includes('/transcript-words')) return { words: [] };
    throw new Error(`unexpected apiFetch call: ${path}`);
  });
}

function renderFeed(sessionId = CURRENT_SESSION_ID) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const memory = memoryLocation({ path: `/sessions/${sessionId}`, record: true });
  setNavigationImplForTesting((path, options) => memory.navigate(path, options));
  const view = renderStrict(
    <Router hook={memory.hook}>
      <QueryClientProvider client={client}>
        <TranscribeFeed sessionId={sessionId} />
      </QueryClientProvider>
    </Router>,
  );
  return { ...view, memory };
}

beforeEach(() => {
  mockedApiFetch.mockReset();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-07-28T12:01:05.000Z'));
});

afterEach(() => {
  setNavigationImplForTesting(null);
  vi.useRealTimers();
});

describe('TranscribeFeed — transcript generation lock banner', () => {
  it('shows busy copy with title and mm:ss elapsed when another session holds the lock', async () => {
    mockRoutes({
      in_flight: true,
      session_id: BUSY_SESSION_ID,
      session_title: 'HD_384',
      started_at: '2026-07-28T12:00:00.000Z',
    });
    renderFeed();

    const banner = await screen.findByRole('status', { name: 'Transcript generation in progress' });
    expect(banner.textContent).toMatch(/Transcribing/);
    expect(banner.textContent).toContain('HD_384');
    expect(banner.textContent).toContain('01:05');
    const link = screen.getByRole('link', { name: 'HD_384' });
    expect(link.getAttribute('href')).toBe(`/sessions/${BUSY_SESSION_ID}`);
  });

  it('navigates to the busy session when the cross-session link is clicked', async () => {
    mockRoutes({
      in_flight: true,
      session_id: BUSY_SESSION_ID,
      session_title: 'HD_384',
      started_at: '2026-07-28T12:00:00.000Z',
    });
    const { memory } = renderFeed();

    fireEvent.click(await screen.findByRole('link', { name: 'HD_384' }));
    expect(memory.history).toEqual([
      `/sessions/${CURRENT_SESSION_ID}`,
      `/sessions/${BUSY_SESSION_ID}`,
    ]);
  });

  it('falls back to session id in copy when title is null and omits the link for same-session busy', async () => {
    mockRoutes({
      in_flight: true,
      session_id: CURRENT_SESSION_ID,
      session_title: null,
      started_at: '2026-07-28T12:01:00.000Z',
    });
    renderFeed();

    const banner = await screen.findByRole('status', { name: 'Transcript generation in progress' });
    expect(banner.textContent).toContain(CURRENT_SESSION_ID);
    expect(banner.textContent).toContain('00:05');
    expect(screen.queryByRole('link')).toBeNull();

    const generateBtn = screen.getByRole('button', { name: 'Generating…' });
    expect(generateBtn.hasAttribute('disabled')).toBe(true);
  });

  it('advances elapsed display on the 1s client tick', async () => {
    mockRoutes({
      in_flight: true,
      session_id: BUSY_SESSION_ID,
      session_title: 'HD_384',
      started_at: '2026-07-28T12:00:00.000Z',
    });
    renderFeed();

    const banner = await screen.findByRole('status', { name: 'Transcript generation in progress' });
    expect(banner.textContent).toContain('01:05');

    vi.setSystemTime(new Date('2026-07-28T12:01:06.000Z'));
    await waitFor(() => expect(banner.textContent).toContain('01:06'), { timeout: 2_500 });
  });
});
