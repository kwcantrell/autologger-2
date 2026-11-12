import { QueryClient } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch } from '../../../api/client';
import type {
  AutogenerateJob,
  ProfilePayload,
  ProvidersResponse,
  YoutubePlaylistResponse,
} from '../../../api/types';
import { renderWithQueryClient } from '../../../test/renderWithQueryClient';
import { startAutogenerateAfterImport } from '../batchImport/autogenerateAfterImport';
import type { RunPlaylistImportOptions } from '../batchImport/playlistRunner';
import { stitchAudioFiles } from '../batchImport/stitch';
import { BatchImportModal } from './BatchImportModal';

vi.mock('../../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/client')>();
  return { ...actual, apiFetch: vi.fn() };
});

// playlist-import-autogenerate task 4.1: the autogenerate tests replace the playlist runner; every
// other test keeps the real one.
const runner = vi.hoisted(() => ({
  impl: null as null | ((o: RunPlaylistImportOptions) => Promise<void>),
}));
vi.mock('../batchImport/playlistRunner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../batchImport/playlistRunner')>();
  return {
    ...actual,
    runPlaylistImport: vi.fn((o: RunPlaylistImportOptions) =>
      runner.impl ? runner.impl(o) : actual.runPlaylistImport(o),
    ),
  };
});
vi.mock('../batchImport/autogenerateAfterImport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../batchImport/autogenerateAfterImport')>();
  return { ...actual, startAutogenerateAfterImport: vi.fn(async () => []) };
});

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

