// ai-v2-dashboards — talk_time_by_speaker catalog widget (task 4.3). Bars by
// speaker, each carrying a direct numeric label (spec/brief: color is never
// the only channel) and a swatch-beside-text identity (text never wears a
// series color). Can act as a `highlight_speaker` interaction SOURCE
// (`onSpeakerSelect`, wired by DashboardGrid) and/or TARGET (`highlightSpeaker`).

import clsx from 'clsx';
import { fmtHmsFromSec } from '../../../../shared/utils/timecode';
import { speakerColorVar, speakerLabel } from './palette';
import { UnavailableState } from './UnavailableState';
import type { TalkTimeData } from './widgetTypes';

interface Props {
  data: TalkTimeData;
  /** highlight_speaker interaction SOURCE: fires when a bar is activated. */
  onSpeakerSelect?: (speakerId: string) => void;
  /** highlight_speaker interaction TARGET: dim non-matching speakers when set. */
  highlightSpeaker?: string | null;
}

export function TalkTimeBySpeakerWidget({ data, onSpeakerSelect, highlightSpeaker }: Props) {
  if (!data.available) {
    return <UnavailableState reason={data.reason ?? 'Talk time is unavailable.'} />;
  }
  const total = data.bySpeaker.reduce((sum, s) => sum + s.talkTimeSec, 0);
  return (
    <div
      className="flex flex-1 min-h-0 flex-col justify-center gap-2"
      data-testid="aiv2-widget-talk_time_by_speaker"
    >
      {data.bySpeaker.map((slice) => {
        const pct = total > 0 ? (slice.talkTimeSec / total) * 100 : 0;
        const dimmed = Boolean(highlightSpeaker) && highlightSpeaker !== slice.speaker;
        const color = speakerColorVar(slice.speaker);
        const interactive = Boolean(onSpeakerSelect);
        const Row = interactive ? 'button' : 'div';
        return (
          <Row
            key={slice.speaker}
            type={interactive ? 'button' : undefined}
            onClick={interactive ? () => onSpeakerSelect?.(slice.speaker) : undefined}
            className={clsx(
              'grid grid-cols-[6.2rem_minmax(0,1fr)_3.6rem] items-center gap-2.5 text-left transition-opacity',
              dimmed && 'opacity-40',
              interactive && 'cursor-pointer',
            )}
            data-testid="aiv2-talk-time-row"
            data-speaker={slice.speaker}
          >
            <span className="flex items-center gap-1.5 overflow-hidden text-ellipsis whitespace-nowrap text-[0.8rem] text-v5-text">
              <i
                aria-hidden="true"
                className="inline-block h-2 w-2 shrink-0 rounded-full"
                style={{ background: color }}
              />
              {speakerLabel(slice.speaker)}
            </span>
            <span className="relative h-3.5 rounded-r-[4px]">
              <i
                aria-hidden="true"
                className="absolute inset-y-0 left-0 min-w-[2px] rounded-r-[4px]"
                style={{ width: `${pct}%`, background: color }}
              />
            </span>
            {/* Direct numeric label — color is never the only channel. */}
            <span className="whitespace-nowrap text-right text-[0.78rem] [font-variant-numeric:tabular-nums] text-v5-muted">
              {fmtHmsFromSec(slice.talkTimeSec)}
            </span>
          </Row>
        );
      })}
    </div>
  );
}
