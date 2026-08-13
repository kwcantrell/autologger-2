import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('../../../api/client', () => ({ apiFetch: vi.fn() }));
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
vi.mock('./AudioPlayer', () => ({
  AudioPlayer: () => null,
}));
vi.mock('./AudioRecorder', () => ({
  AudioRecorder: () => null,
}));
vi.mock('./AudioSaveOverlay', () => ({ AudioSaveOverlay: () => null }));
vi.mock('./ChunkRescueBanner', () => ({ ChunkRescueBanner: () => null }));
vi.mock('./CategoryButtonStrip', () => ({
  CategoryButtonStrip: () => <div data-testid="category-strip-stub" />,
}));
vi.mock('./EventLogSheet', () => ({
  EventLogSheet: () => <div data-testid="event-log-sheet-stub" />,
}));
vi.mock('./ExportFeed', () => ({ ExportFeed: () => null }));
vi.mock('./MarkerNav', () => ({ MarkerNav: () => null }));
vi.mock('./TimecodeDisplay', () => ({
  TimecodeDisplay: () => <div data-testid="timecode-display-stub" />,
}));
vi.mock('./Timeline', () => ({
  Timeline: ({
    stripOnly,
    stripTrailing,
    stripLaneSlot,
  }: {
    stripOnly?: boolean;
    stripTrailing?: import('react').ReactNode;
    stripLaneSlot?: import('react').ReactNode;
  }) => (
    <div data-testid={stripOnly ? 'timeline-strip-stub' : 'timeline-full-stub'}>
      {stripLaneSlot ? <div data-testid="strip-lane-slot">{stripLaneSlot}</div> : null}
      {stripOnly ? stripTrailing : null}
    </div>
  ),
}));
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

import { SessionWorkspace } from './SessionWorkspace';

function renderWorkspace(sessionId = 'sess-a', ytImportPending = false) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SessionWorkspace sessionId={sessionId} ytImportPending={ytImportPending} />
    </QueryClientProvider>,
  );
}

function idleStatus() {
  useSessionStatusMock.mockReturnValue({
    data: { is_rolling: false, audio_recording_lease_alive: false },
  });
}

function rollingStatus() {
  useSessionStatusMock.mockReturnValue({
    data: { is_rolling: true, audio_recording_lease_alive: false },
  });
}

function recordingStatus() {
  useSessionStatusMock.mockReturnValue({
    data: { is_rolling: true, audio_recording_lease_alive: true },
  });
}

