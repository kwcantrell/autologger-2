import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../client';
import type {
  EventsGenerateBody,
  EventsGenerateResponse,
  EventsResponse,
  EventUpdateBody,
  EventVersionConflict,
  LogBody,
  LogEvent,
  OkResponse,
} from '../types';
import { guardBody, type VersionGuard, versionConflictOf, versionQuery } from '../versionConflict';

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

/**
 * `POST …/events/generate` — one synchronous AI generation run
 * (auto-generate-event-logs design D9). Void-variables mutation, matching
 * `useGenerateTopics`, so it slots straight into `useGatedGenerate`'s
 * `GenerateMutate` shape. The optional body selects append-all, regenerate-all,
 * or a custom instruction subset. The run's inserted rows reach the feed live via the
 * existing `event.changed`-driven refetch; the on-success invalidation is
 * belt-and-braces for the terminal state. `sessionId` is captured by the
 * `mutationFn` closure at mutate time, so a session switch mid-run cannot
 * redirect the in-flight request; the run always completes server-side (the
 * route takes no abort signal).
 */
export function useGenerateEvents(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body?: EventsGenerateBody) =>
      apiFetch<EventsGenerateResponse>(`sessions/${sessionId}/events/generate`, {
        method: 'POST',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: eventsKeys.all(sessionId) }),
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

/**
 * session-edit-conflicts D8: on a version-conflict 409 the server's `current` row replaces the
 * cached row (by `event_id`) in every events page of the session, then the pages are
 * invalidated. The cache holds server truth; the person's text lives only in their draft. Any
 * other error leaves the cache alone. The error still reaches the caller either way.
 */
function useEventConflictWriter(sessionId: string) {
  const qc = useQueryClient();
  return (error: unknown) => {
    const conflict = versionConflictOf<EventVersionConflict>(error);
    if (!conflict) return;
    const { current } = conflict;
    qc.setQueriesData<EventsResponse>({ queryKey: eventsKeys.all(sessionId) }, (old) =>
      old?.events
        ? {
            ...old,
            events: old.events.map((e) => (e.event_id === current.event_id ? current : e)),
          }
        : old,
    );
    // Not awaited: the caller's conflict prompt must not wait for the refetch.
    void qc.invalidateQueries({ queryKey: eventsKeys.all(sessionId) });
  };
}

export function useUpdateEvent(sessionId: string) {
  const qc = useQueryClient();
  const onConflict = useEventConflictWriter(sessionId);
  return useMutation({
    mutationFn: ({
      eventId,
      body,
      guard,
    }: {
      eventId: string;
      body: EventUpdateBody;
      guard?: VersionGuard;
    }) =>
      apiFetch<LogEvent>(`sessions/${sessionId}/events/${eventId}`, {
        method: 'PUT',
        body: JSON.stringify({ ...body, ...guardBody(guard) }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: eventsKeys.all(sessionId) }),
    onError: onConflict,
  });
}

export function useDeleteEvent(sessionId: string) {
  const qc = useQueryClient();
  const onConflict = useEventConflictWriter(sessionId);
  return useMutation({
    mutationFn: ({ eventId, guard }: { eventId: string; guard?: VersionGuard }) =>
      apiFetch<OkResponse>(`sessions/${sessionId}/events/${eventId}${versionQuery(guard)}`, {
        method: 'DELETE',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: eventsKeys.all(sessionId) }),
    onError: onConflict,
  });
}
