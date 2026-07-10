import clsx from 'clsx';
import { useMemo } from 'react';
import type { AudioClipLite } from '../../../../shared/utils/waveformMerge';

// --- converted class strings (were Timeline.module.css) ---
// TWO-MODE: base = standalone clip strips; `[#v4-log-session_&]:` = the session-context
// look, which hides clips entirely (the former !important flags become utilities that
// win by layer order). --timeline-clip-strip-h is a local prop set per state. The
// literal `timelineClipActive` is retained for the perf-debug @layer rule.
const CLIPS = 'absolute inset-0 h-full pointer-events-none z-[4]';
// .timelineClip base + #v4-log-session hide.
const CLIP =
  '[--timeline-clip-strip-h:max(1px,0.0625rem)] absolute top-auto bottom-0 left-0 w-0 h-[calc(var(--timeline-clip-strip-h)*1.5)] [background:color-mix(in_srgb,var(--color-accent)_40%,transparent)] shadow-none rounded-none [#v4-log-session_&]:opacity-0 [#v4-log-session_&]:invisible [#v4-log-session_&]:h-0 [#v4-log-session_&]:min-h-0 [#v4-log-session_&]:shadow-none [#v4-log-session_&]:border-none';
// .timelineClipMissingAudio (base + the .active.missing base is the same red).
const CLIP_MISSING =
  '[--timeline-clip-strip-h:max(4px,0.25rem)] [background:rgba(220,60,60,0.3)] shadow-none';
// .timelineClipActive — retained literal for perf-debug targeting. Geometry (strip-h,
// height) applies whenever active; the accent background is applied only when NOT missing,
// so `.timelineClipActive.timelineClipMissingAudio` keeps the red bg (source-order match).
const CLIP_ACTIVE =
  'timelineClipActive [--timeline-clip-strip-h:max(4px,0.25rem)] h-[calc(var(--timeline-clip-strip-h)*0.8)]';
const CLIP_ACTIVE_BG = '[background:color-mix(in_srgb,var(--color-accent)_100%,transparent)]';

interface Props {
  clips: AudioClipLite[];
  totalSec: number;
  activeClipIdx: number;
}

function safeTimelineSec(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function TimelineClips({ clips, totalSec, activeClipIdx }: Props) {
  const positioned = useMemo(() => {
    if (totalSec <= 0) return [];
    return clips.map((c, i) => {
      const s0 = safeTimelineSec(c.startSec, 0);
      const e0 = safeTimelineSec(c.endSec, s0);
      const sPct = Math.max(0, Math.min(100, (s0 / totalSec) * 100));
      const ePct = Math.max(0, Math.min(100, (e0 / totalSec) * 100));
      const wPct = Math.max(0.2, ePct - sPct);
      const missing = c.missingAudio || !c.url;
      const title = missing ? 'No audio file for this log interval' : `Audio clip ${i + 1}`;
      return { i, sPct, wPct, missing, title, key: c.segmentId ?? `idx-${i}` };
    });
  }, [clips, totalSec]);

  return (
    <div className={CLIPS} id="timeline-clips">
      {positioned.map(({ key, sPct, wPct, missing, title, i }) => {
        const active = activeClipIdx === i;
        return (
          <div
            key={key}
            className={clsx(
              CLIP,
              missing && CLIP_MISSING,
              active && CLIP_ACTIVE,
              active && !missing && CLIP_ACTIVE_BG,
            )}
            title={title}
            style={{ left: `${sPct}%`, width: `${wPct}%` }}
          />
        );
      })}
    </div>
  );
}
