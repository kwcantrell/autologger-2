import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch } from '../../../api/client';
import { WORKSPACE_EVENTS_LIMIT } from '../../../api/hooks/useEvents';
import type { Category, EventsResponse, LogEvent, SessionStatus } from '../../../api/types';
import { showToast } from '../../../shared/components/Toast';
import { TooltipProvider } from '../../../shared/ui/Tooltip';
import { renderStrict, StrictWrapper } from '../../../test/renderStrict';
import { EventLogSheet } from './EventLogSheet';

// --- EventLogSheet batch-Escape / discard-confirm regression (ui-refresh, phase-2
// fix wave) ---
//
// Bug: Radix's DismissableLayer (the discard ConfirmDialog's own Escape handling)
// calls `preventDefault()` on the Escape it consumes but does NOT `stopPropagation()`
// (see @radix-ui/react-dismissable-layer's handleKeyDown). So with the discard dialog
// open, a single Escape keypress: (1) Radix's own listener declines the dialog, then
// (2) the SAME event still reaches EventLogSheet's document-level "Escape to cancel
// batch" listener, which — without a `defaultPrevented` guard — calls
// `handleCancelBatch()` again and re-arms the just-declined dialog, so it can never
// actually be Escape-dismissed.
//
// This test exercises the real, rendered EventLogSheet + the real themed
// ConfirmDialog (real Radix Dialog underneath — see ConfirmDialog.test.tsx for the
// matchMedia stub this also needs). Rather than depend on the precise document
// listener *registration order* between Radix's capture-phase handler and
// EventLogSheet's bubble-phase one (real, but timing-fragile across React/jsdom
// versions), it manufactures the exact condition the fix guards on: an Escape
// `keydown` whose `defaultPrevented` is already `true` by the time EventLogSheet's
// listener sees it (dispatched with `preventDefault()` already called, standing in
// for "Radix's capture listener consumed this one already"). That is the one
// documented case the guard exists for; asserting on it does not require pinning
// listener race timing that isn't the guard's own contract.

vi.mock('../../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/client')>();
  return { ...actual, apiFetch: vi.fn() };
});

// `@tanstack/react-virtual` is mocked to render every row unconditionally:
// jsdom has no layout engine, so `EventLogSheet`'s real virtualizer measures
// a zero-height scroll viewport and computes an empty visible range — a
// known test-infrastructure gap recorded in design.md's panel log. That gap
// is orthogonal to what these tests drive (filtering, sort order, the batch
// Escape guard, reveal page growth), so it's bypassed here rather than routed
// around per-test. `scrollToIndex` is the virtualizer method EventLogSheet's
// reveal effect calls once the target row's index resolves; the window-spacer
// and reveal-scroll wiring themselves are covered in
// EventLogSheet.virtualization.test.tsx against a windowing mock.
// (Spread over the real module rather than replaced: EventLogSheet also imports
// `defaultRangeExtractor` for its pinned-row `rangeExtractor`, and a
// replacement factory would hand it `undefined`.)
vi.mock('@tanstack/react-virtual', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-virtual')>()),
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
      scrollToIndex: () => {},
    };
  },
}));

// Observed by the version-conflict suite (batch and delete toasts); nothing else here reads
// toasts.
vi.mock('../../../shared/components/Toast', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../shared/components/Toast')>()),
  showToast: vi.fn(),
}));

const mockedApiFetch = vi.mocked(apiFetch);
const mockedShowToast = vi.mocked(showToast);

const SESSION_ID = 'sess-log-sheet-1';

// Dialog (via useIsMobile/breakpoints.ts) reads window.matchMedia, which jsdom does
// not implement natively (same stub as ConfirmDialog.test.tsx; guarded so it's a
// no-op if the global test setup already installs one).
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

function logEventFixture(): LogEvent {
  return {
    version: 1,
    event_id: 'ev-1',
    category: 'general',
    category_label: 'General',
    category_color: '#4488ff',
    message: 'A logged note',
    timecode: '00:00:10:00',
    timecode_total_frames: 240,
    frame_rate: 24,
    wall_time_utc: '2026-07-21T00:00:10Z',
    metadata: {},
  };
}

function statusFixture(): SessionStatus {
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
    title: 'Log sheet test session',
    deck_title: '',
    show_name: null,
    show_code: null,
    episode: '',
    session_created_at_utc: null,
    now_utc: '2026-07-21T00:00:30Z',
    notes: '',
    show_id: null,
    events_stream_revision: 1,
  };
}

