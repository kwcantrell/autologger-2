import { fireEvent, screen, waitFor } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { apiFetch } from '../../../api/client';
import type { ProfilePayload } from '../../../api/types';
import { renderWithQueryClient } from '../../../test/renderWithQueryClient';
import { stitchAudioFiles } from '../batchImport/stitch';
import { BatchImportModal } from './BatchImportModal';

vi.mock('../../../api/client', () => ({
  apiFetch: vi.fn(),
}));

vi.mock('../batchImport/stitch', () => ({
  stitchAudioFiles: vi.fn(),
}));

const mockedApiFetch = vi.mocked(apiFetch);
const mockedStitch = vi.mocked(stitchAudioFiles);

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
    new_session_defaults: { default_frame_rate: 24, title_prefix: '' },
    admin: { is_admin: false },
    auth: { require_login: false, user: null },
  } as unknown as ProfilePayload;
}

function folderFile(name: string, relPath: string): File {
  const file = new File(['audio'], name, { type: 'audio/mpeg' });
  Object.defineProperty(file, 'webkitRelativePath', { value: relPath, configurable: true });
  return file;
}

function pickFolder(...files: File[]) {
  fireEvent.click(screen.getByRole('button', { name: 'Import Audio' }));
  fireEvent.change(screen.getByTestId('batch-import-dir-input'), { target: { files } });
}

