import { useQueryClient } from '@tanstack/react-query';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useReducer,
  useRef,
  useState,
} from 'react';
import { API_ROOT, ApiError } from '../../../api/client';
import {
  audioSegmentsKeys,
  useAudioSegments,
  useClaimAudioLease,
  useHeartbeatAudioLease,
  useReleaseAudioLease,
} from '../../../api/hooks/useAudio';
import { useEvents, useLogEvent, WORKSPACE_EVENTS_LIMIT } from '../../../api/hooks/useEvents';
import { useProfile } from '../../../api/hooks/useProfile';
import type { AudioSegment, LogEvent, OkResponse } from '../../../api/types';
import { showToast as appShowToast } from '../../../shared/components/Toast';
import { parseRecordingOrdinalFromMessage } from '../../../shared/utils/audioClips';
import { getClientInstanceId } from '../../../shared/utils/clientId';
import { createWorkerInterval, type WorkerInterval } from '../../../shared/utils/workerInterval';
import {
  type ChunkHandle,
  detectSafari,
  getChunkStore,
  setChunkStoreDegradedListener,
} from '../utils/chunkStore';
import {
  type ChunkInput,
  type ChunkQueueSnapshot,
  type ChunkUploadQueue,
  getChunkUploadQueue,
  onChunkConfirmed,
} from '../utils/chunkUploadQueue';
import { devChunkMsOverride } from '../utils/devChunkMs';
import { runMicLevelMeter } from '../utils/micLevelMeter';
import {
  audioTracksOf,
  deviceIdOf,
  MIC_REACQUIRE_WINDOW_MS,
  reacquireMicrophone,
  rolloverAction,
  watchMicrophone,
} from '../utils/micReacquire';
import { browserLockManager, createRecorderLocks } from '../utils/recorderLocks';
import {
  browserWakeLock,
  createWakeLockController,
  type WakeLockController,
} from '../utils/wakeLock';
import { type HiddenInterval, HiddenTabWarning } from './HiddenTabWarning';

const HEARTBEAT_INTERVAL_MS = 8_000;
/** Shown once per lease loss mid-take (session-leases design D7). */
const LEASE_LOST_WARNING = 'Another window, tab, or user now holds the recording lease.';
/**
 * Chunk rollover cadence (chunked-live-recording design D2 — the value is
 * design-owned tuning, deliberately not spec surface): ~10 MB per chunk at
 * Chrome's default Opus bitrate, 5x headroom under the server's 50 MB live
 * segment cap. Tests inject a smaller value via the `chunkMs` prop.
 */
const CHUNK_MS = 10 * 60_000;
/**
 * Timeslice (media-worker design D10, owner answer 3): each slice is appended to the chunk's
 * stored entry, so a crash loses at most about this much audio.
 */
export const PERSIST_SLICE_MS = 5_000;
/**
 * Safari's persistence mode (design D10): `slices` until the owner's Safari check of spike 0.2
 * shows its concatenated slices fail to decode; then `finished-only` (no timeslice, the chunk is
 * persisted when it completes).
 */
export const SAFARI_PERSIST_MODE: 'slices' | 'finished-only' = 'slices';
const SCAN_PENDING_MESSAGE = 'Checking this browser for unsent recordings; try again in a moment.';

type Phase =
  | 'scanning'
  | 'idle'
  | 'claiming'
  | 'recording'
  | 'stopping'
  | 'uploading'
  | 'drain_blocked';

interface State {
  phase: Phase;
  ordinal: number;
  startedAt: string | null;
  stoppedAt: string | null;
}

type Action =
  | { type: 'SCAN_DONE'; blocked: boolean }
  | { type: 'CLAIM_START' }
  | { type: 'CLAIM_OK'; ordinal: number; startedAt: string }
  | { type: 'STOP_REQUESTED'; stoppedAt: string }
  | { type: 'UPLOAD_START' }
  | { type: 'DRAIN_BLOCKED' }
  | { type: 'DONE' }
  | { type: 'ERROR' };

/**
 * Phase machine (chunked-live-recording design D3, binding invariant):
 * mid-take chunk uploads never leave `recording`. `UPLOAD_START` (the final
 * drain) is reachable only from `stopping`, and `DONE` only from the stopped
 * side of the machine. `scanning` (media-worker D10) holds Record until the
 * recovery scan of this browser's chunk store has completed.
 */
