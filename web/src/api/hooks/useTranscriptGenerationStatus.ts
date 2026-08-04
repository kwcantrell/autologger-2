import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../client';

/** apiFetch path segment for `GET /api/transcript-generation/status`. */
export const TRANSCRIPT_GENERATION_STATUS_PATH = 'transcript-generation/status';

const BUSY_POLL_MS = 2_000;
const IDLE_POLL_MS = 10_000;

export type TranscriptGenerationStatusIdle = { in_flight: false };

/** Busy status. `session_id`/`session_title` are BOTH null when the holder
 * belongs to a studio the requester is not a member of — the server redacts
 * the identifiers but still reports busy-ness (and `started_at`) truthfully. */
export type TranscriptGenerationStatusBusy = {
  in_flight: true;
  session_id: string | null;
  session_title: string | null;
  started_at: string;
};

export type TranscriptGenerationStatus =
  | TranscriptGenerationStatusIdle
  | TranscriptGenerationStatusBusy;

export function useTranscriptGenerationStatus() {
  return useQuery({
    queryKey: [TRANSCRIPT_GENERATION_STATUS_PATH],
    queryFn: () => apiFetch<TranscriptGenerationStatus>(TRANSCRIPT_GENERATION_STATUS_PATH),
    refetchInterval: (query) => {
      const data = query.state.data;
      return data?.in_flight ? BUSY_POLL_MS : IDLE_POLL_MS;
    },
    refetchIntervalInBackground: false,
  });
}

/** mm:ss elapsed from a UTC ISO `started_at` instant. */
export function formatTranscriptGenerationElapsed(startedAtIso: string, nowMs: number): string {
  const startedMs = Date.parse(startedAtIso);
  if (Number.isNaN(startedMs)) return '00:00';
  const elapsedSec = Math.max(0, Math.floor((nowMs - startedMs) / 1000));
  const m = Math.floor(elapsedSec / 60);
  const s = elapsedSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
