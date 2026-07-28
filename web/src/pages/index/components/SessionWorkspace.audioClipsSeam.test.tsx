import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../../../api/client';
import type {
  AudioSegment,
  AudioSegmentsResponse,
  EventsResponse,
  LogEvent,
  SessionStatus,
  TranscriptWord,
} from '../../../api/types';
import { renderStrict } from '../../../test/renderStrict';
import { SessionWorkspace } from './SessionWorkspace';

// --- IMPORTANT-1 fix (feed-row-seek fix wave 2): the C1 fix's structural
// guarantee — that `SessionWorkspace` publishes ONE `useAudioClips` layout
// through `AudioClipsContext` for every feed's jump coverage check to read —
// had NO test exercising the real seam. `feedRowSeek.clipLayoutParity.test.tsx`
// proves the coverage LOGIC is correct, but does so against a hand-written
// `TestWorkspace` mirror, not `SessionWorkspace` itself; `SessionWorkspace.
// test.tsx` mocks `useAudioClips` to `{ clips: [] }` and stubs `TranscribeFeed`
// out entirely. A re-review confirmed that mutating `SessionWorkspace`'s
// `<AudioClipsProvider clips={[]}>` to a hard-coded empty array —
// dropping the provider's real value, or moving/misfeeding it — left the
// entire web suite green: the failure mode is SAFE (no clips ⇒ nothing plays)
// but D1's jump-and-play feature would die silently.
//
// This file renders the REAL `SessionWorkspace` (not a mirror), with the
// REAL `AudioClipsProvider` → `useAudioClips` → `AudioClipsContext` →
// `useTimelineSeek` → `TranscribeFeed` chain unmocked, and asserts a covered
// row's jump control ends up calling the real
// `window.AutoLogger_seekAudioAndPlay` global with the resolved second.
// Everything ELSE (AudioRecorder, Timeline, MarkerNav, TransportControls,
// CategoryButtonStrip, EventLogSheet, TopicsFeed, AiPanel, AiV2Panel, the
// socket/companion/waveform/gate hooks) is mocked away — irrelevant to this
// seam and would otherwise need its own fixture plumbing.

vi.mock('../../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/client')>();
  return { ...actual, apiFetch: vi.fn() };
});

// `resolvePlayPosition` (real) is imported by the real `useTimelineSeek` from
// this same module — only the `AudioPlayer` component itself is stubbed, so
// the coverage check under test keeps using the actual implementation.
vi.mock('./AudioPlayer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./AudioPlayer')>();
  return { ...actual, AudioPlayer: () => null };
});

vi.mock('../../../api/hooks/useCompanionPresence', () => ({
  useCompanionPresence: () => {},
}));
vi.mock('../../../api/hooks/useSessionSocket', () => ({
  useSessionSocket: () => {},
}));
vi.mock('../../../shared/components/Toast', () => ({
  showToast: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('../../../shared/hooks/useDebugTransportOverride', () => ({
  useDebugTransportOverride: () => null,
}));
vi.mock('../../../shared/ui/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../../../shared/utils/loadingVideo', () => ({
  AUTOLOGGER_LOADING_VIDEO_SRC: '',
}));
vi.mock('../hooks/useRecoveryStopWarning', () => ({
  useRecoveryStopWarning: () => null,
}));
vi.mock('../hooks/useRemoteRecordingGate', () => ({
  useRemoteRecordingGate: () => false,
}));
vi.mock('../hooks/useWaveforms', () => ({
  useWaveforms: () => ({ mergedPeaks: null, isDecoding: false }),
}));

vi.mock('./AudioRecorder', () => ({ AudioRecorder: () => null }));
vi.mock('./AudioSaveOverlay', () => ({ AudioSaveOverlay: () => null }));
vi.mock('./CategoryButtonStrip', () => ({ CategoryButtonStrip: () => null }));
vi.mock('./EventLogSheet', () => ({
  EventLogSheet: () => <div data-testid="event-log-sheet-stub" />,
}));
vi.mock('./ExportModal', () => ({ ExportModal: () => null }));
vi.mock('./MarkerNav', () => ({ MarkerNav: () => null }));
vi.mock('./TimecodeDisplay', () => ({ TimecodeDisplay: () => null }));
vi.mock('./Timeline', () => ({ Timeline: () => null }));
vi.mock('./TopicsFeed', () => ({
  TopicsFeed: () => <div data-testid="topics-feed-stub" />,
}));
vi.mock('./TransportControls', () => ({
  getTransportState: () => 'stop',
  TransportControls: () => null,
}));
vi.mock('./AiPanel', () => ({
  AiPanel: () => <div data-testid="ai-chat-panel-stub" />,
}));
vi.mock('./AiV2Panel', () => ({
  AiV2Panel: () => <div data-testid="aiv2-panel-stub" />,
}));

// jsdom has no layout engine, so `TranscribeFeed`'s real virtualizer measures a
// zero-height scroll viewport and computes an empty visible range — bypassed
// the same way `feedRowSeek.clipLayoutParity.test.tsx` does.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: () => number }) => {
    const size = estimateSize();
    return {
      getVirtualItems: () =>
        Array.from({ length: count }, (_, index) => ({
          index,
          start: index * size,
          end: (index + 1) * size,
          key: index,
        })),
      getTotalSize: () => count * size,
    };
  },
}));

