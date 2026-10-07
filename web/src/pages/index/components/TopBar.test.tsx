import { QueryClient } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../../../api/client';
import { sessionStatusKeys } from '../../../api/hooks/useSessionStatus';
import type { ProfilePayload } from '../../../api/types';
import { renderWithQueryClient } from '../../../test/renderWithQueryClient';
import { publishTransportStatus } from '../coordination/transportStatus';
import { showToast } from '../utils/toast';
import { TopBar } from './TopBar';

// --- TopBar (redesign-show-ignition tasks 3.1-3.2; design D5, D10; web-ui-system "Top bar
// names the active team, show and transport state") ---
//
// Rendered against a REAL query client seeded with the profile, so the team/show triggers read
// the same cache the switch writes (`useProfileMutation`'s `setQueryData`) and the refetch
// assertions run against the shared client itself (web-coordination-seam "The settings modal
// still refetches the session list"). Only the network (`apiFetch`) and the toast are mocked.
// Route-level effects of a team switch (navigate to `/` from a session, none from `/teams`)
// are AppShell's close-session path and are asserted in AppShell.test.tsx.

vi.mock('../../../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../api/client')>()),
  apiFetch: vi.fn(),
}));

vi.mock('../utils/toast', () => ({ showToast: vi.fn() }));

const apiFetchMock = vi.mocked(apiFetch);

function makeProfile(overrides: Partial<ProfilePayload> = {}): ProfilePayload {
  return {
    active_studio_id: 'team-yt',
    active_show_id: 'show-ats',
    active_studio: { id: 'team-yt', name: 'Youtube Studio', categories: [] },
    studios: [
      { id: 'team-yt', name: 'Youtube Studio' },
      { id: 'team-north', name: 'Northlight Productions' },
    ],
    studio_settings: {},
    shows: [
      {
        id: 'show-ats',
        studio_id: 'team-yt',
        name: 'Autolog Test Show',
        show_code: 'ATS',
        title_suffix: 'date',
        can_access: true,
      },
      {
        id: 'show-late',
        studio_id: 'team-yt',
        name: 'Late Edition',
        show_code: 'LE',
        title_suffix: 'date',
        can_access: false,
      },
      {
        id: 'show-north',
        studio_id: 'team-north',
        name: 'Harbour Lights',
        show_code: 'HL',
        title_suffix: 'episode',
        can_access: true,
      },
    ],
    new_session_defaults: { title_prefix: '', default_frame_rate: 25 },
    admin: { restart_supported: false, restart_needs_token: false },
    auth: {
      logged_in: true,
      oauth_configured: true,
      user: {
        id: 'u1',
        email: 'u1@example.com',
        given_name: 'Kai',
        family_name: 'Lee',
        picture_url: null,
        teams: [
          { id: 'team-yt', name: 'Youtube Studio', role: 'owner' },
          { id: 'team-north', name: 'Northlight Productions', role: 'member' },
        ],
      },
    },
    ...overrides,
  };
}

function setup(
  props: Partial<React.ComponentProps<typeof TopBar>> = {},
  profile: ProfilePayload = makeProfile(),
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['profile'], profile);
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const onCloseSession = vi.fn();
  const onReturnToSession = vi.fn();
  const onToggleSidebar = vi.fn();
  renderWithQueryClient(
    <TopBar
      onCloseSession={onCloseSession}
      onReturnToSession={onReturnToSession}
      onToggleSidebar={onToggleSidebar}
      {...props}
    />,
    client,
  );
  return { client, invalidate, onCloseSession, onReturnToSession, onToggleSidebar };
}

// Radix DropdownMenu opens on pointer-down (button 0) or on Enter / Space / ArrowDown.
function openMenu(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
}

const teamTrigger = () => screen.getByRole('button', { name: /switch team/i });
const showTrigger = () => screen.getByRole('button', { name: /switch show/i });

