import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ProfilePayload } from '../../../api/types';
import { renderStrict } from '../../../test/renderStrict';
import { BatchImportModal } from './BatchImportModal';

function profileFixture(): ProfilePayload {
  return {
    active_studio_id: 'studio-1',
    active_show_id: 'show-1',
    active_studio: { id: 'studio-1', name: 'Studio', categories: [] },
    studios: [],
    studio_settings: {},
    shows: [
      {
        id: 'show-1',
        name: 'Your Mom',
        show_code: 'YMH',
        next_episode: 1,
        studio_id: 'studio-1',
      },
      {
        id: 'show-2',
        name: 'Tigerbelly',
        show_code: 'TB',
        next_episode: 42,
        studio_id: 'studio-1',
      },
    ],
    new_session_defaults: { default_frame_rate: 24 },
    admin: { is_admin: false },
    auth: { require_login: false, user: null },
  } as unknown as ProfilePayload;
}

function folderFile(name: string, relPath: string): File {
  const file = new File([''], name, { type: 'audio/mpeg' });
  Object.defineProperty(file, 'webkitRelativePath', { value: relPath, configurable: true });
  return file;
}

describe('BatchImportModal', () => {
  it('renders the Batch Import dialog chrome and closes via the close control', () => {
    const onClose = vi.fn();
    renderStrict(<BatchImportModal profile={profileFixture()} onClose={onClose} />);

    expect(screen.getByRole('dialog', { name: 'Batch Import' })).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('includes a Show dropdown with the same options pattern as New Session', () => {
    renderStrict(<BatchImportModal profile={profileFixture()} onClose={() => {}} />);

    const showSelect = screen.getByLabelText('Show');
    expect(showSelect).not.toBeNull();
    expect(showSelect.tagName).toBe('BUTTON');
    expect(screen.getByText('Your Mom (YMH)')).not.toBeNull();
  });

  it('Import Logs is a no-op (no file picker, no import side effects)', () => {
    renderStrict(<BatchImportModal profile={profileFixture()} onClose={() => {}} />);

    const dirInput = screen.getByTestId('batch-import-dir-input');
    expect(dirInput).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Import Logs' }));

    expect(screen.queryByTestId('batch-import-folder-name')).toBeNull();
    expect((dirInput as HTMLInputElement).files?.length ?? 0).toBe(0);
  });

  it('shows the folder name after simulating a directory file input change', () => {
    renderStrict(<BatchImportModal profile={profileFixture()} onClose={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Import Audio' }));

    const dirInput = screen.getByTestId('batch-import-dir-input');
    const files = [
      folderFile('ep1.mp3', 'EpisodeBatch/ep1.mp3'),
      folderFile('ep2.mp3', 'EpisodeBatch/ep2.mp3'),
    ];
    fireEvent.change(dirInput, { target: { files } });

    expect(screen.getByTestId('batch-import-folder-name').textContent).toBe('EpisodeBatch');
  });

  it('close clears folder selection on a fresh open', () => {
    const onClose = vi.fn();
    const { unmount } = renderStrict(
      <BatchImportModal profile={profileFixture()} onClose={onClose} />,
    );

    const dirInput = screen.getByTestId('batch-import-dir-input');
    fireEvent.change(dirInput, {
      target: { files: [folderFile('ep1.mp3', 'EpisodeBatch/ep1.mp3')] },
    });
    expect(screen.getByTestId('batch-import-folder-name')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();

    renderStrict(<BatchImportModal profile={profileFixture()} onClose={() => {}} />);
    expect(screen.queryByTestId('batch-import-folder-name')).toBeNull();
  });

  it('includes an empty progress region beneath Start Import', () => {
    renderStrict(<BatchImportModal profile={profileFixture()} onClose={() => {}} />);

    const progress = screen.getByTestId('batch-import-progress');
    expect(progress).not.toBeNull();
    expect(progress.textContent).toBe('');
    expect(screen.getByRole('button', { name: 'Start Import' })).not.toBeNull();
  });
});
