import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, screen } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../../../api/client';
import type { Category, EventsResponse, LogEvent, SessionStatus } from '../../../api/types';
import { TooltipProvider } from '../../../shared/ui/Tooltip';
import { renderStrict } from '../../../test/renderStrict';
import { EventLogSheet } from './EventLogSheet';

// --- EventLogSheet virtualization (perf plan C3) ---
//
// EventLogSheet renders its rows through `@tanstack/react-virtual` using the
// TranscribeFeed precedent: padding rows inside the real <table> (a top and a
// bottom spacer `<tr><td style={{height}}/>`) with only the visible window of
// `<tr>`s between them. Two properties are pinned here, and neither is
// observable through the render-everything mock the other EventLogSheet suites
// use:
//
//  1. Windowing wiring — the sheet renders exactly the rows the virtualizer
//     reports and sizes both spacers from `start`/`end`/`getTotalSize()`. A
//     spacer computed from the wrong end (or omitted) leaves the scroll extent
//     wrong while every row assertion elsewhere still passes.
//  2. Reveal → `scrollToIndex` — the reveal path's whole point. The workspace's
//     `scrollAndFlashEventRowWithRetry` polls the DOM for
//     `tr[data-event-id=…]`; an unmounted virtual row never appears, so without
//     this call a timeline-marker reveal silently no-ops. The index MUST be
//     resolved against the sheet's `sorted` (post-filter, post-sort) order —
//     the fixture below is served in a SHUFFLED timecode order precisely so a
//     raw-list index would produce a different (wrong) number.
//
// jsdom has no layout engine, so `@tanstack/react-virtual` is mocked here as
// well — but with a controllable window rather than the render-everything stub,
// so the spacers have something non-zero to compute from. `size` is captured
// from the sheet's own `estimateSize()` so re-measuring ROW_HEIGHT does not
// break these assertions.

vi.mock('../../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/client')>();
  return { ...actual, apiFetch: vi.fn() };
});

const virtualMock = vi.hoisted(() => ({
  /** Rendered window, [first, last) in row indexes. Widened per test. */
  first: 0,
  last: Number.POSITIVE_INFINITY,
  /** Row height the component asked for, captured from `estimateSize()`. */
  size: 0,
  scrollToIndex: vi.fn(),
}));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: () => number }) => {
    const size = estimateSize();
    virtualMock.size = size;
    const first = Math.min(virtualMock.first, count);
    const last = Math.min(virtualMock.last, count);
    return {
      getVirtualItems: () =>
        Array.from({ length: Math.max(0, last - first) }, (_, offset) => {
          const index = first + offset;
          return { index, start: index * size, end: (index + 1) * size, key: index };
        }),
      getTotalSize: () => count * size,
      scrollToIndex: virtualMock.scrollToIndex,
    };
  },
}));

const mockedApiFetch = vi.mocked(apiFetch);

const SESSION_ID = 'sess-virtualized-1';
const EVENT_COUNT = 20;

