import clsx from 'clsx';
import { useEffect, useMemo, useState } from 'react';
import { useEvents } from '../../../api/hooks/useEvents';
import { useSessionStatus } from '../../../api/hooks/useSessionStatus';
import type { LogEvent, SessionStatus } from '../../../api/types';
import {
  eventTimelineSec,
  parseSmpteToSec,
  sessionFrameRate,
} from '../../../shared/utils/audioClips';
import styles from './MarkerNav.module.css';

interface MarkerEntry {
  sec: number;
  event: LogEvent;
  isInternal: boolean;
}

// Marker positions MUST use the same coordinate space as the rendered timeline
// markers and audio clips (eventTimelineSec, frame-rate aware). The display-only
// parseSmpteToSec in shared/utils/timecode.ts drops the SMPTE frame field, so
// jump targets landed ~1s before each recording's start clip — putting the
// playhead in the inter-recording gap, where the audio player resolves forward
// and skips/auto-plays the wrong recording.
function groupMarkers(events: LogEvent[], status: SessionStatus | null | undefined): MarkerEntry[] {
  const grouped = new Map<string, MarkerEntry>();
  for (const e of events) {
    const sec = eventTimelineSec(e, status);
    if (!(Number.isFinite(sec) && sec >= 0)) continue;
    const key = sec.toFixed(3);
    const isInternal = String(e.category ?? '').toLowerCase() === 'internal';
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, { sec, event: e, isInternal });
    } else if (existing.isInternal && !isInternal) {
      grouped.set(key, { sec, event: e, isInternal });
    }
  }
  return Array.from(grouped.values()).sort((a, b) => a.sec - b.sec);
}

function neighborEvents(
  markers: MarkerEntry[],
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
  const { data: eventsRes } = useEvents(sessionId || null, { limit: 1000 });
  const events = useMemo(() => eventsRes?.events ?? [], [eventsRes]);

  // session.js dispatches autologger:timeline-sec whenever the displayed timeline
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

  const markers = useMemo(() => groupMarkers(events, status), [events, status]);
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
    window.AutoLogger_setManualScrubSec?.(target);
    window.AutoLogger_scrollTimelineToSec?.(target);
    window.AutoLogger_seekAudio?.(target);
  };

  const prevColor = enabled && prevEvent ? colorOf(prevEvent) : 'transparent';
  const nextColor = enabled && nextEvent ? colorOf(nextEvent) : 'transparent';

  return (
    <div className={styles.v4SessionNavBtns} role="toolbar" aria-label="Marker navigation">
      <button
        type="button"
        className={clsx(styles.v4SessionNavBtn, styles.v4SessionNavBtnBack)}
        id="btn-prev-marker-aside"
        aria-label="Previous marker"
        disabled={!enabled}
        onClick={() => handleJump(-1)}
        style={{ ['--v4-session-nav-border' as 'borderColor']: prevColor }}
      >
        <span
          className={clsx(styles.v4SessionNavHint, styles.v4SessionNavHintPrev)}
          aria-hidden={true}
          style={{
            backgroundColor: enabled && prevEvent ? prevColor : 'transparent',
            opacity: enabled && prevEvent ? 1 : 0,
          }}
        />
      </button>
      <button
        type="button"
        className={clsx(styles.v4SessionNavBtn, styles.v4SessionNavBtnNext)}
        id="btn-next-marker-aside"
        aria-label="Next marker"
        disabled={!enabled}
        onClick={() => handleJump(1)}
        style={{ ['--v4-session-nav-border' as 'borderColor']: nextColor }}
      >
        <span
          className={clsx(styles.v4SessionNavHint, styles.v4SessionNavHintNext)}
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
