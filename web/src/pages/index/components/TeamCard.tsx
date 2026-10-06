import { type ReactNode, useState } from 'react';
import { ApiError } from '../../../api/client';
import { useStudioShows } from '../../../api/hooks/useShows';
import {
  useChangeMemberRole,
  useDeleteTeam,
  useInviteToTeam,
  useLeaveTeam,
  useRemoveMember,
  useRenameTeam,
  useRevokeInvite,
  useSetShowGrant,
  useTeam,
  useTransferOwnership,
} from '../../../api/hooks/useTeams';
import type {
  TeamDetail,
  TeamMember,
  TeamMembershipBrief,
  TeamRole,
  TeamRoleChangeBody,
} from '../../../api/types';
import { Alert } from '../../../shared/components/ui/alert';
import { Badge } from '../../../shared/components/ui/badge';
import { Button } from '../../../shared/components/ui/button';
import { Checkbox } from '../../../shared/components/ui/checkbox';
import { Field, FieldLabel, FieldLegend, FieldSet } from '../../../shared/components/ui/field';
import { Input } from '../../../shared/components/ui/input';
import { Spinner } from '../../../shared/components/ui/spinner';
import { useConfirm } from '../../../shared/ui/ConfirmDialog';

// --- TeamCard (teams-self-serve, task 6.2; owner-bootstrap D12) ---
//
// One expandable row per team the caller belongs to; the former built-ins are ordinary teams
// (owner-bootstrap D9). Collapsed by construction: `useTeam` is only enabled while `expanded` is
// true, so opening `/teams` never fetches every team's detail up front (design D7 — "expanding a
// team fetches GET /api/teams/:id").
//
// Three views by the caller's role in the team:
// - owner: the admin controls plus role toggles, "Transfer ownership" on each other member, and
//   delete; no leave (the owner can't leave until they transfer);
// - admin: rename, invites, and remove on `member` rows only; no role toggles; leave;
// - member: the read-only members list and leave.
// The owner and admin views give each `member` row a "Show access" picker: one checkbox per team
// show, checked from the row's `show_ids`, toggling a grant (show-grants D13). Owner and admin rows
// get none: their role reaches every show.
// A team with no owner shows the no-owner notice: a member sees only the notice, an admin sees it
// above the admin controls. `enabled_admin_count` is not read (owner decision B).

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : fallback;
}

// shadcn-port-shell D5: section hint text (was `.modal-hint`) and the inline loading line.
const HINT = 'm-0 mb-1 text-[0.78rem] leading-[1.45] text-v5-muted';

function LoadingLine({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={`${HINT} flex items-center gap-2 ${className ?? ''}`} aria-busy="true">
      <Spinner aria-hidden="true" />
      {children}
    </p>
  );
}

function RoleBadge({ role }: { role: TeamRole }) {
  return (
    <Badge variant="outline" className="ml-2">
      {role}
    </Badge>
  );
}

/** The team's shows as checkboxes for one member, checked from `show_ids`; mounted only while
 * the row's "Show access" disclosure is open, so `/teams` fetches no show list up front. */
function ShowAccessList({
  teamId,
  member,
  onError,
}: {
  teamId: string;
  member: TeamMember;
  onError: (message: string) => void;
}) {
  const shows = useStudioShows(teamId);
  const setGrant = useSetShowGrant(teamId);
  const granted = new Set(member.show_ids ?? []);
  if (shows.isError) {
    return <Alert variant="destructive">Couldn&apos;t load this team&apos;s shows.</Alert>;
  }
  if (!shows.data) {
    return <LoadingLine>Loading shows…</LoadingLine>;
  }
  const list = shows.data.shows ?? [];
  if (list.length === 0) return <p className={HINT}>This team has no shows yet.</p>;
  return (
    <FieldSet className="m-0 flex-row flex-wrap gap-x-4 gap-y-1 border-0 p-0">
      <FieldLegend className="sr-only">Show access for {member.email}</FieldLegend>
      {list.map((show) => {
        const id = `show-access-${member.id}-${show.id}`;
        return (
          <Field key={show.id} orientation="horizontal" className="w-auto items-center gap-2">
            <Checkbox
              id={id}
              checked={granted.has(show.id)}
              onCheckedChange={(checked) =>
                setGrant.mutate(
                  { showId: show.id, userId: member.id, granted: checked === true },
                  { onError: (err) => onError(errorMessage(err, 'Show access change failed.')) },
                )
              }
            />
            <FieldLabel htmlFor={id} className="text-v5-text">
              {show.name}
            </FieldLabel>
          </Field>
        );
      })}
    </FieldSet>
  );
}

function ShowAccessPicker({
  teamId,
  member,
  onError,
}: {
  teamId: string;
  member: TeamMember;
  onError: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="w-full">
      <Button variant="outline" size="sm" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Show access
      </Button>
      {open && (
        <div className="mt-2" data-testid={`team-show-access-${member.id}`}>
          <ShowAccessList teamId={teamId} member={member} onError={onError} />
        </div>
      )}
    </div>
  );
}

