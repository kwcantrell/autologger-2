import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch } from '../../../api/client';
import type {
  Category,
  EventsResponse,
  SessionStatus,
  ShowCategoriesResponse,
} from '../../../api/types';
import { renderStrict, StrictWrapper } from '../../../test/renderStrict';
import { EventLogSheet } from './EventLogSheet';

// --- Event feed AUTO GENERATE behavior pins (auto-generate-event-logs task 5.1,
// design D9) — mirrors generateLatch.test.tsx for the shared machinery, plus the
// two behaviors unique to this feed:
//
//  1. 503 latch (delta spec, MODIFIED "Honest capability gating"): latches per
//     MOUNTED panel — persists across a session switch within the mount, cleared
//     only by a remount (reload); reason names the missing integration and the
//     reload remedy; manual-alternative empty-state copy appears.
//  2. 409 (busy slot) renders the SERVER's detail verbatim, inline, retryable —
//     never latched (spec "Busy slot is retryable, not latched").
//  3. Success renders the created count inline (`role="status"`, single
//     channel); `cap_hit` adds "per-run cap reached" wording.
//  4. `auto_instructions_present: false` makes the control non-actionable with
//     a DISTINCT keyboard-reachable reason pointing at Settings (spec "No
//     instructions configured") — not the 503 latch.
//  5. Run/outcome state is scoped to the STARTING session across this
//     mounted-hidden unkeyed panel (spec "Session switch mid-run does not leak
//     state").

vi.mock('../../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/client')>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);
const SESSION_A = 'sess-evgen-a';
const SESSION_B = 'sess-evgen-b';

// Dialog (via useConfirm → useIsMobile/breakpoints.ts) reads window.matchMedia,
// which jsdom does not implement natively (same guarded stub as
// EventLogSheet.test.tsx).
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

function showCategoriesFixture(instructionsPresent: boolean): ShowCategoriesResponse {
  return {
    categories: [categoryFixture()],
    show_name: '',
    show_code: '',
    auto_instructions_present: instructionsPresent,
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
    event_count: 0,
    logged_event_count: 0,
    title: 'Event generate test session',
    deck_title: '',
    show_name: null,
    show_code: null,
    episode: '',
    session_created_at_utc: null,
    now_utc: '2026-07-29T00:00:30Z',
    notes: '',
    show_id: null,
    events_stream_revision: 1,
  };
}

function emptyEventsFixture(): EventsResponse {
  return { events: [], total: 0, logged_event_count: 0, offset: 0, limit: 200 };
}

/** Routes the sheet's reads for ANY session id; `POST …/events/generate` runs
 * `generateImpl` and is counted. */
function mockRoutes(
  generateImpl: () => Promise<unknown>,
  opts: { instructionsPresent?: boolean } = {},
): { count: number } {
  const calls = { count: 0 };
  mockedApiFetch.mockImplementation(async (path: string) => {
    if (path.includes('/events/generate')) {
      calls.count += 1;
      return generateImpl();
    }
    if (path.includes('/status')) return statusFixture();
    if (path.includes('/show-categories')) {
      return showCategoriesFixture(opts.instructionsPresent ?? true);
    }
    if (path.includes('/events')) return emptyEventsFixture();
    throw new Error(`unexpected apiFetch call: ${path}`);
  });
  return calls;
}

function sheetFor(client: QueryClient, sessionId: string) {
  return (
    <QueryClientProvider client={client}>
      <EventLogSheet sessionId={sessionId} />
    </QueryClientProvider>
  );
}

/** Renders the sheet and returns a `switchSession` that RERENDERS the same
 * mounted instance with a new `sessionId` prop — the mounted-hidden unkeyed
 * panel shape (SessionWorkspace keeps one EventLogSheet across switches). */
function renderSheet(sessionId: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = renderStrict(sheetFor(client, sessionId));
  return {
    ...utils,
    switchSession: (next: string) =>
      utils.rerender(<StrictWrapper>{sheetFor(client, next)}</StrictWrapper>),
  };
}