function eventsFixture(): EventsResponse {
  const events = [logEventFixture()];
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
  mockedApiFetch.mockReset();
  mockedApiFetch.mockImplementation(async (path: string) => {
    if (path.includes('/status')) return statusFixture();
    if (path.includes('/show-categories')) {
      return { categories: [categoryFixture()], show_name: '', show_code: '' };
    }
    if (path === 'profile') {
      return {
        active_studio_id: '',
        active_show_id: '',
        active_studio: { id: '', name: '', categories: [] },
        studios: [],
        studio_settings: {},
        shows: [],
        new_session_defaults: { title_prefix: '', default_frame_rate: 24 },
        admin: { restart_supported: false, restart_needs_token: false },
        auth: { logged_in: false, oauth_configured: true, user: null },
      };
    }
    if (path.includes('/events')) return eventsFixture();
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

/** A real `keydown` Escape event, already marked `defaultPrevented` before dispatch —
 *  the state EventLogSheet's listener observes once Radix's own Escape consumption
 *  has already run for that same event. */
function dispatchAlreadyConsumedEscape() {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  event.preventDefault();
  act(() => {
    document.dispatchEvent(event);
  });
}

// --- Toolbar overflow clamp (auto-generate-event-logs, 6.2 fix wave / audit I1) ---
//
// The Event feed toolbar gained the AUTO GENERATE button; FeedShell's shared
// `FEED_TOOLBAR` sizes the row `flex-[0_0_auto]` (max-content), so without a
// max-width clamp its internal `flex-wrap` never engages and on narrow (390px)
// viewports the row overflowed, pushing FILTER off-viewport. The fix threads
// `toolbarClassName="max-w-full"` through FeedShell's optional prop. This test
// pins that wiring: dropping either the prop at the EventLogSheet call site or
// FeedShell's pass-through re-introduces the overflow with every gate green.
describe('EventLogSheet toolbar overflow clamp', () => {
  it('renders the feed toolbar with max-w-full so its flex-wrap can engage', async () => {
    renderSheet();

    const toolbar = await screen.findByRole('toolbar', { name: 'Event feed tools' });
    expect(toolbar.className.split(/\s+/)).toContain('max-w-full');
  });
});

// --- Loading vs. empty (paint stability) ---
//
// `isLoading`/`isEmpty` are distinct FeedTable states (FeedTable consults `isEmpty`
// only when `!isLoading`). Folding the pending flag into `isEmpty` — the old
// `sorted.length === 0 && !isPending` — rendered NEITHER row while the query was in
// flight, so the sheet body was empty on first paint and popped when rows arrived.
describe('EventLogSheet loading state', () => {
  it('renders the loading row, not the empty message, while the events query is pending', async () => {
    mockedApiFetch.mockImplementation(async (path: string) => {
      if (path.includes('/status')) return statusFixture();
      if (path.includes('/show-categories')) {
        return { categories: [categoryFixture()], show_name: '', show_code: '' };
      }
      // Never settles: `isPending` stays true for the whole assertion.
      if (path.includes('/events')) return new Promise<never>(() => {});
      throw new Error(`unexpected apiFetch call: ${path}`);
    });

    renderSheet();

    expect(await screen.findByText('Loading…')).toBeTruthy();
    expect(screen.queryByText('— No logged items yet.')).toBeNull();
  });
});

// Radix DropdownMenu opens on pointer-down or the keyboard, not on click (shadcn-port-shell B1).
function openMenu(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
}

describe('EventLogSheet filter checkmarks', () => {
  it('checked state is the checkmark + aria-checked only, and the menu stays open while toggling', async () => {
    renderSheet();

    openMenu(await screen.findByRole('button', { name: 'Filter' }));
    expect(await screen.findByRole('menu', { name: 'Filter' })).toBeTruthy();
    const general = await screen.findByRole('menuitemcheckbox', { name: 'General' });
    const internal = screen.getByRole('menuitemcheckbox', { name: 'Internal' });

    expect(general.getAttribute('aria-checked')).toBe('true');
    expect(internal.getAttribute('aria-checked')).toBe('true');
    expect(general.querySelector('[data-testid="filter-check"]')).toBeTruthy();
    expect(internal.querySelector('[data-testid="filter-check"]')).toBeTruthy();
    // The label keeps the show-category color (fixture General = #4488ff).
    expect(within(general).getByText('General').getAttribute('style')).toContain(
      'color: rgb(68, 136, 255)',
    );

    fireEvent.click(general);
    // Still open (toggling several categories is one gesture), now unchecked, no checkmark.
    expect(screen.getByRole('menu', { name: 'Filter' })).toBeTruthy();
    const generalAfter = screen.getByRole('menuitemcheckbox', { name: 'General' });
    expect(generalAfter.getAttribute('aria-checked')).toBe('false');
    expect(generalAfter.querySelector('[data-testid="filter-check"]')).toBeNull();

    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Internal' }));
    expect((document.getElementById('show-internal-log') as HTMLInputElement).checked).toBe(false);
  });
});

describe('EventLogSheet time display menu', () => {
  it('opens by keyboard as a radio menu and switches the time display', async () => {
    renderSheet();

    const trigger = await screen.findByRole('button', { name: 'Time display' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(await screen.findByRole('menu', { name: 'Time display' })).toBeTruthy();
    const session = screen.getByRole('menuitemradio', { name: 'Session Time' });
    const world = screen.getByRole('menuitemradio', { name: 'World Clock' });
    expect(session.getAttribute('aria-checked')).toBe('true');
    expect(world.getAttribute('aria-checked')).toBe('false');
    expect((document.getElementById('view-utc-log') as HTMLInputElement).checked).toBe(false);

    fireEvent.click(world);
    expect(screen.queryByRole('menu', { name: 'Time display' })).toBeNull();
    expect((document.getElementById('view-utc-log') as HTMLInputElement).checked).toBe(true);
  });
});

describe('EventLogSheet menu Escape vs batch mode (A5)', () => {
  it('Escape in an open menu closes the menu without arming the discard dialog', async () => {
    renderSheet();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete row' }));

    openMenu(screen.getByRole('button', { name: 'Filter' }));
    const menu = await screen.findByRole('menu', { name: 'Filter' });
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: 'Filter' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Discard changes' })).toBeNull();
  });
});

describe('EventLogSheet category filter', () => {
  it('lists every show category and hides matching rows when deselected', async () => {
    mockedApiFetch.mockImplementation(async (path: string) => {
      if (path.includes('/status')) return statusFixture();
      if (path.includes('/show-categories')) {
        return {
          categories: [
            categoryFixture(),
            {
              id: 'slate',
              label: 'Slate',
              color: '#112233',
              type: 'BUTTON',
              dropdown_options: [],
              on_label: '',
              off_label: '',
            },
          ],
          show_name: '',
          show_code: '',
        };
      }
      if (path.includes('/events')) {
        return {
          events: [
            logEventFixture(),
            {
              ...logEventFixture(),
              event_id: 'ev-2',
              category: 'slate',
              category_label: 'Slate',
              message: 'Mark',
            },
          ],
          total: 2,
          logged_event_count: 2,
          offset: 0,
          limit: 200,
        };
      }
      throw new Error(`unexpected apiFetch call: ${path}`);
    });

    renderSheet();

    openMenu(await screen.findByRole('button', { name: 'Filter' }));
    expect(await screen.findByRole('menuitemcheckbox', { name: 'General' })).toBeTruthy();
    expect(screen.getByRole('menuitemcheckbox', { name: 'Slate' })).toBeTruthy();
    expect(screen.getByText('A logged note')).toBeTruthy();
    expect(screen.getByText('Mark')).toBeTruthy();

    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'General' }));
    expect(screen.queryByText('A logged note')).toBeNull();
    expect(screen.getByText('Mark')).toBeTruthy();
  });
});

describe('EventLogSheet batch-mode Escape (discard-confirm guard)', () => {
  it('does not re-arm the discard dialog for an Escape whose default is already prevented', async () => {
    renderSheet();

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));

    // Mark a row for delete so the batch is dirty — handleCancelBatch only opens
    // the discard confirm when there are unsaved changes.
    fireEvent.click(await screen.findByRole('button', { name: 'Delete row' }));

    // A real (not pre-prevented) Escape opens the discard-confirm dialog. The
    // dialog's title heading and its confirm button both read "Discard changes"
    // (ConfirmDialogProps.confirmLabel defaults to the title's own wording here),
    // so the heading role disambiguates from the button.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(await screen.findByRole('heading', { name: 'Discard changes' })).toBeTruthy();

    // Decline it (mirrors what Radix's own Escape handling does internally:
    // dismiss without discarding).
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('heading', { name: 'Discard changes' })).toBeNull();

    // The batch is still dirty (decline doesn't clear pendingDeleteIds/batchEdits) and
    // batchEditMode is still on, so a buggy (unguarded) handler would treat this next
    // Escape as fresh input and re-open the dialog. A guarded handler bails on
    // `e.defaultPrevented` and leaves it closed.
    dispatchAlreadyConsumedEscape();

    expect(screen.queryByRole('heading', { name: 'Discard changes' })).toBeNull();
  });
});