describe('SessionWorkspace fused strip layout', () => {
  beforeEach(() => {
    idleStatus();
    useEventsMock.mockReturnValue({ data: { events: [] } });
    useAudioClipsMock.mockReturnValue({ clips: [], totalSec: 0, segments: [] });
    useWaveformsMock.mockReturnValue({ mergedPeaks: null, isDecoding: false });
    useCompanionPresenceMock.mockReturnValue({ data: null });
    useSessionSocketMock.mockReturnValue(undefined);
    useRecoveryStopWarningMock.mockReturnValue({ open: false, confirm: vi.fn(), cancel: vi.fn() });
    useRemoteRecordingGateMock.mockReturnValue(false);
    useDebugTransportOverrideMock.mockReturnValue(null);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('always shows the fused strip (no twin panels)', () => {
    renderWorkspace();
    expect(document.getElementById('v5-maximize-log-strip')).toBeTruthy();
    expect(document.querySelector('.v5-session-panels')).toBeNull();
    expect(screen.getByTestId('timeline-strip-stub')).toBeTruthy();
    expect(screen.getByTestId('transport-controls-stub')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^(Maximize log|Default view)$/ })).toBeNull();
  });

  it('places mobile nav beside session controls when onOpenMobileNav is provided', () => {
    const onOpenMobileNav = vi.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <SessionWorkspace sessionId="sess-a" onOpenMobileNav={onOpenMobileNav} />
      </QueryClientProvider>,
    );
    const btn = screen.getByRole('button', { name: 'Open navigation' });
    expect(btn.className).toContain('md:hidden');
    fireEvent.click(btn);
    expect(onOpenMobileNav).toHaveBeenCalledTimes(1);
  });

  it('shows Status above timecode in the strip', () => {
    renderWorkspace();
    expect(document.getElementById('v5-controls-recording-head')).toBeTruthy();
    expect(document.getElementById('v5-controls-status-value')?.textContent).toBe('Stopped');
  });

  it('shows YouTube import in Status when pending', () => {
    renderWorkspace('sess-a', true);
    expect(document.getElementById('v5-controls-status-value')?.textContent).toBe(
      'Importing YouTube Audio',
    );
  });

  it('swaps timeline lane for category buttons while rolling', () => {
    rollingStatus();
    renderWorkspace();
    expect(document.getElementById('v5-maximize-log-strip')).toBeTruthy();
    expect(screen.getByTestId('strip-lane-slot')).toBeTruthy();
    expect(screen.getByTestId('category-strip-stub')).toBeTruthy();
    expect(document.getElementById('v5-controls-status-value')?.textContent).toBe('Rolling');
    // Mic level meter is local-recording-only (web-session-console spec:
    // "Truthful recording indication") — its CSS reveal keys on
    // `body.v4-is-recording`, which only AudioRecorder (mocked out here)
    // toggles, so merely rolling must not set it.
    expect(document.body.classList.contains('v4-is-recording')).toBe(false);
    // Obsolete live-dock attribute must not be set (it used to CSS-hide the strip).
    expect(document.getElementById('v4-log-session')?.getAttribute('data-v5-live-log')).toBeNull();
  });

  it('keeps strip and shows Recording status while recording', () => {
    recordingStatus();
    renderWorkspace();
    expect(document.getElementById('v5-maximize-log-strip')).toBeTruthy();
    expect(screen.getByTestId('category-strip-stub')).toBeTruthy();
    expect(document.getElementById('v5-controls-status-value')?.textContent).toBe('Recording');
    // Meter/duration elements exist for AudioRecorder to drive, but their CSS
    // reveal keys on `body.v4-is-recording` (this client's recorder), NOT the
    // session-wide lease this fixture sets — a REMOTE client's recording shows
    // "Recording" status while this client's (empty) meter stays hidden
    // (spec "Remote client recording" — the deliberate divergence).
    expect(document.getElementById('top-bar-mic-level')).toBeTruthy();
    expect(document.getElementById('top-bar-mic-level')?.getAttribute('data-show')).toBeNull();
    expect(document.getElementById('top-bar-recording-dur')).toBeTruthy();
    expect(document.body.classList.contains('v4-is-recording')).toBe(false);
  });

  // PR#4 review fix: the retired MicLevelPreview opened getUserMedia for every
  // viewer of a *rolling* session (session-wide state) to feed a meter the
  // web-session-console spec keeps hidden outside local mic recording — an
  // unprompted permission dialog + lit mic-in-use indicator serving nothing
  // visible. The mic may only open through AudioRecorder's own record flow.
  it('never opens the local microphone while the session is merely rolling', () => {
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [] }) as unknown as MediaStream);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });
    try {
      rollingStatus();
      renderWorkspace();
      expect(getUserMedia).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: undefined,
      });
    }
  });

  it('restores scrubber lane when returning to idle', () => {
    rollingStatus();
    const { rerender } = renderWorkspace();
    expect(screen.getByTestId('strip-lane-slot')).toBeTruthy();

    idleStatus();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() => {
      rerender(
        <QueryClientProvider client={qc}>
          <SessionWorkspace sessionId="sess-a" />
        </QueryClientProvider>,
      );
    });
    expect(screen.queryByTestId('strip-lane-slot')).toBeNull();
    expect(document.getElementById('v5-controls-status-value')?.textContent).toBe('Stopped');
  });
});
