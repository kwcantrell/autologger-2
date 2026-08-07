import clsx from 'clsx';
import { useEffect, useMemo, useState } from 'react';
import { useEvents, WORKSPACE_EVENTS_LIMIT } from '../../../api/hooks/useEvents';
import { useSessionStatus } from '../../../api/hooks/useSessionStatus';
import type { LogEvent } from '../../../api/types';
import { parseSmpteToSec, sessionFrameRate } from '../../../shared/utils/audioClips';
import { groupTimelineMarkers, type TimelineMarkerGroup } from '../utils/markerGrouping';
import { jumpTimelineToSec } from '../utils/timelineJump';

// Match compact transport tiles (same size + chrome as stop/roll/mic).
const NAV_BTN =
  'relative isolate box-border grid h-(--v4-ctrl-btn-h) max-h-(--v4-ctrl-btn-h) min-h-(--v4-ctrl-btn-h) w-(--v4-ctrl-btn-w) flex-[0_0_var(--v4-ctrl-btn-w)] cursor-pointer place-items-center overflow-visible rounded-v5-md border border-[rgba(148,163,184,0.22)] p-0 [background:linear-gradient(180deg,rgba(255,255,255,0.07)_0%,rgba(255,255,255,0)_42%),linear-gradient(180deg,rgba(19,27,48,0.88),rgba(11,16,30,0.78))] shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_4px_16px_rgba(2,8,23,0.42)] [--session-ctl-accent:#e2e8f0] [transition:border-color_0.15s_ease,box-shadow_0.15s_ease,opacity_0.15s_ease] hover-always:not-disabled:[border-color:color-mix(in_srgb,var(--session-ctl-accent)_28%,rgba(148,163,184,0.22))] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[rgba(56,189,248,0.55)] disabled:cursor-not-allowed disabled:border-dashed disabled:border-[rgba(148,163,184,0.14)] disabled:bg-[rgba(7,11,20,0.55)] disabled:opacity-[0.48] disabled:shadow-none';
// Desktop strip (ungrouped): grow equally with transport / ? tiles.
// `!` beats the fixed flex-basis/width utilities on NAV_BTN.
const NAV_BTN_DESKTOP_GROW = 'md:min-w-(--v4-ctrl-btn-w) md:w-auto! md:max-w-none md:flex-1!';

const NAV_ICON =
  'pointer-events-none relative z-[1] inline-flex h-[1.15rem] w-[1.15rem] items-center justify-center text-[color:color-mix(in_srgb,var(--session-ctl-accent)_70%,#e2e8f0)]';

// Category-color hint centered on the outer border (prev = left, next = right).
const NAV_HINT = 'pointer-events-none absolute top-1/2 z-[2] h-[0.45rem] w-[0.45rem] rounded-full';

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
  /** Force-disable (e.g. YouTube import in progress). */
  disabled?: boolean;
  /** Flatten into parent flex so gaps match sibling control buttons. */
  ungrouped?: boolean;
}

function NavGlyph({ direction }: { direction: 'prev' | 'next' }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      {direction === 'prev' ? (
        <path
          d="M11 6.5L5.5 12L11 17.5M18.5 6.5L13 12L18.5 17.5"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        <path
          d="M13 6.5L18.5 12L13 17.5M5.5 6.5L11 12L5.5 17.5"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

export function MarkerNav({ sessionId, disabled = false, ungrouped = false }: Props) {
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
  // No marker scrubbing while rolling/recording — timeline lane is category buttons.
  const liveTransport = Boolean(status?.is_rolling || status?.audio_recording_lease_alive);
  const enabled = markers.length > 0 && !liveTransport && !disabled;

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
      className={
        ungrouped
          ? 'contents'
          : 'box-border flex h-(--v4-ctrl-btn-h) max-h-(--v4-ctrl-btn-h) min-h-(--v4-ctrl-btn-h) shrink-0 flex-row flex-nowrap items-center gap-[0.3rem]'
      }
      role={ungrouped ? undefined : 'toolbar'}
      aria-label={ungrouped ? undefined : 'Marker navigation'}
    >
      <button
        type="button"
        className={clsx(
          NAV_BTN,
          ungrouped && NAV_BTN_DESKTOP_GROW,
          // `!` beats the base `grid` display utility on NAV_BTN.
          ungrouped && !enabled && 'max-md:hidden!',
        )}
        id="btn-prev-marker-aside"
        aria-label="Previous marker"
        disabled={!enabled}
        onClick={() => handleJump(-1)}
      >
        <span
          className={clsx(NAV_HINT, 'left-0 -translate-x-1/2 -translate-y-1/2')}
          aria-hidden={true}
          style={{
            backgroundColor: prevColor,
            opacity: enabled && prevEvent ? 1 : 0,
            boxShadow:
              enabled && prevEvent
                ? `0 0 6px color-mix(in srgb, ${prevColor} 55%, transparent)`
                : undefined,
          }}
        />
        <span className={NAV_ICON}>
          <NavGlyph direction="prev" />
        </span>
      </button>
      <button
        type="button"
        className={clsx(
          NAV_BTN,
          ungrouped && NAV_BTN_DESKTOP_GROW,
          ungrouped && !enabled && 'max-md:hidden!',
        )}
        id="btn-next-marker-aside"
        aria-label="Next marker"
        disabled={!enabled}
        onClick={() => handleJump(1)}
      >
        <span
          className={clsx(NAV_HINT, 'right-0 translate-x-1/2 -translate-y-1/2')}
          aria-hidden={true}
          style={{
            backgroundColor: nextColor,
            opacity: enabled && nextEvent ? 1 : 0,
            boxShadow:
              enabled && nextEvent
                ? `0 0 6px color-mix(in srgb, ${nextColor} 55%, transparent)`
                : undefined,
          }}
        />
        <span className={NAV_ICON}>
          <NavGlyph direction="next" />
        </span>
      </button>
    </div>
  );
}
