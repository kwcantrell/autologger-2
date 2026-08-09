import { describe, expect, it, vi } from 'vitest';
import type { SessionStatus } from '../../../api/types';
import { renderStrict } from '../../../test/renderStrict';
import { isRegistered } from '../coordination/registry';
import { Timeline } from './Timeline';

// --- web-coordination-seam task 5.2 (spec "Enforcement checks are proven
// non-vacuous") ---
//
// `Timeline` is the sole owner of `setManualScrubSec` (`Timeline.tsx`'s own
// `register('setManualScrubSec', writeManualScrubSec)` effect). No existing
// test mounted the real, unmocked component — every current consumer
// (`SessionWorkspace.*.test.tsx`, `MaximizeLogStrip.test.tsx`) stubs
// `./Timeline` out, so a window-write regression in its registration effect
// would be invisible everywhere else. This file exists solely to give that
// owner a real mount.
//
// jsdom has no ResizeObserver; `useZoomRail` (which `Timeline` calls
// internally) observes the viewport + zoom-range elements purely for layout
// sync, not exercised by this mount-only assertion.
class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof window !== 'undefined' && typeof window.ResizeObserver === 'undefined') {
  window.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
}

function baseProps() {
  return {
    sessionId: 'sess-timeline-mount-1',
    status: null as SessionStatus | null,
    events: [],
    audioClips: [],
    totalSec: 0,
    mergedPeaks: null,
    audioPlaybackSec: null,
    onSeekAudio: vi.fn(),
  };
}

describe('Timeline mounts its own coordination handle without touching window', () => {
  it('defines no AutoLogger_setManualScrubSec global after mount', () => {
    renderStrict(<Timeline {...baseProps()} />);
    expect('AutoLogger_setManualScrubSec' in window).toBe(false);
  });

  // --- Whole-branch audit finding Important-2 ---
  //
  // `Timeline` owns `setManualScrubSec`'s cleanup (`unregister('setManualScrubSec',
  // writeManualScrubSec)`); identity-scoped teardown (registry.ts, design D3) means
  // that call only releases the handle if it hands back the SAME reference it
  // registered. Mirrors `SessionWorkspace.coordinationHandles.test.tsx`'s
  // "unmounting releases the seekAudio handle" — the class of coverage phase 2
  // added for `SessionWorkspace` but never reached this owner.
  it('unmounting releases the setManualScrubSec handle', () => {
    const { unmount } = renderStrict(<Timeline {...baseProps()} />);
    expect(isRegistered('setManualScrubSec')).toBe(true);

    unmount();

    expect(isRegistered('setManualScrubSec')).toBe(false);
  });
});
