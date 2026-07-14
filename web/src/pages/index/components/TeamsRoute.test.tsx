import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch } from '../../../api/client';
import { useProfile } from '../../../api/hooks/useProfile';
import type { ProfilePayload, TeamDetail, TeamMembershipBrief } from '../../../api/types';
import { renderStrict } from '../../../test/renderStrict';
import { TeamsRoute } from './TeamsRoute';

// --- TeamsRoute page tests (teams-self-serve, task 6.2; spec:
// team-management "Teams management UI", all four scenarios) ---
//
// Mocked at module boundaries (the SessionRoute.test.tsx idiom): `useProfile`
// is replaced (this page reads the teams list + roles off it, and the real
// hook's own request/cache behavior is covered by useProfile's own tests
// elsewhere) and `apiFetch` is the sole network seam — every team-detail
// fetch and management mutation runs through the REAL `useTeam`/mutation
// hooks and a REAL QueryClient, so invalidation-driven UI updates (the invite
// round-trip, last-admin 409) are exercised for real, not simulated.

vi.mock('../../../api/hooks/useProfile', () => ({
  useProfile: vi.fn(),
}));

vi.mock('../../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/client')>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedUseProfile = vi.mocked(useProfile);
const mockedApiFetch = vi.mocked(apiFetch);

function teamsProfile(
  teams: TeamMembershipBrief[],
  overrides: Partial<ProfilePayload['auth']> = {},
): ProfilePayload {
  return {
    active_studio_id: '',
    active_show_id: '',
    active_studio: { id: '', name: '', categories: [] },
    studios: [],
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
      ...overrides,
    },
  } as unknown as ProfilePayload;
}

