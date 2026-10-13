import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../../../api/client';
import { sessionStatusKeys } from '../../../api/hooks/useSessionStatus';
import { wikiKeys } from '../../../api/hooks/useWiki';
import type { ProfilePayload } from '../../../api/types';
import { showToast } from '../utils/toast';
import { useSwitchActive } from './useSwitchActive';

// catalog-search task 5.4 (design D9): TopBar's switch logic, extracted so a search result can
// switch through the same `confirmSwitch` guard and close-session path. A show in another studio
// sends `{active_studio_id, active_show_id}` in ONE PUT (the server 400s on a show outside the
// active studio otherwise). TopBar's own switching stays pinned by TopBar.test.tsx.

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

function setup(opts: { confirmSwitch?: () => true | Promise<boolean> } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['profile'], makeProfile());
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const onCloseSession = vi.fn();
  const { result } = renderHook(
    () => useSwitchActive({ onCloseSession, confirmSwitch: opts.confirmSwitch }),
    {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  return { result, client, invalidate, onCloseSession };
}

const bodyOf = (i: number) => JSON.parse(String(apiFetchMock.mock.calls[i][1]?.body));

beforeEach(() => {
  apiFetchMock.mockReset();
  vi.mocked(showToast).mockReset();
});

describe('useSwitchActive', () => {
  it('a show in another studio sends {active_studio_id, active_show_id} in one PUT through confirmSwitch, then closes the session', async () => {
    apiFetchMock.mockResolvedValue(
      makeProfile({ active_studio_id: 'team-north', active_show_id: 'show-north' }),
    );
    const confirmSwitch = vi.fn((): true | Promise<boolean> => Promise.resolve(true));
    const { result, client, invalidate, onCloseSession } = setup({ confirmSwitch });
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.switchActive({ studioId: 'team-north', showId: 'show-north' });
    });
    expect(ok).toBe(true);
    expect(confirmSwitch).toHaveBeenCalledTimes(1);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = apiFetchMock.mock.calls[0];
    expect(path).toBe('profile');
    expect(init?.method).toBe('PUT');
    expect(bodyOf(0)).toEqual({ active_studio_id: 'team-north', active_show_id: 'show-north' });
    expect(onCloseSession).toHaveBeenCalledTimes(1);
    expect(client.getQueryData<ProfilePayload>(['profile'])?.active_show_id).toBe('show-north');
    const keys = invalidate.mock.calls.map(([f]) => f?.queryKey);
    expect(keys).toEqual(
      expect.arrayContaining([
        ['sessions'],
        ['events'],
        sessionStatusKeys.all(),
        ['show-categories'],
        wikiKeys.all(),
      ]),
    );
  });

  it('a studio sends {active_studio_id} alone and closes the session', async () => {
    apiFetchMock.mockResolvedValue(makeProfile({ active_studio_id: 'team-north' }));
    const { result, onCloseSession } = setup();
    await act(async () => {
      await result.current.switchActive({ studioId: 'team-north' });
    });
    expect(bodyOf(0)).toEqual({ active_studio_id: 'team-north' });
    expect(onCloseSession).toHaveBeenCalledTimes(1);
  });

  it('a show in the active studio sends both ids and keeps the session open', async () => {
    apiFetchMock.mockResolvedValue(makeProfile());
    const { result, onCloseSession } = setup();
    await act(async () => {
      await result.current.switchActive({ studioId: 'team-yt', showId: 'show-other' });
    });
    expect(bodyOf(0)).toEqual({ active_studio_id: 'team-yt', active_show_id: 'show-other' });
    expect(onCloseSession).not.toHaveBeenCalled();
  });

  it('a declined guard writes nothing and reports false', async () => {
    const { result, onCloseSession } = setup({ confirmSwitch: () => Promise.resolve(false) });
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.switchActive({ studioId: 'team-north', showId: 'show-north' });
    });
    expect(ok).toBe(false);
    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(onCloseSession).not.toHaveBeenCalled();
  });

  it('the already active selection writes nothing and reports true', async () => {
    const { result } = setup();
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.switchActive({ studioId: 'team-yt', showId: 'show-ats' });
    });
    expect(ok).toBe(true);
    await act(async () => {
      ok = await result.current.switchActive({ studioId: 'team-yt' });
    });
    expect(ok).toBe(true);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('a failed write names the failure, keeps the cache, and reports false', async () => {
    apiFetchMock.mockRejectedValue(new Error('No access to that show.'));
    const { result, client, onCloseSession, invalidate } = setup();
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.switchActive({ studioId: 'team-north', showId: 'show-north' });
    });
    expect(ok).toBe(false);
    expect(showToast).toHaveBeenCalledWith(
      expect.stringMatching(/show.*No access to that show\./),
      true,
    );
    expect(client.getQueryData<ProfilePayload>(['profile'])?.active_show_id).toBe('show-ats');
    expect(onCloseSession).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });
});
