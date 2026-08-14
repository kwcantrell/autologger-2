import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../../../api/client';
import { useEvents } from '../../../api/hooks/useEvents';
import type {
  AudioSegment,
  AudioSegmentsResponse,
  EventsResponse,
  LogEvent,
  SessionStatus,
  TranscriptWord,
} from '../../../api/types';
import { renderStrict } from '../../../test/renderStrict';
import { register } from '../coordination/registry';
import { AudioClipsProvider } from '../hooks/AudioClipsContext';
import { useAudioClips } from '../hooks/useAudioClips';
import { TranscribeFeed } from './TranscribeFeed';

// --- C1 regression: the feed jump's coverage check must read the SAME clip
// layout the player does (whole-branch audit fix wave, finding C1) ---
//
// Before the fix, `useTimelineSeek` called `useAudioClips(sessionId, events)`
// with the CALLING FEED's own (differently-limited) events query, while
// `SessionWorkspace` → `AudioPlayer` built its clip layout from a SEPARATE
// `useEvents(sessionId, { limit: 2000 })`. Events are served `ORDER BY
// wall_time_utc ASC`, so a feed's default 200-row page truncates the TAIL —
// and `rebuildAudioClips` pairs each audio segment to its `Recording N
// Started/Stopped` event; a segment whose pairing event falls outside a
// truncated window gets chained at a FABRICATED position. A gate-intent
// repro against `rebuildAudioClips` directly (pre-fix) confirmed the
// disagreement concretely: with a second recording's pairing events pushed
// past the 200-row cutoff, the FULL (2000-limit) layout placed that
// recording's clip at its real position and reported second 100 as an
// uncovered gap, while the TRUNCATED (200-limit) layout chained the same
// segment right after the first clip and reported that same second 100 as
// "covered" — exactly the "genuine inter-recording gap reported as covered"
// hazard this fix eliminates.
//
// This test does NOT mock `useAudioClips` — `TestWorkspace` below mirrors
// `SessionWorkspace`'s real wiring (one `useEvents({ limit: 2000 })` → one
// `useAudioClips` → `AudioClipsProvider`), and the mocked `apiFetch` genuinely
// respects the `limit` query param, so a >200-event session list is fetched
// in full for this ONE call. Because `useTimelineSeek` now reads that
// context instead of building its own layout, `TranscribeFeed`'s row-jump
// coverage check is structurally the SAME computation the player used —
// there is no second, differently-limited `events` query left anywhere in
// the render tree for it to diverge from.

vi.mock('../../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/client')>();
  return { ...actual, apiFetch: vi.fn() };
});

// jsdom has no layout engine, so `TranscribeFeed`'s real virtualizer measures
// a zero-height scroll viewport and computes an empty visible range (mirrors
// `feedRowSeek.transition.test.tsx`) — bypassed here since virtualization
// itself isn't what this test drives.
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
const SESSION_ID = 'sess-clip-parity-1';

function wallAt(offsetSec: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, offsetSec)).toISOString();
}

function ev(overrides: Partial<LogEvent>): LogEvent {
  return {
    event_id: `ev-${Math.random()}`,
    category: 'general',
    category_label: 'General',
    category_color: '#4488ff',
    message: '',
    timecode: '00:00:00:00',
    timecode_total_frames: 0,
    frame_rate: 24,
    wall_time_utc: wallAt(0),
    metadata: {},
    ...overrides,
  };
}

/**
 * 202 events, `wall_time_utc` strictly ascending (matches the server's
 * `ORDER BY wall_time_utc ASC`). The FIRST recording's Started/Stopped pair
 * sits early (positions 10/11, well inside any 200-row page); the SECOND
 * recording's pair sits at positions 200/201 — the first two rows a 200-row
 * page (`slice(0, 200)`, indices 0..199) would drop.
 */
function buildEvents(): LogEvent[] {
  const events: LogEvent[] = [];
  for (let i = 0; i < 10; i++) {
    events.push(
      ev({ event_id: `filler-${i}`, wall_time_utc: wallAt(i), timecode_total_frames: i * 24 }),
    );
  }
  events.push(
    ev({
      event_id: 'rec1-start',
      category: 'internal',
      message: 'Recording 1 Started',
      wall_time_utc: wallAt(10),
      timecode_total_frames: 10 * 24,
    }),
  );
  events.push(
    ev({
      event_id: 'rec1-stop',
      category: 'internal',
      message: 'Recording 1 Stopped',
      wall_time_utc: wallAt(60),
      timecode_total_frames: 60 * 24,
    }),
  );
  for (let i = 12; i < 200; i++) {
    const offset = 61 + (i - 12);
    events.push(
      ev({
        event_id: `filler-${i}`,
        wall_time_utc: wallAt(offset),
        timecode_total_frames: offset * 24,
      }),
    );
  }
  events.push(
    ev({
      event_id: 'rec2-start',
      category: 'internal',
      message: 'Recording 2 Started',
      wall_time_utc: wallAt(3600),
      timecode_total_frames: 3600 * 24,
    }),
  );
  events.push(
    ev({
      event_id: 'rec2-stop',
      category: 'internal',
      message: 'Recording 2 Stopped',
      wall_time_utc: wallAt(3700),
      timecode_total_frames: 3700 * 24,
    }),
  );
  return events;
}

