import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../../../api/client';
import { eventsKeys } from '../../../api/hooks/useEvents';
import type { EventsResponse, LogEvent, SessionStatus } from '../../../api/types';
import { useRecoveryStopWarning } from './useRecoveryStopWarning';

// --- useRecoveryStopWarning (ui-refresh, task 2.3; D13 panel-pinned semantics) ---
//
// This slice has no spike reference (fact-check finding: the spike still called
// window.confirm here) — the async window the themed dialog opens is exercised
// directly: accept posts, decline posts nothing, and accept RE-VALIDATES the
// orphan + lease against the LATEST query data before posting, no-oping (still
// dismissing) if either resolved out from under the still-open dialog.
//
// `apiFetch` is mocked at the module boundary and dispatches on path/method so
// the underlying useEvents/useSessionStatus queries behave like a real
// (mutable) backend — POSTs are recorded separately so "nothing was posted"
// assertions aren't confused by the GET traffic those hooks issue on their own.

vi.mock('../../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/client')>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

const SESSION_ID = 'sess-recovery-1';

function orphanStartEvent(overrides: Partial<LogEvent> = {}): LogEvent {
  return {
    event_id: 'ev-start-1',
    session_id: SESSION_ID,
    category: 'internal',
    category_label: 'Internal',
    category_color: '#000000',
    message: 'Recording 1 Started',
    timecode: '00:00:10:00',
    timecode_hms: '00:00:10',
    timecode_total_frames: 240,
    frame_rate: 24,
    wall_time_utc: '2026-07-21T00:00:10Z',
    metadata: {},
    ...overrides,
  };
}

function matchingStopEvent(): LogEvent {
  return {
    ...orphanStartEvent(),
    event_id: 'ev-stop-1',
    message: 'Recording 1 Stopped',
    timecode: '00:00:20:00',
    timecode_hms: '00:00:20',
    timecode_total_frames: 480,
    wall_time_utc: '2026-07-21T00:00:20Z',
  };
}

function eventsFixture(events: LogEvent[]): EventsResponse {
  return {
    events,
    total: events.length,
    logged_event_count: events.length,
    offset: 0,
    limit: 2000,
  };
}

function statusFixture(overrides: Partial<SessionStatus> = {}): SessionStatus {
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
    event_count: 1,
    logged_event_count: 1,
    audio_segment_count: 0,
    title: 'Recovery test session',
    deck_title: '',
    show_name: null,
    show_code: null,
    episode: '',
    session_created_at_utc: null,
    now_utc: '2026-07-21T00:00:30Z',
    notes: '',
    show_id: null,
    events_stream_revision: 1,
    ...overrides,
  };
}

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function wrapperFor(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <StrictMode>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </StrictMode>
  );
}

// --- Fake per-session backend state, read by the apiFetch mock below ---
let backend: Record<string, { events: LogEvent[]; status: SessionStatus }>;
let postCalls: Array<{ path: string; body: Record<string, unknown> }>;

function setSessionState(sessionId: string, events: LogEvent[], status: SessionStatus) {
  backend[sessionId] = { events, status };
}

beforeEach(() => {
  backend = {};
  postCalls = [];
  mockedApiFetch.mockReset();
  mockedApiFetch.mockImplementation(async (path: string, opts?: RequestInit) => {
    if (opts?.method === 'POST') {
      postCalls.push({ path, body: JSON.parse(String(opts.body)) });
      return {};
    }
    const sessionId = decodeURIComponent(path.split('/')[1] ?? '');
    const state = backend[sessionId];
    if (!state) throw new Error(`no fixture backend state for session ${sessionId}`);
    if (path.includes('/status')) return state.status;
    if (path.includes('/events')) return eventsFixture(state.events);
    throw new Error(`unexpected apiFetch call: ${path}`);
  });
  window.AutoLogger_invalidateEvents = undefined;
});

async function refetchAll(client: QueryClient, sessionId: string) {
  await act(async () => {
    await client.invalidateQueries({ queryKey: eventsKeys.all(sessionId) });
    await client.invalidateQueries({ queryKey: ['session-status', sessionId] });
  });
}

