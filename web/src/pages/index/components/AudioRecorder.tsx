import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useReducer, useRef } from 'react';
import { API_ROOT, ApiError, apiFetch } from '../../../api/client';
import {
  audioSegmentsKeys,
  useAudioSegments,
  useClaimAudioLease,
  useHeartbeatAudioLease,
  useReleaseAudioLease,
} from '../../../api/hooks/useAudio';
import { useEvents, useLogEvent, WORKSPACE_EVENTS_LIMIT } from '../../../api/hooks/useEvents';
import type { AudioSegment, AudioSegmentsResponse, LogEvent, OkResponse } from '../../../api/types';
import { showToast as appShowToast } from '../../../shared/components/Toast';
import { parseRecordingOrdinalFromMessage } from '../../../shared/utils/audioClips';
import { getClientInstanceId } from '../../../shared/utils/clientId';
import { computeDbPeaks01 } from '../../../shared/utils/waveformDecode';
import {
  type ChunkInput,
  type ChunkUploadQueue,
  type ChunkUploadQueueDeps,
  getChunkUploadQueue,
} from '../utils/chunkUploadQueue';
import { runMicLevelMeter } from '../utils/micLevelMeter';

const WF_DB_FLOOR = -48;
const HEARTBEAT_INTERVAL_MS = 8_000;
/** Shown once per lease loss mid-take (session-leases design D7). */
const LEASE_LOST_WARNING = 'Another window, tab, or user now holds the recording lease.';
const WF_BUCKET_COUNT = 800;
/**
 * Chunk rollover cadence (chunked-live-recording design D2 — the value is
 * design-owned tuning, deliberately not spec surface): ~10 MB per chunk at
 * Chrome's default Opus bitrate, 5x headroom under the server's 50 MB live
 * segment cap, and a crash loses at most this much plus whatever the rescue
 * queue holds. Tests inject a smaller value via the `chunkMs` prop.
 */
const CHUNK_MS = 10 * 60_000;

type Phase = 'idle' | 'claiming' | 'recording' | 'stopping' | 'uploading' | 'drain_blocked';

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
  | { type: 'DRAIN_BLOCKED' }
  | { type: 'DONE' }
  | { type: 'ERROR' };

/**
 * Phase machine (chunked-live-recording design D3, binding invariant):
 * mid-take chunk uploads never leave `recording` — heartbeats, the
 * recording indication/body classes, and the duration counter all key off
 * capture state, so a rollover upload must not disturb them. The guarded
 * transitions below make that structural: `UPLOAD_START` (the final drain,
 * which owns the full-screen saving presentation) is reachable only from
 * `stopping`, and `DONE` only from the stopped side of the machine — a
 * stray mid-take dispatch is a no-op rather than a phase flip.
 */
function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'CLAIM_START':
      return { ...s, phase: 'claiming' };
    case 'CLAIM_OK':
      return { ...s, phase: 'recording', ordinal: a.ordinal, startedAt: a.startedAt };
    case 'STOP_REQUESTED':
      // Only a live recording stops; repeated dispatches (user stop already
      // flipped it) are no-ops.
      return s.phase === 'recording' ? { ...s, phase: 'stopping', stoppedAt: a.stoppedAt } : s;
    case 'UPLOAD_START':
      // Final drain only — capture must already have stopped (design D3).
      return s.phase === 'stopping' ? { ...s, phase: 'uploading' } : s;
    case 'DRAIN_BLOCKED':
      // Final drain finished with chunks still queued (failures) — the
      // recorder is not idle (no new recording) but no longer presents the
      // saving overlay. Task 5.1's rescue surface reads the queue directly.
      return s.phase === 'uploading' ? { ...s, phase: 'drain_blocked' } : s;
    case 'DONE':
      // DONE is reachable only from the stopped state (design D3): a
      // mid-take upload completing must never reset a live recording.
      return s.phase === 'stopping' || s.phase === 'uploading' || s.phase === 'drain_blocked'
        ? { phase: 'idle', ordinal: 1, startedAt: null, stoppedAt: null }
        : s;
    case 'ERROR':
      return { phase: 'idle', ordinal: 1, startedAt: null, stoppedAt: null };
  }
}

