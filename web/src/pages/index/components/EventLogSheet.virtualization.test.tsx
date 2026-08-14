import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../../../api/client';
import { sessionStatusKeys } from '../../../api/hooks/useSessionStatus';
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

/** Flipped by the inline-draft suite below: inline (rolling) edit is live
 *  exactly while `is_rolling` — every other suite here runs stopped. */
let rolling = false;

function statusFixture(): SessionStatus {
  return {
    is_rolling: rolling,
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

/** The served event list, mutable so a PUT can persist the way a real backend
 *  does — the inline-save suite below needs the refetch after a save to carry
 *  the committed row. */
let serverEvents: LogEvent[] = [];

beforeEach(() => {
  virtualMock.first = 0;
  virtualMock.last = Number.POSITIVE_INFINITY;
  virtualMock.size = 0;
  virtualMock.scrollToIndex.mockReset();
  rolling = false;
  serverEvents = eventsFixture(EVENT_COUNT).events;
  mockedApiFetch.mockReset();
  mockedApiFetch.mockImplementation(async (path: string, opts: RequestInit = {}) => {
    if (path.includes('/status')) return statusFixture();
    if (path.includes('/show-categories')) {
      return { categories: [categoryFixture()], show_name: '', show_code: '' };
    }
    if (path.includes('/events/') && opts.method === 'PUT') {
      const eventId = path.split('/events/')[1];
      const body = JSON.parse(String(opts.body)) as {
        category: string;
        message: string;
      };
      const index = serverEvents.findIndex((e) => e.event_id === eventId);
      if (index < 0) throw new Error(`unknown event: ${eventId}`);
      // A fresh object for the edited row only, so React Query's structural
      // sharing hands EventLogRow a NEW `event` identity for it and keeps every
      // other row's — exactly what the server round trip produces.
      const updated = { ...serverEvents[index], category: body.category, message: body.message };
      serverEvents = [...serverEvents];
      serverEvents[index] = updated;
      return updated;
    }
    if (path.includes('/events')) {
      return {
        ...eventsFixture(EVENT_COUNT),
        events: serverEvents,
      };
    }
    throw new Error(`unexpected apiFetch call: ${path}`);
  });
});

function renderSheet() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    client,
    ...renderStrict(
      <QueryClientProvider client={client}>
        <TooltipProvider delayDuration={400}>
          <EventLogSheet sessionId={SESSION_ID} />
        </TooltipProvider>
      </QueryClientProvider>,
    ),
  };
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

// --- Inline-edit drafts across a virtual unmount (data-loss regression) ---
//
// Virtualizing this feed made a previously impossible failure reachable: the
// inline (rolling) edit controls are UNCONTROLLED (`defaultValue` + refs in
// EventLogRow), so before the draft store the only copy of an in-progress edit
// was the <tr>'s own DOM nodes. Scrolling the edited row more than `overscan`
// rows away — or a timeline-marker reveal calling `scrollToIndex` at the other
// end of the list — unmounted it and destroyed the keystrokes silently:
// scrolling back showed the original server text, with no error and no toast.
// Pre-virtualization every row stayed mounted, so this could not happen.
//
// EventLogSheet now owns the drafts and each row writes through to them, so the
// round trip below must be lossless. The suite also pins the two ways a draft
// STOPS being live — a committed save and the end of inline-edit mode — because
// a store that never forgets would shadow fresh server state instead.
describe('EventLogSheet inline-edit drafts', () => {
  function row(eventId: string): HTMLElement {
    const el = document.querySelector<HTMLTableRowElement>(
      `#v4-log-sheet tr[data-event-id="${eventId}"]`,
    );
    if (!el) throw new Error(`row ${eventId} is not mounted`);
    return el;
  }

  function messageInput(eventId: string): HTMLInputElement {
    return within(row(eventId)).getByLabelText('Message') as HTMLInputElement;
  }

  /** Move the rendered window, driven the way the app does it: a timeline-marker
   *  reveal. (`scrollToIndex` is the mock's no-op here, so the resulting window
   *  is set directly — the reveal supplies the render, the window supplies the
   *  range.) */
  function scrollWindowTo(first: number, last: number, revealEventId: string) {
    act(() => {
      virtualMock.first = first;
      virtualMock.last = last;
      document.body.dispatchEvent(
        new CustomEvent('autologger:reveal-event', { detail: { eventId: revealEventId } }),
      );
    });
  }

  /** Renders with timecode rolling — the state inline edit is live in — and
   *  waits for the first window of rows to reach edit mode. */
  async function renderRollingSheet() {
    rolling = true;
    const utils = renderSheet();
    await waitFor(() => expect(messageInput('ev-0').value).toBe('note 0'));
    return utils;
  }

  it('restores an in-progress edit when the virtualizer unmounts and remounts the row', async () => {
    virtualMock.first = 0;
    virtualMock.last = 3;
    await renderRollingSheet();

    fireEvent.change(messageInput('ev-0'), { target: { value: 'half-typed thought' } });
    fireEvent.change(within(row('ev-0')).getByLabelText('Timecode'), {
      target: { value: '00:00:1' },
    });

    // Jump far enough away that ev-0 leaves the window entirely.
    scrollWindowTo(10, 13, 'ev-11');
    expect(document.querySelector('#v4-log-sheet tr[data-event-id="ev-0"]')).toBeNull();

    // ...and back. Before the draft store this rendered the server text again.
    scrollWindowTo(0, 3, 'ev-1');
    expect(messageInput('ev-0').value).toBe('half-typed thought');
    expect((within(row('ev-0')).getByLabelText('Timecode') as HTMLInputElement).value).toBe(
      '00:00:1',
    );
    // Untyped fields are untouched, and no other row inherits the draft.
    expect(messageInput('ev-1').value).toBe('note 1');
  });

  it('drops the draft once the inline save has round-tripped', async () => {
    virtualMock.first = 0;
    virtualMock.last = 3;
    await renderRollingSheet();

    const input = messageInput('ev-0');
    act(() => {
      input.focus();
    });
    // Trailing whitespace is the discriminator: `saveInline` trims what it
    // COMMITS, so the server row and a leftover draft differ by exactly those
    // two spaces — a stale draft would be visible on the remount below.
    fireEvent.change(input, { target: { value: 'committed note  ' } });
    await act(async () => {
      input.blur();
      // handleBlur defers its save a tick to let focus settle.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() =>
      expect(serverEvents.find((e) => e.event_id === 'ev-0')?.message).toBe('committed note'),
    );
    await waitFor(() => expect(messageInput('ev-0').value).toBe('committed note'));
    // Let the mutation's own continuation (which forgets the draft) run.
    await act(async () => {});

    scrollWindowTo(10, 13, 'ev-11');
    scrollWindowTo(0, 3, 'ev-1');

    expect(messageInput('ev-0').value).toBe('committed note');
  });

  it('drops inline drafts when inline-edit mode ends', async () => {
    virtualMock.first = 0;
    virtualMock.last = 3;
    const { client } = await renderRollingSheet();

    fireEvent.change(messageInput('ev-0'), { target: { value: 'abandoned thought' } });

    // Timecode stops: every inline control unmounts. That is the closest thing
    // rolling edit has to a cancel — nothing was committed, and the abandoned
    // text must not come back.
    rolling = false;
    await act(async () => {
      await client.invalidateQueries({ queryKey: sessionStatusKeys.bySession(SESSION_ID) });
    });
    await waitFor(() => expect(within(row('ev-0')).queryByLabelText('Message')).toBeNull());

    rolling = true;
    await act(async () => {
      await client.invalidateQueries({ queryKey: sessionStatusKeys.bySession(SESSION_ID) });
    });
    await waitFor(() => expect(messageInput('ev-0').value).toBe('note 0'));
  });
});
