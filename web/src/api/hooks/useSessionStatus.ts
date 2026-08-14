import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../client';
import type { SessionStatus } from '../types';

// While rolling/recording, the UI has no local clock tick, so a slow poll advances
// the live timecode. Every discrete event/transport/audio/lease change is pushed
// over the session WebSocket (useSessionSocket); idle sessions rely on that alone.
const ROLLING_POLL_MS = 1_200;

/**
 * Query-key factory for the session-status domain (code-health-tail task 4.6,
 * finding 2.8) — the single owner of the `'session-status'` literal, guarded
 * by `queryKeyFactories.repo.test.ts`. `bySession(...)` is the per-session
 * entry every reader/invalidator uses; `all()` is the bare prefix
 * (HomeSettingsModal invalidates every session's status after a settings
 * save, via React Query prefix matching).
 */
export const sessionStatusKeys = {
  all: () => ['session-status'] as const,
  bySession: (sessionId: string | null) => ['session-status', sessionId] as const,
};

export function useSessionStatus(sessionId: string | null) {
  return useQuery({
    queryKey: sessionStatusKeys.bySession(sessionId),
    queryFn: () => apiFetch<SessionStatus>(`sessions/${sessionId}/status`),
    enabled: Boolean(sessionId),
    // Absorbs the rail's late same-key observer (RecentSessionsList) under the
    // global staleTime:0 default; the rolling refetchInterval and WS
    // invalidations bypass staleness, so freshness is unchanged.
    staleTime: 2_000,
    refetchInterval: (query) => {
      const status = query.state.data;
      const active = Boolean(status?.is_rolling || status?.audio_recording_lease_alive);
      return active ? ROLLING_POLL_MS : false;
    },
    refetchIntervalInBackground: false,
  });
}
