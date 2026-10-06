import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../client';
import type { SessionTopic, TopicVersionConflict } from '../types';
import { guardBody, type VersionGuard, versionConflictOf, versionQuery } from '../versionConflict';

const key = (sessionId: string) => ['topics', sessionId];

/** Public topics query key, for callers outside this module that need to
 * invalidate the same cache entry (e.g. `AiChat`'s `create_topic` tool-event
 * liveness refresh — ai-topics-chat design D9). Keep this the single source
 * of truth for the key shape so it can't drift from the internal `key()`. */
export const topicsQueryKey = key;

export function useTopics(sessionId: string | null) {
  return useQuery({
    queryKey: key(sessionId ?? ''),
    queryFn: () =>
      apiFetch<{ topics: SessionTopic[] }>(`sessions/${sessionId}/topics`).then((r) => r.topics),
    enabled: Boolean(sessionId),
    // Match useTranscriptWords: AI-derived content, refreshed via mutation invalidation.
    staleTime: 30_000,
  });
}

export function useGenerateTopics(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ topics: SessionTopic[] }>(`sessions/${sessionId}/topics/generate`, {
        method: 'POST',
      }).then((r) => r.topics),
    onSuccess: () => qc.invalidateQueries({ queryKey: key(sessionId) }),
  });
}

export function useInsertTopic(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      session_time?: string;
      duration_sec?: number;
      topic_level?: number;
      summary?: string;
    }) =>
      apiFetch<SessionTopic>(`sessions/${sessionId}/topics`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key(sessionId) }),
  });
}

/**
 * session-edit-conflicts D8: on a version-conflict 409 the server's `current` row replaces the
 * cached row (by `id`), then the query is invalidated. The cache holds server truth; the
 * person's text lives only in their draft. Any other error leaves the cache alone. The error
 * still reaches the caller either way.
 */
function useConflictWriter(sessionId: string) {
  const qc = useQueryClient();
  return (error: unknown) => {
    const conflict = versionConflictOf<TopicVersionConflict>(error);
    if (!conflict) return;
    const { current } = conflict;
    qc.setQueryData<SessionTopic[]>(key(sessionId), (old) =>
      old?.map((r) => (r.id === current.id ? current : r)),
    );
    // Not awaited: the caller's conflict prompt must not wait for the refetch.
    void qc.invalidateQueries({ queryKey: key(sessionId) });
  };
}

export function useUpdateTopic(sessionId: string) {
  const qc = useQueryClient();
  const onConflict = useConflictWriter(sessionId);
  return useMutation({
    mutationFn: ({
      topicId,
      patch,
      guard,
    }: {
      topicId: string;
      guard?: VersionGuard;
      patch: {
        session_time?: string;
        duration_sec?: number;
        topic_level?: number;
        summary?: string;
      };
    }) =>
      apiFetch<SessionTopic>(`sessions/${sessionId}/topics/${topicId}`, {
        method: 'PATCH',
        body: JSON.stringify({ ...patch, ...guardBody(guard) }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key(sessionId) }),
    onError: onConflict,
  });
}

export function useDeleteTopic(sessionId: string) {
  const qc = useQueryClient();
  const onConflict = useConflictWriter(sessionId);
  return useMutation({
    mutationFn: ({ topicId, guard }: { topicId: string; guard?: VersionGuard }) =>
      apiFetch<void>(`sessions/${sessionId}/topics/${topicId}${versionQuery(guard)}`, {
        method: 'DELETE',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key(sessionId) }),
    onError: onConflict,
  });
}
