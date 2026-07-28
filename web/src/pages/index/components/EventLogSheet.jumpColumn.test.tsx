import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, screen } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../../../api/client';
import type { Category, EventsResponse, LogEvent, SessionStatus } from '../../../api/types';
import { TooltipProvider } from '../../../shared/ui/Tooltip';
import type { AudioClipLite } from '../../../shared/utils/waveformMerge';
import { renderStrict } from '../../../test/renderStrict';
import { AudioClipsProvider } from '../hooks/AudioClipsContext';
import { EventLogSheet, eventRowTimelineSec } from './EventLogSheet';

// --- EventLogSheet jump column wiring (feed-row-seek, task 6.1/6.2) ---
//
// EventLogSheet owns `useTimelineSeek` (design D7) and resolves each event
// row's position from `timecode_total_frames / frame_rate` DIRECTLY (design
// D4) — never via `eventTimelineSec`'s SMPTE-string fallback, which would
// substitute 0 for a missing timecode. These tests render the REAL
// EventLogSheet + real EventLogRows (same pattern as the pre-existing
// EventLogSheet.test.tsx, which must keep passing unchanged) and drive the
// resolution rule, the not-rolling/batch-edit gate, and jump-and-play
// end-to-end through rendered DOM.
//
// `useTimelineSeek` reads its clip layout from `AudioClipsContext` (whole-
// branch audit fix wave, finding C1) — the SAME session-wide layout
// `SessionWorkspace` publishes — rather than calling `useAudioClips` itself,
// so clip coverage here is driven by wrapping `renderSheet()` in an
// `AudioClipsProvider`, not by mocking `useAudioClips`.

vi.mock('../../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/client')>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

const SESSION_ID = 'sess-jump-col-1';

