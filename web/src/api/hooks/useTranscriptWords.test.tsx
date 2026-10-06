import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch } from '../client';
import type { TranscriptWord } from '../types';
import { useDeleteTranscriptWord, useUpdateTranscriptWord } from './useTranscriptWords';

// session-edit-conflicts task 3.1 (design D8): the word update/delete hooks carry an optional
// version guard and, on a version-conflict 409, write the server's `current` row into the
// words cache and invalidate.

vi.mock('../client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../client')>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);
const KEY = ['transcript-words', 's1'];

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function wrapperFor(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

function w(id: string, word: string, version: number): TranscriptWord {
  return {
    id,
    session_time: '00:00:01:00',
    speaker: '0',
    word,
    start_sec: 1,
    end_sec: 1.5,
    ordinal: 0,
    version,
  };
}

beforeEach(() => {
  mockedApiFetch.mockReset();
});

describe('useUpdateTranscriptWord', () => {
  it('with no guard sends the patch byte-identical to today', async () => {
    mockedApiFetch.mockResolvedValue(w('w1', 'mine', 2));
    const { result } = renderHook(() => useUpdateTranscriptWord('s1'), {
      wrapper: wrapperFor(makeClient()),
    });
    await act(() => result.current.mutateAsync({ wordId: 'w1', patch: { word: 'mine' } }));
    expect(mockedApiFetch).toHaveBeenCalledWith('sessions/s1/transcript-words/w1', {
      method: 'PATCH',
      body: JSON.stringify({ word: 'mine' }),
    });
  });

  it('a guard puts version (and overwrite) into the body', async () => {
    mockedApiFetch.mockResolvedValue(w('w1', 'mine', 2));
    const { result } = renderHook(() => useUpdateTranscriptWord('s1'), {
      wrapper: wrapperFor(makeClient()),
    });
    await act(() =>
      result.current.mutateAsync({ wordId: 'w1', patch: { word: 'mine' }, guard: { version: 1 } }),
    );
    await act(() =>
      result.current.mutateAsync({
        wordId: 'w1',
        patch: { word: 'mine' },
        guard: { version: 2, overwrite: true },
      }),
    );
    const sent = mockedApiFetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(sent).toEqual([
      { word: 'mine', version: 1 },
      { word: 'mine', version: 2, overwrite: true },
    ]);
  });

  it('a version conflict writes current into the cache and invalidates', async () => {
    const client = makeClient();
    client.setQueryData(KEY, [w('w0', 'a', 1), w('w1', 'old', 1)]);
    const current = w('w1', 'theirs', 2);
    const err = new ApiError(409, 'Version conflict.', { detail: 'Version conflict.', current });
    mockedApiFetch.mockRejectedValue(err);
    const { result } = renderHook(() => useUpdateTranscriptWord('s1'), {
      wrapper: wrapperFor(client),
    });
    await act(() =>
      expect(
        result.current.mutateAsync({
          wordId: 'w1',
          patch: { word: 'mine' },
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
    const { result } = renderHook(() => useUpdateTranscriptWord('s1'), {
      wrapper: wrapperFor(client),
    });
    await act(() =>
      expect(result.current.mutateAsync({ wordId: 'w1', patch: { word: 'mine' } })).rejects.toBe(
        err,
      ),
    );
    expect(client.getQueryData(KEY)).toEqual([w('w1', 'old', 1)]);
    expect(client.getQueryState(KEY)?.isInvalidated).toBe(false);
  });
});

describe('useDeleteTranscriptWord', () => {
  it('with no guard sends the URL and options byte-identical to today', async () => {
    mockedApiFetch.mockResolvedValue(undefined);
    const { result } = renderHook(() => useDeleteTranscriptWord('s1'), {
      wrapper: wrapperFor(makeClient()),
    });
    await act(() => result.current.mutateAsync({ wordId: 'w1' }));
    expect(mockedApiFetch).toHaveBeenCalledWith('sessions/s1/transcript-words/w1', {
      method: 'DELETE',
    });
  });

  it('a guard puts ?version=N[&overwrite=1] on the URL', async () => {
    mockedApiFetch.mockResolvedValue(undefined);
    const { result } = renderHook(() => useDeleteTranscriptWord('s1'), {
      wrapper: wrapperFor(makeClient()),
    });
    await act(() => result.current.mutateAsync({ wordId: 'w1', guard: { version: 4 } }));
    await act(() =>
      result.current.mutateAsync({ wordId: 'w1', guard: { version: 5, overwrite: true } }),
    );
    expect(mockedApiFetch.mock.calls.map(([url]) => url)).toEqual([
      'sessions/s1/transcript-words/w1?version=4',
      'sessions/s1/transcript-words/w1?version=5&overwrite=1',
    ]);
  });

  it('a version conflict writes current into the cache and invalidates', async () => {
    const client = makeClient();
    client.setQueryData(KEY, [w('w1', 'old', 1)]);
    const current = w('w1', 'theirs', 2);
    const err = new ApiError(409, 'Version conflict.', { detail: 'Version conflict.', current });
    mockedApiFetch.mockRejectedValue(err);
    const { result } = renderHook(() => useDeleteTranscriptWord('s1'), {
      wrapper: wrapperFor(client),
    });
    await act(() =>
      expect(result.current.mutateAsync({ wordId: 'w1', guard: { version: 1 } })).rejects.toBe(err),
    );
    expect(client.getQueryData(KEY)).toEqual([current]);
    expect(client.getQueryState(KEY)?.isInvalidated).toBe(true);
  });
});
