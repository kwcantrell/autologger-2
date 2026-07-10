import { forwardRef, useCallback, useEffect, useImperativeHandle, useReducer, useRef } from 'react';
import { API_ROOT } from '../../../api/client';
import {
  useAudioSegments,
  useClaimAudioLease,
  useHeartbeatAudioLease,
  useReleaseAudioLease,
  useUploadAudioSegment,
  useUploadWaveform,
} from '../../../api/hooks/useAudio';
import { useLogEvent } from '../../../api/hooks/useEvents';
import { showToast as appShowToast } from '../../../shared/components/Toast';
import { getClientInstanceId } from '../../../shared/utils/clientId';
import { computeDbPeaks01 } from '../../../shared/utils/waveformDecode';

const WF_DB_FLOOR = -48;
const HEARTBEAT_INTERVAL_MS = 8_000;
const WF_BUCKET_COUNT = 800;

type Phase = 'idle' | 'claiming' | 'recording' | 'stopping' | 'uploading';

interface State {
  phase: Phase;
  ordinal: number;
  startedAt: string | null;
  stoppedAt: string | null;
}

type Action =
  | { type: 'CLAIM_START' }
  | { type: 'CLAIM_OK'; ordinal: number; startedAt: string }
  | { type: 'STOP_REQUESTED'; stoppedAt: string }
  | { type: 'UPLOAD_START' }
  | { type: 'DONE' }
  | { type: 'ERROR' };

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'CLAIM_START':
      return { ...s, phase: 'claiming' };
    case 'CLAIM_OK':
      return { ...s, phase: 'recording', ordinal: a.ordinal, startedAt: a.startedAt };
    case 'STOP_REQUESTED':
      return { ...s, phase: 'stopping', stoppedAt: a.stoppedAt };
    case 'UPLOAD_START':
      return { ...s, phase: 'uploading' };
    case 'DONE':
    case 'ERROR':
      return { phase: 'idle', ordinal: 1, startedAt: null, stoppedAt: null };
  }
}

export interface AudioRecorderHandle {
  /** Start/stop recording. Resolves false when the lease claim or mic access fails. */
  toggle: () => Promise<boolean>;
  isRecording: () => boolean;
  isUploading: () => boolean;
}

export interface AudioRecorderProps {
  sessionId: string;
  onPhaseChange?: (phase: Phase) => void;
}

