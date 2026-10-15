import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../../../api/client';
import type { ProfilePayload, Session } from '../../../api/types';
import {
  fileGroupIdentity,
  findImportSession,
  findRememberedUpload,
  forgetImportSession,
  IMPORT_PARTS_THRESHOLD_BYTES,
  PartsUploadError,
  rememberImportSession,
  uploadInParts,
} from '../../../api/uploads';
import { formatCompletedLine, formatSkippedLine, runBatchImport } from './runner';
import { stitchAudioFiles } from './stitch';

// media-worker D.3 (batch-audio-import "Client stitch and single-take attach" and "Large imports
// upload in parts"): a blob over the 40 MiB threshold — a big single file or a big stitched WAV —
// goes through the parts upload with the same `duration_s` and seam parts; smaller ones keep
// `local-audio-import` unchanged.

vi.mock('../../../api/client', () => ({ apiFetch: vi.fn() }));
vi.mock('./stitch', () => ({ stitchAudioFiles: vi.fn() }));
vi.mock('../../../api/uploads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/uploads')>();
  return {
    ...actual,
    uploadInParts: vi.fn(),
    findRememberedUpload: vi.fn(async () => null),
    findImportSession: vi.fn(async () => null),
    rememberImportSession: vi.fn(async () => undefined),
    forgetImportSession: vi.fn(async () => undefined),
  };
});

const mockedApiFetch = vi.mocked(apiFetch);
const mockedStitch = vi.mocked(stitchAudioFiles);
const mockedParts = vi.mocked(uploadInParts);
const mockedRemembered = vi.mocked(findRememberedUpload);
const mockedImportSession = vi.mocked(findImportSession);
const mockedRememberSession = vi.mocked(rememberImportSession);
const mockedForgetSession = vi.mocked(forgetImportSession);
/** Segments per session id for `GET sessions/:id/audio/segments`. */
let segmentsBySession: Record<string, number>;

const BIG = IMPORT_PARTS_THRESHOLD_BYTES + 1;

const profile = {
  active_studio_id: 'studio-1',
  active_show_id: 'show-1',
  new_session_defaults: { default_frame_rate: 24, title_prefix: '' },
} as unknown as ProfilePayload;

function file(name: string, lastModified = 1): File {
  return new File(['audio'], name, { type: 'audio/mpeg', lastModified });
}

/** A Blob stand-in reporting `size` without allocating it (the parts client is mocked). */
function sizedBlob(size: number, type: string): Blob {
  return { size, type } as Blob;
}

let sessions: Session[];
let deleted: string[];

beforeEach(() => {
  sessions = [];
  deleted = [];
  segmentsBySession = {};
  mockedApiFetch.mockImplementation(async (path, opts) => {
    if (path === 'sessions' && !opts?.method) return { active: sessions, archived: [] };
    if (path === 'sessions' && opts?.method === 'POST') {
      const body = JSON.parse(String(opts.body));
      const s = { id: `new-${body.episode}`, episode: body.episode, title: body.title } as Session;
      sessions.push(s);
      return s;
    }
    if (path.startsWith('sessions/') && opts?.method === 'DELETE') {
      const id = decodeURIComponent(path.split('/')[1]);
      deleted.push(id);
      sessions = sessions.filter((s) => s.id !== id);
      return undefined;
    }
    if (path.includes('local-audio-import')) return { ok: true };
    const seg = /^sessions\/([^/]+)\/audio\/segments$/.exec(path);
    if (seg && !opts?.method) {
      const n = segmentsBySession[decodeURIComponent(seg[1])] ?? 0;
      return { segments: Array.from({ length: n }, (_, i) => ({ id: `s${i}` })), has_audio: n > 0 };
    }
    throw new Error(`unexpected ${path}`);
  });
  mockedParts.mockResolvedValue({ segmentId: 'seg-1' });
  mockedRemembered.mockResolvedValue(null);
  mockedImportSession.mockResolvedValue(null);
});

afterEach(() => vi.clearAllMocks());

async function run(files: File[]) {
  const states: { current: string | null; lines: string[] }[] = [];
  await runBatchImport({
    showId: 'show-1',
    files,
    profile,
    signal: new AbortController().signal,
    onProgress: (s) => states.push({ current: s.current, lines: s.lines }),
  });
  return states;
}

