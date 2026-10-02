import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProfilePayload } from '../types';
import { useProfile } from './useProfile';
import { useShowAccess } from './useShowAccess';

// --- useShowAccess (show-grants D13; spec: web-home-launch "Session actions follow show access") ---
//
// Everything is derived from the profile: `shows[].can_access` decides show access and
// `auth.user.teams[].role` the caller's role per team. `useProfile` is mocked at the module
// boundary, so these pin the derivation only.

vi.mock('./useProfile', () => ({ useProfile: vi.fn() }));

const mockedUseProfile = vi.mocked(useProfile);

const profile = {
  active_studio_id: 'team-a',
  active_show_id: 'show-a1',
  shows: [
    {
      id: 'show-a1',
      studio_id: 'team-a',
      name: 'A1',
      show_code: 'A1',
      title_suffix: 'date',
      can_access: true,
    },
    {
      id: 'show-a2',
      studio_id: 'team-a',
      name: 'A2',
      show_code: 'A2',
      title_suffix: 'date',
      can_access: false,
    },
    {
      id: 'show-b1',
      studio_id: 'team-b',
      name: 'B1',
      show_code: 'B1',
      title_suffix: 'date',
      can_access: true,
    },
  ],
  auth: {
    logged_in: true,
    oauth_configured: true,
    user: {
      id: 'u1',
      email: 'u1@example.com',
      given_name: '',
      family_name: '',
      picture_url: '',
      teams: [
        { id: 'team-a', name: 'A', role: 'member' },
        { id: 'team-b', name: 'B', role: 'admin' },
        { id: 'team-c', name: 'C', role: 'owner' },
      ],
    },
  },
} as unknown as ProfilePayload;

function access(p: ProfilePayload | undefined) {
  mockedUseProfile.mockReturnValue({ data: p } as unknown as ReturnType<typeof useProfile>);
  return renderHook(() => useShowAccess()).result.current;
}

beforeEach(() => {
  mockedUseProfile.mockReset();
});

describe('useShowAccess', () => {
  it('canAccessShow follows shows[].can_access; unknown and null show ids are not accessible', () => {
    const a = access(profile);
    expect(a.canAccessShow('show-a1')).toBe(true);
    expect(a.canAccessShow('show-a2')).toBe(false);
    expect(a.canAccessShow('show-b1')).toBe(true);
    expect(a.canAccessShow('no-such-show')).toBe(false);
    expect(a.canAccessShow(null)).toBe(false);
  });

  it('accessibleShows lists a team’s accessible shows only', () => {
    const a = access(profile);
    expect(a.accessibleShows('team-a').map((s) => s.id)).toEqual(['show-a1']);
    expect(a.accessibleShows('team-b').map((s) => s.id)).toEqual(['show-b1']);
    expect(a.accessibleShows('team-c')).toEqual([]);
    expect(a.activeStudioId).toBe('team-a');
  });

  it('teamRole and isTeamManager read auth.user.teams[].role', () => {
    const a = access(profile);
    expect(a.teamRole('team-a')).toBe('member');
    expect(a.isTeamManager('team-a')).toBe(false);
    expect(a.isTeamManager('team-b')).toBe(true);
    expect(a.isTeamManager('team-c')).toBe(true);
    expect(a.teamRole('team-z')).toBeNull();
    expect(a.isTeamManager('team-z')).toBe(false);
  });

  it('with no profile, nothing is accessible and there is no role', () => {
    const a = access(undefined);
    expect(a.canAccessShow('show-a1')).toBe(false);
    expect(a.accessibleShows('team-a')).toEqual([]);
    expect(a.teamRole('team-a')).toBeNull();
    expect(a.activeStudioId).toBe('');
  });
});