export const AudioRecorder = forwardRef<AudioRecorderHandle, AudioRecorderProps>(
  function AudioRecorder({ sessionId, onPhaseChange }, ref) {
    const [state, dispatch] = useReducer(reducer, {
      phase: 'idle',
      ordinal: 1,
      startedAt: null,
      stoppedAt: null,
    });

    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const mediaStreamRef = useRef<MediaStream | null>(null);
    const chunksRef = useRef<Blob[]>([]);
    const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const stateRef = useRef(state);
    stateRef.current = state;

    const { data: segData } = useAudioSegments(sessionId);
    const claimLease = useClaimAudioLease(sessionId);
    const releaseLease = useReleaseAudioLease(sessionId);
    const heartbeat = useHeartbeatAudioLease(sessionId);
    const uploadSegment = useUploadAudioSegment(sessionId);
    const uploadWaveform = useUploadWaveform(sessionId);
    const logEvent = useLogEvent(sessionId);

    const nextOrdinal = (segData?.segments.length ?? 0) + 1;

    const showToast = useCallback((msg: string, isError = false) => {
      appShowToast(msg, isError);
    }, []);

    const stopHeartbeat = useCallback(() => {
      if (heartbeatRef.current != null) {
        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
    }, []);

    const releaseLeaseQuiet = useCallback(async () => {
      try {
        await releaseLease.mutateAsync({ client_id: getClientInstanceId() });
      } catch {
        /* best effort */
      }
    }, [releaseLease]);

    const beaconRelease = useCallback(() => {
      if (typeof navigator.sendBeacon !== 'function') return;
      try {
        const b = new Blob([JSON.stringify({ client_id: getClientInstanceId() })], {
          type: 'application/json',
        });
        // Use raw sendBeacon URL — apiFetch is not available at page hide time
        navigator.sendBeacon(`${API_ROOT}/sessions/${sessionId}/audio-recording-lease/release`, b);
      } catch {
        /* ignore */
      }
    }, [sessionId]);

    const updateRecordingDur = useCallback((startMs: number) => {
      const el = document.getElementById('top-bar-recording-dur');
      if (!el) return;
      const elapsed = Math.floor((Date.now() - startMs) / 1000);
      const h = Math.floor(elapsed / 3600);
      const m = Math.floor((elapsed % 3600) / 60);
      const s = elapsed % 60;
      el.textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }, []);

    const doUpload = useCallback(
      async (blob: Blob, ordinal: number, startedAt: string, stoppedAt: string) => {
        dispatch({ type: 'UPLOAD_START' });
        const showingUi = document.getElementById('timeline-audio-seek-overlay');
        if (showingUi) showingUi.classList.remove('hidden');
        try {
          const seg = await uploadSegment.mutateAsync({
            blob,
            startedAtUtc: startedAt,
            endedAtUtc: stoppedAt,
            ordinal,
          });
          // Compute + persist waveform peaks
          try {
            const AC =
              window.AudioContext ??
              ((window as unknown as Record<string, unknown>)
                .webkitAudioContext as typeof AudioContext);
            if (AC) {
              const ctx = new AC();
              await ctx.resume().catch(() => {});
              const ab = await blob.arrayBuffer();
              const buf = await ctx.decodeAudioData(ab.slice(0));
              const bc = Math.max(200, Math.min(WF_BUCKET_COUNT, Math.round(buf.duration * 20)));
              const peaks = computeDbPeaks01(buf, bc, WF_DB_FLOOR);
              if (peaks.length >= 8) {
                await uploadWaveform.mutateAsync({
                  segmentId: seg.id,
                  body: { peaks: Array.from(peaks) },
                });
              }
            }
          } catch {
            /* waveform is optional */
          }
        } finally {
          if (showingUi) showingUi.classList.add('hidden');
          dispatch({ type: 'DONE' });
        }
      },
      [uploadSegment, uploadWaveform],
    );

    const toggle = useCallback(async (): Promise<boolean> => {
      const { phase } = stateRef.current;

      if (phase === 'recording') {
        // Stop recording
        const stoppedAt = new Date().toISOString();
        dispatch({ type: 'STOP_REQUESTED', stoppedAt });
        stopHeartbeat();
        if (mediaRecorderRef.current?.state === 'recording') {
          mediaRecorderRef.current.stop();
        }
        return true;
      }

      if (phase !== 'idle') return false;

      dispatch({ type: 'CLAIM_START' });
      const cid = getClientInstanceId();
      const ordinal = nextOrdinal;
      const startedAt = new Date().toISOString();

      try {
        await claimLease.mutateAsync({ client_id: cid });
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Could not claim recording lease.');
        dispatch({ type: 'ERROR' });
        return false;
      }

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        await releaseLeaseQuiet();
        showToast(err instanceof Error ? err.message : 'Microphone access denied.');
        dispatch({ type: 'ERROR' });
        return false;
      }

      mediaStreamRef.current = stream;
      chunksRef.current = [];
      const mr = new MediaRecorder(stream);
      mediaRecorderRef.current = mr;

      mr.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };

      mr.onstop = async () => {
        const { stoppedAt: st, ordinal: ord } = stateRef.current;
        const mime = mr.mimeType || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type: mime });
        chunksRef.current = [];
        for (const t of mediaStreamRef.current?.getTracks() ?? []) t.stop();
        mediaStreamRef.current = null;
        mediaRecorderRef.current = null;
        stopHeartbeat();

        // Post stopped internal event
        const endIso = st ?? new Date().toISOString();
        try {
          await logEvent.mutateAsync({
            category: 'internal',
            message: `Recording ${ord} Stopped`,
            marked_at_utc: endIso,
          });
        } catch {
          /* best effort */
        }
        await releaseLeaseQuiet();

        // Reset recording-dur display
        const durEl = document.getElementById('top-bar-recording-dur');
        if (durEl) durEl.textContent = '00:00:00';

        if (blob.size > 0) {
          await doUpload(blob, ord, stateRef.current.startedAt ?? startedAt, endIso);
        } else {
          dispatch({ type: 'DONE' });
        }
      };

      mr.start();

      // Start heartbeat
      heartbeatRef.current = setInterval(() => {
        if (stateRef.current.phase !== 'recording') {
          stopHeartbeat();
          return;
        }
        heartbeat.mutate({ client_id: cid });
      }, HEARTBEAT_INTERVAL_MS);

      dispatch({ type: 'CLAIM_OK', ordinal, startedAt });

      // Post started internal event
      try {
        await logEvent.mutateAsync({
          category: 'internal',
          message: `Recording ${ordinal} Started`,
          marked_at_utc: startedAt,
        });
      } catch {
        /* best effort — recording still proceeds */
      }

      // Kick off recording-dur timer
      const startMs = Date.now();
      const durTimer = setInterval(() => {
        if (stateRef.current.phase !== 'recording') {
          clearInterval(durTimer);
          return;
        }
        updateRecordingDur(startMs);
      }, 1_000);

      return true;
    }, [
      nextOrdinal,
      claimLease,
      releaseLeaseQuiet,
      logEvent,
      heartbeat,
      stopHeartbeat,
      doUpload,
      showToast,
      updateRecordingDur,
    ]);

    // Expose handle to parent
    useImperativeHandle(
      ref,
      () => ({
        toggle,
        isRecording: () => stateRef.current.phase === 'recording',
        isUploading: () => stateRef.current.phase === 'uploading',
      }),
      [toggle],
    );

    // Notify parent of phase changes
    useEffect(() => {
      onPhaseChange?.(state.phase);
    }, [state.phase, onPhaseChange]);

    // Update body class for remote-recording CSS
    useEffect(() => {
      const isActive = state.phase === 'recording' || state.phase === 'uploading';
      document.body.classList.toggle('v4-local-recording', isActive);
    }, [state.phase]);

    // Release on page hide / tab close
    useEffect(() => {
      const onHide = () => {
        if (stateRef.current.phase !== 'recording') return;
        stopHeartbeat();
        beaconRelease();
      };
      window.addEventListener('pagehide', onHide);
      return () => window.removeEventListener('pagehide', onHide);
    }, [beaconRelease, stopHeartbeat]);

    // Warn before unload while recording
    useEffect(() => {
      const onBeforeUnload = (e: BeforeUnloadEvent) => {
        if (stateRef.current.phase !== 'recording') return;
        const msg =
          'Audio is still recording. Stop the recording before leaving, or you may lose the latest audio.';
        e.preventDefault();
        e.returnValue = msg;
      };
      window.addEventListener('beforeunload', onBeforeUnload);
      return () => window.removeEventListener('beforeunload', onBeforeUnload);
    }, []);

    // Cleanup on unmount
    useEffect(() => {
      return () => {
        stopHeartbeat();
        if (mediaRecorderRef.current?.state === 'recording') {
          mediaRecorderRef.current.stop();
        }
        for (const t of mediaStreamRef.current?.getTracks() ?? []) t.stop();
      };
    }, [stopHeartbeat]);

    return null;
  },
);
