import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../client';
import type {
  AudioRecordingLeaseBody,
  AudioSegmentsResponse,
  AudioSegmentWaveformBody,
  OkResponse,
  SessionStatus,
} from '../types';
import { sessionStatusKeys } from './useSessionStatus';

/**
 * Query-key factory for the audio-segments domain (code-health-tail task 4.6,
 * finding 2.8) — the single owner of the `'audio-segments'` literal, guarded
 * by `queryKeyFactories.repo.test.ts`.
 */
export const audioSegmentsKeys = {
  bySession: (sessionId: string | null) => ['audio-segments', sessionId] as const,
};

export function useAudioSegments(sessionId: string | null) {
  return useQuery({
    queryKey: audioSegmentsKeys.bySession(sessionId),
    queryFn: () => apiFetch<AudioSegmentsResponse>(`sessions/${sessionId}/audio/segments`),
    enabled: Boolean(sessionId),
  });
}

/**
 * Lease request variables: the session travels with each request, not with
 * the hook, because the recorder is not remounted per session and every lease
 * request of a take must go to the take's session (session-leases D7). Only
 * `client_id` is sent as the body.
 */
export type AudioLeaseVars = AudioRecordingLeaseBody & { sessionId: string };

export function useClaimAudioLease() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ sessionId, ...body }: AudioLeaseVars) =>
      apiFetch<OkResponse>(`sessions/${sessionId}/audio-recording-lease`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    // Optimistically reflect the lease in the status cache so consumers (e.g.
    // recovery-stop warning) see lease_alive synchronously, ahead of the next poll.
    onSuccess: (_data, vars) => {
      qc.setQueryData<SessionStatus | undefined>(
        sessionStatusKeys.bySession(vars.sessionId),
        (prev) =>
          prev
            ? {
                ...prev,
                audio_recording_lease_alive: true,
                audio_recording_lease_holder_id: vars.client_id,
              }
            : prev,
      );
    },
  });
}

export function useHeartbeatAudioLease() {
  return useMutation({
    mutationFn: ({ sessionId, ...body }: AudioLeaseVars) =>
      apiFetch<OkResponse>(`sessions/${sessionId}/audio-recording-lease/heartbeat`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  });
}

export function useReleaseAudioLease() {
  return useMutation({
    mutationFn: ({ sessionId, ...body }: AudioLeaseVars) =>
      apiFetch<OkResponse>(`sessions/${sessionId}/audio-recording-lease/release`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  });
}

export function useUploadWaveform(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ segmentId, body }: { segmentId: string; body: AudioSegmentWaveformBody }) =>
      apiFetch<OkResponse>(`sessions/${sessionId}/audio/segments/${segmentId}/waveform`, {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: audioSegmentsKeys.bySession(sessionId) }),
  });
}

// The live-recorder segment upload moved into the chunk upload pipeline
// (chunked-live-recording task 4.2): AudioRecorder.tsx builds the POST
// `…/audio/segments` request in its queue deps, binding each chunk's
// sessionId at recording start rather than a hook's render-time prop.
