import clsx from 'clsx';
import { useEffect, useMemo, useState } from 'react';
import { useEvents, WORKSPACE_EVENTS_LIMIT } from '../../../api/hooks/useEvents';
import { useSessionStatus } from '../../../api/hooks/useSessionStatus';
import type { LogEvent } from '../../../api/types';
import { parseSmpteToSec, sessionFrameRate } from '../../../shared/utils/audioClips';
import { groupTimelineMarkers, type TimelineMarkerGroup } from '../utils/markerGrouping';
import { jumpTimelineToSec } from '../utils/timelineJump';

// .v4-session-nav-btn: local --v4-session-nav-border fallback (transparent) is
// defined here as an arbitrary-property utility (recipe 3b); MarkerNav's inline
// style overrides it per-button with the neighbor category color. The v5 carve-out
// (rounded-v5-md + rgba bg) wins by source order over the base radius/bg.
const NAV_BTN =
  '[--v4-session-nav-border:transparent] relative box-border h-(--v4-session-nav-btn-h) max-h-(--v4-session-nav-btn-h) min-h-(--v4-session-nav-btn-h) w-(--v4-session-nav-btn-w) flex-[0_0_var(--v4-session-nav-btn-w)] cursor-pointer appearance-none rounded-v5-md border border-[var(--v4-session-nav-border)] bg-[rgba(255,255,255,0.06)] bg-[length:1.05rem_1.05rem] bg-center bg-no-repeat p-0 hover-always:not-disabled:[filter:brightness(1.5)] disabled:cursor-not-allowed disabled:border-transparent disabled:opacity-45';

// .v4-session-nav-hint: absolute dot, local geometry vars for size/offset.
const NAV_HINT =
  '[--v4-session-nav-icon-r:calc(1.05rem/2)] [--v4-session-nav-hint-r:0.225rem] pointer-events-none absolute top-1/2 box-border h-[calc(var(--v4-session-nav-hint-r)*2)] w-[calc(var(--v4-session-nav-hint-r)*2)] translate-x-[-50%] translate-y-[-50%] rounded-full bg-transparent opacity-0';

// Marker positions MUST use the same coordinate space as the rendered timeline
// markers and audio clips (eventTimelineSec, frame-rate aware — the shared
// groupTimelineMarkers util). A display-only parseSmpteToSec (formerly in
// shared/utils/timecode.ts, deleted 2026-07-27) dropped the SMPTE frame field,
// so jump targets landed ~1s before each recording's start clip — putting the
// playhead in the inter-recording gap, where the audio player resolves forward
// and skips/auto-plays the wrong recording.
function neighborEvents(
  markers: TimelineMarkerGroup[],
  currentSec: number,
): { prevEvent: LogEvent | null; nextEvent: LogEvent | null } {
  if (markers.length === 0) return { prevEvent: null, nextEvent: null };
  let prev: LogEvent = markers[markers.length - 1].event;
  for (let i = markers.length - 1; i >= 0; i -= 1) {
    if (markers[i].sec < currentSec - 1e-6) {
      prev = markers[i].event;
      break;
    }
    prev = markers[markers.length - 1].event;
  }
  let next: LogEvent = markers[0].event;
  for (let i = 0; i < markers.length; i += 1) {
    if (markers[i].sec > currentSec + 1e-6) {
      next = markers[i].event;
      break;
    }
    next = markers[0].event;
  }
  return { prevEvent: prev, nextEvent: next };
}

const TIMELINE_SEC_EVENT = 'autologger:timeline-sec';

interface Props {
  sessionId: string;
}

