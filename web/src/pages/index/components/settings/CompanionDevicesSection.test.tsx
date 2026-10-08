import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch } from '../../../../api/client';
import { companionDeviceKeys } from '../../../../api/hooks/useCompanionDevices';
import type {
  CompanionDevice,
  CompanionDeviceCreatedResponse,
  ProfilePayload,
} from '../../../../api/types';
import { fmtDateOnly } from '../../../../shared/utils/fmtDateOnly';
import { renderStrict } from '../../../../test/renderStrict';
import { SettingsView } from './SettingsView';

// --- Settings › Companion devices (companion-devices task 7.1, design D6; web-ui-system
// "Settings manages the user's Companion devices") ---
//
// The real view, section and hooks over a real QueryClient; `apiFetch` is the one seam (the
// AccountSection.test.tsx idiom). The section acts immediately: no save bar, no unsaved state.

vi.mock('../../../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../api/client')>();
  return { ...actual, apiFetch: vi.fn() };
});
vi.mock('../../utils/toast', () => ({ showToast: vi.fn() }));

const mockedApiFetch = vi.mocked(apiFetch);

const TOKEN = `ald_${'Ab3_-'.repeat(8)}xyz`;

const PROFILE = {
  active_studio_id: 'studio-1',
  active_show_id: null,
  active_studio: { id: 'studio-1', name: 'Studio One', categories: [] },
  studios: [{ id: 'studio-1', name: 'Studio One', categories: [] }],
  studio_settings: { 'studio-1': { default_frame_rate: 25, title_format: 'x' } },
  shows: [],
  new_session_defaults: { title_prefix: '', default_frame_rate: 25 },
  admin: { restart_supported: false, restart_needs_token: false },
  auth: {
    logged_in: true,
    oauth_configured: true,
    user: {
      email: 'ada@example.com',
      given_name: 'Ada',
      family_name: 'Lovelace',
      teams: [{ id: 'studio-1', name: 'Studio One', role: 'member' }],
    },
  },
} as unknown as ProfilePayload;

const USED: CompanionDevice = {
  id: 'dev-used',
  name: 'Booth A',
  created_at: '2026-01-02T10:00:00.000Z',
  last_used_at: '2026-03-04T10:00:00.000Z',
  expired: false,
};
const NEVER: CompanionDevice = {
  id: 'dev-never',
  name: 'Booth B',
  created_at: '2026-05-06T10:00:00.000Z',
  last_used_at: null,
  expired: false,
};
const IDLE: CompanionDevice = {
  id: 'dev-idle',
  name: 'Old deck',
  created_at: '2025-01-01T10:00:00.000Z',
  last_used_at: '2025-02-01T10:00:00.000Z',
  expired: true,
};

let devices: CompanionDevice[];

const calls = (method: string) =>
  mockedApiFetch.mock.calls.filter(
    ([p, o]) => String(p).startsWith('companion-devices') && (o?.method ?? 'GET') === method,
  );

function route() {
  mockedApiFetch.mockImplementation(async (path: string, opts?: RequestInit) => {
    const method = opts?.method ?? 'GET';
    if (path === 'companion-devices' && method === 'GET') return { devices };
    if (path === 'companion-devices' && method === 'POST') {
      const { name } = JSON.parse(String(opts?.body)) as { name: string };
      const created: CompanionDeviceCreatedResponse = {
        id: 'dev-new',
        name,
        created_at: '2026-10-08T09:00:00.000Z',
        token: TOKEN,
      };
      devices = [
        {
          id: created.id,
          name,
          created_at: created.created_at,
          last_used_at: null,
          expired: false,
        },
        ...devices,
      ];
      return created;
    }
    const del = /^companion-devices\/(.+)$/.exec(path);
    if (del && method === 'DELETE') {
      devices = devices.filter((d) => d.id !== decodeURIComponent(del[1]));
      return '';
    }
    if (path.startsWith('shows')) return { shows: [] };
    throw new Error(`unexpected apiFetch: ${method} ${path}`);
  });
}

function Harness() {
  const [section, setSection] = useState<'companion-devices'>('companion-devices');
  return (
    <SettingsView
      section={section}
      onSectionChange={(s) => setSection(s as 'companion-devices')}
      onClose={vi.fn()}
      onCloseSession={vi.fn()}
      backLabel="Back to sessions"
    />
  );
}

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['profile'], PROFILE);
  renderStrict(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
  return client;
}

const panel = () => document.getElementById('settings-section-companion-devices') as HTMLElement;
const rowOf = (name: string) =>
  within(panel()).getByText(name).closest('[data-testid^="companion-device-"]') as HTMLElement;

/** Every string anywhere in the cache, so a token stored under any key or field is found. */
function cacheText(client: QueryClient): string {
  const all = client
    .getQueryCache()
    .getAll()
    .map((q) => q.state.data);
  const mutations = client
    .getMutationCache()
    .getAll()
    .map((m) => m.state.data);
  return JSON.stringify([all, mutations]);
}

beforeEach(() => {
  mockedApiFetch.mockReset();
  devices = [USED, NEVER, IDLE];
  route();
});

