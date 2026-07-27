// Slice 4: Zoom rail logic migrated from session.js.
// All state is in refs to avoid React re-renders from imperative zoom ops.

import { type RefObject, useEffect, useRef } from 'react';
import { toast } from '../../../shared/components/Toast';
import { isTypingTarget } from '../components/ShortcutsDialog';

declare global {
  interface Window {
    AutoLogger_getTimelineZoom?: () => number;
    AutoLogger_scrollTimelineToSec?: (sec: number, totalSec?: number) => void;
  }
}

const TIMELINE_ZOOM_EVENT = 'autologger:timeline-zoom-changed';
const TIMELINE_ZOOM_MIN = 1;
const TIMELINE_ZOOM_ABS_MAX = 25;
const TIMELINE_ZOOM_KEY_FACT = 1.25;
const TIMELINE_ZOOM_WHEEL_FACT = 1.25 ** (1 / 5);
const TIMELINE_ZOOM_TOOLTIP_MS = 1400;
const TIMELINE_FIT_SCROLL_EPS_PX = 2;

export interface ZoomRailRefs {
  viewportRef: RefObject<HTMLDivElement | null>;
  innerRef: RefObject<HTMLDivElement | null>;
  zoomRangeRef: RefObject<HTMLDivElement | null>;
  zoomBarRef: RefObject<HTMLDivElement | null>;
  zoomOutRef: RefObject<HTMLButtonElement | null>;
  zoomInRef: RefObject<HTMLButtonElement | null>;
  zoomValueRef: RefObject<HTMLInputElement | null>;
  zoomTooltipRef: RefObject<HTMLDivElement | null>;
}

interface ZoomRangeMetrics {
  W: number;
  R: number;
  cx: number;
  spanMin: number;
  spanMax: number;
  hw: number;
}

function clampZoomBarEnds(l: number, r: number, m: ZoomRangeMetrics): { l: number; r: number } {
  const { W, R, spanMin, spanMax } = m;
  let nl = l;
  let nr = r;
  let span = Math.max(spanMin, Math.min(spanMax, nr - nl));
  const mid = (nl + nr) / 2;
  nl = mid - span / 2;
  nr = mid + span / 2;
  if (nl < R) {
    nl = R;
    nr = nl + span;
  }
  if (nr > W - R) {
    nr = W - R;
    nl = nr - span;
  }
  span = nr - nl;
  if (span < spanMin - 1e-6) {
    nr = Math.min(W - R, nl + spanMin);
    nl = nr - spanMin;
    nl = Math.max(R, nl);
  }
  if (span > spanMax + 1e-6) {
    nl = Math.max(R, nr - spanMax);
    nr = nl + spanMax;
    if (nr > W - R) {
      nr = W - R;
      nl = nr - spanMax;
    }
  }
  return { l: nl, r: nr };
}