export function MarkerNav({ sessionId }: Props) {
  const { data: status } = useSessionStatus(sessionId || null);
  const { data: eventsRes } = useEvents(sessionId || null, { limit: WORKSPACE_EVENTS_LIMIT });
  const events = useMemo(() => eventsRes?.events ?? [], [eventsRes]);

  // Timeline dispatches autologger:timeline-sec whenever the displayed timeline
  // position changes (status poll, manual scrub, playhead drag). We use that override
  // as the source of truth when present so side hints update in lockstep with the playhead.
  const [scrubSec, setScrubSec] = useState<number | null>(null);
  useEffect(() => {
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<{ sec: number | null }>).detail;
      const v = detail?.sec;
      setScrubSec(v == null || !Number.isFinite(Number(v)) ? null : Math.max(0, Number(v)));
    };
    document.body.addEventListener(TIMELINE_SEC_EVENT, handler);
    return () => document.body.removeEventListener(TIMELINE_SEC_EVENT, handler);
  }, []);

  const markers = useMemo(() => groupTimelineMarkers(events, status), [events, status]);
  const enabled = markers.length > 0;

  const currentSec = useMemo(() => {
    if (scrubSec != null) return scrubSec;
    const tc = status?.timecode ?? '00:00:00';
    const s = parseSmpteToSec(tc, sessionFrameRate(status));
    return Number.isFinite(s) && s >= 0 ? s : 0;
  }, [scrubSec, status]);

  const { prevEvent, nextEvent } = useMemo(
    () => neighborEvents(markers, currentSec),
    [markers, currentSec],
  );

  const colorOf = (ev: LogEvent | null): string => {
    const raw = String(ev?.category_color ?? '').trim();
    return raw || '#6b7280';
  };

  const handleJump = (direction: -1 | 1) => {
    if (!markers.length) return;
    const secs = markers.map((m) => m.sec);
    const cur = currentSec;
    let target = secs[0];
    if (direction < 0) {
      for (let i = secs.length - 1; i >= 0; i -= 1) {
        if (secs[i] < cur - 1e-6) {
          target = secs[i];
          break;
        }
        target = secs[secs.length - 1];
      }
    } else {
      for (let i = 0; i < secs.length; i += 1) {
        if (secs[i] > cur + 1e-6) {
          target = secs[i];
          break;
        }
        target = secs[0];
      }
    }
    jumpTimelineToSec(target);
  };

  const prevColor = enabled && prevEvent ? colorOf(prevEvent) : 'transparent';
  const nextColor = enabled && nextEvent ? colorOf(nextEvent) : 'transparent';

  return (
    <div
      className="box-border flex w-full min-w-0 flex-row flex-nowrap items-center justify-evenly gap-[0.35rem] mt-(--v4-ctrl-btn-my) min-h-(--v4-session-nav-btn-h)"
      role="toolbar"
      aria-label="Marker navigation"
    >
      <button
        type="button"
        className={clsx(NAV_BTN, '[background-image:var(--v4-icon-nav-back)]')}
        id="btn-prev-marker-aside"
        aria-label="Previous marker"
        disabled={!enabled}
        onClick={() => handleJump(-1)}
        style={{ ['--v4-session-nav-border' as 'borderColor']: prevColor }}
      >
        <span
          className={clsx(
            NAV_HINT,
            'left-[calc(50%-var(--v4-session-nav-icon-r)-1rem-var(--v4-session-nav-hint-r))]',
          )}
          aria-hidden={true}
          style={{
            backgroundColor: enabled && prevEvent ? prevColor : 'transparent',
            opacity: enabled && prevEvent ? 1 : 0,
          }}
        />
      </button>
      <button
        type="button"
        className={clsx(NAV_BTN, '[background-image:var(--v4-icon-nav-next)]')}
        id="btn-next-marker-aside"
        aria-label="Next marker"
        disabled={!enabled}
        onClick={() => handleJump(1)}
        style={{ ['--v4-session-nav-border' as 'borderColor']: nextColor }}
      >
        <span
          className={clsx(
            NAV_HINT,
            'left-[calc(50%+var(--v4-session-nav-icon-r)+1rem+var(--v4-session-nav-hint-r))]',
          )}
          aria-hidden={true}
          style={{
            backgroundColor: enabled && nextEvent ? nextColor : 'transparent',
            opacity: enabled && nextEvent ? 1 : 0,
          }}
        />
      </button>
    </div>
  );
}
