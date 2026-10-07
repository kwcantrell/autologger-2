import { ChevronRightIcon, TriangleAlertIcon } from 'lucide-react';
import { type FormEvent, Fragment, useState } from 'react';
import { ApiError } from '../../../../api/client';
import { useProfile } from '../../../../api/hooks/useProfile';
import { showAccessFrom } from '../../../../api/hooks/useShowAccess';
import {
  useChangeMemberRole,
  useInviteToTeam,
  useRemoveMember,
  useRevokeInvite,
  useSetShowGrant,
  useTeam,
} from '../../../../api/hooks/useTeams';
import type {
  ProfilePayload,
  ShowBrief,
  TeamInvite,
  TeamMember,
  TeamRole,
} from '../../../../api/types';
import { Alert, AlertDescription } from '../../../../shared/components/ui/alert';
import { Avatar, AvatarFallback } from '../../../../shared/components/ui/avatar';
import { Badge } from '../../../../shared/components/ui/badge';
import { Button } from '../../../../shared/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../../../shared/components/ui/card';
import { Checkbox } from '../../../../shared/components/ui/checkbox';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '../../../../shared/components/ui/empty';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from '../../../../shared/components/ui/field';
import { Input } from '../../../../shared/components/ui/input';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from '../../../../shared/components/ui/item';
import { Spinner } from '../../../../shared/components/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '../../../../shared/components/ui/toggle-group';
import { useConfirm } from '../../../../shared/ui/ConfirmDialog';
import type { SettingsSectionProps } from './SettingsView';
import { runSaveSteps, type SaveStep, SidePanel } from './SidePanel';
import { profileStudioId } from './settingsModel';
import { OrphanedNotice, RoleLockNotice, SettingsSectionHeader, YOU_ARE } from './settingsParts';
import { isManager, memberInitials, memberLabel, memberPermissions, ROLE_LABEL } from './teamRules';

// --- Settings › Members (redesign-show-ignition 8.1; design D4, D10) ---
//
// The active team's members as shadcn `Item` rows (initials, name, email, role, show access), then
// the pending invites, with invite-by-email above (team-management "Teams management page"):
//   - owner and admin: invite, pending invites with Revoke, and each row opens the member's panel;
//   - member: the read-only list, under a notice naming their role; the invite row renders
//     disabled, and neither pending invites nor anyone's show access is shown.
// A team with no owner shows the no-owner notice: a member gets only the notice, an admin keeps
// the controls under it.
//
// The member panel (`SidePanel`) drafts locally and applies on Save (design D4): the role (owner
// only, never for the owner), then a grant PUT or DELETE per changed show (`member` rows only),
// then removal (confirmed when staged). The first failure stops the run and names the step; the
// team hooks invalidate on every success, so what applied shows at once. Each step is computed
// against the member as last fetched, so a retry sends only what did not apply.
//
// Invites and revokes are single requests, not drafts, so they apply immediately.

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError || err instanceof Error) return err.message;
  return fallback;
}

export function MembersSection({ onGoToSection }: SettingsSectionProps) {
  const { data: profile } = useProfile();
  const studioId = profileStudioId(profile);
  if (!profile || !studioId) {
    return (
      <>
        <SettingsSectionHeader title="Members" description="You’re not on a team yet." />
        <Empty>
          <EmptyDescription>Create a team to invite people to it.</EmptyDescription>
          <EmptyContent>
            <Button variant="outline" onClick={() => onGoToSection('team-details')}>
              Go to Team details
            </Button>
          </EmptyContent>
        </Empty>
      </>
    );
  }
  return <Members profile={profile} studioId={studioId} />;
}

