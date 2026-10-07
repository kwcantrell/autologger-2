import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderStrict } from '../../../../test/renderStrict';
import { SETTINGS_SECTION_CONTENT } from './SettingsSections';

// --- Interim Settings sections (redesign-show-ignition 6.1/6.2) ---
//
// Until group 9 builds Event buttons, nothing users rely on may disappear: it opens the previous
// Settings dialog (the other sections have their own tests). The dialog has its own tests
// (HomeSettingsModal.test.tsx); here it is a stand-in.

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
  it.each([
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
