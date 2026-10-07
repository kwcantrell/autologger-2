import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch } from '../../../../api/client';
import type { ProfilePayload, TeamDetail, TeamMember, TeamRole } from '../../../../api/types';
import { renderStrict } from '../../../../test/renderStrict';
import { SettingsView } from './SettingsView';
import type { SettingsSectionId } from './sections';

// --- Settings › Members (redesign-show-ignition 8.1; team-management "Teams management page":
// the role matrix, the show-access picker, the invite round-trip and the no-owner notice;
// web-ui-system "Honest save model in Settings", side panels) ---
//
// Ports the previous team card's and teams page's assertions (TeamCard.test.tsx,
// LegacyTeamsPanel.test.tsx) to the Members list and the member panel. The real view, sections,
// hooks and QueryClient; `apiFetch` is the one seam, and it plays a small server: mutations change
// the team detail the next GET returns, so "reflected without a reload" is exercised for real.

vi.mock('../../../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../api/client')>();
  return { ...actual, apiFetch: vi.fn() };
});
vi.mock('../../utils/toast', () => ({ showToast: vi.fn() }));

const mockedApiFetch = vi.mocked(apiFetch);

const OWNER: TeamMember = {
  id: 'owner-1',
  email: 'owner@example.com',
  given_name: 'Olu',
  family_name: 'Wner',
  role: 'owner',
  show_ids: [],
};
const ADMIN: TeamMember = {
  id: 'admin-1',
  email: 'admin@example.com',
  given_name: 'Ad',
  family_name: 'Min',
  role: 'admin',
  show_ids: [],
};
const MEMBER: TeamMember = {
  id: 'member-1',
  email: 'member@example.com',
  given_name: 'Mem',
  family_name: 'Ber',
  role: 'member',
  show_ids: ['show-1'],
};
const SELF: Record<TeamRole, string> = { owner: 'owner-1', admin: 'admin-1', member: 'member-1' };

function detail(role: TeamRole, overrides: Partial<TeamDetail> = {}): TeamDetail {
  const members = [OWNER, ADMIN, MEMBER].map((m) =>
    // A member caller gets no one's show access (the server omits it, like invites).
    role === 'member' ? { ...m, show_ids: undefined } : { ...m },
  );
  return {
    id: 'team-a',
    name: 'Team A',
    role,
    enabled_admin_count: 1,
    members,
    ...(role === 'member'
      ? {}
      : { invites: [{ email: 'pending@example.com', invited_at_utc: '2026-10-01T00:00:00Z' }] }),
    ...overrides,
  };
}

function profileAs(role: TeamRole): ProfilePayload {
  return {
    active_studio_id: 'team-a',
    active_show_id: 'show-1',
    active_studio: { id: 'team-a', name: 'Team A', categories: [] },
    studios: [{ id: 'team-a', name: 'Team A', categories: [] }],
    studio_settings: {},
    shows: [1, 2].map((i) => ({
      id: `show-${i}`,
      studio_id: 'team-a',
      name: `Show ${i}`,
      show_code: `S${i}`,
      title_suffix: 'date',
      can_access: true,
    })),
    new_session_defaults: { title_prefix: '', default_frame_rate: 25 },
    admin: { restart_supported: false, restart_needs_token: false },
    auth: {
      logged_in: true,
      oauth_configured: true,
      user: {
        id: SELF[role],
        email: `${role}@example.com`,
        given_name: 'Me',
        family_name: '',
        picture_url: null,
        teams: [{ id: 'team-a', name: 'Team A', role }],
      },
    },
  } as unknown as ProfilePayload;
}

let profile: ProfilePayload;
let teamDetail: TeamDetail;
let failGrant: Error | null = null;
let failRole: Error | null = null;

const member = (id: string) => teamDetail.members.find((m) => m.id === id) as TeamMember;

