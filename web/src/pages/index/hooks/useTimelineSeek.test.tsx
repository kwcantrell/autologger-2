import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionStatus } from '../../../api/hooks/useSessionStatus';
import type { AudioClipLite } from '../../../shared/utils/waveformMerge';
import { register, unregister } from '../coordination/registry';
import { AudioClipsProvider } from './AudioClipsContext';
import { useTimelineSeek } from './useTimelineSeek';

// --- useTimelineSeek (feed-row-seek, task 3.3/3.4) ---
//
// The shared feed-facing hook (design D5/D6/D7/D8): the FEED gate (loaded status,
// not rolling, not batch-edit), the clip-coverage check, and playback all live
// here — deliberately NOT in `timelineJump` (the ungated, uncoverage-checked,
// non-playing module MarkerNav owns). `useSessionStatus` is mocked at the
// module boundary; the clip layout is supplied via `AudioClipsProvider` (whole-
// branch audit fix wave, finding C1) — the hook reads the SAME session-wide
// layout `SessionWorkspace` publishes rather than calling `useAudioClips`
// itself, so these tests drive it the same way: a wrapper around `renderHook`,
// not a module mock.

vi.mock('../../../api/hooks/useSessionStatus', () => ({
  useSessionStatus: vi.fn(),
}));

const mockedUseSessionStatus = vi.mocked(useSessionStatus);

const SESSION_ID = 'sess-timeline-seek-1';

function statusResult(data: { is_rolling: boolean } | undefined) {
  return { data } as unknown as ReturnType<typeof useSessionStatus>;
}

// A clip covering [10, 20) that is fully playable.
const COVERING_CLIP: AudioClipLite = {
  segmentId: 'seg-1',
  url: 'https://example.test/seg-1.wav',
  startSec: 10,
  endSec: 20,
  duration: 10,
  missingAudio: false,
};

/** `renderHook`'s `wrapper` option — publishes `clips` via `AudioClipsContext`,
 *  the same mechanism `SessionWorkspace` uses in production. */
function withClips(clips: AudioClipLite[]) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <AudioClipsProvider clips={clips}>{children}</AudioClipsProvider>;
  };
}

let scrubMock: ReturnType<typeof vi.fn<(sec: number | null) => void>>;
let scrollMock: ReturnType<typeof vi.fn<(sec: number, totalSec?: number) => void>>;
let seekMock: ReturnType<typeof vi.fn<(sec: number) => void>>;
let seekAndPlayMock: ReturnType<typeof vi.fn<(sec: number) => void>>;

beforeEach(() => {
  vi.clearAllMocks();
  scrubMock = vi.fn();
  scrollMock = vi.fn();
  seekMock = vi.fn();
  seekAndPlayMock = vi.fn();
  register('setManualScrubSec', scrubMock);
  register('scrollTimelineToSec', scrollMock);
  register('seekAudio', seekMock);
  register('seekAudioAndPlay', seekAndPlayMock);
  // Default: loaded, not rolling. Individual tests override.
  mockedUseSessionStatus.mockReturnValue(statusResult({ is_rolling: false }));
});

