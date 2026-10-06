import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch } from '../client';
import type { EventsResponse, LogEvent } from '../types';
import { eventsKeys, useDeleteEvent, useUpdateEvent } from './useEvents';

// session-edit-conflicts task 3.1 (design D8): the event update/delete hooks carry an optional
// version guard and, on a version-conflict 409, write the server's `current` row into every
// cached events page and invalidate. `apiFetch` is mocked at the module boundary with the real
// `ApiError`.

vi.mock('../client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../client')>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function wrapperFor(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

function ev(event_id: string, message: string, version: number): LogEvent {
  return {
    event_id,
    category: 'cam',
    category_label: 'Camera',
    category_color: null,
    message,
    timecode: null,
    timecode_total_frames: null,
    frame_rate: null,
    wall_time_utc: '2026-10-06T10:00:00.000Z',
    metadata: {},
    version,
  };
}

function page(events: LogEvent[]): EventsResponse {
  return {
    events,
    total: events.length,
    logged_event_count: events.length,
    offset: 0,
    limit: 200,
    has_auto_generated: false,
  };
}

const body = {
  category: 'cam',
  message: 'mine',
  wall_time_utc: '2026-10-06T10:00:00.000Z',
  timecode_hms: '00:00:01',
};

beforeEach(() => {
  mockedApiFetch.mockReset();
});

describe('useUpdateEvent', () => {
  it('with no guard sends the body byte-identical to today', async () => {
    mockedApiFetch.mockResolvedValue(ev('e1', 'mine', 2));
    const { result } = renderHook(() => useUpdateEvent('s1'), {
      wrapper: wrapperFor(makeClient()),
    });
    await act(() => result.current.mutateAsync({ eventId: 'e1', body }));
    expect(mockedApiFetch).toHaveBeenCalledWith('sessions/s1/events/e1', {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  });

  it('a guard puts version (and overwrite) into the body', async () => {
    mockedApiFetch.mockResolvedValue(ev('e1', 'mine', 2));
    const { result } = renderHook(() => useUpdateEvent('s1'), {
      wrapper: wrapperFor(makeClient()),
    });
    await act(() => result.current.mutateAsync({ eventId: 'e1', body, guard: { version: 1 } }));
    await act(() =>
      result.current.mutateAsync({ eventId: 'e1', body, guard: { version: 3, overwrite: true } }),
    );
    const sent = mockedApiFetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(sent[0]).toEqual({ ...body, version: 1 });
    expect(sent[1]).toEqual({ ...body, version: 3, overwrite: true });
  });

  it('a version conflict writes current into every cached page of the session and invalidates', async () => {
    const client = makeClient();
    const k200 = eventsKeys.page('s1', 0, 200);
    const k2000 = eventsKeys.page('s1', 0, 2000);
    const other = eventsKeys.page('s2', 0, 200);
    client.setQueryData(k200, page([ev('e0', 'a', 1), ev('e1', 'old', 1)]));
    client.setQueryData(k2000, page([ev('e1', 'old', 1)]));
    client.setQueryData(other, page([ev('e1', 'old', 1)]));
    const current = ev('e1', 'theirs', 2);
    const err = new ApiError(409, 'Version conflict.', { detail: 'Version conflict.', current });
    mockedApiFetch.mockRejectedValue(err);
    const { result } = renderHook(() => useUpdateEvent('s1'), { wrapper: wrapperFor(client) });
    await act(() =>
      expect(
        result.current.mutateAsync({ eventId: 'e1', body, guard: { version: 1 } }),
      ).rejects.toBe(err),
    );
    expect(client.getQueryData<EventsResponse>(k200)?.events).toEqual([ev('e0', 'a', 1), current]);
    expect(client.getQueryData<EventsResponse>(k2000)?.events).toEqual([current]);
    expect(client.getQueryData<EventsResponse>(other)?.events).toEqual([ev('e1', 'old', 1)]);
    expect(client.getQueryState(k200)?.isInvalidated).toBe(true);
    expect(client.getQueryState(k2000)?.isInvalidated).toBe(true);
    expect(client.getQueryState(other)?.isInvalidated).toBe(false);
  });

  it('any other error leaves the cache alone', async () => {
    const client = makeClient();
    const k = eventsKeys.page('s1', 0, 200);
    client.setQueryData(k, page([ev('e1', 'old', 1)]));
    const err = new ApiError(409, 'Something else.', {
      detail: 'Something else.',
      current: ev('e1', 'x', 2),
    });
    mockedApiFetch.mockRejectedValue(err);
    const { result } = renderHook(() => useUpdateEvent('s1'), { wrapper: wrapperFor(client) });
    await act(() => expect(result.current.mutateAsync({ eventId: 'e1', body })).rejects.toBe(err));
    expect(client.getQueryData<EventsResponse>(k)?.events).toEqual([ev('e1', 'old', 1)]);
    expect(client.getQueryState(k)?.isInvalidated).toBe(false);
  });
});

describe('useDeleteEvent', () => {
  it('with no guard sends the URL and options byte-identical to today', async () => {
    mockedApiFetch.mockResolvedValue({ ok: true });
    const { result } = renderHook(() => useDeleteEvent('s1'), {
      wrapper: wrapperFor(makeClient()),
    });
    await act(() => result.current.mutateAsync({ eventId: 'e1' }));
    expect(mockedApiFetch).toHaveBeenCalledWith('sessions/s1/events/e1', { method: 'DELETE' });
  });

  it('a guard puts ?version=N[&overwrite=1] on the URL', async () => {
    mockedApiFetch.mockResolvedValue({ ok: true });
    const { result } = renderHook(() => useDeleteEvent('s1'), {
      wrapper: wrapperFor(makeClient()),
    });
    await act(() => result.current.mutateAsync({ eventId: 'e1', guard: { version: 4 } }));
    await act(() =>
      result.current.mutateAsync({ eventId: 'e1', guard: { version: 5, overwrite: true } }),
    );
    expect(mockedApiFetch.mock.calls.map(([url]) => url)).toEqual([
      'sessions/s1/events/e1?version=4',
      'sessions/s1/events/e1?version=5&overwrite=1',
    ]);
  });

  it('a version conflict writes current into the cache and invalidates', async () => {
    const client = makeClient();
    const k = eventsKeys.page('s1', 0, 200);
    client.setQueryData(k, page([ev('e1', 'old', 1)]));
    const current = ev('e1', 'theirs', 2);
    const err = new ApiError(409, 'Version conflict.', { detail: 'Version conflict.', current });
    mockedApiFetch.mockRejectedValue(err);
    const { result } = renderHook(() => useDeleteEvent('s1'), { wrapper: wrapperFor(client) });
    await act(() =>
      expect(result.current.mutateAsync({ eventId: 'e1', guard: { version: 1 } })).rejects.toBe(
        err,
      ),
    );
    expect(client.getQueryData<EventsResponse>(k)?.events).toEqual([current]);
    expect(client.getQueryState(k)?.isInvalidated).toBe(true);
  });
});
