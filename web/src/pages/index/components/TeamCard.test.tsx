import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../../../api/client';
import type { TeamDetail, TeamMember, TeamRole } from '../../../api/types';
import { renderStrict } from '../../../test/renderStrict';
import { TeamCard } from './TeamCard';

// --- TeamCard role views (owner-bootstrap 8.1, design D12; spec: team-management "Teams
// management page") ---
//
// `apiFetch` is the only seam, so the real `useTeam` and mutation hooks run against a real
// QueryClient. Each test expands one card and checks which controls its role's view renders.

vi.mock('../../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/client')>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

const OWNER: TeamMember = {
  id: 'owner-1',
  email: 'owner@example.com',
  given_name: 'Olu',
  family_name: 'Wner',
  role: 'owner',
};
const ADMIN: TeamMember = {
  id: 'admin-1',
  email: 'admin@example.com',
  given_name: 'Ad',
  family_name: 'Min',
  role: 'admin',
};
const MEMBER: TeamMember = {
  id: 'member-1',
  email: 'member@example.com',
  given_name: 'Mem',
  family_name: 'Ber',
  role: 'member',
};

function detail(role: TeamRole, overrides: Partial<TeamDetail> = {}): TeamDetail {
  return {
    id: 'team-a',
    name: 'Team A',
    role,
    enabled_admin_count: 1,
    members: [OWNER, ADMIN, MEMBER],
    ...(role === 'member' ? {} : { invites: [] }),
    ...overrides,
  };
}

function renderCard(role: TeamRole) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderStrict(
    <QueryClientProvider client={client}>
      <ul>
        <TeamCard team={{ id: 'team-a', name: 'Team A', role }} />
      </ul>
    </QueryClientProvider>,
  );
}

async function expand(panelTestId: string): Promise<HTMLElement> {
  fireEvent.click(screen.getByTestId('team-toggle-team-a'));
  await waitFor(() => expect(screen.getByTestId(panelTestId)).not.toBeNull());
  return screen.getByTestId(panelTestId);
}

const row = (panel: HTMLElement, member: TeamMember) =>
  within(panel).getByTestId(`team-member-${member.id}`);

beforeEach(() => {
  mockedApiFetch.mockReset();
});

