import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../client';
import type { TransportStartResponse, TransportStopResponse } from '../types';
import { eventsKeys } from './useEvents';
import { sessionStatusKeys } from './useSessionStatus';

export function useTransport(sessionId: string) {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: sessionStatusKeys.bySession(sessionId) });
    qc.invalidateQueries({ queryKey: eventsKeys.all(sessionId) });
  };
  const start = useMutation({
    mutationFn: () =>
      apiFetch<TransportStartResponse>(`sessions/${sessionId}/transport/start`, { method: 'POST' }),
    onSuccess: invalidate,
  });
  const stop = useMutation({
    mutationFn: () =>
      apiFetch<TransportStopResponse>(`sessions/${sessionId}/transport/stop`, { method: 'POST' }),
    onSuccess: invalidate,
  });
  return { start, stop };
}
