import { beforeEach, describe, expect, it, vi } from 'vitest';
import { register, unregister } from '../coordination/registry';
import { jumpTimelineToSec } from './timelineJump';

// --- timelineJump (feed-row-seek, task 3.1) ---
//
// The ONE typed place the three coordination handles — setManualScrubSec,
// scrollTimelineToSec, seekAudio — live. It is deliberately
// dumb (design D8): no gate, no clip-coverage check, no playback. MarkerNav
// (phase 10) will be refactored onto this exact module with no behavior change,
// so anything added here beyond the three calls would silently regress marker
// navigation, which is normative in the spec ("Marker navigation behavior is
// unchanged") and pinned by MarkerNav.test.tsx.
//
// Registrations are driven through the coordination registry rather than
// `window`; the shared web test setup resets the registry after every test
// (web-coordination-seam D3), so no manual teardown is needed here.

let scrubMock: ReturnType<typeof vi.fn<(sec: number | null) => void>>;
let scrollMock: ReturnType<typeof vi.fn<(sec: number, totalSec?: number) => void>>;
let seekMock: ReturnType<typeof vi.fn<(sec: number) => void>>;
let seekAndPlayMock: ReturnType<typeof vi.fn<(sec: number) => void>>;

beforeEach(() => {
  scrubMock = vi.fn();
  scrollMock = vi.fn();
  seekMock = vi.fn();
  // Play-capable path (feed-row-seek, phase 4) — jumpTimelineToSec must never
  // call this; see "never starts playback" below (quality fix wave, FIX 5,
  // mirroring MarkerNav.test.tsx's identical strengthening).
  seekAndPlayMock = vi.fn();
  register('setManualScrubSec', scrubMock);
  register('scrollTimelineToSec', scrollMock);
  register('seekAudio', seekMock);
  register('seekAudioAndPlay', seekAndPlayMock);
});

describe('jumpTimelineToSec', () => {
  it('issues scrub, scroll, and audio-seek with the same second, in that order', () => {
    jumpTimelineToSec(42);

    expect(scrubMock).toHaveBeenCalledWith(42);
    expect(scrollMock).toHaveBeenCalledWith(42, undefined);
    expect(seekMock).toHaveBeenCalledWith(42);

    const order = [scrubMock, scrollMock, seekMock].map((m) => m.mock.invocationCallOrder[0]);
    expect(order[0]).toBeLessThan(order[1]);
    expect(order[1]).toBeLessThan(order[2]);
  });

  it('no-ops without throwing when no owner is registered for all three handles', () => {
    unregister('setManualScrubSec', scrubMock);
    unregister('scrollTimelineToSec', scrollMock);
    unregister('seekAudio', seekMock);

    expect(() => jumpTimelineToSec(10)).not.toThrow();
  });

  it('no-ops without throwing when only some handles have no registered owner', () => {
    unregister('scrollTimelineToSec', scrollMock);

    expect(() => jumpTimelineToSec(10)).not.toThrow();
    expect(scrubMock).toHaveBeenCalledWith(10);
    expect(seekMock).toHaveBeenCalledWith(10);
  });

  it('does not gate on any rolling/session state — it is a plain, unconditional call', () => {
    // No status/session mocking exists at all in this test file. If jumpTimelineToSec
    // gated on anything, it would need such a dependency to test against; it has none.
    jumpTimelineToSec(5);
    jumpTimelineToSec(5);
    expect(seekMock).toHaveBeenCalledTimes(2);
  });

  it('does not check clip coverage — it issues the audio seek unconditionally', () => {
    // No useAudioClips or clip-coverage concept is imported or referenced; every
    // call reaches the seekAudio handle regardless of target.
    jumpTimelineToSec(999999);
    expect(seekMock).toHaveBeenCalledWith(999999);
  });

  it('never starts playback — the seek call carries only the target second', () => {
    jumpTimelineToSec(7);
    // A playback-capable path would need a second argument or a distinct handle;
    // this module exposes neither. Every call is the same single-argument,
    // non-playing signature AudioPlayer.seekToTimelineSec exposes today.
    for (const call of seekMock.mock.calls) {
      expect(call).toHaveLength(1);
    }

    // Direct assertion (quality fix wave, FIX 5): the arity check above is a
    // proxy that an implementation calling BOTH the seekAudio handle AND the
    // seekAudioAndPlay handle would pass unchanged, since no spy was
    // registered for that handle and an unregistered invoke silently no-ops.
    // MarkerNav.test.tsx closed this exact hole for MarkerNav; this mirrors
    // it for jumpTimelineToSec.
    expect(seekAndPlayMock).not.toHaveBeenCalled();
  });
});