const localImportCalls = () =>
  mockedApiFetch.mock.calls.filter(([p]) => String(p).includes('local-audio-import'));

describe('runBatchImport — the parts path', () => {
  it('a single file over 40 MiB goes through the parts upload with duration and seam parts', async () => {
    mockedStitch.mockResolvedValue({
      blob: sizedBlob(BIG, 'audio/mpeg'),
      durationS: 3600,
      partDurationsS: [3600],
    });
    const f = file('YMH_001.mp3');
    const states = await run([f]);
    expect(localImportCalls()).toHaveLength(0);
    expect(mockedParts).toHaveBeenCalledTimes(1);
    const opts = mockedParts.mock.calls[0][0];
    expect(opts.sessionId).toBe('new-YMH_001');
    expect(opts.contentType).toBe('audio/mpeg');
    expect(opts.completion).toEqual({
      mode: 'import',
      durationS: 3600,
      seamParts: [{ duration_s: 3600 }],
    });
    expect(opts.resumeKey).toBe(fileGroupIdentity([f]));
    expect(states.at(-1)?.lines).toContain(formatCompletedLine('YMH_001'));
  });

  it('a stitched WAV over 40 MiB takes the parts path too', async () => {
    mockedStitch.mockResolvedValue({
      blob: sizedBlob(BIG, 'audio/wav'),
      durationS: 120,
      partDurationsS: [60, 60],
    });
    await run([file('YMH_002-1.mp3'), file('YMH_002-2.mp3')]);
    expect(localImportCalls()).toHaveLength(0);
    const opts = mockedParts.mock.calls[0][0];
    expect(opts.contentType).toBe('audio/wav');
    expect(opts.completion).toEqual({
      mode: 'import',
      durationS: 120,
      seamParts: [{ duration_s: 60 }, { duration_s: 60 }],
    });
  });

  it('a file at the threshold keeps local-audio-import unchanged', async () => {
    mockedStitch.mockResolvedValue({
      blob: new Blob(['x'], { type: 'audio/mpeg' }),
      durationS: 10,
      partDurationsS: [10],
    });
    await run([file('YMH_003.mp3')]);
    expect(mockedParts).not.toHaveBeenCalled();
    expect(localImportCalls()).toHaveLength(1);
  });

  it('shows per-part progress for the group', async () => {
    mockedStitch.mockResolvedValue({
      blob: sizedBlob(BIG, 'audio/mpeg'),
      durationS: 10,
      partDurationsS: [10],
    });
    mockedParts.mockImplementation(async (opts) => {
      opts.onProgress?.({ partsDone: 0, partsTotal: 3 });
      opts.onProgress?.({ partsDone: 1, partsTotal: 3 });
      opts.onProgress?.({ partsDone: 3, partsTotal: 3 });
      return { segmentId: 'seg-1' };
    });
    const states = await run([file('YMH_004.mp3')]);
    const currents = states.map((s) => s.current).filter(Boolean);
    expect(currents).toContain('Uploading YMH_004: part 1 of 3...');
    expect(currents).toContain('Uploading YMH_004: part 3 of 3...');
  });

  it('a 429 or 507 fails the group with its message and rolls the session back', async () => {
    mockedStitch.mockResolvedValue({
      blob: sizedBlob(BIG, 'audio/mpeg'),
      durationS: 10,
      partDurationsS: [10],
    });
    mockedParts.mockRejectedValue(
      new PartsUploadError('disk', 'The server is low on disk', 507, false),
    );
    const states = await run([file('YMH_005.mp3')]);
    expect(states.at(-1)?.lines).toEqual(['Failed YMH_005: The server is low on disk']);
    expect(deleted).toEqual(['new-YMH_005']);
  });

  it('an interrupted resumable upload keeps its session so a re-run resumes', async () => {
    mockedStitch.mockResolvedValue({
      blob: sizedBlob(BIG, 'audio/mpeg'),
      durationS: 10,
      partDurationsS: [10],
    });
    mockedParts.mockRejectedValue(new PartsUploadError('failed', 'Failed to fetch', null, true));
    const states = await run([file('YMH_006.mp3')]);
    expect(deleted).toEqual([]);
    expect(states.at(-1)?.lines[0]).toMatch(/^Failed YMH_006: Failed to fetch.*re-run/);
  });

  it('a re-run resumes into the session the remembered upload belongs to instead of skipping', async () => {
    sessions = [{ id: 'kept', episode: 'YMH_007', title: 'YMH_007' } as Session];
    const f = file('YMH_007.mp3');
    mockedRemembered.mockImplementation(async (key) =>
      key === fileGroupIdentity([f])
        ? {
            uploadId: 'u1',
            sessionId: 'kept',
            sizeBytes: BIG,
            partSize: 8,
            partSha256: [],
            contentType: 'audio/mpeg',
            savedAtMs: 0,
          }
        : null,
    );
    mockedStitch.mockResolvedValue({
      blob: sizedBlob(BIG, 'audio/mpeg'),
      durationS: 10,
      partDurationsS: [10],
    });
    const states = await run([f]);
    expect(mockedParts.mock.calls[0][0].sessionId).toBe('kept');
    expect(states.at(-1)?.lines).toEqual([formatCompletedLine('YMH_007')]);
    expect(
      mockedApiFetch.mock.calls.some(([p, o]) => p === 'sessions' && o?.method === 'POST'),
    ).toBe(false);
  });

  it('an existing session with no remembered upload is still skipped', async () => {
    sessions = [{ id: 'old', episode: 'YMH_008', title: 'YMH_008' } as Session];
    const states = await run([file('YMH_008.mp3')]);
    expect(states.at(-1)?.lines).toEqual([formatSkippedLine('YMH_008')]);
    expect(mockedStitch).not.toHaveBeenCalled();
  });
});