beforeAll(() => {
  if (typeof window.matchMedia === 'function') return;
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

function categoryFixture(): Category {
  return {
    id: 'general',
    label: 'General',
    color: '#4488ff',
    type: 'BUTTON',
    dropdown_options: [],
    on_label: '',
    off_label: '',
  };
}

/** Resolves to exactly 10s: 240 frames / 24fps. */
function resolvableEventFixture(overrides: Partial<LogEvent> = {}): LogEvent {
  return {
    event_id: 'ev-resolvable',
    category: 'general',
    category_label: 'General',
    category_color: '#4488ff',
    message: 'Resolvable row',
    timecode: '00:00:10:00',
    timecode_total_frames: 240,
    frame_rate: 24,
    wall_time_utc: '2026-07-21T00:00:10Z',
    metadata: {},
    ...overrides,
  };
}

/** No frame count at all — design D4: unresolvable, MUST NOT fall back to
 *  parsing `timecode` (that fallback is exactly what `eventTimelineSec` does,
 *  and is exactly what D4 forbids for event rows). */
function positionlessEventFixture(overrides: Partial<LogEvent> = {}): LogEvent {
  return {
    event_id: 'ev-positionless',
    category: 'general',
    category_label: 'General',
    category_color: '#4488ff',
    message: 'Positionless row',
    timecode: '00:00:20:00',
    timecode_total_frames: null,
    frame_rate: null,
    wall_time_utc: '2026-07-21T00:00:20Z',
    metadata: {},
    ...overrides,
  };
}

function statusFixture(overrides: Partial<SessionStatus> = {}): SessionStatus {
  return {
    is_rolling: false,
    timecode: '00:00:30:00',
    session_timecode: '00:00:30:00',
    master_timecode: '00:00:30:00',
    frame_rate: 24,
    current_take: 0,
    audio_recording_lease_alive: false,
    audio_recording_lease_holder_id: null,
    event_count: 1,
    logged_event_count: 1,
    title: 'Jump column test session',
    deck_title: '',
    show_name: null,
    show_code: null,
    episode: '',
    session_created_at_utc: null,
    now_utc: '2026-07-21T00:00:30Z',
    notes: '',
    show_id: null,
    events_stream_revision: 1,
    ...overrides,
  };
}

function eventsFixture(events: LogEvent[]): EventsResponse {
  return {
    events,
    total: events.length,
    logged_event_count: events.length,
    offset: 0,
    limit: 200,
  };
}

const COVERING_CLIP: AudioClipLite = {
  segmentId: 'seg-1',
  url: 'https://example.test/seg-1.wav',
  startSec: 0,
  endSec: 20,
  duration: 20,
  missingAudio: false,
};

function mockApi(status: SessionStatus, events: LogEvent[]) {
  mockedApiFetch.mockImplementation(async (path: string) => {
    if (path.includes('/status')) return status;
    if (path.includes('/show-categories')) {
      return { categories: [categoryFixture()], show_name: '', show_code: '' };
    }
    if (path.includes('/events')) return eventsFixture(events);
    throw new Error(`unexpected apiFetch call: ${path}`);
  });
}

let scrubMock: ReturnType<typeof vi.fn<(sec: number | null) => void>>;
let scrollMock: ReturnType<typeof vi.fn<(sec: number, totalSec?: number) => void>>;
let seekAndPlayMock: ReturnType<typeof vi.fn<(sec: number) => void>>;

beforeEach(() => {
  mockedApiFetch.mockReset();
  vi.clearAllMocks();
  scrubMock = vi.fn();
  scrollMock = vi.fn();
  seekAndPlayMock = vi.fn();
  window.AutoLogger_setManualScrubSec = scrubMock;
  window.AutoLogger_scrollTimelineToSec = scrollMock;
  window.AutoLogger_seekAudio = vi.fn();
  window.AutoLogger_seekAudioAndPlay = seekAndPlayMock;
});

function renderSheet(clips: AudioClipLite[] = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderStrict(
    <QueryClientProvider client={client}>
      <TooltipProvider delayDuration={400}>
        <AudioClipsProvider clips={clips}>
          <EventLogSheet sessionId={SESSION_ID} />
        </AudioClipsProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('EventLogSheet — jump column', () => {
  it('the jump column header is visually hidden but carries an accessible label (FeedTable.ColumnDef.ariaLabel)', async () => {
    mockApi(statusFixture(), [resolvableEventFixture()]);
    renderSheet();

    const header = await screen.findByRole('columnheader', { name: 'Jump to time' });
    expect(header.textContent).toBe('');
  });

  it('resolves an event row from timecode_total_frames / frame_rate directly; a row with no frame count renders no control', async () => {
    mockApi(statusFixture(), [resolvableEventFixture(), positionlessEventFixture()]);
    renderSheet();

    const jumpButtons = await screen.findAllByRole('button', { name: /Jump to/ });
    expect(jumpButtons).toHaveLength(1);
    // The one control present names the resolvable row's timecode, not the
    // positionless row's — confirms it's the resolvable row that got it.
    expect(jumpButtons[0].getAttribute('aria-label')).toBe('Jump to 00:00:10');
  });

  it('jump controls are aria-disabled and share one reason node while rolling', async () => {
    mockApi(statusFixture({ is_rolling: true }), [
      resolvableEventFixture({ event_id: 'ev-a' }),
      resolvableEventFixture({
        event_id: 'ev-b',
        timecode: '00:00:11:00',
        timecode_total_frames: 264,
      }),
    ]);
    renderSheet();

    const jumpButtons = await screen.findAllByRole('button', { name: /Jump to/ });
    expect(jumpButtons).toHaveLength(2);
    const reasonIds = new Set(jumpButtons.map((b) => b.getAttribute('aria-describedby')));
    expect(reasonIds.size).toBe(1);
    expect([...reasonIds][0]).toBeTruthy();
    for (const b of jumpButtons) {
      expect(b.getAttribute('aria-disabled')).toBe('true');
    }
  });

  it('jump controls are unavailable in batch-edit mode', async () => {
    mockApi(statusFixture(), [resolvableEventFixture()]);
    renderSheet();

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));

    const btn = await screen.findByRole('button', { name: /Jump to/ });
    expect(btn.getAttribute('aria-disabled')).toBe('true');
  });

  it('activating an available jump control seeks the timeline and starts playback when the target is covered', async () => {
    mockApi(statusFixture(), [resolvableEventFixture()]);
    renderSheet([COVERING_CLIP]);

    const btn = await screen.findByRole('button', { name: /Jump to/ });
    fireEvent.click(btn);

    expect(scrubMock).toHaveBeenCalledWith(10);
    expect(scrollMock).toHaveBeenCalledWith(10);
    expect(seekAndPlayMock).toHaveBeenCalledWith(10);
  });

  it('does not truncate an HH:MM:SS:FF session time in the existing timecode column', async () => {
    mockApi(statusFixture(), [resolvableEventFixture()]);
    renderSheet();

    expect(await screen.findByText('00:00:10')).toBeTruthy();
  });
});

// Whole-branch audit fix wave, finding M6: the spec requires a row's
// resolved second to be finite AND non-negative (mirroring
// `sessionTimeToTimelineSec`'s own `sec >= 0` floor). Not reachable through
// the current data shape (frames/fps are both already guarded finite and
// positive above this check), but pinned directly against the exported
// function for spec conformance and to catch a future loosening of the
// frames guard.
describe('eventRowTimelineSec — non-negative guard (finding M6)', () => {
  it('rejects a negative resolved second rather than returning it', () => {
    expect(
      eventRowTimelineSec(resolvableEventFixture({ timecode_total_frames: -240, frame_rate: 24 })),
    ).toBeNull();
  });

  it('still resolves an ordinary non-negative row', () => {
    expect(eventRowTimelineSec(resolvableEventFixture())).toBe(10);
  });
});
