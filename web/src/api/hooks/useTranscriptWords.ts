import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../client';
import type { TranscriptWord } from '../types';

const key = (sessionId: string) => ['transcript-words', sessionId];

export function useTranscriptWords(sessionId: string | null) {
  return useQuery({
    queryKey: key(sessionId ?? ''),
    queryFn: () =>
      apiFetch<{ words: TranscriptWord[] }>(`sessions/${sessionId}/transcript-words`).then(
        (r) => r.words,
      ),
    enabled: Boolean(sessionId),
    staleTime: 30_000,
  });
}

export function useGenerateTranscript(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ words: TranscriptWord[] }>(`sessions/${sessionId}/transcript-words/generate`, {
        method: 'POST',
      }).then((r) => r.words),
    onSuccess: (words) => qc.setQueryData(key(sessionId), words),
  });
}

export function useInsertTranscriptWord(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { session_time?: string; speaker?: string; word?: string }) =>
      apiFetch<TranscriptWord>(`sessions/${sessionId}/transcript-words`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key(sessionId) }),
  });
}

export function useUpdateTranscriptWord(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      wordId,
      patch,
    }: {
      wordId: string;
      patch: { session_time?: string; speaker?: string; word?: string };
    }) =>
      apiFetch<TranscriptWord>(`sessions/${sessionId}/transcript-words/${wordId}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key(sessionId) }),
  });
}

export function useDeleteTranscriptWord(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (wordId: string) =>
      apiFetch<void>(`sessions/${sessionId}/transcript-words/${wordId}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key(sessionId) }),
  });
}
