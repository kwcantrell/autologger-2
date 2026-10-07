import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch } from '../../../../api/client';
import type { ProfilePayload, Show, TeamDetail, TeamMember, TeamRole } from '../../../../api/types';
import { renderStrict } from '../../../../test/renderStrict';
import { SettingsView } from './SettingsView';
import type { SettingsSectionId } from './sections';

// --- Settings › Shows (redesign-show-ignition 8.2; team-management "Teams management page" Shows,
// "Member content access"; session-title-suffix "Show title-suffix preference" (the show panel's
// Suffix after the code); web-ui-system "Honest save model in Settings" (the Add-Show flow in a
// side panel, every profile write carrying the team and echoing the show)) ---
//
// The real view, sections, hooks and QueryClient; `apiFetch` is the one seam and plays a small
// server, so a created show, a renamed show and a grant all come back on the next GET.

vi.mock('../../../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../api/client')>();
  return { ...actual, apiFetch: vi.fn() };
});
vi.mock('../../utils/toast', () => ({ showToast: vi.fn() }));

const mockedApiFetch = vi.mocked(apiFetch);

function makeShow(i: number, overrides: Partial<Show> = {}): Show {
  return {
    id: `show-${i}`,
    studio_id: 'team-a',
    name: `Show ${i}`,
    show_code: `S${i}`,
    title_suffix: 'date',
    categories: [
      {
        id: `cat-${i}`,
        name: 'Roll Call',
        color: '#112233',
        type: 'BUTTON',
        dropdown_options: [],
        on_label: '',
        off_label: '',
        auto_instruction: 'Log every roll call',
      },
    ],
    event_palette: ['#111111'],
    event_palette_preset: 'custom',
    event_palette_custom: ['#222222'],
    ...overrides,
  } as unknown as Show;
}

const member = (id: string, name: string, role: TeamRole, show_ids: string[] = []): TeamMember => {
  const [given_name, family_name] = name.split(' ');
  return { id, email: `${id}@example.com`, given_name, family_name, role, show_ids };
};

let shows: Show[];
let profile: ProfilePayload;
let teamDetail: TeamDetail;
let failGrant: Error | null = null;
let nextId = 3;

function briefs() {
  return shows.map(({ id, studio_id, name, show_code, title_suffix }) => ({
    id,
    studio_id,
    name,
    show_code,
    title_suffix,
    can_access: true,
  }));
}

function profileAs(role: TeamRole): ProfilePayload {
  return {
    active_studio_id: 'team-a',
    // The active show is not the first, so an echo that fell back to "first" would show.
    active_show_id: 'show-2',
    active_studio: { id: 'team-a', name: 'Team A', categories: [] },
    studios: [{ id: 'team-a', name: 'Team A', categories: [] }],
    studio_settings: {},
    shows: briefs(),
    new_session_defaults: { title_prefix: '', default_frame_rate: 25 },
    admin: { restart_supported: false, restart_needs_token: false },
    auth: {
      logged_in: true,
      oauth_configured: true,
      user: {
        id: 'me',
        email: 'me@example.com',
        given_name: 'Me',
        family_name: '',
        picture_url: null,
        teams: [{ id: 'team-a', name: 'Team A', role }],
      },
    },
  } as unknown as ProfilePayload;
}

function route() {
  mockedApiFetch.mockImplementation(async (path: string, opts?: RequestInit) => {
    const method = opts?.method ?? 'GET';
    if (path === 'profile' && method === 'GET') return { ...profile, shows: briefs() };
    if (path === 'profile' && method === 'PUT') {
      const body = JSON.parse(String(opts?.body));
      for (const u of body.show_updates ?? []) {
        shows = shows.map((s) =>
          s.id === u.show_id
            ? { ...s, name: u.name, show_code: u.show_code, title_suffix: u.title_suffix }
            : s,
        );
      }
      return { ...profile, shows: briefs() };
    }
    if (path === 'shows?studio_id=team-a') return { shows: structuredClone(shows) };
    if (path === 'shows' && method === 'POST') {
      const body = JSON.parse(String(opts?.body));
      const created = makeShow(nextId++, {
        name: body.name,
        show_code: body.show_code ?? 'AUTO',
        categories: [],
      });
      shows = [...shows, created];
      return { show: structuredClone(created) };
    }
    if (path === 'teams/team-a' && method === 'GET') return structuredClone(teamDetail);
    const grant = path.match(/^teams\/team-a\/shows\/([^/]+)\/grants\/([^/]+)$/);
    if (grant && (method === 'PUT' || method === 'DELETE')) {
      if (failGrant) throw failGrant;
      const m = teamDetail.members.find((x) => x.id === grant[2]) as TeamMember;
      const ids = new Set(m.show_ids ?? []);
      if (method === 'PUT') ids.add(grant[1]);
      else ids.delete(grant[1]);
      m.show_ids = [...ids].sort();
      return { ok: true };
    }
    throw new Error(`unexpected apiFetch: ${method} ${path}`);
  });
}

