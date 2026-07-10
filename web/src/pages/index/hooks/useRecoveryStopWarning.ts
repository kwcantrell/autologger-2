import { useEffect, useRef } from 'react';
import { apiFetch } from '../../../api/client';
import { useEvents } from '../../../api/hooks/useEvents';
import { useSessionStatus } from '../../../api/hooks/useSessionStatus';
import { findOrphanRecording } from '../../../shared/utils/recording';
import { formatTimecodeHMS } from '../../../shared/utils/timecode';

declare global {
  interface Window {
    AutoLogger_invalidateEvents?: () => void;
  }
}

export function useRecoveryStopWarning(sessionId: string | null, blocksMedia: boolean): void {
  const { data: eventsRes } = useEvents(sessionId, { limit: 2000 });
  const { data: status } = useSessionStatus(sessionId);
  const warnedRef = useRef(false);
  const inFlightRef = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on session switch
  useEffect(() => {
    warnedRef.current = false;
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || !eventsRes || !status || blocksMedia) return;
    if (status.audio_recording_lease_alive) return;
    if (warnedRef.current || inFlightRef.current) return;
    const orphan = findOrphanRecording(eventsRes.events ?? [], status);
    if (!orphan) return;
    warnedRef.current = true;
    const nowTc = formatTimecodeHMS(status?.timecode ?? '00:00:00');
    const ok = window.confirm(
      `The session log shows an audio recording with no matching stop event (last segment around ${orphan.lastEndDisplay}).\n\nIf another window, tab, or user is still recording this session, click Cancel — do not add a stop from here.\n\nClick OK only if that recording truly ended without logging a stop (for example after a crash), and you want to add a synthetic stop at ${nowTc} to fix the log.`,
    );
    if (!ok) return;
    inFlightRef.current = true;
    apiFetch(`sessions/${encodeURIComponent(sessionId)}/events`, {
      method: 'POST',
      body: JSON.stringify({
        category: 'internal',
        message: `Recording ${orphan.orphanOrdinal} Stopped`,
        marked_at_utc: new Date().toISOString(),
        metadata: {},
      }),
    })
      .catch(() => {
        /* best effort */
      })
      .finally(() => {
        inFlightRef.current = false;
        window.AutoLogger_invalidateEvents?.();
      });
  }, [sessionId, eventsRes, blocksMedia, status]);
}
