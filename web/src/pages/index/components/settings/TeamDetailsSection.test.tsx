import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch } from '../../../../api/client';
import type { ProfilePayload, TeamDetail, TeamMember, TeamRole } from '../../../../api/types';
import { renderStrict } from '../../../../test/renderStrict';
import { SettingsView } from './SettingsView';
import type { SettingsSectionId } from './sections';

// --- Settings › Team details (redesign-show-ignition 7.3; team-management "Teams management
// page" role matrix, "Deleting a team that still has shows", the no-owner notice; web-ui-system
// "Honest save model in Settings") ---
//
// Ports the owner, admin and member view assertions of the previous team card (TeamCard.test.tsx)
// to Team details: rename, frame rate, transfer, leave, delete and create, each by role. The real
// view, hooks and QueryClient; `apiFetch` is the one seam. The frame-rate control is the shared
// `FpsSelect` (a shadcn Select), stood in by a native select so a value can be picked in jsdom.

vi.mock('../../../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../api/client')>();
  return { ...actual, apiFetch: vi.fn() };
});
vi.mock('../../utils/toast', () => ({ showToast: vi.fn() }));
vi.mock('../FpsSelect', () => ({
  FpsSelect: (props: {
    id?: string;
    value: number;
    disabled?: boolean;
    onChange: (fps: number) => void;
  }) => (
    <select
      id={props.id}
      value={String(props.value)}
      disabled={props.disabled}
      onChange={(e) => props.onChange(Number.parseFloat(e.target.value))}
    >
      {['24', '25', '29.97', '30'].map((v) => (
        <option key={v} value={v}>
          {v}
        </option>
      ))}
    </select>
  ),
}));

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

function profileAs(role: TeamRole, { shows = 1 }: { shows?: number } = {}): ProfilePayload {
  return {
    active_studio_id: 'team-a',
    active_show_id: shows ? 'show-1' : '',
    active_studio: { id: 'team-a', name: 'Team A', categories: [] },
    studios: [{ id: 'team-a', name: 'Team A', categories: [] }],
    studio_settings: { 'team-a': { default_frame_rate: 25, title_format: '{code}' } },
    shows: Array.from({ length: shows }, (_, i) => ({
      id: `show-${i + 1}`,
      studio_id: 'team-a',
      name: `Show ${i + 1}`,
      show_code: `S${i + 1}`,
      title_suffix: 'date',
      can_access: true,
    })),
    new_session_defaults: { title_prefix: '', default_frame_rate: 25 },
    admin: { restart_supported: false, restart_needs_token: false },
    auth: {
      logged_in: true,
      oauth_configured: true,
      user: {
        email: 'me@example.com',
        given_name: 'Me',
        family_name: '',
        teams: [{ id: 'team-a', name: 'Team A', role }],
      },
    },
  } as unknown as ProfilePayload;
}

let profile: ProfilePayload;
let teamDetail: TeamDetail;
let failRename = false;
let failProfile = false;
const onCloseSession = vi.fn();

function route() {
  mockedApiFetch.mockImplementation(async (path: string, opts?: RequestInit) => {
    const method = opts?.method ?? 'GET';
    if (path === 'profile' && method === 'GET') return profile;
    if (path === 'profile' && method === 'PUT') {
      if (failProfile) throw new Error('Admin role required.');
      return profile;
    }
    if (path === 'shows?studio_id=team-a') return { shows: [] };
    if (path === 'teams/team-a' && method === 'GET') return teamDetail;
    if (path === 'teams/team-a' && method === 'PATCH') {
      if (failRename) throw new Error('Name taken.');
      return { id: 'team-a', name: JSON.parse(String(opts?.body)).display_name };
    }
    if (path === 'teams/team-a' && method === 'DELETE') return { ok: true };
    if (path === 'teams/team-a/owner' && method === 'POST') return { ok: true };
    if (path === 'teams/team-a/leave' && method === 'POST') return { ok: true };
    if (path === 'teams' && method === 'POST') return { id: 'new', name: 'New', role: 'owner' };
    throw new Error(`unexpected apiFetch: ${method} ${path}`);
  });
}