describe('owner view', () => {
  it('shows role toggles, transfer and remove on other members, delete, and no leave', async () => {
    mockedApiFetch.mockResolvedValue(detail('owner'));
    renderCard('owner');
    const panel = await expand('team-owner-panel-team-a');

    expect(within(panel).getByRole('button', { name: 'Save name' })).not.toBeNull();
    expect(within(panel).getByRole('button', { name: 'Invite' })).not.toBeNull();
    expect(within(panel).getByRole('button', { name: 'Delete team' })).not.toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Leave team' })).toBeNull();

    // The owner's own row carries no controls.
    expect(within(row(panel, OWNER)).queryByRole('button')).toBeNull();
    // An admin row: demote, transfer, remove.
    const adminRow = row(panel, ADMIN);
    expect(within(adminRow).getByRole('button', { name: 'Make member' })).not.toBeNull();
    expect(within(adminRow).getByRole('button', { name: 'Transfer ownership' })).not.toBeNull();
    expect(within(adminRow).getByRole('button', { name: 'Remove' })).not.toBeNull();
    // A member row: promote, transfer, remove.
    const memberRow = row(panel, MEMBER);
    expect(within(memberRow).getByRole('button', { name: 'Make admin' })).not.toBeNull();
    expect(within(memberRow).getByRole('button', { name: 'Transfer ownership' })).not.toBeNull();
    expect(within(memberRow).getByRole('button', { name: 'Remove' })).not.toBeNull();
    expect(screen.queryByTestId('team-orphaned-notice')).toBeNull();
  });

  it('transfers ownership to a member after confirming', async () => {
    mockedApiFetch.mockImplementation(async (path: string, opts?: RequestInit) => {
      if (path === 'teams/team-a' && (opts?.method ?? 'GET') === 'GET') return detail('owner');
      if (path === 'teams/team-a/owner' && opts?.method === 'POST') return { ok: true };
      throw new Error(`unexpected apiFetch: ${opts?.method ?? 'GET'} ${path}`);
    });
    renderCard('owner');
    const panel = await expand('team-owner-panel-team-a');

    fireEvent.click(within(row(panel, MEMBER)).getByRole('button', { name: 'Transfer ownership' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Transfer' }));

    await waitFor(() =>
      expect(mockedApiFetch).toHaveBeenCalledWith('teams/team-a/owner', {
        method: 'POST',
        body: JSON.stringify({ user_id: MEMBER.id }),
      }),
    );
  });

  it('deletes the team after confirming', async () => {
    mockedApiFetch.mockImplementation(async (path: string, opts?: RequestInit) => {
      if (path === 'teams/team-a' && (opts?.method ?? 'GET') === 'GET') return detail('owner');
      if (path === 'teams/team-a' && opts?.method === 'DELETE') return { ok: true };
      throw new Error(`unexpected apiFetch: ${opts?.method ?? 'GET'} ${path}`);
    });
    renderCard('owner');
    const panel = await expand('team-owner-panel-team-a');

    fireEvent.click(within(panel).getByRole('button', { name: 'Delete team' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(mockedApiFetch).toHaveBeenCalledWith('teams/team-a', { method: 'DELETE' }),
    );
  });
});

describe('admin view', () => {
  it('shows rename, invites and remove on member rows only; no role toggles, transfer or delete; leave', async () => {
    mockedApiFetch.mockResolvedValue(
      detail('admin', {
        invites: [{ email: 'pending@example.com', invited_at_utc: '2026-07-14T00:00:00Z' }],
      }),
    );
    renderCard('admin');
    const panel = await expand('team-admin-panel-team-a');

    expect(within(panel).getByRole('button', { name: 'Save name' })).not.toBeNull();
    expect(within(panel).getByRole('button', { name: 'Invite' })).not.toBeNull();
    expect(within(panel).getByText('pending@example.com')).not.toBeNull();
    expect(within(panel).getByRole('button', { name: 'Leave team' })).not.toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Delete team' })).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Make admin' })).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Make member' })).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Transfer ownership' })).toBeNull();

    expect(within(row(panel, OWNER)).queryByRole('button')).toBeNull();
    expect(within(row(panel, ADMIN)).queryByRole('button')).toBeNull();
    expect(within(row(panel, MEMBER)).getByRole('button', { name: 'Remove' })).not.toBeNull();
    expect(screen.queryByTestId('team-orphaned-notice')).toBeNull();
  });

  it('shows the no-owner notice above the admin panel when no member is the owner', async () => {
    mockedApiFetch.mockResolvedValue(detail('admin', { members: [ADMIN, MEMBER] }));
    renderCard('admin');
    const panel = await expand('team-admin-panel-team-a');

    const notice = screen.getByTestId('team-orphaned-notice');
    expect(notice.textContent).toBe('This team has no owner. Contact support.');
    // The notice precedes the panel in document order.
    expect(notice.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('member view', () => {
  it('is unchanged: the read-only members list and leave, no invites', async () => {
    mockedApiFetch.mockResolvedValue(detail('member'));
    renderCard('member');
    const panel = await expand('team-member-panel-team-a');

    expect(within(panel).getByRole('button', { name: 'Leave team' })).not.toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Invite' })).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Remove' })).toBeNull();
    expect(within(row(panel, OWNER)).getByText('owner')).not.toBeNull();
    expect(screen.queryByTestId('team-orphaned-notice')).toBeNull();
  });

  it('a member of a team with no owner sees only the notice', async () => {
    // enabled_admin_count > 0: the notice keys on the owner, not on the admin count.
    mockedApiFetch.mockResolvedValue(
      detail('member', { members: [ADMIN, MEMBER], enabled_admin_count: 1 }),
    );
    renderCard('member');
    fireEvent.click(screen.getByTestId('team-toggle-team-a'));

    await waitFor(() => expect(screen.getByTestId('team-orphaned-notice')).not.toBeNull());
    expect(screen.getByTestId('team-orphaned-notice').textContent).toBe(
      'This team has no owner. Contact support.',
    );
    expect(screen.queryByTestId('team-member-panel-team-a')).toBeNull();
    expect(screen.queryByTestId('team-admin-panel-team-a')).toBeNull();
  });

  it('a member of an owned team with no admins sees the member panel, not the notice', async () => {
    mockedApiFetch.mockResolvedValue(
      detail('member', { members: [OWNER, MEMBER], enabled_admin_count: 0 }),
    );
    renderCard('member');
    await expand('team-member-panel-team-a');
    expect(screen.queryByTestId('team-orphaned-notice')).toBeNull();
  });
});

// --- Show-access picker (show-grants D13; spec: team-management "Teams management page",
// "Granting a show from the team page") ---
describe('show-access picker', () => {
  const SHOWS = [
    { id: 'show-1', name: 'Morning News' },
    { id: 'show-2', name: 'Evening News' },
  ].map((s) => ({
    ...s,
    studio_id: 'team-a',
    show_code: s.id.toUpperCase(),
    title_suffix: 'date',
    categories: [],
    event_palette: [],
    event_palette_preset: 'custom',
    event_palette_custom: [],
  }));

  function routes(role: TeamRole) {
    const members = [
      { ...OWNER, show_ids: [] },
      { ...ADMIN, show_ids: [] },
      { ...MEMBER, show_ids: ['show-2'] },
    ];
    mockedApiFetch.mockImplementation(async (path: string, opts?: RequestInit) => {
      const method = opts?.method ?? 'GET';
      if (path === 'teams/team-a' && method === 'GET') {
        return role === 'member' ? detail(role) : detail(role, { members });
      }
      if (path === 'shows?studio_id=team-a' && method === 'GET') return { shows: SHOWS };
      if (path.startsWith('teams/team-a/shows/') && (method === 'PUT' || method === 'DELETE')) {
        return { ok: true };
      }
      throw new Error(`unexpected apiFetch: ${method} ${path}`);
    });
  }

  for (const role of ['owner', 'admin'] as const) {
    it(`${role} view: a checkbox per team show on member rows only, checked from show_ids`, async () => {
      routes(role);
      renderCard(role);
      const panel = await expand(`team-${role}-panel-team-a`);

      expect(within(row(panel, OWNER)).queryByRole('button', { name: 'Show access' })).toBeNull();
      expect(within(row(panel, ADMIN)).queryByRole('button', { name: 'Show access' })).toBeNull();
      fireEvent.click(within(row(panel, MEMBER)).getByRole('button', { name: 'Show access' }));

      const morning = await within(row(panel, MEMBER)).findByRole('checkbox', {
        name: 'Morning News',
      });
      const evening = within(row(panel, MEMBER)).getByRole('checkbox', { name: 'Evening News' });
      expect((morning as HTMLInputElement).checked).toBe(false);
      expect((evening as HTMLInputElement).checked).toBe(true);
    });
  }

  it('toggling a checkbox grants (PUT) or revokes (DELETE) that show', async () => {
    routes('admin');
    renderCard('admin');
    const panel = await expand('team-admin-panel-team-a');
    fireEvent.click(within(row(panel, MEMBER)).getByRole('button', { name: 'Show access' }));

    fireEvent.click(
      await within(row(panel, MEMBER)).findByRole('checkbox', { name: 'Morning News' }),
    );
    await waitFor(() =>
      expect(mockedApiFetch).toHaveBeenCalledWith('teams/team-a/shows/show-1/grants/member-1', {
        method: 'PUT',
      }),
    );

    fireEvent.click(within(row(panel, MEMBER)).getByRole('checkbox', { name: 'Evening News' }));
    await waitFor(() =>
      expect(mockedApiFetch).toHaveBeenCalledWith('teams/team-a/shows/show-2/grants/member-1', {
        method: 'DELETE',
      }),
    );
  });

  it('member view: no picker', async () => {
    routes('member');
    renderCard('member');
    const panel = await expand('team-member-panel-team-a');
    expect(within(panel).queryByRole('button', { name: 'Show access' })).toBeNull();
    expect(within(panel).queryByRole('checkbox')).toBeNull();
  });
});