// --- Default sort: oldest-first (owner decision 2026-08-06, PR#4 review) ---
//
// All three feeds default to ascending time — the log reads top-down like a
// sheet. Nothing else pins the direction (visual shots mask timestamps), so a
// silent flip back to newest-first would ship with every gate green.
describe('EventLogSheet default sort', () => {
  it('defaults to Session Time ascending: oldest event renders first', async () => {
    const older = logEventFixture();
    const newer: LogEvent = {
      ...logEventFixture(),
      event_id: 'ev-2',
      message: 'A newer note',
      timecode: '00:00:20:00',
      timecode_total_frames: 480,
      wall_time_utc: '2026-07-21T00:00:20Z',
    };
    mockedApiFetch.mockImplementation(async (path: string) => {
      if (path.includes('/status')) return statusFixture();
      if (path.includes('/show-categories')) {
        return { categories: [categoryFixture()], show_name: '', show_code: '' };
      }
      if (path.includes('/events')) {
        // Serve newest-first so the asserted order can only come from the
        // sheet's own default sort, not the wire order.
        return { events: [newer, older], total: 2, logged_event_count: 2, offset: 0, limit: 200 };
      }
      throw new Error(`unexpected apiFetch call: ${path}`);
    });
    renderSheet();

    await screen.findByText('A newer note');
    const timeHeader = screen.getByRole('columnheader', { name: 'Session Time' });
    expect(timeHeader.getAttribute('aria-sort')).toBe('ascending');
    const rowIds = Array.from(document.querySelectorAll('tr[data-event-id]')).map((tr) =>
      tr.getAttribute('data-event-id'),
    );
    expect(rowIds.indexOf('ev-1')).toBeLessThan(rowIds.indexOf('ev-2'));
  });
});

