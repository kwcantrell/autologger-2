import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch } from '../client';
import type { SearchResponse } from '../types';
import { searchKeys, useSearch } from './useSearch';

// catalog-search task 5.2 (design D7, D9): `useSearch` is keyed through the `searchKeys` factory,
// never fetches below 2 characters, never retries (a 503 is an answer, not a blip), and hands
// react-query's AbortSignal to the fetch so a superseded query is cancelled.

vi.mock('../client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../client')>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

const EMPTY: SearchResponse = {
  q: 'budget',
  studios: [],
  shows: [],
  sessions: [],
  moments: [],
  moment_sessions: [],
};

function wrapperFor(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

// Retries ON by default here, so `retry: false` must come from the hook itself.
const makeClient = () => new QueryClient({ defaultOptions: { queries: { retry: 3 } } });

beforeEach(() => {
  mockedApiFetch.mockReset();
});

describe('searchKeys', () => {
  it('roots every key at the factory root and separates the parameters', () => {
    expect(searchKeys.all()).toEqual(['search']);
    const k = searchKeys.query({ q: 'budget', studioId: 's1', showId: '', limit: 25 });
    expect(k[0]).toBe('search');
    expect(k).not.toEqual(searchKeys.query({ q: 'budget', studioId: 's2', showId: '', limit: 25 }));
    expect(k).not.toEqual(searchKeys.query({ q: 'budget', studioId: 's1', showId: '', limit: 5 }));
  });
});

describe('useSearch', () => {
  it('does not fetch for a query under 2 characters (after trimming)', async () => {
    const client = makeClient();
    const { result, rerender } = renderHook(({ q }) => useSearch({ q }), {
      wrapper: wrapperFor(client),
      initialProps: { q: '' },
    });
    rerender({ q: 'b' });
    rerender({ q: ' b ' });
    await new Promise((r) => setTimeout(r, 20));
    expect(mockedApiFetch).not.toHaveBeenCalled();
    expect(result.current.fetchStatus).toBe('idle');
    expect(result.current.data).toBeUndefined();
  });

  it('fetches GET search with the trimmed q, omitting empty filters, and passes the AbortSignal', async () => {
    mockedApiFetch.mockResolvedValue(EMPTY);
    const { result } = renderHook(() => useSearch({ q: ' budget ', studioId: '', showId: '' }), {
      wrapper: wrapperFor(makeClient()),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApiFetch).toHaveBeenCalledTimes(1);
    const [path, init] = mockedApiFetch.mock.calls[0];
    expect(path).toBe('search?q=budget');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(result.current.data).toEqual(EMPTY);
  });

  it('sends the filters and the limit when given', async () => {
    mockedApiFetch.mockResolvedValue(EMPTY);
    const { result } = renderHook(
      () => useSearch({ q: 'café noir', studioId: 'st 1', showId: 'sh1', limit: 25 }),
      { wrapper: wrapperFor(makeClient()) },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const path = String(mockedApiFetch.mock.calls[0][0]);
    const params = new URLSearchParams(path.split('?')[1]);
    expect(path.startsWith('search?')).toBe(true);
    expect(params.get('q')).toBe('café noir');
    expect(params.get('studio_id')).toBe('st 1');
    expect(params.get('show_id')).toBe('sh1');
    expect(params.get('limit')).toBe('25');
  });

  it('does not retry a failure (retry: false)', async () => {
    mockedApiFetch.mockRejectedValue(new ApiError(503, 'Search is busy; try again.'));
    const { result } = renderHook(() => useSearch({ q: 'budget' }), {
      wrapper: wrapperFor(makeClient()),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mockedApiFetch).toHaveBeenCalledTimes(1);
    expect(result.current.error?.message).toBe('Search is busy; try again.');
  });

  it('a superseded query aborts its signal', async () => {
    const signals: AbortSignal[] = [];
    mockedApiFetch.mockImplementation((_path, init) => {
      if (init?.signal) signals.push(init.signal);
      return new Promise(() => {});
    });
    const client = makeClient();
    const { rerender, unmount } = renderHook(({ q }) => useSearch({ q }), {
      wrapper: wrapperFor(client),
      initialProps: { q: 'budget' },
    });
    await waitFor(() => expect(signals).toHaveLength(1));
    rerender({ q: 'budgets' });
    await waitFor(() => expect(signals).toHaveLength(2));
    unmount();
    await client.cancelQueries({ queryKey: searchKeys.all() });
    expect(signals[0].aborted).toBe(true);
  });
});

// catalog-search task 7.3 (design D11.3): "Show more in this session" asks for one session's
// moments through the same hook and factory.
describe('useSearch: one session (D11)', () => {
  it('the key separates sessions, and no session differs from one', () => {
    const base = { q: 'divorce', studioId: '', showId: '', limit: 25 };
    const a = searchKeys.query({ ...base, sessionId: 'sess-a' });
    expect(a[0]).toBe('search');
    expect(a).not.toEqual(searchKeys.query({ ...base, sessionId: 'sess-b' }));
    expect(a).not.toEqual(searchKeys.query(base));
  });

  it('sends session_id with the filters it is given, leaving empty ones out', async () => {
    mockedApiFetch.mockResolvedValue(EMPTY);
    const { result } = renderHook(
      () =>
        useSearch({ q: 'divorce', studioId: 'st-1', showId: '', sessionId: 'sess a', limit: 25 }),
      { wrapper: wrapperFor(makeClient()) },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const path = String(mockedApiFetch.mock.calls[0][0]);
    const params = new URLSearchParams(path.split('?')[1]);
    expect([...params.keys()].sort()).toEqual(['limit', 'q', 'session_id', 'studio_id']);
    expect(params.get('session_id')).toBe('sess a');
    expect(params.get('limit')).toBe('25');
  });
});
