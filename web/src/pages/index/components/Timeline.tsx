// Slice 5: session.js deleted; all timeline state is React-owned.

import clsx from 'clsx';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { LogEvent, SessionStatus } from '../../../api/types';
import {
  eventTimelineSec,
  parseSmpteToSec,
  safeTimelineSec,
  sessionFrameRate,
} from '../../../shared/utils/audioClips';
import { fmtHmsFromSec } from '../../../shared/utils/timecode';
import type { AudioClipLite } from '../../../shared/utils/waveformMerge';
import { clipIndexContainingTimelineSec } from '../../../shared/utils/waveformSvg';
import { useZoomRail } from '../hooks/useZoomRail';
import styles from './Timeline.module.css';
import { TimelineClips } from './timeline/TimelineClips';
import { TimelineMarkers } from './timeline/TimelineMarkers';
import { TimelineTicks } from './timeline/TimelineTicks';
import { TimelineWaveform } from './timeline/TimelineWaveform';

declare global {
  interface Window {
    AutoLogger_getManualScrubSec?: () => number | null;
    AutoLogger_getSelectedEventId?: () => string | null;
    AutoLogger_setManualScrubSec?: (sec: number | null) => void;
  }
}

function fmtSessionDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}/${d.getUTCFullYear()}`;
}

/** Marker tooltip placement matches session.js's showTimelineMarkerTooltip math. */
function placeTooltip(
  el: HTMLElement,
  clientX: number,
  clientY: number,
  defaultW = 180,
  defaultH = 30,
): void {
  const pad = 10;
  const tw = el.offsetWidth || defaultW;
  const th = el.offsetHeight || defaultH;
  let left = clientX + 12;
  let top = clientY - th - 12;
  const maxLeft = window.innerWidth - tw - pad;
  if (left > maxLeft) left = Math.max(pad, clientX - tw - 12);
  if (top < pad) top = Math.min(window.innerHeight - th - pad, clientY + 14);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

function placeHoverTooltip(el: HTMLElement, clientX: number, clientY: number): void {
  const pad = 10;
  const tw = el.offsetWidth || 160;
  const th = el.offsetHeight || 28;
  let left = clientX + 14;
  let top = clientY - th - 12;
  const maxLeft = window.innerWidth - tw - pad;
  if (left > maxLeft) left = Math.max(pad, clientX - tw - 14);
  if (top < pad) top = Math.min(window.innerHeight - th - pad, clientY + 16);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

const TIMELINE_MARKER_GLOW_FADE_MIN_SEC = 0.6;
const TIMELINE_MARKER_GLOW_FADE_PX = 28;
const TIMELINE_MARKER_GLOW_FADE_CAP_SEC = 4;

function smoothstep01(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

interface Props {
  sessionId: string;
  status: SessionStatus | null;
  events: LogEvent[];
  audioClips: AudioClipLite[];
  totalSec: number;
  mergedPeaks: Float32Array | null;
  isWaveformDecoding?: boolean;
  audioPlaybackSec: number | null;
  onSeekAudio: (sec: number) => void;
  onExport: () => void;
  hidden?: boolean;
}

export function Timeline({
  sessionId,
  status,
  events,
  audioClips,
  totalSec,
  mergedPeaks,
  isWaveformDecoding,
  audioPlaybackSec,
  onSeekAudio,
  onExport,
  hidden,
}: Props) {
  const code = (status?.show_code ?? '').trim();
  const ep = (status?.episode ?? '').trim();
  const showName = (status?.show_name ?? '').trim();
  const deckFallback = (status?.deck_title ?? status?.title ?? '').trim();

  const titleText = code ? showName || code : deckFallback || '—';
  const titleAttr = code || '';
  const studioLine = code ? `Episode ${ep || '1'}` : '';

  const dateText = fmtSessionDate(status?.session_created_at_utc ?? status?.now_utc);

  const [manualScrubSec, setManualScrubSec] = useState<number | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [markerTip, setMarkerTip] = useState<{
    eventId: string;
    clientX: number;
    clientY: number;
  } | null>(null);
  const [hoverSec, setHoverSec] = useState<{
    sec: number;
    clientX: number;
    clientY: number;
  } | null>(null);

  // Refs mirror state for handlers + window getters.
  const manualScrubSecRef = useRef(manualScrubSec);
  manualScrubSecRef.current = manualScrubSec;
  const selectedEventIdRef = useRef(selectedEventId);
  selectedEventIdRef.current = selectedEventId;
  const totalSecRef = useRef(totalSec);
  totalSecRef.current = totalSec;
  const isScrubbingRef = useRef(false);
  const lastTrackPointerRef = useRef<{ clientX: number; clientY: number } | null>(null);
  const lastDocPointerRef = useRef<{ clientX: number; clientY: number } | null>(null);

  // Zoom rail DOM refs
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const zoomRangeRef = useRef<HTMLDivElement | null>(null);
  const zoomBarRef = useRef<HTMLDivElement | null>(null);
  const zoomOutRef = useRef<HTMLButtonElement | null>(null);
  const zoomInRef = useRef<HTMLButtonElement | null>(null);
  const zoomValueRef = useRef<HTMLInputElement | null>(null);
  const zoomTooltipRef = useRef<HTMLDivElement | null>(null);

  const glowRef = useRef<HTMLDivElement | null>(null);
  const navCatRef = useRef<HTMLSpanElement | null>(null);
  const navMsgCellRef = useRef<HTMLSpanElement | null>(null);
  const prevAudioPlaybackSecRef = useRef(audioPlaybackSec);

  // activeSecRef for zoom scroll centering (set below after activeSec is computed)
  const activeSecRef = useRef(0);

  // Reset interaction state on session switch.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset on sessionId change
  useEffect(() => {
    setManualScrubSec(null);
    setSelectedEventId(null);
    setMarkerTip(null);
    setHoverSec(null);
    isScrubbingRef.current = false;
    lastTrackPointerRef.current = null;
  }, [sessionId]);

  // Sync writer: updates the ref synchronously for immediate reads, then queues
  // the React state update for reactivity (re-renders, deps).
  const writeManualScrubSec = useCallback((sec: number | null) => {
    manualScrubSecRef.current = sec;
    setManualScrubSec(sec);
  }, []);
  const writeSelectedEventId = useCallback((id: string | null) => {
    selectedEventIdRef.current = id;
    setSelectedEventId(id);
  }, []);

  // Drop selectedEventId when its event vanishes from the cache.
  useEffect(() => {
    if (selectedEventId && !events.some((e) => e.event_id === selectedEventId)) {
      writeSelectedEventId(null);
    }
  }, [events, selectedEventId, writeSelectedEventId]);

  // Live timecode seconds derived from server status.
  const nowSec = useMemo(() => {
    const raw = status?.session_timecode ?? status?.timecode ?? '00:00:00';
    return Math.max(0, parseSmpteToSec(raw, sessionFrameRate(status)));
  }, [status]);

  // Master playhead position. Priority: live audio playback > manual scrub > rolling timecode.
  const activeSec = useMemo(() => {
    const raw =
      audioPlaybackSec != null
        ? audioPlaybackSec
        : manualScrubSec == null
          ? nowSec
          : manualScrubSec;
    return safeTimelineSec(raw, 0);
  }, [audioPlaybackSec, manualScrubSec, nowSec]);

  // Keep activeSecRef current for zoom rail (must be before useZoomRail call).
  activeSecRef.current = activeSec;

  // Zoom rail — owns zoom state, handle/wheel/keyboard listeners, resize observers.
  useZoomRail(
    {
      viewportRef,
      innerRef,
      zoomRangeRef,
      zoomBarRef,
      zoomOutRef,
      zoomInRef,
      zoomValueRef,
      zoomTooltipRef,
    },
    activeSecRef,
    totalSecRef,
    sessionId,
  );

  const activeClipIdx = useMemo(
    () => clipIndexContainingTimelineSec(activeSec, audioClips),
    [activeSec, audioClips],
  );

  // Current sidebar nav marker: last marker at or before the playhead.
  const currentNavMarker = useMemo(() => {
    const grouped = new Map<
      string,
      { sec: number; cat: string; msg: string; col: string; isInternal: boolean }
    >();
    for (const e of events) {
      const sec = eventTimelineSec(e, status);
      if (!Number.isFinite(sec) || sec < 0) continue;
      const key = sec.toFixed(3);
      const isInternal = String(e.category ?? '').toLowerCase() === 'internal';
      const existing = grouped.get(key);
      if (!existing || (existing.isInternal && !isInternal)) {
        grouped.set(key, {
          sec,
          cat: String(e.category_label || e.category || '—'),
          msg: String(e.message || '—'),
          col: String(e.category_color || '').trim() || '#6b7280',
          isInternal,
        });
      }
    }
    const marks = Array.from(grouped.values()).sort((a, b) => a.sec - b.sec);
    if (!marks.length) return null;
    let chosen = marks[0];
    for (const m of marks) {
      if (m.sec <= activeSec + 1e-6) chosen = m;
      else break;
    }
    return chosen;
  }, [events, activeSec, status]);

  // Cumulative session-roll seconds for the right-side readout (e.g. "/ 00:12:34").
  const rollingSec = useMemo(() => {
    const raw = status?.session_timecode;
    if (raw == null || String(raw).trim() === '') return 0;
    return Math.max(0, parseSmpteToSec(raw, sessionFrameRate(status)));
  }, [status]);

  const playheadPct = totalSec > 0 ? Math.max(0, Math.min(100, (activeSec / totalSec) * 100)) : 0;

  // Notify MarkerNav (and any other listener) about playhead changes.
  useEffect(() => {
    document.body.dispatchEvent(
      new CustomEvent('autologger:timeline-sec', { detail: { sec: activeSec } }),
    );
  }, [activeSec]);

  // Expose scrub state as window globals so MarkerNav can read/write without prop threading.
  useEffect(() => {
    window.AutoLogger_getManualScrubSec = () => manualScrubSecRef.current;
    window.AutoLogger_getSelectedEventId = () => selectedEventIdRef.current;
    window.AutoLogger_setManualScrubSec = writeManualScrubSec;
    return () => {
      window.AutoLogger_getManualScrubSec = undefined;
      window.AutoLogger_getSelectedEventId = undefined;
      window.AutoLogger_setManualScrubSec = undefined;
    };
  }, [writeManualScrubSec]);

  const secFromClientX = useCallback((clientX: number): number | null => {
    const vp = viewportRef.current;
    const inner = innerRef.current;
    const totSec = totalSecRef.current;
    if (!vp || !inner || totSec <= 0) return null;
    const vr = vp.getBoundingClientRect();
    const x = clientX - vr.left + vp.scrollLeft;
    const w = inner.offsetWidth;
    if (w <= 0) return null;
    const pct = Math.max(0, Math.min(1, x / w));
    return Math.round(pct * totSec);
  }, []);

  const scrubAtClientX = useCallback(
    (clientX: number) => {
      const sec = secFromClientX(clientX);
      if (sec == null) return;
      writeManualScrubSec(sec);
      onSeekAudio(sec);
    },
    [secFromClientX, onSeekAudio, writeManualScrubSec],
  );

  // Keyboard scrub for the slider role: ←/→ ±1s, Shift+←/→ ±10s.
  const onTrackKeyDown = useCallback(
    (ev: ReactKeyboardEvent<HTMLDivElement>) => {
      if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
      ev.preventDefault();
      const step = (ev.shiftKey ? 10 : 1) * (ev.key === 'ArrowLeft' ? -1 : 1);
      const next = Math.max(0, Math.min(totalSec, activeSecRef.current + step));
      writeManualScrubSec(next);
      onSeekAudio(next);
    },
    [totalSec, onSeekAudio, writeManualScrubSec],
  );

  const markerSel = `.${styles.timelineMarker}`;

  const onTrackPointerDown = useCallback(
    (ev: ReactPointerEvent<HTMLDivElement>) => {
      if (!ev.isPrimary || ev.button !== 0) return;
      // Markers handle their own click; skip starting a scrub from a marker hit.
      if ((ev.target as Element).closest?.(markerSel)) return;
      setHoverSec(null);
      isScrubbingRef.current = true;
      try {
        ev.currentTarget.setPointerCapture(ev.pointerId);
      } catch {
        /* capture may fail on some pointers; safe to ignore */
      }
      scrubAtClientX(ev.clientX);
    },
    [scrubAtClientX, markerSel],
  );

  const onTrackPointerMove = useCallback(
    (ev: ReactPointerEvent<HTMLDivElement>) => {
      if (isScrubbingRef.current) {
        scrubAtClientX(ev.clientX);
        return;
      }
      lastTrackPointerRef.current = { clientX: ev.clientX, clientY: ev.clientY };
      if ((ev.target as Element).closest?.(markerSel)) {
        setHoverSec(null);
        return;
      }
      const sec = secFromClientX(ev.clientX);
      if (sec == null) {
        setHoverSec(null);
        return;
      }
      setHoverSec({ sec, clientX: ev.clientX, clientY: ev.clientY });
    },
    [secFromClientX, scrubAtClientX, markerSel],
  );

  const onTrackPointerUp = useCallback((ev: ReactPointerEvent<HTMLDivElement>) => {
    if (!isScrubbingRef.current) return;
    isScrubbingRef.current = false;
    try {
      ev.currentTarget.releasePointerCapture(ev.pointerId);
    } catch {
      /* release may have already happened; ignore */
    }
  }, []);

  const onTrackPointerLeave = useCallback(() => {
    lastTrackPointerRef.current = null;
    setHoverSec(null);
  }, []);

  const onTrackDoubleClick = useCallback(() => {
    writeManualScrubSec(null);
  }, [writeManualScrubSec]);

  const onMarkersMouseOver = useCallback(
    (ev: ReactMouseEvent<HTMLDivElement>) => {
      const el = (ev.target as Element).closest?.(markerSel) as HTMLElement | null;
      if (!el) return;
      const eventId = el.dataset.eventId || '';
      if (!eventId) return;
      setMarkerTip({ eventId, clientX: ev.clientX, clientY: ev.clientY });
    },
    [markerSel],
  );

  const onMarkersMouseMove = useCallback(
    (ev: ReactMouseEvent<HTMLDivElement>) => {
      const el = (ev.target as Element).closest?.(markerSel) as HTMLElement | null;
      if (!el) {
        setMarkerTip(null);
        return;
      }
      const eventId = el.dataset.eventId || '';
      if (!eventId) {
        setMarkerTip(null);
        return;
      }
      setMarkerTip({ eventId, clientX: ev.clientX, clientY: ev.clientY });
    },
    [markerSel],
  );

  const onMarkersMouseOut = useCallback(() => {
    setMarkerTip(null);
  }, []);

  const onMarkersClick = useCallback(
    (ev: ReactMouseEvent<HTMLDivElement>) => {
      const el = (ev.target as Element).closest?.(markerSel) as HTMLElement | null;
      if (!el) return;
      const eventId = el.dataset.eventId;
      if (!eventId) return;
      writeSelectedEventId(eventId);
    },
    [writeSelectedEventId, markerSel],
  );

  // Track the pointer inside the timeline viewport for marker-tooltip refresh after
  // scroll (scoped to the viewport — positions outside it can't hit a marker anyway).
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const onMove = (ev: MouseEvent) => {
      lastDocPointerRef.current = { clientX: ev.clientX, clientY: ev.clientY };
    };
    const onLeave = () => {
      lastDocPointerRef.current = null;
    };
    vp.addEventListener('mousemove', onMove);
    vp.addEventListener('mouseleave', onLeave);
    return () => {
      vp.removeEventListener('mousemove', onMove);
      vp.removeEventListener('mouseleave', onLeave);
    };
  }, []);

  // After timeline viewport scroll, re-evaluate hover preview + marker tooltip from last pointer.
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const onScroll = () => {
      // Hover preview from last track pointer.
      const tp = lastTrackPointerRef.current;
      if (tp && !isScrubbingRef.current) {
        const elUnder = document.elementFromPoint(tp.clientX, tp.clientY);
        const track = document.getElementById('timeline-track');
        if (!track?.contains(elUnder as Node) || (elUnder as Element)?.closest?.(markerSel)) {
          setHoverSec(null);
        } else {
          const sec = secFromClientX(tp.clientX);
          if (sec == null) setHoverSec(null);
          else setHoverSec({ sec, clientX: tp.clientX, clientY: tp.clientY });
        }
      }
      // Marker tooltip from last document pointer.
      const dp = lastDocPointerRef.current;
      const markersHost = document.getElementById('timeline-markers');
      if (!dp || !markersHost) {
        setMarkerTip(null);
      } else {
        const el = document
          .elementFromPoint(dp.clientX, dp.clientY)
          ?.closest?.(markerSel) as HTMLElement | null;
        if (!el || !markersHost.contains(el)) {
          setMarkerTip(null);
        } else {
          const eventId = el.dataset.eventId || '';
          if (eventId) setMarkerTip({ eventId, clientX: dp.clientX, clientY: dp.clientY });
        }
      }
    };
    vp.addEventListener('scroll', onScroll);
    return () => vp.removeEventListener('scroll', onScroll);
  }, [secFromClientX, markerSel]);

  // Look up the event for the active marker tooltip (cat/msg/color).
  const markerTipEvent = useMemo(() => {
    if (!markerTip) return null;
    return events.find((e) => e.event_id === markerTip.eventId) ?? null;
  }, [markerTip, events]);

  const markerTipRef = useRef<HTMLDivElement | null>(null);
  const hoverTipRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const el = markerTipRef.current;
    if (!el || !markerTip || !markerTipEvent) return;
    placeTooltip(el, markerTip.clientX, markerTip.clientY);
  }, [markerTip, markerTipEvent]);

  useLayoutEffect(() => {
    const el = hoverTipRef.current;
    if (!el || !hoverSec) return;
    placeHoverTooltip(el, hoverSec.clientX, hoverSec.clientY);
  }, [hoverSec]);

  // Marker-playhead glow: position + opacity fade toward nearest marker.
  useLayoutEffect(() => {
    const el = glowRef.current;
    const inner = innerRef.current;
    if (!el) return;
    if (totalSec <= 0 || !events.length) {
      el.style.opacity = '0';
      return;
    }
    const w = Math.max(1, inner?.offsetWidth ?? 1);
    const secPerPx = totalSec / w;
    const maxFadeDistSec = Math.min(
      TIMELINE_MARKER_GLOW_FADE_CAP_SEC,
      Math.max(TIMELINE_MARKER_GLOW_FADE_MIN_SEC, secPerPx * TIMELINE_MARKER_GLOW_FADE_PX),
      totalSec * 0.4,
    );
    let best: { sec: number; col: string } | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const e of events) {
      const sec = eventTimelineSec(e, status);
      if (!Number.isFinite(sec)) continue;
      const d = Math.abs(sec - activeSec);
      if (d < bestDist) {
        bestDist = d;
        best = { sec, col: String(e.category_color || '').trim() || 'var(--accent)' };
      }
    }
    if (!best) {
      el.style.opacity = '0';
      return;
    }
    const pct = Math.max(0, Math.min(100, (best.sec / totalSec) * 100));
    el.style.setProperty('--marker-glow-col', best.col);
    el.style.left = `${pct}%`;
    const linear = maxFadeDistSec > 0 ? Math.max(0, Math.min(1, 1 - bestDist / maxFadeDistSec)) : 0;
    const strength = smoothstep01(linear);
    el.style.opacity = String(strength);
    el.style.transform = `translate(-50%, -50%) scale(${1.08 + 0.08 * strength})`;
  }, [activeSec, totalSec, events, status]);

  // When audio playback stops, freeze the playhead at the last played position.
  useEffect(() => {
    const prev = prevAudioPlaybackSecRef.current;
    prevAudioPlaybackSecRef.current = audioPlaybackSec;
    if (prev != null && audioPlaybackSec == null) {
      writeManualScrubSec(prev);
    }
  }, [audioPlaybackSec, writeManualScrubSec]);

  // Toggle marquee scroll class after nav label content changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: navCatRef/navMsgCellRef are stable DOM refs
  useEffect(() => {
    const cat = navCatRef.current;
    const cell = navMsgCellRef.current;
    if (!cat || !cell) return;
    requestAnimationFrame(() => {
      const msgA = cell.querySelector<HTMLElement>(`.${styles.markerCurrentMsgA}`);
      if (!msgA) return;
      cat.classList.toggle(styles.markerCurrentMsgScroll, msgA.scrollWidth > cell.clientWidth);
    });
  }, [currentNavMarker]);

  const hoverPct =
    hoverSec && totalSec > 0
      ? Math.max(0, Math.min(100, (Math.max(0, Math.min(totalSec, hoverSec.sec)) / totalSec) * 100))
      : null;

  const markerTipCat = markerTipEvent
    ? String(markerTipEvent.category_label || markerTipEvent.category || '—').trim() || '—'
    : '';
  const markerTipMsg = markerTipEvent ? markerTipEvent.message || '—' : '';
  const markerTipCol = markerTipEvent
    ? String(markerTipEvent.category_color || '').trim() || '#bfc5cd'
    : '#bfc5cd';

  return (
    <div className="v5-session-timeline-stack" id="v5-session-timeline-stack" hidden={hidden}>
      <div className="v5-panel-head v5-panel-head--timeline">
        <div className="v5-panel-head__main">
          <p className="v5-panel-eyebrow">Session Timeline</p>
          <header className="v4-playback-deck-header">
            <div className="v5-deck-title-cluster">
              <h1
                className="v4-playback-deck-title"
                id="session-deck-title"
                aria-label="Session show and episode"
              >
                <span id="session-title-code" className="session-title-code" title={titleAttr}>
                  {titleText}
                </span>
                <span className="session-title-sep" aria-hidden={true} hidden={true}>
                  {' - '}
                </span>
                <span id="session-title-ep" className="session-title-ep" hidden={true} />
              </h1>
              <div className="v5-deck-session-meta">
                <span
                  className="v4-episode v5-studio-name-inline"
                  id="studio-name"
                  hidden={!studioLine}
                >
                  {studioLine}
                </span>
                <span className="v5-deck-meta-sep" aria-hidden={true}>
                  &middot;
                </span>
                <span className="v4-session-date v5-session-date-inline" id="session-aside-date">
                  {dateText}
                </span>
              </div>
            </div>
          </header>
        </div>
        <div className="v5-panel-head__actions">
          <button
            type="button"
            className="btn primary v5-btn-export-log"
            id="btn-export-log"
            onClick={onExport}
          >
            Export
          </button>
        </div>
      </div>

      <div className={styles.v4ExtRow}>
        <div className={styles.v4NavArea}>
          <div
            className={clsx(styles.v4NavCat, styles.v4NavCatDynamic)}
            id="marker-current-cat-pill"
            style={
              currentNavMarker ? { ['--nav-cat-col' as string]: currentNavMarker.col } : undefined
            }
          >
            <span className={styles.v4NavCatTitle} id="marker-current-cat-cell">
              {currentNavMarker?.cat ?? '—'}
            </span>
          </div>
          <div className={styles.v4NavMsg}>
            <span
              ref={navCatRef}
              id="marker-current-cat"
              className={clsx(styles.timelineMarkerCurrentCat, styles.v4NavMarkerWrap)}
              title={
                currentNavMarker
                  ? `Current marker: ${currentNavMarker.cat} — ${currentNavMarker.msg}`
                  : 'No markers'
              }
            >
              <span
                ref={navMsgCellRef}
                className={styles.markerCurrentMsgCell}
                id="marker-current-msg-cell"
              >
                <span className={styles.markerCurrentMsgTrack} id="marker-current-msg-track">
                  <span
                    className={clsx(
                      styles.markerCurrentMsgSegment,
                      styles.markerCurrentMsgA,
                      styles.v4NavMsgValue,
                    )}
                    id="marker-current-msg-a"
                  >
                    {currentNavMarker?.msg ?? '—'}
                  </span>
                  <span className={styles.markerCurrentMsgGap} aria-hidden={true}>
                    {'    '}
                  </span>
                  <span
                    className={clsx(
                      styles.markerCurrentMsgSegment,
                      styles.markerCurrentMsgB,
                      styles.v4NavMsgValue,
                    )}
                    id="marker-current-msg-b"
                  >
                    {currentNavMarker?.msg ?? '—'}
                  </span>
                  <span
                    className={clsx(styles.markerCurrentMsgGap, styles.markerCurrentMsgGap2)}
                    aria-hidden={true}
                  >
                    {'    '}
                  </span>
                </span>
              </span>
            </span>
          </div>
        </div>
      </div>

      <div className={styles.v4TimelineRow}>
        <div className={clsx(styles.v4TlTrack, styles.v4TlTrackLive)} role="presentation">
          <div className={styles.timelineShell} id="timeline-shell">
            <div ref={viewportRef} className={styles.timelineViewport} id="timeline-viewport">
              <div ref={innerRef} className={styles.timelineInner} id="timeline-inner">
                <div
                  className={styles.timelineTrack}
                  id="timeline-track"
                  role="slider"
                  aria-label="Timeline scrubber"
                  aria-valuemin={0}
                  aria-valuemax={Math.round(totalSec)}
                  aria-valuenow={Math.round(activeSec)}
                  tabIndex={0}
                  onPointerDown={onTrackPointerDown}
                  onPointerMove={onTrackPointerMove}
                  onPointerUp={onTrackPointerUp}
                  onPointerCancel={onTrackPointerUp}
                  onPointerLeave={onTrackPointerLeave}
                  onDoubleClick={onTrackDoubleClick}
                  onKeyDown={onTrackKeyDown}
                >
                  <div className={styles.timelineTrackLayers}>
                    <TimelineClips
                      clips={audioClips}
                      totalSec={totalSec}
                      activeClipIdx={activeClipIdx}
                    />
                    <TimelineWaveform
                      mergedPeaks={mergedPeaks}
                      isDecoding={isWaveformDecoding ?? false}
                      activeSec={activeSec}
                      totalSec={totalSec}
                      clips={audioClips}
                    />
                    <div
                      className={clsx(
                        styles.timelineHoverPlayhead,
                        hoverPct != null && styles.timelineHoverPlayheadVisible,
                      )}
                      id="timeline-hover-playhead"
                      aria-hidden={true}
                      style={hoverPct != null ? { left: `${hoverPct}%` } : undefined}
                    />
                    <div
                      ref={glowRef}
                      className={styles.timelineMarkerPlayheadGlow}
                      id="timeline-marker-playhead-glow"
                      aria-hidden={true}
                    />
                    <TimelineMarkers
                      events={events}
                      status={status}
                      totalSec={totalSec}
                      selectedEventId={selectedEventId}
                      onMouseOver={onMarkersMouseOver}
                      onMouseMove={onMarkersMouseMove}
                      onMouseOut={onMarkersMouseOut}
                      onClick={onMarkersClick}
                    />
                    <div
                      className={styles.timelinePlayhead}
                      id="timeline-playhead"
                      style={{ left: `${playheadPct}%` }}
                    />
                  </div>
                </div>
                <TimelineTicks totalSec={totalSec} />
              </div>
            </div>
          </div>

          <div
            className={clsx(styles.timelineZoomRail, styles.v4TimelineZoomRail)}
            role="toolbar"
            aria-label="Timeline zoom"
          >
            <div
              ref={zoomTooltipRef}
              className={clsx(styles.timelineZoomTooltip, 'hidden')}
              id="timeline-zoom-tooltip"
              role="status"
              aria-live="polite"
            />
            <input
              ref={zoomValueRef}
              type="text"
              className={clsx(styles.timelineZoomValue, styles.v4TimelineZoomPct, 'mono', 'faint')}
              id="timeline-zoom-value"
              inputMode="decimal"
              autoComplete="off"
              spellCheck={false}
              aria-label="Timeline zoom percent"
              defaultValue="100%"
            />
            <div
              ref={zoomRangeRef}
              className={clsx(styles.v4ZoomRange, styles.timelineZoomRange)}
              id="timeline-zoom-range"
            >
              <div
                ref={zoomBarRef}
                className={clsx(styles.v4ZoomBar, styles.timelineZoomBar)}
                id="timeline-zoom-bar"
              />
              <button
                ref={zoomOutRef}
                type="button"
                className={clsx(
                  styles.v4ZoomHandle,
                  styles.v4ZoomHandleLeft,
                  styles.timelineZoomHandle,
                  styles.timelineZoomHandleLeft,
                )}
                id="timeline-zoom-out"
                aria-label="Reduce timeline zoom"
              />
              <button
                ref={zoomInRef}
                type="button"
                className={clsx(
                  styles.v4ZoomHandle,
                  styles.v4ZoomHandleRight,
                  styles.timelineZoomHandle,
                  styles.timelineZoomHandleRight,
                )}
                id="timeline-zoom-in"
                aria-label="Increase timeline zoom"
              />
            </div>
            <div className={clsx(styles.v4ExtTimecode, styles.v4ExtTimecodeZoomRail)}>
              <span className={styles.v4ExtTimecodePos} id="timeline-readout-pos">
                {fmtHmsFromSec(activeSec)}
              </span>
              <span className={styles.v4ExtTimecodeTotal} id="timeline-readout-total">
                {` / ${fmtHmsFromSec(rollingSec)}`}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Marker tooltip — React-owned, positioned in useLayoutEffect. */}
      {markerTip && markerTipEvent && (
        <div
          ref={markerTipRef}
          id="timeline-marker-tooltip"
          className={clsx(styles.timelineMarkerTooltip, styles.timelineMarkerTooltipVisible)}
          role="tooltip"
          style={{ ['--tooltip-cat-col' as string]: markerTipCol }}
        >
          <span className={styles.timelineTooltipCat}>{markerTipCat}</span>
          <span className={styles.timelineTooltipMsg}>{markerTipMsg}</span>
        </div>
      )}

      {/* Track hover tooltip — formatted HH:MM:SS. */}
      {hoverSec && (
        <div
          ref={hoverTipRef}
          id="timeline-hover-tooltip"
          className="timeline-hover-tooltip"
          role="tooltip"
        >
          {fmtHmsFromSec(hoverSec.sec)}
        </div>
      )}
    </div>
  );
}
