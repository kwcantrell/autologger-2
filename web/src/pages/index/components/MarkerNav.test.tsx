import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEvents } from '../../../api/hooks/useEvents';
import { useSessionStatus } from '../../../api/hooks/useSessionStatus';
import type { EventsResponse, LogEvent, SessionStatus } from '../../../api/types';
import { renderStrict } from '../../../test/renderStrict';
import { MarkerNav } from './MarkerNav';

// --- MarkerNav characterization (feed-row-seek task 1.1, re-pinned by maximize-log-view) ---
//
// Originally pinned the feed-row-seek baseline ahead of the shared `timelineJump`
// refactor (design D8, phase 10). The maximize-log-view sole-strip polish then
// deliberately gated marker nav off while rolling/recording ("No marker scrubbing
// while rolling/recording — timeline lane is category buttons"; delta spec
// scenario "Strip contents when rolling": marker prev/next controls are
// disabled). This test now pins the CURRENT behavior:
//
//   1. each button issues AutoLogger_setManualScrubSec, AutoLogger_scrollTimelineToSec,
//      and AutoLogger_seekAudio, in that order, all with the SAME grouped-marker second
//   2. it is disabled while rolling or while the recording lease is alive
//      (maximize-log-view; supersedes the feed-row-seek "ungated while rolling" pin)
//   3. the audio seek is issued unconditionally, with no clip-coverage check
//   4. it never starts playback
//   (plus: the buttons are disabled when no markers exist)
//
// The hooks MarkerNav reads (useEvents, useSessionStatus) are mocked at the
// module boundary, same pattern as CategoryButtonStrip.test.tsx — this is a
// rendering test of MarkerNav's own click behavior, not an integration test of
// the underlying React Query plumbing, so no QueryClientProvider is needed.

vi.mock('../../../api/hooks/useEvents', () => ({
  useEvents: vi.fn(),
  WORKSPACE_EVENTS_LIMIT: 2000,
}));
vi.mock('../../../api/hooks/useSessionStatus', () => ({
  useSessionStatus: vi.fn(),
}));

const mockedUseEvents = vi.mocked(useEvents);
const mockedUseSessionStatus = vi.mocked(useSessionStatus);

const SESSION_ID = 'sess-marker-nav-1';
const FPS = 24;

function eventFixture(id: string, totalFrames: number): LogEvent {
  return {
    event_id: id,
    category: 'general',
    category_label: 'General',
    category_color: '#4488ff',
    message: `event ${id}`,
    timecode: '00:00:00:00',
    timecode_total_frames: totalFrames,
    frame_rate: FPS,
    wall_time_utc: null,
    metadata: {},
  };
}

// Two markers, 10s apart: sec 10 (240 frames) and sec 20 (480 frames) at 24fps.
const MARKER_EVENTS: LogEvent[] = [eventFixture('ev-10s', 240), eventFixture('ev-20s', 480)];

function statusFixture(overrides: Partial<SessionStatus> = {}): SessionStatus {
  return {
    is_rolling: false,
    // currentSec resolves from status.timecode when no scrub override has
    // been dispatched (no `autologger:timeline-sec` event fired in this
    // test) — 00:00:15:00 at 24fps sits between the two markers.
    timecode: '00:00:15:00',
    session_timecode: '00:00:15:00',
    master_timecode: '00:00:15:00',
    frame_rate: FPS,
    current_take: 0,
    audio_recording_lease_alive: false,
    audio_recording_lease_holder_id: null,
    event_count: MARKER_EVENTS.length,
    logged_event_count: MARKER_EVENTS.length,
    title: 'MarkerNav test session',
    deck_title: '',
    show_name: null,
    show_code: null,
    episode: '',
    session_created_at_utc: null,
    now_utc: '2026-07-26T00:00:15Z',
    notes: '',
    show_id: null,
    events_stream_revision: 1,
    ...overrides,
  };
}

function eventsResponseFixture(events: LogEvent[]): EventsResponse {
  return {
    events,
    total: events.length,
    logged_event_count: events.length,
    offset: 0,
    limit: 1000,
    has_auto_generated: false,
  };
}

function mockHooks(events: LogEvent[], status: SessionStatus) {
  mockedUseEvents.mockReturnValue({
    data: eventsResponseFixture(events),
  } as unknown as ReturnType<typeof useEvents>);
  mockedUseSessionStatus.mockReturnValue({
    data: status,
  } as unknown as ReturnType<typeof useSessionStatus>);
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
  // Play-capable path (feed-row-seek, phase 4) — MarkerNav must never call this;
  // see "issues the audio seek unconditionally ... and never starts playback" below.
  seekAndPlayMock = vi.fn();
  window.AutoLogger_setManualScrubSec = scrubMock;
  window.AutoLogger_scrollTimelineToSec = scrollMock;
  window.AutoLogger_seekAudio = seekMock;
  window.AutoLogger_seekAudioAndPlay = seekAndPlayMock;
});

