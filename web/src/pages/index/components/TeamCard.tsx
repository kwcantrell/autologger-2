import { useState } from 'react';
import { ApiError } from '../../../api/client';
import {
  useChangeMemberRole,
  useInviteToTeam,
  useLeaveTeam,
  useRemoveMember,
  useRenameTeam,
  useRevokeInvite,
  useTeam,
} from '../../../api/hooks/useTeams';
import type { TeamDetail, TeamMember, TeamMembershipBrief, TeamRole } from '../../../api/types';

// --- TeamCard (teams-self-serve, task 6.2; design D7) ---
//
// One expandable row per non-built-in team the caller belongs to (built-in
// memberships render as a separate, non-expandable read-only row — see
// TeamsRoute — and never mount this component, so they never issue a detail
// fetch). Collapsed by construction: `useTeam` is only enabled while
// `expanded` is true, so opening `/teams` never fetches every team's detail
// up front (design D7 — "expanding a team fetches GET /api/teams/:id").

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : fallback;
}

function RoleBadge({ role }: { role: TeamRole }) {
  return (
    <span className="ml-2 rounded-v5-sm border border-v5-border-strong bg-white/5 px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-v5-muted">
      {role}
    </span>
  );
}

function MemberRow({
  member,
  canManage,
  onPromote,
  onDemote,
  onRemove,
  busy,
}: {
  member: TeamMember;
  canManage: boolean;
  onPromote: () => void;
  onDemote: () => void;
  onRemove: () => void;
  busy: boolean;
}) {
  const label = `${member.given_name} ${member.family_name}`.trim() || member.email;
  return (
    <li
      data-testid={`team-member-${member.id}`}
      className="flex flex-wrap items-center justify-between gap-2 border-b border-v5-border py-2 last:border-b-0"
    >
      <span>
        {label} <span className="text-v5-muted">({member.email})</span>
        <RoleBadge role={member.role} />
      </span>
      {canManage && (
        <span className="flex gap-2">
          {member.role === 'member' ? (
            <button type="button" className="btn" disabled={busy} onClick={onPromote}>
              Make admin
            </button>
          ) : (
            <button type="button" className="btn" disabled={busy} onClick={onDemote}>
              Make member
            </button>
          )}
          <button type="button" className="btn danger" disabled={busy} onClick={onRemove}>
            Remove
          </button>
        </span>
      )}
    </li>
  );
}