export function useZoomRail(
  refs: ZoomRailRefs,
  activeSecRef: RefObject<number>,
  totalSecRef: RefObject<number>,
  sessionId: string,
): void {
  const {
    viewportRef,
    innerRef,
    zoomRangeRef,
    zoomBarRef,
    zoomOutRef,
    zoomInRef,
    zoomValueRef,
    zoomTooltipRef,
  } = refs;

  // All zoom state as mutable refs — no React re-renders from imperative zoom ops.
  const zoomRef = useRef(1);
  const stableBaseWidthRef = useRef<number | null>(null);
  const scrollRecenterFlagRef = useRef(false);

  // Bar handle positions (pixel centers within #timeline-zoom-range).
  const zoomLCenterPxRef = useRef<number | null>(null);
  const zoomRCenterPxRef = useRef<number | null>(null);

  // Drag state
  const zoomHandleDragRef = useRef<'bar' | 'left' | 'right' | null>(null);
  const zoomDragPointerIdRef = useRef<number | null>(null);
  const zoomDragRafRef = useRef<number | null>(null);
  const zoomBarDragStartXRef = useRef(0);
  const zoomBarDragStartBarLeftRef = useRef(0);
  const zoomBarDragSpanRef = useRef(0);
  const zoomDragStartPointerXRef = useRef(0);
  const zoomDragStartLRef = useRef(0);
  const zoomDragStartRRef = useRef(0);

  // Tooltip state
  const lastZoomTooltipPctRef = useRef<number | null>(null);
  const zoomTooltipHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Wheel coalescing
  const wheelZoomRafRef = useRef<number | null>(null);
  const wheelPendingFactorRef = useRef(1);

  // ---------- helpers ----------

  const publishZoom = useRef(() => {
    window.dispatchEvent(new Event(TIMELINE_ZOOM_EVENT));
  });

  const getZoomRangeMetrics = useRef((): ZoomRangeMetrics | null => {
    const zr = zoomRangeRef.current;
    const zo = zoomOutRef.current;
    if (!zr || !zo) return null;
    const W = zr.clientWidth;
    if (W < 2) return null;
    const hw = zo.offsetWidth || Number.parseFloat(getComputedStyle(zo).width) || 1;
    const R = hw / 2;
    const cx = W / 2;
    const spanMin = 2 * R;
    const spanMax = Math.max(spanMin, W - 2 * R);
    return { W, R, cx, spanMin, spanMax, hw };
  });

  const timelineZoomLayoutBase = useRef((): number => {
    const vp = viewportRef.current;
    if (!vp) return stableBaseWidthRef.current ?? 400;
    if (stableBaseWidthRef.current == null) {
      stableBaseWidthRef.current = Math.max(120, vp.clientWidth || 320);
    }
    return stableBaseWidthRef.current;
  });

  const timelineZoomMaxFromGeom = useRef((): number => {
    const m = getZoomRangeMetrics.current();
    const vp = viewportRef.current;
    if (!m || !vp) return 10;
    const base = timelineZoomLayoutBase.current();
    if (!(base > 0)) return 1e6;
    const vpW = Math.max(1, vp.clientWidth);
    const spanMin = Math.max(m.spanMin, 1e-6);
    const innerWMax = (vpW * m.W) / spanMin;
    const geom = Math.max(TIMELINE_ZOOM_MIN, innerWMax / base);
    return Math.min(TIMELINE_ZOOM_ABS_MAX, geom);
  });

  const updateZoomTrackDomVisual = useRef((): void => {
    const bar = zoomBarRef.current;
    const zo = zoomOutRef.current;
    const zi = zoomInRef.current;
    if (!bar || !zo || !zi) return;
    if (zoomLCenterPxRef.current == null || zoomRCenterPxRef.current == null) return;
    bar.style.left = `${zoomLCenterPxRef.current}px`;
    bar.style.width = `${Math.max(0, zoomRCenterPxRef.current - zoomLCenterPxRef.current)}px`;
    zo.style.left = `${zoomLCenterPxRef.current}px`;
    zi.style.left = `${zoomRCenterPxRef.current}px`;
  });

  const maybeShowZoomTooltip = useRef((z: number): void => {
    const tooltip = zoomTooltipRef.current;
    if (!tooltip) return;
    const pct = Math.round(z * 100);
    if (lastZoomTooltipPctRef.current === null) {
      lastZoomTooltipPctRef.current = pct;
      return;
    }
    if (pct === lastZoomTooltipPctRef.current) return;
    lastZoomTooltipPctRef.current = pct;
    tooltip.textContent = `${pct}%`;
    tooltip.classList.remove('hidden');
    if (zoomTooltipHideTimerRef.current) clearTimeout(zoomTooltipHideTimerRef.current);
    zoomTooltipHideTimerRef.current = setTimeout(() => {
      zoomTooltipHideTimerRef.current = null;
      tooltip.classList.add('hidden');
    }, TIMELINE_ZOOM_TOOLTIP_MS);
  });

  const setZoomValueLabel = useRef((z: number, force = false): void => {
    const inp = zoomValueRef.current;
    if (!inp) return;
    if (!force && document.activeElement === inp) return;
    inp.value = `${Math.round(z * 100)}%`;
  });

  const syncZoomTrackFromScroll = useRef((): void => {
    const zr = zoomRangeRef.current;
    const vp = viewportRef.current;
    const inner = innerRef.current;
    const bar = zoomBarRef.current;
    const zo = zoomOutRef.current;
    if (!zr || !vp || !inner || !bar || !zo) return;
    if (zoomHandleDragRef.current === 'bar') return;
    const m = getZoomRangeMetrics.current();
    if (!m) return;
    const { W, R, spanMin, spanMax } = m;
    if (zoomRef.current <= TIMELINE_ZOOM_MIN + 1e-9) {
      zoomLCenterPxRef.current = R;
      zoomRCenterPxRef.current = W - R;
      updateZoomTrackDomVisual.current();
      return;
    }
    const innerW = Math.max(1, inner.offsetWidth);
    const vpW = Math.max(1, vp.clientWidth);
    const sl = Math.max(0, vp.scrollLeft);
    const maxScroll = Math.max(0, innerW - vpW);
    let barWidth = (vpW / innerW) * W;
    barWidth = Math.max(spanMin, Math.min(spanMax, barWidth));
    let barLeft: number;
    if (maxScroll < 1e-6) {
      barLeft = R;
      barWidth = Math.min(spanMax, Math.max(spanMin, W - 2 * R));
    } else {
      const usable = Math.max(0, W - 2 * R - barWidth);
      barLeft = R + (sl / maxScroll) * usable;
    }
    zoomLCenterPxRef.current = barLeft;
    zoomRCenterPxRef.current = barLeft + barWidth;
    const c = clampZoomBarEnds(zoomLCenterPxRef.current, zoomRCenterPxRef.current, m);
    zoomLCenterPxRef.current = c.l;
    zoomRCenterPxRef.current = c.r;
    updateZoomTrackDomVisual.current();
  });

  const syncTimelineScrollFromZoomBar = useRef((): void => {
    const vp = viewportRef.current;
    const inner = innerRef.current;
    const zr = zoomRangeRef.current;
    if (!vp || !inner || !zr) return;
    const m = getZoomRangeMetrics.current();
    if (!m || zoomLCenterPxRef.current == null || zoomRCenterPxRef.current == null) return;
    const bl = zoomLCenterPxRef.current;
    const span = Math.max(0, zoomRCenterPxRef.current - zoomLCenterPxRef.current);
    const innerW = Math.max(1, inner.offsetWidth);
    const vpW = Math.max(1, vp.clientWidth);
    const maxScroll = Math.max(0, innerW - vpW);
    const usable = Math.max(0, m.W - 2 * m.R - span);
    let sl = 0;
    if (maxScroll > 1e-6 && usable > 1e-6) {
      sl = ((bl - m.R) / usable) * maxScroll;
      sl = Math.max(0, Math.min(sl, maxScroll));
    }
    vp.scrollLeft = sl;
  });

  const scrollLeftToCenterPlayhead = useRef(
    (
      zoomLevel: number,
      measured?: { innerW?: number; vpW?: number },
      playSecOverride?: number,
      totalSecOverride?: number,
    ): number => {
      const vp = viewportRef.current;
      if (!vp) return 0;
      const base = timelineZoomLayoutBase.current();
      const innerW =
        measured && Number.isFinite(measured.innerW) && (measured.innerW ?? 0) > 0
          ? (measured.innerW as number)
          : Math.ceil(base * zoomLevel);
      const vpW =
        measured && Number.isFinite(measured.vpW) && (measured.vpW ?? 0) > 0
          ? (measured.vpW as number)
          : Math.max(1, vp.clientWidth);
      const maxScroll = Math.max(0, innerW - vpW);
      if (maxScroll <= TIMELINE_FIT_SCROLL_EPS_PX) return 0;
      const totalSec =
        totalSecOverride != null && Number.isFinite(totalSecOverride) && totalSecOverride > 0
          ? totalSecOverride
          : Math.max(1, totalSecRef.current ?? 30);
      if (totalSec <= 1e-9) return 0;
      let playSec: number;
      if (playSecOverride != null && Number.isFinite(playSecOverride)) {
        playSec = Math.min(Math.max(0, playSecOverride), totalSec);
      } else {
        playSec = Math.min(Math.max(0, activeSecRef.current ?? 0), totalSec);
      }
      const playPx = (playSec / totalSec) * innerW;
      const sl = playPx - vpW / 2;
      return Math.max(0, Math.min(maxScroll, Math.round(sl)));
    },
  );

  const syncTimelineScrollToPlayhead = useRef(
    (playSecOverride?: number, totalSecOverride?: number): void => {
      const vp = viewportRef.current;
      const inner = innerRef.current;
      if (!vp || !inner) return;
      const innerW = Math.max(1, inner.offsetWidth);
      const vpW = Math.max(1, vp.clientWidth);
      const sl = scrollLeftToCenterPlayhead.current(
        zoomRef.current,
        { innerW, vpW },
        playSecOverride,
        totalSecOverride,
      );
      vp.scrollLeft = sl;
      syncZoomTrackFromScroll.current();
    },
  );

  const applyTimelineZoomLayout = useRef(
    (opts?: {
      syncScrollFromZoomBar?: boolean;
      postLayoutScrollLeft?: number;
      recenterPlayheadAfterZoom?: boolean;
      deferPlayheadScroll?: boolean;
    }): void => {
      const inner = innerRef.current;
      const vp = viewportRef.current;
      if (!inner || !vp) return;
      const zMax = timelineZoomMaxFromGeom.current();
      const z = Math.max(TIMELINE_ZOOM_MIN, Math.min(zMax, zoomRef.current));
      zoomRef.current = z;
      publishZoom.current();
      if (z <= TIMELINE_ZOOM_MIN + 1e-9) {
        stableBaseWidthRef.current = Math.max(120, vp.clientWidth || 320);
      }
      const base = timelineZoomLayoutBase.current();
      const widthStr = `${Math.ceil(base * z)}px`;
      const widthSame = inner.style.width === widthStr;
      const vpWNow = Math.max(1, vp.clientWidth);
      const innerWNow = inner.offsetWidth;
      const atMinZoom = z <= TIMELINE_ZOOM_MIN + 1e-9;
      const minZoomWidthDrift = atMinZoom && Math.abs(innerWNow - vpWNow) > 1.5;
      const scrollOverride =
        opts &&
        typeof opts.postLayoutScrollLeft === 'number' &&
        Number.isFinite(opts.postLayoutScrollLeft);
      const recenter = Boolean(opts?.recenterPlayheadAfterZoom);
      const deferPlayheadScroll = Boolean(opts?.deferPlayheadScroll) && recenter;
      if (
        widthSame &&
        !minZoomWidthDrift &&
        !opts?.syncScrollFromZoomBar &&
        !scrollOverride &&
        !recenter
      ) {
        if (atMinZoom) {
          const ms = Math.max(0, inner.offsetWidth - vp.clientWidth);
          if (ms <= TIMELINE_FIT_SCROLL_EPS_PX && vp.scrollLeft !== 0) {
            vp.scrollLeft = 0;
            syncZoomTrackFromScroll.current();
          }
        }
        return;
      }
      if (!widthSame || minZoomWidthDrift) {
        inner.style.width = widthStr;
      }
      const zoomed = z > 1 + 1e-9;
      vp.style.overflowX = zoomed ? 'scroll' : 'auto';
      vp.classList.toggle('timeline-viewport-zoomed', zoomed);
      void inner.offsetWidth; // force reflow so offsetWidth is fresh
      setZoomValueLabel.current(z);
      maybeShowZoomTooltip.current(z);
      if (opts?.syncScrollFromZoomBar) {
        syncTimelineScrollFromZoomBar.current();
      } else if (scrollOverride && opts?.postLayoutScrollLeft != null) {
        const maxScroll = Math.max(0, inner.offsetWidth - vp.clientWidth);
        vp.scrollLeft = Math.max(0, Math.min(maxScroll, opts.postLayoutScrollLeft));
        syncZoomTrackFromScroll.current();
      } else if (recenter && !deferPlayheadScroll) {
        const innerWr = Math.max(1, inner.offsetWidth);
        const vpWr = Math.max(1, vp.clientWidth);
        const sl = scrollLeftToCenterPlayhead.current(z, { innerW: innerWr, vpW: vpWr });
        vp.scrollLeft = sl;
        syncZoomTrackFromScroll.current();
      } else if (!recenter) {
        syncZoomTrackFromScroll.current();
      }
      if (atMinZoom) {
        vp.scrollLeft = 0;
        syncZoomTrackFromScroll.current();
      }
    },
  );

  const ensureZoomHandlesLayout = useRef((): boolean => {
    if (!getZoomRangeMetrics.current()) return false;
    syncZoomTrackFromScroll.current();
    return true;
  });

  const changeTimelineZoom = useRef((factor: number): void => {
    const vp = viewportRef.current;
    const inner = innerRef.current;
    if (!vp || !inner || factor <= 0) return;
    const zMax = timelineZoomMaxFromGeom.current();
    const next = Math.max(TIMELINE_ZOOM_MIN, Math.min(zMax, zoomRef.current * factor));
    if (Math.abs(next - zoomRef.current) < 1e-9) return;
    scrollRecenterFlagRef.current = true;
    zoomRef.current = next;
    applyTimelineZoomLayout.current({ recenterPlayheadAfterZoom: true, deferPlayheadScroll: true });
    // Trigger React render for TimelineTicks (zoom event already dispatched in applyTimelineZoomLayout).
    // Also run scroll sync once more since deferPlayheadScroll was true.
    if (scrollRecenterFlagRef.current) {
      scrollRecenterFlagRef.current = false;
      if (zoomRef.current > 1 + 1e-9) {
        syncTimelineScrollToPlayhead.current();
      } else {
        syncZoomTrackFromScroll.current();
      }
    }
  });

  const flushResizeLayout = useRef((): void => {
    const vp = viewportRef.current;
    if (!vp) return;
    stableBaseWidthRef.current = Math.max(120, vp.clientWidth || 320);
    const maxScroll = Math.max(0, vp.scrollWidth - vp.clientWidth);
    const ratio = maxScroll > 0 ? vp.scrollLeft / maxScroll : 0;
    applyTimelineZoomLayout.current();
    const newMax = Math.max(0, vp.scrollWidth - vp.clientWidth);
    vp.scrollLeft = newMax > 0 ? ratio * newMax : 0;
    syncZoomTrackFromScroll.current();
    // Second pass — zoom-range may also have resized.
    if (getZoomRangeMetrics.current()) {
      applyTimelineZoomLayout.current();
      syncZoomTrackFromScroll.current();
    }
  });

  // Wheel coalescing
  const flushWheelZoom = useRef((): void => {
    wheelZoomRafRef.current = null;
    const f = wheelPendingFactorRef.current;
    wheelPendingFactorRef.current = 1;
    if (Math.abs(f - 1) > 1e-12) changeTimelineZoom.current(f);
  });

  const scheduleWheelZoom = useRef((factor: number): void => {
    wheelPendingFactorRef.current *= factor;
    if (wheelZoomRafRef.current != null) return;
    wheelZoomRafRef.current = requestAnimationFrame(flushWheelZoom.current);
  });

  // Zoom bar pointer handlers
  const zoomHandleLocalX = useRef((ev: PointerEvent): number => {
    const zr = zoomRangeRef.current;
    if (!zr) return 0;
    return ev.clientX - zr.getBoundingClientRect().left;
  });

  const onZoomBarPointerDown = useRef((ev: PointerEvent): void => {
    const zr = zoomRangeRef.current;
    const bar = zoomBarRef.current;
    if (!zr || !bar || ev.button !== 0) return;
    ev.preventDefault();
    ensureZoomHandlesLayout.current();
    zoomHandleDragRef.current = 'bar';
    zoomDragPointerIdRef.current = ev.pointerId;
    zoomBarDragStartXRef.current = zoomHandleLocalX.current(ev);
    zoomBarDragStartBarLeftRef.current = zoomLCenterPxRef.current ?? 0;
    zoomBarDragSpanRef.current = Math.max(
      0,
      (zoomRCenterPxRef.current ?? 0) - (zoomLCenterPxRef.current ?? 0),
    );
    (ev.currentTarget as Element).setPointerCapture(ev.pointerId);
  });

  const onZoomBarPointerMove = useRef((ev: PointerEvent): void => {
    if (
      zoomHandleDragRef.current !== 'bar' ||
      zoomDragPointerIdRef.current == null ||
      ev.pointerId !== zoomDragPointerIdRef.current
    )
      return;
    const vp = viewportRef.current;
    const inner = innerRef.current;
    if (!vp || !inner) return;
    const m = getZoomRangeMetrics.current();
    if (!m) return;
    const x = zoomHandleLocalX.current(ev);
    const span = zoomBarDragSpanRef.current;
    let bl = zoomBarDragStartBarLeftRef.current + (x - zoomBarDragStartXRef.current);
    bl = Math.max(m.R, Math.min(bl, m.W - m.R - span));
    const innerW = Math.max(1, inner.offsetWidth);
    const vpW = Math.max(1, vp.clientWidth);
    const maxScroll = Math.max(0, innerW - vpW);
    const usable = Math.max(0, m.W - 2 * m.R - span);
    let sl = 0;
    if (maxScroll > 1e-6 && usable > 1e-6) {
      sl = ((bl - m.R) / usable) * maxScroll;
      sl = Math.max(0, Math.min(sl, maxScroll));
    }
    vp.scrollLeft = sl;
    zoomLCenterPxRef.current = bl;
    zoomRCenterPxRef.current = bl + span;
    updateZoomTrackDomVisual.current();
  });

  const commitZoomDragFrame = useRef((): void => {
    zoomDragRafRef.current = null;
    scrollRecenterFlagRef.current = true;
    applyTimelineZoomLayout.current({ syncScrollFromZoomBar: true });
    if (scrollRecenterFlagRef.current) {
      scrollRecenterFlagRef.current = false;
      if (zoomRef.current > 1 + 1e-9) syncTimelineScrollToPlayhead.current();
      else syncZoomTrackFromScroll.current();
    }
  });

  const onZoomHandlePointerDown = useRef((side: 'left' | 'right', ev: PointerEvent): void => {
    const zr = zoomRangeRef.current;
    if (!zr || ev.button !== 0) return;
    ev.preventDefault();
    ensureZoomHandlesLayout.current();
    if (zoomLCenterPxRef.current == null || zoomRCenterPxRef.current == null) return;
    zoomHandleDragRef.current = side;
    zoomDragPointerIdRef.current = ev.pointerId;
    zoomDragStartPointerXRef.current = zoomHandleLocalX.current(ev);
    zoomDragStartLRef.current = zoomLCenterPxRef.current;
    zoomDragStartRRef.current = zoomRCenterPxRef.current;
    (ev.currentTarget as Element).setPointerCapture(ev.pointerId);
  });

  const onZoomHandlePointerMove = useRef((ev: PointerEvent): void => {
    if (
      !zoomHandleDragRef.current ||
      zoomDragPointerIdRef.current == null ||
      ev.pointerId !== zoomDragPointerIdRef.current
    )
      return;
    if (zoomHandleDragRef.current === 'bar') return;
    const m = getZoomRangeMetrics.current();
    const vp = viewportRef.current;
    if (!m || !vp) return;
    const x = zoomHandleLocalX.current(ev);
    const dx = x - zoomDragStartPointerXRef.current;
    const base = timelineZoomLayoutBase.current();
    const vpW = Math.max(1, vp.clientWidth);
    const zMax = timelineZoomMaxFromGeom.current();
    const S0 = zoomDragStartRRef.current - zoomDragStartLRef.current;
    let spanStrip = zoomHandleDragRef.current === 'left' ? S0 - 2 * dx : S0 + 2 * dx;
    spanStrip = Math.max(m.spanMin, Math.min(m.spanMax, spanStrip));
    if (m.spanMax - spanStrip < 1e-2) {
      zoomLCenterPxRef.current = m.R;
      zoomRCenterPxRef.current = m.W - m.R;
      zoomRef.current = TIMELINE_ZOOM_MIN;
    } else {
      let innerW = (vpW * m.W) / spanStrip;
      zoomRef.current = innerW / base;
      zoomRef.current = Math.max(TIMELINE_ZOOM_MIN, Math.min(zMax, zoomRef.current));
      innerW = Math.ceil(base * zoomRef.current);
      spanStrip = (vpW * m.W) / innerW;
      spanStrip = Math.max(m.spanMin, Math.min(m.spanMax, spanStrip));
      const maxScroll = Math.max(0, innerW - vpW);
      const totalSec = Math.max(1, totalSecRef.current ?? 30);
      let sl = 0;
      if (totalSec > 1e-9) {
        const playSec = Math.min(Math.max(0, activeSecRef.current ?? 0), totalSec);
        const playPx = (playSec / totalSec) * innerW;
        sl = Math.max(0, Math.min(maxScroll, playPx - vpW / 2));
      }
      const usable = Math.max(0, m.W - 2 * m.R - spanStrip);
      let nl: number;
      if (maxScroll < 1e-6) {
        nl = m.R;
      } else {
        nl = m.R + (sl / maxScroll) * usable;
      }
      let nr = nl + spanStrip;
      nl = Math.max(m.R, Math.min(nl, m.W - m.R - spanStrip));
      nr = nl + spanStrip;
      if (nr > m.W - m.R) {
        nr = m.W - m.R;
        nl = Math.max(m.R, nr - spanStrip);
        nr = nl + spanStrip;
      }
      zoomLCenterPxRef.current = nl;
      zoomRCenterPxRef.current = nr;
    }
    updateZoomTrackDomVisual.current();
    setZoomValueLabel.current(zoomRef.current);
    if (!zoomDragRafRef.current) {
      zoomDragRafRef.current = requestAnimationFrame(commitZoomDragFrame.current);
    }
  });

  const onZoomHandlePointerUp = useRef((ev: PointerEvent): void => {
    if (zoomDragPointerIdRef.current == null || ev.pointerId !== zoomDragPointerIdRef.current)
      return;
    const wasBar = zoomHandleDragRef.current === 'bar';
    const capEl =
      zoomHandleDragRef.current === 'left'
        ? zoomOutRef.current
        : zoomHandleDragRef.current === 'right'
          ? zoomInRef.current
          : zoomHandleDragRef.current === 'bar'
            ? zoomBarRef.current
            : null;
    if (zoomDragRafRef.current) {
      cancelAnimationFrame(zoomDragRafRef.current);
      zoomDragRafRef.current = null;
    }
    if (!wasBar) {
      scrollRecenterFlagRef.current = true;
      applyTimelineZoomLayout.current({ syncScrollFromZoomBar: true });
      if (scrollRecenterFlagRef.current) {
        scrollRecenterFlagRef.current = false;
        if (zoomRef.current > 1 + 1e-9) syncTimelineScrollToPlayhead.current();
        else syncZoomTrackFromScroll.current();
      }
    }
    zoomHandleDragRef.current = null;
    zoomDragPointerIdRef.current = null;
    try {
      capEl?.releasePointerCapture(ev.pointerId);
    } catch {
      /* ignore */
    }
    if (wasBar) syncZoomTrackFromScroll.current();
  });

  const parseZoomPercentInput = useRef((raw: string): number | null => {
    const s = raw.trim().replace(/%+\s*$/, '');
    const n = Number.parseFloat(s);
    return Number.isFinite(n) ? n : null;
  });

  const commitZoomFromValueField = useRef((): void => {
    const inp = zoomValueRef.current;
    if (!inp) return;
    const pct = parseZoomPercentInput.current(inp.value);
    const zMax = timelineZoomMaxFromGeom.current();
    if (pct == null) {
      if (inp.value.trim() !== '') {
        toast.error(
          `Zoom must be a number between ${Math.round(TIMELINE_ZOOM_MIN * 100)}% and ${Math.round(zMax * 100)}%.`,
        );
      }
      setZoomValueLabel.current(zoomRef.current, true);
      return;
    }
    const clampedPct = Math.max(TIMELINE_ZOOM_MIN * 100, Math.min(zMax * 100, pct));
    zoomRef.current = Math.max(TIMELINE_ZOOM_MIN, Math.min(zMax, clampedPct / 100));
    scrollRecenterFlagRef.current = true;
    applyTimelineZoomLayout.current({ recenterPlayheadAfterZoom: true, deferPlayheadScroll: true });
    if (scrollRecenterFlagRef.current) {
      scrollRecenterFlagRef.current = false;
      if (zoomRef.current > 1 + 1e-9) syncTimelineScrollToPlayhead.current();
      else syncZoomTrackFromScroll.current();
    }
    setZoomValueLabel.current(zoomRef.current, true);
  });

  const scrollToSec = useRef((sec: number, totalSec?: number): void => {
    const vp = viewportRef.current;
    const inner = innerRef.current;
    const tot =
      totalSec != null && Number.isFinite(totalSec) && totalSec > 0
        ? totalSec
        : (totalSecRef.current ?? 30);
    if (!vp || !inner || tot <= 0) return;
    const vpW = Math.max(1, vp.clientWidth);
    const innerW = Math.max(1, inner.offsetWidth);
    const maxScroll = Math.max(0, innerW - vpW);
    if (maxScroll <= TIMELINE_FIT_SCROLL_EPS_PX) {
      vp.scrollLeft = 0;
      syncZoomTrackFromScroll.current();
      return;
    }
    const t = Math.max(0, Math.min(1, sec / tot));
    const x = t * innerW;
    vp.scrollLeft = Math.max(0, Math.min(x - vpW / 2, maxScroll));
  });

  const resetZoom = useRef((): void => {
    if (zoomTooltipHideTimerRef.current) {
      clearTimeout(zoomTooltipHideTimerRef.current);
      zoomTooltipHideTimerRef.current = null;
    }
    zoomTooltipRef.current?.classList.add('hidden');
    zoomRef.current = 1;
    stableBaseWidthRef.current = null;
    zoomLCenterPxRef.current = null;
    zoomRCenterPxRef.current = null;
    lastZoomTooltipPctRef.current = null;
    setZoomValueLabel.current(1, true);
  });

  // ---------- effects ----------

  // Publish window globals for in-app consumers (TimelineTicks reads the zoom;
  // timelineJump/useTimelineSeek drive the scroll).
  useEffect(() => {
    window.AutoLogger_getTimelineZoom = () => zoomRef.current;
    window.AutoLogger_scrollTimelineToSec = (sec: number, totalSec?: number) =>
      scrollToSec.current(sec, totalSec);
    return () => {
      window.AutoLogger_getTimelineZoom = undefined;
      window.AutoLogger_scrollTimelineToSec = undefined;
    };
  }, []);

  // Reset zoom on session switch.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset on sessionId change
  useEffect(() => {
    resetZoom.current();
  }, [sessionId]);

  // Attach all event listeners + ResizeObservers.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once; zoom DOM refs are stable after mount
  useEffect(() => {
    const vp = viewportRef.current;
    const inner = innerRef.current;
    const zr = zoomRangeRef.current;
    const bar = zoomBarRef.current;
    const zo = zoomOutRef.current;
    const zi = zoomInRef.current;
    const inp = zoomValueRef.current;
    if (!vp || !inner || !zr || !bar || !zo || !zi || !inp) return;

    // Scroll → sync zoom strip
    const onScroll = () => syncZoomTrackFromScroll.current();
    vp.addEventListener('scroll', onScroll);

    // Wheel pinch-zoom on viewport
    const isZoomWheel = (ev: WheelEvent) =>
      ev.ctrlKey || ev.metaKey || (typeof ev.deltaZ === 'number' && Math.abs(ev.deltaZ) > 1e-6);
    const onWheel = (ev: WheelEvent) => {
      if (!isZoomWheel(ev)) return;
      ev.preventDefault();
      const factor = ev.deltaY > 0 ? 1 / TIMELINE_ZOOM_WHEEL_FACT : TIMELINE_ZOOM_WHEEL_FACT;
      scheduleWheelZoom.current(factor);
    };
    vp.addEventListener('wheel', onWheel, { passive: false });

    // Zoom bar drag
    const onBarDown = (ev: PointerEvent) => onZoomBarPointerDown.current(ev);
    const onBarMove = (ev: PointerEvent) => onZoomBarPointerMove.current(ev);
    const onBarUp = (ev: PointerEvent) => onZoomHandlePointerUp.current(ev);
    bar.addEventListener('pointerdown', onBarDown);
    bar.addEventListener('pointermove', onBarMove);
    bar.addEventListener('pointerup', onBarUp);
    bar.addEventListener('pointercancel', onBarUp);

    // Left handle drag
    const onZoDown = (ev: PointerEvent) => onZoomHandlePointerDown.current('left', ev);
    const onZoMove = (ev: PointerEvent) => onZoomHandlePointerMove.current(ev);
    const onZoUp = (ev: PointerEvent) => onZoomHandlePointerUp.current(ev);
    zo.addEventListener('pointerdown', onZoDown);
    zo.addEventListener('pointermove', onZoMove);
    zo.addEventListener('pointerup', onZoUp);
    zo.addEventListener('pointercancel', onZoUp);

    // Right handle drag
    const onZiDown = (ev: PointerEvent) => onZoomHandlePointerDown.current('right', ev);
    const onZiMove = (ev: PointerEvent) => onZoomHandlePointerMove.current(ev);
    const onZiUp = (ev: PointerEvent) => onZoomHandlePointerUp.current(ev);
    zi.addEventListener('pointerdown', onZiDown);
    zi.addEventListener('pointermove', onZiMove);
    zi.addEventListener('pointerup', onZiUp);
    zi.addEventListener('pointercancel', onZiUp);

    // Zoom value input
    const onInpKeydown = (ev: KeyboardEvent) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        inp.blur();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        setZoomValueLabel.current(zoomRef.current, true);
        inp.blur();
      }
    };
    const onInpBlur = () => commitZoomFromValueField.current();
    const onInpFocus = () => {
      if (typeof inp.select === 'function') inp.select();
    };
    inp.addEventListener('keydown', onInpKeydown);
    inp.addEventListener('blur', onInpBlur);
    inp.addEventListener('focus', onInpFocus);

    // Keyboard zoom (+/-): bail while typing, while any dialog is open, or
    // when another handler already consumed the key (ui-refresh D14 / spec
    // "Global single-key handlers yield to dialogs and interactive targets").
    const onKeydown = (ev: KeyboardEvent) => {
      if (isTypingTarget(ev.target)) return;
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (ev.defaultPrevented) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (ev.code === 'Equal' || ev.code === 'NumpadAdd') {
        ev.preventDefault();
        changeTimelineZoom.current(TIMELINE_ZOOM_KEY_FACT);
      } else if (ev.code === 'Minus' || ev.code === 'NumpadSubtract') {
        ev.preventDefault();
        changeTimelineZoom.current(1 / TIMELINE_ZOOM_KEY_FACT);
      }
    };
    window.addEventListener('keydown', onKeydown);

    // ResizeObserver — coalesce viewport + zoom strip
    let resizeRafId: number | null = null;
    const scheduleResize = () => {
      if (resizeRafId) cancelAnimationFrame(resizeRafId);
      resizeRafId = requestAnimationFrame(() => {
        resizeRafId = null;
        flushResizeLayout.current();
      });
    };
    const ro = new ResizeObserver(scheduleResize);
    ro.observe(vp);
    const zro = new ResizeObserver(scheduleResize);
    zro.observe(zr);

    // Initial layout
    flushResizeLayout.current();

    return () => {
      vp.removeEventListener('scroll', onScroll);
      vp.removeEventListener('wheel', onWheel);
      bar.removeEventListener('pointerdown', onBarDown);
      bar.removeEventListener('pointermove', onBarMove);
      bar.removeEventListener('pointerup', onBarUp);
      bar.removeEventListener('pointercancel', onBarUp);
      zo.removeEventListener('pointerdown', onZoDown);
      zo.removeEventListener('pointermove', onZoMove);
      zo.removeEventListener('pointerup', onZoUp);
      zo.removeEventListener('pointercancel', onZoUp);
      zi.removeEventListener('pointerdown', onZiDown);
      zi.removeEventListener('pointermove', onZiMove);
      zi.removeEventListener('pointerup', onZiUp);
      zi.removeEventListener('pointercancel', onZiUp);
      inp.removeEventListener('keydown', onInpKeydown);
      inp.removeEventListener('blur', onInpBlur);
      inp.removeEventListener('focus', onInpFocus);
      window.removeEventListener('keydown', onKeydown);
      ro.disconnect();
      zro.disconnect();
      if (resizeRafId) cancelAnimationFrame(resizeRafId);
      if (wheelZoomRafRef.current) cancelAnimationFrame(wheelZoomRafRef.current);
      if (zoomDragRafRef.current) cancelAnimationFrame(zoomDragRafRef.current);
      if (zoomTooltipHideTimerRef.current) clearTimeout(zoomTooltipHideTimerRef.current);
    };
  }, []);

  // After each render that changes activeSec/totalSec, check for a pending recenter.
  // (This handles the case where zoom was changed via keyboard/wheel and the new activeSec
  //  is only available after React reconciles.)
  // NOTE: Most recentering is done synchronously in the zoom handlers themselves;
  // this is a safety net for any remaining deferred cases.
  useEffect(() => {
    if (!scrollRecenterFlagRef.current) return;
    scrollRecenterFlagRef.current = false;
    if (zoomRef.current > 1 + 1e-9) {
      syncTimelineScrollToPlayhead.current(activeSecRef.current ?? 0, totalSecRef.current ?? 30);
    } else {
      syncZoomTrackFromScroll.current();
    }
  });
}
