import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { useProfile } from '../../../api/hooks/useProfile';
import { useSessions } from '../../../api/hooks/useSessions';
import type { ProfilePayload, Session, SessionsResponse } from '../../../api/types';
import {
  SIDEBAR_STORAGE_KEY,
  SidebarProvider,
  SidebarTrigger,
} from '../../../shared/components/ui/sidebar';
import { renderStrict } from '../../../test/renderStrict';
import { setNavigationImplForTesting } from '../navigation';
import { V6Rail } from './V6Rail';

// --- V6Rail on the shadcn Sidebar (redesign-show-ignition D8, task 4.1) + rail session search
// (ui-refresh, task 5.2; spec: web-home-launch "Real rail session search") ---
//
// `useSessions` is stubbed at the module boundary; `RecentSessionsList`/
// `ArchivedSessionsList` are exercised FOR REAL (not mocked) for the search
// tests below, so the filter/no-match assertions genuinely exercise those
// components' own `matchesFilter` logic rather than a hand-rolled stand-in —
// the same "mock at the boundary, not the unit under test" idiom the
// mounted-hidden AI tab tests use elsewhere. the rail lists scroll in the real shadcn ScrollArea, and a real `QueryClient` is provided so the session
// cards' `useMutation` hooks (archive/delete/restore/rename) don't throw on
// mount. The rail renders inside a real `SidebarProvider` (with a `SidebarTrigger` beside it,
// standing in for the top bar's), so collapse and persistence are the primitive's real ones.

vi.mock('../../../api/hooks/useSessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/hooks/useSessions')>();
  return { ...actual, useSessions: vi.fn() };
});

vi.mock('../../../api/hooks/useProfile', () => ({ useProfile: vi.fn() }));

const mockedUseSessions = vi.mocked(useSessions);

// show-grants D13: the components read show access from the profile through `useShowAccess`;
// `useProfile` is mocked at the module boundary. The default profile can access `show-1` (the
// session fixtures' show) in the active team `studio-1`.
function accessProfile(
  shows: Array<{ id: string; studio_id?: string; can_access: boolean }> = [
    { id: 'show-1', can_access: true },
  ],
): ProfilePayload {
  return {
    active_studio_id: 'studio-1',
    active_show_id: shows[0]?.id ?? '',
    shows: shows.map((s) => ({
      studio_id: 'studio-1',
      name: s.id,
      show_code: s.id.toUpperCase(),
      title_suffix: 'date',
      ...s,
    })),
    auth: { logged_in: true, oauth_configured: true, user: null },
  } as unknown as ProfilePayload;
}

function mockProfile(p: ProfilePayload) {
  vi.mocked(useProfile).mockReturnValue({ data: p } as unknown as ReturnType<typeof useProfile>);
}

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

function renderRail(initialPath = '/', props: Partial<React.ComponentProps<typeof V6Rail>> = {}) {
  const memory = memoryLocation({ path: initialPath, record: true });
  setNavigationImplForTesting((path, options) => memory.navigate(path, options));
  const client = new QueryClient();
  const view = renderStrict(
    <QueryClientProvider client={client}>
      <Router hook={memory.hook}>
        <SidebarProvider>
          <SidebarTrigger />
          <V6Rail
            activeSessionId=""
            onSelectSession={() => {}}
            onCloseSession={() => {}}
            onNewSession={() => {}}
            onBatchImport={() => {}}
            onOpenSettings={() => {}}
            {...props}
          />
        </SidebarProvider>
      </Router>
    </QueryClientProvider>,
  );
  return { view, memory };
}

const sidebarState = () =>
  document.querySelector('[data-slot="sidebar"]')?.getAttribute('data-state') ?? null;

beforeEach(() => {
  window.localStorage.clear();
  mockSessions({ active: [], archived: [] });
  mockProfile(accessProfile());
});

afterEach(() => {
  setNavigationImplForTesting(null);
  window.localStorage.clear();
});