// --- Timeline marker reveal grows the loaded page (PR#4 review fix) ---
//
// Markers derive from the workspace-wide events query, but the sheet mounts
// only its oldest `loadedLimit` (200) rows. A reveal targeting a newer event
// used to find no row and silently do nothing. The sheet now listens for
// REVEAL_EVENT and grows `loadedLimit` just enough to cover the target.
describe('EventLogSheet marker reveal page growth', () => {
  // The pagination-sentinel effect only mounts an observer when more rows
  // exist than are loaded — the multi-page fixture below is the first test
  // here to reach it, and jsdom has no IntersectionObserver.
  beforeAll(() => {
    if (typeof window.IntersectionObserver !== 'undefined') return;
    class StubIntersectionObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    window.IntersectionObserver =
      StubIntersectionObserver as unknown as typeof IntersectionObserver;
  });

  function manyEventsFixture(count: number): LogEvent[] {
    return Array.from({ length: count }, (_, i) => ({
      version: 1,
      event_id: `ev-${i}`,
      category: 'general',
      category_label: 'General',
      category_color: '#4488ff',
      message: `note ${i}`,
      timecode: '00:00:10:00',
      timecode_total_frames: 240 + i * 24,
      frame_rate: 24,
      wall_time_utc: new Date(Date.UTC(2026, 6, 21, 0, 0, 10 + i)).toISOString(),
      metadata: {},
    }));
  }

  it('renders a revealed row beyond the initial window without a second fetch', async () => {
    const all = manyEventsFixture(250);
    mockedApiFetch.mockImplementation(async (path: string) => {
      if (path.includes('/status')) return statusFixture();
      if (path.includes('/show-categories')) {
        return { categories: [categoryFixture()], show_name: '', show_code: '' };
      }
      if (path.includes('/events')) {
        const limit = Number(new URLSearchParams(path.split('?')[1] ?? '').get('limit') ?? 200);
        return {
          events: all.slice(0, limit),
          total: all.length,
          logged_event_count: all.length,
          offset: 0,
          limit,
        };
      }
      throw new Error(`unexpected apiFetch call: ${path}`);
    });
    renderSheet();

    // First page only: the target row does not exist yet.
    await screen.findByText('note 0');
    expect(document.querySelector('tr[data-event-id="ev-249"]')).toBeNull();

    act(() => {
      document.body.dispatchEvent(
        new CustomEvent('autologger:reveal-event', { detail: { eventId: 'ev-249' } }),
      );
    });

    // The sheet grows its RENDER window to cover index 249; the rows were
    // already fetched, so no new request is issued.
    await screen.findByText('note 249');
    expect(document.querySelector('tr[data-event-id="ev-249"]')).toBeTruthy();

    // The regression this guards: `loadedLimit` used to be passed to
    // `useEvents` as the query `limit`, which is part of the React Query key.
    // Growing the window therefore minted a second (then third, …) cache entry
    // and re-fetched rows the workspace query had already loaded — the exact
    // divergence `useEvents.ts`'s header forbids. Assert the sheet issues
    // events requests at exactly one limit, and that it is the shared one.
    const eventsLimits = new Set(
      mockedApiFetch.mock.calls
        .map(([p]) => (typeof p === 'string' ? p : ''))
        .filter((p) => p.includes('/events?'))
        .map((p) => new URLSearchParams(p.split('?')[1] ?? '').get('limit')),
    );
    expect([...eventsLimits]).toEqual([String(WORKSPACE_EVENTS_LIMIT)]);
  });
});

