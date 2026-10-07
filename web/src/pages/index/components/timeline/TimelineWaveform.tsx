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
// are retained for the perf-debug @layer rules that target them. The unplayed body is a flat
// on-palette wash (`--si-wave-body`; 11.4 cleanup retired the V5 slate gradient). The decoding
// label folds Timeline's former hash-scoped keyframe into the shared wf-label-pulse token.
const WAVEFORMS = 'timelineWaveforms absolute inset-0 h-full pointer-events-none z-[1]';
const WAVEFORM_FULL =
  'absolute top-0 left-0 h-full w-full overflow-hidden box-border isolate [contain:paint]';
const WAVEFORM_SVG = 'block relative w-full h-full [shape-rendering:geometricPrecision]';
const WAVEFORM_FILL = 'timelineWaveformFill [fill:var(--si-wave-body)] stroke-none';
// The played portion is the one accent, flat (finish review fix round 2: it was a sky-blue ramp,
// a second hue beside #5b7cff). Fix round 3: it follows the transport (`--tx-wave-progress`): a dim
// neutral when stopped, the accent in playback and live, easing between states (still under
// reduced motion).
const WAVEFORM_PROGRESS =
  'timelineWaveformProgress [fill:var(--tx-wave-progress)] stroke-none [transition:fill_var(--tx-dur)_var(--tx-ease)] motion-reduce:transition-none';
const WAVEFORM_DECODING_LABEL =
  'absolute inset-0 flex items-center justify-center pointer-events-none z-[2] text-[2rem] font-medium tracking-[0.06em] uppercase text-[rgba(229,238,252,0.42)] animate-wf-label-pulse motion-reduce:animate-none motion-reduce:opacity-85';

interface Props {
  mergedPeaks: Float32Array | null;
  isDecoding?: boolean;
  activeSec: number;
  totalSec: number;
  clips: AudioClipLite[];
}

function WaveformDefs({ progRect }: { progRect: WaveformProgressRect | null }) {
  return (
    <defs>
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
          <WaveformDefs progRect={progRect} />
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
