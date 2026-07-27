import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../client';
import type { EventsResponse, EventUpdateBody, LogBody, LogEvent } from '../types';

/**
 * Query-key factory for the events domain. Pages cache under `page(...)`;
 * mutations (and the events_stream_revision watcher) invalidate the `all(...)`
 * prefix, which matches every page variant via React Query prefix matching.
 */
/**
 * Widest events page the session workspace fetches. `limit` is part of the
 * React Query key, so every full-session consumer (SessionWorkspace,
 * MarkerNav, useRecoveryStopWarning) MUST use this same value to dedupe onto
 * one cache entry — a divergent limit is a second full fetch AND, if smaller,
 * navigation that cannot reach markers the timeline renders.
 */
export const WORKSPACE_EVENTS_LIMIT = 2000;

export const eventsKeys = {
  all: (sessionId: string | null) => ['events', sessionId] as const,
  page: (sessionId: string | null, offset: number, limit: number) =>
    ['events', sessionId, offset, limit] as const,
};

export function useEvents(
  sessionId: string | null,
  opts: { limit?: number; offset?: number; refetchInterval?: number | false } = {},
) {
  const limit = opts.limit ?? 200;
  const offset = opts.offset ?? 0;
  return useQuery({
    queryKey: eventsKeys.page(sessionId, offset, limit),
    queryFn: () =>
      apiFetch<EventsResponse>(`sessions/${sessionId}/events?limit=${limit}&offset=${offset}`),
    enabled: Boolean(sessionId),
    staleTime: 0,
    placeholderData: keepPreviousData,
    refetchInterval: opts.refetchInterval,
  });
}

export function useLogEvent(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: LogBody) =>
      apiFetch<LogEvent>(`sessions/${sessionId}/events`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: eventsKeys.all(sessionId) }),
  });
}

export function useUpdateEvent(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ eventId, body }: { eventId: string; body: EventUpdateBody }) =>
      apiFetch<LogEvent>(`sessions/${sessionId}/events/${eventId}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: eventsKeys.all(sessionId) }),
  });
}

export function useDeleteEvent(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (eventId: string) =>
      apiFetch<{ ok: boolean }>(`sessions/${sessionId}/events/${eventId}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: eventsKeys.all(sessionId) }),
  });
}
