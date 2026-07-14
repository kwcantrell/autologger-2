import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, apiFetch } from '../client';
import type { NewSessionBody, Session, SessionsResponse, SessionUpdateBody } from '../types';
import { eventsKeys } from './useEvents';

export function useSessions() {
  return useQuery({
    queryKey: ['sessions'],
    queryFn: () => apiFetch<SessionsResponse>('sessions'),
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
  });
}

export const sessionKeys = {
  detail: (sessionId: string) => ['session', sessionId] as const,
};

/**
 * Deep-link resolution result (session-deep-links, design D5). The server
 * masks nonexistent, deleted, and unauthorized ids behind one `404`, so
 * not-found is a *resolved* outcome, not a failure: the queryFn folds it into
 * data instead of throwing. That keeps the two failure classes deterministic —
 * a 404 is never retried into the error state, and a transient error (network,
 * 5xx) is never presented as a missing session.
 */
export type SessionResolution = { kind: 'found'; session: Session } | { kind: 'not-found' };

/**
 * Per-id session query against `GET /api/sessions/:id` — the deep-link
 * resolution source (design D5; NOT the polled sessions list, which is
 * active-show-scoped while authorization is studio-wide).
 *
 * Latched WITHIN A MOUNT by construction: fetched on route entry, then never
 * spontaneously refetched while mounted — no `refetchInterval`,
 * `staleTime: Infinity` (so focus/reconnect revalidation never re-resolve an
 * open workspace out from under the user), plus explicit focus/reconnect
 * opt-outs as belt and braces. Re-resolution while mounted happens only
 * through invalidation (the Restore mutation) or an explicit `refetch()` from
 * the error state.
 *
 * `gcTime: 0` deliberately does NOT extend that latch across route exits: the
 * cache entry is dropped the instant the query unmounts, so every fresh route
 * entry — including re-entering the same id — re-resolves against the server
 * instead of reusing a stale cached result (react-query's default 5-minute
 * gcTime would otherwise let a since-archived/deleted session keep rendering
 * as it was for up to 5 minutes after navigating back to it).
 */
export function useSession(sessionId: string) {
  return useQuery({
    queryKey: sessionKeys.detail(sessionId),
    queryFn: async (): Promise<SessionResolution> => {
      try {
        // Re-encode: the route param arrives decoded, and the API path must
        // carry the id as a single segment (`a/b` must not fan out into some
        // other `/api/sessions/...` route).
        const session = await apiFetch<Session>(`sessions/${encodeURIComponent(sessionId)}`);
        return { kind: 'found', session };
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return { kind: 'not-found' };
        throw err; // non-404: surface as a retryable query error (default retry policy)
      }
    },
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    enabled: sessionId !== '',
  });
}

export function useCreateSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: NewSessionBody) =>
      apiFetch<Session>('sessions', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions'] }),
  });
}

export function useUpdateSession(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SessionUpdateBody) =>
      apiFetch<Session>(`sessions/${sessionId}`, { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions'] }),
  });
}

export function useArchiveSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) =>
      apiFetch<{ ok: boolean }>(`sessions/${sessionId}/archive`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions'] }),
  });
}

export function useRestoreSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) =>
      apiFetch<{ ok: boolean }>(`sessions/${sessionId}/restore`, { method: 'POST' }),
    onSuccess: (_data, sessionId) => {
      qc.invalidateQueries({ queryKey: ['sessions'] });
      // Re-resolve the per-id query: from the archived interstitial, Restore
      // must flip the SAME URL to the workspace with no navigation (design D5).
      qc.invalidateQueries({ queryKey: sessionKeys.detail(sessionId) });
    },
  });
}

export function useDeleteSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) =>
      apiFetch<{ ok: boolean }>(`sessions/${sessionId}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions'] }),
  });
}

export function useYoutubeImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      sessionId,
      url,
      usePublishDate,
    }: {
      sessionId: string;
      url: string;
      usePublishDate: boolean;
    }) =>
      apiFetch<{ ok: boolean }>(`sessions/${sessionId}/youtube-import`, {
        method: 'POST',
        body: JSON.stringify({ url, use_publish_date: usePublishDate }),
      }),
    onSuccess: (_data, { sessionId: sid }) => {
      qc.invalidateQueries({ queryKey: ['sessions'] });
      qc.invalidateQueries({ queryKey: ['audio-segments', sid] });
      qc.invalidateQueries({ queryKey: eventsKeys.all(sid) });
    },
  });
}
