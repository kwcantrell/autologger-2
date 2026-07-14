import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../client';
import type {
  OkResponse,
  TeamCreateBody,
  TeamCreateResponse,
  TeamDetail,
  TeamInviteBody,
  TeamRenameBody,
  TeamRenameResponse,
  TeamRole,
  TeamRoleChangeResponse,
} from '../types';

// --- Team management hooks (teams-self-serve, task 6.1; design D7) ---
//
// `useTeam(id)` uses ordinary react-query staleness — no latching requirement
// (contrast `useSession`'s deep-link latch, which exists to keep an open
// workspace from being resolved out from under the user). Every mutation
// invalidates BOTH the team's detail key and `['profile']`: the teams list on
// `/teams` reads role off the profile (`auth.user.teams[]`), and the expanded
// detail reads members/invites off `GET /api/teams/:id` — a mutation can
// change either (or both, e.g. a role change on the caller's own membership),
// so both must go stale together for the UI to reflect it without a reload.

export const teamKeys = {
  detail: (teamId: string) => ['team', teamId] as const,
};

function teamPath(teamId: string, ...segments: string[]): string {
  return ['teams', encodeURIComponent(teamId), ...segments].join('/');
}

/**
 * `GET /api/teams/:id` detail. Disabled for the empty id (mirrors
 * `useSession`'s empty-id gate) — callers pass `''` when a team card is
 * collapsed or is a built-in/read-only entry that must never fetch detail.
 */
export function useTeam(teamId: string) {
  return useQuery({
    queryKey: teamKeys.detail(teamId),
    queryFn: () => apiFetch<TeamDetail>(teamPath(teamId)),
    enabled: teamId !== '',
  });
}

function invalidateTeam(qc: QueryClient, teamId: string): void {
  qc.invalidateQueries({ queryKey: teamKeys.detail(teamId) });
  qc.invalidateQueries({ queryKey: ['profile'] });
}

export function useCreateTeam() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TeamCreateBody) =>
      apiFetch<TeamCreateResponse>('teams', { method: 'POST', body: JSON.stringify(body) }),
    // A brand-new team has no existing detail-query cache entry to
    // invalidate; the profile refetch is what surfaces it in the list.
    onSuccess: () => qc.invalidateQueries({ queryKey: ['profile'] }),
  });
}

export function useRenameTeam(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TeamRenameBody) =>
      apiFetch<TeamRenameResponse>(teamPath(teamId), {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => invalidateTeam(qc, teamId),
  });
}

export function useDeleteTeam(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<OkResponse>(teamPath(teamId), { method: 'DELETE' }),
    onSuccess: () => {
      qc.removeQueries({ queryKey: teamKeys.detail(teamId) });
      qc.invalidateQueries({ queryKey: ['profile'] });
    },
  });
}

export function useInviteToTeam(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TeamInviteBody) =>
      apiFetch<OkResponse>(teamPath(teamId, 'invites'), {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => invalidateTeam(qc, teamId),
  });
}

export function useRevokeInvite(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (email: string) =>
      apiFetch<OkResponse>(teamPath(teamId, 'invites', encodeURIComponent(email)), {
        method: 'DELETE',
      }),
    onSuccess: () => invalidateTeam(qc, teamId),
  });
}

export function useChangeMemberRole(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: TeamRole }) =>
      apiFetch<TeamRoleChangeResponse>(
        teamPath(teamId, 'members', encodeURIComponent(userId), 'role'),
        { method: 'POST', body: JSON.stringify({ role }) },
      ),
    onSuccess: () => invalidateTeam(qc, teamId),
  });
}

export function useRemoveMember(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      apiFetch<OkResponse>(teamPath(teamId, 'members', encodeURIComponent(userId)), {
        method: 'DELETE',
      }),
    onSuccess: () => invalidateTeam(qc, teamId),
  });
}

export function useLeaveTeam(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<OkResponse>(teamPath(teamId, 'leave'), { method: 'POST' }),
    onSuccess: () => {
      qc.removeQueries({ queryKey: teamKeys.detail(teamId) });
      qc.invalidateQueries({ queryKey: ['profile'] });
    },
  });
}