describe('V6Rail chrome (redesign-show-ignition D8)', () => {
  it('has no Teams control (team management moves to Settings)', () => {
    renderRail('/');
    expect(screen.queryByRole('button', { name: 'Teams' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Teams' })).toBeNull();
    expect(document.getElementById('v6-btn-teams')).toBeNull();
  });

  it('has no rail-local toggle: the top bar trigger (and `[`, Ctrl/⌘+B) own it', () => {
    renderRail('/');
    expect(document.getElementById('v6-rail-toggle')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Toggle navigation' })).toBeNull();
  });

  it('is the shadcn icon-collapsible sidebar, keeping the #v6-rail hook the ignition tint reads', () => {
    renderRail('/');
    const sidebar = document.querySelector('[data-slot="sidebar"]');
    expect(sidebar?.getAttribute('data-state')).toBe('expanded');
    const container = document.getElementById('v6-rail');
    expect(container?.getAttribute('data-slot')).toBe('sidebar-container');
    expect(container?.getAttribute('aria-label')).toBe('Navigation');
  });

  it('Settings sits in the sidebar footer and calls onOpenSettings', () => {
    const onOpenSettings = vi.fn();
    renderRail('/', { onOpenSettings });
    const settings = screen.getByRole('button', { name: 'Settings' });
    expect(settings.closest('[data-slot="sidebar-footer"]')).not.toBeNull();
    fireEvent.click(settings);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    // The version still sits at the rail bottom.
    expect(screen.getByText(/^v\d/)).toBeTruthy();
  });
});

describe('V6Rail tooltips only in the icon strip', () => {
  it('a focused control in the expanded sidebar opens no tooltip layer (it would swallow Escape)', () => {
    mockSessions({ active: [sessionFixture()], archived: [] });
    renderRail('/');
    act(() => {
      screen.getByRole('button', { name: 'New session' }).focus();
    });
    act(() => {
      screen.getByRole('button', { name: 'Settings' }).focus();
    });
    expect(document.querySelector('[data-slot="tooltip-content"]')).toBeNull();
  });
});

describe('V6Rail New session and Import (sidebar header)', () => {
  it('sit in the sidebar header and call their handlers', () => {
    const onNewSession = vi.fn();
    const onBatchImport = vi.fn();
    renderRail('/', { onNewSession, onBatchImport });
    const create = screen.getByRole('button', { name: 'New session' });
    const importBtn = screen.getByRole('button', { name: 'Import' });
    expect(create.closest('[data-slot="sidebar-header"]')).not.toBeNull();
    expect(importBtn.closest('[data-slot="sidebar-header"]')).not.toBeNull();
    fireEvent.click(create);
    fireEvent.click(importBtn);
    expect(onNewSession).toHaveBeenCalledTimes(1);
    expect(onBatchImport).toHaveBeenCalledTimes(1);
  });

  it('uses an up-arrow upload icon on the Import button', () => {
    renderRail();

    const batchBtn = document.getElementById('v6-btn-batch-import');
    expect(batchBtn).not.toBeNull();
    // shadcn-port-shell D6: lucide's Upload icon (an up-arrow over a tray) — the gated D8
    // "up-arrow (upload) affordance" — decorative, inheriting currentColor.
    const icon = batchBtn?.querySelector('svg.lucide-upload');
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
    expect(icon?.getAttribute('stroke')).toBe('currentColor');
  });
});

describe('V6Rail session cards (SidebarMenu)', () => {
  it('lists sessions as sidebar menu buttons, the open one active', () => {
    mockSessions({
      active: [
        sessionFixture({ id: 'a1', title: 'Alpha Standup' }),
        sessionFixture({ id: 'b1', title: 'Beta Review' }),
      ],
      archived: [],
    });
    const onSelectSession = vi.fn();
    renderRail('/sessions/b1', { activeSessionId: 'b1', onSelectSession });

    const alpha = screen.getByText('Alpha Standup').closest('[data-slot="sidebar-menu-button"]');
    const beta = screen.getByText('Beta Review').closest('[data-slot="sidebar-menu-button"]');
    expect(alpha?.getAttribute('data-active')).toBe('false');
    expect(beta?.getAttribute('data-active')).toBe('true');
    expect(beta?.getAttribute('aria-current')).toBe('page');
    fireEvent.click(alpha as HTMLElement);
    expect(onSelectSession).toHaveBeenCalledWith('a1');
  });
});

describe('V6Rail collapse persistence (sidebar primitive, localStorage)', () => {
  it('the collapsed state survives a remount', () => {
    const first = renderRail('/');
    fireEvent.click(screen.getByRole('button', { name: /toggle sidebar/i }));
    expect(sidebarState()).toBe('collapsed');
    expect(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe('collapsed');
    first.view.unmount();

    renderRail('/');
    expect(sidebarState()).toBe('collapsed');
  });

  it('storage that throws defaults to expanded', () => {
    const own = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('denied');
      },
    });
    try {
      renderRail('/');
      expect(sidebarState()).toBe('expanded');
      fireEvent.click(screen.getByRole('button', { name: /toggle sidebar/i }));
      expect(sidebarState()).toBe('collapsed');
    } finally {
      if (own) Object.defineProperty(window, 'localStorage', own);
      else delete (window as unknown as Record<string, unknown>).localStorage;
    }
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
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, 'collapsed');
    renderRail();
    expect(sidebarState()).toBe('collapsed');

    const searchButton = screen.getByRole('button', { name: 'Search sessions' });
    // A genuine <button> (panel finding on the spike's bare div), so Tab reaches it and
    // Enter/Space activate it; browsers turn those keys into this click.
    expect(searchButton.tagName).toBe('BUTTON');

    act(() => {
      fireEvent.click(searchButton);
    });

    expect(sidebarState()).toBe('expanded');
    const input = screen.getByRole('searchbox', { name: 'Search sessions' });
    expect(document.activeElement).toBe(input);
  });
});

describe('V6Rail New session and Import follow show access (show-grants D13)', () => {
  it('are hidden when the active team has no show the user can access', () => {
    mockProfile(accessProfile([{ id: 'show-1', can_access: false }]));
    renderRail();
    expect(screen.queryByRole('button', { name: 'New session' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Import' })).toBeNull();
  });

  it('are hidden when the only accessible show belongs to another team', () => {
    mockProfile(
      accessProfile([
        { id: 'show-1', can_access: false },
        { id: 'show-9', studio_id: 'studio-2', can_access: true },
      ]),
    );
    renderRail();
    expect(screen.queryByRole('button', { name: 'New session' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Import' })).toBeNull();
  });

  it('are shown with one accessible show in the active team', () => {
    mockProfile(
      accessProfile([
        { id: 'show-1', can_access: false },
        { id: 'show-2', can_access: true },
      ]),
    );
    renderRail();
    expect(screen.getByRole('button', { name: 'New session' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Import' })).not.toBeNull();
  });
});
