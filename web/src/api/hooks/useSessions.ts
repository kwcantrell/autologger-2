import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../client';
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
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions'] }),
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