function Members({ profile, studioId }: { profile: ProfilePayload; studioId: string }) {
  const team = useTeam(studioId);
  const role: TeamRole = showAccessFrom(profile).teamRole(studioId) ?? 'member';
  const manager = isManager(role);
  const teamName = profile.studios.find((s) => s.id === studioId)?.name ?? studioId;
  const selfId = profile.auth.user?.id ?? null;
  const shows = profile.shows.filter((s) => s.studio_id === studioId);
  const detail = team.data;
  const orphaned = Boolean(detail) && !detail?.members.some((m) => m.role === 'owner');
  // The panel's member, and whether it is open. Each open is a fresh mount (`n`), so its draft
  // starts from the member's saved state; closing keeps it mounted so the sheet animates out and
  // hands focus back to the row.
  const [panel, setPanel] = useState<{ id: string; open: boolean; n: number } | null>(null);
  const openPanel = (id: string) => setPanel((p) => ({ id, open: true, n: (p?.n ?? 0) + 1 }));
  const panelMember = detail?.members.find((m) => m.id === panel?.id) ?? null;

  const header = (
    <SettingsSectionHeader title="Members" description={`${teamName} · ${YOU_ARE[role]}`} />
  );

  // A member of an ownerless team gets only the notice (as on the previous team card).
  if (orphaned && !manager) {
    return (
      <>
        {header}
        <OrphanedNotice />
      </>
    );
  }

  const members = detail?.members ?? [];
  const invites = manager ? (detail?.invites ?? []) : [];
  const count = `${members.length} member${members.length === 1 ? '' : 's'}`;

  return (
    <>
      {header}
      {orphaned && <OrphanedNotice />}
      {!manager && (
        <RoleLockNotice role={role} teamName={teamName}>
          {`${YOU_ARE[role]} of ${teamName}. Only owners and admins can invite people or change roles and show access.`}
        </RoleLockNotice>
      )}
      <InviteCard studioId={studioId} disabled={!manager} />

      {team.isError ? (
        <Empty data-slot="settings-members-state" data-state="error">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <TriangleAlertIcon aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>Couldn’t load the members.</EmptyTitle>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" onClick={() => void team.refetch()}>
              Retry
            </Button>
          </EmptyContent>
        </Empty>
      ) : !detail ? (
        <Empty data-slot="settings-members-state" data-state="loading" aria-busy="true">
          <EmptyHeader>
            <EmptyMedia>
              <Spinner aria-hidden="true" />
            </EmptyMedia>
            <EmptyDescription>Loading members…</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>
              {invites.length > 0 ? `${count} · ${invites.length} invited` : count}
            </CardTitle>
            {manager && (
              <CardDescription>Open a member to change their role or show access.</CardDescription>
            )}
          </CardHeader>
          <CardContent className="px-2">
            <ItemGroup aria-label={`${teamName} members`}>
              {members.map((m, i) => (
                <Fragment key={m.id}>
                  {i > 0 && <ItemSeparator />}
                  <MemberRow
                    member={m}
                    self={m.id === selfId}
                    showCount={shows.length}
                    manager={manager}
                    onOpen={manager ? () => openPanel(m.id) : undefined}
                  />
                </Fragment>
              ))}
              {invites.map((inv) => (
                <Fragment key={inv.email}>
                  <ItemSeparator />
                  <InviteRow studioId={studioId} invite={inv} />
                </Fragment>
              ))}
            </ItemGroup>
          </CardContent>
        </Card>
      )}

      {manager && panel && (
        <MemberPanel
          key={panel.n}
          open={panel.open}
          studioId={studioId}
          teamName={teamName}
          viewer={role}
          selfId={selfId}
          member={panelMember}
          shows={shows}
          onClose={() => setPanel((p) => (p ? { ...p, open: false } : p))}
        />
      )}
    </>
  );
}

function MemberRow({
  member,
  self,
  showCount,
  manager,
  onOpen,
}: {
  member: TeamMember;
  self: boolean;
  showCount: number;
  manager: boolean;
  onOpen?: () => void;
}) {
  const label = memberLabel(member);
  const access =
    member.role === 'member'
      ? `${member.show_ids?.length ?? 0} of ${showCount} show${showCount === 1 ? '' : 's'}`
      : 'All shows';
  return (
    <Item
      role="listitem"
      size="sm"
      data-testid={`member-row-${member.id}`}
      className="relative flex-nowrap has-[[data-slot=member-open]:hover]:bg-si-panel-2"
    >
      <ItemMedia>
        <Avatar size="lg">
          <AvatarFallback>{memberInitials(member)}</AvatarFallback>
        </Avatar>
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="max-w-full min-w-0">
          {onOpen ? (
            // The whole row is the target (the button's ::after covers it), named by the member.
            <button
              type="button"
              data-slot="member-open"
              className="min-w-0 truncate text-left outline-none after:absolute after:inset-0 after:rounded-md after:content-[''] focus-visible:after:ring-[3px] focus-visible:after:ring-ring/50"
              onClick={onOpen}
            >
              {label}
            </button>
          ) : (
            <span className="min-w-0 truncate">{label}</span>
          )}
          {self && <Badge variant="secondary">You</Badge>}
        </ItemTitle>
        <ItemDescription className="truncate">{member.email}</ItemDescription>
      </ItemContent>
      <ItemActions className="shrink-0">
        <Badge variant="outline">{ROLE_LABEL[member.role]}</Badge>
        {manager && (
          <span className="w-[6.5rem] text-right text-sm text-muted-foreground max-sm:hidden">
            {access}
          </span>
        )}
        {onOpen && <ChevronRightIcon aria-hidden="true" className="text-si-dim" />}
      </ItemActions>
    </Item>
  );
}

