import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../../../api/client';
import type { ProfilePayload, Session, SessionsResponse } from '../../../api/types';
import {
  findMatchingSession,
  formatSkippedLine,
  runBatchImport,
  sessionMatchesStem,
} from './runner';
import { stitchAudioFiles } from './stitch';

vi.mock('../../../api/client', () => ({
  apiFetch: vi.fn(),
}));

vi.mock('./stitch', () => ({
  stitchAudioFiles: vi.fn(),
}));

const mockedApiFetch = vi.mocked(apiFetch);
const mockedStitch = vi.mocked(stitchAudioFiles);

function profileFixture(overrides: Partial<ProfilePayload> = {}): ProfilePayload {
  return {
    active_studio_id: 'studio-1',
    active_show_id: 'show-1',
    shows: [
      {
        id: 'show-1',
        name: 'Your Mom',
        show_code: 'YMH',
        title_suffix: 'episode',
        studio_id: 'studio-1',
      },
    ],
    new_session_defaults: { default_frame_rate: 24, title_prefix: '' },
    ...overrides,
  } as unknown as ProfilePayload;
}

function session(id: string, stem: string): Session {
  return {
    id,
    title: stem,
    episode: stem,
    show_id: 'show-1',
  } as Session;
}

function fileNamed(name: string): File {
  return new File(['audio'], name, { type: 'audio/mpeg' });
}

function filesFrom(...names: string[]): File[] {
  return names.map((name) => fileNamed(name));
}

function mockSessionsResponse(sessions: Session[]): SessionsResponse {
  return { active: sessions, archived: [] };
}

describe('sessionMatchesStem', () => {
  it('matches episode or title', () => {
    expect(sessionMatchesStem(session('s1', 'YMH_001'), 'YMH_001')).toBe(true);
    expect(
      sessionMatchesStem({ ...session('s1', 'other'), episode: 'YMH_001' } as Session, 'YMH_001'),
    ).toBe(true);
    expect(sessionMatchesStem(session('s1', 'other'), 'YMH_001')).toBe(false);
  });
});

describe('findMatchingSession', () => {
  it('returns the first matching session', () => {
    const sessions = [session('a', 'one'), session('b', 'YMH_001')];
    expect(findMatchingSession(sessions, 'YMH_001')?.id).toBe('b');
  });
});

