import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { useSessions } from '../../../api/hooks/useSessions';
import type { Session, SessionsResponse } from '../../../api/types';
import { renderStrict } from '../../../test/renderStrict';
import { setNavigationImplForTesting } from '../navigation';
import { V6Rail } from './V6Rail';

// --- V6Rail Teams-button same-route guard (teams-settings-nav, task 2.3;
// design D2 gate decision 1) + rail session search (ui-refresh, task 5.2;
// spec: web-home-launch "Real rail session search") ---
//
// `useSessions` is stubbed at the module boundary; `RecentSessionsList`/
// `ArchivedSessionsList` are exercised FOR REAL (not mocked) for the search
// tests below, so the filter/no-match assertions genuinely exercise those
// components' own `matchesFilter` logic rather than a hand-rolled stand-in —
// the same "mock at the boundary, not the unit under test" idiom the
// mounted-hidden AI tab tests use elsewhere. `overlayscrollbars-react` is
// mocked to a plain div (a presentational scroll-chrome library with no jsdom
// support for its underlying ResizeObserver usage — irrelevant to what's
// under test here) and a real `QueryClient` is provided so the session
// cards' `useMutation` hooks (archive/delete/restore/rename) don't throw on
// mount. The button click reaches the shared `navigate` wrapper, which
// routes through the test-seam impl into the recorded memory location (same
// seam SessionRoute.test.tsx and AppShell.test.tsx use).

vi.mock('../../../api/hooks/useSessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/hooks/useSessions')>();
  return { ...actual, useSessions: vi.fn() };
});

vi.mock('overlayscrollbars-react', () => ({
  OverlayScrollbarsComponent: ({
    children,
    id,
    className,
  }: {
    children?: React.ReactNode;
    id?: string;
    className?: string;
  }) => (
    <div id={id} className={className}>
      {children}
    </div>
  ),
}));

const mockedUseSessions = vi.mocked(useSessions);

function sessionFixture(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    title: 'Session',
    deck_title: '',
    show_id: 'show-1',
    show_code: 'SH',
    show_name: 'Show One',
    episode: '1',
    notes: '',
    session_status: 'active',
    frame_rate: 30,
    start_offset_frames: 0,
    created_at_utc: '2026-07-14T00:00:00Z',
    episode_date: null,
    event_count: 0,
    is_rolling: false,
    current_take: 0,
    rolling_timecode: null,
    total_runtime_hms: '00:00:00',
    archived: false,
    ...overrides,
  };
}

function mockSessions(data: SessionsResponse | undefined) {
  mockedUseSessions.mockReturnValue({ data, isLoading: false } as unknown as ReturnType<
    typeof useSessions
  >);
}

function renderRail(initialPath = '/') {
  const memory = memoryLocation({ path: initialPath, record: true });
  setNavigationImplForTesting((path, options) => memory.navigate(path, options));
  const client = new QueryClient();
  const view = renderStrict(
    <QueryClientProvider client={client}>
      <Router hook={memory.hook}>
        <V6Rail
          activeSessionId=""
          onSelectSession={() => {}}
          onCloseSession={() => {}}
          onNewSession={() => {}}
          onBatchImport={() => {}}
          onOpenSettings={() => {}}
        />
      </Router>
    </QueryClientProvider>,
  );
  return { view, memory };
}

beforeEach(() => {
  document.body.classList.remove('v6-app--rail-collapsed');
  mockSessions({ active: [], archived: [] });
});

afterEach(() => {
  setNavigationImplForTesting(null);
  document.body.classList.remove('v6-app--rail-collapsed');
});

describe('V6Rail Teams button same-route guard (gate decision 1)', () => {
  it('navigates to /teams when not already on /teams', () => {
    const { memory } = renderRail('/');

    fireEvent.click(screen.getByRole('button', { name: 'Teams' }));

    expect(memory.history).toEqual(['/', '/teams']);
  });

  it('pushes no history entry when clicked while already on /teams', () => {
    const { memory } = renderRail('/teams');

    fireEvent.click(screen.getByRole('button', { name: 'Teams' }));

    expect(memory.history).toEqual(['/teams']);
  });
});