function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'SCAN_DONE':
      return s.phase === 'scanning' ? { ...s, phase: a.blocked ? 'drain_blocked' : 'idle' } : s;
    case 'CLAIM_START':
      return { ...s, phase: 'claiming' };
    case 'CLAIM_OK':
      return { ...s, phase: 'recording', ordinal: a.ordinal, startedAt: a.startedAt };
    case 'STOP_REQUESTED':
      return s.phase === 'recording' ? { ...s, phase: 'stopping', stoppedAt: a.stoppedAt } : s;
    case 'UPLOAD_START':
      return s.phase === 'stopping' ? { ...s, phase: 'uploading' } : s;
    case 'DRAIN_BLOCKED':
      return s.phase === 'uploading' ? { ...s, phase: 'drain_blocked' } : s;
    case 'DONE':
      return s.phase === 'stopping' || s.phase === 'uploading' || s.phase === 'drain_blocked'
        ? { phase: 'idle', ordinal: 1, startedAt: null, stoppedAt: null }
        : s;
    case 'ERROR':
      return { phase: 'idle', ordinal: 1, startedAt: null, stoppedAt: null };
  }
}

/**
 * Chunks this tab captured and has not confirmed hold the recorder in
 * `drain_blocked`; chunks recovered from a previous page do not (a new
 * recording may start while they upload, with the next ordinal — D10).
 */
function blocksNewRecording(snapshot: ChunkQueueSnapshot): boolean {
  return snapshot.chunks.some((c) => !c.recovered);
}

function initialState(args: { queue: ChunkUploadQueue; scanned: boolean }): State {
  const blocked = blocksNewRecording(args.queue.getSnapshot());
  const phase: Phase = !args.scanned ? 'scanning' : blocked ? 'drain_blocked' : 'idle';
  return { phase, ordinal: 1, startedAt: null, stoppedAt: null };
}

/**
 * Next recording ordinal (design D8): strictly greater than every ordinal
 * already used in the session — segments, `Recording N` events, and ordinals
 * held by the upload queue (recovered chunks included, media-worker D10).
 */
export function deriveNextOrdinal(
  segments: readonly Pick<AudioSegment, 'recording_ordinal'>[] | undefined,
  events: readonly Pick<LogEvent, 'category' | 'message'>[] | undefined,
  pendingOrdinals: readonly number[],
): number {
  let max = 0;
  for (const s of segments ?? []) {
    const n = s.recording_ordinal;
    if (typeof n === 'number' && Number.isFinite(n) && n > max) max = n;
  }
  for (const e of events ?? []) {
    if (String(e.category || '').toLowerCase() !== 'internal') continue;
    const n = parseRecordingOrdinalFromMessage(e.message);
    if (n != null && n > max) max = n;
  }
  for (const n of pendingOrdinals) {
    if (n > max) max = n;
  }
  return max + 1;
}

/** One recording ("take") — spans every chunk. Captured at recording start. */
interface ActiveTake {
  sessionId: string;
  ordinal: number;
  /** The signed-in user owning this take's stored chunks (`null`: memory only). */
  userId: string | null;
  nextChunkIndex: number;
  /** `started_at_utc` of every chunk with bytes, in capture order (the finalize list). */
  windows: string[];
  /** Settles once the latest chunk's onstop has persisted and enqueued it. */
  chunkSettled: Promise<void>;
  /** Releases the take's Web Lock (D10). */
  releaseTakeLock: () => void;
  /** A microphone re-acquisition is running (D19). */
  reacquiring: boolean;
  leaseMode: 'holding' | 'lost';
  leaseInFlight: Promise<void> | null;
  claimInFlight: Promise<void> | null;
  leaseReleasedLate: boolean;
}

/** The active chunk's recorder plus why it is being stopped; `null` = unexpected (mic lost). */
interface ChunkRecorder {
  mr: MediaRecorder;
  reason: 'rollover' | 'final' | 'lost' | null;
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
  /** Test seam for the rollover cadence (design D2). */
  chunkMs?: number;
  /** Test seam for the microphone re-acquisition window (design D19: 60 s). */
  micRetryWindowMs?: number;
  /** Longest Record waits for the profile and the storage scan (A.8: never forever). */
  scanTimeoutMs?: number;
}

const SCAN_TIMEOUT_MS = 10_000;

function isMobileSafari(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent);
}

