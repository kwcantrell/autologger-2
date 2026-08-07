import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, screen } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../../../api/client';
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
  return { events, total: events.length, logged_event_count: events.length, offset: 0, limit: 200 };
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

  it('loads and renders a revealed row beyond the first 200-row page', async () => {
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

    // The sheet grows loadedLimit to the next 200 step covering index 249 (400)
    // and the row renders once that page resolves.
    await screen.findByText('note 249');
    expect(document.querySelector('tr[data-event-id="ev-249"]')).toBeTruthy();
    expect(
      mockedApiFetch.mock.calls.some(([p]) => typeof p === 'string' && p.includes('limit=400')),
    ).toBe(true);
  });
});