describe('V6Rail Batch Import button', () => {
  it('calls onBatchImport when clicked', () => {
    const onBatchImport = vi.fn();
    const memory = memoryLocation({ path: '/', record: true });
    setNavigationImplForTesting((path, options) => memory.navigate(path, options));
    const client = new QueryClient();
    renderStrict(
      <QueryClientProvider client={client}>
        <Router hook={memory.hook}>
          <V6Rail
            activeSessionId=""
            onSelectSession={() => {}}
            onCloseSession={() => {}}
            onNewSession={() => {}}
            onBatchImport={onBatchImport}
            onOpenSettings={() => {}}
          />
        </Router>
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Batch Import' }));
    expect(onBatchImport).toHaveBeenCalledTimes(1);
  });

  it('uses an up-arrow upload icon on the Batch Import rail button', () => {
    renderRail();

    const batchBtn = document.getElementById('v6-btn-batch-import');
    expect(batchBtn).not.toBeNull();
    const paths = batchBtn?.querySelectorAll('path') ?? [];
    const dValues = Array.from(paths).map((p) => p.getAttribute('d'));
    expect(dValues).toContain('M12 3V15');
    // Arrow head points UP (apex at y=3), per the gated D8 upload affordance.
    expect(dValues.some((d) => d?.includes('L12 3'))).toBe(true);
    expect(dValues.some((d) => d?.includes('L12 15'))).toBe(false);
    expect(dValues).toContain('M4 19H20');
  });
});

describe('V6Rail footer layout (collapsed overflow)', () => {
  it('footer carries collapsed flex-col + mobile drawer flex-row revert so Teams/Settings stack in the narrow rail', () => {
    renderRail();

    const teams = screen.getByRole('button', { name: 'Teams' });
    const settings = screen.getByRole('button', { name: 'Settings' });
    const footer = teams.parentElement;
    expect(footer).not.toBeNull();
    expect(footer).toBe(settings.parentElement);
    // Tailwind ancestor variants live on the element; CSS activates under
    // body.v6-app--rail-collapsed. Lock the class contract (jsdom won't compute
    // layout for arbitrary utilities).
    expect(footer?.className).toContain('[.v6-app--rail-collapsed_&]:flex-col');
    expect(footer?.className).toContain('max-md:[.v6-app--rail-collapsed_&]:flex-row');
  });
});

describe('V6Rail session search (spec: "Real rail session search")', () => {
  it('narrows both the Recent and Archived lists as the user types, case-insensitively', () => {
    mockSessions({
      active: [
        sessionFixture({ id: 'a1', title: 'Alpha Standup' }),
        sessionFixture({ id: 'b1', title: 'Beta Review' }),
      ],
      archived: [
        sessionFixture({ id: 'a2', title: 'Old Alpha Recap', archived: true }),
        sessionFixture({ id: 'b2', title: 'Old Beta Recap', archived: true }),
      ],
    });
    renderRail();

    expect(screen.getByText('Alpha Standup')).not.toBeNull();
    expect(screen.getByText('Beta Review')).not.toBeNull();
    expect(screen.getByText('Old Alpha Recap')).not.toBeNull();
    expect(screen.getByText('Old Beta Recap')).not.toBeNull();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search sessions' }), {
      target: { value: 'ALPHA' },
    });

    expect(screen.getByText('Alpha Standup')).not.toBeNull();
    expect(screen.getByText('Old Alpha Recap')).not.toBeNull();
    expect(screen.queryByText('Beta Review')).toBeNull();
    expect(screen.queryByText('Old Beta Recap')).toBeNull();

    // Clearing restores the full lists.
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search sessions' }), {
      target: { value: '' },
    });
    expect(screen.getByText('Beta Review')).not.toBeNull();
    expect(screen.getByText('Old Beta Recap')).not.toBeNull();
  });

  it('shows a "no sessions match" empty state naming the query, for both lists', () => {
    mockSessions({
      active: [sessionFixture({ id: 'a1', title: 'Alpha Standup' })],
      archived: [sessionFixture({ id: 'a2', title: 'Old Alpha Recap', archived: true })],
    });
    renderRail();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search sessions' }), {
      target: { value: 'zzz-no-match' },
    });

    expect(screen.getByText('No sessions match “zzz-no-match”.')).not.toBeNull();
    expect(screen.getByText('No archived sessions match “zzz-no-match”.')).not.toBeNull();
    expect(screen.queryByText('Alpha Standup')).toBeNull();
    expect(screen.queryByText('Old Alpha Recap')).toBeNull();
  });

  it('collapsed-rail: the search affordance is a real, keyboard-focusable button that expands the rail and moves focus into the visible input', () => {
    mockSessions({ active: [sessionFixture()], archived: [] });
    document.body.classList.add('v6-app--rail-collapsed');
    renderRail();

    const searchButton = screen.getByRole('button', { name: 'Search sessions' });
    // The fix vs. the spike (panel finding): this is a genuine <button>, not a
    // div — so it is reachable by Tab and activatable by Enter/Space like any
    // other button, unlike a bare `onClick` div.
    expect(searchButton.tagName).toBe('BUTTON');
    expect(document.body.classList.contains('v6-app--rail-collapsed')).toBe(true);

    // Native browsers translate a keyboard Enter/Space on a focused <button>
    // into this same click event; that's what the button's own handler acts
    // on, so exercising it via `fireEvent.click` here is the standard
    // testing-library idiom for "activatable by keyboard" on a real button
    // (see e.g. the Teams-button/New-Session-button tests above).
    fireEvent.click(searchButton);

    expect(document.body.classList.contains('v6-app--rail-collapsed')).toBe(false);
    const input = screen.getByRole('searchbox', { name: 'Search sessions' });
    expect(document.activeElement).toBe(input);
  });
});