/**
 * Lazy `useReducer` initializer (fix-wave F2). A fresh mount must not
 * default to `idle` when the module-owned queue (design D6 — it survives
 * unmount/remount) already holds queued/permanent chunks from a prior
 * mount: spec "The recorder SHALL reach its idle state … only after the
 * rescue queue drains or the user explicitly discards its remainder"
 * applies across the component's own lifecycle, not just within one
 * mount. Reading the queue's snapshot at construction time (rather than
 * starting 'idle' and reconciling in an effect) means the very first
 * render already reflects reality — no idle-then-drain_blocked flash, and
 * `toggle()` refuses a new recording immediately.
 */
function initialState(queue: ChunkUploadQueue): State {
  const idle = queue.getSnapshot().idle;
  return { phase: idle ? 'idle' : 'drain_blocked', ordinal: 1, startedAt: null, stoppedAt: null };
}

/**
 * Next recording ordinal (design D8; spec "Recording ordinals derive from
 * prior recordings, never segment counts"): strictly greater than every
 * ordinal already used in the session — the max across (a) segments'
 * `recording_ordinal` values, (b) the N parsed from `Recording N
 * Started/Stopped` internal events (covers fully-discarded recordings whose
 * segments never persisted), and (c) ordinals still held by the upload
 * queue (covers not-yet-persisted chunks) — plus 1. NEVER
 * `segments.length + 1`: multi-chunk recordings would skip numbers and a
 * fully-discarded recording would reuse its N.
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

/**
 * Compute + persist one chunk's waveform peaks from that chunk's own blob
 * (spec: "Each chunk gets its own waveform"). Best-effort by requirement —
 * a waveform failure never fails the chunk — and deliberately off the
 * upload critical path (design D7): callers fire-and-forget this.
 */
async function computeAndUploadWaveformBestEffort(
  sessionId: string,
  segmentId: string,
  blob: Blob,
  queryClient: QueryClient,
): Promise<void> {
  try {
    const AC =
      window.AudioContext ??
      ((window as unknown as Record<string, unknown>).webkitAudioContext as typeof AudioContext);
    if (!AC) return;
    const ctx = new AC();
    try {
      await ctx.resume().catch(() => {});
      const ab = await blob.arrayBuffer();
      const buf = await ctx.decodeAudioData(ab.slice(0));
      const bc = Math.max(200, Math.min(WF_BUCKET_COUNT, Math.round(buf.duration * 20)));
      const peaks = computeDbPeaks01(buf, bc, WF_DB_FLOOR);
      if (peaks.length >= 8) {
        await apiFetch<OkResponse>(`sessions/${sessionId}/audio/segments/${segmentId}/waveform`, {
          method: 'PUT',
          body: JSON.stringify({ peaks: Array.from(peaks) }),
        });
        void queryClient.invalidateQueries({ queryKey: audioSegmentsKeys.bySession(sessionId) });
      }
    } finally {
      // Close per-chunk contexts: browsers cap live AudioContexts, and a
      // long take decodes one blob every rollover.
      await ctx.close().catch(() => {});
    }
  } catch {
    /* waveform is optional — best-effort per spec */
  }
}

/**
 * Dependencies for the module-owned chunk upload queue (design D6). The
 * session id comes from each chunk — bound at recording start, never a
 * component prop — so uploads survive session switches and unmount (spec:
 * "Rescue and uploads are bound to their recording's session…"). Failures
 * propagate as thrown `ApiError`s; the queue classifies them by status.
 */
function buildQueueDeps(queryClient: QueryClient): ChunkUploadQueueDeps {
  return {
    upload: async (chunk: ChunkInput) => {
      const params = new URLSearchParams({
        started_at_utc: chunk.startedAtUtc,
        ended_at_utc: chunk.endedAtUtc,
        recording_ordinal: String(chunk.recordingOrdinal),
      });
      const seg = await apiFetch<AudioSegment>(
        `sessions/${chunk.sessionId}/audio/segments?${params.toString()}`,
        {
          method: 'POST',
          headers: { 'Content-Type': chunk.mimeType || 'audio/webm' },
          body: chunk.blob,
        },
      );
      void queryClient.invalidateQueries({
        queryKey: audioSegmentsKeys.bySession(chunk.sessionId),
      });
      void computeAndUploadWaveformBestEffort(chunk.sessionId, seg.id, chunk.blob, queryClient);
      return {
        ok: true as const,
        segment: {
          id: seg.id,
          recording_ordinal: seg.recording_ordinal,
          started_at_utc: seg.started_at_utc,
        },
      };
    },
    listSegments: async (sessionId: string) =>
      (await apiFetch<AudioSegmentsResponse>(`sessions/${sessionId}/audio/segments`)).segments,
    clock: { now: () => Date.now() },
  };
}