function Harness() {
  const [section, setSection] = useState<SettingsSectionId>('shows');
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

function renderShows(role: TeamRole) {
  profile = profileAs(role);
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

const section = () => document.getElementById('settings-section-shows') as HTMLElement;
const inSection = () => within(section());
const findRow = (id: string) => screen.findByTestId(`show-row-${id}`);
const calls = (method: string, path: string) =>
  mockedApiFetch.mock.calls.filter(([p, o]) => p === path && (o?.method ?? 'GET') === method);
const putBodies = () =>
  calls('PUT', 'profile').map(([, o]) => JSON.parse(String(o?.body)) as Record<string, unknown>);
const editShow = async (id: string) => {
  fireEvent.click(within(await findRow(id)).getByRole('button', { name: /^Edit/ }));
  return screen.findByRole('dialog', { name: 'Edit show' });
};

beforeEach(() => {
  mockedApiFetch.mockReset();
  failGrant = null;
  nextId = 3;
  shows = [makeShow(1), makeShow(2, { title_suffix: 'episode' })];
  teamDetail = {
    id: 'team-a',
    name: 'Team A',
    role: 'owner',
    enabled_admin_count: 1,
    members: [
      member('me', 'Me Owner', 'owner'),
      member('adm', 'Ada Admin', 'admin'),
      member('mem', 'Mo Member', 'member', ['show-1']),
      member('mem2', 'Mia Member', 'member'),
    ],
    invites: [],
  };
});

describe('Shows list', () => {
  it('lists the team’s shows with code and suffix, an Edit for each and Add show', async () => {
    renderShows('owner');
    const row = await findRow('show-1');
    expect(row.closest('[data-slot="item-group"]')).not.toBeNull();
    expect(within(row).getByText('Show 1')).not.toBeNull();
    expect(within(row).getByText('S1 · Date suffix')).not.toBeNull();
    expect(within(await findRow('show-2')).getByText('S2 · Episode Number suffix')).not.toBeNull();
    // The active show says so.
    expect(within(await findRow('show-2')).getByText('Current show')).not.toBeNull();
    expect(within(row).getByRole('button', { name: 'Edit Show 1' }).hasAttribute('disabled')).toBe(
      false,
    );
    expect(inSection().getByRole('button', { name: 'Add show' }).hasAttribute('disabled')).toBe(
      false,
    );
    expect(inSection().queryByRole('button', { name: /Open previous Settings/ })).toBeNull();
  });

  it('members have disabled Edit and Add show under a role notice', async () => {
    renderShows('member');
    const row = await findRow('show-1');
    expect(within(row).getByRole('button', { name: 'Edit Show 1' }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(inSection().getByRole('button', { name: 'Add show' }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(section().querySelector('[data-slot="settings-role-notice"]')?.textContent).toContain(
      'You’re a member of Team A',
    );
    // A member reads no one's access, so the section fetches no team detail.
    expect(calls('GET', 'teams/team-a')).toHaveLength(0);
  });
});

describe('Show panel', () => {
  it('holds name, code, Suffix after the code, and who can open it; there is no delete', async () => {
    renderShows('admin');
    const panel = await editShow('show-1');
    expect((within(panel).getByLabelText('Show name') as HTMLInputElement).value).toBe('Show 1');
    expect((within(panel).getByLabelText('Code') as HTMLInputElement).value).toBe('S1');
    const suffix = within(panel).getByRole('radiogroup', { name: 'Suffix' });
    expect(
      within(suffix)
        .getAllByRole('radio')
        .map((r) => r.textContent),
    ).toEqual(['Date', 'Episode Number']);
    expect(
      within(panel).getByLabelText('Code').compareDocumentPosition(suffix) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(panel.textContent).not.toMatch(/Next Ep/i);
    const access = within(panel).getByRole('group', { name: 'Who can open it' });
    // Member rows only, checked from their grants; owners and admins are covered by their role.
    expect(
      within(access)
        .getAllByRole('checkbox')
        .map((c) => c.id),
    ).toHaveLength(2);
    expect(
      within(access)
        .getByRole('checkbox', { name: /Mo Member/ })
        .getAttribute('aria-checked'),
    ).toBe('true');
    expect(
      within(access)
        .getByRole('checkbox', { name: /Mia Member/ })
        .getAttribute('aria-checked'),
    ).toBe('false');
    expect(access.textContent).toContain('Owners and admins can always open every show.');
    expect(within(panel).queryByRole('button', { name: /delete/i })).toBeNull();
  });

  it('edit name and suffix: saves the whole show through show_updates with the team and the active show', async () => {
    renderShows('owner');
    const panel = await editShow('show-1');
    fireEvent.change(within(panel).getByLabelText('Show name'), {
      target: { value: 'Morning Desk' },
    });
    fireEvent.click(within(panel).getByRole('radio', { name: 'Episode Number' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit show' })).toBeNull());

    expect(putBodies()).toHaveLength(1);
    const body = putBodies()[0] as {
      active_studio_id: string;
      active_show_id: string;
      show_updates: Record<string, unknown>[];
    };
    expect(body.active_studio_id).toBe('team-a');
    expect(body.active_show_id).toBe('show-2');
    expect(body.show_updates).toHaveLength(1);
    expect(body.show_updates[0]).toMatchObject({
      show_id: 'show-1',
      name: 'Morning Desk',
      show_code: 'S1',
      title_suffix: 'episode',
      // The show's buttons and palette go back unchanged.
      categories: [
        expect.objectContaining({ id: 'cat-1', auto_instruction: 'Log every roll call' }),
      ],
      event_palette_preset: 'custom',
    });
    expect(body.show_updates[0]).not.toHaveProperty('next_episode');
    expect(calls('PUT', 'teams/team-a/shows/show-1/grants/mem2')).toHaveLength(0);
    await waitFor(() =>
      expect(
        within(screen.getByTestId('show-row-show-1')).getByText('Morning Desk'),
      ).not.toBeNull(),
    );
  });

  it('toggle a member’s access: a grant call, and no profile write', async () => {
    renderShows('admin');
    let panel = await editShow('show-1');
    fireEvent.click(within(panel).getByRole('checkbox', { name: /Mia Member/ }));
    fireEvent.click(within(panel).getByRole('checkbox', { name: /Mo Member/ }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit show' })).toBeNull());
    expect(calls('PUT', 'teams/team-a/shows/show-1/grants/mem2')).toHaveLength(1);
    expect(calls('DELETE', 'teams/team-a/shows/show-1/grants/mem')).toHaveLength(1);
    expect(putBodies()).toHaveLength(0);

    // Reopened, it reads the grants back.
    panel = await editShow('show-1');
    await waitFor(() =>
      expect(
        within(panel)
          .getByRole('checkbox', { name: /Mia Member/ })
          .getAttribute('aria-checked'),
      ).toBe('true'),
    );
    expect(
      within(panel)
        .getByRole('checkbox', { name: /Mo Member/ })
        .getAttribute('aria-checked'),
    ).toBe('false');
  });

  it('a failed grant keeps the panel open, naming it, with the show edit already saved', async () => {
    renderShows('owner');
    const panel = await editShow('show-1');
    fireEvent.change(within(panel).getByLabelText('Show name'), { target: { value: 'Renamed' } });
    fireEvent.click(within(panel).getByRole('checkbox', { name: /Mia Member/ }));
    failGrant = new ApiError(400, 'Grant refused.');
    fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));
    expect((await within(panel).findByRole('alert')).textContent).toContain(
      'Couldn’t give Mia Member access: Grant refused.',
    );
    expect(screen.getByRole('dialog', { name: 'Edit show' })).not.toBeNull();
    await waitFor(() =>
      expect(within(screen.getByTestId('show-row-show-1')).getByText('Renamed')).not.toBeNull(),
    );
    // The retry sends only the grant.
    failGrant = null;
    fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit show' })).toBeNull());
    expect(putBodies()).toHaveLength(1);
  });
});

describe('Add show', () => {
  it('opens an empty panel; Save needs a name', async () => {
    renderShows('owner');
    await findRow('show-1');
    fireEvent.click(inSection().getByRole('button', { name: 'Add show' }));
    const panel = await screen.findByRole('dialog', { name: 'New show' });
    expect((within(panel).getByLabelText('Show name') as HTMLInputElement).value).toBe('');
    expect(within(panel).getByRole('radio', { name: 'Date' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    const add = within(panel).getByRole('button', { name: 'Add show' });
    expect(add.hasAttribute('disabled')).toBe(true);
    fireEvent.change(within(panel).getByLabelText('Show name'), { target: { value: '  ' } });
    expect(add.hasAttribute('disabled')).toBe(true);
  });

  it('creates the show (POST /api/shows), then sets its suffix and grants, and lists it', async () => {
    renderShows('owner');
    await findRow('show-1');
    fireEvent.click(inSection().getByRole('button', { name: 'Add show' }));
    const panel = await screen.findByRole('dialog', { name: 'New show' });
    fireEvent.change(within(panel).getByLabelText('Show name'), {
      target: { value: 'Late Edition' },
    });
    fireEvent.change(within(panel).getByLabelText('Code'), { target: { value: 'le' } });
    fireEvent.click(within(panel).getByRole('radio', { name: 'Episode Number' }));
    await waitFor(() =>
      expect(within(panel).getByRole('checkbox', { name: /Mia Member/ })).not.toBeNull(),
    );
    fireEvent.click(within(panel).getByRole('checkbox', { name: /Mia Member/ }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Add show' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New show' })).toBeNull());

    expect(JSON.parse(String(calls('POST', 'shows')[0][1]?.body))).toEqual({
      studio_id: 'team-a',
      name: 'Late Edition',
      show_code: 'LE',
    });
    const body = putBodies()[0] as {
      active_studio_id: string;
      active_show_id: string;
      show_updates: Record<string, unknown>[];
    };
    expect(body.active_studio_id).toBe('team-a');
    expect(body.active_show_id).toBe('show-2');
    expect(body.show_updates[0]).toMatchObject({ show_id: 'show-3', title_suffix: 'episode' });
    expect(calls('PUT', 'teams/team-a/shows/show-3/grants/mem2')).toHaveLength(1);
    const order = mockedApiFetch.mock.calls
      .filter(([, o]) => o?.method === 'POST' || o?.method === 'PUT')
      .map(([p, o]) => `${o?.method} ${p}`);
    expect(order).toEqual([
      'POST shows',
      'PUT profile',
      'PUT teams/team-a/shows/show-3/grants/mem2',
    ]);
    expect(within(await findRow('show-3')).getByText('Late Edition')).not.toBeNull();
  });

  it('a Date show needs no profile write; a failed grant after the create does not create twice', async () => {
    renderShows('admin');
    await findRow('show-1');
    fireEvent.click(inSection().getByRole('button', { name: 'Add show' }));
    const panel = await screen.findByRole('dialog', { name: 'New show' });
    fireEvent.change(within(panel).getByLabelText('Show name'), { target: { value: 'Noon' } });
    await waitFor(() =>
      expect(within(panel).getByRole('checkbox', { name: /Mo Member/ })).not.toBeNull(),
    );
    fireEvent.click(within(panel).getByRole('checkbox', { name: /Mo Member/ }));
    failGrant = new ApiError(400, 'Grant refused.');
    fireEvent.click(within(panel).getByRole('button', { name: 'Add show' }));
    expect((await within(panel).findByRole('alert')).textContent).toContain(
      'Couldn’t give Mo Member access: Grant refused.',
    );
    expect(putBodies()).toHaveLength(0);
    failGrant = null;
    fireEvent.click(within(panel).getByRole('button', { name: 'Add show' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New show' })).toBeNull());
    expect(calls('POST', 'shows')).toHaveLength(1);
    expect(calls('PUT', 'teams/team-a/shows/show-3/grants/mem')).toHaveLength(2);
  });
});