describe('Settings › Companion devices', () => {
  it('is listed in the You group after Account', () => {
    renderSection();
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabs.slice(0, 2)).toEqual(['Account', 'Companion devices']);
  });

  it('lists name, created and last used ("Never" when unused), and marks only the expired device', async () => {
    renderSection();
    await within(panel()).findByText('Booth A');

    const used = rowOf('Booth A');
    expect(used.textContent).toContain(fmtDateOnly(USED.created_at));
    expect(used.textContent).toContain(fmtDateOnly(USED.last_used_at as string));
    expect(used.textContent).not.toContain('Never');
    expect(used.textContent).not.toContain('Expired');

    const never = rowOf('Booth B');
    expect(never.textContent).toContain(fmtDateOnly(NEVER.created_at));
    expect(never.textContent).toContain('Never');
    expect(never.textContent).not.toContain('Expired');

    const idle = rowOf('Old deck');
    expect(within(idle).getByText('Expired')).not.toBeNull();
    // Still revocable.
    expect(within(idle).getByRole('button', { name: /Revoke/ })).not.toBeNull();

    // Acts immediately: no save bar.
    expect(panel().querySelector('[data-slot="settings-save-bar"]')).toBeNull();
  });

  it('Add shows the token once with Copy and the warning; after close it is gone from the DOM and the cache', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const client = renderSection();
    await within(panel()).findByText('Booth A');

    fireEvent.change(within(panel()).getByLabelText('Device name'), {
      target: { value: 'Stream Deck 2' },
    });
    fireEvent.click(within(panel()).getByRole('button', { name: 'Add device' }));

    const dialog = await screen.findByRole('dialog', { name: 'Device token' });
    const field = within(dialog).getByRole('textbox') as HTMLInputElement;
    expect(field.value).toBe(TOKEN);
    expect(field.readOnly).toBe(true);
    expect(dialog.textContent).toContain("Copy this token now. It won't be shown again.");
    expect(JSON.parse(String(calls('POST')[0][1]?.body))).toEqual({ name: 'Stream Deck 2' });

    fireEvent.click(within(dialog).getByRole('button', { name: /Copy/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(TOKEN));

    // The list refreshes to show the new device, unused.
    await within(panel()).findByText('Stream Deck 2');
    expect(rowOf('Stream Deck 2').textContent).toContain('Never');
    expect(cacheText(client)).not.toContain(TOKEN);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Device token' })).toBeNull());
    expect(document.body.innerHTML).not.toContain(TOKEN);
    expect(cacheText(client)).not.toContain(TOKEN);
    expect(client.getQueryData<{ devices: CompanionDevice[] }>(companionDeviceKeys.list())).toEqual(
      {
        devices,
      },
    );
  });

  it('Revoke asks first: declining sends nothing; confirming deletes and refreshes the list', async () => {
    renderSection();
    await within(panel()).findByText('Booth A');

    fireEvent.click(within(rowOf('Booth A')).getByRole('button', { name: /Revoke/ }));
    let confirm = await screen.findByRole('alertdialog');
    expect(confirm.textContent).toContain('Booth A');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(calls('DELETE')).toHaveLength(0);
    expect(within(panel()).getByText('Booth A')).not.toBeNull();

    fireEvent.click(within(rowOf('Booth A')).getByRole('button', { name: /Revoke/ }));
    confirm = await screen.findByRole('alertdialog');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(calls('DELETE')).toHaveLength(1));
    expect(calls('DELETE')[0][0]).toBe('companion-devices/dev-used');
    await waitFor(() => expect(within(panel()).queryByText('Booth A')).toBeNull());
    expect(within(panel()).getByText('Booth B')).not.toBeNull();
  });

  it('shows the server detail when Add fails (the ten-device limit), and the list is unchanged', async () => {
    const detail = 'You already have 10 Companion devices; revoke one first.';
    const base = mockedApiFetch.getMockImplementation();
    mockedApiFetch.mockImplementation(async (path: string, opts?: RequestInit) => {
      if (path === 'companion-devices' && opts?.method === 'POST') {
        throw new ApiError(409, detail, { detail });
      }
      return base?.(path, opts);
    });
    renderSection();
    await within(panel()).findByText('Booth A');

    fireEvent.change(within(panel()).getByLabelText('Device name'), {
      target: { value: 'One too many' },
    });
    fireEvent.click(within(panel()).getByRole('button', { name: 'Add device' }));

    const alert = await within(panel()).findByRole('alert');
    expect(alert.textContent).toContain(detail);
    expect(screen.queryByRole('dialog', { name: 'Device token' })).toBeNull();
    expect(within(panel()).queryByText('One too many')).toBeNull();
    expect(within(panel()).getAllByRole('button', { name: /Revoke/ })).toHaveLength(3);
  });

  it('shows the server detail when the list fails', async () => {
    mockedApiFetch.mockImplementation(async (path: string) => {
      if (path === 'companion-devices') throw new ApiError(503, 'Database unavailable.');
      throw new Error(`unexpected apiFetch: ${path}`);
    });
    renderSection();
    const alert = await within(panel()).findByRole('alert');
    expect(alert.textContent).toContain('Database unavailable.');
  });

  it('shows the server detail when Revoke fails', async () => {
    const base = mockedApiFetch.getMockImplementation();
    mockedApiFetch.mockImplementation(async (path: string, opts?: RequestInit) => {
      if (opts?.method === 'DELETE') throw new ApiError(404, 'Companion device not found.');
      return base?.(path, opts);
    });
    renderSection();
    await within(panel()).findByText('Booth A');
    fireEvent.click(within(rowOf('Booth A')).getByRole('button', { name: /Revoke/ }));
    const confirm = await screen.findByRole('alertdialog');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Revoke' }));
    const alert = await within(panel()).findByRole('alert');
    expect(alert.textContent).toContain('Companion device not found.');
    expect(within(panel()).getByText('Booth A')).not.toBeNull();
  });
});
