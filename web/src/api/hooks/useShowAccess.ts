import { useMemo } from 'react';
import type { ProfilePayload, ProfileShow, TeamRole } from '../types';
import { useProfile } from './useProfile';

// --- Show access on the web (show-grants D13; spec: web-home-launch "Session actions follow
// show access") ---
//
// Derived from the profile only: a show is accessible when its profile entry says
// `can_access: true` (the server's rule: owner or admin of the team, or a member with a grant),
// and the caller's role per team is `auth.user.teams[].role`. The server gates every route
// anyway; this only decides which affordances to offer. With no profile yet, nothing is
// accessible and there is no role (the shell renders only after the profile loads).

export interface ShowAccess {
  /** The profile's active team id (`''` when there is none). */
  activeStudioId: string;
  canAccessShow: (showId: string | null | undefined) => boolean;
  /** The accessible shows of one team, in profile order. */
  accessibleShows: (studioId: string | null | undefined) => ProfileShow[];
  teamRole: (studioId: string | null | undefined) => TeamRole | null;
  isTeamManager: (studioId: string | null | undefined) => boolean;
}

export function showAccessFrom(profile: ProfilePayload | undefined): ShowAccess {
  const shows = profile?.shows ?? [];
  const accessible = new Set(shows.filter((s) => s.can_access === true).map((s) => s.id));
  const roles = new Map((profile?.auth?.user?.teams ?? []).map((t) => [t.id, t.role]));
  const teamRole = (studioId: string | null | undefined): TeamRole | null =>
    (studioId ? roles.get(studioId) : undefined) ?? null;
  return {
    activeStudioId: profile?.active_studio_id ?? '',
    canAccessShow: (showId) => (showId ? accessible.has(showId) : false),
    accessibleShows: (studioId) =>
      studioId ? shows.filter((s) => s.studio_id === studioId && accessible.has(s.id)) : [],
    teamRole,
    isTeamManager: (studioId) => {
      const role = teamRole(studioId);
      return role === 'owner' || role === 'admin';
    },
  };
}

export function useShowAccess(): ShowAccess {
  const { data } = useProfile();
  return useMemo(() => showAccessFrom(data), [data]);
}
