import clsx from 'clsx';
import { useEffect, useMemo, useState } from 'react';
import { useEvents, WORKSPACE_EVENTS_LIMIT } from '../../../api/hooks/useEvents';
import { useSessionStatus } from '../../../api/hooks/useSessionStatus';
import type { LogEvent } from '../../../api/types';
import { Button } from '../../../shared/components/ui/button';
import { parseSmpteToSec, sessionFrameRate } from '../../../shared/utils/audioClips';
import { resolveCategoryColor } from '../../../shared/utils/categoryColor';
import { groupTimelineMarkers, type TimelineMarkerGroup } from '../utils/markerGrouping';
import { jumpTimelineToSec } from '../utils/timelineJump';
import { TIMELINE_SEC_EVENT } from '../utils/timelineSecEvent';

// The same flat `transport` Button as the transport controls (redesign-show-ignition task 5.2).
// Desktop strip (ungrouped): grow equally with transport / ? controls.
const NAV_BTN_DESKTOP_GROW = 'md:w-auto md:min-w-(--h-ctl) md:flex-1';

// The neighbouring marker's category colour, as a small swatch INSIDE the button on its outer
// side (prev = left, next = right). It used to straddle the border and, on the last control of
// a phone-width row, reached the viewport edge.
const NAV_HINT =
  'pointer-events-none absolute top-1/2 size-1.5 -translate-y-1/2 rounded-full transition-opacity';

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
    return resolveCategoryColor(ev?.category_color) ?? '#6b7280';
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
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: false positive — the label travels with role="toolbar" (both undefined when ungrouped); the rule can't see the conditional pairing.
    <div
      className={ungrouped ? 'contents' : 'flex shrink-0 flex-row flex-nowrap items-center gap-1.5'}
      role={ungrouped ? undefined : 'toolbar'}
      aria-label={ungrouped ? undefined : 'Marker navigation'}
    >
      <Button
        variant="transport"
        size="icon"
        className={clsx(
          'relative',
          ungrouped && NAV_BTN_DESKTOP_GROW,
          ungrouped && !enabled && 'max-md:hidden',
        )}
        id="btn-prev-marker-aside"
        aria-label="Previous marker"
        disabled={!enabled}
        onClick={() => handleJump(-1)}
      >
        <span
          className={clsx(NAV_HINT, 'left-1.5')}
          aria-hidden={true}
          style={{
            backgroundColor: prevColor,
            opacity: enabled && prevEvent ? 1 : 0,
          }}
        />
        <NavGlyph direction="prev" />
      </Button>
      <Button
        variant="transport"
        size="icon"
        className={clsx(
          'relative',
          ungrouped && NAV_BTN_DESKTOP_GROW,
          ungrouped && !enabled && 'max-md:hidden',
        )}
        id="btn-next-marker-aside"
        aria-label="Next marker"
        disabled={!enabled}
        onClick={() => handleJump(1)}
      >
        <span
          className={clsx(NAV_HINT, 'right-1.5')}
          aria-hidden={true}
          style={{
            backgroundColor: nextColor,
            opacity: enabled && nextEvent ? 1 : 0,
          }}
        />
        <NavGlyph direction="next" />
      </Button>
    </div>
  );
}
