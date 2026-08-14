import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../client';
import type { TranscriptWord } from '../types';

const key = (sessionId: string) => ['transcript-words', sessionId];

/**
 * The session's transcript words — the largest payload the workspace fetches
 * (multi-MB on a long session).
 *
 * `opts.enabled` lets a caller DEFER that fetch until the words are actually
 * needed (perf plan B4): the workspace keeps every feed panel mounted, so
 * without a gate four always-mounted consumers pulled the whole word list on
 * session mount even when the user never opened Transcript/Topics/Export.
 * Callers that pass nothing keep the old unconditional behaviour — the default
 * is `true`, so every untouched call site (and its tests) is unaffected. The
 * gate itself lives in the page layer (`TranscriptWordsGateContext`), never
 * here: this hook stays a plain data hook with no knowledge of tabs or
 * dashboards.
 *
 * Note for consumers that gate on loading: a DISABLED pending query reports
 * `isLoading === false` (react-query v5 computes it as `isPending &&
 * isFetching`), so a caller that hides content while loading must use
 * `isPending && <its own enabled flag>` rather than `isLoading` if it wants the
 * enabled-but-not-yet-fetched window to read as "loading".
 */
export function useTranscriptWords(sessionId: string | null, opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: key(sessionId ?? ''),
    queryFn: () =>
      apiFetch<{ words: TranscriptWord[] }>(`sessions/${sessionId}/transcript-words`).then(
        (r) => r.words,
      ),
    enabled: Boolean(sessionId) && (opts?.enabled ?? true),
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
