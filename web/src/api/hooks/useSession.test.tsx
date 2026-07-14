import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch } from '../client';
import type { Session } from '../types';
import { useSession } from './useSessions';

// --- useSession resolution-hook tests (session-deep-links, task 4.3; spec:
// web-session-routing "Deep-link resolution states") ---
//
// The hook's 404-vs-error discrimination gets direct coverage here: the fetch
// layer (`apiFetch`) is mocked at the module boundary — NOT the hook — and the
// QueryClient mirrors production's retry policy (`retry: 1`, main.tsx) with a
// zero retry delay so the retry behavior itself is under test:
//
//   404            -> resolves as `{ kind: 'not-found' }` DATA, exactly one
//                     request — never retried, never an error state
//   non-404 / network -> query error state after the default retry — never
//                     presented as not-found
//
// `ApiError` stays the real class (importOriginal) so the hook's instanceof
// discrimination is exercised for real.

vi.mock('../client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../client')>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

function sessionFixture(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    title: 'Ep 12 Live Log',
    deck_title: '',
    show_id: 'show-1',
    show_code: 'SH',
    show_name: 'Show One',
    episode: '12',
    notes: '',
    session_status: 'active',
    frame_rate: 30,
    start_offset_frames: 0,
    created_at_utc: '2026-07-14T00:00:00Z',
    episode_date: null,
    event_count: 0,
    is_rolling: false,
    current_take: 0,
    rolling_timecode: null,
    total_runtime_hms: '00:00:00',
    archived: false,
    ...overrides,
  };
}

function makeClient() {
  // Mirrors the production default (`retry: 1` in main.tsx) so the
  // 404-is-never-retried assertions run against the same policy; retryDelay 0
  // keeps the retried-error test fast.
  return new QueryClient({ defaultOptions: { queries: { retry: 1, retryDelay: 0 } } });
}

function wrapperFor(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <StrictMode>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </StrictMode>
  );
}

beforeEach(() => {
  mockedApiFetch.mockReset();
});

describe('useSession (per-id deep-link resolution query)', () => {
  it('resolves a 200 as { kind: found } with the session payload', async () => {
    const session = sessionFixture();
    mockedApiFetch.mockResolvedValue(session);

    const { result } = renderHook(() => useSession('sess-1'), {
      wrapper: wrapperFor(makeClient()),
    });

    await waitFor(() => expect(result.current.data).toEqual({ kind: 'found', session }));
    expect(result.current.isError).toBe(false);
    expect(mockedApiFetch).toHaveBeenCalledWith('sessions/sess-1');
  });

  it('resolves a 404 deterministically as { kind: not-found } — no error state, no retry', async () => {
    mockedApiFetch.mockRejectedValue(new ApiError(404, 'Session not found'));

    const { result } = renderHook(() => useSession('ghost-1'), {
      wrapper: wrapperFor(makeClient()),
    });

    await waitFor(() => expect(result.current.data).toEqual({ kind: 'not-found' }));
    expect(result.current.isError).toBe(false);
    // The masked 404 is a resolved outcome: with retry enabled on the client,
    // it must still settle on the first response.
    expect(mockedApiFetch).toHaveBeenCalledTimes(1);
  });

  it('surfaces a 5xx as a query error (after the default retry) — never as not-found', async () => {
    mockedApiFetch.mockRejectedValue(new ApiError(503, 'Service unavailable'));

    const { result } = renderHook(() => useSession('flaky-1'), {
      wrapper: wrapperFor(makeClient()),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
    // retry: 1 applies to transient failures: initial attempt + one retry.
    expect(mockedApiFetch).toHaveBeenCalledTimes(2);
  });

  it('surfaces a network failure (non-ApiError throw) as a query error', async () => {
    mockedApiFetch.mockRejectedValue(new TypeError('fetch failed'));

    const { result } = renderHook(() => useSession('offline-1'), {
      wrapper: wrapperFor(makeClient()),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });

  it('re-encodes the id so it stays a single API path segment', async () => {
    mockedApiFetch.mockResolvedValue(sessionFixture({ id: 'a/b' }));

    renderHook(() => useSession('a/b'), { wrapper: wrapperFor(makeClient()) });

    await waitFor(() => expect(mockedApiFetch).toHaveBeenCalledWith('sessions/a%2Fb'));
  });

  it('issues no request for the empty (home) id', () => {
    const { result } = renderHook(() => useSession(''), {
      wrapper: wrapperFor(makeClient()),
    });

    expect(result.current.fetchStatus).toBe('idle');
    expect(mockedApiFetch).not.toHaveBeenCalled();
  });
});
