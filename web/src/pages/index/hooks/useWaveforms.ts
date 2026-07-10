import { useCallback, useEffect, useRef, useState } from 'react';
import { useAudioSegments, useUploadWaveform } from '../../../api/hooks/useAudio';
import { fetchAndDecodeWaveformPeaks } from '../../../shared/utils/waveformDecode';
import {
  type AudioClipLite,
  clipLayoutFingerprint,
  mergeAudioClipsIntoTimelinePeaks,
  remapWaveformPeaksDbEnvelope,
  resampleTimelinePeaksToNewSpan,
  segmentWaveformDecodeBucketCount,
  WF_DB_FLOOR,
  WF_LEGACY_DB_FLOOR,
  WF_MERGED_RESAMPLE_MIN_DELTA_SEC,
} from '../../../shared/utils/waveformMerge';

/**
 * Stateful waveform cache + decode loop for the session timeline.
 *
 * React (`useAudioClips`) owns the clip layout; this hook ingests it as a prop
 * and maintains the per-segment peaks cache + merged envelope, returned to
 * `Timeline` JSX as a `Float32Array | null`.
 *
 * The per-segment cache is seeded from `segment.waveform_peaks` (which the server
 * stores after the first decode) and topped up by client-side fetch+decode of any
 * still-missing clips. Decoded peaks are persisted back via PUT so the next session
 * load skips the network/decode step.
 */

interface WaveformAudioContextCtor {
  new (): AudioContext;
}

function getAudioContextCtor(): WaveformAudioContextCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    AudioContext?: WaveformAudioContextCtor;
    webkitAudioContext?: WaveformAudioContextCtor;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

interface LayoutSnapshot {
  fp: string;
  clips: AudioClipLite[];
  totalSec: number;
}

