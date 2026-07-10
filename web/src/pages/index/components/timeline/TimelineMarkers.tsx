import clsx from 'clsx';
import type { CSSProperties, MouseEventHandler } from 'react';
import { useMemo } from 'react';
import type { LogEvent, SessionStatus } from '../../../../api/types';
import { eventTimelineSec, safeTimelineSec } from '../../../../shared/utils/audioClips';

// --- converted class strings (were Timeline.module.css) ---
// TWO-MODE: base = standalone marker (0.62rem, big glow on hover); `[#v4-log-session_&]:`
// = the session-context look (0.92rem, subtler v5 glows). Hover is UNGUARDED (audit default)
// → `hover-always:`. --mcol is runtime-set inline. The literal `timelineMarker` /
// `timelineMarkerSelected` are retained for the hide-internal + perf-debug @layer rules.
const MARKERS = 'absolute inset-0 z-[5] pointer-events-none';
// Base rest transform is written as the `transform` PROPERTY (not Tailwind's `translate`
// utilities) so it matches the hover/selected `[transform:...]` overrides on the SAME
// property — mixing the `translate` and `transform` properties left a residual compositing
// layer that mis-routed pointer hit-testing on the sec=0 (half-clipped) marker.
const MARKER =
  'timelineMarker absolute top-1/2 left-0 w-[0.62rem] h-[0.62rem] m-0 p-0 border-0 rounded-full bg-(--mcol) [transform:translate(-50%,-50%)] cursor-pointer opacity-95 pointer-events-auto shadow-none' +
  // base hover (big multi-ring glow)
  ' hover-always:opacity-100 hover-always:[transform:translate(-50%,-50%)_scale(1.12)] hover-always:[box-shadow:0_0_8px_color-mix(in_srgb,var(--mcol)_100%,transparent),0_0_18px_color-mix(in_srgb,var(--mcol)_100%,transparent),0_0_30px_color-mix(in_srgb,var(--mcol)_98%,transparent),0_0_46px_color-mix(in_srgb,var(--mcol)_90%,transparent)]' +
  // base focus-visible
  ' focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-[3px]' +
  // session-context base look
  ' [#v4-log-session_&]:w-[0.92rem] [#v4-log-session_&]:h-[0.92rem] [#v4-log-session_&]:[box-shadow:0_0_16px_color-mix(in_srgb,var(--mcol)_26%,transparent)]' +
  // session-context hover + focus-visible
  ' [#v4-log-session_&]:hover-always:[transform:translate(-50%,-50%)_scale(1.06)] [#v4-log-session_&]:hover-always:[box-shadow:0_0_20px_color-mix(in_srgb,var(--mcol)_32%,transparent)] [#v4-log-session_&]:focus-visible:outline-v5-primary';
const MARKER_SELECTED =
  'timelineMarkerSelected opacity-100 [transform:translate(-50%,-50%)_scale(1.18)] [box-shadow:0_0_10px_color-mix(in_srgb,var(--mcol)_100%,transparent),0_0_22px_color-mix(in_srgb,var(--mcol)_100%,transparent),0_0_36px_color-mix(in_srgb,var(--mcol)_100%,transparent),0_0_54px_color-mix(in_srgb,var(--mcol)_92%,transparent)]' +
  // base selected hover
  ' hover-always:[box-shadow:0_0_12px_color-mix(in_srgb,var(--mcol)_100%,transparent),0_0_26px_color-mix(in_srgb,var(--mcol)_100%,transparent),0_0_42px_color-mix(in_srgb,var(--mcol)_100%,transparent),0_0_62px_color-mix(in_srgb,var(--mcol)_95%,transparent)]' +
  // session-context selected + hover
  ' [#v4-log-session_&]:[transform:translate(-50%,-50%)_scale(1.1)] [#v4-log-session_&]:[box-shadow:0_0_22px_color-mix(in_srgb,var(--mcol)_36%,transparent)] [#v4-log-session_&]:hover-always:[box-shadow:0_0_24px_color-mix(in_srgb,var(--mcol)_40%,transparent)]';

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
      className={MARKERS}
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
            className={clsx(MARKER, selectedEventId === event.event_id && MARKER_SELECTED)}
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