beforeAll(() => {
  if (typeof window.matchMedia !== 'function') {
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
  }
  // The pagination-sentinel effect mounts an observer whenever more rows exist
  // than are loaded; jsdom has no IntersectionObserver.
  if (typeof window.IntersectionObserver === 'undefined') {
    class StubIntersectionObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    window.IntersectionObserver =
      StubIntersectionObserver as unknown as typeof IntersectionObserver;
  }
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

function statusFixture(): SessionStatus {
  return {
    is_rolling: false,
    timecode: '00:01:00:00',
    session_timecode: '00:01:00:00',
    master_timecode: '00:01:00:00',
    frame_rate: 24,
    current_take: 0,
    audio_recording_lease_alive: false,
    audio_recording_lease_holder_id: null,
    event_count: EVENT_COUNT,
    logged_event_count: EVENT_COUNT,
    title: 'Virtualization test session',
    deck_title: '',
    show_name: null,
    show_code: null,
    episode: '',
    session_created_at_utc: null,
    now_utc: '2026-07-21T00:01:00Z',
    notes: '',
    show_id: null,
    events_stream_revision: 1,
  };
}

/**
 * `count` events served in a SHUFFLED session-time order (`n = i * 7 % count`,
 * a permutation since 7 and 20 are coprime). `ev-<n>` sits at index `n` in the
 * sheet's default ascending `sorted`, at `count - 1 - n` descending, and at
 * neither of those in the raw response — so a reveal index taken from the fetch
 * order can't accidentally agree with the sorted one in either direction.
 * `ev-4`, the reveal target below, is at raw index 12.
 */
function eventsFixture(count: number): EventsResponse {
  const events: LogEvent[] = Array.from({ length: count }, (_, i) => {
    const n = (i * 7) % count;
    return {
      event_id: `ev-${n}`,
      category: 'general',
      category_label: 'General',
      category_color: '#4488ff',
      message: `note ${n}`,
      timecode: '00:00:10:00',
      timecode_total_frames: 240 + n * 24,
      frame_rate: 24,
      wall_time_utc: new Date(Date.UTC(2026, 6, 21, 0, 0, 10 + n)).toISOString(),
      metadata: {},
    };
  });
  return {
    events,
    total: events.length,
    logged_event_count: events.length,
    offset: 0,
    limit: 200,
    has_auto_generated: false,
  };
}

beforeEach(() => {
  virtualMock.first = 0;
  virtualMock.last = Number.POSITIVE_INFINITY;
  virtualMock.size = 0;
  virtualMock.scrollToIndex.mockReset();
  mockedApiFetch.mockReset();
  mockedApiFetch.mockImplementation(async (path: string) => {
    if (path.includes('/status')) return statusFixture();
    if (path.includes('/show-categories')) {
      return { categories: [categoryFixture()], show_name: '', show_code: '' };
    }
    if (path.includes('/events')) return eventsFixture(EVENT_COUNT);
    throw new Error(`unexpected apiFetch call: ${path}`);
  });
});

function renderSheet() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderStrict(
    <QueryClientProvider client={client}>
      <TooltipProvider delayDuration={400}>
        <EventLogSheet sessionId={SESSION_ID} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

function renderedEventIds(): string[] {
  return Array.from(document.querySelectorAll('#v4-log-sheet tr[data-event-id]')).map(
    (tr) => tr.getAttribute('data-event-id') ?? '',
  );
}

/** The spacer rows are the only cells carrying an inline `height`. */
function spacerHeights(): string[] {
  return Array.from(document.querySelectorAll<HTMLTableCellElement>('#v4-log-sheet tbody td'))
    .filter((td) => td.style.height !== '')
    .map((td) => td.style.height);
}

describe('EventLogSheet virtualization', () => {
  it('renders only the virtualizer window, with top/bottom spacers holding the rest of the scroll height', async () => {
    virtualMock.first = 3;
    virtualMock.last = 6;
    renderSheet();

    await screen.findByText('note 3');

    // Exactly the windowed rows, in `sorted` (ascending session-time) order.
    expect(renderedEventIds()).toEqual(['ev-3', 'ev-4', 'ev-5']);
    expect(screen.queryByText('note 2')).toBeNull();
    expect(screen.queryByText('note 6')).toBeNull();

    const size = virtualMock.size;
    expect(size).toBeGreaterThan(0);
    // Top spacer = first item's `start`; bottom spacer = total - last item's `end`.
    expect(spacerHeights()).toEqual([`${3 * size}px`, `${(EVENT_COUNT - 6) * size}px`]);
  });

  it('omits a spacer whose height is zero (window pinned to the top of the list)', async () => {
    virtualMock.first = 0;
    virtualMock.last = 4;
    renderSheet();

    await screen.findByText('note 0');

    expect(renderedEventIds()).toEqual(['ev-0', 'ev-1', 'ev-2', 'ev-3']);
    expect(spacerHeights()).toEqual([`${(EVENT_COUNT - 4) * virtualMock.size}px`]);
  });

  it('scrolls the virtualizer to a revealed row using its index in sorted order', async () => {
    renderSheet();
    await screen.findByText('note 0');
    expect(virtualMock.scrollToIndex).not.toHaveBeenCalled();

    act(() => {
      document.body.dispatchEvent(
        new CustomEvent('autologger:reveal-event', { detail: { eventId: 'ev-4' } }),
      );
    });

    // 4 is the row's index in `sorted`; its index in the raw response is 12, so
    // this discriminates the two.
    expect(virtualMock.scrollToIndex).toHaveBeenCalledWith(4, { align: 'center' });
  });

  it('resolves the reveal index against the CURRENT sort direction, not the fetch order', async () => {
    renderSheet();
    await screen.findByText('note 0');

    // Flip to descending session time — `sorted` reverses, so the same event's
    // index must change with it.
    act(() => {
      screen.getByRole('button', { name: 'Session Time' }).click();
    });

    act(() => {
      document.body.dispatchEvent(
        new CustomEvent('autologger:reveal-event', { detail: { eventId: 'ev-4' } }),
      );
    });

    expect(virtualMock.scrollToIndex).toHaveBeenCalledWith(EVENT_COUNT - 1 - 4, {
      align: 'center',
    });
  });
});
