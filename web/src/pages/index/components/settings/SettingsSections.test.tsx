import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderStrict } from '../../../../test/renderStrict';
import { SETTINGS_SECTION_CONTENT } from './SettingsSections';

// --- Interim Settings sections (redesign-show-ignition 6.1/6.2) ---
//
// Until groups 7-9 build each section, nothing users rely on may disappear: Members carries the
// retired `/teams` page body, Team details points there, and the rest open the previous Settings
// dialog. The two embedded surfaces have their own tests (LegacyTeamsPanel.test.tsx,
// HomeSettingsModal.test.tsx); here they are stand-ins.

vi.mock('./LegacyTeamsPanel', () => ({
  LegacyTeamsPanel: () => <div data-testid="legacy-teams-panel" />,
}));
vi.mock('../HomeSettingsModal', () => ({
  HomeSettingsModal: (props: { onClose: () => void; onCloseSession: () => void }) => (
    <div role="dialog" aria-label="Previous Settings">
      <button type="button" onClick={props.onClose}>
        Close previous
      </button>
      <button type="button" onClick={props.onCloseSession}>
        Switch studio
      </button>
    </div>
  ),
}));

const props = () => ({ onGoToSection: vi.fn(), onCloseSession: vi.fn() });

describe('interim Settings sections', () => {
  it('Members carries the former teams page, so team management stays reachable', () => {
    const Members = SETTINGS_SECTION_CONTENT.members;
    renderStrict(<Members {...props()} />);
    expect(screen.getByRole('heading', { name: 'Members' })).not.toBeNull();
    expect(screen.getByTestId('legacy-teams-panel')).not.toBeNull();
  });

  it('Team details sends the user to Members, where its actions live for now', () => {
    const p = props();
    const TeamDetails = SETTINGS_SECTION_CONTENT['team-details'];
    renderStrict(<TeamDetails {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'Go to Members' }));
    expect(p.onGoToSection).toHaveBeenCalledWith('members');
  });

  it.each([
    'account',
    'shows',
    'show-details',
    'event-buttons',
  ] as const)('%s says it is moving here and opens the previous Settings dialog meanwhile', (id) => {
    const p = props();
    const Section = SETTINGS_SECTION_CONTENT[id];
    renderStrict(<Section {...p} />);

    expect(screen.getByText('Moving here soon')).not.toBeNull();
    expect(screen.queryByRole('dialog', { name: 'Previous Settings' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open previous Settings' }));
    expect(screen.getByRole('dialog', { name: 'Previous Settings' })).not.toBeNull();

    // Its team-switch save still reaches the shell's close-session path.
    fireEvent.click(screen.getByRole('button', { name: 'Switch studio' }));
    expect(p.onCloseSession).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Close previous' }));
    expect(screen.queryByRole('dialog', { name: 'Previous Settings' })).toBeNull();
  });
});