const SEGMENTS: AudioSegment[] = [
  {
    id: 'seg-a',
    ordinal: 0,
    recording_ordinal: 1,
    started_at_utc: wallAt(10),
    ended_at_utc: null,
    mime_type: 'audio/webm',
    url: 'blob:seg-a',
    waveform_peaks: null,
    waveform_db_floor: null,
  },
  {
    id: 'seg-b',
    ordinal: 1,
    recording_ordinal: 2,
    started_at_utc: wallAt(3600),
    ended_at_utc: null,
    mime_type: 'audio/webm',
    url: 'blob:seg-b',
    waveform_peaks: null,
    waveform_db_floor: null,
  },
];

function statusFixture(): SessionStatus {
  return {
    is_rolling: false,
    timecode: '01:02:00:00',
    session_timecode: '01:02:00:00',
    master_timecode: '01:02:00:00',
    frame_rate: 24,
    current_take: 0,
    audio_recording_lease_alive: false,
    audio_recording_lease_holder_id: null,
    event_count: 202,
    logged_event_count: 202,
    title: 'Clip layout parity test session',
    deck_title: '',
    show_name: null,
    show_code: null,
    episode: '',
    session_created_at_utc: null,
    now_utc: wallAt(3720),
    notes: '',
    show_id: null,
    events_stream_revision: 1,
  };
}

function wordFixture(overrides: Partial<TranscriptWord> = {}): TranscriptWord {
  return {
    id: 'w-1',
    session_time: '00:00:10:00',
    speaker: '0',
    word: 'hello',
    start_sec: 0,
    end_sec: 0,
    ordinal: 0,
    ...overrides,
  };
}

function mockApi(events: LogEvent[], words: TranscriptWord[]) {
  mockedApiFetch.mockImplementation(async (path: string) => {
    if (path === 'transcript-generation/status') return { in_flight: false };
    if (path.includes('/status')) return statusFixture();
    if (path.includes('/audio/segments')) {
      return { segments: SEGMENTS, has_audio: true } satisfies AudioSegmentsResponse;
    }
    if (path.includes('/transcript-words')) return { words };
    if (path.includes('/events')) {
      const m = /limit=(\d+)/.exec(path);
      const limit = m ? Number(m[1]) : 200;
      const page = events.slice(0, limit);
      return {
        events: page,
        total: events.length,
        logged_event_count: events.length,
        offset: 0,
        limit,
        has_auto_generated: false,
      } satisfies EventsResponse;
    }
    throw new Error(`unexpected apiFetch call: ${path}`);
  });
}

let scrubMock: ReturnType<typeof vi.fn<(sec: number | null) => void>>;
let seekAndPlayMock: ReturnType<typeof vi.fn<(sec: number) => void>>;

beforeEach(() => {
  mockedApiFetch.mockReset();
  vi.clearAllMocks();
  scrubMock = vi.fn();
  seekAndPlayMock = vi.fn();
  register('setManualScrubSec', scrubMock);
  register('scrollTimelineToSec', vi.fn());
  register('seekAudio', vi.fn());
  register('seekAudioAndPlay', seekAndPlayMock);
  // `useAudioClips`'s disk-sync effect uses raw `fetch`, not `apiFetch` — stub
  // it so that POST doesn't hit a real network call in jsdom.
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) } as Response),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Mirrors `SessionWorkspace`'s real wiring: ONE wide `useEvents({ limit: 2000
 *  })` feeds ONE `useAudioClips` call, published via `AudioClipsProvider` —
 *  the exact structural fix `useTimelineSeek` now depends on. */
function TestWorkspace({ sessionId }: { sessionId: string }) {
  const { data: eventsRes } = useEvents(sessionId, { limit: 2000 });
  const events = eventsRes?.events ?? [];
  const { clips } = useAudioClips(sessionId, events);
  return (
    <AudioClipsProvider clips={clips}>
      <TranscribeFeed sessionId={sessionId} />
    </AudioClipsProvider>
  );
}

function renderWorkspace() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderStrict(
    <QueryClientProvider client={client}>
      <TestWorkspace sessionId={SESSION_ID} />
    </QueryClientProvider>,
  );
}

describe('feed jump coverage matches the player layout across a >200-event session (finding C1)', () => {
  it('a row resolving into a genuine inter-recording gap is NOT reported covered', async () => {
    // second=100 sits between the first recording's real end (60) and the
    // second recording's real start (3600) — a genuine gap in the FULL
    // layout. A feed still building its OWN layout from a 200-row page would
    // have fabricated the second segment right after the first (chained at
    // [60, 160)), making this same second look "covered".
    mockApi(buildEvents(), [wordFixture({ id: 'w-gap', session_time: '00:01:40:00' })]);
    renderWorkspace();

    const btn = await screen.findByRole('button', { name: /Jump to/ });
    fireEvent.click(btn);

    expect(scrubMock).toHaveBeenCalledWith(100);
    expect(seekAndPlayMock).not.toHaveBeenCalled();
  });

  it('a row resolving inside the SECOND recording (whose pairing events sit beyond a 200-row page) IS reported covered', async () => {
    // second=3650 is inside the second recording's REAL span [3600, 3700) —
    // only resolvable as "covered" by a layout built from the FULL event
    // list, since the pairing events proving that span exist at positions
    // 200/201.
    mockApi(buildEvents(), [wordFixture({ id: 'w-real', session_time: '01:00:50:00' })]);
    renderWorkspace();

    const btn = await screen.findByRole('button', { name: /Jump to/ });
    fireEvent.click(btn);

    expect(seekAndPlayMock).toHaveBeenCalledWith(3650);
  });
});
