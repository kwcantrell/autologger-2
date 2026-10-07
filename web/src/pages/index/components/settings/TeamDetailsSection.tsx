import { useQueryClient } from '@tanstack/react-query';
import { ChevronDownIcon, TriangleAlertIcon } from 'lucide-react';
import { useState } from 'react';
import { ApiError } from '../../../../api/client';
import { useProfile, useProfileMutation } from '../../../../api/hooks/useProfile';
import { showAccessFrom } from '../../../../api/hooks/useShowAccess';
import {
  useDeleteTeam,
  useLeaveTeam,
  useRenameTeam,
  useTeam,
  useTransferOwnership,
} from '../../../../api/hooks/useTeams';
import type { ProfilePayload, TeamMember, TeamRole } from '../../../../api/types';
import { Alert, AlertDescription } from '../../../../shared/components/ui/alert';
import { Button } from '../../../../shared/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../../../shared/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../../../shared/components/ui/dropdown-menu';
import { Empty, EmptyDescription } from '../../../../shared/components/ui/empty';
import { FieldGroup, FieldSeparator } from '../../../../shared/components/ui/field';
import { Input } from '../../../../shared/components/ui/input';
import { useConfirm } from '../../../../shared/ui/ConfirmDialog';
import { showToast } from '../../utils/toast';
import { CreateTeamForm } from '../CreateTeamForm';
import { FpsSelect } from '../FpsSelect';
import type { SettingsSectionProps } from './SettingsView';
import { runSaveSteps, type SaveStep } from './SidePanel';
import {
  activeShowIdForSave,
  getDefaultFps,
  invalidateAfterProfileSave,
  profileStudioId,
  teamSettingsWithFps,
} from './settingsModel';
import { RoleLockNotice, SectionSaveBar, SettingRow, SettingsSectionHeader } from './settingsParts';
import { useInlineDraft, useSettingsShows } from './settingsScopes';

// --- Settings › Team details (redesign-show-ignition 7.3) ---
//
// The active team (chosen in the top bar): its name and default frame rate under the section's
// save bar, then ownership and membership by role, then create-a-team for anyone
// (team-management "Teams management page"):
//   - owner: rename, frame rate, transfer ownership, delete team (unavailable while the team has
//     shows, saying so); no leave;
//   - admin: rename, frame rate, leave;
//   - member: the same rows disabled under a notice naming their role, and leave.
// A team with no owner shows the no-owner notice (an admin keeps their controls under it; a member
// gets only the notice).
//
// The save model (design D4): the name is `PATCH /api/teams/:id`; the frame rate is a team setting
// merged into the existing `settings` blob (the server replaces it wholesale) and written with the
// active team and the echoed active show. With both dirty the rename runs first, and a failure stops
// the sequence and names the step that did not apply; a step that did apply is saved.

interface TeamDetailsDraft {
  name: string;
  fps: number;
}

const YOU_ARE: Record<TeamRole, string> = {
  owner: 'You’re the owner',
  admin: 'You’re an admin',
  member: 'You’re a member',
};

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError || err instanceof Error) return err.message;
  return fallback;
}

const memberLabel = (m: TeamMember) => `${m.given_name} ${m.family_name}`.trim() || m.email;

function OrphanedNotice() {
  return (
    // A polite status, not an alarm (shadcn-port-shell D5; Alert defaults to role="alert").
    <Alert role="status" data-testid="team-orphaned-notice">
      This team has no owner. Contact support.
    </Alert>
  );
}

export function TeamDetailsSection({ onCloseSession }: SettingsSectionProps) {
  const { data: profile } = useProfile();
  const studioId = profileStudioId(profile);

  if (!profile || !studioId) {
    return (
      <>
        <SettingsSectionHeader title="Team details" description="You’re not on a team yet." />
        <Card>
          <CardHeader>
            <CardTitle>Create a team</CardTitle>
            <CardDescription>You’ll be its owner.</CardDescription>
          </CardHeader>
          <CardContent>
            <CreateTeamForm className="flex flex-col" />
          </CardContent>
        </Card>
      </>
    );
  }
  return <TeamDetails profile={profile} studioId={studioId} onCloseSession={onCloseSession} />;
}

