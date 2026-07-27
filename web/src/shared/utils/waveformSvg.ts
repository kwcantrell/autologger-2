import { safeTimelineSec } from './audioClips';
import type { AudioClipLite } from './waveformMerge';

/** ViewBox height fraction used for 0 → full-scale peak (headroom above the loudest bin). */
const WF_SVG_PEAK_SPAN = 80;

function waveformPeakToSvgY(peak01: number): number {
  const amp = Number.isFinite(peak01) ? peak01 : 0;
  const y = 100 - amp * WF_SVG_PEAK_SPAN;
  return Math.max(100 - WF_SVG_PEAK_SPAN, Math.min(100, y));
}

export interface WaveformSvgSpec {
  w: number;
  pathD: string;
}

export function waveformSvgSpec(peaks: Float32Array | null | undefined): WaveformSvgSpec {
  if (!peaks || peaks.length === 0) {
    return { w: 1, pathD: 'M 0 100 L 1 100 Z' };
  }
  const n = peaks.length;
  if (n === 1) {
    const pk = Number(peaks[0]);
    const pv = Number.isFinite(pk) ? pk : 0;
    const y = waveformPeakToSvgY(pv);
    return { w: 1, pathD: `M 0 100 L 0 ${y} L 1 ${y} L 1 100 Z` };
  }
  const w = n - 1;
  const ys: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const p = Number(peaks[i]);
    ys.push(waveformPeakToSvgY(Number.isFinite(p) ? p : 0));
  }
  let d = `M 0 100 L 0 ${ys[0]}`;
  for (let i = 1; i < n; i++) d += ` L ${i} ${ys[i]}`;
  d += ` L ${w} 100 Z`;
  return { w, pathD: d };
}

/** Playable clip under the playhead (half-open [start, end)); skips placeholders. */
export function clipIndexContainingTimelineSec(
  activeSec: number,
  clips: readonly AudioClipLite[],
): number {
  const t = Number(activeSec);
  if (!Number.isFinite(t)) return -1;
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    if (c.missingAudio || !c.url || !c.segmentId) continue;
    const s0 = safeTimelineSec(c.startSec, 0);
    const e0 = safeTimelineSec(c.endSec, s0);
    if (t >= s0 && t < e0) return i;
  }
  return -1;
}

export interface WaveformProgressRect {
  x: number;
  width: number;
}

/**
 * Blue progress rect in SVG viewBox coords for the waveform overlay:
 * from the active clip's timeline start → playhead.
 */
export function timelineWaveformProgressClipRect(
  w: number,
  activeSec: number,
  totalSec: number,
  clipIdx: number,
  clips: readonly AudioClipLite[],
): WaveformProgressRect | null {
  if (!(Number.isFinite(w) && w > 0 && totalSec > 0)) return null;
  if (clipIdx < 0 || clipIdx >= clips.length) return null;
  const clip = clips[clipIdx];
  const t0 = safeTimelineSec(clip?.startSec, 0);
  const t = Number(activeSec);
  if (!Number.isFinite(t) || t <= t0) return null;
  const x0 = (t0 / totalSec) * w;
  const x1 = Math.max(0, Math.min(w, (t / totalSec) * w));
  const width = x1 - x0;
  if (width <= 0.0001) return null;
  return { x: x0, width };
}
