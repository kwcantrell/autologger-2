import { describe, expect, it, vi } from 'vitest';
import { renderStrict } from '../../../test/renderStrict';
import { SessionWorkspace } from './SessionWorkspace';

// --- SessionWorkspace visibility-swap tests (session-deep-links, task 3.3;
// spec: web-session-routing "Legacy selection spine retired" — "Workspace
// visibility swap survives the removal") ---
//
// The placeholder ↔ grid swap used to be imperative classList toggling in
// AppShell's syncChrome(); it is now render-driven off the sessionId prop
// (design D9). These tests pin the two observable halves the e2e suite
// asserts on (`#v3-session-placeholder` / `#v3-session-grid`), with every
// data/socket/audio hook and heavy child mocked at the module boundary —
// this is a rendering test, not an integration test.

vi.mock('../../../api/client', () => ({
  apiFetch: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../../api/hooks/useCompanionPresence', () => ({
  useCompanionPresence: () => {},
}));

vi.mock('../../../api/hooks/useEvents', () => ({
  eventsKeys: { all: (sessionId: string) => ['events', sessionId] },
  useEvents: () => ({ data: undefined }),
}));

vi.mock('../../../api/hooks/useSessionSocket', () => ({
  useSessionSocket: () => {},
}));

vi.mock('../../../api/hooks/useSessionStatus', () => ({
  useSessionStatus: () => ({ data: undefined }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock('../../../shared/components/Toast', () => ({
  showToast: vi.fn(),
}));

vi.mock('../../../shared/hooks/useDebugTransportOverride', () => ({
  useDebugTransportOverride: () => null,
}));

vi.mock('../../../shared/ui/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../../../shared/utils/loadingVideo', () => ({
  AUTOLOGGER_LOADING_VIDEO_SRC: '',
}));

vi.mock('../hooks/useAudioClips', () => ({
  useAudioClips: () => ({ clips: [], totalSec: 0, segments: [] }),
}));

vi.mock('../hooks/useRecoveryStopWarning', () => ({
  useRecoveryStopWarning: () => {},
}));

vi.mock('../hooks/useRemoteRecordingGate', () => ({
  useRemoteRecordingGate: () => false,
}));

vi.mock('../hooks/useWaveforms', () => ({
  useWaveforms: () => ({ mergedPeaks: null, isDecoding: false }),
}));

vi.mock('./AudioPlayer', () => ({ AudioPlayer: () => null }));
vi.mock('./AudioRecorder', () => ({ AudioRecorder: () => null }));
vi.mock('./AudioSaveOverlay', () => ({ AudioSaveOverlay: () => null }));
vi.mock('./CategoryButtonStrip', () => ({ CategoryButtonStrip: () => null }));
vi.mock('./EventLogSheet', () => ({ EventLogSheet: () => null }));
vi.mock('./ExportModal', () => ({ ExportModal: () => null }));
vi.mock('./MarkerNav', () => ({ MarkerNav: () => null }));
vi.mock('./TimecodeDisplay', () => ({ TimecodeDisplay: () => null }));
vi.mock('./Timeline', () => ({ Timeline: () => null }));
vi.mock('./TopicsFeed', () => ({ TopicsFeed: () => null }));
vi.mock('./TranscribeFeed', () => ({ TranscribeFeed: () => null }));
vi.mock('./TransportControls', () => ({
  getTransportState: () => 'stop',
  TransportControls: () => null,
}));

function regions(container: HTMLElement) {
  const placeholder = container.querySelector('#v3-session-placeholder');
  const grid = container.querySelector('#v3-session-grid');
  expect(placeholder).not.toBeNull();
  expect(grid).not.toBeNull();
  return { placeholder: placeholder as HTMLElement, grid: grid as HTMLElement };
}

describe('SessionWorkspace visibility swap', () => {
  it('shows the placeholder and hides the grid when no session is active', () => {
    const { container } = renderStrict(<SessionWorkspace sessionId="" />);
    const { placeholder, grid } = regions(container);

    expect(placeholder.classList.contains('hidden')).toBe(false);
    expect(grid.classList.contains('hidden')).toBe(true);
  });

  it('reveals the grid and hides the placeholder when a session is active', () => {
    const { container } = renderStrict(<SessionWorkspace sessionId="sess-1" />);
    const { placeholder, grid } = regions(container);

    expect(placeholder.classList.contains('hidden')).toBe(true);
    expect(grid.classList.contains('hidden')).toBe(false);
  });

  it('swaps back when the session id prop is cleared (close path)', () => {
    const { container, rerender } = renderStrict(<SessionWorkspace sessionId="sess-1" />);
    rerender(<SessionWorkspace sessionId="" />);
    const { placeholder, grid } = regions(container);

    expect(placeholder.classList.contains('hidden')).toBe(false);
    expect(grid.classList.contains('hidden')).toBe(true);
  });
});
