import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../../../api/client';
import { useEvents } from '../../../api/hooks/useEvents';
import { useSessionStatus } from '../../../api/hooks/useSessionStatus';
import { findOrphanRecording, type OrphanRecording } from '../../../shared/utils/recording';

declare global {
  interface Window {
    AutoLogger_invalidateEvents?: () => void;
  }
}

/**
 * A pending recovery-stop decision, exposed so the caller can render it through the
 * themed `ConfirmDialog` (ui-refresh D13) instead of the blocking `window.confirm`
 * this replaces. `window.confirm` blocked the event loop, so its accept was atomic
 * with the data it was shown against; a themed dialog is NOT blocking, so a real
 * window opens between "shown" and "decided" — `onAccept` below re-validates
 * against the latest data before posting anything.
 */
export interface RecoveryStopPendingDecision {
  title: string;
  message: string;
  onAccept: () => void;
  onDecline: () => void;
}

export function useRecoveryStopWarning(
  sessionId: string | null,
  blocksMedia: boolean,
): RecoveryStopPendingDecision | null {
  const { data: eventsRes } = useEvents(sessionId, { limit: 2000 });
  const { data: status } = useSessionStatus(sessionId);
  const warnedRef = useRef(false);
  const inFlightRef = useRef(false);
  const [pending, setPending] = useState<OrphanRecording | null>(null);

  // Reset on session switch: re-arm the once-per-session-mount latch, and dismiss
  // (as decline — nothing posted) any decision still pending from the session
  // being left (spec: "a pending decision SHALL be dismissed on session switch").
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on session switch
  useEffect(() => {
    warnedRef.current = false;
    setPending(null);
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || !eventsRes || !status || blocksMedia) return;
    if (status.audio_recording_lease_alive) return;
    if (warnedRef.current || inFlightRef.current) return;
    const orphan = findOrphanRecording(eventsRes.events ?? [], status);
    if (!orphan) return;
    // Arms once per session mount: this latch does not re-open on decline, and
    // does not re-open just because the underlying queries refetch.
    warnedRef.current = true;
    setPending(orphan);
  }, [sessionId, eventsRes, blocksMedia, status]);

  // Any dismissal (Escape, overlay click, session switch) is decline: clear the
  // pending decision and post nothing.
  const onDecline = () => setPending(null);

  // Accept re-validates against the CURRENT events/status/lease closed over by
  // THIS render — not the render that armed the dialog — because SessionWorkspace
  // re-renders on every events/status query update, so the closure handed to the
  // rendered dialog is always the latest as of the click. No-op (dismiss only, no
  // post) if the orphan already resolved or another client's lease is now alive.
  const onAccept = () => {
    setPending(null);
    if (!sessionId) return;
    if (status?.audio_recording_lease_alive) return;
    const stillOrphan = findOrphanRecording(eventsRes?.events ?? [], status);
    if (!stillOrphan) return;
    inFlightRef.current = true;
    apiFetch(`sessions/${encodeURIComponent(sessionId)}/events`, {
      method: 'POST',
      body: JSON.stringify({
        category: 'internal',
        message: `Recording ${stillOrphan.orphanOrdinal} Stopped`,
        // Accept-time timestamp (D13): the dialog is non-blocking, so this is
        // computed at the moment of accept, not when the dialog first armed.
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
  };

  if (!pending) return null;

  return {
    title: 'Unresolved recording',
    // Copy intentionally does not promise a specific timecode for the stop it
    // will add (D13) — the dialog is non-blocking, so "now" isn't fixed at
    // render time; it names the current time only in the abstract.
    message: `The session log shows an audio recording with no matching stop event (last segment around ${pending.lastEndDisplay}). If another window, tab, or user is still recording this session, decline — do not add a stop from here. Accept only if that recording truly ended without logging a stop (for example after a crash); a synthetic stop will be added at the current time to fix the log.`,
    onAccept,
    onDecline,
  };
}