const mockedApiFetch = vi.mocked(apiFetch);
const SESSION_ID = 'sess-audio-clips-seam-1';

function wallAt(offsetSec: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, offsetSec)).toISOString();
}

function ev(overrides: Partial<LogEvent>): LogEvent {
  return {
    event_id: `ev-${Math.random()}`,
    session_id: SESSION_ID,
    category: 'general',
    category_label: 'General',
    category_color: '#4488ff',
    message: '',
    timecode: '00:00:00:00',
    timecode_hms: '00:00:00',
    timecode_total_frames: 0,
    frame_rate: 24,
    wall_time_utc: wallAt(0),
    metadata: {},
    ...overrides,
  };
}

// One recording covering timeline seconds [5, 65) — a single Recording 1
// Started/Stopped pair is all `rebuildAudioClips` needs to build the interval.
const EVENTS: LogEvent[] = [
  ev({
    event_id: 'rec1-start',
    category: 'internal',
    message: 'Recording 1 Started',
    wall_time_utc: wallAt(5),
    timecode_total_frames: 5 * 24,
  }),
  ev({
    event_id: 'rec1-stop',
    category: 'internal',
    message: 'Recording 1 Stopped',
    wall_time_utc: wallAt(65),
    timecode_total_frames: 65 * 24,
  }),
];

const SEGMENTS: AudioSegment[] = [
  {
    id: 'seg-a',
    session_id: SESSION_ID,
    ordinal: 0,
    recording_ordinal: 1,
    started_at_utc: wallAt(5),
    ended_at_utc: null,
    duration_sec: 60,
    file_path: '/tmp/a',
    mime_type: 'audio/webm',
    url: 'blob:seg-a',
    waveform_peaks: null,
    waveform_db_floor: null,
  },
];

// Resolves (design D4/D3) to timeline second 30 — inside the recording's real
// [5, 65) span, so `isCoveredByPlayableClip` must report it covered.
const COVERED_WORD: TranscriptWord = {
  id: 'w-covered',
  session_id: SESSION_ID,
  session_time: '00:00:30:00',
  speaker: '0',
  word: 'hello',
  start_sec: 0,
  end_sec: 0,
  ordinal: 0,
  created_at_utc: '2026-01-01T00:00:00Z',
};

function statusFixture(): SessionStatus {
  return {
    is_rolling: false,
    timecode: '00:02:00:00',
    session_timecode: '00:02:00:00',
    master_timecode: '00:02:00:00',
    timecode_total_frames: 120 * 24,
    frame_rate: 24,
    start_offset_frames: 0,
    current_take: 0,
    audio_recording_lease_alive: false,
    audio_recording_lease_holder_id: null,
    event_count: EVENTS.length,
    logged_event_count: EVENTS.length,
    audio_segment_count: 1,
    title: 'Audio-clips seam test session',
    deck_title: '',
    show_name: null,
    show_code: null,
    episode: '',
    session_created_at_utc: null,
    now_utc: wallAt(120),
    notes: '',
    show_id: null,
    events_stream_revision: 1,
  };
}

function mockApi() {
  mockedApiFetch.mockImplementation(async (path: string) => {
    if (path === 'transcript-generation/status') return { in_flight: false };
    if (path.includes('/status')) return statusFixture();
    if (path.includes('/audio/segments')) {
      return { segments: SEGMENTS, has_audio: true } satisfies AudioSegmentsResponse;
    }
    if (path.includes('/transcript-words')) return { words: [COVERED_WORD] };
    if (path.includes('/events')) {
      return {
        events: EVENTS,
        total: EVENTS.length,
        logged_event_count: EVENTS.length,
        offset: 0,
        limit: 2000,
      } satisfies EventsResponse;
    }
    throw new Error(`unexpected apiFetch call: ${path}`);
  });
}

beforeEach(() => {
  mockedApiFetch.mockReset();
  vi.clearAllMocks();
  mockApi();
  // `useAudioClips`'s disk-sync effect uses raw `fetch`, not `apiFetch` — stub
  // it so the POST doesn't hit a real network call in jsdom.
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) } as Response),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderWorkspace() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderStrict(
    <QueryClientProvider client={client}>
      <SessionWorkspace sessionId={SESSION_ID} />
    </QueryClientProvider>,
  );
}

describe('SessionWorkspace real audio-clips seam (feed-row-seek fix wave 2, IMPORTANT-1)', () => {
  it('a covered Transcript row jump calls window.AutoLogger_seekAudioAndPlay with the resolved second', async () => {
    renderWorkspace();

    // `SessionWorkspace`'s own effect assigns the real
    // `window.AutoLogger_seekAudioAndPlay` wrapper on mount; replace it AFTER
    // mount with a spy so we can observe `useTimelineSeek`'s call to it
    // without needing a real `AudioPlayer` ref target.
    const seekAndPlay = vi.fn();
    window.AutoLogger_seekAudioAndPlay = seekAndPlay;

    fireEvent.click(screen.getByRole('tab', { name: 'Transcript' }));

    const jumpBtn = await screen.findByRole('button', { name: /Jump to/ });
    fireEvent.click(jumpBtn);

    expect(seekAndPlay).toHaveBeenCalledWith(30);
  });
});
