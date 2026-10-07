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
import { LegacyTeamsPanel } from './LegacyTeamsPanel';
import type { SettingsSectionProps } from './SettingsView';
import type { SettingsSectionId } from './sections';

// --- Settings sections (interim, redesign-show-ignition 6.1) ---
//
// Group 6 builds the Settings view's shell; each section's real content lands in groups 7-9
// (Account, Show details, Team details: 7; Members, Shows: 8; Event buttons: 9). Until then each
// section says so plainly and keeps what users rely on reachable:
//   - Members embeds the retired `/teams` page body (`LegacyTeamsPanel`), so every team action
//     that page offered is still here;
//   - Team details points at Members, where those actions live for now;
//   - Account, Shows, Show details and Event buttons open the previous Settings dialog
//     (`HomeSettingsModal`, retired by task 10.1), which still edits all of them.
// The legacy dialog is imported statically: it rides in the Settings view's chunk, which is the
// one overlay split point for Settings (web-frontend-platform's five).

export function SettingsSectionHeader({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <header className="flex flex-col gap-1.5">
      <h3 className="m-0 font-ui text-2xl leading-tight font-semibold">{title}</h3>
      {description && <p className="m-0 text-sm text-muted-foreground">{description}</p>}
    </header>
  );
}

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

function AccountSection({ onCloseSession }: SettingsSectionProps) {
  return (
    <>
      <SettingsSectionHeader
        title="Account"
        description="Your profile on this AutoLogger server."
      />
      <PreviousSettingsCard what="Your name and sign-out" onCloseSession={onCloseSession} />
    </>
  );
}

function MembersSection() {
  return (
    <>
      <SettingsSectionHeader
        title="Members"
        description="Your teams, their members and invites. The new member list replaces this in an upcoming update."
      />
      <LegacyTeamsPanel />
    </>
  );
}

function ShowsSection({ onCloseSession }: SettingsSectionProps) {
  return (
    <>
      <SettingsSectionHeader title="Shows" description="The active team’s shows." />
      <PreviousSettingsCard what="Adding and editing shows" onCloseSession={onCloseSession} />
    </>
  );
}

function TeamDetailsSection({ onGoToSection }: SettingsSectionProps) {
  return (
    <>
      <SettingsSectionHeader
        title="Team details"
        description="The team’s name, ownership and membership."
      />
      <Card>
        <CardHeader>
          <CardTitle>Moving here soon</CardTitle>
          <CardDescription>
            Renaming, creating, transferring, leaving and deleting a team are under Members for now.
          </CardDescription>
        </CardHeader>
        <CardFooter>
          <Button variant="outline" onClick={() => onGoToSection('members')}>
            Go to Members
          </Button>
        </CardFooter>
      </Card>
    </>
  );
}

function ShowDetailsSection({ onCloseSession }: SettingsSectionProps) {
  return (
    <>
      <SettingsSectionHeader title="Show details" description="The active show’s name and code." />
      <PreviousSettingsCard
        what="The show’s name, code, suffix and default frame rate"
        onCloseSession={onCloseSession}
      />
    </>
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
