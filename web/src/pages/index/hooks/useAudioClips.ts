import { useEffect, useMemo, useRef, useState } from 'react';
import { useAudioSegments } from '../../../api/hooks/useAudio';
import { useSessionStatus } from '../../../api/hooks/useSessionStatus';
import type { AudioSegment, LogEvent } from '../../../api/types';
import { computeTotalSec, rebuildAudioClips } from '../../../shared/utils/audioClips';
import type { AudioClipLite } from '../../../shared/utils/waveformMerge';

/**
 * Probes HTMLAudioElement metadata for a single segment URL. Returns the duration
 * in seconds, or null if the probe fails (codec, CORS, corrupt file). The element
 * is created with preload='metadata' and never inserted into the DOM.
 */
function probeSegmentDuration(url: string, signal?: AbortSignal): Promise<number | null> {
  return new Promise((resolve) => {
    if (!url || signal?.aborted) {
      resolve(null);
      return;
    }
    const probe = new Audio();
    probe.preload = 'metadata';
    const settle = (d: number | null) => {
      probe.removeEventListener('loadedmetadata', onMeta);
      probe.removeEventListener('error', onErr);
      signal?.removeEventListener('abort', onAbort);
      // Detach src so any in-flight fetch stops and the element can be GC'd.
      probe.removeAttribute('src');
      probe.load();
      resolve(d);
    };
    const onMeta = () => {
      const d = Number(probe.duration);
      settle(Number.isFinite(d) && d > 0 ? d : null);
    };
    const onErr = () => settle(null);
    const onAbort = () => settle(null);
    probe.addEventListener('loadedmetadata', onMeta, { once: true });
    probe.addEventListener('error', onErr, { once: true });
    signal?.addEventListener('abort', onAbort, { once: true });
    probe.src = url;
  });
}

export interface AudioClipsLayout {
  clips: AudioClipLite[];
  totalSec: number;
}

/**
 * React-owned audio-segment + clip layout for the session timeline.
 *
 * Pulls segments from `useAudioSegments`, probes durations via HTMLAudioElement,
 * then runs the clip-matching pipeline (`rebuildAudioClips`) against `events` and
 * `status`. Returns `{ clips, totalSec }` for AudioPlayer + useWaveforms.
 */
export function useAudioClips(
  sessionId: string,
  events: LogEvent[],
): AudioClipsLayout & { segments: AudioSegment[] } {
  const { data: audioData } = useAudioSegments(sessionId || null);
  const { data: status } = useSessionStatus(sessionId || null);
  const segments = useMemo(() => audioData?.segments ?? [], [audioData]);

  // Trigger a sync-from-disk once per session so freshly-uploaded files appear.
  useEffect(() => {
    if (!sessionId) return;
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/audio/segments/sync-from-disk`, {
      method: 'POST',
      credentials: 'same-origin',
    }).catch(() => undefined);
  }, [sessionId]);

  // Probe durations: segments without server-known duration_sec need an HTMLAudio probe.
  // Cache keyed by segment id; survives across re-renders within a session.
  const durationsRef = useRef<Map<string, number>>(new Map());
  const [durationsTick, setDurationsTick] = useState(0);

  // Reset cache on session switch.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset on sessionId change
  useEffect(() => {
    durationsRef.current = new Map();
    setDurationsTick((t) => t + 1);
  }, [sessionId]);

  // Probe any segment we don't have a duration for yet.
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    let ingestedServerDurations = false;
    const pending = segments.filter((s) => {
      if (!s.id || !s.url) return false;
      if (durationsRef.current.has(s.id)) return false;
      // Server-provided duration_sec wins; skip probe in that case.
      const dServ = Number(s.duration_sec);
      if (Number.isFinite(dServ) && dServ > 0) {
        durationsRef.current.set(s.id, dServ);
        ingestedServerDurations = true;
        return false;
      }
      return true;
    });
    if (pending.length === 0) {
      // Bump tick only if we ingested any server-provided durations above —
      // an unconditional bump forced a spurious layout recompute on every
      // segments identity change (code-health-tail 4.8).
      if (ingestedServerDurations) setDurationsTick((t) => t + 1);
      return;
    }
    (async () => {
      const results = await Promise.all(
        pending.map(async (s) => ({
          id: s.id,
          d: await probeSegmentDuration(s.url, controller.signal),
        })),
      );
      if (cancelled) return;
      for (const { id, d } of results) {
        if (d != null) durationsRef.current.set(id, d);
      }
      setDurationsTick((t) => t + 1);
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [segments]);

  const layout = useMemo<AudioClipsLayout>(() => {
    void durationsTick; // recompute when probes complete
    const segmentDurations = segments.map((s) => durationsRef.current.get(s.id) ?? null);
    const clips = rebuildAudioClips(segments, segmentDurations, events, status ?? null);
    const totalSec = computeTotalSec(status ?? null, events, clips);
    return { clips, totalSec };
  }, [segments, events, status, durationsTick]);

  return { clips: layout.clips, totalSec: layout.totalSec, segments };
}
