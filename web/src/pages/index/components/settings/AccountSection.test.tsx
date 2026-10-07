import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../../../../api/client';
import type { ProfilePayload, Show } from '../../../../api/types';
import { renderStrict } from '../../../../test/renderStrict';
import { SettingsView } from './SettingsView';
import type { SettingsSectionId } from './sections';

// --- Settings › Account (redesign-show-ignition 7.1; web-ui-system "Honest save model in
// Settings"; team-management "Member content access" › "A member saves Settings") ---
//
// The real view, sections and hooks over a real QueryClient; `apiFetch` is the one seam. The
// profile is seeded into the cache (the shell has it before Settings can open).

vi.mock('../../../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../api/client')>();
  return { ...actual, apiFetch: vi.fn() };
});
vi.mock('../../utils/toast', () => ({ showToast: vi.fn() }));

const mockedApiFetch = vi.mocked(apiFetch);

const SHOWS: Show[] = [
  { id: 'show-1', name: 'Morning News', show_code: 'MN' },
  { id: 'show-2', name: 'Evening News', show_code: 'EN' },
].map(
  (s) =>
    ({
      ...s,
      studio_id: 'studio-1',
      title_suffix: 'date',
      categories: [],
      event_palette: [],
      event_palette_preset: 'custom',
      event_palette_custom: [],
    }) as unknown as Show,
);

function profileAs(role: 'owner' | 'admin' | 'member', activeShow = 'show-2'): ProfilePayload {
  return {
    active_studio_id: 'studio-1',
    active_show_id: activeShow,
    active_studio: { id: 'studio-1', name: 'Studio One', categories: [] },
    studios: [{ id: 'studio-1', name: 'Studio One', categories: [] }],
    studio_settings: { 'studio-1': { default_frame_rate: 25, title_format: 'x' } },
    shows: SHOWS.map(({ id, studio_id, name, show_code, title_suffix }) => ({
      id,
      studio_id,
      name,
      show_code,
      title_suffix,
      can_access: true,
    })),
    new_session_defaults: { title_prefix: '', default_frame_rate: 25 },
    admin: { restart_supported: false, restart_needs_token: false },
    auth: {
      logged_in: true,
      oauth_configured: true,
      user: {
        email: 'ada@example.com',
        given_name: 'Ada',
        family_name: 'Lovelace',
        teams: [{ id: 'studio-1', name: 'Studio One', role }],
      },
    },
  } as unknown as ProfilePayload;
}

let profile: ProfilePayload;

function route() {
  mockedApiFetch.mockImplementation(async (path: string, opts?: RequestInit) => {
    const method = opts?.method ?? 'GET';
    if (path === 'profile' && method === 'GET') return profile;
    if (path === 'profile' && method === 'PUT') {
      const body = JSON.parse(String(opts?.body)) as Record<string, string>;
      // The server's rule: an absent show re-points the caller at the team's first show.
      profile = {
        ...profile,
        active_show_id: body.active_show_id ?? SHOWS[0].id,
        auth: {
          ...profile.auth,
          user: {
            ...(profile.auth.user as NonNullable<ProfilePayload['auth']['user']>),
            given_name: body.given_name,
            family_name: body.family_name,
          },
        },
      } as ProfilePayload;
      return profile;
    }
    if (path === 'shows?studio_id=studio-1') return { shows: SHOWS };
    throw new Error(`unexpected apiFetch: ${method} ${path}`);
  });
}

function Harness({ initial }: { initial: SettingsSectionId }) {
  const [section, setSection] = useState<SettingsSectionId>(initial);
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

function renderAccount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['profile'], profile);
  renderStrict(
    <QueryClientProvider client={client}>
      <Harness initial="account" />
    </QueryClientProvider>,
  );
  return client;
}

const accountPanel = () => document.getElementById('settings-section-account') as HTMLElement;
const save = () => within(accountPanel()).getByRole('button', { name: /^Save/ });
const putBodies = () =>
  mockedApiFetch.mock.calls
    .filter(([p, o]) => p === 'profile' && o?.method === 'PUT')
    .map(([, o]) => JSON.parse(String(o?.body)) as Record<string, unknown>);

beforeEach(() => {
  mockedApiFetch.mockReset();
  profile = profileAs('owner');
  route();
});

