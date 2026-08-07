import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch } from '../../../api/client';
import type {
  Category,
  EventsResponse,
  LogEvent,
  ProfilePayload,
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
//     instructions configured") — not the 503 latch. This at-rest reason is
//     VISUALLY HIDDEN (sr-only, reached via `aria-describedby`; a spec-accepted
//     form) so the resting toolbar shows no extra visible text — an
//     always-visible span overflowed the shared FEED_TOOLBAR row (6.2 gate
//     regression). The 503 latch keeps the always-visible form.
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

function autoEventFixture(): LogEvent {
  return {
    event_id: 'auto-1',
    category: 'general',
    category_label: 'General',
    category_color: '#4488ff',
    message: 'Generated event',
    timecode: '00:00:10:00',
    timecode_total_frames: 240,
    frame_rate: 24,
    wall_time_utc: '2026-07-29T00:00:10Z',
    metadata: { auto_generated: true },
  };
}

function customProfileFixture(): ProfilePayload {
  return {
    active_studio_id: 'studio-1',
    active_show_id: 'show-1',
    active_studio: { id: 'studio-1', name: 'Studio', categories: [] },
    studios: [{ id: 'studio-1', name: 'Studio' }],
    studio_settings: {},
    shows: [
      {
        id: 'show-1',
        studio_id: 'studio-1',
        name: 'Show',
        show_code: 'SHOW',
        next_episode: 1,
        categories: [
          {
            id: 'general',
            name: 'General',
            color: '#4488ff',
            type: 'BUTTON',
            dropdown_options: [],
            on_label: '',
            off_label: '',
            auto_instruction: 'Log notable moments',
          },
          {
            id: 'camera',
            name: 'Camera',
            color: '#22aa88',
            type: 'DROPDOWN',
            dropdown_options: [
              {
                label: 'Wide',
                needs_context: false,
                auto_instruction: 'Log a wide camera change',
              },
              { label: 'Close', needs_context: false },
            ],
            on_label: '',
            off_label: '',
            auto_instruction: 'Log camera discussion',
          },
        ],
        event_palette: [],
        event_palette_preset: '',
        event_palette_custom: [],
      },
    ],
    new_session_defaults: { title_prefix: '', default_frame_rate: 24 },
    admin: { restart_supported: false, restart_needs_token: false },
    auth: { logged_in: false, oauth_configured: false, user: null },
  };
}

/** Routes the sheet's reads for ANY session id; `POST …/events/generate` runs
 * `generateImpl` and is counted. */
function mockRoutes(
  generateImpl: (body: unknown) => Promise<unknown>,
  opts: {
    instructionsPresent?: boolean;
    events?: EventsResponse;
    profile?: unknown;
    statusShowId?: string | null;
  } = {},
): { count: number; bodies: unknown[] } {
  const calls = { count: 0, bodies: [] as unknown[] };
  mockedApiFetch.mockImplementation(async (path: string, request?: RequestInit) => {
    if (path.includes('/events/generate')) {
      calls.count += 1;
      const body = typeof request?.body === 'string' ? JSON.parse(request.body) : undefined;
      calls.bodies.push(body);
      return generateImpl(body);
    }
    if (path.includes('/status')) {
      return { ...statusFixture(), show_id: opts.statusShowId ?? null };
    }
    if (path.includes('/show-categories')) {
      return showCategoriesFixture(opts.instructionsPresent ?? true);
    }
    if (path === 'profile') {
      return (
        opts.profile ?? {
          active_studio_id: '',
          active_show_id: '',
          active_studio: { id: '', name: '', categories: [] },
          studios: [],
          studio_settings: {},
          shows: [],
          new_session_defaults: { title_prefix: '', default_frame_rate: 24 },
          admin: { restart_supported: false, restart_needs_token: false },
          auth: { logged_in: false, oauth_configured: false, user: null },
        }
      );
    }
    if (path.includes('/events')) return opts.events ?? emptyEventsFixture();
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

async function startGenerate(item = 'Generate All') {
  fireEvent.click(await screen.findByRole('button', { name: 'Auto Generate' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: item }));
}

beforeEach(() => {
  mockedApiFetch.mockReset();
});

describe('event feed — AUTO GENERATE 503 latch (honest capability gating)', () => {
  it('latches on the first 503, persists across a session switch within the mount, clears only on remount', async () => {
    const calls = mockRoutes(() => Promise.reject(new ApiError(503, 'Service Unavailable')));
    const { switchSession, unmount } = renderSheet(SESSION_A);

    await startGenerate();

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
    // The latch reason stays VISIBLE (sighted users see the outage too) —
    // only the at-rest no-instructions reason is sr-only.
    expect(reason?.classList.contains('sr-only')).toBe(false);
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

describe('event feed — Auto Generate menu and custom selection', () => {
  it('offers Generate All and posts without a body when no loaded event is auto-generated', async () => {
    const calls = mockRoutes(() => Promise.resolve({ created: 1, cap_hit: false }));
    renderSheet(SESSION_A);

    fireEvent.click(await screen.findByRole('button', { name: 'Auto Generate' }));
    expect(screen.getByRole('menuitem', { name: 'Generate All' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Custom' })).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Generate All' }));

    await waitFor(() => expect(calls.count).toBe(1));
    expect(calls.bodies).toEqual([undefined]);
  });

  it('offers Regenerate All and posts the regenerate body only after the destructive confirm', async () => {
    const auto = autoEventFixture();
    const calls = mockRoutes(() => Promise.resolve({ created: 1, cap_hit: false, deleted: 1 }), {
      events: {
        events: [auto],
        total: 1,
        logged_event_count: 1,
        offset: 0,
        limit: 200,
      },
    });
    renderSheet(SESSION_A);

    fireEvent.click(await screen.findByRole('button', { name: 'Auto Generate' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Regenerate All' }));

    // Destructive confirm first — nothing posted yet, copy warns edited rows die too.
    expect(await screen.findByRole('heading', { name: 'Regenerate all auto events' })).toBeTruthy();
    expect(screen.getByText(/including any you edited/)).toBeTruthy();
    expect(calls.count).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: 'Delete and regenerate' }));
    await waitFor(() => expect(calls.count).toBe(1));
    expect(calls.bodies).toEqual([{ regenerate: true }]);
  });

  it('cancelling the regenerate confirm aborts without posting', async () => {
    const auto = autoEventFixture();
    const calls = mockRoutes(() => Promise.resolve({ created: 1, cap_hit: false, deleted: 1 }), {
      events: {
        events: [auto],
        total: 1,
        logged_event_count: 1,
        offset: 0,
        limit: 200,
      },
    });
    renderSheet(SESSION_A);

    fireEvent.click(await screen.findByRole('button', { name: 'Auto Generate' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Regenerate All' }));
    expect(await screen.findByRole('heading', { name: 'Regenerate all auto events' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Regenerate all auto events' })).toBeNull(),
    );
    expect(calls.count).toBe(0);
  });

  it('opens Custom without a request, requires a selection, and posts selection only', async () => {
    const calls = mockRoutes(() => Promise.resolve({ created: 2, cap_hit: false }), {
      profile: customProfileFixture(),
      statusShowId: 'show-1',
    });
    renderSheet(SESSION_A);

    fireEvent.click(await screen.findByRole('button', { name: 'Auto Generate' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Custom' }));
    expect(await screen.findByRole('dialog', { name: 'Custom event generation' })).toBeTruthy();
    expect(calls.count).toBe(0);

    const submit = screen.getByRole('button', { name: 'Generate' });
    expect(submit.hasAttribute('disabled')).toBe(true);
    const generalGroup = await screen.findByRole('group', { name: 'General' });
    const cameraGroup = await screen.findByRole('group', { name: 'Camera' });
    fireEvent.click(
      within(generalGroup).getByRole('checkbox', {
        name: /Button instruction/,
      }),
    );
    fireEvent.click(
      within(cameraGroup).getByRole('checkbox', {
        name: /Wide/,
      }),
    );
    expect(submit.hasAttribute('disabled')).toBe(false);
    fireEvent.click(submit);

    await waitFor(() => expect(calls.count).toBe(1));
    expect(calls.bodies).toEqual([
      {
        selection: [{ category_id: 'general' }, { category_id: 'camera', option_label: 'Wide' }],
      },
    ]);
  });
});

describe('event feed — AUTO GENERATE non-503 outcomes (single inline channel)', () => {
  it('renders the server 409 busy detail verbatim, retryable, NOT latched', async () => {
    const busyDetail =
      'A turn (AI chat, AI v2, topic generation, or event generation) is already in progress for this session; ' +
      'wait for it to finish before generating events. These features share one per-session AI slot by design.';
    const calls = mockRoutes(() => Promise.reject(new ApiError(409, busyDetail)));
    renderSheet(SESSION_A);

    await startGenerate();

    // The SERVER's detail, verbatim (never a client-derived holder list).
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(busyDetail);
    expect(generateButton().getAttribute('aria-disabled')).toBeNull();
    expect(calls.count).toBe(1);

    // Not latched: a retry goes back to the network.
    await startGenerate();
    await waitFor(() => expect(calls.count).toBe(2));
  });

  it('renders other non-503 failures inline with the server detail, unlatched', async () => {
    const calls = mockRoutes(() => Promise.reject(new ApiError(502, 'generation failed upstream')));
    renderSheet(SESSION_A);

    await startGenerate();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('generation failed upstream');
    expect(generateButton().getAttribute('aria-disabled')).toBeNull();
    expect(calls.count).toBe(1);
  });

  it('renders the created count inline on success', async () => {
    mockRoutes(() => Promise.resolve({ created: 3, cap_hit: false }));
    renderSheet(SESSION_A);

    await startGenerate();

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

    await startGenerate();

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
    // AT REST the reason is visually hidden (sr-only) — reachable through the
    // accessible description above, but adding no visible toolbar text: this
    // gate is every session's default state, and a visible span here overflows
    // the shared FEED_TOOLBAR row (6.2 gate regression, fix wave).
    expect(reason?.classList.contains('sr-only')).toBe(true);

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
    await startGenerate();
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
