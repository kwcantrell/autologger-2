import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jumpTimelineToSec } from './timelineJump';

// --- timelineJump (feed-row-seek, task 3.1) ---
//
// The ONE typed place the three global names — AutoLogger_setManualScrubSec,
// AutoLogger_scrollTimelineToSec, AutoLogger_seekAudio — live. It is deliberately
// dumb (design D8): no gate, no clip-coverage check, no playback. MarkerNav
// (phase 10) will be refactored onto this exact module with no behavior change,
// so anything added here beyond the three calls would silently regress marker
// navigation, which is normative in the spec ("Marker navigation behavior is
// unchanged") and pinned by MarkerNav.test.tsx.

let scrubMock: ReturnType<typeof vi.fn<(sec: number | null) => void>>;
let scrollMock: ReturnType<typeof vi.fn<(sec: number, totalSec?: number) => void>>;
let seekMock: ReturnType<typeof vi.fn<(sec: number) => void>>;

const originalScrub = window.AutoLogger_setManualScrubSec;
const originalScroll = window.AutoLogger_scrollTimelineToSec;
const originalSeek = window.AutoLogger_seekAudio;

beforeEach(() => {
  scrubMock = vi.fn();
  scrollMock = vi.fn();
  seekMock = vi.fn();
  window.AutoLogger_setManualScrubSec = scrubMock;
  window.AutoLogger_scrollTimelineToSec = scrollMock;
  window.AutoLogger_seekAudio = seekMock;
});

afterEach(() => {
  window.AutoLogger_setManualScrubSec = originalScrub;
  window.AutoLogger_scrollTimelineToSec = originalScroll;
  window.AutoLogger_seekAudio = originalSeek;
});

describe('jumpTimelineToSec', () => {
  it('issues scrub, scroll, and audio-seek with the same second, in that order', () => {
    jumpTimelineToSec(42);

    expect(scrubMock).toHaveBeenCalledWith(42);
    expect(scrollMock).toHaveBeenCalledWith(42);
    expect(seekMock).toHaveBeenCalledWith(42);

    const order = [scrubMock, scrollMock, seekMock].map((m) => m.mock.invocationCallOrder[0]);
    expect(order[0]).toBeLessThan(order[1]);
    expect(order[1]).toBeLessThan(order[2]);
  });

  it('no-ops without throwing when all three globals are undefined', () => {
    window.AutoLogger_setManualScrubSec = undefined;
    window.AutoLogger_scrollTimelineToSec = undefined;
    window.AutoLogger_seekAudio = undefined;

    expect(() => jumpTimelineToSec(10)).not.toThrow();
  });

  it('no-ops without throwing when only some globals are undefined', () => {
    window.AutoLogger_scrollTimelineToSec = undefined;

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
    // call reaches AutoLogger_seekAudio regardless of target.
    jumpTimelineToSec(999999);
    expect(seekMock).toHaveBeenCalledWith(999999);
  });

  it('never starts playback — the seek call carries only the target second', () => {
    jumpTimelineToSec(7);
    // A playback-capable path would need a second argument or a distinct global;
    // this module exposes neither. Every call is the same single-argument,
    // non-playing signature AudioPlayer.seekToTimelineSec exposes today.
    for (const call of seekMock.mock.calls) {
      expect(call).toHaveLength(1);
    }
  });
});