function route() {
  mockedApiFetch.mockImplementation(async (path: string, opts?: RequestInit) => {
    const method = opts?.method ?? 'GET';
    if (path === 'profile' && method === 'GET') return profile;
    if (path === 'shows?studio_id=team-a') return { shows: [] };
    if (path === 'teams/team-a' && method === 'GET') return structuredClone(teamDetail);
    if (path === 'teams/team-a/invites' && method === 'POST') {
      const { email } = JSON.parse(String(opts?.body));
      teamDetail.invites = [
        ...(teamDetail.invites ?? []),
        { email, invited_at_utc: '2026-10-07T00:00:00Z' },
      ];
      return { ok: true };
    }
    const revoke = path.match(/^teams\/team-a\/invites\/(.+)$/);
    if (revoke && method === 'DELETE') {
      const email = decodeURIComponent(revoke[1]);
      teamDetail.invites = (teamDetail.invites ?? []).filter((i) => i.email !== email);
      return { ok: true };
    }
    const role = path.match(/^teams\/team-a\/members\/([^/]+)\/role$/);
    if (role && method === 'POST') {
      if (failRole) throw failRole;
      const next = JSON.parse(String(opts?.body)).role;
      member(role[1]).role = next;
      return { ok: true, role: next };
    }
    const grant = path.match(/^teams\/team-a\/shows\/([^/]+)\/grants\/([^/]+)$/);
    if (grant && (method === 'PUT' || method === 'DELETE')) {
      if (failGrant) throw failGrant;
      const m = member(grant[2]);
      const ids = new Set(m.show_ids ?? []);
      if (method === 'PUT') ids.add(grant[1]);
      else ids.delete(grant[1]);
      m.show_ids = [...ids].sort();
      return { ok: true };
    }
    const remove = path.match(/^teams\/team-a\/members\/([^/]+)$/);
    if (remove && method === 'DELETE') {
      teamDetail.members = teamDetail.members.filter((m) => m.id !== remove[1]);
      return { ok: true };
    }
    throw new Error(`unexpected apiFetch: ${method} ${path}`);
  });
}

function Harness() {
  const [section, setSection] = useState<SettingsSectionId>('members');
  return (
    <SettingsView
      section={section}
      onSectionChange={setSection}
      onClose={vi.fn()}
      onCloseSession={vi.fn()}
      backLabel="Back to sessions"
    />
  );
}

function renderMembers(role: TeamRole, d?: TeamDetail) {
  profile = profileAs(role);
  teamDetail = d ?? detail(role);
  route();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['profile'], profile);
  renderStrict(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
  return client;
}

const section = () => document.getElementById('settings-section-members') as HTMLElement;
const inSection = () => within(section());
const row = (id: string) => screen.getByTestId(`member-row-${id}`);
const findRow = (id: string) => screen.findByTestId(`member-row-${id}`);
const sheet = () => screen.getByRole('dialog', { name: /./, hidden: false }) as HTMLElement;
const openPanel = async (id: string, name: RegExp) => {
  fireEvent.click(within(await findRow(id)).getByRole('button', { name }));
  return screen.findByRole('dialog', { name });
};
const calls = (method: string, path: string) =>
  mockedApiFetch.mock.calls.filter(([p, o]) => p === path && (o?.method ?? 'GET') === method);

beforeEach(() => {
  mockedApiFetch.mockReset();
  failGrant = null;
  failRole = null;
});

