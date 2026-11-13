import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch } from '../../../../api/client';
import type { ConnectedApp, ProfilePayload } from '../../../../api/types';
import { fmtDateOnly } from '../../../../shared/utils/fmtDateOnly';
import { renderStrict } from '../../../../test/renderStrict';
import { SettingsView } from './SettingsView';

// --- Settings › Connected apps (custom session dashboards J4, design 4.8; web-ui-system
// "Settings manages the user's connected apps") ---
//
// The real view, section and hooks over a real QueryClient; `apiFetch` is the one seam (the
// CompanionDevicesSection.test.tsx idiom).

vi.mock('../../../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../api/client')>();
  return { ...actual, apiFetch: vi.fn() };
});
vi.mock('../../utils/toast', () => ({ showToast: vi.fn() }));

const mockedApiFetch = vi.mocked(apiFetch);

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

const USED: ConnectedApp = {
  grant_id: 'alg_used',
  client_name: 'Claude',
  redirect_host: 'claude.ai',
  created_at: '2026-01-02T10:00:00.000Z',
  last_used_at: '2026-03-04T10:00:00.000Z',
};
const NEVER: ConnectedApp = {
  grant_id: 'alg_never',
  client_name: '<img src=x onerror=alert(1)><b>Evil</b>',
  redirect_host: 'example.org',
  created_at: '2026-05-06T10:00:00.000Z',
  last_used_at: null,
};

let apps: ConnectedApp[];
let featureOn: boolean;

const callsTo = (method: string) =>
  mockedApiFetch.mock.calls.filter(
    ([p, o]) => String(p).startsWith('oauth/connected-apps') && (o?.method ?? 'GET') === method,
  );

function route() {
  mockedApiFetch.mockImplementation(async (path: string, opts?: RequestInit) => {
    const method = opts?.method ?? 'GET';
    if (path === 'oauth/connected-apps' && method === 'GET') {
      if (!featureOn) throw new ApiError(404, 'Not Found');
      return { apps };
    }
    const del = /^oauth\/connected-apps\/(.+)$/.exec(path);
    if (del && method === 'DELETE') {
      apps = apps.filter((a) => a.grant_id !== decodeURIComponent(del[1]));
      return '';
    }
    if (path.startsWith('shows')) return { shows: [] };
    throw new Error(`unexpected apiFetch: ${method} ${path}`);
  });
}

function Harness() {
  const [section, setSection] = useState<'connected-apps' | 'account'>('account');
  return (
    <SettingsView
      section={section}
      onSectionChange={(s) => setSection(s as 'connected-apps' | 'account')}
      onClose={vi.fn()}
      onCloseSession={vi.fn()}
      backLabel="Back to sessions"
    />
  );
}

function renderView() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['profile'], PROFILE);
  renderStrict(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
  return client;
}

const openSection = async () => {
  const tab = await screen.findByRole('tab', { name: 'Connected apps' });
  fireEvent.mouseDown(tab, { button: 0 });
  return document.getElementById('settings-section-connected-apps') as HTMLElement;
};

beforeEach(() => {
  mockedApiFetch.mockReset();
  apps = [USED, NEVER];
  featureOn = true;
  route();
});

describe('Settings › Connected apps with the flag on', () => {
  it('is listed in the You group after Companion devices', async () => {
    renderView();
    await screen.findByRole('tab', { name: 'Connected apps' });
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabs.slice(0, 4)).toEqual([
      'Account',
      'Companion devices',
      'Connected apps',
      'Advanced',
    ]);
  });

  it('lists client name, redirect host, created and last used ("Never" when unused)', async () => {
    renderView();
    const panel = await openSection();
    await within(panel).findByText('Claude');
    const used = within(panel).getByTestId('connected-app-alg_used');
    expect(used.textContent).toContain('claude.ai');
    expect(used.textContent).toContain(fmtDateOnly(USED.created_at));
    expect(used.textContent).toContain(fmtDateOnly(USED.last_used_at as string));
    const never = within(panel).getByTestId('connected-app-alg_never');
    expect(never.textContent).toContain('Never');
    expect(panel.querySelector('[data-slot="settings-save-bar"]')).toBeNull();
    // The section reads the probe's cache: still exactly one list request.
    expect(callsTo('GET')).toHaveLength(1);
  });

  it('renders a client name containing markup as text, never as HTML', async () => {
    renderView();
    const panel = await openSection();
    const row = await within(panel).findByTestId('connected-app-alg_never');
    expect(row.textContent).toContain('<img src=x onerror=alert(1)><b>Evil</b>');
    expect(panel.querySelector('img')).toBeNull();
    expect(panel.querySelector('b')).toBeNull();
  });

  it('Revoke asks first: declining sends nothing, confirming deletes and refreshes the list', async () => {
    renderView();
    const panel = await openSection();
    await within(panel).findByText('Claude');

    fireEvent.click(within(panel).getByRole('button', { name: 'Revoke Claude' }));
    let dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(callsTo('DELETE')).toHaveLength(0);
    expect(within(panel).queryByText('Claude')).not.toBeNull();

    fireEvent.click(within(panel).getByRole('button', { name: 'Revoke Claude' }));
    dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(within(panel).queryByText('Claude')).toBeNull());
    expect(callsTo('DELETE').map(([p]) => p)).toEqual(['oauth/connected-apps/alg_used']);
  });

  it('shows the server detail when a revoke fails, and keeps the list', async () => {
    renderView();
    const panel = await openSection();
    await within(panel).findByText('Claude');
    mockedApiFetch.mockImplementation(async (_p: string, opts?: RequestInit) => {
      if (opts?.method === 'DELETE') throw new ApiError(404, 'Connected app not found.');
      return { apps };
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Revoke Claude' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    await within(panel).findByText('Connected app not found.');
    expect(within(panel).queryByText('Claude')).not.toBeNull();
  });
});

describe('Settings › Connected apps when the list fails', () => {
  it('keeps the tab listed and shows the error detail on a 500', async () => {
    mockedApiFetch.mockImplementation(async (path: string) => {
      if (path === 'oauth/connected-apps') throw new ApiError(500, 'boom');
      if (path.startsWith('shows')) return { shows: [] };
      throw new Error(`unexpected apiFetch: ${path}`);
    });
    renderView();
    // The hook retries a non-404 twice (1s, 2s backoff) before the query settles in error.
    const tab = await screen.findByRole('tab', { name: 'Connected apps' }, { timeout: 6000 });
    fireEvent.mouseDown(tab, { button: 0 });
    const panel = document.getElementById('settings-section-connected-apps') as HTMLElement;
    await within(panel).findByText('boom');
  }, 10000);
});

describe('Settings › Connected apps with the flag off', () => {
  it('makes exactly one request, which gets 404, and renders no section', async () => {
    featureOn = false;
    renderView();
    await waitFor(() => expect(callsTo('GET')).toHaveLength(1));
    // Let any retry or refetch happen, then count again.
    await new Promise((r) => setTimeout(r, 50));
    expect(callsTo('GET')).toHaveLength(1);
    expect(callsTo('GET')[0][0]).toBe('oauth/connected-apps');
    expect(screen.queryByRole('tab', { name: 'Connected apps' })).toBeNull();
    expect(document.getElementById('settings-section-connected-apps')?.textContent ?? '').toBe('');
    expect(screen.queryByText('Connected apps')).toBeNull();
  });
});