// youtube-playlist-import task 8.4 (batch-audio-import "Batch Import modal layout and actions",
// "YouTube playlist selection", "YouTube playlist import run").
describe('BatchImportModal — YouTube playlist', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function playlist(title: string, ids: string[]): YoutubePlaylistResponse {
    return {
      playlist: { id: 'PLx', title, url: 'https://www.youtube.com/playlist?list=PLx' },
      entries: ids.map((id, i) => ({
        index: i + 1,
        video_id: id,
        url: `https://www.youtube.com/watch?v=${id}`,
        title: `${title} video ${i + 1}`,
        duration_s: 60,
        importable: true,
        reason: null,
      })),
      truncated: false,
    };
  }

  async function loadPlaylist(url: string) {
    fireEvent.click(screen.getByRole('button', { name: 'Import YouTube Playlist' }));
    const field = await screen.findByRole('textbox', { name: /YouTube playlist link/ });
    fireEvent.change(field, { target: { value: url } });
    fireEvent.click(screen.getByRole('button', { name: 'Load playlist' }));
  }

  const startButton = () =>
    screen.getByRole('button', { name: 'Start Import' }) as HTMLButtonElement;

  it('orders the controls Import Audio, Import YouTube Playlist, Import Logs, Start Import', () => {
    renderWithQueryClient(<BatchImportModal profile={profileFixture()} onClose={() => {}} />);
    const names = screen
      .getAllByRole('button')
      .map((b) => b.textContent)
      .filter((t) =>
        ['Import Audio', 'Import YouTube Playlist', 'Import Logs', 'Start Import'].includes(
          t ?? '',
        ),
      );
    expect(names).toEqual([
      'Import Audio',
      'Import YouTube Playlist',
      'Import Logs',
      'Start Import',
    ]);
  });

  it('asks for the link in the themed prompt, shows a loading state, then the playlist', async () => {
    let resolve: ((v: YoutubePlaylistResponse) => void) | undefined;
    mockedApiFetch.mockImplementation(async (path) => {
      if (path === 'youtube/playlist-entries') {
        return new Promise((r) => {
          resolve = r as (v: YoutubePlaylistResponse) => void;
        });
      }
      throw new Error(`unexpected ${path}`);
    });
    const prompt = vi.spyOn(window, 'prompt');
    renderWithQueryClient(<BatchImportModal profile={profileFixture()} onClose={() => {}} />);
    await loadPlaylist(' https://www.youtube.com/playlist?list=PLx ');
    expect(await screen.findByText('Loading playlist…')).not.toBeNull();
    expect(mockedApiFetch).toHaveBeenCalledWith(
      'youtube/playlist-entries',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ url: 'https://www.youtube.com/playlist?list=PLx' }),
      }),
    );
    resolve?.(playlist('First', ['aaaaaaaaaaa']));
    expect(await screen.findByText('First')).not.toBeNull();
    expect(screen.queryByText('Loading playlist…')).toBeNull();
    expect(prompt).not.toHaveBeenCalled();
    prompt.mockRestore();
  });

  it.each([
    [503, 'YouTube import is unavailable on this deployment.'],
    [400, "Mix and radio lists can't be imported; use a regular playlist link."],
  ])('a %i shows the server detail beneath the control and loads no playlist', async (status, detail) => {
    mockedApiFetch.mockImplementation(async (path) => {
      if (path === 'youtube/playlist-entries') throw new ApiError(status, detail, { detail });
      throw new Error(`unexpected ${path}`);
    });
    renderWithQueryClient(<BatchImportModal profile={profileFixture()} onClose={() => {}} />);
    await loadPlaylist('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ');
    const error = await screen.findByTestId('batch-import-playlist-error');
    expect(error.textContent).toBe(detail);
    expect(screen.queryByTestId('playlist-picker')).toBeNull();
    expect(startButton().disabled).toBe(true);
  });

  it('a second link replaces the first playlist; a failed load leaves none', async () => {
    const lists: Array<YoutubePlaylistResponse | Error> = [
      playlist('First', ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc']),
      playlist('Second', ['ddddddddddd']),
      new ApiError(502, 'Failed to list the playlist.', { detail: 'Failed to list the playlist.' }),
    ];
    mockedApiFetch.mockImplementation(async (path) => {
      if (path === 'youtube/playlist-entries') {
        const next = lists.shift();
        if (next instanceof Error) throw next;
        return next;
      }
      throw new Error(`unexpected ${path}`);
    });
    renderWithQueryClient(<BatchImportModal profile={profileFixture()} onClose={() => {}} />);
    await loadPlaylist('https://www.youtube.com/playlist?list=PL1');
    await screen.findByText('First');
    fireEvent.click(screen.getByRole('button', { name: 'Select none' }));
    expect(screen.getByTestId('playlist-selected-count').textContent).toBe('0 of 3 selected');

    await loadPlaylist('https://www.youtube.com/playlist?list=PL2');
    await screen.findByText('Second');
    expect(screen.queryByText('First')).toBeNull();
    expect(screen.queryByText('First video 2')).toBeNull();
    expect(screen.getByTestId('playlist-selected-count').textContent).toBe('1 of 1 selected');

    await loadPlaylist('https://www.youtube.com/playlist?list=PL3');
    expect((await screen.findByTestId('batch-import-playlist-error')).textContent).toBe(
      'Failed to list the playlist.',
    );
    expect(screen.queryByTestId('playlist-picker')).toBeNull();
  });

  it('a playlist alone enables Start Import; unchecking every entry disables it', async () => {
    mockedApiFetch.mockImplementation(async (path) => {
      if (path === 'youtube/playlist-entries')
        return playlist('First', ['aaaaaaaaaaa', 'bbbbbbbbbbb']);
      throw new Error(`unexpected ${path}`);
    });
    renderWithQueryClient(<BatchImportModal profile={profileFixture()} onClose={() => {}} />);
    expect(startButton().disabled).toBe(true);
    await loadPlaylist('https://www.youtube.com/playlist?list=PLx');
    await screen.findByText('First');
    await waitFor(() => expect(startButton().disabled).toBe(false));
    fireEvent.click(screen.getByRole('checkbox', { name: /^1\. / }));
    fireEvent.click(screen.getByRole('checkbox', { name: /^2\. / }));
    await waitFor(() => expect(startButton().disabled).toBe(true));
  });

  it('runs folder, then playlist, then logs, with the lines in that order', async () => {
    const sessions: Array<{ id: string; episode: string; title: string; show_id: string }> = [];
    const order: string[] = [];
    mockedApiFetch.mockImplementation(async (path, opts) => {
      const method = opts?.method ?? 'GET';
      if (path === 'youtube/playlist-entries') return playlist('First', ['aaaaaaaaaaa']);
      if (path === 'profile' && method === 'GET') return profileFixture();
      if (path === 'sessions' && method === 'GET') return { active: [...sessions], archived: [] };
      if (path === 'sessions' && method === 'POST') {
        const body = JSON.parse(String(opts?.body));
        const s = {
          id: `new-${sessions.length + 1}`,
          episode: body.episode,
          title: body.title,
          show_id: body.show_id,
        };
        sessions.push(s);
        return s;
      }
      if (path.includes('local-audio-import')) {
        order.push('folder');
        return { ok: true };
      }
      if (path.endsWith('/youtube-import')) {
        order.push('playlist');
        return { ok: true };
      }
      if (path === 'shows/show-1/log-import') {
        order.push('logs');
        return { job_id: 'job-1' };
      }
      if (path === 'log-import/job-1')
        return { status: 'completed', lines: ['matched 2 sheets'], error: null };
      throw new Error(`unexpected ${method} ${path}`);
    });
    mockedStitch.mockResolvedValue({
      blob: new Blob(['wav'], { type: 'audio/wav' }),
      durationS: 3,
      partDurationsS: [3],
    });
    renderWithQueryClient(<BatchImportModal profile={profileFixture()} onClose={() => {}} />);
    pickFolder(folderFile('YMH_001.mp3', 'Batch/YMH_001.mp3'));
    await loadPlaylist('https://www.youtube.com/playlist?list=PLx');
    await screen.findByText('First');
    await enterLogs('https://docs.google.com/spreadsheets/d/abc123/edit');
    await waitFor(() => expect(startButton().disabled).toBe(false));
    fireEvent.click(startButton());
    await screen.findByText('[logs] matched 2 sheets');
    expect(order).toEqual(['folder', 'playlist', 'logs']);
    const lines = Array.from(screen.getByTestId('batch-import-lines').querySelectorAll('li')).map(
      (li) => li.textContent,
    );
    expect(lines).toEqual([
      'Completed YMH_001',
      'Completed First video 1',
      '[logs] matched 2 sheets',
    ]);
  });

  async function enterLogs(url: string) {
    fireEvent.click(screen.getByRole('button', { name: 'Import Logs' }));
    const field = await screen.findByRole('textbox', { name: /Google Sheets URL/ });
    fireEvent.change(field, { target: { value: url } });
    fireEvent.click(screen.getByRole('button', { name: 'Use URL' }));
  }

  it('closing mid-run aborts the playlist run and a reopen is empty', async () => {
    let importSignal: AbortSignal | undefined;
    mockedApiFetch.mockImplementation(async (path, opts) => {
      const method = opts?.method ?? 'GET';
      if (path === 'youtube/playlist-entries')
        return playlist('First', ['aaaaaaaaaaa', 'bbbbbbbbbbb']);
      if (path === 'profile' && method === 'GET') return profileFixture();
      if (path === 'sessions' && method === 'GET') return { active: [], archived: [] };
      if (path === 'sessions' && method === 'POST') {
        return { id: 'new-1', episode: 'x', title: 'x', show_id: 'show-1' };
      }
      if (path.endsWith('/youtube-import')) {
        importSignal = opts?.signal ?? undefined;
        return new Promise((_, reject) => {
          opts?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        });
      }
      throw new Error(`unexpected ${method} ${path}`);
    });
    const onClose = vi.fn();
    const { unmount } = renderWithQueryClient(
      <BatchImportModal profile={profileFixture()} onClose={onClose} />,
    );
    await loadPlaylist('https://www.youtube.com/playlist?list=PLx');
    await screen.findByText('First');
    await waitFor(() => expect(startButton().disabled).toBe(false));
    fireEvent.click(startButton());
    await waitFor(() => expect(importSignal).toBeDefined());
    expect(screen.getByTestId('batch-import-current').textContent).toContain(
      'Importing First video 1 (video 1 of 2)...',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(importSignal?.aborted).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
    expect(
      mockedApiFetch.mock.calls.filter(([p]) => String(p).endsWith('/youtube-import')),
    ).toHaveLength(1);

    renderWithQueryClient(<BatchImportModal profile={profileFixture()} onClose={() => {}} />);
    expect(screen.getByTestId('batch-import-progress').textContent).toBe('');
    expect(screen.queryByTestId('playlist-picker')).toBeNull();
  });
});

