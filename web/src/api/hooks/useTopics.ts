import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../client';
import type { SessionTopic } from '../types';

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

export function useUpdateTopic(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      topicId,
      patch,
    }: {
      topicId: string;
      patch: {
        session_time?: string;
        duration_sec?: number;
        topic_level?: number;
        summary?: string;
      };
    }) =>
      apiFetch<SessionTopic>(`sessions/${sessionId}/topics/${topicId}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key(sessionId) }),
  });
}

export function useDeleteTopic(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (topicId: string) =>
      apiFetch<void>(`sessions/${sessionId}/topics/${topicId}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key(sessionId) }),
  });
}