describe('BatchImportModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the Batch Import dialog chrome and closes via the close control', () => {
    const onClose = vi.fn();
    renderWithQueryClient(<BatchImportModal profile={profileFixture()} onClose={onClose} />);

    expect(screen.getByRole('dialog', { name: 'Batch Import' })).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('includes a Show dropdown with the same options pattern as New Session', () => {
    renderWithQueryClient(<BatchImportModal profile={profileFixture()} onClose={() => {}} />);

    const showSelect = screen.getByLabelText('Show');
    expect(showSelect).not.toBeNull();
    expect(showSelect.tagName).toBe('BUTTON');
    expect(screen.getByText('Your Mom (YMH)')).not.toBeNull();
  });

  it('Import Logs is a no-op (no file picker, no import side effects)', () => {
    renderWithQueryClient(<BatchImportModal profile={profileFixture()} onClose={() => {}} />);

    const dirInput = screen.getByTestId('batch-import-dir-input');
    expect(dirInput).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Import Logs' }));

    expect(screen.queryByTestId('batch-import-folder-name')).toBeNull();
    expect((dirInput as HTMLInputElement).files?.length ?? 0).toBe(0);
  });

  it('shows the folder name after simulating a directory file input change', () => {
    renderWithQueryClient(<BatchImportModal profile={profileFixture()} onClose={() => {}} />);

    pickFolder(
      folderFile('ep1.mp3', 'EpisodeBatch/ep1.mp3'),
      folderFile('ep2.mp3', 'EpisodeBatch/ep2.mp3'),
    );

    expect(screen.getByTestId('batch-import-folder-name').textContent).toBe('EpisodeBatch');
  });

  it('close clears folder selection on a fresh open', () => {
    const onClose = vi.fn();
    const { unmount } = renderWithQueryClient(
      <BatchImportModal profile={profileFixture()} onClose={onClose} />,
    );

    pickFolder(folderFile('ep1.mp3', 'EpisodeBatch/ep1.mp3'));
    expect(screen.getByTestId('batch-import-folder-name')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();

    renderWithQueryClient(<BatchImportModal profile={profileFixture()} onClose={() => {}} />);
    expect(screen.queryByTestId('batch-import-folder-name')).toBeNull();
    expect(screen.getByTestId('batch-import-progress').textContent).toBe('');
  });

  it('includes an empty progress region beneath Start Import', () => {
    renderWithQueryClient(<BatchImportModal profile={profileFixture()} onClose={() => {}} />);

    const progress = screen.getByTestId('batch-import-progress');
    expect(progress).not.toBeNull();
    expect(progress.textContent).toBe('');
    expect(screen.getByRole('button', { name: 'Start Import' })).not.toBeNull();
  });

  it('skips existing sessions and records a skip line', async () => {
    mockedApiFetch.mockImplementation(async (path) => {
      if (path === 'sessions') {
        return {
          active: [{ id: 's1', episode: 'YMH_001', title: 'YMH_001', show_id: 'show-1' }],
          archived: [],
        };
      }
      throw new Error(`unexpected ${path}`);
    });

    renderWithQueryClient(<BatchImportModal profile={profileFixture()} onClose={() => {}} />);
    pickFolder(folderFile('YMH_001.mp3', 'Batch/YMH_001.mp3'));
    fireEvent.click(screen.getByRole('button', { name: 'Start Import' }));

    await waitFor(() => {
      expect(screen.getByText('Skipped YMH_001 (already in system)')).not.toBeNull();
    });
    expect(mockedStitch).not.toHaveBeenCalled();
    expect(mockedApiFetch).not.toHaveBeenCalledWith(
      expect.stringContaining('local-audio-import'),
      expect.anything(),
    );
  });

  it('creates a session and imports audio on the success path without opening a session', async () => {
    mockedApiFetch.mockImplementation(async (path, opts) => {
      if (path === 'sessions' && (!opts || opts.method === undefined)) {
        return { active: [], archived: [] };
      }
      if (path === 'sessions' && opts?.method === 'POST') {
        return { id: 'new-id', episode: 'YMH_002', title: 'YMH_002' };
      }
      if (path.includes('local-audio-import')) return { ok: true };
      throw new Error(`unexpected ${path}`);
    });
    mockedStitch.mockResolvedValue({
      blob: new Blob(['wav'], { type: 'audio/wav' }),
      durationS: 3,
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');

    renderWithQueryClient(<BatchImportModal profile={profileFixture()} onClose={() => {}} />, client);
    pickFolder(folderFile('YMH_002.mp3', 'Batch/YMH_002.mp3'));
    fireEvent.click(screen.getByRole('button', { name: 'Start Import' }));

    await waitFor(() => {
      expect(screen.getByText('Completed YMH_002')).not.toBeNull();
    });
    expect(mockedStitch).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['sessions'] });
    expect(mockedApiFetch).not.toHaveBeenCalledWith(
      expect.stringMatching(/^sessions\/new-id$/),
      expect.anything(),
    );
  });

  it('keeps progress visible after import finishes until close', async () => {
    mockedApiFetch.mockImplementation(async (path) => {
      if (path === 'sessions') {
        return {
          active: [{ id: 's1', episode: 'YMH_001', title: 'YMH_001' }],
          archived: [],
        };
      }
      throw new Error(`unexpected ${path}`);
    });

    renderWithQueryClient(<BatchImportModal profile={profileFixture()} onClose={() => {}} />);
    pickFolder(folderFile('YMH_001.mp3', 'Batch/YMH_001.mp3'));
    fireEvent.click(screen.getByRole('button', { name: 'Start Import' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Start Import' })).not.toBeNull();
    });

    expect(screen.getByText('Skipped YMH_001 (already in system)')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Start Import' }).textContent).toBe('Start Import');
  });

  it('abort on close clears progress on remount', async () => {
    let resolveStitch: ((v: { blob: Blob; durationS: number }) => void) | undefined;
    mockedStitch.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStitch = resolve;
        }),
    );
    mockedApiFetch.mockImplementation(async (path, opts) => {
      if (path === 'sessions' && (!opts || opts.method === undefined)) {
        return { active: [], archived: [] };
      }
      if (path === 'sessions' && opts?.method === 'POST') {
        return { id: 'new-id', episode: 'SLOW', title: 'SLOW' };
      }
      throw new Error(`unexpected ${path}`);
    });

    const onClose = vi.fn();
    const { unmount } = renderWithQueryClient(
      <BatchImportModal profile={profileFixture()} onClose={onClose} />,
    );
    pickFolder(folderFile('SLOW.mp3', 'Batch/SLOW.mp3'));
    fireEvent.click(screen.getByRole('button', { name: 'Start Import' }));

    await waitFor(() => {
      expect(screen.getByTestId('batch-import-current')).not.toBeNull();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();

    resolveStitch?.({ blob: new Blob(['wav'], { type: 'audio/wav' }), durationS: 1 });

    renderWithQueryClient(<BatchImportModal profile={profileFixture()} onClose={() => {}} />);
    expect(screen.getByTestId('batch-import-progress').textContent).toBe('');
  });
});