// --- Feed count matches the rows shown (redesign-show-ignition D7, task 5.1) ---
//
// web-session-console "Feed count matches the rows shown": the heading counts the
// whole filtered FETCHED set (before the `loadedLimit` render window), never
// `logged_event_count`, which excludes internal events. A `+` follows when the
// session holds more events than the workspace fetches (`total` > fetched).
describe('EventLogSheet feed count', () => {
  beforeAll(() => {
    if (typeof window.IntersectionObserver !== 'undefined') return;
    class StubIntersectionObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    window.IntersectionObserver =
      StubIntersectionObserver as unknown as typeof IntersectionObserver;
  });

  function rowsFixture(count: number, category = 'general', from = 0): LogEvent[] {
    return Array.from({ length: count }, (_, j) => {
      const i = from + j;
      return {
        version: 1,
        event_id: `ev-${i}`,
        category,
        category_label: category === 'internal' ? 'Internal' : 'General',
        category_color: '#4488ff',
        message: `note ${i}`,
        timecode: '00:00:10:00',
        timecode_total_frames: 240 + i * 24,
        frame_rate: 24,
        wall_time_utc: new Date(Date.UTC(2026, 6, 21, 0, 0, 10 + i)).toISOString(),
        metadata: {},
      };
    });
  }

  function serve(events: LogEvent[], total = events.length, logged = events.length) {
    mockedApiFetch.mockImplementation(async (path: string) => {
      if (path.includes('/status')) return statusFixture();
      if (path.includes('/show-categories')) {
        return { categories: [categoryFixture()], show_name: '', show_code: '' };
      }
      if (path.includes('/events')) {
        return { events, total, logged_event_count: logged, offset: 0, limit: 2000 };
      }
      throw new Error(`unexpected apiFetch call: ${path}`);
    });
  }

  const heading = () => document.getElementById('v5-event-feed-head') as HTMLElement;

  it('counts internal events while shown and drops them in the same render when hidden', async () => {
    serve([...rowsFixture(2), ...rowsFixture(8, 'internal', 2)], 10, 2);
    renderSheet();
    await screen.findByText('note 9');
    expect(heading().textContent).toBe('10 events');

    openMenu(screen.getByRole('button', { name: 'Filter' }));
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Internal' }));
    expect(heading().textContent).toBe('2 events');
    expect(screen.queryByText('note 9')).toBeNull();
  });

  it('counts the whole fetched set, not the 200 rows paged into the window', async () => {
    serve(rowsFixture(450));
    renderSheet();
    await screen.findByText('note 0');
    // Only the first page is rendered…
    expect(document.querySelector('tr[data-event-id="ev-449"]')).toBeNull();
    // …but the heading counts every fetched row the filters select.
    expect(heading().textContent).toBe('450 events');
  });

  it('adds a trailing + when the session has more events than the workspace fetches', async () => {
    serve(rowsFixture(WORKSPACE_EVENTS_LIMIT), 2600, 2600);
    renderSheet();
    await screen.findByText('note 0');
    expect(heading().textContent).toBe('2000+ events');
  });

  it('uses the singular for one event', async () => {
    renderSheet();
    await screen.findByText('A logged note');
    expect(heading().textContent).toBe('1 event');
  });
});

