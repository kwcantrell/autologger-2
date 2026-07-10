import { useMemo } from 'react';
import type { AudioClipLite } from '../../../../shared/utils/waveformMerge';
import {
  clipIndexContainingTimelineSec,
  timelineWaveformProgressClipRect,
  type WaveformProgressRect,
  waveformSvgSpec,
} from '../../../../shared/utils/waveformSvg';

// --- converted class strings (were Timeline.module.css) ---
// The `timelineWaveforms` / `timelineWaveformFill` / `timelineWaveformProgress` literals
// are retained for the perf-debug @layer rules that target them. Fill/progress use the v5
// gradient url() — the #v4-log-session override, which is always the case here. The decoding
// label folds Timeline's former hash-scoped keyframe into the shared wf-label-pulse token.
const WAVEFORMS = 'timelineWaveforms absolute inset-0 h-full pointer-events-none z-[1]';
const WAVEFORM_FULL =
  'absolute top-0 left-0 h-full w-full overflow-hidden box-border isolate [contain:paint]';
const WAVEFORM_SVG = 'block relative w-full h-full [shape-rendering:geometricPrecision]';
const WAVEFORM_FILL = 'timelineWaveformFill [fill:url(#timeline-wf-v5-fill)] stroke-none';
const WAVEFORM_PROGRESS = 'timelineWaveformProgress [fill:url(#timeline-wf-v5-prog)] stroke-none';
const WAVEFORM_DECODING_LABEL =
  'absolute inset-0 flex items-center justify-center pointer-events-none z-[2] text-[2rem] font-medium tracking-[0.06em] uppercase text-[rgba(229,238,252,0.42)] animate-wf-label-pulse motion-reduce:animate-none motion-reduce:opacity-85';

interface Props {
  mergedPeaks: Float32Array | null;
  isDecoding?: boolean;
  activeSec: number;
  totalSec: number;
  clips: AudioClipLite[];
}

function V5Defs({ w, progRect }: { w: number; progRect: WaveformProgressRect | null }) {
  return (
    <defs>
      <linearGradient
        id="timeline-wf-v5-fill"
        gradientUnits="userSpaceOnUse"
        x1="0"
        y1="0"
        x2="0"
        y2="100"
      >
        <stop offset="0%" stopColor="#94a3b8" stopOpacity="0.5" />
        <stop offset="34%" stopColor="#64748b" stopOpacity="0.56" />
        <stop offset="68%" stopColor="#334155" stopOpacity="0.62" />
        <stop offset="100%" stopColor="#0f172a" stopOpacity="0.78" />
      </linearGradient>
      <linearGradient
        id="timeline-wf-v5-prog"
        gradientUnits="userSpaceOnUse"
        x1="0"
        y1="0"
        x2={w}
        y2="0"
      >
        <stop offset="0%" stopColor="#94a3b8" stopOpacity="0.45" />
        <stop offset="28%" stopColor="#7dd3fc" stopOpacity="0.82" />
        <stop offset="62%" stopColor="#38bdf8" stopOpacity="0.9" />
        <stop offset="100%" stopColor="#0284c7" stopOpacity="0.92" />
      </linearGradient>
      {progRect && (
        <clipPath id="timeline-wf-p-full">
          <rect
            id="timeline-wf-progress-rect"
            x={progRect.x}
            y="0"
            width={progRect.width}
            height="100"
          />
        </clipPath>
      )}
    </defs>
  );
}

export function TimelineWaveform({ mergedPeaks, isDecoding, activeSec, totalSec, clips }: Props) {
  const { w, pathD } = useMemo(() => waveformSvgSpec(mergedPeaks), [mergedPeaks]);
  const progRect = useMemo(() => {
    if (!mergedPeaks || mergedPeaks.length === 0) return null;
    const idx = clipIndexContainingTimelineSec(activeSec, clips);
    return timelineWaveformProgressClipRect(w, activeSec, totalSec, idx, clips);
  }, [mergedPeaks, w, activeSec, totalSec, clips]);

  if (!mergedPeaks || mergedPeaks.length === 0) {
    return (
      <div className={WAVEFORMS} id="timeline-waveforms" aria-hidden={true}>
        <div className={WAVEFORM_FULL} aria-hidden={true} />
        {clips.length > 0 && (
          <div className={WAVEFORM_DECODING_LABEL} aria-hidden={true}>
            Generating waveform…
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={WAVEFORMS} id="timeline-waveforms" aria-hidden={true}>
      <div className={WAVEFORM_FULL} aria-hidden={true}>
        <svg
          className={WAVEFORM_SVG}
          viewBox={`0 0 ${w} 100`}
          preserveAspectRatio="none"
          aria-hidden={true}
        >
          <V5Defs w={w} progRect={progRect} />
          <path className={WAVEFORM_FILL} d={pathD} />
          {progRect && (
            <path className={WAVEFORM_PROGRESS} d={pathD} clipPath="url(#timeline-wf-p-full)" />
          )}
        </svg>
      </div>
      {isDecoding && (
        <div className={WAVEFORM_DECODING_LABEL} aria-hidden={true}>
          Generating waveform…
        </div>
      )}
    </div>
  );
}
