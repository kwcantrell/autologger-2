import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch } from '../client';
import type { SessionTopic } from '../types';
import { useDeleteTopic, useUpdateTopic } from './useTopics';

// session-edit-conflicts task 3.1 (design D8): the topic update/delete hooks carry an optional
// version guard and, on a version-conflict 409, write the server's `current` row into the
// topics cache and invalidate.

vi.mock('../client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../client')>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);
const KEY = ['topics', 's1'];

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function wrapperFor(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

function w(id: string, summary: string, version: number): SessionTopic {
  return {
    id,
    session_time: '00:00:01:00',
    duration_sec: 30,
    topic_level: 1,
    summary,
    ordinal: 0,
    created_at_utc: '2026-10-06T10:00:00.000Z',
    version,
  };
}

beforeEach(() => {
  mockedApiFetch.mockReset();
});

describe('useUpdateTopic', () => {
  it('with no guard sends the patch byte-identical to today', async () => {
    mockedApiFetch.mockResolvedValue(w('w1', 'mine', 2));
    const { result } = renderHook(() => useUpdateTopic('s1'), {
      wrapper: wrapperFor(makeClient()),
    });
    await act(() => result.current.mutateAsync({ topicId: 'w1', patch: { summary: 'mine' } }));
    expect(mockedApiFetch).toHaveBeenCalledWith('sessions/s1/topics/w1', {
      method: 'PATCH',
      body: JSON.stringify({ summary: 'mine' }),
    });
  });

  it('a guard puts version (and overwrite) into the body', async () => {
    mockedApiFetch.mockResolvedValue(w('w1', 'mine', 2));
    const { result } = renderHook(() => useUpdateTopic('s1'), {
      wrapper: wrapperFor(makeClient()),
    });
    await act(() =>
      result.current.mutateAsync({
        topicId: 'w1',
        patch: { summary: 'mine' },
        guard: { version: 1 },
      }),
    );
    await act(() =>
      result.current.mutateAsync({
        topicId: 'w1',
        patch: { summary: 'mine' },
        guard: { version: 2, overwrite: true },
      }),
    );
    const sent = mockedApiFetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(sent).toEqual([
      { summary: 'mine', version: 1 },
      { summary: 'mine', version: 2, overwrite: true },
    ]);
  });

  it('a version conflict writes current into the cache and invalidates', async () => {
    const client = makeClient();
    client.setQueryData(KEY, [w('w0', 'a', 1), w('w1', 'old', 1)]);
    const current = w('w1', 'theirs', 2);
    const err = new ApiError(409, 'Version conflict.', { detail: 'Version conflict.', current });
    mockedApiFetch.mockRejectedValue(err);
    const { result } = renderHook(() => useUpdateTopic('s1'), { wrapper: wrapperFor(client) });
    await act(() =>
      expect(
        result.current.mutateAsync({
          topicId: 'w1',
          patch: { summary: 'mine' },
          guard: { version: 1 },
        }),
      ).rejects.toBe(err),
    );
    expect(client.getQueryData(KEY)).toEqual([w('w0', 'a', 1), current]);
    expect(client.getQueryState(KEY)?.isInvalidated).toBe(true);
  });

  it('any other error leaves the cache alone', async () => {
    const client = makeClient();
    client.setQueryData(KEY, [w('w1', 'old', 1)]);
    const err = new ApiError(500, 'boom');
    mockedApiFetch.mockRejectedValue(err);
    const { result } = renderHook(() => useUpdateTopic('s1'), { wrapper: wrapperFor(client) });
    await act(() =>
      expect(
        result.current.mutateAsync({ topicId: 'w1', patch: { summary: 'mine' } }),
      ).rejects.toBe(err),
    );
    expect(client.getQueryData(KEY)).toEqual([w('w1', 'old', 1)]);
    expect(client.getQueryState(KEY)?.isInvalidated).toBe(false);
  });
});

describe('useDeleteTopic', () => {
  it('with no guard sends the URL and options byte-identical to today', async () => {
    mockedApiFetch.mockResolvedValue(undefined);
    const { result } = renderHook(() => useDeleteTopic('s1'), {
      wrapper: wrapperFor(makeClient()),
    });
    await act(() => result.current.mutateAsync({ topicId: 'w1' }));
    expect(mockedApiFetch).toHaveBeenCalledWith('sessions/s1/topics/w1', { method: 'DELETE' });
  });

  it('a guard puts ?version=N[&overwrite=1] on the URL', async () => {
    mockedApiFetch.mockResolvedValue(undefined);
    const { result } = renderHook(() => useDeleteTopic('s1'), {
      wrapper: wrapperFor(makeClient()),
    });
    await act(() => result.current.mutateAsync({ topicId: 'w1', guard: { version: 4 } }));
    await act(() =>
      result.current.mutateAsync({ topicId: 'w1', guard: { version: 5, overwrite: true } }),
    );
    expect(mockedApiFetch.mock.calls.map(([url]) => url)).toEqual([
      'sessions/s1/topics/w1?version=4',
      'sessions/s1/topics/w1?version=5&overwrite=1',
    ]);
  });

  it('a version conflict writes current into the cache and invalidates', async () => {
    const client = makeClient();
    client.setQueryData(KEY, [w('w1', 'old', 1)]);
    const current = w('w1', 'theirs', 2);
    const err = new ApiError(409, 'Version conflict.', { detail: 'Version conflict.', current });
    mockedApiFetch.mockRejectedValue(err);
    const { result } = renderHook(() => useDeleteTopic('s1'), { wrapper: wrapperFor(client) });
    await act(() =>
      expect(result.current.mutateAsync({ topicId: 'w1', guard: { version: 1 } })).rejects.toBe(
        err,
      ),
    );
    expect(client.getQueryData(KEY)).toEqual([current]);
    expect(client.getQueryState(KEY)?.isInvalidated).toBe(true);
  });
});