function anonymousProfile(): ProfilePayload {
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

function detailFixture(overrides: Partial<TeamDetail> = {}): TeamDetail {
  return {
    id: 'team-a',
    name: 'Team A',
    role: 'admin',
    enabled_admin_count: 2,
    members: [
      {
        id: 'caller-1',
        email: 'caller@example.com',
        given_name: 'Cal',
        family_name: 'Ler',
        role: 'admin',
      },
      {
        id: 'u2',
        email: 'other@example.com',
        given_name: 'Ot',
        family_name: 'Her',
        role: 'member',
      },
    ],
    invites: [],
    ...overrides,
  };
}

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderPage(profile: ProfilePayload) {
  mockedUseProfile.mockReturnValue({ data: profile } as unknown as ReturnType<typeof useProfile>);
  return renderStrict(
    <QueryClientProvider client={makeClient()}>
      <TeamsRoute />
    </QueryClientProvider>,
  );
}

const teamsApiCalls = () =>
  mockedApiFetch.mock.calls.filter(([path]) => String(path).startsWith('teams'));

beforeEach(() => {
  mockedApiFetch.mockReset();
});

describe('dev-anonymous mode', () => {
  it('renders a signed-in-required notice and issues no /api/teams requests', () => {
    renderPage(anonymousProfile());

    expect(screen.getByTestId('teams-route')).not.toBeNull();
    expect(document.getElementById('teams-signed-in-required')).not.toBeNull();
    expect(teamsApiCalls()).toHaveLength(0);
  });
});

describe('built-in team memberships', () => {
  it('render read-only with no expand affordance and no detail fetch', () => {
    renderPage(teamsProfile([{ id: 'test-studios', name: 'Test Studios', role: 'member' }]));

    const row = screen.getByTestId('team-row-test-studios');
    expect(within(row).getByText('Legacy team — managed by support.')).not.toBeNull();
    expect(within(row).queryByRole('button')).toBeNull();
    expect(teamsApiCalls()).toHaveLength(0);
  });
});

describe('admin sees controls, member does not (scenario: Admin sees controls, member does not)', () => {
  it('team A (admin) shows management controls incl. pending invites; team B (member) is read-only with leave', async () => {
    mockedApiFetch.mockImplementation(async (path: string) => {
      if (path === 'teams/team-a') {
        return detailFixture({
          id: 'team-a',
          role: 'admin',
          invites: [{ email: 'pending@example.com', invited_at_utc: '2026-07-14T00:00:00Z' }],
        });
      }
      if (path === 'teams/team-b') {
        return detailFixture({ id: 'team-b', role: 'member', enabled_admin_count: 1 });
      }
      throw new Error(`unexpected apiFetch: ${path}`);
    });

    renderPage(
      teamsProfile([
        { id: 'team-a', name: 'Team A', role: 'admin' },
        { id: 'team-b', name: 'Team B', role: 'member' },
      ]),
    );

    fireEvent.click(screen.getByTestId('team-toggle-team-a'));
    await waitFor(() => expect(screen.getByTestId('team-admin-panel-team-a')).not.toBeNull());
    const panelA = screen.getByTestId('team-admin-panel-team-a');
    expect(within(panelA).getByText('pending@example.com')).not.toBeNull();
    expect(within(panelA).getByRole('button', { name: 'Save name' })).not.toBeNull();
    expect(within(panelA).getByRole('button', { name: 'Invite' })).not.toBeNull();

    fireEvent.click(screen.getByTestId('team-toggle-team-b'));
    await waitFor(() => expect(screen.getByTestId('team-member-panel-team-b')).not.toBeNull());
    const panelB = screen.getByTestId('team-member-panel-team-b');
    expect(within(panelB).getByRole('button', { name: 'Leave team' })).not.toBeNull();
    expect(within(panelB).queryByRole('button', { name: 'Invite' })).toBeNull();
    expect(within(panelB).queryByText('pending@example.com')).toBeNull();
  });
});

describe('invite flow round-trip (scenario: Invite flow round-trip)', () => {
  it('a new pending invite appears after inviting and disappears after revoking, without a page reload', async () => {
    let invites: TeamDetail['invites'] = [];
    mockedApiFetch.mockImplementation(async (path: string, opts?: RequestInit) => {
      const method = opts?.method ?? 'GET';
      if (path === 'teams/team-a' && method === 'GET') {
        return detailFixture({ invites });
      }
      if (path === 'teams/team-a/invites' && method === 'POST') {
        invites = [{ email: 'new@example.com', invited_at_utc: '2026-07-14T00:00:00Z' }];
        return { ok: true };
      }
      if (path === 'teams/team-a/invites/new%40example.com' && method === 'DELETE') {
        invites = [];
        return { ok: true };
      }
      throw new Error(`unexpected apiFetch: ${method} ${path}`);
    });

    renderPage(teamsProfile([{ id: 'team-a', name: 'Team A', role: 'admin' }]));
    fireEvent.click(screen.getByTestId('team-toggle-team-a'));
    await waitFor(() => expect(screen.getByTestId('team-admin-panel-team-a')).not.toBeNull());

    fireEvent.change(screen.getByLabelText('Invite by email'), {
      target: { value: 'new@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }));

    await waitFor(() => expect(screen.getByTestId('team-invite-new@example.com')).not.toBeNull());

    fireEvent.click(
      within(screen.getByTestId('team-invite-new@example.com')).getByRole('button', {
        name: 'Revoke',
      }),
    );

    await waitFor(() => expect(screen.queryByTestId('team-invite-new@example.com')).toBeNull());
    expect(screen.getByText('No pending invites.')).not.toBeNull();
  });
});

describe('last-admin protection surfaced as an actionable message', () => {
  it('demoting the sole enabled admin (self) shows the 409 detail text', async () => {
    mockedApiFetch.mockImplementation(async (path: string, opts?: RequestInit) => {
      const method = opts?.method ?? 'GET';
      if (path === 'teams/team-a' && method === 'GET') {
        return detailFixture({
          enabled_admin_count: 1,
          members: [
            {
              id: 'caller-1',
              email: 'caller@example.com',
              given_name: 'Cal',
              family_name: 'Ler',
              role: 'admin',
            },
          ],
        });
      }
      if (path === 'teams/team-a/members/caller-1/role' && method === 'POST') {
        throw new ApiError(409, 'This would leave the team with no enabled admin.');
      }
      throw new Error(`unexpected apiFetch: ${method} ${path}`);
    });

    renderPage(teamsProfile([{ id: 'team-a', name: 'Team A', role: 'admin' }]));
    fireEvent.click(screen.getByTestId('team-toggle-team-a'));
    await waitFor(() => expect(screen.getByTestId('team-admin-panel-team-a')).not.toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Make member' }));

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        'This would leave the team with no enabled admin.',
      ),
    );
  });
});

describe('orphaned team is visible as such (scenario: Orphaned team is visible as such)', () => {
  it('a zero-enabled-admin team renders the contact-support notice instead of management controls', async () => {
    mockedApiFetch.mockResolvedValue(
      detailFixture({ role: 'member', enabled_admin_count: 0 }) satisfies TeamDetail,
    );

    renderPage(teamsProfile([{ id: 'team-a', name: 'Team A', role: 'member' }]));
    fireEvent.click(screen.getByTestId('team-toggle-team-a'));

    await waitFor(() => expect(screen.getByTestId('team-orphaned-notice')).not.toBeNull());
    expect(screen.queryByTestId('team-admin-panel-team-a')).toBeNull();
    expect(screen.queryByTestId('team-member-panel-team-a')).toBeNull();
  });
});

describe('create-team form', () => {
  it('surfaces the {detail} cap error inline', async () => {
    mockedApiFetch.mockRejectedValue(
      new ApiError(400, 'You already admin 20 teams; the limit has been reached.'),
    );

    renderPage(teamsProfile([]));

    fireEvent.change(screen.getByLabelText('Team id (slug)'), { target: { value: 'my-crew' } });
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'My Crew' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create team' }));

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        'You already admin 20 teams; the limit has been reached.',
      ),
    );
  });
});