describe('Settings › Account', () => {
  it('renders the names and sign out as rows, with Save disabled and saved while clean', () => {
    renderAccount();
    const panel = accountPanel();
    expect((within(panel).getByLabelText('First name') as HTMLInputElement).value).toBe('Ada');
    expect((within(panel).getByLabelText('Last name') as HTMLInputElement).value).toBe('Lovelace');
    expect(within(panel).getByText('ada@example.com')).not.toBeNull();
    const signOut = within(panel).getByRole('link', { name: 'Sign out' });
    expect(signOut.getAttribute('href')).toBe('/auth/logout');
    expect(save().textContent).toBe('Saved');
    expect(save().hasAttribute('disabled')).toBe(true);
    // No "previous Settings" fallback once the section is real.
    expect(within(panel).queryByRole('button', { name: 'Open previous Settings' })).toBeNull();
  });

  it('an edit arms Save, and undoing it disarms it again', () => {
    renderAccount();
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Grace' } });
    expect(save().textContent).toBe('Save');
    expect(save().hasAttribute('disabled')).toBe(false);
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Ada' } });
    expect(save().textContent).toBe('Saved');
  });

  it('saving sends the names with the active team and the current show, and the show is unchanged', async () => {
    const client = renderAccount();
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Byron' } });
    fireEvent.click(save());

    await waitFor(() => expect(putBodies()).toHaveLength(1));
    const body = putBodies()[0];
    expect(body).toEqual({
      active_studio_id: 'studio-1',
      // show-2 is active while show-1 sorts first, so an omitted field would be observably wrong.
      active_show_id: 'show-2',
      given_name: 'Ada',
      family_name: 'Byron',
    });
    expect(body).not.toHaveProperty('settings');
    expect(body).not.toHaveProperty('show_updates');
    await waitFor(() => expect(save().textContent).toBe('Saved'));
    expect(client.getQueryData<ProfilePayload>(['profile'])?.active_show_id).toBe('show-2');
  });

  it('echoes the profile’s show while the shows query is unavailable', async () => {
    mockedApiFetch.mockImplementation(async (path: string, opts?: RequestInit) => {
      if (path.startsWith('shows')) throw new Error('boom');
      if (path === 'profile' && opts?.method === 'PUT') return profile;
      throw new Error(`unexpected apiFetch: ${path}`);
    });
    renderAccount();
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Grace' } });
    fireEvent.click(save());
    await waitFor(() => expect(putBodies()).toHaveLength(1));
    expect(putBodies()[0].active_show_id).toBe('show-2');
  });

  it('a dirty section switch prompts, and keeping editing stays on Account with the edit', async () => {
    renderAccount();
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Grace' } });
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Show details' }), { button: 0 });

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('Account');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(accountPanel().hidden).toBe(false);
    expect((screen.getByLabelText('First name') as HTMLInputElement).value).toBe('Grace');
  });

  it('A member saves Settings: the save succeeds and carries no team or show settings', async () => {
    profile = profileAs('member');
    renderAccount();
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Grace' } });
    fireEvent.click(save());
    await waitFor(() => expect(putBodies()).toHaveLength(1));
    const body = putBodies()[0];
    expect(body.given_name).toBe('Grace');
    expect(body.active_studio_id).toBe('studio-1');
    expect(body).not.toHaveProperty('settings');
    expect(body).not.toHaveProperty('show_updates');
    await waitFor(() => expect(save().textContent).toBe('Saved'));
  });

  it('a failed save keeps the edit, re-arms Save and says what failed', async () => {
    mockedApiFetch.mockImplementation(async (path: string, opts?: RequestInit) => {
      if (path === 'profile' && opts?.method === 'PUT') throw new Error('Server unavailable.');
      if (path === 'shows?studio_id=studio-1') return { shows: SHOWS };
      throw new Error(`unexpected apiFetch: ${path}`);
    });
    renderAccount();
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Grace' } });
    fireEvent.click(save());
    const alert = await within(accountPanel()).findByRole('alert');
    expect(alert.textContent).toContain('Server unavailable.');
    expect(save().textContent).toBe('Save');
    expect((screen.getByLabelText('First name') as HTMLInputElement).value).toBe('Grace');
  });
});
