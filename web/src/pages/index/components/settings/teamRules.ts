import type { TeamMember, TeamRole } from '../../../../api/types';

// --- Who may do what to a team member (team-management "Teams management page") ---
//
// The role matrix the previous team card applied inline, lifted out so the Members
// section and its panels share one copy:
//   - no control ever targets the owner (ownership moves only by transfer);
//   - only the owner changes roles (Admin / Member);
//   - the owner removes anyone else; an admin removes `member` rows only; nobody removes themself
//     here (leaving is in Team details);
//   - only `member` rows get the show-access picker: an owner's or admin's role reaches every show;
//   - only owners and admins see the picker, invites and anyone's show access at all.

export const ROLE_LABEL: Record<TeamRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
};

export const isManager = (role: TeamRole | null | undefined): boolean =>
  role === 'owner' || role === 'admin';

export interface MemberPermissions {
  changeRole: boolean;
  remove: boolean;
  /** Show the show-access picker for this row (a `member` row seen by an owner or admin). */
  grantShows: boolean;
}

export function memberPermissions(
  viewer: TeamRole,
  member: Pick<TeamMember, 'id' | 'role'>,
  selfId?: string | null,
): MemberPermissions {
  const target = member.role !== 'owner';
  const self = Boolean(selfId) && member.id === selfId;
  return {
    changeRole: viewer === 'owner' && target && !self,
    remove:
      target && !self && (viewer === 'owner' || (viewer === 'admin' && member.role === 'member')),
    grantShows: isManager(viewer) && member.role === 'member',
  };
}

/** A member's display name: their names, else their email. */
export const memberLabel = (m: Pick<TeamMember, 'given_name' | 'family_name' | 'email'>) =>
  `${m.given_name} ${m.family_name}`.trim() || m.email;

/** Up to two initials for an avatar, from the names, else the email. */
export function memberInitials(m: Pick<TeamMember, 'given_name' | 'family_name' | 'email'>) {
  const named = [m.given_name, m.family_name].map((s) => s.trim()).filter(Boolean);
  if (named.length > 0) {
    const parts = named.join(' ').split(/\s+/);
    const first = parts[0]?.[0] ?? '';
    const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
    return (first + last).toUpperCase();
  }
  return (m.email[0] ?? '?').toUpperCase();
}
