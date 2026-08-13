import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- Phase 2 fix wave (web-coordination-seam): the reviewer demonstrated
// that mutating two of SessionWorkspace's own owning effects left the whole
// 934-test suite green:
//
//   1. `seekAudio`'s cleanup passing a FRESH closure to `unregister` instead
//      of the registered reference (identity-scoped teardown silently fails).
//   2. `stopTransportIfNeeded`'s ineligible branch calling
//      `register('stopTransportIfNeeded', () => {})` instead of `unregister`
//      (the handle ends up "registered to a no-op" instead of genuinely
//      unowned).
//
// `registry.test.ts` pins both properties generically against synthetic
// ownerA/ownerB closures, but nothing exercised SessionWorkspace's REAL
// effects doing the registering. These tests do, asserting only through the
// registry's own `isRegistered` API (spec: "Ownership state is observable" —
// unowned vs. registered-to-a-no-op must be distinguishable), matching
// "Teardown removes the handler", "An ineligible owner leaves the handle
// unowned", and "Eligibility regained re-registers".
//
// Mock roster mirrors `SessionWorkspace.maximizeLog.test.tsx` (the existing
// controllable-hook pattern for this component) rather than
// `SessionWorkspace.test.tsx`'s fixed-value mocks, since these tests need to
// drive `isRolling`/`blocksMedia`/`sessionId` through multiple states across
// a single mount via `rerender`.

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
vi.mock('./EventLogSheet', () => ({
  EventLogSheet: () => <div data-testid="event-log-sheet-stub" />,
}));
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

import { isRegistered } from '../coordination/registry';
import { SessionWorkspace } from './SessionWorkspace';

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

function renderWorkspace(sessionId = 'sess-a') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <SessionWorkspace sessionId={sessionId} />
    </QueryClientProvider>,
  );
  return {
    ...utils,
    rerenderWith: (nextSessionId: string) => {
      utils.rerender(
        <QueryClientProvider client={qc}>
          <SessionWorkspace sessionId={nextSessionId} />
        </QueryClientProvider>,
      );
    },
  };
}

describe('SessionWorkspace owning effects release their coordination handles (phase 2 fix wave)', () => {
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

  // Finding 1 (IMPORTANT): the `seekAudio` effect's cleanup must unregister
  // the SAME handler reference it registered — `unregister` is identity-
  // scoped (`registry.ts`: `if (handlers[handle] === handler)`), so a
  // cleanup that hands it a fresh closure silently fails to release the
  // handle. Spec "Teardown removes the handler": "an owning component
  // unmounts ... THEN the handle has no registered handler afterwards".
  it('unmounting releases the seekAudio handle', () => {
    const { unmount } = renderWorkspace();
    expect(isRegistered('seekAudio')).toBe(true);

    unmount();

    expect(isRegistered('seekAudio')).toBe(false);
  });

  // Finding 2 (IMPORTANT): the `stopTransportIfNeeded` effect's ineligible
  // branch (`!sessionId || blocksMedia || !isRolling`) must leave the handle
  // genuinely UNOWNED, not registered to a no-op — spec "An ineligible owner
  // leaves the handle unowned" requires `isRegistered` to report false, which
  // "registered to a handler that does nothing" would not satisfy (spec
  // "Unowned and registered-to-a-no-op are distinguishable"). Drives all
  // three ineligibility inputs — isRolling, blocksMedia, sessionId — each
  // through an eligible -> ineligible -> eligible round trip.
  it('registers stopTransportIfNeeded while eligible and is genuinely unowned (not a no-op) while ineligible', () => {
    rollingStatus();
    const { rerenderWith } = renderWorkspace('sess-a');
    expect(isRegistered('stopTransportIfNeeded')).toBe(true);

    // isRolling: true -> false
    idleStatus();
    act(() => rerenderWith('sess-a'));
    expect(isRegistered('stopTransportIfNeeded')).toBe(false);

    rollingStatus();
    act(() => rerenderWith('sess-a'));
    expect(isRegistered('stopTransportIfNeeded')).toBe(true);

    // blocksMedia: false -> true
    useRemoteRecordingGateMock.mockReturnValue(true);
    act(() => rerenderWith('sess-a'));
    expect(isRegistered('stopTransportIfNeeded')).toBe(false);

    useRemoteRecordingGateMock.mockReturnValue(false);
    act(() => rerenderWith('sess-a'));
    expect(isRegistered('stopTransportIfNeeded')).toBe(true);

    // sessionId: truthy -> empty
    act(() => rerenderWith(''));
    expect(isRegistered('stopTransportIfNeeded')).toBe(false);

    act(() => rerenderWith('sess-a'));
    expect(isRegistered('stopTransportIfNeeded')).toBe(true);
  });

  // --- web-coordination-seam task 5.2 (spec "Enforcement checks are proven
  // non-vacuous": "A negative runtime assertion ... SHALL be made in a
  // context where that handle's owning component actually mounts. An
  // assertion placed where the owner is module-mocked passes identically
  // before and after the change and enforces nothing.") ---
  //
  // `SessionWorkspace` is rendered here for real — `renderWorkspace` above
  // mounts the actual imported `SessionWorkspace`, not a stub — unlike
  // `AppShell.test.tsx`, which module-mocks `SessionRoute` and
  // `HomeSettingsModal` so those components' owning effects never run there.
  // `SessionWorkspace` owns four handles (seekAudio, seekAudioAndPlay,
  // stopTransportIfNeeded, invalidateEvents); this is where a regression
  // that reintroduced a `window.AutoLogger_*` write inside any of its four
  // registration effects would actually be observable.
  it('defines none of seekAudio / seekAudioAndPlay / stopTransportIfNeeded / invalidateEvents on window after mount', () => {
    rollingStatus();
    renderWorkspace();

    expect('AutoLogger_seekAudio' in window).toBe(false);
    expect('AutoLogger_seekAudioAndPlay' in window).toBe(false);
    expect('AutoLogger_stopTransportIfNeeded' in window).toBe(false);
    expect('AutoLogger_invalidateEvents' in window).toBe(false);
  });
});