// The remembered upload expires after 24 h, but the session an interrupted import created must
// not then be skipped as "already in system" forever: the importer also remembers which session
// it created for the group, and a re-run that finds that session still empty starts a fresh
// upload into it. A matching session it did not create, or one that has audio, is still skipped.
describe('runBatchImport — the session of an interrupted import after its upload expired', () => {
  const bigStitch = () =>
    mockedStitch.mockResolvedValue({
      blob: sizedBlob(BIG, 'audio/mpeg'),
      durationS: 10,
      partDurationsS: [10],
    });

  it('remembers the session it creates for a parts upload and forgets it on success', async () => {
    bigStitch();
    const f = file('YMH_010.mp3');
    await run([f]);
    expect(mockedRememberSession).toHaveBeenCalledWith(fileGroupIdentity([f]), 'new-YMH_010');
    expect(mockedForgetSession).toHaveBeenCalledWith(fileGroupIdentity([f]));
  });

  it('resumes into its own empty session with a fresh upload instead of skipping', async () => {
    sessions = [{ id: 'mine', episode: 'YMH_011', title: 'YMH_011' } as Session];
    const f = file('YMH_011.mp3');
    mockedImportSession.mockImplementation(async (key) =>
      key === fileGroupIdentity([f]) ? 'mine' : null,
    );
    bigStitch();
    const states = await run([f]);
    expect(mockedParts).toHaveBeenCalledTimes(1);
    expect(mockedParts.mock.calls[0][0].sessionId).toBe('mine');
    expect(states.at(-1)?.lines).toEqual([formatCompletedLine('YMH_011')]);
    expect(
      mockedApiFetch.mock.calls.some(([p, o]) => p === 'sessions' && o?.method === 'POST'),
    ).toBe(false);
  });

  it('still skips its own session once that session has audio', async () => {
    sessions = [{ id: 'mine', episode: 'YMH_012', title: 'YMH_012' } as Session];
    segmentsBySession = { mine: 1 };
    const f = file('YMH_012.mp3');
    mockedImportSession.mockResolvedValue('mine');
    const states = await run([f]);
    expect(states.at(-1)?.lines).toEqual([formatSkippedLine('YMH_012')]);
    expect(mockedParts).not.toHaveBeenCalled();
  });

  it('still skips an empty matching session this import did not create', async () => {
    sessions = [{ id: 'someone-elses', episode: 'YMH_013', title: 'YMH_013' } as Session];
    mockedImportSession.mockResolvedValue(null);
    const states = await run([file('YMH_013.mp3')]);
    expect(states.at(-1)?.lines).toEqual([formatSkippedLine('YMH_013')]);
    expect(mockedStitch).not.toHaveBeenCalled();
  });
});