beforeEach(() => {
  apiFetchMock.mockReset();
  vi.mocked(showToast).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TopBar: names and menus (task 3.1)', () => {
  it('renders the active team and show names with no wordmark or Team/Show labels', () => {
    setup();
    const bar = screen.getByRole('banner');
    expect(bar.getAttribute('data-slot')).toBe('topbar');
    expect(within(teamTrigger()).getByText('Youtube Studio')).toBeTruthy();
    expect(within(showTrigger()).getByText('Autolog Test Show')).toBeTruthy();
    expect(within(bar).queryByText(/autologger/i)).toBeNull();
    expect(within(bar).queryByText(/^team$/i)).toBeNull();
    expect(within(bar).queryByText(/^show$/i)).toBeNull();
    // No role badge on the team trigger itself.
    expect(within(teamTrigger()).queryByText(/owner/i)).toBeNull();
  });

  it('the team menu lists each team with its role and show count, the active one checked', async () => {
    setup();
    openMenu(teamTrigger());
    const items = await screen.findAllByRole('menuitemradio');
    expect(items).toHaveLength(2);
    const [yt, north] = items;
    expect(within(yt).getByText('Youtube Studio')).toBeTruthy();
    expect(within(yt).getByText('Owner')).toBeTruthy();
    expect(within(yt).getByText('2 shows')).toBeTruthy();
    expect(yt.getAttribute('aria-checked')).toBe('true');
    expect(within(north).getByText('Northlight Productions')).toBeTruthy();
    expect(within(north).getByText('Member')).toBeTruthy();
    expect(within(north).getByText('1 show')).toBeTruthy();
    expect(north.getAttribute('aria-checked')).toBe('false');
  });

  it('the show menu lists the active team’s shows by name only, inaccessible ones included', async () => {
    setup();
    openMenu(showTrigger());
    const items = await screen.findAllByRole('menuitemradio');
    expect(items.map((i) => i.textContent)).toEqual(['Autolog Test Show', 'Late Edition']);
    expect(items[0].getAttribute('aria-checked')).toBe('true');
  });

  it('the menus are keyboard-operable: Enter opens, arrows move, Enter chooses, Escape dismisses', async () => {
    apiFetchMock.mockResolvedValue(makeProfile({ active_show_id: 'show-late' }));
    setup();
    const trigger = showTrigger();
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Enter' });
    const menu = await screen.findByRole('menu');
    const items = within(menu).getAllByRole('menuitemradio');
    // Radix focuses the first item on keyboard open; ArrowDown moves to the next.
    await waitFor(() => expect(document.activeElement).toBe(items[0]));
    fireEvent.keyDown(items[0], { key: 'ArrowDown' });
    await waitFor(() => expect(document.activeElement).toBe(items[1]));
    fireEvent.keyDown(items[1], { key: 'Enter' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1));

    // Escape dismisses without choosing.
    apiFetchMock.mockClear();
    const team = teamTrigger();
    team.focus();
    fireEvent.keyDown(team, { key: 'Enter' });
    const teamMenu = await screen.findByRole('menu');
    fireEvent.keyDown(within(teamMenu).getAllByRole('menuitemradio')[0], { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('the sidebar control toggles the sidebar', () => {
    const { onToggleSidebar } = setup();
    fireEvent.click(screen.getByRole('button', { name: /toggle sidebar/i }));
    expect(onToggleSidebar).toHaveBeenCalledTimes(1);
  });
});

describe('TopBar: status (task 3.1)', () => {
  const owner = {};

  it.each([
    ['stopped', 'STOPPED'],
    ['rolling', 'ROLLING'],
    ['recording', 'REC'],
    ['playback', 'PLAY'],
  ] as const)('reads %s from the store as %s with the session title', (state, label) => {
    setup();
    act(() => {
      publishTransportStatus(owner, { state, sessionId: 'sess-1', title: 'ATS_youtube' });
    });
    const status = screen.getByRole('button', { name: /return to session/i });
    expect(within(status).getByText(label)).toBeTruthy();
    expect(within(status).getByText('ATS_youtube')).toBeTruthy();
  });

  it('activating the status returns to the open session', () => {
    const { onReturnToSession } = setup();
    act(() => {
      publishTransportStatus(owner, {
        state: 'recording',
        sessionId: 'sess-1',
        title: 'ATS_youtube',
      });
    });
    fireEvent.click(screen.getByRole('button', { name: /return to session/i }));
    expect(onReturnToSession).toHaveBeenCalledWith('sess-1');
  });

  it('with no session open it reads so and is not actionable', () => {
    const { onReturnToSession } = setup();
    expect(screen.queryByRole('button', { name: /return to session/i })).toBeNull();
    const bar = screen.getByRole('banner');
    const label = within(bar).getByText('No session open');
    expect(within(bar).getAllByText('STOPPED').length).toBeGreaterThan(0);
    expect(label.closest('button')).toBeNull();
    fireEvent.click(label);
    expect(onReturnToSession).not.toHaveBeenCalled();
  });
});

describe('TopBar: switching (task 3.2)', () => {
  it('choosing a team sends {active_studio_id} with no active_show_id and follows the close-session path', async () => {
    apiFetchMock.mockResolvedValue(
      makeProfile({
        active_studio_id: 'team-north',
        active_show_id: 'show-north',
        active_studio: { id: 'team-north', name: 'Northlight Productions', categories: [] },
      }),
    );
    const { onCloseSession } = setup();
    openMenu(teamTrigger());
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /northlight/i }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1));
    const [path, init] = apiFetchMock.mock.calls[0];
    expect(path).toBe('profile');
    expect(init?.method).toBe('PUT');
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({ active_studio_id: 'team-north' });
    expect('active_show_id' in body).toBe(false);
    await waitFor(() => expect(onCloseSession).toHaveBeenCalledTimes(1));
    // The new selection is shown once the write lands.
    await waitFor(() =>
      expect(within(teamTrigger()).getByText('Northlight Productions')).toBeTruthy(),
    );
    expect(within(showTrigger()).getByText('Harbour Lights')).toBeTruthy();
  });

  it('after a switch the four query keys are invalidated on the shared query client', async () => {
    apiFetchMock.mockResolvedValue(makeProfile({ active_studio_id: 'team-north' }));
    const { invalidate } = setup();
    openMenu(teamTrigger());
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /northlight/i }));
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(4));
    const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    expect(keys).toEqual(
      expect.arrayContaining([
        ['sessions'],
        ['events'],
        sessionStatusKeys.all(),
        ['show-categories'],
      ]),
    );
  });

  it('choosing a show sends {active_show_id} (with the current team the server requires) and does not close the session', async () => {
    apiFetchMock.mockResolvedValue(makeProfile({ active_show_id: 'show-late' }));
    const { onCloseSession, invalidate } = setup();
    openMenu(showTrigger());
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Late Edition' }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(String(apiFetchMock.mock.calls[0][1]?.body));
    expect(body).toEqual({ active_studio_id: 'team-yt', active_show_id: 'show-late' });
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(4));
    expect(onCloseSession).not.toHaveBeenCalled();
    await waitFor(() => expect(within(showTrigger()).getByText('Late Edition')).toBeTruthy());
  });

  it('choosing the already active team writes nothing', async () => {
    setup();
    openMenu(teamTrigger());
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /youtube studio/i }));
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('a failed write keeps the previous selection and names the failure', async () => {
    apiFetchMock.mockRejectedValue(new Error('No access to that team.'));
    const { onCloseSession, invalidate } = setup();
    openMenu(teamTrigger());
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /northlight/i }));
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.stringContaining('No access to that team.'),
        true,
      ),
    );
    expect(vi.mocked(showToast).mock.calls[0][0]).toMatch(/team/i);
    expect(within(teamTrigger()).getByText('Youtube Studio')).toBeTruthy();
    expect(within(showTrigger()).getByText('Autolog Test Show')).toBeTruthy();
    expect(onCloseSession).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });
});