function AdminPanel({ detail }: { detail: TeamDetail }) {
  const [name, setName] = useState(detail.name);
  const [inviteEmail, setInviteEmail] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);

  const rename = useRenameTeam(detail.id);
  const invite = useInviteToTeam(detail.id);
  const revoke = useRevokeInvite(detail.id);
  const changeRole = useChangeMemberRole(detail.id);
  const removeMember = useRemoveMember(detail.id);

  const busy =
    rename.isPending ||
    invite.isPending ||
    revoke.isPending ||
    changeRole.isPending ||
    removeMember.isPending;

  function handleRename(e: React.FormEvent) {
    e.preventDefault();
    setActionError(null);
    rename.mutate(
      { display_name: name.trim() },
      { onError: (err) => setActionError(errorMessage(err, 'Rename failed.')) },
    );
  }

  function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    setActionError(null);
    invite.mutate(
      { email: inviteEmail.trim() },
      {
        onSuccess: () => setInviteEmail(''),
        onError: (err) => setActionError(errorMessage(err, 'Invite failed.')),
      },
    );
  }

  function handleRoleChange(userId: string, role: TeamRole) {
    setActionError(null);
    changeRole.mutate(
      { userId, role },
      { onError: (err) => setActionError(errorMessage(err, 'Role change failed.')) },
    );
  }

  function handleRemove(userId: string, email: string) {
    if (!window.confirm(`Remove ${email} from this team?`)) return;
    setActionError(null);
    removeMember.mutate(userId, {
      onError: (err) => setActionError(errorMessage(err, 'Remove failed.')),
    });
  }

  function handleRevoke(email: string) {
    revoke.mutate(email, { onError: (err) => setActionError(errorMessage(err, 'Revoke failed.')) });
  }

  return (
    <div className="mt-3 space-y-4" data-testid={`team-admin-panel-${detail.id}`}>
      {actionError && (
        <p role="alert" className="modal-hint text-[#ff8a8a]">
          {actionError}
        </p>
      )}

      <form className="flex flex-wrap items-end gap-2" onSubmit={handleRename}>
        <label className="field">
          <span>Team name</span>
          <input
            type="text"
            className="profile-select"
            maxLength={200}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <button type="submit" className="btn primary" disabled={busy || name.trim() === ''}>
          {rename.isPending ? 'Saving…' : 'Save name'}
        </button>
      </form>

      <div>
        <p className="modal-hint mb-1">Members</p>
        <ul>
          {detail.members.map((m) => (
            <MemberRow
              key={m.id}
              member={m}
              canManage
              busy={busy}
              onPromote={() => handleRoleChange(m.id, 'admin')}
              onDemote={() => handleRoleChange(m.id, 'member')}
              onRemove={() => handleRemove(m.id, m.email)}
            />
          ))}
        </ul>
      </div>

      <form className="flex flex-wrap items-end gap-2" onSubmit={handleInvite}>
        <label className="field">
          <span>Invite by email</span>
          <input
            type="email"
            className="profile-select"
            placeholder="person@example.com"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
          />
        </label>
        <button type="submit" className="btn" disabled={busy || inviteEmail.trim() === ''}>
          {invite.isPending ? 'Inviting…' : 'Invite'}
        </button>
      </form>

      <div>
        <p className="modal-hint mb-1">Pending invites</p>
        {(detail.invites ?? []).length === 0 ? (
          <p className="modal-hint muted">No pending invites.</p>
        ) : (
          <ul>
            {(detail.invites ?? []).map((inv) => (
              <li
                key={inv.email}
                data-testid={`team-invite-${inv.email}`}
                className="flex items-center justify-between gap-2 border-b border-v5-border py-2 last:border-b-0"
              >
                <span>{inv.email}</span>
                <button
                  type="button"
                  className="btn"
                  disabled={revoke.isPending}
                  onClick={() => handleRevoke(inv.email)}
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function MemberPanel({ detail }: { detail: TeamDetail }) {
  const leave = useLeaveTeam(detail.id);
  const [error, setError] = useState<string | null>(null);

  function handleLeave() {
    if (!window.confirm('Leave this team?')) return;
    setError(null);
    leave.mutate(undefined, { onError: (err) => setError(errorMessage(err, 'Leave failed.')) });
  }

  return (
    <div className="mt-3 space-y-3" data-testid={`team-member-panel-${detail.id}`}>
      {error && (
        <p role="alert" className="modal-hint text-[#ff8a8a]">
          {error}
        </p>
      )}
      <ul>
        {detail.members.map((m) => {
          const label = `${m.given_name} ${m.family_name}`.trim() || m.email;
          return (
            <li
              key={m.id}
              data-testid={`team-member-${m.id}`}
              className="flex items-center justify-between gap-2 border-b border-v5-border py-2 last:border-b-0"
            >
              <span>
                {label} <span className="text-v5-muted">({m.email})</span>
                <RoleBadge role={m.role} />
              </span>
            </li>
          );
        })}
      </ul>
      <button type="button" className="btn danger" disabled={leave.isPending} onClick={handleLeave}>
        {leave.isPending ? 'Leaving…' : 'Leave team'}
      </button>
    </div>
  );
}

function OrphanedNotice() {
  return (
    <p role="status" className="modal-hint" data-testid="team-orphaned-notice">
      This team has no admins. Contact support to regain management access.
    </p>
  );
}

interface TeamCardProps {
  team: TeamMembershipBrief;
}

export function TeamCard({ team }: TeamCardProps) {
  const [expanded, setExpanded] = useState(false);
  const query = useTeam(expanded ? team.id : '');

  return (
    <li data-testid={`team-row-${team.id}`} className="glass-panel rounded-v5-lg px-4 py-3">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 bg-transparent text-left text-v5-text"
        data-testid={`team-toggle-${team.id}`}
        aria-expanded={expanded}
        onClick={() => setExpanded((e) => !e)}
      >
        <span>
          {team.name}
          <RoleBadge role={team.role} />
        </span>
        <span className="text-v5-muted">{expanded ? 'Hide' : 'Manage'}</span>
      </button>

      {expanded && (
        <>
          {query.isLoading && (
            <p className="modal-hint mt-3" aria-busy="true">
              Loading…
            </p>
          )}
          {query.isError && (
            <div className="mt-3">
              <p role="alert" className="modal-hint text-[#ff8a8a]">
                Couldn&apos;t load this team.
              </p>
              <button type="button" className="btn" onClick={() => query.refetch()}>
                Try again
              </button>
            </div>
          )}
          {query.data && query.data.enabled_admin_count === 0 && <OrphanedNotice />}
          {query.data &&
            query.data.enabled_admin_count > 0 &&
            (query.data.role === 'admin' ? (
              <AdminPanel detail={query.data} />
            ) : (
              <MemberPanel detail={query.data} />
            ))}
        </>
      )}
    </li>
  );
}