function InviteRow({ studioId, invite }: { studioId: string; invite: TeamInvite }) {
  const revoke = useRevokeInvite(studioId);
  const [error, setError] = useState<string | null>(null);
  return (
    <Item
      role="listitem"
      size="sm"
      data-testid={`invite-row-${invite.email}`}
      className="flex-nowrap"
    >
      <ItemMedia>
        <Avatar size="lg">
          <AvatarFallback>@</AvatarFallback>
        </Avatar>
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="max-w-full min-w-0">
          <span className="min-w-0 truncate">{invite.email}</span>
        </ItemTitle>
        <ItemDescription className="truncate">
          {error ?? 'Invited. Joins at first sign-in.'}
        </ItemDescription>
      </ItemContent>
      <ItemActions className="shrink-0">
        <Badge variant="outline" className="max-sm:hidden">
          Invited
        </Badge>
        <Button
          variant="ghost"
          size="sm"
          disabled={revoke.isPending}
          onClick={() => {
            setError(null);
            revoke.mutate(invite.email, {
              onError: (err) => setError(`Couldn’t revoke: ${errorMessage(err, 'Revoke failed.')}`),
            });
          }}
        >
          {revoke.isPending && <Spinner data-icon="inline-start" aria-hidden="true" />}
          Revoke
        </Button>
      </ItemActions>
    </Item>
  );
}