describe('useRecoveryStopWarning (themed, race-safe orphan-recovery dialog)', () => {
  it('accept posts a synthetic stop at accept-time', async () => {
    setSessionState(SESSION_ID, [orphanStartEvent()], statusFixture());
    const client = makeClient();

    const { result } = renderHook(() => useRecoveryStopWarning(SESSION_ID, false), {
      wrapper: wrapperFor(client),
    });

    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current?.title).toBeTruthy();

    act(() => {
      result.current?.onAccept();
    });

    // Dialog dismisses immediately on accept.
    await waitFor(() => expect(result.current).toBeNull());
    await waitFor(() => expect(postCalls).toHaveLength(1));

    const [{ path, body }] = postCalls;
    expect(path).toBe(`sessions/${SESSION_ID}/events`);
    expect(body.category).toBe('internal');
    expect(body.message).toBe('Recording 1 Stopped');
    // marked_at_utc is a real, parseable accept-time timestamp — not a value
    // baked in when the dialog first armed.
    expect(Number.isNaN(Date.parse(String(body.marked_at_utc)))).toBe(false);
  });

  it('decline dismisses the dialog and posts nothing', async () => {
    setSessionState(SESSION_ID, [orphanStartEvent()], statusFixture());
    const client = makeClient();

    const { result } = renderHook(() => useRecoveryStopWarning(SESSION_ID, false), {
      wrapper: wrapperFor(client),
    });

    await waitFor(() => expect(result.current).not.toBeNull());

    act(() => {
      result.current?.onDecline();
    });

    await waitFor(() => expect(result.current).toBeNull());
    expect(postCalls).toHaveLength(0);
  });

  it('accept no-ops (dismisses, posts nothing) if the orphan resolved before the click', async () => {
    setSessionState(SESSION_ID, [orphanStartEvent()], statusFixture());
    const client = makeClient();

    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) => useRecoveryStopWarning(sessionId, false),
      { wrapper: wrapperFor(client), initialProps: { sessionId: SESSION_ID } },
    );

    await waitFor(() => expect(result.current).not.toBeNull());

    // The recording resolved out from under the still-open, non-blocking dialog
    // (e.g. another tab logged the real stop).
    setSessionState(SESSION_ID, [orphanStartEvent(), matchingStopEvent()], statusFixture());
    await refetchAll(client, SESSION_ID);
    // `rerender` forces a fresh render pass so the hook's `useEvents`/
    // `useSessionStatus` subscriptions read the cache's current snapshot
    // synchronously — react-query's own notification can otherwise lag a
    // tick behind the invalidation promise settling in this harness.
    rerender({ sessionId: SESSION_ID });
    await waitFor(() =>
      expect(client.getQueryData(eventsKeys.page(SESSION_ID, 0, 2000))).toEqual(
        eventsFixture([orphanStartEvent(), matchingStopEvent()]),
      ),
    );

    act(() => {
      result.current?.onAccept();
    });

    await waitFor(() => expect(result.current).toBeNull());
    expect(postCalls).toHaveLength(0);
  });

  it('accept no-ops (dismisses, posts nothing) if the recording lease is alive before the click', async () => {
    setSessionState(SESSION_ID, [orphanStartEvent()], statusFixture());
    const client = makeClient();

    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) => useRecoveryStopWarning(sessionId, false),
      { wrapper: wrapperFor(client), initialProps: { sessionId: SESSION_ID } },
    );

    await waitFor(() => expect(result.current).not.toBeNull());

    // Another client started actively holding the recording lease while the
    // dialog sat open — accept must not race a live recording.
    setSessionState(
      SESSION_ID,
      [orphanStartEvent()],
      statusFixture({ audio_recording_lease_alive: true }),
    );
    await refetchAll(client, SESSION_ID);
    rerender({ sessionId: SESSION_ID });
    await waitFor(() =>
      expect(
        (client.getQueryData(['session-status', SESSION_ID]) as SessionStatus)
          .audio_recording_lease_alive,
      ).toBe(true),
    );

    act(() => {
      result.current?.onAccept();
    });

    await waitFor(() => expect(result.current).toBeNull());
    expect(postCalls).toHaveLength(0);
  });

  it('dismisses a pending decision (as decline) on session switch', async () => {
    setSessionState(SESSION_ID, [orphanStartEvent()], statusFixture());
    setSessionState('sess-other', [], statusFixture());
    const client = makeClient();

    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) => useRecoveryStopWarning(sessionId, false),
      { wrapper: wrapperFor(client), initialProps: { sessionId: SESSION_ID } },
    );

    await waitFor(() => expect(result.current).not.toBeNull());

    rerender({ sessionId: 'sess-other' });

    await waitFor(() => expect(result.current).toBeNull());
    expect(postCalls).toHaveLength(0);
  });
});