describe('MarkerNav prev/next jump (characterization baseline)', () => {
  it('next issues scrub, scroll, and audio-seek with the same grouped-marker second, in order, while idle', () => {
    mockHooks(MARKER_EVENTS, statusFixture());
    renderStrict(<MarkerNav sessionId={SESSION_ID} />);

    screen.getByRole('button', { name: 'Next marker' }).click();

    // Same second to all three globals.
    expect(scrubMock).toHaveBeenCalledWith(20);
    expect(scrollMock).toHaveBeenCalledWith(20);
    expect(seekMock).toHaveBeenCalledWith(20);

    // In order: scrub, then scroll, then audio seek.
    const order = [scrubMock, scrollMock, seekMock].map((m) => m.mock.invocationCallOrder[0]);
    expect(order[0]).toBeLessThan(order[1]);
    expect(order[1]).toBeLessThan(order[2]);
  });

  it('prev issues scrub, scroll, and audio-seek with the same grouped-marker second, in order, while idle', () => {
    mockHooks(MARKER_EVENTS, statusFixture());
    renderStrict(<MarkerNav sessionId={SESSION_ID} />);

    screen.getByRole('button', { name: 'Previous marker' }).click();

    expect(scrubMock).toHaveBeenCalledWith(10);
    expect(scrollMock).toHaveBeenCalledWith(10);
    expect(seekMock).toHaveBeenCalledWith(10);

    const order = [scrubMock, scrollMock, seekMock].map((m) => m.mock.invocationCallOrder[0]);
    expect(order[0]).toBeLessThan(order[1]);
    expect(order[1]).toBeLessThan(order[2]);
  });

  it('disables both buttons while rolling — no scrub/scroll/seek fires', () => {
    mockHooks(MARKER_EVENTS, statusFixture({ is_rolling: true }));
    renderStrict(<MarkerNav sessionId={SESSION_ID} />);

    const nextBtn = screen.getByRole('button', { name: 'Next marker' }) as HTMLButtonElement;
    const prevBtn = screen.getByRole('button', { name: 'Previous marker' }) as HTMLButtonElement;
    expect(prevBtn.disabled).toBe(true);
    expect(nextBtn.disabled).toBe(true);

    nextBtn.click();
    prevBtn.click();
    expect(scrubMock).not.toHaveBeenCalled();
    expect(scrollMock).not.toHaveBeenCalled();
    expect(seekMock).not.toHaveBeenCalled();
  });

  it('disables both buttons while the recording lease is alive', () => {
    mockHooks(MARKER_EVENTS, statusFixture({ audio_recording_lease_alive: true }));
    renderStrict(<MarkerNav sessionId={SESSION_ID} />);

    const nextBtn = screen.getByRole('button', { name: 'Next marker' }) as HTMLButtonElement;
    expect(nextBtn.disabled).toBe(true);
    nextBtn.click();
    expect(seekMock).not.toHaveBeenCalled();
  });

  it('issues the audio seek unconditionally, with no clip-coverage check, and never starts playback', () => {
    mockHooks(MARKER_EVENTS, statusFixture());
    renderStrict(<MarkerNav sessionId={SESSION_ID} />);

    // MarkerNav has no notion of audio clips or coverage at all (no
    // useAudioClips import) — clicking always issues the seek, with no
    // branch that could skip it for an "uncovered" target.
    screen.getByRole('button', { name: 'Next marker' }).click();
    screen.getByRole('button', { name: 'Previous marker' }).click();
    expect(seekMock).toHaveBeenCalledTimes(2);

    // "Never starts playback": the only audio-facing call is AutoLogger_seekAudio,
    // and every call carries just the target second — the same single-argument,
    // non-playing signature AudioPlayer.seekToTimelineSec exposes today.
    for (const call of seekMock.mock.calls) {
      expect(call).toHaveLength(1);
    }

    // Direct assertion (feed-row-seek phase 4 strengthened this beyond the
    // call-arity proxy above, now that a playback-capable path actually
    // exists): MarkerNav must never reach the play-capable global at all.
    expect(seekAndPlayMock).not.toHaveBeenCalled();
  });

  it('disables both buttons when no markers exist', () => {
    mockHooks([], statusFixture());
    renderStrict(<MarkerNav sessionId={SESSION_ID} />);

    const prevBtn = screen.getByRole('button', { name: 'Previous marker' }) as HTMLButtonElement;
    const nextBtn = screen.getByRole('button', { name: 'Next marker' }) as HTMLButtonElement;
    expect(prevBtn.disabled).toBe(true);
    expect(nextBtn.disabled).toBe(true);

    prevBtn.click();
    nextBtn.click();
    expect(scrubMock).not.toHaveBeenCalled();
    expect(scrollMock).not.toHaveBeenCalled();
    expect(seekMock).not.toHaveBeenCalled();
  });
});
