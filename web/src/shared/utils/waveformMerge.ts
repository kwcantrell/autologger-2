/**
 * Pure functions for building the merged waveform envelope drawn on the timeline.
 * Stateless — the hook (useWaveforms) owns the per-segment peaks cache and the
 * merged-envelope reference.
 */

export const WF_TIMELINE_BUCKETS = 5000;
export const WF_DB_FLOOR = -48;
export const WF_LEGACY_DB_FLOOR = -72;
export const WF_SEGMENT_DECODE_MIN = 256;
export const WF_SEGMENT_DECODE_MAX = 4096;
/** Min |ΔtotalSec| before resampling merged peaks (rolling timeline). Avoids constant morphing. */
export const WF_MERGED_RESAMPLE_MIN_DELTA_SEC = 1.25;

export interface AudioClipLite {
  segmentId: string | null;
  url: string | null;
  startSec: number;
  endSec: number;
  duration: number;
  missingAudio: boolean;
}

export function remapWaveformPeaksDbEnvelope(
  peaks: ArrayLike<number>,
  oldFloor: number,
  newFloor: number,
): Float32Array {
  const dOld = -oldFloor;
  const dNew = -newFloor;
  const out = new Float32Array(peaks.length);
  for (let i = 0; i < peaks.length; i++) {
    const db = oldFloor + Number(peaks[i]) * dOld;
    const dbClamped = Math.max(newFloor, Math.min(0, db));
    out[i] = (dbClamped - newFloor) / dNew;
  }
  return out;
}

export function segmentWaveformDecodeBucketCount(
  durationSec: number,
  timelineSpanSec: number,
): number {
  const span = Math.max(Number(timelineSpanSec) || 1, 1);
  const d = Math.max(Number(durationSec) || 0, 0.05);
  const raw = Math.round((WF_TIMELINE_BUCKETS * 2 * d) / span);
  return Math.max(WF_SEGMENT_DECODE_MIN, Math.min(WF_SEGMENT_DECODE_MAX, raw));
}

/** Fingerprint of clip layout — used to detect when a re-merge is needed. */
export function clipLayoutFingerprint(
  segmentIds: readonly string[],
  clips: readonly AudioClipLite[],
): string {
  const segs = segmentIds.join(',');
  const cs = clips
    .map((c) => `${c.segmentId ?? ''}:${c.startSec}:${c.endSec}:${c.duration}`)
    .join(';');
  return `${segs}|${cs}`;
}

function samplePeaksLinear(peaks: ArrayLike<number>, u: number): number {
  if (!peaks || peaks.length === 0) return 0;
  const n = peaks.length;
  if (n === 1) return Number(peaks[0]) || 0;
  const x = Math.max(0, Math.min(1, u)) * (n - 1);
  const i = Math.floor(x);
  const f = x - i;
  const a = Number(peaks[i]) || 0;
  const b = Number(peaks[Math.min(i + 1, n - 1)]) || 0;
  return a + f * (b - a);
}

export function mergeAudioClipsIntoTimelinePeaks(
  spanSec: number,
  clips: readonly AudioClipLite[],
  peaksById: ReadonlyMap<string, Float32Array | null>,
): Float32Array {
  const n = WF_TIMELINE_BUCKETS;
  const out = new Float32Array(n);
  if (!(Number.isFinite(spanSec) && spanSec > 0)) return out;
  for (let b = 0; b < n; b += 1) {
    const t = ((b + 0.5) / n) * spanSec;
    let m = 0;
    for (const c of clips) {
      if (!c.segmentId || c.missingAudio || !c.url) continue;
      const d = Number(c.duration);
      const t0 = Number(c.startSec);
      if (!Number.isFinite(d) || d <= 0 || !Number.isFinite(t0)) continue;
      const offset = t - t0;
      if (offset < 0 || offset >= d) continue;
      const peaks = peaksById.get(c.segmentId);
      if (!peaks || peaks.length === 0) continue;
      const u = offset / d;
      const v = samplePeaksLinear(peaks, u);
      if (v > m) m = v;
    }
    out[b] = m;
  }
  return out;
}

/** Stretch an existing merged envelope to a new total-span without re-merging. */
export function resampleTimelinePeaksToNewSpan(
  peaks: Float32Array,
  oldSpan: number,
  newSpan: number,
): Float32Array {
  const n = WF_TIMELINE_BUCKETS;
  const out = new Float32Array(n);
  if (!peaks || peaks.length !== n || !(oldSpan > 0) || !(newSpan > 0)) return out;
  if (Math.abs(oldSpan - newSpan) < 1e-9) {
    out.set(peaks);
    return out;
  }
  for (let b = 0; b < n; b += 1) {
    const t = ((b + 0.5) / n) * newSpan;
    if (t >= oldSpan) {
      out[b] = 0;
      continue;
    }
    const pos = (t / oldSpan) * (n - 1);
    const i = Math.floor(pos);
    const f = pos - i;
    const a = peaks[i];
    const b0 = peaks[Math.min(i + 1, n - 1)];
    out[b] = a + f * (b0 - a);
  }
  return out;
}