export function useWaveforms(
  sessionId: string,
  clips: AudioClipLite[],
  totalSec: number,
): { mergedPeaks: Float32Array | null; isDecoding: boolean } {
  const { data: audioData } = useAudioSegments(sessionId || null);
  const upload = useUploadWaveform(sessionId);

  // Caches owned by refs so window-global pushes/pulls don't suffer stale closures.
  const peaksByIdRef = useRef<Map<string, Float32Array | null>>(new Map());
  const layoutRef = useRef<LayoutSnapshot | null>(null);
  const mergedRef = useRef<Float32Array | null>(null);
  const mergedAtTotalSecRef = useRef<number | null>(null);
  const decodeGenRef = useRef(0);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const decodeAbortRef = useRef<AbortController | null>(null);
  const uploadRef = useRef(upload);
  uploadRef.current = upload;
  const audioDataRef = useRef(audioData);
  audioDataRef.current = audioData;

  // mergedPeaks state — drives Timeline JSX re-renders. The ref is the source of truth
  // so synchronous reads always see the latest value without waiting for a commit.
  const [mergedPeaks, setMergedPeaks] = useState<Float32Array | null>(null);
  const [isDecoding, setIsDecoding] = useState(false);
  const publishMerged = useCallback((peaks: Float32Array | null): void => {
    mergedRef.current = peaks;
    setMergedPeaks(peaks);
  }, []);

  // Ingest server-provided waveform_peaks whenever the segments query updates.
  useEffect(() => {
    const segs = audioData?.segments ?? [];
    const map = peaksByIdRef.current;
    let changed = false;
    for (const seg of segs) {
      const id = seg.id;
      const arr = seg.waveform_peaks;
      if (!id || !Array.isArray(arr) || arr.length < 8) continue;
      if (map.has(id)) {
        const existing = map.get(id);
        if (existing && existing.length > 0) continue;
      }
      const f = seg.waveform_db_floor;
      if (f != null && Number(f) === WF_DB_FLOOR) {
        map.set(id, Float32Array.from(arr));
        changed = true;
        continue;
      }
      const oldFloor = f == null ? WF_LEGACY_DB_FLOOR : Number(f);
      if (!Number.isFinite(oldFloor) || oldFloor >= 0) continue;
      map.set(id, remapWaveformPeaksDbEnvelope(arr, oldFloor, WF_DB_FLOOR));
      changed = true;
    }
    if (changed && layoutRef.current) {
      const { clips, totalSec } = layoutRef.current;
      publishMerged(mergeAudioClipsIntoTimelinePeaks(totalSec, clips, map));
      mergedAtTotalSecRef.current = totalSec;
    }
  }, [audioData, publishMerged]);

  // Ingest clip layout changes pushed from useAudioClips. Re-merges the cached
  // peaks and kicks off decodes for any new clip whose segment isn't cached yet.
  useEffect(() => {
    const ensureCtx = (): AudioContext | null => {
      if (!audioCtxRef.current) {
        const Ctor = getAudioContextCtor();
        if (!Ctor) return null;
        audioCtxRef.current = new Ctor();
      }
      return audioCtxRef.current;
    };

    const runDecodes = async (
      pending: AudioClipLite[],
      spanSec: number,
      layoutFp: string,
      gen: number,
      signal: AbortSignal,
    ): Promise<void> => {
      const ctx = ensureCtx();
      if (!ctx) return;
      try {
        await ctx.resume().catch(() => undefined);
      } catch {
        return;
      }
      const results = await Promise.all(
        pending.map(async (c) => {
          const id = c.segmentId;
          const url = c.url;
          if (!id || !url) return { id: null as string | null, peaks: null as Float32Array | null };
          try {
            const bc = segmentWaveformDecodeBucketCount(c.duration, spanSec);
            const peaks = await fetchAndDecodeWaveformPeaks(url, ctx, {
              bucketCount: bc,
              dbFloor: WF_DB_FLOOR,
              signal,
            });
            return { id, peaks };
          } catch {
            return { id, peaks: null as Float32Array | null };
          }
        }),
      );
      if (gen !== decodeGenRef.current) return;
      if (layoutRef.current?.fp !== layoutFp) return;
      const map = peaksByIdRef.current;
      for (const { id, peaks } of results) {
        if (!id) continue;
        map.set(id, peaks);
        if (peaks && peaks.length >= 8) {
          uploadRef.current
            .mutateAsync({ segmentId: id, body: { peaks: Array.from(peaks, (x) => Number(x)) } })
            .catch(() => undefined);
        }
      }
      if (gen !== decodeGenRef.current) return;
      if (layoutRef.current?.fp !== layoutFp) return;
      setIsDecoding(false);
      const totalAtMerge = layoutRef.current.totalSec;
      publishMerged(mergeAudioClipsIntoTimelinePeaks(totalAtMerge, layoutRef.current.clips, map));
      mergedAtTotalSecRef.current = totalAtMerge;
    };

    const map = peaksByIdRef.current;
    const segmentIds = (audioDataRef.current?.segments ?? []).map((s) => s.id);
    const fp = clipLayoutFingerprint(segmentIds, clips);
    const prev = layoutRef.current;
    if (prev && prev.fp === fp) {
      // Layout unchanged — possibly only totalSec changed (rolling timecode growth).
      const delta = Math.abs(totalSec - (mergedAtTotalSecRef.current ?? totalSec));
      if (mergedRef.current && delta > WF_MERGED_RESAMPLE_MIN_DELTA_SEC) {
        publishMerged(
          resampleTimelinePeaksToNewSpan(
            mergedRef.current,
            mergedAtTotalSecRef.current ?? totalSec,
            totalSec,
          ),
        );
        mergedAtTotalSecRef.current = totalSec;
      } else if (!mergedRef.current) {
        publishMerged(mergeAudioClipsIntoTimelinePeaks(totalSec, clips, map));
        mergedAtTotalSecRef.current = totalSec;
      }
      layoutRef.current = { fp, clips, totalSec };
      // Don't touch isDecoding here — a decode may be in flight for this layout.
      return;
    }
    // Layout changed — bump generation, merge from current cache, kick off decodes.
    decodeGenRef.current += 1;
    const gen = decodeGenRef.current;
    layoutRef.current = { fp, clips, totalSec };
    publishMerged(mergeAudioClipsIntoTimelinePeaks(totalSec, clips, map));
    mergedAtTotalSecRef.current = totalSec;
    const pending = clips.filter((c) => {
      if (!c.segmentId || !c.url || c.missingAudio) return false;
      const cached = map.get(c.segmentId);
      return !(cached && cached.length > 0);
    });
    if (pending.length > 0) {
      decodeAbortRef.current?.abort();
      const ctrl = new AbortController();
      decodeAbortRef.current = ctrl;
      setIsDecoding(true);
      void runDecodes(pending, totalSec, fp, gen, ctrl.signal);
    } else {
      setIsDecoding(false);
    }
  }, [clips, totalSec, publishMerged]);

  // Reset cache + layout on session switch.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset
  useEffect(() => {
    // Abort any in-flight fetches and close the AudioContext so stale decode
    // work for the previous session is cancelled immediately rather than
    // competing with the new session's downloads and audio-thread budget.
    decodeAbortRef.current?.abort();
    decodeAbortRef.current = null;
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => undefined);
      audioCtxRef.current = null;
    }
    // Pre-seed peaks from the new session's audioData. The audioData effect
    // runs in the same commit but before this effect; clearing to an empty Map
    // would discard those seeds and cause the durationsTick-triggered clips
    // effect (next commit) to treat all clips as uncached and start a full
    // unnecessary decode. Reading from audioDataRef (the ref, not the dep)
    // gives the current render's data regardless of effect ordering.
    const newMap = new Map<string, Float32Array | null>();
    for (const seg of audioDataRef.current?.segments ?? []) {
      const id = seg.id;
      const arr = seg.waveform_peaks;
      if (!id || !Array.isArray(arr) || arr.length < 8) continue;
      const f = seg.waveform_db_floor;
      if (f != null && Number(f) === WF_DB_FLOOR) {
        newMap.set(id, Float32Array.from(arr));
        continue;
      }
      const oldFloor = f == null ? WF_LEGACY_DB_FLOOR : Number(f);
      if (!Number.isFinite(oldFloor) || oldFloor >= 0) continue;
      newMap.set(id, remapWaveformPeaksDbEnvelope(arr, oldFloor, WF_DB_FLOOR));
    }
    peaksByIdRef.current = newMap;
    layoutRef.current = null;
    publishMerged(null);
    setIsDecoding(false);
    mergedAtTotalSecRef.current = null;
    decodeGenRef.current += 1;
  }, [sessionId]);

  return { mergedPeaks, isDecoding };
}
