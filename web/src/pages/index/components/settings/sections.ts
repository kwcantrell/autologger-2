// The Settings view's sections (redesign-show-ignition D3; web-ui-system "Settings modal defers
// inactive tab content"). Import-free on purpose: AppShell reads the ids and the default from
// here without pulling the view's chunk into the homepage graph.

export type SettingsSectionId =
  | 'account'
  | 'members'
  | 'shows'
  | 'team-details'
  | 'show-details'
  | 'event-buttons';

/** The shell's Settings state: open on a section, or closed (`null`). Never the URL. */
export type SettingsState = { section: SettingsSectionId } | null;

export interface SettingsSectionGroup {
  /** Group label in the nav ("You", "Team", "Show"). */
  label: string;
  sections: { id: SettingsSectionId; label: string }[];
}

/** Nav order. There is no Auto Sync and no Debug section. */
export const SETTINGS_SECTION_GROUPS: readonly SettingsSectionGroup[] = [
  { label: 'You', sections: [{ id: 'account', label: 'Account' }] },
  {
    label: 'Team',
    sections: [
      { id: 'members', label: 'Members' },
      { id: 'shows', label: 'Shows' },
      { id: 'team-details', label: 'Team details' },
    ],
  },
  {
    label: 'Show',
    sections: [
      { id: 'show-details', label: 'Show details' },
      { id: 'event-buttons', label: 'Event buttons' },
    ],
  },
];

export const SETTINGS_SECTIONS: readonly { id: SettingsSectionId; label: string }[] =
  SETTINGS_SECTION_GROUPS.flatMap((g) => g.sections);

/** Where an open with no named section lands before any section was visited this page load. */
export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = 'show-details';

export const settingsTabId = (id: SettingsSectionId) => `settings-tab-${id}`;
export const settingsPanelId = (id: SettingsSectionId) => `settings-section-${id}`;

/**
 * Marks the view root. The shell's `[` shortcut is the one key the view lets through
 * (web-ui-system "Shell-level sidebar shortcut"), so it skips this overlay and no other.
 */
export const SETTINGS_VIEW_SELECTOR = '[data-slot="settings-view"]';