function MemberRow({
  member,
  canChangeRole,
  canTransfer,
  canRemove,
  onPromote,
  onDemote,
  onTransfer,
  onRemove,
  busy,
  extra,
}: {
  member: TeamMember;
  canChangeRole: boolean;
  canTransfer: boolean;
  canRemove: boolean;
  onPromote: () => void;
  onDemote: () => void;
  onTransfer: () => void;
  onRemove: () => void;
  busy: boolean;
  /** Rendered full-width under the row (the show-access picker on `member` rows). */
  extra?: ReactNode;
}) {
  const label = `${member.given_name} ${member.family_name}`.trim() || member.email;
  const anyControl = canChangeRole || canTransfer || canRemove;
  return (
    <li
      data-testid={`team-member-${member.id}`}
      className="flex flex-wrap items-center justify-between gap-2 border-b border-v5-border py-2 last:border-b-0"
    >
      <span>
        {label} <span className="text-v5-muted">({member.email})</span>
        <RoleBadge role={member.role} />
      </span>
      {anyControl && (
        <span className="flex gap-2">
          {canChangeRole &&
            (member.role === 'member' ? (
              <Button variant="outline" size="sm" disabled={busy} onClick={onPromote}>
                Make admin
              </Button>
            ) : (
              <Button variant="outline" size="sm" disabled={busy} onClick={onDemote}>
                Make member
              </Button>
            ))}
          {canTransfer && (
            <Button variant="outline" size="sm" disabled={busy} onClick={onTransfer}>
              Transfer ownership
            </Button>
          )}
          {canRemove && (
            <Button variant="destructive" size="sm" disabled={busy} onClick={onRemove}>
              Remove
            </Button>
          )}
        </span>
      )}
      {extra}
    </li>
  );
}

/** The owner's and the admins' view (owner-bootstrap D12). `isOwner` adds role toggles, transfer,
 * removing admins and delete, and drops leave. */
