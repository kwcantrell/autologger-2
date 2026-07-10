import clsx from 'clsx';
import type { CSSProperties, MouseEventHandler } from 'react';
import { useMemo } from 'react';
import type { LogEvent, SessionStatus } from '../../../../api/types';
import { eventTimelineSec, safeTimelineSec } from '../../../../shared/utils/audioClips';
import styles from '../Timeline.module.css';

interface Props {
  events: LogEvent[];
  status: SessionStatus | null;
  totalSec: number;
  selectedEventId: string | null;
  onMouseOver: MouseEventHandler<HTMLDivElement>;
  onMouseMove: MouseEventHandler<HTMLDivElement>;
  onMouseOut: MouseEventHandler<HTMLDivElement>;
  onClick: MouseEventHandler<HTMLDivElement>;
}

export function TimelineMarkers({
  events,
  status,
  totalSec,
  selectedEventId,
  onMouseOver,
  onMouseMove,
  onMouseOut,
  onClick,
}: Props) {
  const markers = useMemo(() => {
    if (totalSec <= 0) return [];
    return events.map((e) => {
      const sec = safeTimelineSec(eventTimelineSec(e, status), 0);
      const pct = Math.max(0, Math.min(100, (sec / totalSec) * 100));
      const color = e.category_color || 'var(--accent)';
      const cat = String(e.category_label || e.category || '—');
      return { event: e, pct, color, cat };
    });
  }, [events, status, totalSec]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: delegated click on container; markers are real <button>s
    // biome-ignore lint/a11y/useKeyWithMouseEvents: delegated hover on container; not focusable
    // biome-ignore lint/a11y/noStaticElementInteractions: delegated hover/click surface; markers are real <button>s, container is not a control
    <div
      className={styles.timelineMarkers}
      id="timeline-markers"
      onMouseOver={onMouseOver}
      onMouseMove={onMouseMove}
      onMouseOut={onMouseOut}
      onClick={onClick}
    >
      {markers.map(({ event, pct, color, cat }) => {
        const style: CSSProperties = { left: `${pct}%`, ['--mcol' as string]: color };
        return (
          <button
            key={event.event_id}
            type="button"
            className={clsx(
              styles.timelineMarker,
              selectedEventId === event.event_id && styles.timelineMarkerSelected,
            )}
            data-event-id={event.event_id}
            data-cat={cat}
            data-msg={event.message ?? ''}
            data-col={color}
            style={style}
          />
        );
      })}
    </div>
  );
}