function requestPersistentStorage(): void {
  // Best effort, never awaited (spike 0.3: Firefox's prompt does not settle headless).
  try {
    const p = navigator.storage?.persist?.();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {
    /* unsupported */
  }
}

export const AudioRecorder = forwardRef<AudioRecorderHandle, AudioRecorderProps>(
  function AudioRecorder(
    {
      sessionId,
      onPhaseChange,
      chunkMs = devChunkMsOverride() ?? CHUNK_MS,
      micRetryWindowMs = MIC_REACQUIRE_WINDOW_MS,
      scanTimeoutMs = SCAN_TIMEOUT_MS,
    },
    ref,
  ) {
    const queryClient = useQueryClient();
    const profileQuery = useProfile();
    const profile = profileQuery.data;
    const userId = profile?.auth?.user?.id ?? null;
    // A failed profile query allows recording (in memory); recovery waits for a profile (A.8).
    const profileKnown = profile !== undefined || profileQuery.isError === true;

    // Module-owned singleton (design D6), built with its real deps by the provider.
    const queueRef = useRef<ChunkUploadQueue | null>(null);
    if (queueRef.current === null) queueRef.current = getChunkUploadQueue();
    const queue = queueRef.current;

    const [state, dispatch] = useReducer(
      reducer,
      { queue, scanned: profileKnown && (!userId || queue.recoveryDone(userId)) },
      initialState,
    );
    const [hiddenInterval, setHiddenInterval] = useState<HiddenInterval | null>(null);
    const [micChanged, setMicChanged] = useState(false);

    const mediaStreamRef = useRef<MediaStream | null>(null);
    const chunkRecRef = useRef<ChunkRecorder | null>(null);
    const takeRef = useRef<ActiveTake | null>(null);
    const heartbeatRef = useRef<WorkerInterval | null>(null);
    const rolloverTimerRef = useRef<WorkerInterval | null>(null);
    const durTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const stoppedAtRef = useRef<string | null>(null);
    const meterStopRef = useRef<(() => void) | null>(null);
    const meterActiveRef = useRef(false);
    const micWatchRef = useRef<(() => void) | null>(null);
    const wakeLockRef = useRef<WakeLockController | null>(null);
    const hiddenSinceRef = useRef<number | null>(null);
    const startReacquireRef = useRef<(take: ActiveTake) => Promise<void>>(async () => {});
    const finalizeStopRef = useRef<(take: ActiveTake, r: 'final' | 'unexpected') => Promise<void>>(
      async () => {},
    );
    const stateRef = useRef(state);
    stateRef.current = state;

    const { data: segData } = useAudioSegments(sessionId);
    const { data: eventsRes } = useEvents(sessionId || null, { limit: WORKSPACE_EVENTS_LIMIT });
    const claimLease = useClaimAudioLease();
    const releaseLease = useReleaseAudioLease();
    const heartbeat = useHeartbeatAudioLease();
    const logEvent = useLogEvent(sessionId);

    const showToast = useCallback((msg: string, isError = false) => {
      appShowToast(msg, isError);
    }, []);

    // Never hold Record forever: a profile or scan that has not answered by then lets the user
    // record (A.8); a late scan still enqueues what it finds.
    useEffect(() => {
      const timer = setTimeout(() => {
        if (stateRef.current.phase !== 'scanning') return;
        console.warn('Recorder: the storage scan is taking too long; recording is allowed now.');
        dispatch({ type: 'SCAN_DONE', blocked: blocksNewRecording(queue.getSnapshot()) });
      }, scanTimeoutMs);
      return () => clearTimeout(timer);
    }, [scanTimeoutMs, queue]);

    // The queue uploads only the signed-in user's chunks (the request carries their cookie).
    useEffect(() => {
      if (profile !== undefined) queue.setCurrentUser(userId);
    }, [profile, userId, queue]);

    // Recovery scan (D10): once per user per page load; Record waits for it.
    useEffect(() => {
      if (!profileKnown) return;
      if (!userId) {
        dispatch({ type: 'SCAN_DONE', blocked: blocksNewRecording(queue.getSnapshot()) });
        return;
      }
      let live = true;
      queue
        .recover(userId)
        .catch(() => undefined)
        .then(() => {
          if (live) {
            dispatch({ type: 'SCAN_DONE', blocked: blocksNewRecording(queue.getSnapshot()) });
          }
        });
      return () => {
        live = false;
      };
    }, [profileKnown, userId, queue]);

    // The store's single "fell back to memory" warning, and segment invalidation on confirm.
    useEffect(() => {
      setChunkStoreDegradedListener((m) => appShowToast(m, true));
      const off = onChunkConfirmed((sid) => {
        void queryClient.invalidateQueries({ queryKey: audioSegmentsKeys.bySession(sid) });
      });
      return () => {
        off();
        setChunkStoreDegradedListener(null);
      };
    }, [queryClient]);

    const stopHeartbeat = useCallback(() => {
      heartbeatRef.current?.stop();
      heartbeatRef.current = null;
    }, []);

    const clearRolloverTimer = useCallback(() => {
      rolloverTimerRef.current?.stop();
      rolloverTimerRef.current = null;
    }, []);

    const stopMicMeter = useCallback(() => {
      meterActiveRef.current = false;
      meterStopRef.current?.();
      meterStopRef.current = null;
    }, []);

    const startMicMeter = useCallback(
      (stream: MediaStream) => {
        stopMicMeter();
        meterActiveRef.current = true;
        meterStopRef.current = runMicLevelMeter(stream, () => meterActiveRef.current);
      },
      [stopMicMeter],
    );

    const releaseLeaseQuiet = useCallback(
      async (leaseSessionId: string) => {
        try {
          await releaseLease.mutateAsync({
            sessionId: leaseSessionId,
            client_id: getClientInstanceId(),
          });
        } catch {
          /* best effort */
        }
      },
      [releaseLease],
    );

    const beaconRelease = useCallback((sid: string) => {
      if (typeof navigator.sendBeacon !== 'function') return;
      try {
        const b = new Blob([JSON.stringify({ client_id: getClientInstanceId() })], {
          type: 'application/json',
        });
        // Use raw sendBeacon URL — apiFetch is not available at page hide time
        navigator.sendBeacon(`${API_ROOT}/sessions/${sid}/audio-recording-lease/release`, b);
      } catch {
        /* ignore */
      }
    }, []);

    /** Re-claim the lease for `take` (session-leases design D7). */
    const reclaimLease = useCallback(
      (take: ActiveTake, cid: string): Promise<void> => {
        const capturing = () => takeRef.current === take && stateRef.current.phase === 'recording';
        const run = async () => {
          try {
            await claimLease.mutateAsync({ sessionId: take.sessionId, client_id: cid });
          } catch (err) {
            if (!capturing()) return;
            if (err instanceof ApiError && err.status === 409 && take.leaseMode !== 'lost') {
              take.leaseMode = 'lost';
              showToast(LEASE_LOST_WARNING, true);
            }
            return;
          }
          if (!capturing()) {
            take.leaseReleasedLate = true;
            await releaseLeaseQuiet(take.sessionId);
            return;
          }
          take.leaseMode = 'holding';
        };
        const inFlight: Promise<void> = run().finally(() => {
          if (take.claimInFlight === inFlight) take.claimInFlight = null;
        });
        take.claimInFlight = inFlight;
        return inFlight;
      },
      [claimLease, releaseLeaseQuiet, showToast],
    );

    /** One 8 s lease tick for `take` (design D7). */
    const leaseTick = useCallback(
      (take: ActiveTake, cid: string) => {
        if (take.leaseInFlight) return;
        const run = async () => {
          if (take.leaseMode === 'lost') {
            await reclaimLease(take, cid);
            return;
          }
          let res: OkResponse | undefined;
          try {
            res = await heartbeat.mutateAsync({ sessionId: take.sessionId, client_id: cid });
          } catch {
            return;
          }
          if (res?.ok !== false) return;
          if (takeRef.current !== take || stateRef.current.phase !== 'recording') return;
          await reclaimLease(take, cid);
        };
        const inFlight: Promise<void> = run().finally(() => {
          if (take.leaseInFlight === inFlight) take.leaseInFlight = null;
        });
        take.leaseInFlight = inFlight;
      },
      [heartbeat, reclaimLease],
    );

    const updateRecordingDur = useCallback((startMs: number) => {
      const el = document.getElementById('top-bar-recording-dur');
      if (!el) return;
      const elapsed = Math.floor((Date.now() - startMs) / 1000);
      const h = Math.floor(elapsed / 3600);
      const m = Math.floor((elapsed % 3600) / 60);
      const s = elapsed % 60;
      el.textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }, []);

    const releaseStream = useCallback(() => {
      micWatchRef.current?.();
      micWatchRef.current = null;
      stopMicMeter();
      for (const t of mediaStreamRef.current?.getTracks() ?? []) t.stop();
      mediaStreamRef.current = null;
    }, [stopMicMeter]);

    /**
     * Teardown once THIS recording's capture is over: log the single
     * `Recording N Stopped` event, release the lease once, hand the take's
     * windows to the queue for finalize (media-worker D6), then run the final
     * drain. The saving presentation exists only here (design D3).
     */
    const finalizeStop = useCallback(
      async (take: ActiveTake, _reason: 'final' | 'unexpected') => {
        // Idempotent (fix-wave F3): a second call for a finished take is a no-op.
        if (takeRef.current !== take) return;
        takeRef.current = null;
        chunkRecRef.current = null;
        clearRolloverTimer();
        releaseStream();
        stopHeartbeat();
        void wakeLockRef.current?.release();
        wakeLockRef.current = null;
        setMicChanged(false);

        const endIso = stoppedAtRef.current ?? new Date().toISOString();
        stoppedAtRef.current = null;
        dispatch({ type: 'STOP_REQUESTED', stoppedAt: endIso });

        try {
          await logEvent.mutateAsync({
            category: 'internal',
            message: `Recording ${take.ordinal} Stopped`,
            marked_at_utc: endIso,
          });
        } catch {
          /* best effort */
        }
        if (take.claimInFlight) await take.claimInFlight;
        if (!take.leaseReleasedLate) await releaseLeaseQuiet(take.sessionId);

        const durEl = document.getElementById('top-bar-recording-dur');
        if (durEl) durEl.textContent = '00:00:00';

        // The last chunk is persisted and enqueued before the take lock goes and finalize is
        // requested (finalize lists every window; the queue sends it after the last confirm).
        await take.chunkSettled;
        // The queue holds each chunk's lock from here on; only then may the take lock go (A.8).
        await queue.whenOwned();
        take.releaseTakeLock();
        if (take.windows.length > 0) {
          await queue.requestFinalize({
            userId: take.userId,
            sessionId: take.sessionId,
            recordingOrdinal: take.ordinal,
            windows: take.windows,
          });
        }

        dispatch({ type: 'UPLOAD_START' });
        const showingUi = document.getElementById('timeline-audio-seek-overlay');
        if (showingUi) showingUi.classList.remove('hidden');
        try {
          // A collapsed first call returns the running pump's promise (F1); the
          // second is the final stop's own re-attempt trigger.
          await queue.pump();
          await queue.pump();
        } finally {
          if (showingUi) showingUi.classList.add('hidden');
        }
        const own = queue.getSnapshot().chunks.filter((c) => !c.recovered);
        if (own.length === 0) {
          dispatch({ type: 'DONE' });
        } else {
          // Record stays blocked until this tab's chunks drain or are discarded (spec). Only a
          // terminal or user-actionable failure is an error (A.9): a chunk that is merely
          // retrying on its backoff shows as a neutral status in the rescue surface.
          dispatch({ type: 'DRAIN_BLOCKED' });
          if (own.some((c) => c.classification !== 'queued')) {
            showToast(
              'Some recorded audio failed to upload. See the banner above to retry, download, or discard it.',
              true,
            );
          }
        }
      },
      [
        clearRolloverTimer,
        releaseStream,
        stopHeartbeat,
        showToast,
        logEvent,
        releaseLeaseQuiet,
        queue,
      ],
    );

    finalizeStopRef.current = finalizeStop;

    /**
     * Construct + start a MediaRecorder for one chunk on the (live) stream with
     * a 5 s timeslice (media-worker D10): each slice is appended to the chunk's
     * stored entry. Returns the chunk's `started_at_utc` (the actual capture start).
     */
    const startChunkRecorder = useCallback(
      (stream: MediaStream, take: ActiveTake): string => {
        const mr = new MediaRecorder(stream);
        const rec: ChunkRecorder = { mr, reason: null };
        chunkRecRef.current = rec;
        const chunkIndex = take.nextChunkIndex;
        take.nextChunkIndex += 1;
        const store = getChunkStore();
        let handle: ChunkHandle | null = null;
        const memParts: Blob[] = [];
        let bytes = 0;
        let dataMime = '';
        // Container type from START time or a delivered Blob's own .type — never
        // mr.mimeType at stop: Firefox blanks it by then (design D1 spike).
        let mimeAtStart = '';
        const startedAtUtc = new Date().toISOString();
        let chain: Promise<void> = Promise.resolve();
        if (take.userId) {
          const owner = take.userId;
          chain = chain.then(async () => {
            try {
              handle = await store.openChunk({
                userId: owner,
                sessionId: take.sessionId,
                recordingOrdinal: take.ordinal,
                chunkIndex,
                startedAtUtc,
                mimeType: '',
                pendingFinalize: [...take.windows, startedAtUtc],
              });
            } catch {
              handle = null;
            }
          });
        }
        /** A slice the store refused: this chunk's later slices stay in memory too. */
        let fallback = false;
        mr.ondataavailable = (e) => {
          if (!e.data || e.data.size === 0) return;
          const data = e.data;
          if (!dataMime && data.type) dataMime = data.type;
          bytes += data.size;
          chain = chain.then(async () => {
            if (handle && !fallback) {
              try {
                await store.append(handle, data);
                return;
              } catch {
                fallback = true;
              }
            }
            memParts.push(data);
          });
        };
        let stopped = false;
        mr.onstop = () => {
          // A browser (or a racing stop) may deliver onstop twice: one chunk, one enqueue.
          if (stopped) return;
          stopped = true;
          const endedAtUtc = new Date().toISOString();
          /** Persist the chunk and say what to enqueue. Never rejects (A.8). */
          const persist = async (): Promise<ChunkInput | null> => {
            await chain.catch(() => undefined);
            const mime = mimeAtStart || dataMime || 'audio/webm';
            const owner = take.userId;
            if (bytes === 0) {
              // Zero-byte chunk: never uploaded (the server 400s empty payloads).
              if (handle && owner) await store.remove(owner, handle.id).catch(() => {});
              return null;
            }
            take.windows.push(startedAtUtc);
            const base = {
              sessionId: take.sessionId,
              recordingOrdinal: take.ordinal,
              chunkIndex,
              startedAtUtc,
              endedAtUtc,
              mimeType: mime,
            };
            if (handle && owner && !fallback) {
              try {
                await store.finalize(handle, endedAtUtc, mime);
                return { ...base, storeId: handle.id, userId: owner, bytes };
              } catch {
                /* fall through to an in-memory copy */
              }
            }
            // Memory: what the store holds plus the slices it could not take. The store id stays
            // attached so a confirmation still removes the durable prefix.
            let prefix: Blob | null = null;
            if (handle && owner) {
              prefix = await store.read(owner, handle.id).catch(() => null);
            }
            const blob = new Blob(prefix ? [prefix, ...memParts] : memParts, { type: mime });
            return {
              ...base,
              blob,
              storeId: handle && owner ? handle.id : undefined,
              userId: owner ?? undefined,
            };
          };
          const persisted = persist().catch((err: unknown) => {
            console.warn('Recorded chunk could not be prepared for upload.', err);
            return null;
          });
          // Chunks enqueue in capture order, and the take's settle covers every chunk (finalize
          // must list them all and follow their enqueue).
          const settled = take.chunkSettled.then(async () => {
            const input = await persisted;
            if (input) queue.enqueue(input);
          });
          take.chunkSettled = settled;
          void settled.then(() => {
            if (rec.reason === 'final') {
              void finalizeStop(take, 'final');
              return;
            }
            // Rollover, a lost microphone, or an unexpected stop: pump and nothing
            // else (design D3) — the take goes on.
            void queue.pump();
            if (rec.reason === null) void startReacquireRef.current(take);
          });
        };
        const persistMode =
          typeof navigator !== 'undefined' && detectSafari(navigator.userAgent)
            ? SAFARI_PERSIST_MODE
            : 'slices';
        if (persistMode === 'slices') mr.start(PERSIST_SLICE_MS);
        else mr.start();
        mimeAtStart = mr.mimeType || '';
        return startedAtUtc;
      },
      [queue, finalizeStop],
    );

    /** Watch the active stream for a lost track or a removed device (D19). */
    const watchStream = useCallback((stream: MediaStream, take: ActiveTake) => {
      micWatchRef.current?.();
      const md = navigator.mediaDevices as unknown as EventTarget | undefined;
      micWatchRef.current = watchMicrophone(stream, {
        onLost: () => void startReacquireRef.current(take),
        mediaDevices: md && typeof md.addEventListener === 'function' ? md : null,
        log: (m) => console.info(m),
      });
    }, []);

    /**
     * A lost microphone (D19): persist the chunk captured so far, re-acquire
     * the previous device then the default input for up to 60 s, and continue
     * the same take with the next chunk index. Only a 60 s failure ends it.
     */
    const startReacquire = useCallback(
      async (take: ActiveTake) => {
        if (take.reacquiring || takeRef.current !== take) return;
        take.reacquiring = true;
        const previousDeviceId = deviceIdOf(mediaStreamRef.current);
        const rec = chunkRecRef.current;
        if (rec && rec.mr.state === 'recording') {
          rec.reason = 'lost';
          rec.mr.stop();
        }
        chunkRecRef.current = null;
        releaseStream();
        const result = await reacquireMicrophone({
          getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
          previousDeviceId,
          now: () => Date.now(),
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          windowMs: micRetryWindowMs,
          isCancelled: () => takeRef.current !== take || stateRef.current.phase !== 'recording',
        });
        take.reacquiring = false;
        const ours = takeRef.current === take && stateRef.current.phase === 'recording';
        if (result.ok) {
          if (!ours) {
            for (const t of result.stream.getTracks()) t.stop();
            return;
          }
          console.info('Microphone re-acquired; recording continues on the new input.');
          mediaStreamRef.current = result.stream;
          startMicMeter(result.stream);
          watchStream(result.stream, take);
          startChunkRecorder(result.stream, take);
          setMicChanged(true);
          return;
        }
        if (!ours) return;
        showToast(
          `Recording stopped: the microphone could not be re-acquired (${result.reason}). Saving what was captured.`,
          true,
        );
        void finalizeStop(take, 'unexpected');
      },
      [
        micRetryWindowMs,
        releaseStream,
        startMicMeter,
        watchStream,
        startChunkRecorder,
        showToast,
        finalizeStop,
      ],
    );
    startReacquireRef.current = startReacquire;

    /**
     * Rollover boundary (design D1): stop the active recorder — its onstop
     * persists and enqueues the chunk — and start a fresh one on the same
     * stream. A boundary with no live track waits for (or starts) the
     * microphone re-acquisition instead of ending the take (D19).
     */
    const onRolloverBoundary = useCallback(() => {
      if (stateRef.current.phase !== 'recording') return;
      const take = takeRef.current;
      if (!take) return;
      const stream = mediaStreamRef.current;
      const streamLive = !!stream && audioTracksOf(stream).some((t) => t.readyState === 'live');
      const action = rolloverAction({ streamLive, reacquiring: take.reacquiring });
      if (action === 'wait') return;
      if (action === 'reacquire') {
        void startReacquire(take);
        return;
      }
      const rec = chunkRecRef.current;
      if (!stream || !rec || rec.mr.state !== 'recording') return;
      rec.reason = 'rollover';
      rec.mr.stop();
      startChunkRecorder(stream, take);
    }, [startChunkRecorder, startReacquire]);

    const toggle = useCallback(async (): Promise<boolean> => {
      const { phase } = stateRef.current;

      if (phase === 'recording') {
        const stoppedAt = new Date().toISOString();
        stoppedAtRef.current = stoppedAt;
        dispatch({ type: 'STOP_REQUESTED', stoppedAt });
        stopHeartbeat();
        clearRolloverTimer();
        const rec = chunkRecRef.current;
        if (rec && rec.mr.state === 'recording') {
          rec.reason = 'final';
          rec.mr.stop(); // onstop persists + enqueues the final chunk, then finalizeStop drains
        } else if (takeRef.current) {
          void finalizeStop(takeRef.current, 'final');
        }
        return true;
      }

      if (phase === 'scanning') {
        showToast(SCAN_PENDING_MESSAGE);
        return false;
      }
      // drain_blocked deliberately refuses (spec): idle only after the drain.
      if (phase !== 'idle') return false;

      dispatch({ type: 'CLAIM_START' });
      const cid = getClientInstanceId();
      const recordingSessionId = sessionId;
      // Session-scoped ordinals only (F2 hardening); recovered chunks count (D10).
      const ownSessionOrdinals = queue
        .getSnapshot()
        .chunks.filter((c) => c.sessionId === recordingSessionId)
        .map((c) => c.recordingOrdinal);
      const ordinal = deriveNextOrdinal(segData?.segments, eventsRes?.events, ownSessionOrdinals);

      try {
        await claimLease.mutateAsync({ sessionId: recordingSessionId, client_id: cid });
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Could not claim recording lease.');
        dispatch({ type: 'ERROR' });
        return false;
      }

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        await releaseLeaseQuiet(recordingSessionId);
        showToast(err instanceof Error ? err.message : 'Microphone access denied.');
        dispatch({ type: 'ERROR' });
        return false;
      }

      requestPersistentStorage();
      // The take lock (D10) is held from here until the last chunk is persisted.
      const releaseTakeLock = await createRecorderLocks({
        locks: browserLockManager(),
        now: () => Date.now(),
      }).holdTake(recordingSessionId, ordinal);

      mediaStreamRef.current = stream;
      startMicMeter(stream);
      const take: ActiveTake = {
        sessionId: recordingSessionId,
        ordinal,
        userId,
        nextChunkIndex: 0,
        windows: [],
        chunkSettled: Promise.resolve(),
        releaseTakeLock,
        reacquiring: false,
        leaseMode: 'holding',
        leaseInFlight: null,
        claimInFlight: null,
        leaseReleasedLate: false,
      };
      takeRef.current = take;
      watchStream(stream, take);
      // Chunk 1's capture start — also the Started event's wall time (design D3).
      const startedAt = startChunkRecorder(stream, take);

      // Heartbeat and rollover on worker intervals (media-worker D11): exempt
      // from hidden-tab throttling.
      heartbeatRef.current?.stop();
      heartbeatRef.current = createWorkerInterval(HEARTBEAT_INTERVAL_MS, () => {
        if (stateRef.current.phase !== 'recording') {
          stopHeartbeat();
          return;
        }
        leaseTick(take, cid);
      });
      rolloverTimerRef.current?.stop();
      rolloverTimerRef.current = createWorkerInterval(chunkMs, onRolloverBoundary);

      wakeLockRef.current = createWakeLockController({
        wakeLock: browserWakeLock(),
        doc: document,
        log: (m) => console.info(m),
      });
      void wakeLockRef.current.acquire();

      dispatch({ type: 'CLAIM_OK', ordinal, startedAt });

      try {
        await logEvent.mutateAsync({
          category: 'internal',
          message: `Recording ${ordinal} Started`,
          marked_at_utc: startedAt,
        });
      } catch {
        /* best effort — recording still proceeds */
      }

      // Recording-dur display (identity-gated, fix-wave F6/D1).
      if (durTimerRef.current != null) {
        clearInterval(durTimerRef.current);
        durTimerRef.current = null;
      }
      const startMs = Date.now();
      const durTimerId = setInterval(() => {
        if (durTimerRef.current !== durTimerId || stateRef.current.phase !== 'recording') {
          clearInterval(durTimerId);
          if (durTimerRef.current === durTimerId) {
            durTimerRef.current = null;
          }
          return;
        }
        updateRecordingDur(startMs);
      }, 1_000);
      durTimerRef.current = durTimerId;

      return true;
    }, [
      sessionId,
      userId,
      segData,
      eventsRes,
      queue,
      chunkMs,
      claimLease,
      releaseLeaseQuiet,
      logEvent,
      leaseTick,
      stopHeartbeat,
      clearRolloverTimer,
      startMicMeter,
      watchStream,
      startChunkRecorder,
      onRolloverBoundary,
      finalizeStop,
      showToast,
      updateRecordingDur,
    ]);

    useImperativeHandle(
      ref,
      () => ({
        toggle,
        isRecording: () => stateRef.current.phase === 'recording',
        isUploading: () => stateRef.current.phase === 'uploading',
      }),
      [toggle],
    );

    useEffect(() => {
      onPhaseChange?.(state.phase);
    }, [state.phase, onPhaseChange]);

    // While drain_blocked, watch the queue: once this tab's own chunks are gone
    // the recorder returns to idle (re-checked around subscribe, fix-wave F6/D2).
    useEffect(() => {
      const check = (snap: ChunkQueueSnapshot) => {
        if (!blocksNewRecording(snap) && stateRef.current.phase === 'drain_blocked') {
          dispatch({ type: 'DONE' });
        }
      };
      check(queue.getSnapshot());
      const unsubscribe = queue.subscribe(check);
      check(queue.getSnapshot());
      return unsubscribe;
    }, [queue]);

    useEffect(() => {
      const isActive = state.phase === 'recording' || state.phase === 'uploading';
      document.body.classList.toggle('v4-local-recording', isActive);
      document.body.classList.toggle('v4-is-recording', state.phase === 'recording');
      return () => {
        document.body.classList.remove('v4-local-recording');
        document.body.classList.remove('v4-is-recording');
      };
    }, [state.phase]);

    useEffect(() => () => stopMicMeter(), [stopMicMeter]);

    // Hidden-tab warning (D17): note when a recording tab is hidden; on return,
    // show the interval until the user's next action.
    useEffect(() => {
      const onVisibility = () => {
        if (document.visibilityState === 'hidden') {
          if (stateRef.current.phase === 'recording' && hiddenSinceRef.current === null) {
            hiddenSinceRef.current = Date.now();
            console.info(
              `Recording tab hidden at ${new Date(hiddenSinceRef.current).toISOString()}.`,
            );
          }
          return;
        }
        const from = hiddenSinceRef.current;
        if (from === null) return;
        hiddenSinceRef.current = null;
        const to = Date.now();
        console.info(`Recording tab visible again at ${new Date(to).toISOString()}.`);
        setHiddenInterval({ fromMs: from, toMs: to });
      };
      document.addEventListener('visibilitychange', onVisibility);
      return () => document.removeEventListener('visibilitychange', onVisibility);
    }, []);

    useEffect(() => {
      if (!hiddenInterval) return;
      const clear = () => setHiddenInterval(null);
      window.addEventListener('pointerdown', clear);
      window.addEventListener('keydown', clear);
      return () => {
        window.removeEventListener('pointerdown', clear);
        window.removeEventListener('keydown', clear);
      };
    }, [hiddenInterval]);

    // Page hide: ask for the pending slice (best effort, D11) and release the lease by beacon.
    useEffect(() => {
      const onHide = () => {
        if (stateRef.current.phase !== 'recording') return;
        const mr = chunkRecRef.current?.mr;
        try {
          if (mr && mr.state === 'recording' && typeof mr.requestData === 'function') {
            mr.requestData();
          }
        } catch {
          /* at most one slice is lost either way */
        }
        stopHeartbeat();
        beaconRelease(takeRef.current?.sessionId ?? sessionId);
      };
      window.addEventListener('pagehide', onHide);
      return () => window.removeEventListener('pagehide', onHide);
    }, [beaconRelease, stopHeartbeat, sessionId]);

    // Warn before unload while recording; registered only for the span of a
    // recording so an idle page stays bfcache-eligible.
    useEffect(() => {
      if (state.phase !== 'recording') return;
      const onBeforeUnload = (e: BeforeUnloadEvent) => {
        if (stateRef.current.phase !== 'recording') return;
        const msg =
          'Audio is still recording. Stop the recording before leaving, or you may lose the latest audio.';
        e.preventDefault();
        e.returnValue = msg;
      };
      window.addEventListener('beforeunload', onBeforeUnload);
      return () => window.removeEventListener('beforeunload', onBeforeUnload);
    }, [state.phase]);

    // Cleanup on unmount: a 'final' stop; the module-owned queue keeps pumping.
    useEffect(() => {
      return () => {
        stopHeartbeat();
        clearRolloverTimer();
        if (durTimerRef.current != null) {
          clearInterval(durTimerRef.current);
          durTimerRef.current = null;
        }
        const rec = chunkRecRef.current;
        if (rec && rec.mr.state === 'recording') {
          rec.reason = 'final';
          rec.mr.stop();
        } else if (takeRef.current) {
          // Unmounted mid re-acquisition (no live recorder): end the take now, which also
          // cancels the re-acquisition so it can never start a recorder after unmount (A.8).
          void finalizeStopRef.current(takeRef.current, 'final');
        }
        micWatchRef.current?.();
        micWatchRef.current = null;
        for (const t of mediaStreamRef.current?.getTracks() ?? []) t.stop();
      };
    }, [stopHeartbeat, clearRolloverTimer]);

    return (
      <HiddenTabWarning
        interval={hiddenInterval}
        mobileSafari={isMobileSafari()}
        micChanged={micChanged}
      />
    );
  },
);