// --- Version conflicts on batch save and delete (session-edit-conflicts task 6.2, D3/D9) ---
//
// A stateful server of three rows with 7c-1's version check: a stale `version`
// on PUT, or `?version=` on DELETE, is refused with the 409 carrying `current`.
// `otherPersonEdits` is another operator's save.
describe('EventLogSheet batch and delete version conflicts', () => {
  let rows: LogEvent[] = [];
  /** Ids whose next PUT/DELETE fails with a plain 500. */
  let failFor = new Set<string>();

  function rowFixture(n: number): LogEvent {
    return {
      ...logEventFixture(),
      event_id: `ev-${n}`,
      message: `note ${n}`,
      timecode: `00:00:1${n}:00`,
      timecode_total_frames: 240 + n * 24,
      wall_time_utc: `2026-07-21T00:00:1${n}Z`,
    };
  }

  function otherPersonEdits(eventId: string, patch: Partial<LogEvent>) {
    rows = rows.map((r) =>
      r.event_id === eventId ? { ...r, ...patch, version: r.version + 1 } : r,
    );
  }

  function conflict(current: LogEvent): ApiError {
    return new ApiError(409, 'Version conflict.', { detail: 'Version conflict.', current });
  }

  beforeEach(() => {
    rows = [rowFixture(1), rowFixture(2), rowFixture(3)];
    failFor = new Set();
    mockedShowToast.mockReset();
    mockedApiFetch.mockImplementation(async (path: string, opts: RequestInit = {}) => {
      if (path.includes('/status')) return statusFixture();
      if (path.includes('/show-categories')) {
        return { categories: [categoryFixture()], show_name: '', show_code: '' };
      }
      const m = /\/events\/([^?]+)(\?.*)?$/.exec(path);
      if (m && (opts.method === 'PUT' || opts.method === 'DELETE')) {
        const eventId = m[1];
        if (failFor.delete(eventId)) throw new ApiError(500, 'Server exploded.');
        const current = rows.find((r) => r.event_id === eventId);
        if (!current) throw new ApiError(404, 'Event not found.', { detail: 'Event not found.' });
        if (opts.method === 'PUT') {
          const body = JSON.parse(String(opts.body)) as Partial<LogEvent> & { version?: number };
          if (body.version !== undefined && body.version !== current.version) {
            throw conflict(current);
          }
          const updated = {
            ...current,
            message: body.message ?? current.message,
            version: current.version + 1,
          };
          rows = rows.map((r) => (r.event_id === eventId ? updated : r));
          return updated;
        }
        const q = new URLSearchParams(m[2]?.slice(1) ?? '');
        const v = q.get('version');
        if (v !== null && Number(v) !== current.version) throw conflict(current);
        rows = rows.filter((r) => r.event_id !== eventId);
        return { ok: true };
      }
      if (path.includes('/events')) {
        return {
          events: rows,
          total: rows.length,
          logged_event_count: rows.length,
          offset: 0,
          limit: 200,
          has_auto_generated: false,
        };
      }
      throw new Error(`unexpected apiFetch call: ${path}`);
    });
  });

  function renderWithClient() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderStrict(
      <QueryClientProvider client={client}>
        <TooltipProvider delayDuration={400}>
          <EventLogSheet sessionId={SESSION_ID} />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    return client;
  }

  function writes(method: 'PUT' | 'DELETE'): string[] {
    return mockedApiFetch.mock.calls
      .filter(([, opts]) => (opts as RequestInit | undefined)?.method === method)
      .map(([path]) => String(path));
  }

  function putBodies(): Array<Record<string, unknown>> {
    return mockedApiFetch.mock.calls
      .filter(([, opts]) => (opts as RequestInit | undefined)?.method === 'PUT')
      .map(([, opts]) => JSON.parse(String((opts as RequestInit).body)));
  }

  function rowEl(eventId: string): HTMLElement {
    const el = document.querySelector<HTMLElement>(`tr[data-event-id="${eventId}"]`);
    if (!el) throw new Error(`row ${eventId} is not mounted`);
    return el;
  }

  async function enterBatch() {
    await waitFor(() => expect(rowEl('ev-1')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await waitFor(() => expect(within(rowEl('ev-1')).getByLabelText('Message')).toBeTruthy());
  }

  function batchType(eventId: string, value: string) {
    fireEvent.change(within(rowEl(eventId)).getByLabelText('Message'), { target: { value } });
  }

  async function saveBatch() {
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    });
  }

  async function choose(name: 'Overwrite' | 'Keep theirs' | 'Delete anyway') {
    await screen.findByRole('alertdialog', { name: 'Row changed' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name }));
    });
  }

  async function settle() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  const inBatchMode = () => screen.queryByRole('button', { name: 'Save changes' }) !== null;

  it('a batch of three with a conflict on the second, Keep theirs: the third still saves and batch mode ends', async () => {
    renderWithClient();
    await enterBatch();
    batchType('ev-1', 'mine 1');
    batchType('ev-2', 'mine 2');
    batchType('ev-3', 'mine 3');
    otherPersonEdits('ev-2', { message: 'theirs 2' });

    await saveBatch();
    await choose('Keep theirs');

    await waitFor(() => expect(inBatchMode()).toBe(false));
    expect(rows.map((r) => r.message)).toEqual(['mine 1', 'theirs 2', 'mine 3']);
    expect(putBodies().map((b) => [b.message, b.version])).toEqual([
      ['mine 1', 1],
      ['mine 2', 1],
      ['mine 3', 1],
    ]);
    expect(mockedShowToast).toHaveBeenCalledWith('Changes saved, 1 kept theirs.');
  });

  it('a 500 on the second stops the batch, and a second Save sends only the unsettled rows', async () => {
    renderWithClient();
    await enterBatch();
    batchType('ev-1', 'mine 1');
    batchType('ev-2', 'mine 2');
    batchType('ev-3', 'mine 3');
    failFor.add('ev-2');

    await saveBatch();
    await waitFor(() => expect(mockedShowToast).toHaveBeenCalledWith('Server exploded.', true));
    expect(inBatchMode()).toBe(true);
    expect(writes('PUT')).toHaveLength(2);

    await saveBatch();
    await waitFor(() => expect(inBatchMode()).toBe(false));
    const sent = writes('PUT').map((p) => p.split('/events/')[1]);
    expect(sent).toEqual(['ev-1', 'ev-2', 'ev-2', 'ev-3']);
    expect(rows.map((r) => r.message)).toEqual(['mine 1', 'mine 2', 'mine 3']);
  });

  it('dismissing a batch conflict stops the batch and keeps the rest', async () => {
    renderWithClient();
    await enterBatch();
    batchType('ev-1', 'mine 1');
    batchType('ev-2', 'mine 2');
    batchType('ev-3', 'mine 3');
    otherPersonEdits('ev-2', { message: 'theirs 2' });

    await saveBatch();
    const d = await screen.findByRole('alertdialog', { name: 'Row changed' });
    await act(async () => {
      fireEvent.keyDown(d, { key: 'Escape' });
    });
    await settle();

    expect(inBatchMode()).toBe(true);
    expect(writes('PUT')).toHaveLength(2);
    expect(rows.map((r) => r.message)).toEqual(['mine 1', 'theirs 2', 'note 3']);
    // The unsettled rows still hold the operator's batch text.
    expect((within(rowEl('ev-2')).getByLabelText('Message') as HTMLInputElement).value).toBe(
      'mine 2',
    );
    expect((within(rowEl('ev-3')).getByLabelText('Message') as HTMLInputElement).value).toBe(
      'mine 3',
    );
    expect(mockedShowToast).toHaveBeenCalledWith(expect.any(String), true);
  });

  it('a pending batch delete that conflicts, then Delete anyway, sends ?version=N&overwrite=1', async () => {
    renderWithClient();
    await enterBatch();
    fireEvent.click(within(rowEl('ev-2')).getByRole('button', { name: 'Delete row' }));
    otherPersonEdits('ev-2', { message: 'theirs 2' });

    await saveBatch();
    await choose('Delete anyway');

    await waitFor(() => expect(inBatchMode()).toBe(false));
    expect(writes('DELETE')).toEqual([
      `sessions/${SESSION_ID}/events/ev-2?version=1`,
      `sessions/${SESSION_ID}/events/ev-2?version=2&overwrite=1`,
    ]);
    expect(rows.map((r) => r.event_id)).toEqual(['ev-1', 'ev-3']);
  });

  it('a non-batch delete conflict, then Keep theirs: the row stays', async () => {
    renderWithClient();
    await screen.findByText('note 2');
    otherPersonEdits('ev-2', { message: 'theirs 2' });

    fireEvent.click(within(rowEl('ev-2')).getByRole('button', { name: 'Delete row' }));
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    });
    await choose('Keep theirs');
    await settle();

    expect(writes('DELETE')).toEqual([`sessions/${SESSION_ID}/events/ev-2?version=1`]);
    expect(rows.map((r) => r.event_id)).toEqual(['ev-1', 'ev-2', 'ev-3']);
    await screen.findByText('theirs 2');
  });

  it('a non-batch delete conflict, then Delete anyway: ?version=N&overwrite=1 and the row is removed', async () => {
    renderWithClient();
    await screen.findByText('note 2');
    otherPersonEdits('ev-2', { message: 'theirs 2' });

    fireEvent.click(within(rowEl('ev-2')).getByRole('button', { name: 'Delete row' }));
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    });
    await choose('Delete anyway');
    await settle();

    expect(writes('DELETE')).toEqual([
      `sessions/${SESSION_ID}/events/ev-2?version=1`,
      `sessions/${SESSION_ID}/events/ev-2?version=2&overwrite=1`,
    ]);
    expect(rows.map((r) => r.event_id)).toEqual(['ev-1', 'ev-3']);
    await waitFor(() => expect(document.querySelector('tr[data-event-id="ev-2"]')).toBeNull());
  });

  it('a batch interrupted by a session switch shows no "Save stopped" toast', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tree = (sessionId: string) => (
      <StrictWrapper>
        <QueryClientProvider client={client}>
          <TooltipProvider delayDuration={400}>
            <EventLogSheet sessionId={sessionId} />
          </TooltipProvider>
        </QueryClientProvider>
      </StrictWrapper>
    );
    const { rerender } = render(tree(SESSION_ID));
    await enterBatch();
    batchType('ev-1', 'mine 1');
    batchType('ev-2', 'mine 2');
    otherPersonEdits('ev-1', { message: 'theirs 1' });

    await saveBatch();
    await screen.findByRole('alertdialog', { name: 'Row changed' });
    // The operator switches session with the batch's prompt open.
    await act(async () => {
      rerender(tree('sess-other'));
    });
    await settle();

    expect(screen.queryByRole('alertdialog', { name: 'Row changed' })).toBeNull();
    expect(writes('PUT')).toHaveLength(1);
    expect(mockedShowToast).not.toHaveBeenCalled();
  });

  it('a delete that 404s shows the existing message and no dialog', async () => {
    renderWithClient();
    await screen.findByText('note 2');
    rows = rows.filter((r) => r.event_id !== 'ev-2');

    fireEvent.click(within(rowEl('ev-2')).getByRole('button', { name: 'Delete row' }));
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    });
    await waitFor(() => expect(mockedShowToast).toHaveBeenCalledWith('Event not found.', true));
    expect(screen.queryByRole('alertdialog', { name: 'Row changed' })).toBeNull();
  });

  it('another person’s change that lands before the operator touches a row: batch edit, batch delete and non-batch delete send no prompt', async () => {
    const client = renderWithClient();
    await screen.findByText('note 1');
    otherPersonEdits('ev-1', { message: 'theirs 1' });
    otherPersonEdits('ev-2', { message: 'theirs 2' });
    otherPersonEdits('ev-3', { message: 'theirs 3' });
    await act(async () => {
      await client.invalidateQueries();
    });
    await screen.findByText('theirs 3');

    // Non-batch delete of ev-3.
    fireEvent.click(within(rowEl('ev-3')).getByRole('button', { name: 'Delete row' }));
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    });
    await waitFor(() => expect(rows.map((r) => r.event_id)).toEqual(['ev-1', 'ev-2']));

    // Batch edit of ev-1 and batch delete of ev-2.
    await enterBatch();
    batchType('ev-1', 'mine 1');
    fireEvent.click(within(rowEl('ev-2')).getByRole('button', { name: 'Delete row' }));
    await saveBatch();
    await waitFor(() => expect(inBatchMode()).toBe(false));

    expect(screen.queryByRole('alertdialog', { name: 'Row changed' })).toBeNull();
    expect(writes('DELETE')).toEqual([
      `sessions/${SESSION_ID}/events/ev-3?version=2`,
      `sessions/${SESSION_ID}/events/ev-2?version=2`,
    ]);
    expect(putBodies()).toEqual([expect.objectContaining({ message: 'mine 1', version: 2 })]);
    expect(rows.map((r) => [r.event_id, r.message])).toEqual([['ev-1', 'mine 1']]);
  });
});

// Finish review fix round 1: below md the feed drops the Event column (the category folds under
// the timecode in each row), so the table fits a 390px card with no sideways scroll.
describe('EventLogSheet on phones', () => {
  it('has no Event column header and folds each row to three cells', async () => {
    const original = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(max-width: 767px)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    try {
      renderSheet();
      await screen.findByText('A logged note');
      expect(screen.queryByRole('columnheader', { name: 'Event' })).toBeNull();
      expect(screen.getByRole('columnheader', { name: 'Message' })).not.toBeNull();
      const row = document.querySelector('tr[data-event-id="ev-1"]') as HTMLTableRowElement;
      expect(row.querySelectorAll(':scope > td')).toHaveLength(3);
    } finally {
      window.matchMedia = original;
    }
  });
});
