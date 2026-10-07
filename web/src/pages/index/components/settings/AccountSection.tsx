import { useState } from 'react';
import { useProfile, useProfileMutation } from '../../../../api/hooks/useProfile';
import { Button } from '../../../../shared/components/ui/button';
import { Card, CardContent } from '../../../../shared/components/ui/card';
import { Empty, EmptyDescription } from '../../../../shared/components/ui/empty';
import { FieldGroup, FieldSeparator } from '../../../../shared/components/ui/field';
import { Input } from '../../../../shared/components/ui/input';
import { showToast } from '../../utils/toast';
import { runSaveSteps } from './SidePanel';
import { activeShowIdForSave, profileStudioId } from './settingsModel';
import { SectionSaveBar, SettingRow, SettingsSectionHeader } from './settingsParts';
import { useInlineDraft, useSettingsShows } from './settingsScopes';

// --- Settings › Account (redesign-show-ignition 7.1) ---
//
// The signed-in user's names and sign-out. The names save under the section's save bar through
// `PUT /api/profile`, which needs the active team and treats an absent show as "pick the first",
// so the write carries `active_studio_id` and echoes the current show (settingsModel
// `activeShowIdForSave`). It never carries team or show settings: those are owner/admin writes
// (team-management "Member content access"), and the frame rate lives in Team details.

interface AccountDraft {
  givenName: string;
  familyName: string;
}

export function AccountSection() {
  const { data: profile } = useProfile();
  const mutation = useProfileMutation();
  const shows = useSettingsShows();
  const user = profile?.auth.user ?? null;

  // Initialised once per open (the view mounts per open), from the profile alone.
  const draft = useInlineDraft<AccountDraft>(
    'account',
    user ? 'account' : null,
    user ? { givenName: user.given_name ?? '', familyName: user.family_name ?? '' } : null,
  );
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    if (!profile || !draft.value) return;
    const saved = draft.value;
    const studioId = profileStudioId(profile);
    setError(null);
    try {
      await runSaveSteps([
        {
          label: 'save your name',
          run: () =>
            mutation.mutateAsync({
              active_studio_id: studioId,
              active_show_id: activeShowIdForSave(profile, studioId, {
                ready: shows.ready,
                selectedShowId: shows.activeShowId,
              }),
              given_name: saved.givenName.trim(),
              family_name: saved.familyName.trim(),
            }),
        },
      ]);
      draft.markSaved(saved);
      showToast('Saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.');
    }
  }

  return (
    <>
      <SettingsSectionHeader
        title="Account"
        description="Your profile on this AutoLogger server."
      />
      {!user || !draft.value ? (
        <Empty>
          <EmptyDescription>You’re not signed in.</EmptyDescription>
        </Empty>
      ) : (
        <>
          <Card>
            <CardContent>
              <FieldGroup className="gap-4">
                <SettingRow label="First name" htmlFor="settings-account-given">
                  <Input
                    id="settings-account-given"
                    type="text"
                    maxLength={200}
                    autoComplete="given-name"
                    value={draft.value.givenName}
                    onChange={(e) => draft.update({ givenName: e.target.value })}
                  />
                </SettingRow>
                <FieldSeparator />
                <SettingRow label="Last name" htmlFor="settings-account-family">
                  <Input
                    id="settings-account-family"
                    type="text"
                    maxLength={200}
                    autoComplete="family-name"
                    placeholder="Not set"
                    value={draft.value.familyName}
                    onChange={(e) => draft.update({ familyName: e.target.value })}
                  />
                </SettingRow>
                <FieldSeparator />
                <SettingRow label="Email" description="The account you sign in with.">
                  <span className="truncate text-sm text-muted-foreground">{user.email}</span>
                </SettingRow>
              </FieldGroup>
            </CardContent>
            <SectionSaveBar
              dirty={draft.dirty}
              saving={mutation.isPending}
              error={error}
              onSave={() => void handleSave()}
            />
          </Card>
          <Card>
            <CardContent>
              <FieldGroup>
                <SettingRow label="Sign out" description="Ends your session on this device.">
                  {/* A real link: logout is a full-page navigation. */}
                  <Button variant="destructive" asChild>
                    <a href="/auth/logout">Sign out</a>
                  </Button>
                </SettingRow>
              </FieldGroup>
            </CardContent>
          </Card>
        </>
      )}
    </>
  );
}