function generateButton(): HTMLElement {
  return screen.getByRole('button', { name: /Auto Generate|Generating…/ });
}

beforeEach(() => {
  mockedApiFetch.mockReset();
});

describe('event feed — AUTO GENERATE 503 latch (honest capability gating)', () => {
  it('latches on the first 503, persists across a session switch within the mount, clears only on remount', async () => {
    const calls = mockRoutes(() => Promise.reject(new ApiError(503, 'Service Unavailable')));
    const { switchSession, unmount } = renderSheet(SESSION_A);

    fireEvent.click(await screen.findByRole('button', { name: 'Auto Generate' }));

    // Latched: still a real focusable button (no `disabled` attribute), marked
    // aria-disabled, described by the always-visible reason span naming the
    // missing integration and the reload remedy.
    await waitFor(() => expect(generateButton().getAttribute('aria-disabled')).toBe('true'));
    const latched = generateButton();
    expect(latched.hasAttribute('disabled')).toBe(false);
    const reasonId = latched.getAttribute('aria-describedby');
    expect(reasonId).toBeTruthy();
    const reason = document.getElementById(reasonId as string);
    expect(reason?.textContent).toMatch(/no integration configured/);
    expect(reason?.textContent).toMatch(/[Rr]eload/);
    expect(calls.count).toBe(1);

    // Single channel: the latch replaces any one-off error alert.
    expect(screen.queryByRole('alert')).toBeNull();
    // Empty-state copy names cause + remedy + the manual alternative.
    expect(screen.getByText(/log events manually with the event buttons/)).toBeTruthy();

    // Clicks no-op while latched.
    fireEvent.click(latched);
    fireEvent.click(latched);
    expect(calls.count).toBe(1);

    // The latch is PER MOUNTED PANEL: switching sessions on the same mounted
    // instance keeps it latched, and clicking still never re-calls generate.
    switchSession(SESSION_B);
    await waitFor(() => expect(generateButton().getAttribute('aria-disabled')).toBe('true'));
    fireEvent.click(generateButton());
    expect(calls.count).toBe(1);

    // A REMOUNT (page reload) clears it: a fresh instance is actionable again.
    unmount();
    renderSheet(SESSION_A);
    const fresh = await screen.findByRole('button', { name: 'Auto Generate' });
    expect(fresh.getAttribute('aria-disabled')).toBeNull();
  });
});

