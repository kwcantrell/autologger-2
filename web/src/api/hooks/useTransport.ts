import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../client';
import { eventsKeys } from './useEvents';

export function useTransport(sessionId: string) {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['session-status', sessionId] });
    qc.invalidateQueries({ queryKey: eventsKeys.all(sessionId) });
  };
  const start = useMutation({
    mutationFn: () =>
      apiFetch<{ ok: boolean }>(`sessions/${sessionId}/transport/start`, { method: 'POST' }),
    onSuccess: invalidate,
  });
  const stop = useMutation({
    mutationFn: () =>
      apiFetch<{ ok: boolean }>(`sessions/${sessionId}/transport/stop`, { method: 'POST' }),
    onSuccess: invalidate,
  });
  return { start, stop };
}
