import { useQueryClient } from '@tanstack/react-query';
import { TvIcon } from 'lucide-react';
import { useState } from 'react';
import { useProfile, useProfileMutation } from '../../../../api/hooks/useProfile';
import { showAccessFrom } from '../../../../api/hooks/useShowAccess';
import { Button } from '../../../../shared/components/ui/button';
import { Card, CardContent } from '../../../../shared/components/ui/card';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '../../../../shared/components/ui/empty';
import { FieldGroup, FieldSeparator } from '../../../../shared/components/ui/field';
import { Input } from '../../../../shared/components/ui/input';
import { showToast } from '../../utils/toast';
import type { SettingsSectionProps } from './SettingsView';
import { runSaveSteps } from './SidePanel';
import {
  activeShowIdForSave,
  invalidateAfterProfileSave,
  showDraftToUpdate,
  showInitials,
} from './settingsModel';
import {
  RoleLockNotice,
  SectionSaveBar,
  SettingRow,
  SettingsSectionHeader,
  ShowsNotReady,
  SuffixToggle,
} from './settingsParts';
import { useInlineDraft, useSettingsShows } from './settingsScopes';

// --- Settings › Show details (redesign-show-ignition 7.2) ---
//
// The active show's name, code and title Suffix (session-title-suffix: Date / Episode Number, the
// row after Code; there is no Next Ep). Owners and admins edit; a member sees the same rows
// disabled under a notice naming their role (team-management "Member content access").
//
// The save writes the WHOLE show through `show_updates`: these three fields over the show's saved
// categories and palette from the view's baseline, so it submits the same update whether or not
// Event buttons was visited (web-ui-system "Saving persists shows whose tab was never visited"),
// and never another section's unsaved edits. Before the shows arrive, the section says why it has
// nothing to show: loading, failed (with Retry) or offline (web-ui-system "The Settings shows
// section says why it has nothing to show").

interface ShowDetailsDraft {
  name: string;
  show_code: string;
  title_suffix: 'date' | 'episode';
}

export function ShowDetailsSection({ onGoToSection }: SettingsSectionProps) {
  const { data: profile } = useProfile();
  const mutation = useProfileMutation();
  const queryClient = useQueryClient();
  const scope = useSettingsShows();
  const [error, setError] = useState<string | null>(null);

  const showId = scope.activeShowId;
  const saved = showId ? scope.baseline[showId] : undefined;
  const slice: ShowDetailsDraft | null = saved
    ? { name: saved.name, show_code: saved.show_code, title_suffix: saved.title_suffix }
    : null;
  // Keyed by the saved slice too: a save of this show from its panel in Shows re-seeds this
  // section. It cannot be dirty then (leaving it dirty for Shows went through the discard guard).
  const draft = useInlineDraft<ShowDetailsDraft>(
    'show-details',
    slice ? `${scope.studioId}:${showId}:${JSON.stringify(slice)}` : null,
    slice,
  );

  const role = showAccessFrom(profile).teamRole(scope.studioId);
  const canEdit = role === 'owner' || role === 'admin';
  const teamName = profile?.studios.find((s) => s.id === scope.studioId)?.name ?? 'this team';

  async function handleSave() {
    if (!profile || !saved || !draft.value) return;
    const fields = draft.value;
    const merged = { ...saved, ...fields };
    setError(null);
    try {
      await runSaveSteps([
        {
          label: 'save the show details',
          run: () =>
            mutation.mutateAsync({
              active_studio_id: scope.studioId,
              active_show_id: activeShowIdForSave(profile, scope.studioId, {
                ready: scope.ready,
                selectedShowId: showId,
              }),
              show_updates: [showDraftToUpdate(showId, merged)],
            }),
        },
      ]);
      scope.commitShow(showId, merged);
      draft.markSaved(fields);
      showToast('Saved.');
      invalidateAfterProfileSave(queryClient, { showUpdates: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.');
    }
  }

  // Before the full shows arrive, the profile's brief entry still names the active show.
  const showName =
    (saved ? saved.name || 'Untitled show' : undefined) ??
    profile?.shows.find((s) => s.id === profile.active_show_id)?.name;
  const header = (
    <SettingsSectionHeader
      title="Show details"
      description={showName ? `${showName} in ${teamName}` : 'The active show.'}
    />
  );

  if (!scope.studioId) {
    return (
      <>
        {header}
        <Empty>
          <EmptyDescription>Join or create a team to set up its shows.</EmptyDescription>
        </Empty>
      </>
    );
  }

  if (!scope.ready) {
    return (
      <>
        {header}
        <ShowsNotReady unavailable={scope.unavailable} onRetry={scope.retry} />
      </>
    );
  }

  if (!saved || !draft.value) {
    return (
      <>
        {header}
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <TvIcon aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>No shows yet</EmptyTitle>
            <EmptyDescription>
              {canEdit
                ? `${teamName} has no shows. Add one in Shows.`
                : `${teamName} has no shows yet.`}
            </EmptyDescription>
          </EmptyHeader>
          {canEdit && (
            <EmptyContent>
              <Button variant="outline" onClick={() => onGoToSection('shows')}>
                Go to Shows
              </Button>
            </EmptyContent>
          )}
        </Empty>
      </>
    );
  }

  const value = draft.value;
  const initials = showInitials(value.name);
  const codeHint =
    value.name.trim() && value.show_code.trim() && value.show_code.trim().toUpperCase() !== initials
      ? `Usually the show name’s initials (${initials}). Yours differs, which is fine if intended.`
      : 'Starts the name of every untitled session in this show.';

  return (
    <>
      {header}
      {!canEdit && role && <RoleLockNotice role={role} teamName={teamName} />}
      <Card>
        <CardContent>
          <FieldGroup className="gap-4">
            <SettingRow
              label="Show name"
              htmlFor="settings-show-name"
              description="Appears in the sidebar and on every session."
              disabled={!canEdit}
            >
              <Input
                id="settings-show-name"
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
              label="Code"
              htmlFor="settings-show-code"
              description={codeHint}
              disabled={!canEdit}
            >
              <Input
                id="settings-show-code"
                type="text"
                maxLength={40}
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
                disabled={!canEdit}
                value={value.show_code}
                onChange={(e) => draft.update({ show_code: e.target.value.toUpperCase() })}
              />
            </SettingRow>
            <FieldSeparator />
            <SettingRow
              label="Suffix"
              labelId="settings-show-suffix-label"
              description="How an untitled session’s name ends: the date, or an episode number."
              disabled={!canEdit}
            >
              <SuffixToggle
                labelledBy="settings-show-suffix-label"
                disabled={!canEdit}
                value={value.title_suffix}
                onChange={(title_suffix) => draft.update({ title_suffix })}
              />
            </SettingRow>
          </FieldGroup>
        </CardContent>
        <SectionSaveBar
          dirty={draft.dirty}
          saving={mutation.isPending}
          valid={canEdit && value.name.trim() !== ''}
          error={error}
          onSave={() => void handleSave()}
        />
      </Card>
    </>
  );
}