describe('useTimelineSeek — availability gate', () => {
  it('is unavailable while is_rolling', () => {
    mockedUseSessionStatus.mockReturnValue(statusResult({ is_rolling: true }));
    const { result } = renderHook(() => useTimelineSeek(SESSION_ID, false), {
      wrapper: withClips([COVERING_CLIP]),
    });
    expect(result.current.unavailable).toBe(true);
  });

  it('is unavailable while status is unresolved (undefined must not read as not-rolling)', () => {
    mockedUseSessionStatus.mockReturnValue(statusResult(undefined));
    const { result } = renderHook(() => useTimelineSeek(SESSION_ID, false), {
      wrapper: withClips([COVERING_CLIP]),
    });
    expect(result.current.unavailable).toBe(true);
  });

  it('is unavailable in batch-edit mode', () => {
    mockedUseSessionStatus.mockReturnValue(statusResult({ is_rolling: false }));
    const { result } = renderHook(() => useTimelineSeek(SESSION_ID, true), {
      wrapper: withClips([COVERING_CLIP]),
    });
    expect(result.current.unavailable).toBe(true);
  });

  it('is available when loaded, not rolling, and not batch-edit', () => {
    mockedUseSessionStatus.mockReturnValue(statusResult({ is_rolling: false }));
    const { result } = renderHook(() => useTimelineSeek(SESSION_ID, false), {
      wrapper: withClips([COVERING_CLIP]),
    });
    expect(result.current.unavailable).toBe(false);
  });

  it('is unavailable (empty clips) when rendered outside any AudioClipsProvider', () => {
    const { result } = renderHook(() => useTimelineSeek(SESSION_ID, false));
    // No wrapper: falls back to AudioClipsContext's empty default — the hook
    // itself is still available (status-gated), it simply has no clips to
    // cover anything with.
    expect(result.current.unavailable).toBe(false);
    result.current.jump(15);
    expect(seekAndPlayMock).not.toHaveBeenCalled();
  });
});