/** One recording ("take") — spans every chunk. Captured at recording start; the onstop closures read it, never component props. */
interface ActiveTake {
  sessionId: string;
  ordinal: number;
  nextChunkIndex: number;
  /**
   * Lease mode for this take (session-leases design D7): `holding` ticks send a
   * heartbeat; `lost` ticks send a claim instead. Capture continues in both.
   */
  leaseMode: 'holding' | 'lost';
  /** The one claim or heartbeat in flight for this take; a tick skips while it is set. */
  leaseInFlight: Promise<void> | null;
  /**
   * The re-claim in flight for this take, if any (a subset of `leaseInFlight`).
   * The final release waits only for this, never for a heartbeat (D7).
   */
  claimInFlight: Promise<void> | null;
  /** A re-claim that landed after this take stopped was already released (D7). */
  leaseReleasedLate: boolean;
}

/** The active chunk's recorder plus why it is being stopped. `reason` is set immediately before a deliberate `stop()`; an onstop that finds it null is unexpected (mic unplugged, track ended, OS revoked capture). */
interface ChunkRecorder {
  mr: MediaRecorder;
  reason: 'rollover' | 'final' | null;
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
  /** Test seam for the rollover cadence — production always uses the design-owned CHUNK_MS (design D2). */
  chunkMs?: number;
}