describe('Members list', () => {
  it('lists each member with initials, name, email, role and show access', async () => {
    renderMembers('owner');
    const m = await findRow('member-1');
    expect(m.closest('[data-slot="item-group"]')).not.toBeNull();
    expect(m.getAttribute('data-slot')).toBe('item');
    expect(within(m).getByText('MB')).not.toBeNull();
    expect(within(m).getByText('Mem Ber')).not.toBeNull();
    expect(within(m).getByText('member@example.com')).not.toBeNull();
    expect(within(m).getByText('Member')).not.toBeNull();
    expect(within(m).getByText('1 of 2 shows')).not.toBeNull();
    expect(within(row('admin-1')).getByText('All shows')).not.toBeNull();
    expect(within(row('owner-1')).getByText('Owner')).not.toBeNull();
    // The caller's own row says so.
    expect(within(row('owner-1')).getByText('You')).not.toBeNull();
    expect(inSection().getByText('3 members · 1 invited')).not.toBeNull();
  });

  it('a member’s view is read-only: no invites, no one’s show access, controls disabled under a role notice', async () => {
    renderMembers('member');
    const m = await findRow('owner-1');
    expect(within(m).getByText('Owner')).not.toBeNull();
    expect(section().querySelector('[data-slot="settings-role-notice"]')?.textContent).toContain(
      'You’re a member of Team A',
    );
    expect((inSection().getByLabelText('Email address') as HTMLInputElement).disabled).toBe(true);
    expect(inSection().getByRole('button', { name: 'Send invite' }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(screen.queryByTestId('invite-row-pending@example.com')).toBeNull();
    expect(inSection().queryByText(/of 2 shows|All shows/)).toBeNull();
    expect(inSection().queryByRole('button', { name: /Mem Ber/ })).toBeNull();
  });

  it('Invite flow round-trip: an invite appears in the list, and disappears when revoked', async () => {
    renderMembers('admin', detail('admin', { invites: [] }));
    await findRow('member-1');
    fireEvent.change(inSection().getByLabelText('Email address'), {
      target: { value: 'new@example.com' },
    });
    fireEvent.click(inSection().getByRole('button', { name: 'Send invite' }));
    const invite = await screen.findByTestId('invite-row-new@example.com');
    expect(within(invite).getByText('Invited. Joins at first sign-in.')).not.toBeNull();
    expect((inSection().getByLabelText('Email address') as HTMLInputElement).value).toBe('');

    fireEvent.click(within(invite).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(screen.queryByTestId('invite-row-new@example.com')).toBeNull());
    expect(calls('DELETE', 'teams/team-a/invites/new%40example.com')).toHaveLength(1);
  });

  it('a refused invite says why', async () => {
    renderMembers('owner');
    await findRow('member-1');
    mockedApiFetch.mockImplementationOnce(async () => {
      throw new ApiError(400, 'That email is already on the team.');
    });
    fireEvent.change(inSection().getByLabelText('Email address'), {
      target: { value: 'member@example.com' },
    });
    fireEvent.click(inSection().getByRole('button', { name: 'Send invite' }));
    expect((await inSection().findByRole('alert')).textContent).toContain(
      'That email is already on the team.',
    );
  });

  it('Orphaned team is visible as such: a member sees the notice instead of the list', async () => {
    renderMembers('member', detail('member', { members: [ADMIN, MEMBER] }));
    const notice = await screen.findByTestId('team-orphaned-notice');
    expect(notice.textContent).toBe('This team has no owner. Contact support.');
    expect(screen.queryByTestId('member-row-member-1')).toBeNull();
  });

  it('an admin of an ownerless team keeps the controls under the notice', async () => {
    renderMembers('admin', detail('admin', { members: [ADMIN, MEMBER] }));
    const notice = await screen.findByTestId('team-orphaned-notice');
    const input = inSection().getByLabelText('Email address') as HTMLInputElement;
    expect(input.disabled).toBe(false);
    expect(notice.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(await findRow('member-1')).not.toBeNull();
  });
});

describe('Member panel: role matrix', () => {
  it('owner: a member’s panel offers the role choice, show access and remove', async () => {
    renderMembers('owner');
    const panel = await openPanel('member-1', /Mem Ber/);
    expect(within(panel).getByRole('radiogroup', { name: 'Role' })).not.toBeNull();
    expect(within(panel).getByRole('radio', { name: 'Member' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    const access = within(panel).getByRole('group', { name: 'Show access' });
    expect(
      within(access).getByRole('checkbox', { name: 'Show 1' }).getAttribute('aria-checked'),
    ).toBe('true');
    expect(
      within(access).getByRole('checkbox', { name: 'Show 2' }).getAttribute('aria-checked'),
    ).toBe('false');
    expect(within(panel).getByRole('button', { name: 'Remove…' })).not.toBeNull();
  });

  it('owner: the owner’s own panel has no role choice, no picker and no remove', async () => {
    renderMembers('owner');
    const panel = await openPanel('owner-1', /Olu Wner/);
    expect(within(panel).queryByRole('radio')).toBeNull();
    expect(within(panel).queryByRole('checkbox')).toBeNull();
    expect(panel.textContent).toContain('Owners can open every show');
    expect(within(panel).queryByRole('button', { name: 'Remove…' })).toBeNull();
  });

  it('admin: panels offer no role choice; a member row has remove and access, an admin row neither', async () => {
    renderMembers('admin');
    const panel = await openPanel('member-1', /Mem Ber/);
    expect(within(panel).queryByRole('radio')).toBeNull();
    expect(within(panel).getByText('Member')).not.toBeNull();
    expect(within(panel).getAllByRole('checkbox')).toHaveLength(2);
    expect(within(panel).getByRole('button', { name: 'Remove…' })).not.toBeNull();
    fireEvent.click(within(panel).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Mem Ber/ })).toBeNull());

    const own = await openPanel('admin-1', /Ad Min/);
    expect(within(own).queryByRole('radio')).toBeNull();
    expect(within(own).queryByRole('checkbox')).toBeNull();
    expect(own.textContent).toContain('Admins can open every show');
    expect(within(own).queryByRole('button', { name: 'Remove…' })).toBeNull();
  });
});

describe('Member panel: saving', () => {
  it('Granting a show from the team page: tick, save, reopen, untick, save', async () => {
    renderMembers('admin');
    let panel = await openPanel('member-1', /Mem Ber/);
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Show 2' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Mem Ber/ })).toBeNull());
    expect(calls('PUT', 'teams/team-a/shows/show-2/grants/member-1')).toHaveLength(1);
    expect(calls('DELETE', 'teams/team-a/shows/show-1/grants/member-1')).toHaveLength(0);
    await waitFor(() => expect(within(row('member-1')).getByText('2 of 2 shows')).not.toBeNull());

    panel = await openPanel('member-1', /Mem Ber/);
    expect(
      within(panel).getByRole('checkbox', { name: 'Show 2' }).getAttribute('aria-checked'),
    ).toBe('true');
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Show 2' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Mem Ber/ })).toBeNull());
    expect(calls('DELETE', 'teams/team-a/shows/show-2/grants/member-1')).toHaveLength(1);
    await waitFor(() => expect(within(row('member-1')).getByText('1 of 2 shows')).not.toBeNull());
  });

  it('owner: a role change saves as a role request, and the picker follows the chosen role', async () => {
    renderMembers('owner');
    const panel = await openPanel('member-1', /Mem Ber/);
    fireEvent.click(within(panel).getByRole('radio', { name: 'Admin' }));
    expect(within(panel).queryByRole('checkbox')).toBeNull();
    fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls('POST', 'teams/team-a/members/member-1/role')).toHaveLength(1),
    );
    expect(
      JSON.parse(String(calls('POST', 'teams/team-a/members/member-1/role')[0][1]?.body)),
    ).toEqual({ role: 'admin' });
    await waitFor(() => expect(within(row('member-1')).getByText('Admin')).not.toBeNull());
  });

  it('A partly failed panel save stays open: a failed grant keeps the panel open and the role change already applied is shown', async () => {
    renderMembers('owner');
    const panel = await openPanel('admin-1', /Ad Min/);
    fireEvent.click(within(panel).getByRole('radio', { name: 'Member' }));
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Show 2' }));
    failGrant = new ApiError(400, 'Grant refused.');
    fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));

    expect((await within(panel).findByRole('alert')).textContent).toContain(
      'Couldn’t give access to Show 2: Grant refused.',
    );
    // Role first, then the grant; the panel is still open with its edits.
    const order = mockedApiFetch.mock.calls
      .filter(([, o]) => o?.method === 'POST' || o?.method === 'PUT')
      .map(([p, o]) => `${o?.method} ${p}`);
    expect(order).toEqual([
      'POST teams/team-a/members/admin-1/role',
      'PUT teams/team-a/shows/show-2/grants/admin-1',
    ]);
    expect(screen.getByRole('dialog', { name: /Ad Min/ })).not.toBeNull();
    expect(
      within(panel).getByRole('checkbox', { name: 'Show 2' }).getAttribute('aria-checked'),
    ).toBe('true');
    // The applied role shows in the list without a reload.
    await waitFor(() => expect(within(row('admin-1')).getByText('Member')).not.toBeNull());

    // A retry sends only what did not apply.
    failGrant = null;
    fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Ad Min/ })).toBeNull());
    expect(calls('POST', 'teams/team-a/members/admin-1/role')).toHaveLength(1);
    expect(calls('PUT', 'teams/team-a/shows/show-2/grants/admin-1')).toHaveLength(2);
  });

  it('a refused role change names the step and the server’s reason', async () => {
    renderMembers('owner');
    const panel = await openPanel('admin-1', /Ad Min/);
    fireEvent.click(within(panel).getByRole('radio', { name: 'Member' }));
    failRole = new ApiError(409, 'Transfer ownership first.');
    fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));
    expect((await within(panel).findByRole('alert')).textContent).toBe(
      'Couldn’t change the role to Member: Transfer ownership first.',
    );
  });

  it('remove is confirmed, staged until Save, and Cancel keeps the member', async () => {
    renderMembers('admin');
    const panel = await openPanel('member-1', /Mem Ber/);
    fireEvent.click(within(panel).getByRole('button', { name: 'Remove…' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm.textContent).toContain('member@example.com');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(panel.textContent).toContain('will be removed from Team A when you save');
    expect(calls('DELETE', 'teams/team-a/members/member-1')).toHaveLength(0);

    fireEvent.click(within(panel).getByRole('button', { name: 'Remove member' }));
    await waitFor(() => expect(calls('DELETE', 'teams/team-a/members/member-1')).toHaveLength(1));
    await waitFor(() => expect(screen.queryByTestId('member-row-member-1')).toBeNull());
  });

  it('a dirty panel asks before closing', async () => {
    renderMembers('admin');
    const panel = await openPanel('member-1', /Mem Ber/);
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Show 2' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Cancel' }));
    const confirm = await screen.findByRole('alertdialog');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(sheet()).not.toBeNull();
    expect(calls('PUT', 'teams/team-a/shows/show-2/grants/member-1')).toHaveLength(0);
  });
});

describe('Members without a team', () => {
  it('a team-less account sees a pointer to create one and issues no /api/teams request', () => {
    profile = {
      ...profileAs('owner'),
      active_studio_id: '',
      active_show_id: '',
      studios: [],
      shows: [],
    } as ProfilePayload;
    teamDetail = detail('owner');
    route();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['profile'], profile);
    renderStrict(
      <QueryClientProvider client={client}>
        <Harness />
      </QueryClientProvider>,
    );
    expect(inSection().getByRole('button', { name: 'Go to Team details' })).not.toBeNull();
    expect(mockedApiFetch.mock.calls.filter(([p]) => String(p).startsWith('teams'))).toEqual([]);
  });
});