describe('runBatchImport', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('skips groups whose stem already exists in sessions', async () => {
    mockedApiFetch.mockImplementation(async (path) => {
      if (path === 'sessions') return mockSessionsResponse([session('existing', 'YMH_001')]);
      throw new Error(`unexpected ${path}`);
    });

    const lines: string[] = [];
    await runBatchImport({
      showId: 'show-1',
      files: filesFrom('YMH_001.mp3'),
      profile: profileFixture(),
      signal: new AbortController().signal,
      onProgress: (s) => {
        lines.push(...s.lines);
      },
    });

    expect(lines).toContain(formatSkippedLine('YMH_001'));
    expect(mockedStitch).not.toHaveBeenCalled();
    expect(mockedApiFetch).not.toHaveBeenCalledWith(
      expect.stringContaining('local-audio-import'),
      expect.anything(),
    );
  });

  it('creates a session, stitches, and uploads on the success path', async () => {
    mockedApiFetch.mockImplementation(async (path, opts) => {
      if (path === 'sessions' && (!opts || opts.method === undefined)) {
        return mockSessionsResponse([]);
      }
      if (path === 'sessions' && opts?.method === 'POST') {
        return { id: 'new-session', episode: 'YMH_002', title: 'YMH_002' };
      }
      if (path.includes('local-audio-import')) {
        return { ok: true };
      }
      throw new Error(`unexpected ${path}`);
    });

    mockedStitch.mockResolvedValue({
      blob: new Blob(['wav'], { type: 'audio/wav' }),
      durationS: 12.5,
      partDurationsS: [12.5],
    });

    const created: string[] = [];
    const lines: string[] = [];
    await runBatchImport({
      showId: 'show-1',
      files: filesFrom('YMH_002.mp3'),
      profile: profileFixture(),
      signal: new AbortController().signal,
      onProgress: (s) => {
        lines.push(...s.lines);
      },
      onSessionCreated: () => created.push('yes'),
    });

    expect(created).toHaveLength(1);
    expect(mockedStitch).toHaveBeenCalledTimes(1);
    expect(mockedApiFetch).toHaveBeenCalledWith(
      expect.stringContaining('sessions/new-session/local-audio-import?duration_s=12.5'),
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'audio/wav',
          'X-Audio-Seam-Parts': JSON.stringify([{ duration_s: 12.5 }]),
        },
      }),
    );
    expect(lines).toContain('Completed YMH_002');
  });

  it('PUTs profile when selected show differs from active show', async () => {
    mockedApiFetch.mockImplementation(async (path, opts) => {
      if (path === 'profile' && opts?.method === 'PUT') return {};
      if (path === 'sessions' && opts?.method === 'POST') {
        return { id: 'new-session', episode: 'EP1', title: 'EP1' };
      }
      if (path === 'sessions') return mockSessionsResponse([]);
      if (path.includes('local-audio-import')) return { ok: true };
      throw new Error(`unexpected ${path}`);
    });
    mockedStitch.mockResolvedValue({
      blob: new Blob(['wav'], { type: 'audio/wav' }),
      durationS: 1,
      partDurationsS: [1],
    });

    await runBatchImport({
      showId: 'show-2',
      files: filesFrom('EP1.mp3'),
      profile: profileFixture({ active_show_id: 'show-1' }),
      signal: new AbortController().signal,
      onProgress: () => {},
    });

    expect(mockedApiFetch).toHaveBeenCalledWith(
      'profile',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ active_studio_id: 'studio-1', active_show_id: 'show-2' }),
      }),
    );
    // The created session's real id must flow into the upload path (guards
    // against the POST branch being shadowed by the plain sessions GET branch).
    expect(mockedApiFetch).toHaveBeenCalledWith(
      expect.stringContaining('sessions/new-session/local-audio-import'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('stops processing further groups when aborted', async () => {
    let sessionsCall = 0;
    mockedApiFetch.mockImplementation(async (path) => {
      if (path === 'sessions') {
        sessionsCall += 1;
        return mockSessionsResponse([]);
      }
      throw new Error(`unexpected ${path}`);
    });

    const controller = new AbortController();
    const progressEvents: number[] = [];

    const runPromise = runBatchImport({
      showId: 'show-1',
      files: filesFrom('A.mp3', 'B.mp3', 'C.mp3'),
      profile: profileFixture(),
      signal: controller.signal,
      onProgress: () => {
        progressEvents.push(progressEvents.length);
        if (progressEvents.length === 1) controller.abort();
      },
    });

    await expect(runPromise).rejects.toMatchObject({ name: 'AbortError' });
    expect(sessionsCall).toBe(1);
    expect(mockedStitch).not.toHaveBeenCalled();
  });

  it('does not create a session when stitch fails', async () => {
    mockedApiFetch.mockImplementation(async (path, opts) => {
      if (path === 'sessions' && (!opts || opts.method === undefined)) {
        return mockSessionsResponse([]);
      }
      throw new Error(`unexpected ${path}`);
    });
    mockedStitch.mockRejectedValue(new Error('decode failed'));

    const lines: string[] = [];
    await runBatchImport({
      showId: 'show-1',
      files: filesFrom('YMH_001.mp3'),
      profile: profileFixture(),
      signal: new AbortController().signal,
      onProgress: (s) => {
        lines.push(...s.lines);
      },
    });

    expect(lines).toContain('Failed YMH_001: decode failed');
    expect(mockedApiFetch).not.toHaveBeenCalledWith(
      'sessions',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('deletes the session when import fails', async () => {
    const deleteCalls: string[] = [];
    mockedApiFetch.mockImplementation(async (path, opts) => {
      if (path === 'sessions' && (!opts || opts.method === undefined)) {
        return mockSessionsResponse([]);
      }
      if (path === 'sessions' && opts?.method === 'POST') {
        return { id: 'new-session', episode: 'YMH_003', title: 'YMH_003' };
      }
      if (path === 'sessions/new-session' && opts?.method === 'DELETE') {
        deleteCalls.push('deleted');
        return { ok: true };
      }
      if (path.includes('local-audio-import')) {
        throw new Error('upload failed');
      }
      throw new Error(`unexpected ${path}`);
    });
    mockedStitch.mockResolvedValue({
      blob: new Blob(['wav'], { type: 'audio/wav' }),
      durationS: 3,
      partDurationsS: [3],
    });

    const lines: string[] = [];
    await runBatchImport({
      showId: 'show-1',
      files: filesFrom('YMH_003.mp3'),
      profile: profileFixture(),
      signal: new AbortController().signal,
      onProgress: (s) => {
        lines.push(...s.lines);
      },
    });

    expect(deleteCalls).toHaveLength(1);
    expect(lines).toContain('Failed YMH_003: upload failed');
  });

  it('rolls back the created session when aborted mid-upload, then stops the run', async () => {
    const controller = new AbortController();
    const deleteOpts: Array<{ signal?: AbortSignal }> = [];
    mockedApiFetch.mockImplementation(async (path, opts) => {
      if (path === 'sessions' && (!opts || opts.method === undefined)) {
        return mockSessionsResponse([]);
      }
      if (path === 'sessions' && opts?.method === 'POST') {
        return { id: 'new-session', episode: 'A', title: 'A' };
      }
      if (path === 'sessions/new-session' && opts?.method === 'DELETE') {
        deleteOpts.push((opts ?? {}) as { signal?: AbortSignal });
        return { ok: true };
      }
      if (path.includes('local-audio-import')) {
        // Simulate the user closing the modal while the upload is in flight.
        controller.abort();
        throw new DOMException('Aborted', 'AbortError');
      }
      throw new Error(`unexpected ${path}`);
    });
    mockedStitch.mockResolvedValue({
      blob: new Blob(['wav'], { type: 'audio/wav' }),
      durationS: 2,
      partDurationsS: [2],
    });

    const runPromise = runBatchImport({
      showId: 'show-1',
      files: filesFrom('A.mp3', 'B.mp3'),
      profile: profileFixture(),
      signal: controller.signal,
      onProgress: () => {},
    });

    await expect(runPromise).rejects.toMatchObject({ name: 'AbortError' });
    // The ghost session must be rolled back even though the failure IS an abort...
    expect(deleteOpts).toHaveLength(1);
    // ...and the rollback fetch must not carry the already-aborted signal.
    expect(deleteOpts[0].signal?.aborted).not.toBe(true);
    // The run stops: group B is never stitched.
    expect(mockedStitch).toHaveBeenCalledTimes(1);
  });

  it('uploads a typeless single file with the MIME inferred from its full name', async () => {
    mockedApiFetch.mockImplementation(async (path, opts) => {
      if (path === 'sessions' && (!opts || opts.method === undefined)) {
        return mockSessionsResponse([]);
      }
      if (path === 'sessions' && opts?.method === 'POST') {
        return { id: 'new-session', episode: 'x', title: 'x' };
      }
      if (path.includes('local-audio-import')) return { ok: true };
      throw new Error(`unexpected ${path}`);
    });
    // Single-file pass-through: stitch hands back the original typeless File.
    const typeless = new File(['audio'], 'x.mp3', { type: '' });
    mockedStitch.mockResolvedValue({ blob: typeless, durationS: 2, partDurationsS: [2] });

    await runBatchImport({
      showId: 'show-1',
      files: [typeless],
      profile: profileFixture(),
      signal: new AbortController().signal,
      onProgress: () => {},
    });

    expect(mockedApiFetch).toHaveBeenCalledWith(
      expect.stringContaining('local-audio-import'),
      expect.objectContaining({
        headers: expect.objectContaining({ 'Content-Type': 'audio/mpeg' }),
      }),
    );
  });
});
