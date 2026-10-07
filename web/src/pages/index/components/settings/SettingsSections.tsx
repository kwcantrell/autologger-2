import { type ComponentType, useState } from 'react';
import { Button } from '../../../../shared/components/ui/button';
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '../../../../shared/components/ui/card';
import { HomeSettingsModal } from '../HomeSettingsModal';
import { AccountSection } from './AccountSection';
import { MembersSection } from './MembersSection';
import type { SettingsSectionProps } from './SettingsView';
import { ShowDetailsSection } from './ShowDetailsSection';
import { ShowsSection } from './ShowsSection';
import type { SettingsSectionId } from './sections';
import { SettingsSectionHeader } from './settingsParts';
import { TeamDetailsSection } from './TeamDetailsSection';

// --- Settings sections (redesign-show-ignition 6.1, 7.1-7.3, 8.1-8.2) ---
//
// Account, Show details and Team details are the inline sections (group 7); Members and Shows list
// their items and edit each in a side panel (group 8). Event buttons lands in group 9; until then
// it says so plainly and opens the previous Settings dialog (`HomeSettingsModal`, retired by task
// 10.1), which still edits it. The legacy dialog is imported statically: it rides in the Settings
// view's chunk, which is the one overlay split point for Settings (web-frontend-platform's five).

function PreviousSettingsCard({
  what,
  onCloseSession,
}: {
  what: string;
  onCloseSession: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Moving here soon</CardTitle>
        <CardDescription>
          {what} will be edited on this page in an upcoming update. Until then, use the previous
          Settings dialog.
        </CardDescription>
      </CardHeader>
      <CardFooter>
        <Button variant="outline" onClick={() => setOpen(true)}>
          Open previous Settings
        </Button>
      </CardFooter>
      {open && (
        <HomeSettingsModal isOpen onClose={() => setOpen(false)} onCloseSession={onCloseSession} />
      )}
    </Card>
  );
}

function EventButtonsSection({ onCloseSession }: SettingsSectionProps) {
  return (
    <>
      <SettingsSectionHeader
        title="Event buttons"
        description="The logging strip for the active show."
      />
      <PreviousSettingsCard what="Event buttons and the palette" onCloseSession={onCloseSession} />
    </>
  );
}

export const SETTINGS_SECTION_CONTENT: Record<
  SettingsSectionId,
  ComponentType<SettingsSectionProps>
> = {
  account: AccountSection,
  members: MembersSection,
  shows: ShowsSection,
  'team-details': TeamDetailsSection,
  'show-details': ShowDetailsSection,
  'event-buttons': EventButtonsSection,
};