function Harness() {
  const [section, setSection] = useState<SettingsSectionId>('team-details');
  return (
    <SettingsView
      section={section}
      onSectionChange={setSection}
      onClose={vi.fn()}
      onCloseSession={onCloseSession}
      backLabel="Back to sessions"
    />
  );
}

function renderTeamDetails(role: TeamRole, opts: { shows?: number } = {}, d?: TeamDetail) {
  profile = profileAs(role, opts);
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

const panel = () => document.getElementById('settings-section-team-details') as HTMLElement;
const inPanel = () => within(panel());
const save = () => inPanel().getByRole('button', { name: /^Save/ });
const calls = (method: string, path: string) =>
  mockedApiFetch.mock.calls.filter(([p, o]) => p === path && (o?.method ?? 'GET') === method);

beforeEach(() => {
  mockedApiFetch.mockReset();
  failRename = false;
  failProfile = false;
  onCloseSession.mockReset();
});

describe('Team details: owner view', () => {
  it('offers rename, frame rate, transfer ownership and delete team, and no leave', async () => {
    renderTeamDetails('owner', { shows: 0 });
    expect((inPanel().getByLabelText('Team name') as HTMLInputElement).value).toBe('Team A');
    expect((inPanel().getByLabelText('Team name') as HTMLInputElement).disabled).toBe(false);
    expect((inPanel().getByLabelText('Default frame rate') as HTMLSelectElement).value).toBe('25');
    expect(inPanel().getByText('team-a')).not.toBeNull();
    expect(await inPanel().findByRole('button', { name: 'Transfer…' })).not.toBeNull();
    expect(inPanel().getByRole('button', { name: 'Delete team' })).not.toBeNull();
    expect(inPanel().queryByRole('button', { name: 'Leave team' })).toBeNull();
    expect(inPanel().getByRole('button', { name: 'Create team' })).not.toBeNull();
    expect(screen.queryByTestId('team-orphaned-notice')).toBeNull();
    expect(panel().querySelector('[data-slot="settings-role-notice"]')).toBeNull();
    expect(inPanel().queryByRole('button', { name: 'Go to Members' })).toBeNull();
  });

  it('transfers ownership to a chosen member after confirming', async () => {
    renderTeamDetails('owner');
    fireEvent.pointerDown(await inPanel().findByRole('button', { name: 'Transfer…' }), {
      button: 0,
      ctrlKey: false,
    });
    const items = await screen.findAllByRole('menuitem');
    // Every member but the owner.
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining('Ad Min'),
      expect.stringContaining('Mem Ber'),
    ]);
    fireEvent.click(items[1]);
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('member@example.com');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Transfer' }));
    await waitFor(() =>
      expect(mockedApiFetch).toHaveBeenCalledWith('teams/team-a/owner', {
        method: 'POST',
        body: JSON.stringify({ user_id: MEMBER.id }),
      }),
    );
  });

  it('Deleting a team that still has shows: delete is unavailable and says a team with shows can’t be deleted', async () => {
    renderTeamDetails('owner', { shows: 2 });
    const del = await inPanel().findByRole('button', { name: 'Delete team' });
    expect(del.hasAttribute('disabled')).toBe(true);
    expect(panel().textContent).toContain(
      'Team A still has 2 shows, and a team with shows can’t be deleted.',
    );
    // Deleting shows has no UI, so the reason gives no instruction to remove them.
    expect(panel().textContent).not.toMatch(/remove/i);
    fireEvent.click(del);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(calls('DELETE', 'teams/team-a')).toHaveLength(0);
  });

  it('deletes a team with no shows after confirming', async () => {
    renderTeamDetails('owner', { shows: 0 });
    fireEvent.click(await inPanel().findByRole('button', { name: 'Delete team' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(calls('DELETE', 'teams/team-a')).toHaveLength(1));
  });
});

describe('Team details: admin view', () => {
  it('offers rename, frame rate and leave; no transfer and no delete', async () => {
    renderTeamDetails('admin');
    expect((inPanel().getByLabelText('Team name') as HTMLInputElement).disabled).toBe(false);
    expect((inPanel().getByLabelText('Default frame rate') as HTMLSelectElement).disabled).toBe(
      false,
    );
    expect(await inPanel().findByRole('button', { name: 'Leave team' })).not.toBeNull();
    expect(inPanel().queryByRole('button', { name: 'Transfer…' })).toBeNull();
    expect(inPanel().queryByRole('button', { name: 'Delete team' })).toBeNull();
  });

  it('shows the no-owner notice above the admin controls when no member is the owner', async () => {
    renderTeamDetails('admin', {}, detail('admin', { members: [ADMIN, MEMBER] }));
    const notice = await screen.findByTestId('team-orphaned-notice');
    expect(notice.textContent).toBe('This team has no owner. Contact support.');
    expect(notice.getAttribute('role')).toBe('status');
    expect(notice.getAttribute('data-slot')).toBe('alert');
    // The admin controls stay, below the notice.
    const name = inPanel().getByLabelText('Team name');
    expect(notice.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect((name as HTMLInputElement).disabled).toBe(false);
  });

  it('leaves the team after confirming, and follows the close-session path', async () => {
    renderTeamDetails('admin');
    fireEvent.click(await inPanel().findByRole('button', { name: 'Leave team' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Leave team' }));
    await waitFor(() => expect(calls('POST', 'teams/team-a/leave')).toHaveLength(1));
    await waitFor(() => expect(onCloseSession).toHaveBeenCalledTimes(1));
  });
});

describe('Team details: member view', () => {
  it('a member sees the team name and frame rate disabled under a role notice, and leave', async () => {
    renderTeamDetails('member');
    expect((inPanel().getByLabelText('Team name') as HTMLInputElement).disabled).toBe(true);
    expect((inPanel().getByLabelText('Default frame rate') as HTMLSelectElement).disabled).toBe(
      true,
    );
    expect(panel().querySelector('[data-slot="settings-role-notice"]')?.textContent).toContain(
      'You’re a member of Team A',
    );
    expect(save().hasAttribute('disabled')).toBe(true);
    expect(await inPanel().findByRole('button', { name: 'Leave team' })).not.toBeNull();
    expect(inPanel().queryByRole('button', { name: 'Transfer…' })).toBeNull();
    expect(inPanel().queryByRole('button', { name: 'Delete team' })).toBeNull();
    // Anyone can create a team.
    expect(inPanel().getByRole('button', { name: 'Create team' })).not.toBeNull();
  });

  it('a member of a team with no owner sees the notice and no leave', async () => {
    renderTeamDetails('member', {}, detail('member', { members: [ADMIN, MEMBER] }));
    expect((await screen.findByTestId('team-orphaned-notice')).textContent).toBe(
      'This team has no owner. Contact support.',
    );
    expect(inPanel().queryByRole('button', { name: 'Leave team' })).toBeNull();
  });
});

describe('Team details: saving', () => {
  it('a frame-rate save keeps the other settings keys, the team and the current show', async () => {
    renderTeamDetails('owner');
    fireEvent.change(inPanel().getByLabelText('Default frame rate'), {
      target: { value: '29.97' },
    });
    expect(save().textContent).toBe('Save');
    fireEvent.click(save());
    await waitFor(() => expect(calls('PUT', 'profile')).toHaveLength(1));
    expect(JSON.parse(String(calls('PUT', 'profile')[0][1]?.body))).toEqual({
      active_studio_id: 'team-a',
      active_show_id: 'show-1',
      settings: { default_frame_rate: 29.97, title_format: '{code}' },
    });
    expect(calls('PATCH', 'teams/team-a')).toHaveLength(0);
    await waitFor(() => expect(save().textContent).toBe('Saved'));
  });

  it('a rename alone sends only PATCH /api/teams/:id', async () => {
    renderTeamDetails('admin');
    fireEvent.change(inPanel().getByLabelText('Team name'), { target: { value: 'Team Alpha' } });
    fireEvent.click(save());
    await waitFor(() => expect(calls('PATCH', 'teams/team-a')).toHaveLength(1));
    expect(JSON.parse(String(calls('PATCH', 'teams/team-a')[0][1]?.body))).toEqual({
      display_name: 'Team Alpha',
    });
    expect(calls('PUT', 'profile')).toHaveLength(0);
    await waitFor(() => expect(save().textContent).toBe('Saved'));
  });

  it('with both dirty, renames first, then writes the profile', async () => {
    renderTeamDetails('owner');
    fireEvent.change(inPanel().getByLabelText('Team name'), { target: { value: 'Team Alpha' } });
    fireEvent.change(inPanel().getByLabelText('Default frame rate'), { target: { value: '30' } });
    fireEvent.click(save());
    await waitFor(() => expect(calls('PUT', 'profile')).toHaveLength(1));
    const order = mockedApiFetch.mock.calls
      .filter(([, o]) => o?.method === 'PATCH' || o?.method === 'PUT')
      .map(([p, o]) => `${o?.method} ${p}`);
    expect(order).toEqual(['PATCH teams/team-a', 'PUT profile']);
  });

  it('a failed rename stops before the profile write and names what did not apply', async () => {
    failRename = true;
    renderTeamDetails('owner');
    fireEvent.change(inPanel().getByLabelText('Team name'), { target: { value: 'Team Alpha' } });
    fireEvent.change(inPanel().getByLabelText('Default frame rate'), { target: { value: '30' } });
    fireEvent.click(save());
    const alert = await within(
      panel().querySelector('[data-slot="settings-save-bar"]') as HTMLElement,
    ).findByRole('alert');
    expect(alert.textContent).toContain('Couldn’t rename the team: Name taken.');
    expect(calls('PUT', 'profile')).toHaveLength(0);
    expect(save().textContent).toBe('Save');
  });

  it('a failed frame-rate write after a good rename keeps only the frame rate unsaved', async () => {
    failProfile = true;
    renderTeamDetails('owner');
    fireEvent.change(inPanel().getByLabelText('Team name'), { target: { value: 'Team Alpha' } });
    fireEvent.change(inPanel().getByLabelText('Default frame rate'), { target: { value: '30' } });
    fireEvent.click(save());
    const bar = panel().querySelector('[data-slot="settings-save-bar"]') as HTMLElement;
    expect((await within(bar).findByRole('alert')).textContent).toContain(
      'Couldn’t save the default frame rate: Admin role required.',
    );
    // The rename applied; retrying sends just the frame rate.
    failProfile = false;
    fireEvent.click(save());
    await waitFor(() => expect(calls('PUT', 'profile')).toHaveLength(2));
    expect(calls('PATCH', 'teams/team-a')).toHaveLength(1);
  });

  it('a blank team name cannot be saved', () => {
    renderTeamDetails('owner');
    fireEvent.change(inPanel().getByLabelText('Team name'), { target: { value: '  ' } });
    expect(save().hasAttribute('disabled')).toBe(true);
  });
});

describe('Team details: create team', () => {
  it('surfaces the {detail} cap error inline (ported from the teams page)', async () => {
    renderTeamDetails('member');
    mockedApiFetch.mockImplementation(async (path: string, opts?: RequestInit) => {
      if (path === 'teams' && opts?.method === 'POST') {
        throw new ApiError(400, 'You already own 20 teams; the limit has been reached.');
      }
      if (path === 'teams/team-a') return teamDetail;
      if (path.startsWith('shows')) return { shows: [] };
      return profile;
    });
    fireEvent.change(inPanel().getByLabelText('Team id (slug)'), { target: { value: 'my-crew' } });
    fireEvent.change(inPanel().getByLabelText('Display name'), { target: { value: 'My Crew' } });
    fireEvent.click(inPanel().getByRole('button', { name: 'Create team' }));
    await waitFor(() =>
      expect(
        inPanel()
          .getAllByRole('alert')
          .some((a) => a.textContent === 'You already own 20 teams; the limit has been reached.'),
      ).toBe(true),
    );
  });
});
