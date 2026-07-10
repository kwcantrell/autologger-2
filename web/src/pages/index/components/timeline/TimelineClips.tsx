import clsx from 'clsx';
import { useMemo } from 'react';
import type { AudioClipLite } from '../../../../shared/utils/waveformMerge';
import styles from '../Timeline.module.css';

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
    <div className={styles.timelineClips} id="timeline-clips">
      {positioned.map(({ key, sPct, wPct, missing, title, i }) => (
        <div
          key={key}
          className={clsx(
            styles.timelineClip,
            missing && styles.timelineClipMissingAudio,
            activeClipIdx === i && styles.timelineClipActive,
          )}
          title={title}
          style={{ left: `${sPct}%`, width: `${wPct}%` }}
        />
      ))}
    </div>
  );
}