function InviteCard({ studioId, disabled }: { studioId: string; disabled: boolean }) {
  const invite = useInviteToTeam(studioId);
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    const value = email.trim();
    if (!value || disabled) return;
    setError(null);
    invite.mutate(
      { email: value },
      {
        onSuccess: () => setEmail(''),
        onError: (err) => setError(errorMessage(err, 'Invite failed.')),
      },
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Invite someone</CardTitle>
        <CardDescription>
          They join as a member when they first sign in. Choose their shows here afterwards.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && (
          <Alert variant="destructive">
            <TriangleAlertIcon aria-hidden="true" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <form
          onSubmit={submit}
          className="flex items-end gap-2 max-sm:flex-col max-sm:items-stretch"
        >
          <Field data-disabled={disabled || undefined} className="flex-1">
            <FieldLabel htmlFor="settings-invite-email">Email address</FieldLabel>
            <Input
              id="settings-invite-email"
              type="email"
              autoComplete="off"
              placeholder="name@company.com"
              disabled={disabled}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Button type="submit" disabled={disabled || invite.isPending || email.trim() === ''}>
            {invite.isPending && <Spinner data-icon="inline-start" aria-hidden="true" />}
            Send invite
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

interface MemberDraft {
  role: TeamRole;
  showIds: string[];
  remove: boolean;
}

const draftOf = (m: TeamMember): MemberDraft => ({
  role: m.role,
  showIds: [...(m.show_ids ?? [])].sort(),
  remove: false,
});

function MemberPanel({
  open,
  studioId,
  teamName,
  viewer,
  selfId,
  member,
  shows,
  onClose,
}: {
  open: boolean;
  studioId: string;
  teamName: string;
  viewer: TeamRole;
  selfId: string | null;
  member: TeamMember | null;
  shows: ShowBrief[];
  onClose: () => void;
}) {
  const changeRole = useChangeMemberRole(studioId);
  const setGrant = useSetShowGrant(studioId);
  const removeMember = useRemoveMember(studioId);
  const { confirm, confirmElement } = useConfirm();
  // The member as last fetched; kept once they are gone (removed), so the panel can animate out.
  const [last, setLast] = useState(member);
  if (member && member !== last) setLast(member);
  const current = member ?? last;
  // A fresh mount per open (the parent's `key`), so the draft starts from their saved state.
  const [draft, setDraft] = useState<MemberDraft | null>(() => (member ? draftOf(member) : null));

  if (!current || !draft) return null;
  // The saved state as last fetched: after a partly applied save, what applied is no longer a
  // change, so Save and a retry cover only the rest.
  const saved = draftOf(current);
  const perms = memberPermissions(viewer, current, selfId);
  // The picker follows the chosen role (an owner turning an admin into a member can pick shows at
  // once); an owner or admin reaches every show, and a staged removal makes it moot.
  const canPick =
    draft.role === 'member' && !draft.remove && (perms.grantShows || perms.changeRole);
  const label = memberLabel(current);
  const self = current.id === selfId;

  async function stageRemove() {
    const ok = await confirm({
      title: 'Remove member',
      message: `Remove ${current?.email} from ${teamName}? They lose access when you save, including to any open sessions.`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (ok) setDraft((d) => (d ? { ...d, remove: true } : d));
  }

  // Role, then a grant per changed show, then removal (design D4); a staged removal makes the
  // rest moot, so it runs alone.
  async function save() {
    if (!current || !draft || !saved) return;
    const userId = current.id;
    const steps: SaveStep[] = [];
    if (draft.remove) {
      steps.push({
        label: `remove ${label} from the team`,
        run: () => removeMember.mutateAsync(userId),
      });
    } else {
      if (perms.changeRole && draft.role !== saved.role && draft.role !== 'owner') {
        const role = draft.role;
        steps.push({
          label: `change the role to ${ROLE_LABEL[role]}`,
          run: () => changeRole.mutateAsync({ userId, role }),
        });
      }
      if (canPick) {
        const before = new Set(saved.showIds);
        const after = new Set(draft.showIds);
        for (const show of shows) {
          const granted = after.has(show.id);
          if (granted === before.has(show.id)) continue;
          steps.push({
            label: granted ? `give access to ${show.name}` : `remove access to ${show.name}`,
            run: () => setGrant.mutateAsync({ showId: show.id, userId, granted }),
          });
        }
      }
    }
    await runSaveSteps(steps);
  }

  return (
    <>
      <SidePanel
        open={open}
        onClose={onClose}
        title={label}
        description={self ? `${current.email} · You` : current.email}
        media={
          <Avatar size="lg">
            <AvatarFallback>{memberInitials(current)}</AvatarFallback>
          </Avatar>
        }
        value={draft}
        baseline={saved}
        onSave={save}
        saveLabel={draft.remove ? 'Remove member' : 'Save'}
      >
        {draft.remove && (
          <Alert variant="destructive">
            <TriangleAlertIcon aria-hidden="true" />
            <AlertDescription>
              {`${label} will be removed from ${teamName} when you save.`}
            </AlertDescription>
          </Alert>
        )}
        <FieldSet>
          <FieldLegend>Role</FieldLegend>
          <Field orientation="horizontal" className="justify-between gap-4">
            <FieldContent className="min-w-0">
              <FieldDescription>
                {current.role === 'owner'
                  ? 'The owner manages roles and can transfer or delete the team.'
                  : 'Admins invite, remove members and grant shows. Members log and review.'}
              </FieldDescription>
            </FieldContent>
            {perms.changeRole ? (
              <ToggleGroup
                type="single"
                variant="outline"
                aria-label="Role"
                disabled={draft.remove}
                value={draft.role}
                onValueChange={(v) => {
                  // A single toggle group deselects on a second click; a role is always set.
                  if (v === 'admin' || v === 'member') setDraft({ ...draft, role: v });
                }}
              >
                <ToggleGroupItem value="admin">Admin</ToggleGroupItem>
                <ToggleGroupItem value="member">Member</ToggleGroupItem>
              </ToggleGroup>
            ) : (
              <Badge variant="outline">{ROLE_LABEL[current.role]}</Badge>
            )}
          </Field>
        </FieldSet>

        <FieldSet>
          <FieldLegend>Show access</FieldLegend>
          {canPick ? (
            shows.length === 0 ? (
              <FieldDescription>{teamName} has no shows yet.</FieldDescription>
            ) : (
              <FieldGroup data-slot="checkbox-group" className="gap-3">
                {shows.map((show) => {
                  const id = `member-access-${current.id}-${show.id}`;
                  const checked = draft.showIds.includes(show.id);
                  return (
                    <Field key={show.id} orientation="horizontal">
                      <Checkbox
                        id={id}
                        checked={checked}
                        onCheckedChange={(next) => {
                          const ids = new Set(draft.showIds);
                          if (next === true) ids.add(show.id);
                          else ids.delete(show.id);
                          setDraft({ ...draft, showIds: [...ids].sort() });
                        }}
                      />
                      <FieldLabel htmlFor={id} className="font-normal">
                        {show.name}
                      </FieldLabel>
                    </Field>
                  );
                })}
              </FieldGroup>
            )
          ) : (
            <FieldDescription>
              {draft.remove
                ? 'Removed members lose access to every show.'
                : `${ROLE_LABEL[draft.role]}s can open every show in the team.`}
            </FieldDescription>
          )}
        </FieldSet>

        {perms.remove && (
          <FieldSet>
            <FieldLegend>Membership</FieldLegend>
            <Field orientation="horizontal" className="justify-between gap-4">
              <FieldContent className="min-w-0">
                <FieldTitle>Remove from team</FieldTitle>
                <FieldDescription>
                  They lose access right away, including any open sessions.
                </FieldDescription>
              </FieldContent>
              {draft.remove ? (
                <Button variant="outline" onClick={() => setDraft({ ...draft, remove: false })}>
                  Keep on team
                </Button>
              ) : (
                <Button variant="destructive" onClick={() => void stageRemove()}>
                  Remove…
                </Button>
              )}
            </Field>
          </FieldSet>
        )}
      </SidePanel>
      {confirmElement}
    </>
  );
}
