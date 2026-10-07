import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch } from '../../../../api/client';
import { useProfile } from '../../../../api/hooks/useProfile';
import type { ProfilePayload, TeamDetail, TeamMembershipBrief } from '../../../../api/types';
import { renderStrict } from '../../../../test/renderStrict';
import { LegacyTeamsPanel } from './LegacyTeamsPanel';

// --- LegacyTeamsPanel tests (teams-self-serve, task 6.2; owner-bootstrap 8.2; spec:
// team-management "Teams management page") ---
//
// The retired `/teams` page body, now Settings › Members' interim content (redesign-show-ignition
// 6.2); these are the TeamsRoute page tests moved with it. The page's own back-to-sessions button
// went with the route: the Settings view's back control replaces it, and AppShell.test.tsx pins
// that closing on `/teams` lands on `/`.
//
// Mocked at module boundaries (the SessionRoute.test.tsx idiom): `useProfile`
// is replaced (this page reads the teams list + roles off it, and the real
// hook's own request/cache behavior is covered by useProfile's own tests
// elsewhere) and `apiFetch` is the sole network seam — every team-detail
// fetch and management mutation runs through the REAL `useTeam`/mutation
// hooks and a REAL QueryClient, so invalidation-driven UI updates (the invite
// round-trip, the owner 409) are exercised for real, not simulated.

vi.mock('../../../../api/hooks/useProfile', () => ({
  useProfile: vi.fn(),
}));

vi.mock('../../../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../api/client')>();
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

// A profile with no user. Unreachable in practice (RootGate renders the login
// view whenever `auth.logged_in` is false, so AppShell never mounts this
// route signed out), but `auth.user` is nullable in the type, so pin what the
// page does with it: no anonymous-mode panel, no team requests.
function signedOutProfile(): ProfilePayload {
  return {
    active_studio_id: '',
    active_show_id: '',
    active_studio: { id: '', name: '', categories: [] },
    studios: [],
    studio_settings: {},
    shows: [],
    new_session_defaults: { title_prefix: '', default_frame_rate: 30 },
    admin: { restart_supported: false, restart_needs_token: false },
    auth: { logged_in: false, oauth_configured: true, user: null },
  } as unknown as ProfilePayload;
}

function detailFixture(overrides: Partial<TeamDetail> = {}): TeamDetail {
  return {
    id: 'team-a',
    name: 'Team A',
    role: 'admin',
    enabled_admin_count: 1,
    members: [
      {
        id: 'owner-1',
        email: 'owner@example.com',
        given_name: 'Ow',
        family_name: 'Ner',
        role: 'owner',
      },
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
      <LegacyTeamsPanel />
    </QueryClientProvider>,
  );
}

const teamsApiCalls = () =>
  mockedApiFetch.mock.calls.filter(([path]) => String(path).startsWith('teams'));

beforeEach(() => {
  mockedApiFetch.mockReset();
});

describe('no anonymous mode (require-login D8)', () => {
  it('renders no anonymous-mode panel and issues no /api/teams requests for a null user', () => {
    renderPage(signedOutProfile());

    expect(screen.getByTestId('legacy-teams-panel')).not.toBeNull();
    expect(document.getElementById('teams-signed-in-required')).toBeNull();
    expect(screen.queryByText(/sign in required/i)).toBeNull();
    expect(screen.queryByText(/anonymous mode/i)).toBeNull();
    expect(teamsApiCalls()).toHaveLength(0);
  });
});

describe('former built-in teams (owner-bootstrap D9)', () => {
  it('render as ordinary expandable team cards', async () => {
    mockedApiFetch.mockResolvedValue(
      detailFixture({ id: 'test-studios', name: 'Test Studio', role: 'member' }),
    );
    renderPage(teamsProfile([{ id: 'test-studios', name: 'Test Studio', role: 'member' }]));

    expect(screen.queryByText('Legacy team — managed by support.')).toBeNull();
    fireEvent.click(screen.getByTestId('team-toggle-test-studios'));
    await waitFor(() =>
      expect(screen.getByTestId('team-member-panel-test-studios')).not.toBeNull(),
    );
    expect(teamsApiCalls()).toHaveLength(1);
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

describe('owner rules surfaced as an actionable message', () => {
  it('a refused role change shows the 409 detail text', async () => {
    mockedApiFetch.mockImplementation(async (path: string, opts?: RequestInit) => {
      const method = opts?.method ?? 'GET';
      if (path === 'teams/team-a' && method === 'GET') {
        return detailFixture({
          role: 'owner',
          members: [
            {
              id: 'caller-1',
              email: 'caller@example.com',
              given_name: 'Cal',
              family_name: 'Ler',
              role: 'owner',
            },
            {
              id: 'u2',
              email: 'other@example.com',
              given_name: 'Ot',
              family_name: 'Her',
              role: 'admin',
            },
          ],
        });
      }
      if (path === 'teams/team-a/members/u2/role' && method === 'POST') {
        throw new ApiError(409, 'Transfer ownership first.');
      }
      throw new Error(`unexpected apiFetch: ${method} ${path}`);
    });

    renderPage(teamsProfile([{ id: 'team-a', name: 'Team A', role: 'owner' }]));
    fireEvent.click(screen.getByTestId('team-toggle-team-a'));
    await waitFor(() => expect(screen.getByTestId('team-owner-panel-team-a')).not.toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Make member' }));

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('Transfer ownership first.'),
    );
  });
});

describe('orphaned team is visible as such (scenario: Orphaned team is visible as such)', () => {
  it('a team with no owner renders the contact-support notice instead of member controls', async () => {
    const base = detailFixture({ role: 'member' });
    mockedApiFetch.mockResolvedValue({
      ...base,
      members: base.members.filter((m) => m.role !== 'owner'),
    } satisfies TeamDetail);

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
      new ApiError(400, 'You already own 20 teams; the limit has been reached.'),
    );

    renderPage(teamsProfile([]));

    // shadcn-port-shell D5: Field/Input/Button, and the error is the single destructive Alert.
    expect(screen.getByLabelText('Team id (slug)').getAttribute('data-slot')).toBe('input');
    expect(screen.getByRole('button', { name: 'Create team' }).getAttribute('data-variant')).toBe(
      'default',
    );
    fireEvent.change(screen.getByLabelText('Team id (slug)'), { target: { value: 'my-crew' } });
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'My Crew' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create team' }));

    await waitFor(() => expect(screen.getByRole('alert').getAttribute('data-slot')).toBe('alert'));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        'You already own 20 teams; the limit has been reached.',
      ),
    );
  });
});