// playlist-import-autogenerate task 4.1 (batch-audio-import "Batch Import modal layout and
// actions" and "YouTube playlist import can autogenerate afterwards"; design D3, D6, D7, D9-D13).
describe('BatchImportModal — Autogenerate after import', () => {
  const TEAM = 'studio-1';
  const PREVIEW = `teams/${TEAM}/autogenerate-jobs/preview`;
  const JOBS = `teams/${TEAM}/autogenerate-jobs`;
  const CHECKING = 'Checking your providers…';
  const RECHECK = 'Your providers are checked again when the import ends.';
  const LIVE_WARNING =
    'A batch job is already running for this team; autogenerate after this import will not start unless it has finished by then.';
  const mockedStart = vi.mocked(startAutogenerateAfterImport);

  type Role = 'owner' | 'admin' | 'member';
  function profileAs(role: Role | null, userId = 'me'): ProfilePayload {
    const p = profileFixture();
    if (role === null) return p;
    return {
      ...p,
      auth: {
        logged_in: true,
        oauth_configured: true,
        user: {
          id: userId,
          email: 'me@example.com',
          given_name: 'Ana',
          family_name: 'Diaz',
          picture_url: null,
          teams: [{ id: TEAM, name: 'Studio', role }],
        },
      },
    } as unknown as ProfilePayload;
  }

  function listing(n: number, title = 'First'): YoutubePlaylistResponse {
    return {
      playlist: { id: 'PLx', title, url: 'https://www.youtube.com/playlist?list=PLx' },
      entries: Array.from({ length: n }, (_, i) => ({
        index: i + 1,
        video_id: `v${String(i + 1).padStart(10, '0')}`,
        url: `https://www.youtube.com/watch?v=v${i + 1}`,
        title: `${title} video ${i + 1}`,
        duration_s: 60,
        importable: true,
        reason: null,
      })),
      truncated: false,
    };
  }

  const configured: ProvidersResponse = {
    llm: {
      kind: 'llm',
      provider: 'anthropic',
      base_url: null,
      model: 'm',
      key_last4: 'abcd',
      updated_at: '2026-11-11T00:00:00.000Z',
    },
    stt: {
      kind: 'stt',
      provider: 'deepgram',
      base_url: null,
      model: 'nova',
      key_last4: 'wxyz',
      updated_at: '2026-11-11T00:00:00.000Z',
    },
    run_features_allowed: true,
    claude_cli_allowed: false,
  };
  const job = (status: AutogenerateJob['status']) => ({ id: `j-${status}`, status });

  let listings: Array<YoutubePlaylistResponse | Error>;
  let previewImpl: (body: Record<string, unknown>) => Promise<unknown>;
  let jobsImpl: () => Promise<unknown>;
  let providersImpl: () => Promise<unknown>;
  let previewBodies: Array<Record<string, unknown>>;
  let order: string[];

  const clearPreview = (body: Record<string, unknown>) =>
    Promise.resolve({
      sessions: 3,
      steps: body.steps,
      runs: {},
      max_runs: 3 * (body.steps as string[]).length,
      blocked: null,
    });

  beforeEach(() => {
    vi.clearAllMocks();
    listings = [];
    previewBodies = [];
    order = [];
    previewImpl = clearPreview;
    jobsImpl = async () => ({ jobs: [] });
    providersImpl = async () => configured;
    runner.impl = async (o) => {
      order.push('playlist');
      o.onProgress({
        current: null,
        percent: 100,
        lines: [...(o.initialLines ?? []), 'Completed First video 1'],
      });
      o.onSessionImported?.('s-1');
    };
    mockedStart.mockImplementation(async () => {
      order.push('autogenerate');
      return [
        'Autogenerate started for 1 sessions (at most 4 runs); follow it in Settings → Batch autogenerate.',
      ];
    });
    mockedApiFetch.mockImplementation(async (path, opts) => {
      const method = opts?.method ?? 'GET';
      if (path === 'youtube/playlist-entries') {
        const next = listings.shift() ?? listing(2);
        if (next instanceof Error) throw next;
        return next;
      }
      if (path === PREVIEW && method === 'POST') {
        const body = JSON.parse(String(opts?.body));
        previewBodies.push(body);
        return previewImpl(body);
      }
      if (path === JOBS && method === 'GET') return jobsImpl();
      if (path === 'me/providers') return providersImpl();
      if (path === 'shows/show-1/log-import') {
        order.push('logs');
        return { job_id: 'job-1' };
      }
      if (path === 'log-import/job-1')
        return { status: 'completed', lines: ['matched 1 sheet'], error: null };
      throw new Error(`unexpected ${method} ${path}`);
    });
  });

  afterEach(() => {
    runner.impl = null;
  });

  async function loadPlaylist() {
    fireEvent.click(screen.getByRole('button', { name: 'Import YouTube Playlist' }));
    const field = await screen.findByRole('textbox', { name: /YouTube playlist link/ });
    fireEvent.change(field, { target: { value: 'https://www.youtube.com/playlist?list=PLx' } });
    fireEvent.click(screen.getByRole('button', { name: 'Load playlist' }));
    await screen.findByTestId('playlist-picker');
  }

  async function enterLogs() {
    fireEvent.click(screen.getByRole('button', { name: 'Import Logs' }));
    const field = await screen.findByRole('textbox', { name: /Google Sheets URL/ });
    fireEvent.change(field, {
      target: { value: 'https://docs.google.com/spreadsheets/d/abc123/edit' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Use URL' }));
    await screen.findByTestId('batch-import-logs-url');
  }

  const autogenerateBox = () =>
    screen.queryByRole('checkbox', { name: 'Autogenerate after import' });
  const startButton = () =>
    screen.getByRole('button', { name: /Start Import|Importing…/ }) as HTMLButtonElement;
  const note = () => screen.queryByTestId('batch-import-autogenerate-note')?.textContent ?? null;
  const tick = (name: string) => fireEvent.click(screen.getByRole('checkbox', { name }));
  const stepChecked = (name: string) =>
    within(screen.getByTestId('batch-import-autogenerate'))
      .getByRole('checkbox', { name })
      .getAttribute('aria-checked');
  const jobListCalls = () =>
    mockedApiFetch.mock.calls.filter(([p, o]) => p === JOBS && (o?.method ?? 'GET') === 'GET');
  const autogenerateCalls = () =>
    mockedApiFetch.mock.calls.filter(([p]) => String(p).includes('autogenerate-jobs'));
  const WAIT = { timeout: 3000 };

  async function armed(role: Role = 'owner', client?: QueryClient, onClose = () => {}) {
    const utils = renderWithQueryClient(
      <BatchImportModal profile={profileAs(role)} onClose={onClose} />,
      client,
    );
    await loadPlaylist();
    tick('Autogenerate after import');
    await waitFor(() => expect(startButton().disabled).toBe(false), WAIT);
    return utils;
  }

  async function confirmDialog() {
    return screen.findByRole('alertdialog');
  }

  describe('visibility (design D7)', () => {
    it('absent with no playlist loaded', () => {
      renderWithQueryClient(<BatchImportModal profile={profileAs('owner')} onClose={() => {}} />);
      expect(autogenerateBox()).toBeNull();
    });

    it('absent for a member, and a member run sends no autogenerate request', async () => {
      renderWithQueryClient(<BatchImportModal profile={profileAs('member')} onClose={() => {}} />);
      await loadPlaylist();
      expect(autogenerateBox()).toBeNull();
      await waitFor(() => expect(startButton().disabled).toBe(false));
      fireEvent.click(startButton());
      await screen.findByText('Completed First video 1');
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(autogenerateCalls()).toEqual([]);
      expect(mockedStart).not.toHaveBeenCalled();
    });

    it.each(['owner', 'admin'] as const)('present and unticked for an %s', async (role) => {
      renderWithQueryClient(<BatchImportModal profile={profileAs(role)} onClose={() => {}} />);
      await loadPlaylist();
      expect(autogenerateBox()?.getAttribute('aria-checked')).toBe('false');
      expect(screen.queryByRole('group', { name: 'Steps' })).toBeNull();
    });
  });

  describe('options and arming (design D11)', () => {
    it('ticking shows all four steps and the accept mode', async () => {
      await armed();
      for (const name of ['Transcripts', 'Log events', 'Topics', 'Wiki']) {
        expect(stepChecked(name)).toBe('true');
      }
      expect(
        screen
          .getByRole('radio', { name: 'Add new pages and additions to the wiki' })
          .getAttribute('aria-checked'),
      ).toBe('true');
    });

    it('every control of the group is disabled during a run', async () => {
      runner.impl = (o) =>
        new Promise((_, reject) =>
          o.signal.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          ),
        );
      await armed();
      fireEvent.click(startButton());
      fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
      await waitFor(() => expect(startButton().textContent).toBe('Importing…'));
      const group = screen.getByTestId('batch-import-autogenerate');
      for (const box of within(group).getAllByRole('checkbox')) {
        expect((box as HTMLButtonElement).disabled).toBe(true);
      }
      for (const r of within(group).getAllByRole('radio')) {
        expect((r as HTMLButtonElement).disabled).toBe(true);
      }
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    });

    it('reopening the modal resets the box and the steps', async () => {
      const { unmount } = await armed();
      tick('Topics');
      unmount();
      renderWithQueryClient(<BatchImportModal profile={profileAs('owner')} onClose={() => {}} />);
      await loadPlaylist();
      expect(autogenerateBox()?.getAttribute('aria-checked')).toBe('false');
      tick('Autogenerate after import');
      expect(stepChecked('Topics')).toBe('true');
    });

    it('loading another link unticks the box and resets the steps', async () => {
      listings = [listing(2), listing(1, 'Second')];
      await armed();
      tick('Topics');
      await loadPlaylist();
      await screen.findByText('Second');
      expect(autogenerateBox()?.getAttribute('aria-checked')).toBe('false');
      tick('Autogenerate after import');
      expect(stepChecked('Topics')).toBe('true');
    });

    it('a failed listing hides the group and unticks the box', async () => {
      listings = [
        listing(2),
        new ApiError(502, 'Failed to list the playlist.', {
          detail: 'Failed to list the playlist.',
        }),
        listing(2),
      ];
      await armed();
      fireEvent.click(screen.getByRole('button', { name: 'Import YouTube Playlist' }));
      const field = await screen.findByRole('textbox', { name: /YouTube playlist link/ });
      fireEvent.change(field, { target: { value: 'https://www.youtube.com/playlist?list=PL2' } });
      fireEvent.click(screen.getByRole('button', { name: 'Load playlist' }));
      await screen.findByTestId('batch-import-playlist-error');
      expect(autogenerateBox()).toBeNull();
      await loadPlaylist();
      expect(autogenerateBox()?.getAttribute('aria-checked')).toBe('false');
    });

    it('a ticked box with every entry unchecked does not narrow Start Import: folder only, no confirm, no preview', async () => {
      mockedApiFetch.mockImplementation(async (path, opts) => {
        const method = opts?.method ?? 'GET';
        if (path === 'youtube/playlist-entries') return listing(2);
        if (path === 'sessions')
          return {
            active: [{ id: 's1', episode: 'YMH_001', title: 'YMH_001', show_id: 'show-1' }],
            archived: [],
          };
        if (path === PREVIEW) previewBodies.push({ path });
        if (path === JOBS) return { jobs: [] };
        throw new Error(`unexpected ${method} ${path}`);
      });
      renderWithQueryClient(<BatchImportModal profile={profileAs('owner')} onClose={() => {}} />);
      pickFolder(folderFile('YMH_001.mp3', 'Batch/YMH_001.mp3'));
      await loadPlaylist();
      tick('Autogenerate after import');
      for (const name of ['Transcripts', 'Log events', 'Topics', 'Wiki']) tick(name);
      fireEvent.click(screen.getByRole('button', { name: 'Select none' }));
      await waitFor(() => expect(startButton().disabled).toBe(false));
      expect(note()).toBeNull();
      fireEvent.click(startButton());
      await screen.findByText('Skipped YMH_001 (already in system)');
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(previewBodies).toEqual([]);
      expect(mockedStart).not.toHaveBeenCalled();
    });
  });

  describe('up-front check (design D6)', () => {
    it('sends the preview for the show only while armed, debounced; pending disables Start Import', async () => {
      let resolve: ((v: unknown) => void) | undefined;
      previewImpl = () =>
        new Promise((r) => {
          resolve = r;
        });
      renderWithQueryClient(<BatchImportModal profile={profileAs('owner')} onClose={() => {}} />);
      await loadPlaylist();
      await new Promise((r) => setTimeout(r, 500));
      expect(previewBodies).toEqual([]);
      tick('Autogenerate after import');
      expect(startButton().disabled).toBe(true);
      expect(note()).toBe(CHECKING);
      expect(previewBodies).toEqual([]); // debounced: not sent on the tick itself
      await waitFor(() => expect(previewBodies).toHaveLength(1), WAIT);
      expect(previewBodies[0]).toEqual({
        show_ids: ['show-1'],
        steps: ['transcript', 'events', 'topics', 'wiki'],
        wiki_mode: 'accept',
      });
      expect(startButton().disabled).toBe(true);
      await act(async () =>
        resolve?.({ sessions: 2, steps: [], runs: {}, max_runs: 8, blocked: null }),
      );
      await waitFor(() => expect(startButton().disabled).toBe(false));
      expect(note()).toBeNull();
    });

    it('after a step change the previous answer is not used until the new one arrives', async () => {
      const pending: Array<(v: unknown) => void> = [];
      previewImpl = (body) =>
        (body.steps as string[]).includes('transcript')
          ? new Promise((r) => pending.push(r))
          : clearPreview(body);
      renderWithQueryClient(<BatchImportModal profile={profileAs('owner')} onClose={() => {}} />);
      await loadPlaylist();
      tick('Autogenerate after import');
      tick('Transcripts');
      tick('Log events');
      tick('Wiki');
      await waitFor(() => expect(startButton().disabled).toBe(false), WAIT);
      tick('Transcripts');
      expect(startButton().disabled).toBe(true);
      expect(note()).toBe(CHECKING);
      await waitFor(() => expect(pending).toHaveLength(1), WAIT);
      expect(startButton().disabled).toBe(true);
      expect(note()).toBe(CHECKING);
      await act(async () =>
        pending[0]({ sessions: 2, steps: [], runs: {}, max_runs: 4, blocked: null }),
      );
      await waitFor(() => expect(startButton().disabled).toBe(false));
    });

    it('a 200 blocked answer shows its text and disables Start Import; unticking re-enables it', async () => {
      previewImpl = async (body) => ({
        ...((await clearPreview(body)) as object),
        blocked: 'unconfigured-llm',
      });
      renderWithQueryClient(<BatchImportModal profile={profileAs('owner')} onClose={() => {}} />);
      await loadPlaylist();
      tick('Autogenerate after import');
      await waitFor(
        () => expect(note()).toBe('Add a language model in Settings → Advanced to autogenerate.'),
        WAIT,
      );
      expect(startButton().disabled).toBe(true);
      tick('Autogenerate after import');
      await waitFor(() => expect(startButton().disabled).toBe(false));
      expect(note()).toBeNull();
    });

    it('a 400 preview (empty show) with no stt only warns, with Start Import enabled', async () => {
      previewImpl = async () => {
        throw new ApiError(400, 'No sessions to process.', { detail: 'No sessions to process.' });
      };
      providersImpl = async () => ({ ...configured, stt: null });
      renderWithQueryClient(<BatchImportModal profile={profileAs('owner')} onClose={() => {}} />);
      await loadPlaylist();
      tick('Autogenerate after import');
      await waitFor(
        () =>
          expect(note()).toBe(
            `Add a speech-to-text key in Settings → Advanced to generate transcripts. ${RECHECK}`,
          ),
        WAIT,
      );
      expect(startButton().disabled).toBe(false);
    });

    it('a 400 preview for a configured user shows no warning', async () => {
      previewImpl = async () => {
        throw new ApiError(400, 'No sessions to process.', { detail: 'No sessions to process.' });
      };
      renderWithQueryClient(<BatchImportModal profile={profileAs('owner')} onClose={() => {}} />);
      await loadPlaylist();
      tick('Autogenerate after import');
      await waitFor(
        () => expect(mockedApiFetch.mock.calls.some(([p]) => p === 'me/providers')).toBe(true),
        WAIT,
      );
      await waitFor(() => expect(startButton().disabled).toBe(false));
      expect(note()).toBeNull();
    });

    it('both reads failing show nothing and leave Start Import enabled', async () => {
      previewImpl = async () => {
        throw new TypeError('Failed to fetch');
      };
      providersImpl = async () => {
        throw new TypeError('Failed to fetch');
      };
      renderWithQueryClient(<BatchImportModal profile={profileAs('owner')} onClose={() => {}} />);
      await loadPlaylist();
      tick('Autogenerate after import');
      await waitFor(() => expect(startButton().disabled).toBe(false), WAIT);
      await waitFor(() =>
        expect(mockedApiFetch.mock.calls.some(([p]) => p === 'me/providers')).toBe(true),
      );
      expect(note()).toBeNull();
    });

    it('no step ticked disables Start Import with "Pick at least one step."; a step or unticking re-enables it', async () => {
      await armed();
      for (const name of ['Transcripts', 'Log events', 'Topics', 'Wiki']) tick(name);
      expect(startButton().disabled).toBe(true);
      expect(note()).toBe('Pick at least one step.');
      tick('Topics');
      await waitFor(() => expect(startButton().disabled).toBe(false), WAIT);
      for (const name of ['Topics']) tick(name);
      expect(startButton().disabled).toBe(true);
      tick('Autogenerate after import');
      expect(startButton().disabled).toBe(false);
    });

    it('more than 1000 checked entries disable Start Import with the cap text', async () => {
      listings = [listing(1001)];
      renderWithQueryClient(<BatchImportModal profile={profileAs('owner')} onClose={() => {}} />);
      await loadPlaylist();
      tick('Autogenerate after import');
      await waitFor(() =>
        expect(note()).toBe(
          'Autogenerate after import covers at most 1000 videos; check fewer videos or untick it.',
        ),
      );
      expect(startButton().disabled).toBe(true);
      fireEvent.click(screen.getByRole('checkbox', { name: /^1001\. / }));
      await waitFor(() => expect(startButton().disabled).toBe(false), WAIT);
    });

    it('"A playlist alone enables Start Import" still holds with the box unticked', async () => {
      renderWithQueryClient(<BatchImportModal profile={profileAs('owner')} onClose={() => {}} />);
      await loadPlaylist();
      await waitFor(() => expect(startButton().disabled).toBe(false));
      expect(previewBodies).toEqual([]);
    });
  });

  describe('confirm (design D9, D10)', () => {
    it('a block that arrives while the confirm is open stops the run', async () => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      await armed('owner', client);
      fireEvent.click(startButton());
      await confirmDialog();
      previewImpl = async (body) => ({
        ...((await clearPreview(body)) as object),
        blocked: 'not-approved',
      });
      await act(async () => {
        await client.invalidateQueries({ queryKey: ['autogenerate-jobs', TEAM, 'preview'] });
      });
      await waitFor(() =>
        expect(note()).toBe(
          'Batch autogenerate is limited to approved users on this server. Ask the operator for approval.',
        ),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Start' }));
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      expect(
        vi.mocked((await import('../batchImport/playlistRunner')).runPlaylistImport),
      ).not.toHaveBeenCalled();
      expect(startButton().disabled).toBe(true);
      expect(mockedStart).not.toHaveBeenCalled();
    });

    it('shows the estimate and the re-check sentence; dismissing imports nothing', async () => {
      listings = [listing(12)];
      renderWithQueryClient(<BatchImportModal profile={profileAs('admin')} onClose={() => {}} />);
      await loadPlaylist();
      tick('Autogenerate after import');
      tick('Log events');
      tick('Wiki');
      await waitFor(() => expect(startButton().disabled).toBe(false), WAIT);
      fireEvent.click(startButton());
      const dialog = await confirmDialog();
      expect(dialog.textContent).toContain(
        'Import 12 videos, then autogenerate on up to 12 sessions, at most 24 runs.',
      );
      expect(dialog.textContent).toContain('Only videos this import brings in are included.');
      expect(dialog.textContent).toContain('The work runs on your own provider accounts.');
      expect(dialog.textContent).toContain(RECHECK);
      expect(dialog.textContent).not.toContain(LIVE_WARNING);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      const { runPlaylistImport } = await import('../batchImport/playlistRunner');
      expect(vi.mocked(runPlaylistImport)).not.toHaveBeenCalled();
      expect(mockedStart).not.toHaveBeenCalled();
    });

    it('the wiki auto-accept warning is in the confirm only in accept mode with Wiki ticked', async () => {
      await armed();
      fireEvent.click(startButton());
      expect((await confirmDialog()).textContent).toContain('without review');
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      fireEvent.click(screen.getByRole('radio', { name: 'Leave all as suggestions to review' }));
      await waitFor(() => expect(startButton().disabled).toBe(false), WAIT);
      fireEvent.click(startButton());
      expect((await confirmDialog()).textContent).not.toContain('without review');
    });

    it('unticked: no confirm and no job-list request', async () => {
      renderWithQueryClient(<BatchImportModal profile={profileAs('owner')} onClose={() => {}} />);
      await loadPlaylist();
      await waitFor(() => expect(startButton().disabled).toBe(false));
      fireEvent.click(startButton());
      await screen.findByText('Completed First video 1');
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(jobListCalls()).toEqual([]);
      expect(mockedStart).not.toHaveBeenCalled();
    });

    it.each([
      'running',
      'queued',
    ] as const)('a %s job puts the live-job warning first; Start stays enabled and runs the import', async (status) => {
      jobsImpl = async () => ({ jobs: [job('finished'), job(status)] });
      await armed();
      const before = jobListCalls().length;
      fireEvent.click(startButton());
      const dialog = await confirmDialog();
      expect(jobListCalls().length).toBeGreaterThan(before);
      // First in the confirm's message, before the estimate.
      const message = within(dialog).getByText(LIVE_WARNING).parentElement;
      expect(message?.firstElementChild?.textContent).toBe(LIVE_WARNING);
      expect(message?.textContent?.indexOf('Import 2 videos')).toBeGreaterThan(0);
      const start = within(dialog).getByRole('button', { name: 'Start' }) as HTMLButtonElement;
      expect(start.disabled).toBe(false);
      fireEvent.click(start);
      await screen.findByText('Completed First video 1');
    });

    it.each([
      [
        'only ended jobs',
        async () => ({ jobs: [job('finished'), job('cancelled'), job('failed')] }),
      ],
      ['a 500', async () => Promise.reject(new ApiError(500, 'Internal error', { detail: 'x' }))],
      ['a network error', async () => Promise.reject(new TypeError('Failed to fetch'))],
    ])('%s: the confirm opens without the warning', async (_label, impl) => {
      await armed();
      jobsImpl = impl;
      fireEvent.click(startButton());
      const dialog = await confirmDialog();
      expect(dialog.textContent).not.toContain(LIVE_WARNING);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Start' }));
      await screen.findByText('Completed First video 1');
    });
  });

  describe('dialog during a run (design D13)', () => {
    function hangingRun() {
      let signal: AbortSignal | undefined;
      runner.impl = (o) => {
        signal = o.signal;
        return new Promise((_, reject) =>
          o.signal.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          ),
        );
      };
      return () => signal;
    }

    it('Escape and a pointer-down outside leave the modal open and the run going; Close aborts', async () => {
      const signal = hangingRun();
      const onClose = vi.fn();
      renderWithQueryClient(<BatchImportModal profile={profileAs('owner')} onClose={onClose} />);
      await loadPlaylist();
      fireEvent.click(startButton());
      await waitFor(() => expect(signal()).toBeDefined());
      fireEvent.keyDown(screen.getByRole('dialog', { name: 'Batch Import' }), { key: 'Escape' });
      fireEvent.pointerDown(document.body);
      expect(onClose).not.toHaveBeenCalled();
      expect(signal()?.aborted).toBe(false);
      expect(screen.getByRole('dialog', { name: 'Batch Import' })).not.toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      expect(signal()?.aborted).toBe(true);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('with no run in progress, Escape still closes', () => {
      const onClose = vi.fn();
      renderWithQueryClient(<BatchImportModal profile={profileAs('owner')} onClose={onClose} />);
      fireEvent.keyDown(screen.getByRole('dialog', { name: 'Batch Import' }), { key: 'Escape' });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('closing mid-run sends no autogenerate request', async () => {
      const signal = hangingRun();
      await armed();
      fireEvent.click(startButton());
      fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
      await waitFor(() => expect(signal()).toBeDefined());
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(mockedStart).not.toHaveBeenCalled();
    });
  });

  describe('end-of-run start (design D3, D5, D12)', () => {
    it('starts once after the log part with the reported ids, the team, the confirmed steps and mode and user, and appends its line', async () => {
      runner.impl = async (o) => {
        order.push('playlist');
        o.onProgress({
          current: null,
          percent: 100,
          lines: [...(o.initialLines ?? []), 'Completed First video 1', 'Completed First video 2'],
        });
        o.onSessionImported?.('s-1');
        o.onSessionImported?.('retried-from-earlier-run');
      };
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const invalidate = vi.spyOn(client, 'invalidateQueries');
      renderWithQueryClient(
        <BatchImportModal profile={profileAs('owner')} onClose={() => {}} />,
        client,
      );
      await loadPlaylist();
      await enterLogs();
      tick('Autogenerate after import');
      tick('Log events');
      fireEvent.click(screen.getByRole('radio', { name: 'Leave all as suggestions to review' }));
      await waitFor(() => expect(startButton().disabled).toBe(false), WAIT);
      fireEvent.click(startButton());
      fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
      await screen.findByText(/^Autogenerate started for 1 sessions/);
      expect(order).toEqual(['playlist', 'logs', 'autogenerate']);
      expect(mockedStart).toHaveBeenCalledTimes(1);
      const call = mockedStart.mock.calls[0][0];
      expect(call).toMatchObject({
        teamId: TEAM,
        sessionIds: ['s-1', 'retried-from-earlier-run'],
        steps: ['transcript', 'topics', 'wiki'],
        wikiMode: 'pending',
        confirmedUserId: 'me',
      });
      const lines = Array.from(screen.getByTestId('batch-import-lines').querySelectorAll('li')).map(
        (li) => li.textContent,
      );
      expect(lines).toEqual([
        'Completed First video 1',
        'Completed First video 2',
        '[logs] matched 1 sheet',
        'Autogenerate started for 1 sessions (at most 4 runs); follow it in Settings → Batch autogenerate.',
      ]);
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['autogenerate-jobs', TEAM] });
      expect(startButton().textContent).toBe('Start Import');
    });

    it("the injected reads go through the run's profile and show sessions", async () => {
      await armed();
      fireEvent.click(startButton());
      fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
      await waitFor(() => expect(mockedStart).toHaveBeenCalledTimes(1));
      mockedApiFetch.mockImplementation(async (path) => {
        if (path === 'profile') return profileAs('owner', 'someone');
        if (path === 'sessions')
          return {
            active: [
              { id: 's-1', show_id: 'show-1', title: 'a', episode: 'a' },
              { id: 'x', show_id: 'show-2', title: 'b', episode: 'b' },
            ],
            archived: [],
          };
        throw new Error(`unexpected ${path}`);
      });
      const { readProfile, listShowSessionIds } = mockedStart.mock.calls[0][0];
      const signal = new AbortController().signal;
      expect((await readProfile(signal)).auth.user?.id).toBe('someone');
      expect(await listShowSessionIds(signal)).toEqual(['s-1']);
    });

    it('a part ending with a Failed line still starts it, with the ids reported before the failure', async () => {
      runner.impl = async (o) => {
        o.onProgress({ current: null, percent: 50, lines: ['Completed First video 1'] });
        o.onSessionImported?.('s-1');
        throw new Error('boom');
      };
      await armed();
      fireEvent.click(startButton());
      fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
      await screen.findByText(/^Autogenerate started/);
      expect(mockedStart.mock.calls[0][0].sessionIds).toEqual(['s-1']);
      const lines = Array.from(screen.getByTestId('batch-import-lines').querySelectorAll('li')).map(
        (li) => li.textContent,
      );
      expect(lines.slice(0, 2)).toEqual(['Completed First video 1', 'Failed: boom']);
    });

    it('a not-started line does not refresh the job list', async () => {
      mockedStart.mockResolvedValue([
        'Autogenerate not started: no video was imported by this import.',
      ]);
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const invalidate = vi.spyOn(client, 'invalidateQueries');
      await armed('owner', client);
      fireEvent.click(startButton());
      fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
      await screen.findByText('Autogenerate not started: no video was imported by this import.');
      expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['autogenerate-jobs', TEAM] });
    });
  });
});
