import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionStatus } from '../../../api/hooks/useSessionStatus';
import type { AudioClipLite } from '../../../shared/utils/waveformMerge';
import { useAudioClips } from './useAudioClips';
import { useTimelineSeek } from './useTimelineSeek';

// --- useTimelineSeek (feed-row-seek, task 3.3/3.4) ---
//
// The shared feed-facing hook (design D5/D6/D7/D8): the FEED gate (loaded status,
// not rolling, not batch-edit), the clip-coverage check, and playback all live
// here — deliberately NOT in `timelineJump` (the ungated, uncoverage-checked,
// non-playing module MarkerNav owns). Mocked at the module boundary, same
// pattern as MarkerNav.test.tsx: this is a test of the hook's own gating/
// coverage/playback logic, not of the underlying React Query plumbing, so no
// QueryClientProvider is needed (useSessionStatus and useAudioClips are both
// replaced wholesale).

vi.mock('../../../api/hooks/useSessionStatus', () => ({
  useSessionStatus: vi.fn(),
}));
vi.mock('./useAudioClips', () => ({
  useAudioClips: vi.fn(),
}));

const mockedUseSessionStatus = vi.mocked(useSessionStatus);
const mockedUseAudioClips = vi.mocked(useAudioClips);

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

function clipsResult(clips: (typeof COVERING_CLIP)[]) {
  return { clips, totalSec: 100, segments: [] } as unknown as ReturnType<typeof useAudioClips>;
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
  window.AutoLogger_setManualScrubSec = scrubMock;
  window.AutoLogger_scrollTimelineToSec = scrollMock;
  window.AutoLogger_seekAudio = seekMock;
  window.AutoLogger_seekAudioAndPlay = seekAndPlayMock;
  // Default: loaded, not rolling, one covering clip. Individual tests override.
  mockedUseSessionStatus.mockReturnValue(statusResult({ is_rolling: false }));
  mockedUseAudioClips.mockReturnValue(clipsResult([COVERING_CLIP]));
});

describe('useTimelineSeek — availability gate', () => {
  it('is unavailable while is_rolling', () => {
    mockedUseSessionStatus.mockReturnValue(statusResult({ is_rolling: true }));
    const { result } = renderHook(() => useTimelineSeek(SESSION_ID, [], false));
    expect(result.current.available).toBe(false);
  });

  it('is unavailable while status is unresolved (undefined must not read as not-rolling)', () => {
    mockedUseSessionStatus.mockReturnValue(statusResult(undefined));
    const { result } = renderHook(() => useTimelineSeek(SESSION_ID, [], false));
    expect(result.current.available).toBe(false);
  });

  it('is unavailable in batch-edit mode', () => {
    mockedUseSessionStatus.mockReturnValue(statusResult({ is_rolling: false }));
    const { result } = renderHook(() => useTimelineSeek(SESSION_ID, [], true));
    expect(result.current.available).toBe(false);
  });

  it('is available when loaded, not rolling, and not batch-edit', () => {
    mockedUseSessionStatus.mockReturnValue(statusResult({ is_rolling: false }));
    const { result } = renderHook(() => useTimelineSeek(SESSION_ID, [], false));
    expect(result.current.available).toBe(true);
  });
});

describe('useTimelineSeek — jump behavior', () => {
  it('gated off: activating does nothing at all (no scrub, no scroll, no audio)', () => {
    mockedUseSessionStatus.mockReturnValue(statusResult({ is_rolling: true }));
    const { result } = renderHook(() => useTimelineSeek(SESSION_ID, [], false));

    result.current.jump(15);

    expect(scrubMock).not.toHaveBeenCalled();
    expect(scrollMock).not.toHaveBeenCalled();
    expect(seekMock).not.toHaveBeenCalled();
    expect(seekAndPlayMock).not.toHaveBeenCalled();
  });

  it('uncovered target: issues scrub + scroll but no audio and no playback', () => {
    // No clip at all covers second 50.
    mockedUseAudioClips.mockReturnValue(clipsResult([COVERING_CLIP]));
    const { result } = renderHook(() => useTimelineSeek(SESSION_ID, [], false));

    result.current.jump(50);

    expect(scrubMock).toHaveBeenCalledWith(50);
    expect(scrollMock).toHaveBeenCalledWith(50);
    expect(seekMock).not.toHaveBeenCalled();
    expect(seekAndPlayMock).not.toHaveBeenCalled();
  });

  it('a clip present but unplayable (missingAudio) does not count as coverage', () => {
    mockedUseAudioClips.mockReturnValue(clipsResult([{ ...COVERING_CLIP, missingAudio: true }]));
    const { result } = renderHook(() => useTimelineSeek(SESSION_ID, [], false));

    result.current.jump(15);

    expect(scrubMock).toHaveBeenCalledWith(15);
    expect(scrollMock).toHaveBeenCalledWith(15);
    expect(seekAndPlayMock).not.toHaveBeenCalled();
  });

  it('a clip present but unplayable (no url) does not count as coverage', () => {
    mockedUseAudioClips.mockReturnValue(clipsResult([{ ...COVERING_CLIP, url: null }]));
    const { result } = renderHook(() => useTimelineSeek(SESSION_ID, [], false));

    result.current.jump(15);

    expect(seekAndPlayMock).not.toHaveBeenCalled();
  });

  it('covered target: issues the jump and starts playback via AutoLogger_seekAudioAndPlay', () => {
    const { result } = renderHook(() => useTimelineSeek(SESSION_ID, [], false));

    result.current.jump(15);

    expect(scrubMock).toHaveBeenCalledWith(15);
    expect(scrollMock).toHaveBeenCalledWith(15);
    expect(seekAndPlayMock).toHaveBeenCalledWith(15);
    // The non-playing global belongs to marker navigation only — the feed
    // jump must never call it (design D1's implementation note).
    expect(seekMock).not.toHaveBeenCalled();
  });

  it('jump is a no-op (never throws) when the play-capable global is not yet published', () => {
    window.AutoLogger_seekAudioAndPlay = undefined;
    const { result } = renderHook(() => useTimelineSeek(SESSION_ID, [], false));

    expect(() => result.current.jump(15)).not.toThrow();
    expect(scrubMock).toHaveBeenCalledWith(15);
  });
});

describe('useTimelineSeek — stable callback (design D7)', () => {
  it('jump is referentially stable across re-renders with unchanged gate/clips', () => {
    const { result, rerender } = renderHook(() => useTimelineSeek(SESSION_ID, [], false));
    const first = result.current.jump;
    rerender();
    expect(result.current.jump).toBe(first);
  });

  it('jump changes identity when the gate flips (rolling → not rolling)', () => {
    mockedUseSessionStatus.mockReturnValue(statusResult({ is_rolling: true }));
    const { result, rerender } = renderHook(() => useTimelineSeek(SESSION_ID, [], false));
    const whileRolling = result.current.jump;

    mockedUseSessionStatus.mockReturnValue(statusResult({ is_rolling: false }));
    rerender();

    expect(result.current.jump).not.toBe(whileRolling);
    expect(result.current.available).toBe(true);
  });
});