export const AudioRecorder = forwardRef<AudioRecorderHandle, AudioRecorderProps>(
  function AudioRecorder({ sessionId, onPhaseChange, chunkMs = CHUNK_MS }, ref) {
    const queryClient = useQueryClient();
    // Module-owned singleton (design D6): survives unmount/session switch;
    // deps are consulted only on the first acquire in the tab's lifetime.
    // Acquired ABOVE useReducer (fix-wave F2) so the reducer's lazy
    // initializer can read the queue's current snapshot on this very first
    // render — a fresh mount must not default to 'idle' when a prior
    // mount left chunks queued/permanent in the surviving singleton.
    const queueRef = useRef<ChunkUploadQueue | null>(null);
    if (queueRef.current === null) {
      queueRef.current = getChunkUploadQueue(buildQueueDeps(queryClient));
    }
    const queue = queueRef.current;

    const [state, dispatch] = useReducer(reducer, queue, initialState);

    const mediaStreamRef = useRef<MediaStream | null>(null);
    const chunkRecRef = useRef<ChunkRecorder | null>(null);
    const takeRef = useRef<ActiveTake | null>(null);
    const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const rolloverTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    // Hoisted out of toggle()'s local scope (fix-wave F4) so the unmount
    // cleanup can clear it: the interval previously self-cleared only by
    // observing `stateRef.current.phase !== 'recording'` on its own next
    // tick, which never fires once the component (and its timers) is torn
    // down mid-recording — the interval otherwise keeps calling
    // `updateRecordingDur` (a DOM write) forever after unmount.
    const durTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const stoppedAtRef = useRef<string | null>(null);
    const meterStopRef = useRef<(() => void) | null>(null);
    const meterActiveRef = useRef(false);
    const stateRef = useRef(state);
    stateRef.current = state;

    const { data: segData } = useAudioSegments(sessionId);
    // Ordinal derivation (design D8) needs `Recording N` internal events.
    // Same query key as SessionWorkspace's feed query (page(sessionId, 0,
    // WORKSPACE_EVENTS_LIMIT)), so react-query dedupes — no extra fetch.
    const { data: eventsRes } = useEvents(sessionId || null, { limit: WORKSPACE_EVENTS_LIMIT });
    // Lease requests carry their session per call: every request of a take
    // goes to `take.sessionId`, since the prop can change mid-take (D7).
    const claimLease = useClaimAudioLease();
    const releaseLease = useReleaseAudioLease();
    const heartbeat = useHeartbeatAudioLease();
    const logEvent = useLogEvent(sessionId);

    const showToast = useCallback((msg: string, isError = false) => {
      appShowToast(msg, isError);
    }, []);

    const stopHeartbeat = useCallback(() => {
      if (heartbeatRef.current != null) {
        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
    }, []);

    const clearRolloverTimer = useCallback(() => {
      if (rolloverTimerRef.current != null) {
        clearInterval(rolloverTimerRef.current);
        rolloverTimerRef.current = null;
      }
    }, []);

    const stopMicMeter = useCallback(() => {
      // Own flag — do not gate on stateRef.phase. Meter starts during `claiming`,
      // before CLAIM_OK re-renders, so a phase check aborted the loop forever.
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

    /**
     * Re-claim the lease for `take` with its own client id (session-leases
     * design D7). The answer is acted on only while that take is still the
     * capturing one: 200 → holding; 409 → lost (one warning per loss); any
     * other failure leaves the mode as it was. A claim that succeeds after
     * its take stopped is released at once, so it never outlives the take.
     * The returned promise (also `take.claimInFlight`) settles after that.
     */
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

    /**
     * One 8 s lease tick for `take` (design D7): heartbeat while holding — a
     * refused heartbeat (`{ok:false}`) re-claims at once — or claim while
     * lost. At most one request is in flight; a tick skips while one is.
     * A heartbeat that fails outright keeps the existing behaviour (ignored).
     */
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
            return; // best effort, as before D7
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

    /**
     * Teardown once THIS recording's capture is over (the final chunk is
     * already enqueued by its recorder's onstop): log the single
     * `Recording N Stopped` event, release the lease once (spec: one lease
     * and one event pair per recording, spanning all chunks), then run the
     * final drain. The full-screen saving presentation (UPLOAD_START →
     * DONE) exists only here — never on the mid-take path (design D3).
     */
    const finalizeStop = useCallback(
      async (take: ActiveTake, reason: 'final' | 'unexpected') => {
        // Idempotency guard (fix-wave F3): both the `toggle()` stop path
        // (rec.mr.state !== 'recording' branch) and a `rec.onstop` handler
        // (rollover-reason cleared to 'final'/'unexpected') can end up
        // calling finalizeStop for the SAME take when a deliberate stop
        // races an unexpected onstop. The take is nulled below the first
        // time through; a second call for a take that is no longer the
        // active one is a no-op, so the Stopped event/lease release never
        // double-fire.
        if (takeRef.current !== take) return;
        takeRef.current = null;
        chunkRecRef.current = null;
        clearRolloverTimer();
        stopMicMeter();
        for (const t of mediaStreamRef.current?.getTracks() ?? []) t.stop();
        mediaStreamRef.current = null;
        stopHeartbeat();

        if (reason === 'unexpected') {
          showToast(
            'Recording stopped: the microphone stream ended. Saving what was captured.',
            true,
          );
        }
        const endIso = stoppedAtRef.current ?? new Date().toISOString();
        stoppedAtRef.current = null;
        // No-op when toggle() already dispatched it (user stop); flips
        // 'recording' → 'stopping' for unexpected/unmount stops.
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
        // Design D7: let an in-flight claim settle first, so a re-claim can
        // never land after this final release. A re-claim that landed after
        // the stop already released the lease itself. A heartbeat in flight is
        // not awaited (it has no timeout, and with the take gone it can no
        // longer turn into a re-claim).
        if (take.claimInFlight) await take.claimInFlight;
        if (!take.leaseReleasedLate) await releaseLeaseQuiet(take.sessionId);

        // Reset recording-dur display
        const durEl = document.getElementById('top-bar-recording-dur');
        if (durEl) durEl.textContent = '00:00:00';

        dispatch({ type: 'UPLOAD_START' });
        const showingUi = document.getElementById('timeline-audio-seek-overlay');
        if (showingUi) showingUi.classList.remove('hidden');
        try {
          // First await: if a pump triggered by an earlier rollover
          // boundary is still in flight, `pump()` now returns THAT
          // attempt's completion promise (fix-wave F1) instead of
          // resolving immediately — so this await genuinely waits for it
          // rather than racing ahead of it.
          await queue.pump();
          // Second, fresh call: the final stop is itself a spec'd
          // re-attempt trigger for transient failures ("Upload failure is
          // surfaced and recoverable" — re-attempted at each chunk
          // boundary and at the final stop). A collapsed first call must
          // not skip that re-attempt, so pump once more unconditionally
          // once the prior attempt (if any) has settled.
          await queue.pump();
        } finally {
          if (showingUi) showingUi.classList.add('hidden');
        }
        if (queue.getSnapshot().idle) {
          dispatch({ type: 'DONE' });
        } else {
          // drain_blocked (never a silent hang, never idle with chunks still
          // queued). The durable surface is `ChunkRescueBanner` (task 5.1) —
          // it reads this same module-owned queue directly and persists
          // (never auto-dismissed, immune to `hideToast()`) for as long as
          // the queue holds chunks. This toast is deliberately transient
          // (auto-dismisses, per design D6's "a transient toast pointing at
          // the banner is acceptable") — a one-time nudge toward the banner,
          // never itself the rescue surface and never carrying a discard
          // action.
          dispatch({ type: 'DRAIN_BLOCKED' });
          showToast(
            'Some recorded audio failed to upload. See the banner above to retry, download, or discard it.',
            true,
          );
        }
      },
      [
        clearRolloverTimer,
        stopMicMeter,
        stopHeartbeat,
        showToast,
        logEvent,
        releaseLeaseQuiet,
        queue,
      ],
    );

    /**
     * Construct + start a MediaRecorder for one chunk on the (live) stream.
     * Returns the chunk's `started_at_utc` — the ACTUAL capture start
     * (design D3); for chunk 1 the caller also stamps the Started event
     * with it, preserving the transcript-anchor delta-0 identity (E-A).
     */
    const startChunkRecorder = useCallback(
      (stream: MediaStream, take: ActiveTake): string => {
        const mr = new MediaRecorder(stream);
        const rec: ChunkRecorder = { mr, reason: null };
        chunkRecRef.current = rec;
        const chunkIndex = take.nextChunkIndex;
        take.nextChunkIndex += 1;
        const localChunks: Blob[] = [];
        let dataMime = '';
        // Container type comes from START time or a delivered Blob's own
        // .type — NEVER from mr.mimeType at stop: Firefox blanks it by then
        // (design D1 spike finding).
        let mimeAtStart = '';
        mr.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) {
            localChunks.push(e.data);
            if (!dataMime && e.data.type) dataMime = e.data.type;
          }
        };
        mr.onstop = () => {
          const endedAtUtc = new Date().toISOString();
          const mime = mimeAtStart || dataMime || 'audio/webm';
          const blob = new Blob(localChunks, { type: mime });
          localChunks.length = 0;
          // Zero-byte chunks: enqueue() rejects them by design (the server
          // 400s empty payloads) — not an error, nothing to log.
          queue.enqueue({
            sessionId: take.sessionId,
            recordingOrdinal: take.ordinal,
            chunkIndex,
            blob,
            startedAtUtc,
            endedAtUtc,
            mimeType: mime,
          });
          if (rec.reason === 'rollover') {
            // Mid-take path (design D3, binding): pump the pipeline and
            // NOTHING else — no phase change, no heartbeat/overlay/DOM
            // touch. The recording indication, duration counter, and lease
            // heartbeats run straight through the boundary.
            void queue.pump();
            return;
          }
          void finalizeStop(take, rec.reason === 'final' ? 'final' : 'unexpected');
        };
        const startedAtUtc = new Date().toISOString();
        mr.start();
        mimeAtStart = mr.mimeType || '';
        return startedAtUtc;
      },
      [queue, finalizeStop],
    );

    /**
     * Rollover boundary (design D1): stop the active recorder — its onstop
     * enqueues the completed, self-contained chunk — and IMMEDIATELY start
     * a fresh recorder on the same MediaStream, so the mic permission,
     * stream, and level meter stay live. Never constructs a recorder on a
     * dead stream: a dead track at the boundary is treated as an
     * unexpected end instead.
     */
    const onRolloverBoundary = useCallback(() => {
      if (stateRef.current.phase !== 'recording') return;
      const take = takeRef.current;
      const rec = chunkRecRef.current;
      const stream = mediaStreamRef.current;
      if (!take || !rec || !stream || rec.mr.state !== 'recording') return;
      const streamLive = stream.getTracks().some((t) => t.readyState === 'live');
      if (!streamLive) {
        rec.reason = null; // unexpected — finalize, don't restart (design D1)
        rec.mr.stop();
        return;
      }
      rec.reason = 'rollover';
      rec.mr.stop();
      startChunkRecorder(stream, take);
    }, [startChunkRecorder]);

    const toggle = useCallback(async (): Promise<boolean> => {
      const { phase } = stateRef.current;

      if (phase === 'recording') {
        // Stop recording
        const stoppedAt = new Date().toISOString();
        stoppedAtRef.current = stoppedAt;
        dispatch({ type: 'STOP_REQUESTED', stoppedAt });
        stopHeartbeat();
        clearRolloverTimer();
        const rec = chunkRecRef.current;
        if (rec && rec.mr.state === 'recording') {
          rec.reason = 'final';
          rec.mr.stop(); // onstop enqueues the final chunk, then finalizeStop drains
        } else if (takeRef.current) {
          void finalizeStop(takeRef.current, 'final');
        }
        return true;
      }

      // drain_blocked deliberately refuses: the recorder reaches idle only
      // after the queue drains or the user explicitly discards (spec).
      if (phase !== 'idle') return false;

      dispatch({ type: 'CLAIM_START' });
      const cid = getClientInstanceId();
      // Bind the session at recording start — the prop may change mid-take
      // (the recorder is not remounted per session); every chunk of this
      // take uploads here (spec: session binding).
      const recordingSessionId = sessionId;
      // Session-scoped ordinals only (fix-wave F2 hardening): the queue is
      // a single process-wide singleton that can hold another session's
      // straggler chunks (design D6 — "a single queue instance uploading
      // to multiple sessions' worth of stragglers is correct by
      // construction"). Deriving THIS recording's ordinal must not let
      // another session's queued/permanent ordinals bleed in — filter by
      // this take's session before taking the max.
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

      mediaStreamRef.current = stream;
      startMicMeter(stream);
      const take: ActiveTake = {
        sessionId: recordingSessionId,
        ordinal,
        nextChunkIndex: 0,
        leaseMode: 'holding',
        leaseInFlight: null,
        claimInFlight: null,
        leaseReleasedLate: false,
      };
      takeRef.current = take;
      // Chunk 1's capture start — also the Started event's wall time below
      // (design D3: actual capture start, not lease-claim time, so the
      // permission-prompt latency never enters transcript-anchor deltas).
      const startedAt = startChunkRecorder(stream, take);

      // Start heartbeat — keys off capture phase, which mid-take uploads
      // never leave (design D3), so it survives every rollover.
      heartbeatRef.current = setInterval(() => {
        if (stateRef.current.phase !== 'recording') {
          stopHeartbeat();
          return;
        }
        leaseTick(take, cid);
      }, HEARTBEAT_INTERVAL_MS);

      // Chunk rollover cadence (design D1/D2).
      rolloverTimerRef.current = setInterval(onRolloverBoundary, chunkMs);

      dispatch({ type: 'CLAIM_OK', ordinal, startedAt });

      // Post started internal event — exactly one per recording, all chunks
      try {
        await logEvent.mutateAsync({
          category: 'internal',
          message: `Recording ${ordinal} Started`,
          marked_at_utc: startedAt,
        });
      } catch {
        /* best effort — recording still proceeds */
      }

      // Kick off recording-dur timer — hoisted to durTimerRef (fix-wave F4)
      // so unmount-mid-recording cleanup can clear it too, not just this
      // self-clearing check on its own next tick. Identity-gated (fix-wave
      // F6/D1): a stop followed by an immediate restart within the same
      // second could otherwise leave the OLD interval alive — it only ever
      // checked `phase !== 'recording'`, which a fast restart re-satisfies
      // before the stale callback's next tick, so it would keep writing the
      // OLD `startMs` forever and the new interval it orphaned would leak.
      // Clearing any pre-existing id up front, then having the callback
      // self-clear (and null the ref) only when it still owns the CURRENT
      // id, makes exactly one live interval possible at a time.
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
      startChunkRecorder,
      onRolloverBoundary,
      finalizeStop,
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

    // While drain_blocked, watch the module-owned queue: once something
    // empties it (a Retry that succeeds or an explicit discard — task 5.1's
    // surface, or the interim direct queue access), the recorder returns to
    // idle. This is the "drain blocked" seam 5.1 builds on.
    //
    // Re-checked immediately on mount, both before and after subscribing
    // (fix-wave F6/D2): the queue can finish draining and fire its final
    // `notify()` in the gap between this component's render (which decided
    // the initial `drain_blocked` phase) and this effect actually attaching
    // the listener — that notify goes unheard, and nothing else would ever
    // dispatch DONE for an already-idle queue. Checking the snapshot
    // directly on both sides of `subscribe()` closes the gap regardless of
    // which side the drain landed on.
    useEffect(() => {
      if (queue.getSnapshot().idle && stateRef.current.phase === 'drain_blocked') {
        dispatch({ type: 'DONE' });
      }
      const unsubscribe = queue.subscribe((snap) => {
        if (snap.idle && stateRef.current.phase === 'drain_blocked') {
          dispatch({ type: 'DONE' });
        }
      });
      if (queue.getSnapshot().idle && stateRef.current.phase === 'drain_blocked') {
        dispatch({ type: 'DONE' });
      }
      return unsubscribe;
    }, [queue]);

    // Update body class for remote-recording CSS
    useEffect(() => {
      const isActive = state.phase === 'recording' || state.phase === 'uploading';
      document.body.classList.toggle('v4-local-recording', isActive);
      // ui-refresh: revives the top-bar RECORDING AUDIO indicator (AppShell) —
      // the class the shipped markup always keyed on but nothing ever toggled.
      // Scoped to the live-recording phase only, so the strip never claims
      // "recording" during upload. Rollovers never leave 'recording'
      // (design D3), so the indicator stays lit across chunk boundaries.
      document.body.classList.toggle('v4-is-recording', state.phase === 'recording');
      // Unmount cleanup (spec: "Unmount while recording clears the strip"): the
      // recorder unmounts on session close/switch or route change; without this
      // the body classes — and the strip they reveal — would leak past the
      // component's life. `v4-local-recording` shares the same leak shape (same
      // effect, same body-state semantics), so it is removed here too.
      return () => {
        document.body.classList.remove('v4-local-recording');
        document.body.classList.remove('v4-is-recording');
      };
    }, [state.phase]);

    // Tear down the analyser only on unmount (not on every phase flip — starting
    // the meter races CLAIM_OK before this effect would otherwise re-run).
    useEffect(() => () => stopMicMeter(), [stopMicMeter]);

    // Release on page hide / tab close
    useEffect(() => {
      const onHide = () => {
        if (stateRef.current.phase !== 'recording') return;
        stopHeartbeat();
        // The take's session, not the prop's: the prop can change mid-take.
        beaconRelease(takeRef.current?.sessionId ?? sessionId);
      };
      window.addEventListener('pagehide', onHide);
      return () => window.removeEventListener('pagehide', onHide);
    }, [beaconRelease, stopHeartbeat, sessionId]);

    // Warn before unload while recording. The listener is registered only for
    // the span of an actual recording, not for the component's whole mount:
    // a registered `beforeunload` listener disqualifies the page from the
    // back/forward cache on its mere presence, regardless of whether the
    // handler would warn, so gating the registration (not just the handler
    // body) is what keeps bfcache eligible on an idle session page.
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

    // Cleanup on unmount. Stopping the recorder marks a 'final' stop: its
    // onstop enqueues what was captured and the module-owned queue keeps
    // pumping after unmount (spec: uploads survive component lifecycle).
    useEffect(() => {
      return () => {
        stopHeartbeat();
        // Defense-in-depth timer hygiene (fix-wave F4/F5): both timers
        // otherwise only self-clear by observing phase on their own next
        // tick, which never happens once the component (and, for the
        // rollover timer, the interval callback's closure) is gone.
        clearRolloverTimer();
        if (durTimerRef.current != null) {
          clearInterval(durTimerRef.current);
          durTimerRef.current = null;
        }
        const rec = chunkRecRef.current;
        if (rec && rec.mr.state === 'recording') {
          rec.reason = 'final';
          rec.mr.stop();
        }
        for (const t of mediaStreamRef.current?.getTracks() ?? []) t.stop();
      };
    }, [stopHeartbeat, clearRolloverTimer]);

    return null;
  },
);
