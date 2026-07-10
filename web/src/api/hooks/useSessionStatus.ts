import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../client';
import type { SessionStatus } from '../types';

// While rolling/recording, the UI has no local clock tick, so a slow poll advances
// the live timecode. Every discrete event/transport/audio/lease change is pushed
// over the session WebSocket (useSessionSocket); idle sessions rely on that alone.
const ROLLING_POLL_MS = 1_200;

export function useSessionStatus(sessionId: string | null) {
  return useQuery({
    queryKey: ['session-status', sessionId],
    queryFn: () => apiFetch<SessionStatus>(`sessions/${sessionId}/status`),
    enabled: Boolean(sessionId),
    refetchInterval: (query) => {
      const status = query.state.data;
      const active = Boolean(status?.is_rolling || status?.audio_recording_lease_alive);
      return active ? ROLLING_POLL_MS : false;
    },
    refetchIntervalInBackground: false,
  });
}