function ManagePanel({ detail, isOwner }: { detail: TeamDetail; isOwner: boolean }) {
  const [name, setName] = useState(detail.name);
  const [inviteEmail, setInviteEmail] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);

  const rename = useRenameTeam(detail.id);
  const invite = useInviteToTeam(detail.id);
  const revoke = useRevokeInvite(detail.id);
  const changeRole = useChangeMemberRole(detail.id);
  const removeMember = useRemoveMember(detail.id);
  const transfer = useTransferOwnership(detail.id);
  const deleteTeam = useDeleteTeam(detail.id);
  const leave = useLeaveTeam(detail.id);

  const busy =
    rename.isPending ||
    invite.isPending ||
    revoke.isPending ||
    changeRole.isPending ||
    removeMember.isPending ||
    transfer.isPending ||
    deleteTeam.isPending ||
    leave.isPending;

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

  const { confirm, confirmElement } = useConfirm();

  function handleRoleChange(userId: string, role: TeamRoleChangeBody['role']) {
    setActionError(null);
    changeRole.mutate(
      { userId, role },
      { onError: (err) => setActionError(errorMessage(err, 'Role change failed.')) },
    );
  }

  async function handleTransfer(userId: string, email: string) {
    const ok = await confirm({
      title: 'Transfer ownership',
      message: `Make ${email} the owner of this team? You will become an admin.`,
      confirmLabel: 'Transfer',
      danger: true,
    });
    if (!ok) return;
    setActionError(null);
    transfer.mutate(userId, {
      onError: (err) => setActionError(errorMessage(err, 'Transfer failed.')),
    });
  }

  async function handleRemove(userId: string, email: string) {
    const ok = await confirm({
      title: 'Remove member',
      message: `Remove ${email} from this team?`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    setActionError(null);
    removeMember.mutate(userId, {
      onError: (err) => setActionError(errorMessage(err, 'Remove failed.')),
    });
  }

  async function handleDelete() {
    const ok = await confirm({
      title: 'Delete team',
      message: 'Delete this team? A team that still has shows cannot be deleted.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    setActionError(null);
    deleteTeam.mutate(undefined, {
      onError: (err) => setActionError(errorMessage(err, 'Delete failed.')),
    });
  }

  async function handleLeave() {
    const ok = await confirm({
      title: 'Leave team',
      message: 'Leave this team? You will have to be re-invited to rejoin.',
      confirmLabel: 'Leave team',
      danger: true,
    });
    if (!ok) return;
    setActionError(null);
    leave.mutate(undefined, {
      onError: (err) => setActionError(errorMessage(err, 'Leave failed.')),
    });
  }

  function handleRevoke(email: string) {
    revoke.mutate(email, { onError: (err) => setActionError(errorMessage(err, 'Revoke failed.')) });
  }

  return (
    <div
      className="mt-3 space-y-4"
      data-testid={isOwner ? `team-owner-panel-${detail.id}` : `team-admin-panel-${detail.id}`}
    >
      {confirmElement}
      {actionError && <Alert variant="destructive">{actionError}</Alert>}

      <form className="flex flex-wrap items-end gap-2" onSubmit={handleRename}>
        <Field className="w-auto min-w-[14rem] flex-1">
          <FieldLabel htmlFor={`team-name-${detail.id}`}>Team name</FieldLabel>
          <Input
            id={`team-name-${detail.id}`}
            type="text"
            maxLength={200}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Button type="submit" disabled={busy || name.trim() === ''}>
          {rename.isPending ? 'Saving…' : 'Save name'}
        </Button>
      </form>

      <div>
        <p className={HINT}>Members</p>
        <ul className="my-[1em] list-disc pl-10">
          {detail.members.map((m) => {
            // No control ever targets the owner; an admin removes plain members only.
            const target = m.role !== 'owner';
            return (
              <MemberRow
                key={m.id}
                member={m}
                canChangeRole={isOwner && target}
                canTransfer={isOwner && target}
                canRemove={target && (isOwner || m.role === 'member')}
                busy={busy}
                onPromote={() => handleRoleChange(m.id, 'admin')}
                onDemote={() => handleRoleChange(m.id, 'member')}
                onTransfer={() => handleTransfer(m.id, m.email)}
                onRemove={() => handleRemove(m.id, m.email)}
                extra={
                  m.role === 'member' ? (
                    <ShowAccessPicker teamId={detail.id} member={m} onError={setActionError} />
                  ) : undefined
                }
              />
            );
          })}
        </ul>
      </div>

      <form className="flex flex-wrap items-end gap-2" onSubmit={handleInvite}>
        <Field className="w-auto min-w-[14rem] flex-1">
          <FieldLabel htmlFor={`team-invite-email-${detail.id}`}>Invite by email</FieldLabel>
          <Input
            id={`team-invite-email-${detail.id}`}
            type="email"
            placeholder="person@example.com"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
          />
        </Field>
        <Button type="submit" variant="outline" disabled={busy || inviteEmail.trim() === ''}>
          {invite.isPending ? 'Inviting…' : 'Invite'}
        </Button>
      </form>

      <div>
        <p className={HINT}>Pending invites</p>
        {(detail.invites ?? []).length === 0 ? (
          <p className={HINT}>No pending invites.</p>
        ) : (
          <ul className="my-[1em] list-disc pl-10">
            {(detail.invites ?? []).map((inv) => (
              <li
                key={inv.email}
                data-testid={`team-invite-${inv.email}`}
                className="flex items-center justify-between gap-2 border-b border-v5-border py-2 last:border-b-0"
              >
                <span>{inv.email}</span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={revoke.isPending}
                  onClick={() => handleRevoke(inv.email)}
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {isOwner ? (
        <Button variant="destructive" disabled={busy} onClick={handleDelete}>
          {deleteTeam.isPending ? 'Deleting…' : 'Delete team'}
        </Button>
      ) : (
        <Button variant="destructive" disabled={busy} onClick={handleLeave}>
          {leave.isPending ? 'Leaving…' : 'Leave team'}
        </Button>
      )}
    </div>
  );
}

function MemberPanel({ detail }: { detail: TeamDetail }) {
  const leave = useLeaveTeam(detail.id);
  const [error, setError] = useState<string | null>(null);
  const { confirm, confirmElement } = useConfirm();

  async function handleLeave() {
    const ok = await confirm({
      title: 'Leave team',
      message: 'Leave this team? An admin will have to re-invite you to rejoin.',
      confirmLabel: 'Leave team',
      danger: true,
    });
    if (!ok) return;
    setError(null);
    leave.mutate(undefined, { onError: (err) => setError(errorMessage(err, 'Leave failed.')) });
  }

  return (
    <div className="mt-3 space-y-3" data-testid={`team-member-panel-${detail.id}`}>
      {confirmElement}
      {error && <Alert variant="destructive">{error}</Alert>}
      <ul className="my-[1em] list-disc pl-10">
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
      <Button variant="destructive" disabled={leave.isPending} onClick={handleLeave}>
        {leave.isPending ? 'Leaving…' : 'Leave team'}
      </Button>
    </div>
  );
}

function OrphanedNotice() {
  return (
    // An Alert surface that stays a polite status (shadcn-port-shell D5; Alert defaults to alert).
    <Alert role="status" data-testid="team-orphaned-notice">
      This team has no owner. Contact support.
    </Alert>
  );
}

/** The view for the caller's role; the no-owner notice keys on the members' roles. */
function TeamView({ detail }: { detail: TeamDetail }) {
  const hasOwner = detail.members.some((m) => m.role === 'owner');
  if (detail.role === 'owner') return <ManagePanel detail={detail} isOwner />;
  if (detail.role === 'admin') {
    return (
      <>
        {!hasOwner && <OrphanedNotice />}
        <ManagePanel detail={detail} isOwner={false} />
      </>
    );
  }
  return hasOwner ? <MemberPanel detail={detail} /> : <OrphanedNotice />;
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
          {query.isLoading && <LoadingLine className="mt-3">Loading…</LoadingLine>}
          {query.isError && (
            <div className="mt-3 flex flex-col items-start gap-2">
              <Alert variant="destructive">Couldn&apos;t load this team.</Alert>
              <Button variant="outline" size="sm" onClick={() => query.refetch()}>
                Try again
              </Button>
            </div>
          )}
          {query.data && <TeamView detail={query.data} />}
        </>
      )}
    </li>
  );
}
