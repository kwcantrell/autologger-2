import { QueryClient } from '@tanstack/react-query';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

// Radix Select needs these in jsdom to open (the LazySelect.test.tsx recipe).
if (typeof Element !== 'undefined' && !Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (typeof Element !== 'undefined' && !Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
}
if (typeof Element !== 'undefined' && !Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
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
        title_suffix: 'episode',
        studio_id: 'studio-1',
        can_access: true,
      },
      {
        id: 'show-2',
        name: 'Tigerbelly',
        show_code: 'TB',
        title_suffix: 'episode',
        studio_id: 'studio-1',
        can_access: true,
      },
    ],
    new_session_defaults: { default_frame_rate: 24, title_prefix: '' },
    admin: { is_admin: false },
    auth: { logged_in: false, oauth_configured: true, user: null },
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

  it('actions are shadcn Buttons: outline imports, Start Import primary in the actions row (shadcn-port-modals D3)', () => {
    renderWithQueryClient(<BatchImportModal profile={profileFixture()} onClose={() => {}} />);
    expect(screen.getAllByRole('button', { name: 'Close' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Import Audio' }).getAttribute('data-variant')).toBe(
      'outline',
    );
    expect(screen.getByRole('button', { name: 'Import Logs' }).getAttribute('data-variant')).toBe(
      'outline',
    );
    const start = screen.getByRole('button', { name: 'Start Import' });
    expect(start.getAttribute('data-variant')).toBe('default');
    expect(start.closest('[data-slot="dialog-actions"]')).not.toBeNull();
    expect(start.className).toContain('max-md:min-h-11');
  });

  it('includes a Show dropdown with the same options pattern as New Session', () => {
    renderWithQueryClient(<BatchImportModal profile={profileFixture()} onClose={() => {}} />);

    const showSelect = screen.getByLabelText('Show');
    expect(showSelect).not.toBeNull();
    expect(showSelect.tagName).toBe('BUTTON');
    expect(screen.getByText('Your Mom (YMH)')).not.toBeNull();
  });

  // Import Logs asks for the URL in the themed text prompt (shadcn-shared-wrappers D3b), never
  // `window.prompt`; the URL lands after the prompt's promise resolves, hence the awaits.
  async function enterLogsUrl(url: string) {
    fireEvent.click(screen.getByRole('button', { name: 'Import Logs' }));
    const field = await screen.findByRole('textbox', { name: /Google Sheets URL/ });
    fireEvent.change(field, { target: { value: url } });
    fireEvent.click(screen.getByRole('button', { name: 'Use URL' }));
  }

  it('Import Logs prompts for a Sheets URL and stores it', async () => {
    const prompt = vi.spyOn(window, 'prompt');
    renderWithQueryClient(<BatchImportModal profile={profileFixture()} onClose={() => {}} />);

    await enterLogsUrl(' https://docs.google.com/spreadsheets/d/abc123/edit ');

    await waitFor(() =>
      expect(screen.getByTestId('batch-import-logs-url').textContent).toContain('abc123'),
    );
    expect(prompt).not.toHaveBeenCalled();
    prompt.mockRestore();
  });

  it('Start Import is enabled when only a logs URL is set', async () => {
    renderWithQueryClient(<BatchImportModal profile={profileFixture()} onClose={() => {}} />);
    await enterLogsUrl('https://docs.google.com/spreadsheets/d/abc123/edit');
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Start Import' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
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
      partDurationsS: [3],
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');

    renderWithQueryClient(
      <BatchImportModal profile={profileFixture()} onClose={() => {}} />,
      client,
    );
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

  // shared-request-state D1: a job 404 means the job record expired or never existed (any
  // server process answers the poll now), not a missing API route.
  it('a log-import job 404 says the job was not found and to start again', async () => {
    mockedApiFetch.mockImplementation(async (path) => {
      if (path === 'shows/show-1/log-import') return { job_id: 'job-1' };
      if (path === 'log-import/job-1') {
        throw Object.assign(new Error('Log import job not found.'), { status: 404 });
      }
      throw new Error(`unexpected ${path}`);
    });
    renderWithQueryClient(<BatchImportModal profile={profileFixture()} onClose={() => {}} />);
    await enterLogsUrl('https://docs.google.com/spreadsheets/d/abc123/edit');
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Start Import' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Start Import' }));
    const line = await screen.findByText(/HTTP 404/);
    expect(line.textContent).toBe(
      'Failed: HTTP 404 — Log import job not found. (The import job was not found. It may have expired; start the import again.)',
    );
    expect(screen.queryByText(/API route missing/)).toBeNull();
  });

  it('abort on close clears progress on remount', async () => {
    let resolveStitch:
      | ((v: { blob: Blob; durationS: number; partDurationsS: number[] }) => void)
      | undefined;
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

    resolveStitch?.({
      blob: new Blob(['wav'], { type: 'audio/wav' }),
      durationS: 1,
      partDurationsS: [1],
    });

    renderWithQueryClient(<BatchImportModal profile={profileFixture()} onClose={() => {}} />);
    expect(screen.getByTestId('batch-import-progress').textContent).toBe('');
  });
});

describe('BatchImportModal — the picker lists accessible shows of the active team (show-grants D13)', () => {
  it('lists the accessible show only; the default skips an inaccessible active show', () => {
    const p = profileFixture();
    p.active_show_id = 'show-2';
    p.shows = [
      { ...p.shows[0] },
      { ...p.shows[1], can_access: false },
      { ...p.shows[0], id: 'show-3', name: 'Other Team', show_code: 'OT', studio_id: 'studio-2' },
    ];
    renderWithQueryClient(<BatchImportModal profile={p} onClose={() => {}} />);

    const trigger = screen.getByLabelText('Show');
    expect(trigger.textContent).toContain('Your Mom (YMH)');
    fireEvent.pointerDown(trigger, { pointerType: 'mouse', button: 0 });
    fireEvent.pointerUp(trigger, { pointerType: 'mouse', button: 0 });
    fireEvent.click(trigger);
    // One option, named for the accessible show (the ✓ indicator is aria-hidden).
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option', { name: 'Your Mom (YMH)' })).not.toBeNull();
  });
});
