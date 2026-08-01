import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { apiFetch } from '../../api/client';
import { useYoutubeImport } from '../../api/hooks/useSessions';
import type { ProfilePayload, TeamMembershipBrief } from '../../api/types';
import { renderStrict } from '../../test/renderStrict';
import { AppShell } from './AppShell';
import { setNavigationImplForTesting } from './navigation';

// --- AppShell zero-membership onboarding tests (teams-self-serve, task 6.3;
// spec: team-management "Zero-membership onboarding", design D8) ---
//
// Unlike AppShell.test.tsx (which mocks `useProfile` entirely to drive
// routing/state assertions), this file exercises the REAL `useProfile` +
// `useCreateTeam` hooks against a REAL QueryClient with only `apiFetch`
// mocked at the module boundary (the SessionRoute.test.tsx idiom) — the
// onboarding condition is a profile-data-driven render switch, and the
// "success lands in the normal shell" scenario requires a real
// invalidate-then-refetch round trip, which a fully-mocked `useProfile`
// cannot produce.

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return { ...actual, apiFetch: vi.fn() };
});

vi.mock('../../api/hooks/useSessions', () => ({
  useYoutubeImport: vi.fn(),
  useSessions: () => ({ data: undefined, isLoading: false }),
}));

vi.mock('../../shared/components/Toast', () => ({
  Toast: () => null,
  toast: { error: vi.fn() },
}));

vi.mock('../../shared/ui/breakpoints', () => ({
  useIsMobile: () => false,
}));

vi.mock('../../shared/utils/loadingVideo', () => ({
  AUTOLOGGER_LOADING_VIDEO_SRC: '',
  freezeAutologgerLoadingVideos: () => {},
}));

vi.mock('../../shared/utils/perfDebug', () => ({
  initPerfDebugUI: () => {},
}));

vi.mock('./components/V6Rail', () => ({
  V6Rail: () => <div data-testid="rail" />,
}));

vi.mock('./components/SessionRoute', () => ({
  SessionRoute: (props: { sessionId: string }) => (
    <div data-testid="session-route" data-session-id={props.sessionId} />
  ),
}));

vi.mock('./components/NewSessionModal', () => ({
  NewSessionModal: () => null,
}));

vi.mock('./components/BatchImportModal', () => ({
  BatchImportModal: () => null,
}));

vi.mock('./components/YouTubeImportErrorModal', () => ({
  YouTubeImportErrorModal: () => null,
}));

const mockedApiFetch = vi.mocked(apiFetch);
const mockedUseYoutubeImport = vi.mocked(useYoutubeImport);

function profileFixture(
  teams: TeamMembershipBrief[],
  authOverrides: Partial<ProfilePayload['auth']> = {},
): ProfilePayload {
  return {
    active_studio_id: teams[0]?.id ?? '',
    active_show_id: '',
    active_studio: { id: teams[0]?.id ?? '', name: teams[0]?.name ?? '', categories: [] },
    studios: teams.map((t) => ({ id: t.id, name: t.name })),
    studio_settings: {},
    shows: [],
    new_session_defaults: { title_prefix: '', default_frame_rate: 30 },
    admin: { restart_supported: false, restart_needs_token: false },
    auth: {
      logged_in: true,
      oauth_configured: true,
      user: {
        id: 'caller-1',
        email: 'caller@example.com',
        given_name: 'Cal',
        family_name: 'Ler',
        picture_url: null,
        teams,
      },
      ...authOverrides,
    },
  } as unknown as ProfilePayload;
}

function anonymousProfileFixture(): ProfilePayload {
  return {
    active_studio_id: 'test-studios',
    active_show_id: '',
    active_studio: { id: 'test-studios', name: 'Test Studios', categories: [] },
    studios: [{ id: 'test-studios', name: 'Test Studios' }],
    studio_settings: {},
    shows: [],
    new_session_defaults: { title_prefix: '', default_frame_rate: 30 },
    admin: { restart_supported: false, restart_needs_token: false },
    auth: { logged_in: false, oauth_configured: false, user: null },
  } as unknown as ProfilePayload;
}

function renderShell(client: QueryClient) {
  const memory = memoryLocation({ path: '/', record: true });
  setNavigationImplForTesting((path, options) => memory.navigate(path, options));
  return renderStrict(
    <QueryClientProvider client={client}>
      <Router hook={memory.hook}>
        <AppShell />
      </Router>
    </QueryClientProvider>,
  );
}

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

beforeEach(() => {
  mockedApiFetch.mockReset();
  mockedUseYoutubeImport.mockReturnValue({
    mutateAsync: vi.fn().mockResolvedValue(undefined),
  } as unknown as ReturnType<typeof useYoutubeImport>);
});

afterEach(() => {
  setNavigationImplForTesting(null);
  vi.clearAllMocks();
});

describe('zero-membership onboarding (design D8)', () => {
  it('a logged-in user with zero teams sees the onboarding panel instead of the rail/workspace', async () => {
    mockedApiFetch.mockResolvedValue(profileFixture([]));

    renderShell(makeClient());

    await waitFor(() => expect(screen.getByTestId('onboarding-panel')).not.toBeNull());
    expect(screen.queryByTestId('rail')).toBeNull();
    expect(screen.queryByTestId('session-route')).toBeNull();
    // The settings modal lift (teams-settings-nav, D1) mounts HomeSettingsModal
    // beside the route switch — the onboarding branch early-returns before
    // that switch, so neither the settings affordance nor the modal itself
    // can ever appear here.
    expect(document.getElementById('v6-btn-settings')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('dev-anonymous mode is unaffected (logged_in: false) — normal shell renders', async () => {
    mockedApiFetch.mockResolvedValue(anonymousProfileFixture());

    renderShell(makeClient());

    await waitFor(() => expect(screen.getByTestId('session-route')).not.toBeNull());
    expect(screen.getByTestId('rail')).not.toBeNull();
    expect(screen.queryByTestId('onboarding-panel')).toBeNull();
  });

  it('a logged-in user with at least one team sees the normal shell, not onboarding', async () => {
    mockedApiFetch.mockResolvedValue(
      profileFixture([{ id: 'team-a', name: 'Team A', role: 'admin' }]),
    );

    renderShell(makeClient());

    await waitFor(() => expect(screen.getByTestId('session-route')).not.toBeNull());
    expect(screen.getByTestId('rail')).not.toBeNull();
    expect(screen.queryByTestId('onboarding-panel')).toBeNull();
  });

  it('completing the create-first-team form lands the user in the normal shell (profile invalidation flips the switch)', async () => {
    let teams: TeamMembershipBrief[] = [];
    mockedApiFetch.mockImplementation(async (path: string, opts?: RequestInit) => {
      const method = opts?.method ?? 'GET';
      if (path === 'profile' && method === 'GET') return profileFixture(teams);
      if (path === 'teams' && method === 'POST') {
        teams = [{ id: 'my-crew', name: 'My Crew', role: 'admin' }];
        return { id: 'my-crew', name: 'My Crew', role: 'admin' };
      }
      throw new Error(`unexpected apiFetch: ${method} ${path}`);
    });

    renderShell(makeClient());
    await waitFor(() => expect(screen.getByTestId('onboarding-panel')).not.toBeNull());

    fireEvent.change(screen.getByLabelText('Team id (slug)'), { target: { value: 'my-crew' } });
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'My Crew' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create team' }));

    await waitFor(() => expect(screen.queryByTestId('onboarding-panel')).toBeNull());
    expect(screen.getByTestId('rail')).not.toBeNull();
    expect(screen.getByTestId('session-route')).not.toBeNull();
  });
});
