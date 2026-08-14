import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, screen } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../../../api/client';
import { WORKSPACE_EVENTS_LIMIT } from '../../../api/hooks/useEvents';
import type { Category, EventsResponse, LogEvent, SessionStatus } from '../../../api/types';
import { TooltipProvider } from '../../../shared/ui/Tooltip';
import { renderStrict } from '../../../test/renderStrict';
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
      scrollToIndex: () => {},
    };
  },
}));

const mockedApiFetch = vi.mocked(apiFetch);

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
        auth: { logged_in: false, oauth_configured: false, user: null },
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

describe('EventLogSheet filter checkmarks', () => {
  it('shows checkmarks for enabled rows without the PopoverItem selected tint', async () => {
    renderSheet();

    fireEvent.click(await screen.findByRole('button', { name: 'Filter' }));
    const general = await screen.findByRole('menuitemcheckbox', { name: 'General' });
    const internal = screen.getByRole('menuitemcheckbox', { name: 'Internal' });

    expect(general.getAttribute('aria-checked')).toBe('true');
    expect(internal.getAttribute('aria-checked')).toBe('true');
    expect(general.querySelector('[data-testid="filter-check"]')).toBeTruthy();
    expect(internal.querySelector('[data-testid="filter-check"]')).toBeTruthy();
    expect(general.className).not.toContain(' bg-[rgba(56,189,248,0.14)]');
    expect(general.className).toContain('aria-checked:!bg-transparent');
    // Category label uses the show-category color (fixture General = #4488ff).
    expect((general.querySelector('span.flex') as HTMLElement | null)?.style.color).toBe(
      'rgb(68, 136, 255)',
    );

    fireEvent.click(general);
    expect(general.getAttribute('aria-checked')).toBe('false');
    expect(general.querySelector('[data-testid="filter-check"]')).toBeNull();
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

    fireEvent.click(await screen.findByRole('button', { name: 'Filter' }));
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