function TeamDetails({
  profile,
  studioId,
  onCloseSession,
}: {
  profile: ProfilePayload;
  studioId: string;
  onCloseSession: () => void;
}) {
  const queryClient = useQueryClient();
  const mutation = useProfileMutation();
  const shows = useSettingsShows();
  const team = useTeam(studioId);
  const rename = useRenameTeam(studioId);
  const transfer = useTransferOwnership(studioId);
  const deleteTeam = useDeleteTeam(studioId);
  const leave = useLeaveTeam(studioId);
  const { confirm, confirmElement } = useConfirm();
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const role = showAccessFrom(profile).teamRole(studioId) ?? 'member';
  const canEdit = role === 'owner' || role === 'admin';
  const teamName = profile.studios.find((s) => s.id === studioId)?.name ?? studioId;
  const showCount = profile.shows.filter((s) => s.studio_id === studioId).length;
  const detail = team.data;
  const orphaned = Boolean(detail) && !detail?.members.some((m) => m.role === 'owner');

  // Once per team (the top bar can switch it while the view is open).
  const draft = useInlineDraft<TeamDetailsDraft>('team-details', studioId, {
    name: teamName,
    fps: getDefaultFps(profile, studioId),
  });
  const value = draft.value;
  const baseline = draft.baseline;

  async function handleSave() {
    if (!value || !baseline) return;
    const steps: SaveStep[] = [];
    if (value.name !== baseline.name) {
      const name = value.name;
      steps.push({
        label: 'rename the team',
        run: async () => {
          await rename.mutateAsync({ display_name: name.trim() });
          draft.markSaved({ name });
        },
      });
    }
    if (value.fps !== baseline.fps) {
      const fps = value.fps;
      steps.push({
        label: 'save the default frame rate',
        run: async () => {
          // The latest profile: the rename above refetches it, and the blob is merged from it.
          const latest = queryClient.getQueryData<ProfilePayload>(['profile']) ?? profile;
          await mutation.mutateAsync({
            active_studio_id: studioId,
            active_show_id: activeShowIdForSave(latest, studioId, {
              ready: shows.ready,
              selectedShowId: shows.activeShowId,
            }),
            settings: teamSettingsWithFps(latest, studioId, fps),
          });
          draft.markSaved({ fps });
        },
      });
    }
    setSaveError(null);
    setSaving(true);
    try {
      await runSaveSteps(steps);
      showToast('Saved.');
    } catch (err) {
      setSaveError(errorMessage(err, 'Save failed.'));
    } finally {
      setSaving(false);
    }
  }

  /** After the active team is left or deleted: close an open session of it, refetch the list. */
  function afterTeamGone() {
    onCloseSession();
    invalidateAfterProfileSave(queryClient, { showUpdates: false });
  }

  async function handleTransfer(member: TeamMember) {
    const ok = await confirm({
      title: 'Transfer ownership',
      message: `Make ${member.email} the owner of ${teamName}? You will become an admin.`,
      confirmLabel: 'Transfer',
      danger: true,
    });
    if (!ok) return;
    setActionError(null);
    transfer.mutate(member.id, {
      onError: (err) => setActionError(errorMessage(err, 'Transfer failed.')),
    });
  }

  async function handleDelete() {
    const ok = await confirm({
      title: 'Delete team',
      message: `Delete ${teamName}? This can’t be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    setActionError(null);
    deleteTeam.mutate(undefined, {
      onSuccess: afterTeamGone,
      onError: (err) => setActionError(errorMessage(err, 'Delete failed.')),
    });
  }

  async function handleLeave() {
    const ok = await confirm({
      title: 'Leave team',
      message: `Leave ${teamName}? You’ll have to be re-invited to rejoin.`,
      confirmLabel: 'Leave team',
      danger: true,
    });
    if (!ok) return;
    setActionError(null);
    leave.mutate(undefined, {
      onSuccess: afterTeamGone,
      onError: (err) => setActionError(errorMessage(err, 'Leave failed.')),
    });
  }

  const transferTargets = (detail?.members ?? []).filter((m) => m.role !== 'owner');
  const busy = transfer.isPending || deleteTeam.isPending || leave.isPending;
  // A member of an ownerless team gets only the notice there (as on the previous team card).
  const showMembership = !(role === 'member' && orphaned);

  return (
    <>
      <SettingsSectionHeader title="Team details" description={`${teamName} · ${YOU_ARE[role]}`} />
      {orphaned && <OrphanedNotice />}
      {!canEdit && <RoleLockNotice role={role} teamName={teamName} />}

      {value ? (
        <Card>
          <CardContent>
            <FieldGroup className="gap-4">
              <SettingRow
                label="Team name"
                htmlFor="settings-team-name"
                description="Shown to everyone on the team."
                disabled={!canEdit}
              >
                <Input
                  id="settings-team-name"
                  type="text"
                  maxLength={200}
                  autoComplete="off"
                  disabled={!canEdit}
                  value={value.name}
                  onChange={(e) => draft.update({ name: e.target.value })}
                />
              </SettingRow>
              <FieldSeparator />
              <SettingRow
                label="Team id"
                description="Set when the team was created. Can’t be changed."
              >
                <code className="truncate font-mono text-sm text-muted-foreground">{studioId}</code>
              </SettingRow>
              <FieldSeparator />
              <SettingRow
                label="Default frame rate"
                htmlFor="settings-team-fps"
                description="New sessions in this team start at this rate."
                disabled={!canEdit}
              >
                <FpsSelect
                  id="settings-team-fps"
                  className="w-full"
                  disabled={!canEdit}
                  value={value.fps}
                  onChange={(fps) => draft.update({ fps })}
                />
              </SettingRow>
            </FieldGroup>
          </CardContent>
          <SectionSaveBar
            dirty={draft.dirty}
            saving={saving}
            valid={canEdit && value.name.trim() !== ''}
            error={saveError}
            onSave={() => void handleSave()}
          />
        </Card>
      ) : (
        <Empty>
          <EmptyDescription>Loading the team…</EmptyDescription>
        </Empty>
      )}

      {showMembership && (
        <Card>
          <CardHeader>
            <CardTitle>{role === 'owner' ? 'Handing over' : 'Leaving'}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {actionError && (
              <Alert variant="destructive">
                <TriangleAlertIcon aria-hidden="true" />
                <AlertDescription>{actionError}</AlertDescription>
              </Alert>
            )}
            <FieldGroup className="gap-4">
              {role === 'owner' ? (
                <>
                  <SettingRow
                    label="Transfer ownership"
                    description={
                      detail && transferTargets.length === 0
                        ? 'There’s no one else on the team yet. Invite someone from Members first.'
                        : 'Make someone else the owner. You become an admin.'
                    }
                  >
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="outline" disabled={busy || transferTargets.length === 0}>
                          Transfer…
                          <ChevronDownIcon data-icon="inline-end" aria-hidden="true" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuGroup>
                          {transferTargets.map((m) => (
                            <DropdownMenuItem key={m.id} onSelect={() => void handleTransfer(m)}>
                              <span className="flex min-w-0 flex-col">
                                <span className="truncate">{memberLabel(m)}</span>
                                <span className="truncate text-xs text-muted-foreground">
                                  {m.email}
                                </span>
                              </span>
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuGroup>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </SettingRow>
                  <FieldSeparator />
                  <SettingRow
                    label="Delete team"
                    description={
                      showCount > 0
                        ? `Only a team with no shows can be deleted, so remove ${
                            showCount === 1 ? 'its one show' : `its ${showCount} shows`
                          } first.`
                        : `Permanently deletes ${teamName}.`
                    }
                  >
                    <Button
                      variant="destructive"
                      disabled={busy || showCount > 0}
                      onClick={() => void handleDelete()}
                    >
                      Delete team
                    </Button>
                  </SettingRow>
                </>
              ) : (
                <SettingRow
                  label="Leave team"
                  description={`You’ll lose access to ${teamName}’s shows and sessions.`}
                >
                  <Button variant="destructive" disabled={busy} onClick={() => void handleLeave()}>
                    Leave team
                  </Button>
                </SettingRow>
              )}
            </FieldGroup>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Create a team</CardTitle>
          <CardDescription>
            You’ll be its owner. Invite people from Members afterwards.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CreateTeamForm className="flex flex-col" />
        </CardContent>
      </Card>
      {confirmElement}
    </>
  );
}
