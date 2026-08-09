import { fireEvent } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { renderStrict } from '../../../test/renderStrict';
import { getTimelineZoom, isRegistered } from '../coordination/registry';
import { useZoomRail, type ZoomRailRefs } from './useZoomRail';

// --- useZoomRail +/- guard set (ui-refresh, task 4.4) ---
//
// D14 / spec "Global single-key handlers yield to dialogs and interactive
// targets": the pre-existing global +/- zoom handler must not fire while any
// `[role="dialog"]` is open, and must yield when an earlier listener already
// called `preventDefault()` on the keydown. Exercised through a minimal
// mounted probe (jsdom has no real timeline layout, but the hook's geometry
// helpers all fall back safely with zero-size elements) reading the
// `getTimelineZoom()` coordination handle the hook publishes.

function Harness({ sessionId = 'sess-zoom-1' }: { sessionId?: string }) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const zoomRangeRef = useRef<HTMLDivElement | null>(null);
  const zoomBarRef = useRef<HTMLDivElement | null>(null);
  const zoomOutRef = useRef<HTMLButtonElement | null>(null);
  const zoomInRef = useRef<HTMLButtonElement | null>(null);
  const zoomValueRef = useRef<HTMLInputElement | null>(null);
  const zoomTooltipRef = useRef<HTMLDivElement | null>(null);
  const activeSecRef = useRef(0);
  const totalSecRef = useRef(30);

  const refs: ZoomRailRefs = {
    viewportRef,
    innerRef,
    zoomRangeRef,
    zoomBarRef,
    zoomOutRef,
    zoomInRef,
    zoomValueRef,
    zoomTooltipRef,
  };
  useZoomRail(refs, activeSecRef, totalSecRef, sessionId);

  return (
    <div ref={viewportRef}>
      <div ref={innerRef} />
      <div ref={zoomTooltipRef} />
      <input ref={zoomValueRef} readOnly />
      <div ref={zoomRangeRef}>
        <div ref={zoomBarRef} />
        <button ref={zoomOutRef} type="button" />
        <button ref={zoomInRef} type="button" />
      </div>
    </div>
  );
}

function getZoom(): number {
  return getTimelineZoom() ?? 1;
}

// jsdom has no ResizeObserver; the hook observes the viewport + zoom-range
// elements purely for layout sync, which this guard-set test doesn't exercise.
class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof window !== 'undefined' && typeof window.ResizeObserver === 'undefined') {
  window.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
}

afterEach(() => {
  document.querySelectorAll('[role="dialog"]').forEach((el) => {
    el.remove();
  });
});

describe('useZoomRail global +/- handler', () => {
  it('zooms in on Equal in the baseline case (sanity)', () => {
    renderStrict(<Harness />);
    expect(getZoom()).toBe(1);
    fireEvent.keyDown(document.body, { code: 'Equal' });
    expect(getZoom()).toBeGreaterThan(1);
  });

  it('does not zoom while a [role="dialog"] is open', () => {
    renderStrict(<Harness />);
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.appendChild(dialog);
    try {
      fireEvent.keyDown(document.body, { code: 'Equal' });
      expect(getZoom()).toBe(1);
    } finally {
      dialog.remove();
    }
  });

  it('does not zoom when the keydown was already defaultPrevented', () => {
    renderStrict(<Harness />);
    const swallow = (e: KeyboardEvent) => e.preventDefault();
    document.addEventListener('keydown', swallow);
    try {
      fireEvent.keyDown(document.body, { code: 'Equal' });
      expect(getZoom()).toBe(1);
    } finally {
      document.removeEventListener('keydown', swallow);
    }
  });

  // --- web-coordination-seam task 5.2 (spec "Enforcement checks are proven
  // non-vacuous") --- `Harness` above mounts the real `useZoomRail` hook —
  // the actual owner of BOTH `getTimelineZoom` and `scrollTimelineToSec`,
  // registered together from the same effect (`useZoomRail.ts`) — so a
  // regression that reintroduced either as a `window.AutoLogger_*` write
  // would be observable right here.
  it('defines neither getTimelineZoom nor scrollTimelineToSec on window after mount', () => {
    renderStrict(<Harness />);
    expect('AutoLogger_getTimelineZoom' in window).toBe(false);
    expect('AutoLogger_scrollTimelineToSec' in window).toBe(false);
  });

  // --- Whole-branch audit finding Important-2 ---
  //
  // `useZoomRail` registers BOTH `getTimelineZoom` and `scrollTimelineToSec`
  // from the same effect and unregisters both in its cleanup. Identity-scoped
  // teardown (registry.ts, design D3) means each `unregister` call only
  // releases its handle if it hands back the SAME closure reference that was
  // registered. Mirrors `SessionWorkspace.coordinationHandles.test.tsx`'s
  // "unmounting releases the seekAudio handle" — the class of coverage phase
  // 2 added for `SessionWorkspace` but never reached this owner.
  it('unmounting releases both getTimelineZoom and scrollTimelineToSec handles', () => {
    const { unmount } = renderStrict(<Harness />);
    expect(isRegistered('getTimelineZoom')).toBe(true);
    expect(isRegistered('scrollTimelineToSec')).toBe(true);

    unmount();

    expect(isRegistered('getTimelineZoom')).toBe(false);
    expect(isRegistered('scrollTimelineToSec')).toBe(false);
  });
});