describe('useTimelineSeek — jump behavior', () => {
  it('gated off: activating does nothing at all (no scrub, no scroll, no audio)', () => {
    mockedUseSessionStatus.mockReturnValue(statusResult({ is_rolling: true }));
    const { result } = renderHook(() => useTimelineSeek(SESSION_ID, false), {
      wrapper: withClips([COVERING_CLIP]),
    });

    result.current.jump(15);

    expect(scrubMock).not.toHaveBeenCalled();
    expect(scrollMock).not.toHaveBeenCalled();
    expect(seekMock).not.toHaveBeenCalled();
    expect(seekAndPlayMock).not.toHaveBeenCalled();
  });

  it('uncovered target: issues scrub + scroll but no audio and no playback', () => {
    // No clip at all covers second 50.
    const { result } = renderHook(() => useTimelineSeek(SESSION_ID, false), {
      wrapper: withClips([COVERING_CLIP]),
    });

    result.current.jump(50);

    expect(scrubMock).toHaveBeenCalledWith(50);
    expect(scrollMock).toHaveBeenCalledWith(50, undefined);
    expect(seekMock).not.toHaveBeenCalled();
    expect(seekAndPlayMock).not.toHaveBeenCalled();
  });

  it('a clip present but unplayable (missingAudio) does not count as coverage', () => {
    const { result } = renderHook(() => useTimelineSeek(SESSION_ID, false), {
      wrapper: withClips([{ ...COVERING_CLIP, missingAudio: true }]),
    });

    result.current.jump(15);

    expect(scrubMock).toHaveBeenCalledWith(15);
    expect(scrollMock).toHaveBeenCalledWith(15, undefined);
    expect(seekAndPlayMock).not.toHaveBeenCalled();
  });

  it('a clip present but unplayable (no url) does not count as coverage', () => {
    const { result } = renderHook(() => useTimelineSeek(SESSION_ID, false), {
      wrapper: withClips([{ ...COVERING_CLIP, url: null }]),
    });

    result.current.jump(15);

    expect(seekAndPlayMock).not.toHaveBeenCalled();
  });

  it('covered target: issues the jump and starts playback via the seekAudioAndPlay handle', () => {
    const { result } = renderHook(() => useTimelineSeek(SESSION_ID, false), {
      wrapper: withClips([COVERING_CLIP]),
    });

    result.current.jump(15);

    expect(scrubMock).toHaveBeenCalledWith(15);
    expect(scrollMock).toHaveBeenCalledWith(15, undefined);
    expect(seekAndPlayMock).toHaveBeenCalledWith(15);
    // The non-playing handle belongs to marker navigation only — the feed
    // jump must never call it (design D1's implementation note).
    expect(seekMock).not.toHaveBeenCalled();
  });

  it('jump is a no-op (never throws) when the play-capable handle is not yet registered', () => {
    unregister('seekAudioAndPlay', seekAndPlayMock);
    const { result } = renderHook(() => useTimelineSeek(SESSION_ID, false), {
      wrapper: withClips([COVERING_CLIP]),
    });

    expect(() => result.current.jump(15)).not.toThrow();
    expect(scrubMock).toHaveBeenCalledWith(15);
  });

  // Whole-branch audit fix wave, finding M4: `isCoveredByPlayableClip` used to
  // be a separately-maintained `clips.some(...)` predicate — "some playable
  // clip contains sec" — that could disagree with what `resolvePlayPosition`
  // (the function `AudioPlayer` itself calls to actually start playback)
  // resolves to. `resolvePlayPosition` scans clips in ARRAY ORDER and returns
  // on the FIRST one containing `sec`; if that first clip is unplayable, it
  // forwards to the NEXT playable clip BY INDEX — which may not contain `sec`
  // at all — and never considers any clip after that. `some()` has no such
  // ordering: it would find a THIRD, later playable clip that genuinely
  // contains `sec` and report "covered", even though the player would never
  // reach that clip. Reproduced here with clips = [A (unplayable, contains
  // sec=12), C (playable, does NOT contain sec=12), B (playable, DOES contain
  // sec=12, but positioned AFTER C so resolvePlayPosition never reaches it)]:
  // the old predicate would say "covered" (via B); the fixed one must agree
  // with the player and say "not covered" (the player lands on C, which does
  // not contain 12).
  it('resolvePlayPosition-drift case: a later, genuinely-containing playable clip the player would never reach is NOT reported as covered', () => {
    const unplayableA: AudioClipLite = {
      segmentId: null,
      url: null,
      startSec: 10,
      endSec: 30,
      duration: 20,
      missingAudio: true,
    };
    const playableCNotContaining: AudioClipLite = {
      segmentId: 'seg-c',
      url: 'https://example.test/c.wav',
      startSec: 40,
      endSec: 50,
      duration: 10,
      missingAudio: false,
    };
    const playableBContaining: AudioClipLite = {
      segmentId: 'seg-b',
      url: 'https://example.test/b.wav',
      startSec: 5,
      endSec: 20,
      duration: 15,
      missingAudio: false,
    };
    const { result } = renderHook(() => useTimelineSeek(SESSION_ID, false), {
      wrapper: withClips([unplayableA, playableCNotContaining, playableBContaining]),
    });

    result.current.jump(12);

    expect(seekAndPlayMock).not.toHaveBeenCalled();
    // The playhead still moves — an uncovered-by-the-real-player target still
    // scrubs/scrolls, same as any other uncovered jump (design D6).
    expect(scrubMock).toHaveBeenCalledWith(12);
  });
});

describe('useTimelineSeek — stable callback (design D7)', () => {
  it('jump is referentially stable across re-renders with unchanged gate/clips', () => {
    const { result, rerender } = renderHook(() => useTimelineSeek(SESSION_ID, false), {
      wrapper: withClips([COVERING_CLIP]),
    });
    const first = result.current.jump;
    rerender();
    expect(result.current.jump).toBe(first);
  });

  it('jump changes identity when the gate flips (rolling → not rolling)', () => {
    mockedUseSessionStatus.mockReturnValue(statusResult({ is_rolling: true }));
    const { result, rerender } = renderHook(() => useTimelineSeek(SESSION_ID, false), {
      wrapper: withClips([COVERING_CLIP]),
    });
    const whileRolling = result.current.jump;

    mockedUseSessionStatus.mockReturnValue(statusResult({ is_rolling: false }));
    rerender();

    expect(result.current.jump).not.toBe(whileRolling);
    expect(result.current.unavailable).toBe(false);
  });
});
