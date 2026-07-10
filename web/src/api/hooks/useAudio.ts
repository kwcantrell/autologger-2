import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../client';
import type {
  AudioRecordingLeaseBody,
  AudioSegment,
  AudioSegmentsResponse,
  AudioSegmentWaveformBody,
  SessionStatus,
} from '../types';

export function useAudioSegments(sessionId: string | null) {
  return useQuery({
    queryKey: ['audio-segments', sessionId],
    queryFn: () => apiFetch<AudioSegmentsResponse>(`sessions/${sessionId}/audio/segments`),
    enabled: Boolean(sessionId),
  });
}

export function useClaimAudioLease(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AudioRecordingLeaseBody) =>
      apiFetch<{ ok: boolean }>(`sessions/${sessionId}/audio-recording-lease`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    // Optimistically reflect the lease in the status cache so consumers (e.g.
    // recovery-stop warning) see lease_alive synchronously, ahead of the next poll.
    onSuccess: (_data, body) => {
      qc.setQueryData<SessionStatus | undefined>(['session-status', sessionId], (prev) =>
        prev
          ? {
              ...prev,
              audio_recording_lease_alive: true,
              audio_recording_lease_holder_id: body.client_id,
            }
          : prev,
      );
    },
  });
}

export function useHeartbeatAudioLease(sessionId: string) {
  return useMutation({
    mutationFn: (body: AudioRecordingLeaseBody) =>
      apiFetch<{ ok: boolean }>(`sessions/${sessionId}/audio-recording-lease/heartbeat`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  });
}

export function useReleaseAudioLease(sessionId: string) {
  return useMutation({
    mutationFn: (body: AudioRecordingLeaseBody) =>
      apiFetch<{ ok: boolean }>(`sessions/${sessionId}/audio-recording-lease/release`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  });
}

export function useUploadWaveform(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ segmentId, body }: { segmentId: string; body: AudioSegmentWaveformBody }) =>
      apiFetch<{ ok: boolean }>(`sessions/${sessionId}/audio/segments/${segmentId}/waveform`, {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['audio-segments', sessionId] }),
  });
}

export function useUploadAudioSegment(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      blob,
      startedAtUtc,
      endedAtUtc,
      ordinal,
    }: {
      blob: Blob;
      startedAtUtc: string;
      endedAtUtc: string;
      ordinal: number;
    }) => {
      const params = new URLSearchParams({
        started_at_utc: startedAtUtc,
        ended_at_utc: endedAtUtc,
        recording_ordinal: String(ordinal),
      });
      return apiFetch<AudioSegment>(`sessions/${sessionId}/audio/segments?${params.toString()}`, {
        method: 'POST',
        headers: { 'Content-Type': blob.type || 'audio/webm' },
        body: blob,
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['audio-segments', sessionId] }),
  });
}
