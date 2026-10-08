import type { ComponentType } from 'react';
import { AccountSection } from './AccountSection';
import { CompanionDevicesSection } from './CompanionDevicesSection';
import { EventButtonsSection } from './EventButtonsSection';
import { MembersSection } from './MembersSection';
import type { SettingsSectionProps } from './SettingsView';
import { ShowDetailsSection } from './ShowDetailsSection';
import { ShowsSection } from './ShowsSection';
import type { SettingsSectionId } from './sections';
import { TeamDetailsSection } from './TeamDetailsSection';

// --- Settings sections (redesign-show-ignition 6.1, 7.1-7.3, 8.1-8.2, 9.1-9.2) ---
//
// Account, Show details and Team details are the inline sections (group 7); Companion devices
// (companion-devices D6) acts immediately, with no save bar; Members and Shows list
// their items and edit each in a side panel (group 8); Event buttons lists the show's buttons with
// its palette inline and edits each button in a side panel (group 9).

export const SETTINGS_SECTION_CONTENT: Record<
  SettingsSectionId,
  ComponentType<SettingsSectionProps>
> = {
  account: AccountSection,
  'companion-devices': CompanionDevicesSection,
  members: MembersSection,
  shows: ShowsSection,
  'team-details': TeamDetailsSection,
  'show-details': ShowDetailsSection,
  'event-buttons': EventButtonsSection,
};