describe('event feed — AUTO GENERATE non-503 outcomes (single inline channel)', () => {
  it('renders the server 409 busy detail verbatim, retryable, NOT latched', async () => {
    const busyDetail =
      'A turn (AI chat, AI v2, topic generation, or event generation) is already in progress for this session; ' +
      'wait for it to finish before generating events. These features share one per-session AI slot by design.';
    const calls = mockRoutes(() => Promise.reject(new ApiError(409, busyDetail)));
    renderSheet(SESSION_A);

    fireEvent.click(await screen.findByRole('button', { name: 'Auto Generate' }));

    // The SERVER's detail, verbatim (never a client-derived holder list).
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(busyDetail);
    expect(generateButton().getAttribute('aria-disabled')).toBeNull();
    expect(calls.count).toBe(1);

    // Not latched: a retry goes back to the network.
    fireEvent.click(generateButton());
    await waitFor(() => expect(calls.count).toBe(2));
  });

  it('renders other non-503 failures inline with the server detail, unlatched', async () => {
    const calls = mockRoutes(() => Promise.reject(new ApiError(502, 'generation failed upstream')));
    renderSheet(SESSION_A);

    fireEvent.click(await screen.findByRole('button', { name: 'Auto Generate' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('generation failed upstream');
    expect(generateButton().getAttribute('aria-disabled')).toBeNull();
    expect(calls.count).toBe(1);
  });

  it('renders the created count inline on success', async () => {
    mockRoutes(() => Promise.resolve({ created: 3, cap_hit: false }));
    renderSheet(SESSION_A);

    fireEvent.click(await screen.findByRole('button', { name: 'Auto Generate' }));

    // (Queried by text: FeedShell's count heading is itself a `role="status"`
    // live region, so the role alone is ambiguous.)
    const status = await screen.findByText('Created 3 events.');
    expect(status.getAttribute('role')).toBe('status');
    // Success is not an error: single channel, no alert, still actionable.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(generateButton().getAttribute('aria-disabled')).toBeNull();
  });

  it('notes the per-run cap when cap_hit is true (never "cut off" wording)', async () => {
    mockRoutes(() => Promise.resolve({ created: 200, cap_hit: true }));
    renderSheet(SESSION_A);

    fireEvent.click(await screen.findByRole('button', { name: 'Auto Generate' }));

    const status = await screen.findByText(/Created 200 events/);
    expect(status.getAttribute('role')).toBe('status');
    expect(status.textContent).toMatch(/per-run cap reached/);
    expect(status.textContent).not.toMatch(/cut off/i);
  });
});

describe('event feed — no-instructions gate (auto_instructions_present: false)', () => {
  it('is non-actionable with a distinct reason pointing at the Settings event-buttons table', async () => {
    const calls = mockRoutes(() => Promise.resolve({ created: 0, cap_hit: false }), {
      instructionsPresent: false,
    });
    renderSheet(SESSION_A);

    // Once show-categories resolves with `false`, the control gates.
    await waitFor(() => expect(generateButton().getAttribute('aria-disabled')).toBe('true'));
    const gated = generateButton();
    expect(gated.hasAttribute('disabled')).toBe(false);
    const reasonId = gated.getAttribute('aria-describedby');
    expect(reasonId).toBeTruthy();
    const reason = document.getElementById(reasonId as string);
    // The Settings pointer — NOT the 503-latch integration/reload copy.
    expect(reason?.textContent).toMatch(/Settings/);
    expect(reason?.textContent).toMatch(/event-buttons table/);
    expect(reason?.textContent).not.toMatch(/no integration configured/);

    // Clicking never calls the paid endpoint.
    fireEvent.click(gated);
    expect(calls.count).toBe(0);
  });
});

describe('event feed — run state is scoped to the starting session (mounted-hidden panel)', () => {
  it('mid-run switch shows idle on the new session; the outcome renders only for the starting session', async () => {
    let resolveRun!: (value: unknown) => void;
    const calls = mockRoutes(
      () =>
        new Promise((resolve) => {
          resolveRun = resolve;
        }),
    );
    const { switchSession } = renderSheet(SESSION_A);

    // Start a run on A: the control shows the running state.
    fireEvent.click(await screen.findByRole('button', { name: 'Auto Generate' }));
    expect(await screen.findByRole('button', { name: 'Generating…' })).toBeTruthy();

    // Switch to B mid-run: B renders IDLE (no running state, no outcome, no
    // error), while the request keeps running.
    switchSession(SESSION_B);
    const idleOnB = await screen.findByRole('button', { name: 'Auto Generate' });
    expect(idleOnB.hasAttribute('disabled')).toBe(false);
    expect(idleOnB.getAttribute('aria-disabled')).toBeNull();
    expect(screen.queryByText(/Created \d/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(calls.count).toBe(1);

    // The run completes while B is open.
    await act(async () => {
      resolveRun({ created: 4, cap_hit: false });
    });

    // Returning to A shows A's outcome…
    switchSession(SESSION_A);
    const status = await screen.findByText('Created 4 events.');
    expect(status.getAttribute('role')).toBe('status');

    // …and B never displays it: switching back to B reads idle again.
    switchSession(SESSION_B);
    await waitFor(() => expect(screen.queryByText(/Created \d/)).toBeNull());
    expect(screen.getByRole('button', { name: 'Auto Generate' })).toBeTruthy();
  });
});
