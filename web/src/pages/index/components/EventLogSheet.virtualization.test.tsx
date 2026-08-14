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

type VirtualRange = { startIndex: number; endIndex: number; overscan: number; count: number };

const virtualMock = vi.hoisted(() => ({
  /** Rendered window, [first, last) in row indexes. Widened per test. */
  first: 0,
  last: Number.POSITIVE_INFINITY,
  /** Row height the component asked for, captured from `estimateSize()`. */
  size: 0,
  /** The sheet's own `rangeExtractor`, captured so the pinned-row rule can be
   *  called directly as well as observed through the rendered window. */
  rangeExtractor: null as ((range: VirtualRange) => number[]) | null,
  scrollToIndex: vi.fn(),
}));

// Spread over the real module: the sheet builds its `rangeExtractor` on top of
// the library's own `defaultRangeExtractor`, so that export has to stay real.
// The window mock RUNS the sheet's extractor over `[first, last)` (with zero
// overscan, so an unpinned range comes back exactly as set) — the rows the
// extractor asks for are the rows that mount, which is how the pin is
// observable end-to-end here.
vi.mock('@tanstack/react-virtual', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-virtual')>()),
  useVirtualizer: ({
    count,
    estimateSize,
    rangeExtractor,
  }: {
    count: number;
    estimateSize: () => number;
    rangeExtractor?: (range: VirtualRange) => number[];
  }) => {
    const size = estimateSize();
    virtualMock.size = size;
    virtualMock.rangeExtractor = rangeExtractor ?? null;
    const first = Math.min(virtualMock.first, count);
    const last = Math.min(virtualMock.last, count);
    const window =
      last <= first
        ? []
        : (rangeExtractor?.({ startIndex: first, endIndex: last - 1, overscan: 0, count }) ??
          Array.from({ length: last - first }, (_, offset) => first + offset));
    return {
      getVirtualItems: () =>
        window.map((index) => ({
          index,
          start: index * size,
          end: (index + 1) * size,
          key: index,
        })),
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
  // Radix Select's trigger gesture needs these; jsdom has none of them.
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = () => {};
  if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => {};
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  if (typeof window.ResizeObserver === 'undefined') {
    class StubResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    window.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
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

/** Holds the PUT in flight when set, so a test can type INTO a save round trip
 *  (the real one spans a network call plus the invalidation refetch). */
let putGate: Promise<void> | null = null;

/** Makes the next PUT reject, the state in which the sheet deliberately KEEPS
 *  the operator's draft so the text stays recoverable. */
let putFails = false;

beforeEach(() => {
  virtualMock.first = 0;
  virtualMock.last = Number.POSITIVE_INFINITY;
  virtualMock.size = 0;
  virtualMock.rangeExtractor = null;
  virtualMock.scrollToIndex.mockReset();
  putGate = null;
  putFails = false;
  rolling = false;
  serverEvents = eventsFixture(EVENT_COUNT).events;
  mockedApiFetch.mockReset();
  mockedApiFetch.mockImplementation(async (path: string, opts: RequestInit = {}) => {
    if (path.includes('/status')) return statusFixture();
    if (path.includes('/show-categories')) {
      return { categories: [categoryFixture()], show_name: '', show_code: '' };
    }
    if (path.includes('/events/') && opts.method === 'PUT') {
      if (putGate) await putGate;
      if (putFails) throw new Error('save failed');
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
        // Derived from what is actually served: one suite below swaps in a
        // longer list so a row can be pushed past the pin bound.
        total: serverEvents.length,
        logged_event_count: serverEvents.length,
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

// --- Shared inline-edit harness (the draft, pinning and focus suites below all
// drive the same rolling sheet through the same windowing mock) ---

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

/** Longer than `PINNED_ROW_MAX_EXTRA_ROWS` (50) so a window move can push the
 *  edited row past the pin and make it genuinely unmount. `eventsFixture`'s
 *  `i * 7 % count` shuffle stays a permutation (7 and 120 are coprime). */
const LONG_COUNT = 120;
function serveLongFixture() {
  serverEvents = eventsFixture(LONG_COUNT).events;
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

  it('keeps keystrokes typed DURING the save round trip, and still drops what the save committed', async () => {
    serveLongFixture();
    virtualMock.first = 0;
    virtualMock.last = 3;
    await renderRollingSheet();

    const input = messageInput('ev-0');
    act(() => {
      input.focus();
    });
    fireEvent.change(input, { target: { value: 'first half' } });

    // Hold the PUT so the round trip is a window the operator can type into.
    let release!: () => void;
    putGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    await act(async () => {
      input.blur();
      // handleBlur defers its save a tick to let focus settle.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Save in flight. The operator comes back to the row and keeps typing —
    // these keystrokes are in the draft store but are NOT what is being saved.
    act(() => {
      messageInput('ev-0').focus();
    });
    fireEvent.change(messageInput('ev-0'), { target: { value: 'first half plus more' } });

    await act(async () => {
      release();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() =>
      expect(serverEvents.find((e) => e.event_id === 'ev-0')?.message).toBe('first half'),
    );
    // Let the mutation's own continuation (which reconciles the draft) run.
    await act(async () => {});

    // Past the pin bound, so the row really is unmounted and remounted from the
    // draft store — the only place those later keystrokes now live.
    scrollWindowTo(100, 103, 'ev-101');
    expect(document.querySelector('#v4-log-sheet tr[data-event-id="ev-0"]')).toBeNull();
    scrollWindowTo(0, 3, 'ev-1');

    expect(messageInput('ev-0').value).toBe('first half plus more');
  });

  it('drops the draft of a clean save even when the row is unmounted as it lands', async () => {
    // The blind-clear regression guard. The row's own event-changed effect also
    // clears a spent draft, but only while the row is MOUNTED — unmounting it
    // before the save resolves leaves `handleInlineSave` as the only thing that
    // can forget it. Trailing whitespace is the discriminator: `saveInline`
    // trims what it commits, so a surviving draft is visible on the remount.
    serveLongFixture();
    virtualMock.first = 0;
    virtualMock.last = 3;
    await renderRollingSheet();

    const input = messageInput('ev-0');
    act(() => {
      input.focus();
    });
    fireEvent.change(input, { target: { value: 'committed note  ' } });

    let release!: () => void;
    putGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await act(async () => {
      input.blur();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Focus left the row before the save was issued, so nothing is pinned: the
    // row unmounts while its own save is still in flight.
    scrollWindowTo(100, 103, 'ev-101');
    expect(document.querySelector('#v4-log-sheet tr[data-event-id="ev-0"]')).toBeNull();

    await act(async () => {
      release();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() =>
      expect(serverEvents.find((e) => e.event_id === 'ev-0')?.message).toBe('committed note'),
    );
    await act(async () => {});

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

// --- Pinning the edited row into the virtual window (focus yank) ---
//
// Inline edit is live exactly while timecode is rolling, which is exactly when
// new events are arriving. Under a descending sort every arrival prepends at
// index 0 and shifts the row being edited one further down; past the overscan
// the virtualizer unmounts the focused <tr>. The browser then drops focus to
// <body>: keystrokes go nowhere, the deferred blur-to-save bails on the null row
// ref (so nothing is even saved), and nothing puts focus back.
//
// The sheet answers with @tanstack/react-virtual's `rangeExtractor` seam — the
// library's documented way to force an index into the rendered range. Two
// properties matter and are pinned here: the edited row's index is in the range
// whatever the window does (up to the documented bound), and the range stays
// CONTIGUOUS while doing it, because this table holds its scroll extent with two
// spacer rows and a hole in the middle of the range would shove the window up by
// the height of the gap.
describe('EventLogSheet pinned inline-edit row', () => {
  it('keeps the row being edited mounted after the window moves past it', async () => {
    serveLongFixture();
    virtualMock.first = 0;
    virtualMock.last = 3;
    await renderRollingSheet();

    act(() => {
      messageInput('ev-0').focus();
    });

    // The window moves 30 rows down — far past the row being edited.
    scrollWindowTo(30, 33, 'ev-31');

    const ids = renderedEventIds();
    expect(ids).toContain('ev-0');
    // Contiguous clamp (the documented tradeoff): the gap rows come along, so
    // the rendered range runs from the pinned row to the end of the window.
    expect(ids[0]).toBe('ev-0');
    expect(ids[ids.length - 1]).toBe('ev-32');
    expect(ids).toHaveLength(33);
    // Spacer math is unaffected: still one contiguous run, so the top spacer is
    // zero (omitted) and the bottom one covers everything after it.
    expect(spacerHeights()).toEqual([`${(LONG_COUNT - 33) * virtualMock.size}px`]);
    // ...and the edit is still where the operator left it.
    expect(document.activeElement).toBe(messageInput('ev-0'));
  });

  it('leaves the window alone when nothing is being edited', async () => {
    serveLongFixture();
    virtualMock.first = 0;
    virtualMock.last = 3;
    await renderRollingSheet();

    scrollWindowTo(30, 33, 'ev-31');

    expect(renderedEventIds()).toEqual(['ev-30', 'ev-31', 'ev-32']);
  });

  it('includes the edited row index in the extracted range, and drops the pin past the bound', async () => {
    serveLongFixture();
    virtualMock.first = 0;
    virtualMock.last = 3;
    await renderRollingSheet();

    act(() => {
      messageInput('ev-0').focus();
    });

    const extract = virtualMock.rangeExtractor;
    if (!extract) throw new Error('the sheet passed no rangeExtractor');

    // Within the bound: the pinned index (0 — ev-0 leads the ascending sort) is
    // in the range, and the range is a contiguous run reaching the window.
    const near = extract({ startIndex: 20, endIndex: 25, overscan: 2, count: LONG_COUNT });
    expect(near[0]).toBe(0);
    expect(near[near.length - 1]).toBe(27);
    expect(near).toEqual(Array.from({ length: 28 }, (_, i) => i));

    // Past PINNED_ROW_MAX_EXTRA_ROWS (50) the pin is dropped rather than render
    // the whole gap — the draft store keeps the text and the focus record
    // restores the caret when the row scrolls back. Plain overscan window only.
    const far = extract({ startIndex: 80, endIndex: 85, overscan: 2, count: LONG_COUNT });
    expect(far).toEqual(Array.from({ length: 10 }, (_, i) => 78 + i));
  });

  it('hands the virtualizer one stable rangeExtractor identity across renders', async () => {
    serveLongFixture();
    virtualMock.first = 0;
    virtualMock.last = 3;
    await renderRollingSheet();

    const first = virtualMock.rangeExtractor;
    act(() => {
      messageInput('ev-0').focus();
    });
    fireEvent.change(messageInput('ev-0'), { target: { value: 'typing' } });
    scrollWindowTo(5, 8, 'ev-6');

    // A fresh identity per render is an options change to the virtualizer, so
    // everything the extractor varies on is read through refs instead.
    expect(virtualMock.rangeExtractor).toBe(first);
  });
});

// --- Focus + caret restore across a remount the pin could not prevent ---
describe('EventLogSheet inline-edit focus restore', () => {
  it('puts focus and caret back when the edited row remounts', async () => {
    serveLongFixture();
    virtualMock.first = 0;
    virtualMock.last = 3;
    await renderRollingSheet();

    const input = messageInput('ev-0');
    act(() => {
      input.setSelectionRange(2, 4);
      input.focus();
    });

    // Past the pin bound, so the row genuinely unmounts and focus is lost.
    scrollWindowTo(100, 103, 'ev-101');
    expect(document.querySelector('#v4-log-sheet tr[data-event-id="ev-0"]')).toBeNull();
    expect(document.activeElement).toBe(document.body);

    scrollWindowTo(0, 3, 'ev-1');

    const restored = messageInput('ev-0');
    expect(document.activeElement).toBe(restored);
    expect(restored.selectionStart).toBe(2);
    expect(restored.selectionEnd).toBe(4);
  });

  it('does not grab focus for a row nobody was editing', async () => {
    serveLongFixture();
    virtualMock.first = 0;
    virtualMock.last = 3;
    await renderRollingSheet();

    scrollWindowTo(100, 103, 'ev-101');
    scrollWindowTo(0, 3, 'ev-1');

    expect(document.activeElement).toBe(document.body);
  });
});

// --- A refetch must not delete text no save has taken (review finding 1) ---
//
// The row's server-sync effect (`event` identity changed ⇒ refresh the inputs)
// used to end by clearing the row's whole draft entry, guarded only by "focus is
// not inside this row". That neutralized the merge the save-resolution clear
// above performs: any refetch landing on a blurred row deleted the fields it had
// just deliberately preserved — including the text a FAILED save leaves
// recoverable, which is the one case the operator has no other copy of.
describe('EventLogSheet inline drafts vs. a server refresh', () => {
  it('keeps the text a failed save left recoverable when a later refetch touches the row', async () => {
    virtualMock.first = 0;
    virtualMock.last = 3;
    const { client } = await renderRollingSheet();

    // The save fails: nothing is committed, and the sheet keeps the draft.
    putFails = true;
    const input = messageInput('ev-0');
    act(() => {
      input.focus();
    });
    fireEvent.change(input, { target: { value: 'text nothing has saved' } });
    await act(async () => {
      input.blur();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() =>
      expect(serverEvents.find((e) => e.event_id === 'ev-0')?.message).toBe('note 0'),
    );

    // Something else moves the row on the server (another operator, a
    // regenerate, a poll) and a refetch hands this — now blurred — row a new
    // identity.
    // (A field the sort does not key on, so the row stays in the window.)
    const index = serverEvents.findIndex((e) => e.event_id === 'ev-0');
    serverEvents = [...serverEvents];
    serverEvents[index] = { ...serverEvents[index], category: 'reassigned' };
    await act(async () => {
      await client.invalidateQueries();
    });

    // The unsaved text is still there — on screen and in the store...
    await waitFor(() => expect(messageInput('ev-0').value).toBe('text nothing has saved'));
    // ...and the field the server actually moved still refreshed.
    expect(within(row('ev-0')).getByRole('combobox', { name: 'Category' }).textContent).toContain(
      'reassigned',
    );

    // Not merely on screen: it survives the virtualizer dropping the row.
    scrollWindowTo(10, 13, 'ev-11');
    scrollWindowTo(0, 3, 'ev-1');
    expect(messageInput('ev-0').value).toBe('text nothing has saved');
  });
});

// --- The pin covers the category dropdown too (review finding 2) ---
//
// `recordFocus` is wired to the three text inputs only, so opening the inline
// category Select — which portals its listbox and moves focus outside the <tr> —
// made the deferred blur handler read "focus left the row" and drop the pin,
// exactly while the dropdown was open. The next incoming event then unmounted
// the row mid-choice and the selection went nowhere. Radix's `onOpenChange` is
// the explicit signal that this is still the row being edited.
describe('EventLogSheet pinned row with its category dropdown open', () => {
  async function openCategory(eventId: string) {
    const trigger = within(row(eventId)).getByRole('combobox', { name: 'Category' });
    await act(async () => {
      fireEvent.pointerDown(trigger, { pointerType: 'mouse', button: 0 });
      fireEvent.pointerUp(trigger, { pointerType: 'mouse', button: 0 });
      fireEvent.click(trigger);
      // The blur-to-save the opening gesture fires is deferred a tick.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it('keeps the row mounted after the window moves past it while the dropdown is open', async () => {
    serveLongFixture();
    virtualMock.first = 0;
    virtualMock.last = 3;
    await renderRollingSheet();

    act(() => {
      messageInput('ev-0').focus();
    });
    await openCategory('ev-0');

    // Incoming events push the window far past the row being edited.
    scrollWindowTo(30, 33, 'ev-31');

    expect(renderedEventIds()).toContain('ev-0');
  });

  it('releases the pin once the dropdown closes and focus has left the row', async () => {
    serveLongFixture();
    virtualMock.first = 0;
    virtualMock.last = 3;
    await renderRollingSheet();

    act(() => {
      messageInput('ev-0').focus();
    });
    await openCategory('ev-0');

    // Dismissed with Escape, then focus goes somewhere else entirely.
    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      (document.activeElement as HTMLElement | null)?.blur();
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    scrollWindowTo(30, 33, 'ev-31');
    expect(renderedEventIds()).toEqual(['ev-30', 'ev-31', 'ev-32']);
  });

  // `selectOpen` is a claim only a MOUNTED row can maintain: Radix fires no
  // `onOpenChange(false)` when the virtualizer unmounts the row out from under
  // an open dropdown, so the flag stuck true on a record nothing could correct
  // — permanently disarming the abandon listener and holding the pin.
  it('stops claiming an open dropdown once the row is unmounted out from under it', async () => {
    serveLongFixture();
    virtualMock.first = 0;
    virtualMock.last = 3;
    await renderRollingSheet();

    act(() => {
      messageInput('ev-0').focus();
    });
    await openCategory('ev-0');

    // Past the pin bound: the row — and its dropdown — go away without Radix
    // ever reporting the close.
    scrollWindowTo(100, 103, 'ev-101');
    expect(document.querySelector('#v4-log-sheet tr[data-event-id="ev-0"]')).toBeNull();

    // The operator clicks away. A record still claiming an open dropdown would
    // be skipped by the abandon listener, and stay pinned forever.
    await act(async () => {
      (document.activeElement as HTMLElement | null)?.blur();
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    scrollWindowTo(30, 33, 'ev-31');
    expect(renderedEventIds()).toEqual(['ev-30', 'ev-31', 'ev-32']);
  });
});

// --- An abandoned focus record expires (review finding 3) ---
//
// Wheel scrolling moves neither focus nor `document.activeElement`, so a record
// left behind by an edit the operator walked away from stayed eligible forever:
// the row kept up to `PINNED_ROW_MAX_EXTRA_ROWS` gap rows pinned, and grabbed
// the caret the moment it scrolled back into overscan. An outside interaction
// that focus FOLLOWS is the abandonment signal the scroll wheel cannot give —
// and, per the pointerdown/focus split below, the outside pointerdown alone is
// not that signal.
//
// The sheet's listener is isolated here by unmounting the row first: an
// unmounted row fires no blur, and `handleBlur`'s deferred body bails on the
// null row ref, so nothing but this listener can retire the record.
describe('EventLogSheet abandoned inline-edit focus', () => {
  /** The operator's next interaction lands somewhere else entirely, and focus
   *  goes with it — a pointerdown on a non-focusable area leaves the document
   *  focused on <body>. The deferred focus check runs a tick later. */
  async function clickAway(target: EventTarget = document.body) {
    await act(async () => {
      (document.activeElement as HTMLElement | null)?.blur();
      target.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it('does not steal focus on scroll-back after the operator clicked away', async () => {
    serveLongFixture();
    virtualMock.first = 0;
    virtualMock.last = 3;
    await renderRollingSheet();

    const input = messageInput('ev-0');
    act(() => {
      input.focus();
    });
    fireEvent.change(input, { target: { value: 'abandoned but recoverable' } });

    // Past the pin bound: the row unmounts and focus falls to <body>, which is
    // the state the restore guard looks for.
    scrollWindowTo(100, 103, 'ev-101');
    expect(document.querySelector('#v4-log-sheet tr[data-event-id="ev-0"]')).toBeNull();

    // The operator gets on with something else. Wheel scrolling changed nothing
    // about focus, so only this gesture can retire the record.
    await clickAway();

    scrollWindowTo(0, 3, 'ev-1');

    expect(document.activeElement).toBe(document.body);
    // The TEXT is not abandoned with the caret — it stays recoverable.
    expect(messageInput('ev-0').value).toBe('abandoned but recoverable');
  });

  it('drops the pin with the record, so the gap rows stop rendering', async () => {
    serveLongFixture();
    virtualMock.first = 0;
    virtualMock.last = 3;
    await renderRollingSheet();

    act(() => {
      messageInput('ev-0').focus();
    });
    // Past the pin bound, so the row is unmounted and only the sheet's listener
    // is in play; then the operator clicks away.
    scrollWindowTo(100, 103, 'ev-101');
    await clickAway();

    scrollWindowTo(30, 33, 'ev-31');

    expect(renderedEventIds()).toEqual(['ev-30', 'ev-31', 'ev-32']);
  });

  it('keeps the record while focus is still inside the row', async () => {
    serveLongFixture();
    virtualMock.first = 0;
    virtualMock.last = 3;
    await renderRollingSheet();

    const input = messageInput('ev-0');
    act(() => {
      input.focus();
    });
    // A click on the row itself (or on another of its controls) is not
    // abandonment.
    act(() => {
      input.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    scrollWindowTo(30, 33, 'ev-31');

    expect(renderedEventIds()).toContain('ev-0');
  });

  // --- An outside pointerdown that focus does NOT follow (review finding 2) ---
  //
  // OverlayScrollbars' handle and track are ordinary elements outside the
  // <tr>, and they `preventDefault()` the pointerdown so the focused input
  // keeps focus. Treating the bare pointerdown as abandonment unpinned a row
  // the operator was still typing in, with no record left to restore from —
  // and dragging the same gesture past the pin bound then unmounted that
  // focused row, where no blur fires and nothing saves.
  it('keeps the record when an outside pointerdown does not move focus (a preventDefault-ing scrollbar)', async () => {
    serveLongFixture();
    virtualMock.first = 0;
    virtualMock.last = 3;
    await renderRollingSheet();

    const input = messageInput('ev-0');
    await act(async () => {
      input.focus();
      // Let jsdom's asynchronous `selectionchange` (a side effect of focusing a
      // text input) land BEFORE the gesture under test: React turns it into an
      // `onSelect`, which re-records the caret and would mask what the
      // pointerdown did.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The scrollbar handle: outside the row, and it swallows the focus change.
    const handle = document.createElement('div');
    document.body.appendChild(handle);
    await act(async () => {
      handle.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Focus never left, so the edit was never abandoned...
    expect(document.activeElement).toBe(input);
    // ...and the row is still pinned when the drag scrolls the window past it.
    scrollWindowTo(30, 33, 'ev-31');
    expect(renderedEventIds()).toContain('ev-0');

    handle.remove();
  });
});
