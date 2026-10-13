import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';

// --- Moment deep links in the session workspace (catalog-search task 5.7, design D8;
// web-session-routing "Moment deep links") ---
//
// The rules themselves are pinned against `MomentDeepLink` in `MomentDeepLink.test.tsx`; this file
// pins that the REAL workspace applies them: `?t=` moves the timeline through
// `jumpTimelineToSec` once its handles exist, the parameter goes with a replace, and a moment
// link into the session already open applies without remounting the workspace. The mock roster
// mirrors `SessionWorkspace.coordinationHandles.test.tsx`; the Timeline is mocked, so the test
// registers its two handles itself (as Timeline.tsx and useZoomRail.ts do).

const useSessionStatusMock = vi.fn();
const useEventsMock = vi.fn();
const useAudioClipsMock = vi.fn();
const useWaveformsMock = vi.fn();
const useCompanionPresenceMock = vi.fn();
const useSessionSocketMock = vi.fn();
const useRecoveryStopWarningMock = vi.fn();
const useRemoteRecordingGateMock = vi.fn();
const useDebugTransportOverrideMock = vi.fn();

vi.mock('../../../api/hooks/useSessionStatus', () => ({
  useSessionStatus: (...args: unknown[]) => useSessionStatusMock(...args),
}));
vi.mock('../../../api/hooks/useEvents', () => ({
  useEvents: (...args: unknown[]) => useEventsMock(...args),
  eventsKeys: { all: (id: string) => ['events', id] },
  WORKSPACE_EVENTS_LIMIT: 500,
}));
vi.mock('../hooks/useAudioClips', () => ({
  useAudioClips: (...args: unknown[]) => useAudioClipsMock(...args),
}));
vi.mock('../hooks/useWaveforms', () => ({
  useWaveforms: (...args: unknown[]) => useWaveformsMock(...args),
}));
vi.mock('../../../api/hooks/useCompanionPresence', () => ({
  useCompanionPresence: (...args: unknown[]) => useCompanionPresenceMock(...args),
}));
vi.mock('../../../api/hooks/useSessionSocket', () => ({
  useSessionSocket: (...args: unknown[]) => useSessionSocketMock(...args),
}));
vi.mock('../hooks/useRecoveryStopWarning', () => ({
  useRecoveryStopWarning: (...args: unknown[]) => useRecoveryStopWarningMock(...args),
}));
vi.mock('../hooks/useRemoteRecordingGate', () => ({
  useRemoteRecordingGate: (...args: unknown[]) => useRemoteRecordingGateMock(...args),
}));
vi.mock('../../../shared/hooks/useDebugTransportOverride', () => ({
  useDebugTransportOverride: (...args: unknown[]) => useDebugTransportOverrideMock(...args),
}));
vi.mock('../../../api/client', () => ({ apiFetch: vi.fn().mockResolvedValue({}) }));
vi.mock('../../../shared/components/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../../shared/ui/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('../../../shared/ui/ConfirmDialog', () => ({ ConfirmDialog: () => null }));
vi.mock('../hooks/AudioClipsContext', () => ({
  AudioClipsProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('./AiPanel', () => ({ AiPanel: () => null }));
vi.mock('./AiV2Panel', () => ({ AiV2Panel: () => null }));
vi.mock('./AudioPlayer', () => ({ AudioPlayer: () => null }));
vi.mock('./AudioRecorder', () => ({ AudioRecorder: () => null }));
vi.mock('./AudioSaveOverlay', () => ({ AudioSaveOverlay: () => null }));
vi.mock('./ChunkRescueBanner', () => ({ ChunkRescueBanner: () => null }));
vi.mock('./CategoryButtonStrip', () => ({ CategoryButtonStrip: () => null }));
// Counts the feed's mounts: a same-session moment link must not remount the workspace.
const feedMounts = vi.hoisted(() => ({ count: 0 }));
vi.mock('./EventLogSheet', async () => {
  const { useEffect } = await import('react');
  return {
    EventLogSheet: () => {
      useEffect(() => {
        feedMounts.count += 1;
      }, []);
      return <div data-testid="event-log-sheet-stub" />;
    },
    eventRowTimelineSec: () => null,
  };
});
vi.mock('./ExportFeed', () => ({ ExportFeed: () => null }));
vi.mock('./MarkerNav', () => ({ MarkerNav: () => null }));
vi.mock('./TimecodeDisplay', () => ({
  TimecodeDisplay: () => <div data-testid="timecode-display-stub" />,
}));
vi.mock('./Timeline', () => ({ Timeline: () => <div data-testid="timeline-stub" /> }));
vi.mock('./TopicsFeed', () => ({
  TopicsFeed: () => <div data-testid="topics-feed-stub" />,
}));
vi.mock('./TranscribeFeed', () => ({
  TranscribeFeed: () => <div data-testid="transcribe-feed-stub" />,
}));
vi.mock('./TransportControls', () => ({
  getTransportState: (rolling: boolean, recording: boolean) =>
    recording ? 'audio-recording' : rolling ? 'rolling' : 'stop',
  TransportControls: () => <div data-testid="transport-controls-stub" />,
}));

vi.mock('../utils/timelineJump', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/timelineJump')>();
  return { ...actual, jumpTimelineToSec: vi.fn(actual.jumpTimelineToSec) };
});

import { register } from '../coordination/registry';
import { setNavigationImplForTesting } from '../navigation';
import { jumpTimelineToSec } from '../utils/timelineJump';
import { SessionWorkspace } from './SessionWorkspace';

const jumpMock = vi.mocked(jumpTimelineToSec);
const scrub = vi.fn();
const scroll = vi.fn();

function renderAt(path: string, sessionId = 'sess-a') {
  const memory = memoryLocation({ path, record: true });
  setNavigationImplForTesting((p, o) => memory.navigate(p, o));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <Router hook={memory.hook}>
        <SessionWorkspace sessionId={sessionId} />
      </Router>
    </QueryClientProvider>,
  );
  return { ...utils, memory };
}

describe('SessionWorkspace applies moment deep links', () => {
  beforeEach(() => {
    feedMounts.count = 0;
    useSessionStatusMock.mockReturnValue({
      data: { is_rolling: false, audio_recording_lease_alive: false, frame_rate: 25 },
    });
    useEventsMock.mockReturnValue({ data: { events: [] } });
    useAudioClipsMock.mockReturnValue({ clips: [], totalSec: 0, segments: [] });
    useWaveformsMock.mockReturnValue({ mergedPeaks: null, isDecoding: false });
    useCompanionPresenceMock.mockReturnValue({ data: null });
    useSessionSocketMock.mockReturnValue(undefined);
    useRecoveryStopWarningMock.mockReturnValue(null);
    useRemoteRecordingGateMock.mockReturnValue(false);
    useDebugTransportOverrideMock.mockReturnValue(null);
    register('setManualScrubSec', scrub);
    register('scrollTimelineToSec', scroll);
  });

  afterEach(() => {
    cleanup();
    setNavigationImplForTesting(null);
    vi.clearAllMocks();
  });

  it('?t=754.2 moves the timeline once, without playing, and the address bar drops the parameter', () => {
    const { memory } = renderAt('/sessions/sess-a?t=754.2');
    expect(jumpMock.mock.calls).toEqual([[754.2]]);
    expect(scrub).toHaveBeenCalledWith(754.2);
    expect(memory.history).toEqual(['/sessions/sess-a']);
  });

  it('a rolling session is not moved', () => {
    useSessionStatusMock.mockReturnValue({
      data: { is_rolling: true, audio_recording_lease_alive: false, frame_rate: 25 },
    });
    const { memory } = renderAt('/sessions/sess-a?t=30');
    expect(jumpMock).not.toHaveBeenCalled();
    expect(memory.history).toEqual(['/sessions/sess-a']);
  });

  it('a moment in the session already open applies without a remount', () => {
    const { memory } = renderAt('/sessions/sess-a');
    expect(feedMounts.count).toBe(1);
    expect(jumpMock).not.toHaveBeenCalled();

    act(() => memory.navigate('/sessions/sess-a?t=30'));
    expect(jumpMock.mock.calls).toEqual([[30]]);
    expect(memory.history).toEqual(['/sessions/sess-a', '/sessions/sess-a']);
    expect(feedMounts.count).toBe(1);
  });
});
