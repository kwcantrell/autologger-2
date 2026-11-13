import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch } from '../../../api/client';
import type { ProfilePayload, Session, YoutubePlaylistEntry } from '../../../api/types';
import {
  findImportSession,
  forgetImportSession,
  rememberImportSession,
} from '../../../api/uploads';
import { runPlaylistImport } from './playlistRunner';
import type { BatchImportProgressState } from './runner';

// youtube-playlist-import task 8.2 (batch-audio-import "YouTube playlist import run", design D5,
// D7): the browser loop over the checked entries, against an in-memory fake of the API and of
// the import-session memory, with injected sleep (virtual time).

vi.mock('../../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/client')>();
  return { ...actual, apiFetch: vi.fn() };
});
vi.mock('../../../api/uploads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/uploads')>();
  return {
    ...actual,
    findImportSession: vi.fn(),
    rememberImportSession: vi.fn(),
    forgetImportSession: vi.fn(),
  };
});

const mockedApiFetch = vi.mocked(apiFetch);
const SHOW = 'show-1';

/** Server-side state of the fake API. */
let activeShow: string;
let sessions: Session[];
let segments: Record<string, number>;
let calls: string[];
let creates: Array<Record<string, unknown>>;
let imports: Array<{ sessionId: string; body: Record<string, unknown> }>;
let deleted: string[];
let memory: Map<string, string>;
/** Per-call import behaviour: return to succeed (adds a segment), throw to fail. */
let importImpl: (sessionId: string, n: number) => Promise<unknown>;
let createImpl: ((body: Record<string, unknown>) => Promise<Session>) | null;
let nextId: number;

function profile(): ProfilePayload {
  return {
    active_studio_id: 'studio-1',
    active_show_id: activeShow,
    new_session_defaults: { default_frame_rate: 30, title_prefix: '' },
  } as unknown as ProfilePayload;
}

function sessionRow(
  id: string,
  name: string,
  showId = SHOW,
  field: 'both' | 'title' | 'episode' = 'both',
): Session {
  return {
    id,
    title: field === 'episode' ? 'other' : name,
    episode: field === 'title' ? 'other' : name,
    show_id: showId,
  } as Session;
}

function entry(index: number, title: string, videoId: string): YoutubePlaylistEntry {
  return {
    index,
    video_id: videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    title,
    duration_s: 100,
    importable: true,
    reason: null,
  };
}

const E1 = entry(1, 'One', 'aaaaaaaaaaa');
const E2 = entry(2, 'Two', 'bbbbbbbbbbb');
const E3 = entry(3, 'Three', 'ccccccccccc');
const NAMES = new Map([
  [1, 'One'],
  [2, 'Two'],
  [3, 'Three'],
  [4, 'Four'],
  [5, 'Five'],
]);

const jsonError = (status: number, detail: unknown) =>
  new ApiError(status, typeof detail === 'string' ? detail : JSON.stringify(detail), { detail });

beforeEach(() => {
  activeShow = SHOW;
  sessions = [];
  segments = {};
  calls = [];
  creates = [];
  imports = [];
  deleted = [];
  memory = new Map();
  nextId = 1;
  createImpl = null;
  importImpl = async (sessionId) => {
    segments[sessionId] = (segments[sessionId] ?? 0) + 1;
    return { ok: true };
  };
  vi.mocked(findImportSession).mockImplementation(async (k) => memory.get(k) ?? null);
  vi.mocked(rememberImportSession).mockImplementation(async (k, id) => {
    memory.set(k, id);
  });
  vi.mocked(forgetImportSession).mockImplementation(async (k) => {
    memory.delete(k);
  });
  mockedApiFetch.mockImplementation(async (path: string, opts?: RequestInit) => {
    const method = opts?.method ?? 'GET';
    calls.push(`${method} ${path}`);
    if (path === 'profile' && method === 'GET') return profile();
    if (path === 'profile' && method === 'PUT') {
      activeShow = JSON.parse(String(opts?.body)).active_show_id;
      return profile();
    }
    if (path === 'sessions' && method === 'GET') {
      // The real list follows the profile's CURRENT active show (design A17).
      return { active: sessions.filter((s) => s.show_id === activeShow), archived: [] };
    }
    if (path === 'sessions' && method === 'POST') {
      const body = JSON.parse(String(opts?.body));
      creates.push(body);
      if (createImpl) return createImpl(body);
      const s = sessionRow(`new-${nextId++}`, body.episode, body.show_id);
      sessions.push(s);
      return s;
    }
    const imp = /^sessions\/([^/]+)\/youtube-import$/.exec(path);
    if (imp && method === 'POST') {
      const sessionId = decodeURIComponent(imp[1]);
      imports.push({ sessionId, body: JSON.parse(String(opts?.body)) });
      if (opts?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      return importImpl(sessionId, imports.length);
    }
    const seg = /^sessions\/([^/]+)\/audio\/segments$/.exec(path);
    if (seg && method === 'GET') {
      const n = segments[decodeURIComponent(seg[1])] ?? 0;
      return {
        segments: Array.from({ length: n }, (_, i) => ({ id: `seg${i}` })),
        has_audio: n > 0,
      };
    }
    const del = /^sessions\/([^/]+)$/.exec(path);
    if (del && method === 'DELETE') {
      const id = decodeURIComponent(del[1]);
      deleted.push(id);
      sessions = sessions.filter((s) => s.id !== id);
      return { ok: true, hidden: true };
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
});

afterEach(() => vi.clearAllMocks());

interface RunResult {
  states: BatchImportProgressState[];
  last: BatchImportProgressState;
  sleeps: number[];
}

async function run(
  entries: YoutubePlaylistEntry[],
  opts: {
    usePublishDate?: boolean;
    signal?: AbortSignal;
    initialLines?: string[];
    onSessionCreated?: () => void;
    onSessionImported?: (sessionId: string) => void;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  } = {},
): Promise<RunResult> {
  const states: BatchImportProgressState[] = [];
  const sleeps: number[] = [];
  await runPlaylistImport({
    showId: SHOW,
    entries,
    names: NAMES,
    usePublishDate: opts.usePublishDate ?? true,
    profile: profile(),
    signal: opts.signal ?? new AbortController().signal,
    initialLines: opts.initialLines,
    onProgress: (s) => states.push({ ...s, lines: [...s.lines] }),
    onSessionCreated: opts.onSessionCreated,
    ...(opts.onSessionImported ? { onSessionImported: opts.onSessionImported } : {}),
    sleep:
      opts.sleep ??
      (async (ms) => {
        sleeps.push(ms);
      }),
  });
  return { states, last: states.at(-1) as BatchImportProgressState, sleeps };
}

const createCalls = () => calls.filter((c) => c === 'POST sessions');
const importCalls = () => calls.filter((c) => c.endsWith('/youtube-import'));

describe('runPlaylistImport — show alignment and the fresh list', () => {
  it('aligns the active show at start', async () => {
    activeShow = 'show-other';
    await run([E1]);
    expect(calls[0]).toBe('PUT profile');
    expect(activeShow).toBe(SHOW);
  });

  it('reads the profile and the list right before each create', async () => {
    await run([E1, E2]);
    const firstCreate = calls.indexOf('POST sessions');
    expect(calls.slice(firstCreate - 2, firstCreate)).toEqual(['GET profile', 'GET sessions']);
    const secondCreate = calls.indexOf('POST sessions', firstCreate + 1);
    expect(calls.slice(secondCreate - 2, secondCreate)).toEqual(['GET profile', 'GET sessions']);
  });

  it('switches the active show back with one line when another tab changed it, and a same-named session there does not skip', async () => {
    sessions = [sessionRow('elsewhere', 'Two', 'show-other')];
    importImpl = async (sessionId) => {
      segments[sessionId] = 1;
      if (imports.length === 1) activeShow = 'show-other'; // another tab, during entry 1
      return { ok: true };
    };
    const { last } = await run([E1, E2]);
    expect(last.lines.filter((l) => l.includes('switched back'))).toHaveLength(1);
    expect(createCalls()).toHaveLength(2);
    expect(creates[1]).toMatchObject({ show_id: SHOW, episode: 'Two' });
    expect(last.lines).toContain('Completed Two');
  });

  it('a same-named session whose show_id is another show never causes a skip', async () => {
    // Even if the list carries it (the profile switched between the profile and list reads).
    sessions = [sessionRow('foreign', 'One', 'show-x')];
    const real = mockedApiFetch.getMockImplementation();
    mockedApiFetch.mockImplementation(async (path, o) => {
      if (path === 'sessions' && !o?.method) return { active: [...sessions], archived: [] };
      return real?.(path, o);
    });
    const { last } = await run([E1]);
    expect(last.lines).toContain('Completed One');
  });
});

describe('runPlaylistImport — skip and retry', () => {
  it.each(['both', 'title', 'episode'] as const)(
    'skips on a %s match in the run show',
    async (field) => {
      sessions = [sessionRow('old', 'One', SHOW, field === 'both' ? 'both' : field)];
      const { last } = await run([E1]);
      expect(last.lines).toEqual(['Skipped One (already in system)']);
      expect(createCalls()).toHaveLength(0);
      expect(importCalls()).toHaveLength(0);
    },
  );

  it('a remembered, segment-less session for the same show and video is imported into (no create)', async () => {
    sessions = [sessionRow('mine', 'One')];
    memory.set(`youtube:${SHOW}:aaaaaaaaaaa`, 'mine');
    const { last } = await run([E1]);
    expect(createCalls()).toHaveLength(0);
    expect(imports.map((i) => i.sessionId)).toEqual(['mine']);
    expect(last.lines).toEqual(['Completed One']);
    expect(memory.size).toBe(0);
  });

  it('the same with a 409 logs still-importing, creates nothing and moves on', async () => {
    sessions = [sessionRow('mine', 'One')];
    memory.set(`youtube:${SHOW}:aaaaaaaaaaa`, 'mine');
    importImpl = async (sessionId) => {
      if (sessionId === 'mine')
        throw jsonError(409, 'An import is already in progress for this session.');
      segments[sessionId] = 1;
      return { ok: true };
    };
    const { last } = await run([E1, E2]);
    expect(last.lines).toEqual([
      'Still importing One on the server; run the import again later to check it',
      'Completed Two',
    ]);
    expect(createCalls()).toHaveLength(1);
    expect(deleted).toEqual([]);
    expect(memory.get(`youtube:${SHOW}:aaaaaaaaaaa`)).toBe('mine');
  });

  it('a remembered session that already has a segment is skipped', async () => {
    sessions = [sessionRow('mine', 'One')];
    segments.mine = 1;
    memory.set(`youtube:${SHOW}:aaaaaaaaaaa`, 'mine');
    const { last } = await run([E1]);
    expect(last.lines).toEqual(['Skipped One (already in system)']);
    expect(importCalls()).toHaveLength(0);
  });

  it('a remembered id for another video does not turn a skip into a retry', async () => {
    sessions = [sessionRow('mine', 'One')];
    memory.set(`youtube:${SHOW}:zzzzzzzzzzz`, 'mine');
    const { last } = await run([E1]);
    expect(last.lines).toEqual(['Skipped One (already in system)']);
  });
});

describe('runPlaylistImport — create and import', () => {
  it('creates with the name as episode and title, remembers, imports, forgets; never navigates', async () => {
    const remembered: Array<[string, string]> = [];
    vi.mocked(rememberImportSession).mockImplementation(async (k, id) => {
      remembered.push([k, id]);
      memory.set(k, id);
    });
    const { last } = await run([E1]);
    expect(creates).toEqual([
      { show_id: SHOW, episode: 'One', title: 'One', frame_rate: 30, start_offset_frames: 0 },
    ]);
    expect(remembered).toEqual([[`youtube:${SHOW}:aaaaaaaaaaa`, 'new-1']]);
    expect(imports).toEqual([
      {
        sessionId: 'new-1',
        body: { url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', use_publish_date: true },
      },
    ]);
    expect(last.lines).toEqual(['Completed One']);
    expect(memory.size).toBe(0);
  });

  it.each([true, false])(
    'every youtube-import of the run carries use_publish_date: %s',
    async (flag) => {
      await run([E1, E2], { usePublishDate: flag });
      expect(imports.map((i) => i.body.use_publish_date)).toEqual([flag, flag]);
    },
  );

  it('invalidates the sessions query after each create', async () => {
    const onSessionCreated = vi.fn();
    await run([E1, E2], { onSessionCreated });
    expect(onSessionCreated).toHaveBeenCalledTimes(2);
  });
});

describe('runPlaylistImport — failures', () => {
  it('a 502 {detail}: failed line, session deleted and forgotten, the loop continues', async () => {
    importImpl = async (sessionId, n) => {
      if (n === 2) throw jsonError(502, 'Failed to download audio.');
      segments[sessionId] = 1;
      return { ok: true };
    };
    const { last } = await run([E1, E2, E3]);
    expect(last.lines).toEqual([
      'Completed One',
      'Failed Two: Failed to download audio.',
      'Completed Three',
    ]);
    expect(deleted).toEqual(['new-2']);
    expect(memory.size).toBe(0);
  });

  it('a create 422 with an episode issue renders `episode: Too big` and continues', async () => {
    createImpl = async (body) => {
      if (body.episode === 'One') {
        throw jsonError(422, [{ code: 'too_big', path: ['episode'], message: 'Too big' }]);
      }
      const s = sessionRow(`new-${nextId++}`, String(body.episode));
      sessions.push(s);
      return s;
    };
    const { last } = await run([E1, E2]);
    expect(last.lines).toEqual(['Failed One: episode: Too big', 'Completed Two']);
  });

  it('several validation issues join with "; "', async () => {
    createImpl = async () => {
      throw jsonError(422, [
        { path: ['episode'], message: 'Too big' },
        { path: ['a', 0, 'b'], message: 'Bad' },
      ]);
    };
    const { last } = await run([E1]);
    expect(last.lines).toEqual(['Failed One: episode: Too big; a.0.b: Bad']);
  });

  it.each([401, 403, 503])(
    'a %i ends the playlist part with a not-attempted line',
    async (status) => {
      importImpl = async (sessionId, n) => {
        if (n === 2)
          throw jsonError(status, 'This feature is limited to approved users on this server.');
        segments[sessionId] = 1;
        return { ok: true };
      };
      const five = [E1, E2, E3, entry(4, 'Four', 'ddddddddddd'), entry(5, 'Five', 'eeeeeeeeeee')];
      const { last } = await run(five);
      expect(last.lines).toEqual([
        'Completed One',
        'Failed Two: This feature is limited to approved users on this server.',
        '3 checked videos were not attempted.',
      ]);
      expect(importCalls()).toHaveLength(2);
      expect(createCalls()).toHaveLength(2);
    },
  );
});

describe('runPlaylistImport — unknown outcome (no JSON answer)', () => {
  it('a non-JSON 524 keeps the session and waits for the segment before the next entry', async () => {
    let polls = 0;
    importImpl = async (sessionId, n) => {
      if (n === 1) throw new ApiError(524, 'A timeout occurred', undefined);
      segments[sessionId] = 1;
      return { ok: true };
    };
    const real = mockedApiFetch.getMockImplementation();
    mockedApiFetch.mockImplementation(async (path, o) => {
      if (path === 'sessions/new-1/audio/segments') {
        calls.push(`GET ${path}`);
        polls += 1;
        // The server attaches the audio four minutes (16 polls) after the 524.
        return { segments: polls >= 16 ? [{ id: 'late' }] : [], has_audio: polls >= 16 };
      }
      return real?.(path, o);
    });
    const { last, sleeps, states } = await run([E1, E2]);
    expect(sleeps.slice(0, 16)).toEqual(Array(16).fill(15_000));
    expect(polls).toBe(16);
    // No request for the next entry until the segment was seen.
    const lastPoll = calls.lastIndexOf('GET sessions/new-1/audio/segments');
    expect(calls.slice(0, lastPoll).filter((c) => c === 'POST sessions')).toHaveLength(1);
    expect(importCalls()).toHaveLength(2); // never re-sent while waiting
    expect(deleted).toEqual([]);
    expect(last.lines).toEqual(['Completed One', 'Completed Two']);
    expect(states.map((s) => s.current)).toContain('Waiting for the server to finish One...');
  });

  it('a network error with no segment after 32 minutes: did-not-confirm line, session kept and remembered, next entry runs', async () => {
    importImpl = async (sessionId, n) => {
      if (n === 1) throw new TypeError('Failed to fetch');
      segments[sessionId] = 1;
      return { ok: true };
    };
    const { last, sleeps } = await run([E1, E2]);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBe(32 * 60 * 1000);
    expect(last.lines).toEqual([
      'Failed One: the server did not confirm the import; run the import again to retry',
      'Completed Two',
    ]);
    expect(deleted).toEqual([]);
    expect(memory.get(`youtube:${SHOW}:aaaaaaaaaaa`)).toBe('new-1');
    expect(importCalls()).toHaveLength(2);
  });
});

describe('runPlaylistImport — abort', () => {
  it('abort during an import keeps the in-flight session remembered, starts nothing else and rejects AbortError', async () => {
    const ac = new AbortController();
    importImpl = async (sessionId, n) => {
      if (n === 2) {
        ac.abort();
        throw new DOMException('Aborted', 'AbortError');
      }
      segments[sessionId] = 1;
      return { ok: true };
    };
    await expect(run([E1, E2, E3], { signal: ac.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(deleted).toEqual([]);
    expect(memory.get(`youtube:${SHOW}:bbbbbbbbbbb`)).toBe('new-2');
    expect(createCalls()).toHaveLength(2);
    expect(importCalls()).toHaveLength(2);
  });

  it('abort during the wait stops waiting, keeps the session and rejects AbortError', async () => {
    const ac = new AbortController();
    importImpl = async () => {
      throw new ApiError(524, 'A timeout occurred', undefined);
    };
    let n = 0;
    const sleep = async (_ms: number, signal: AbortSignal) => {
      n += 1;
      if (n === 3) ac.abort();
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    };
    await expect(run([E1, E2], { signal: ac.signal, sleep })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(deleted).toEqual([]);
    expect(memory.get(`youtube:${SHOW}:aaaaaaaaaaa`)).toBe('new-1');
    expect(createCalls()).toHaveLength(1);
  });
});

describe('runPlaylistImport — progress', () => {
  it('keeps initialLines ahead and reports the current line', async () => {
    const { states, last } = await run([E1, E2], { initialLines: ['Completed YMH_001'] });
    expect(last.lines).toEqual(['Completed YMH_001', 'Completed One', 'Completed Two']);
    expect(states.map((s) => s.current)).toContain('Importing One (video 1 of 2)...');
    expect(states.map((s) => s.current)).toContain('Importing Two (video 2 of 2)...');
    expect(last.percent).toBe(100);
    expect(states.every((s) => s.lines[0] === 'Completed YMH_001')).toBe(true);
  });

  it('nothing checked: done at 100 with the initial lines', async () => {
    const { last } = await run([], { initialLines: ['x'] });
    expect(last).toEqual({ current: null, percent: 100, lines: ['x'] });
    expect(calls).toEqual([]);
  });
});

// playlist-import-autogenerate task 2.1 (design D2; batch-audio-import "YouTube playlist import can
// autogenerate afterwards", "Qualifying sessions"): the runner reports each session this import
// brought in, and nothing else, without changing a single progress line.
describe('runPlaylistImport — onSessionImported', () => {
  const E4 = entry(4, 'Four', 'ddddddddddd');
  const E5 = entry(5, 'Five', 'eeeeeeeeeee');

  /** E1 completes; E2 is already in the system; E3 fails definitely; E4's outcome is unknown and
   * later confirmed by a segment; E5's is unknown and never confirmed. */
  function fiveEntryWorld() {
    sessions = [sessionRow('old-two', 'Two')];
    importImpl = async (sessionId, n) => {
      if (n === 2) throw jsonError(502, 'Failed to download audio.');
      if (n === 3) {
        segments[sessionId] = 1; // the server finished after the proxy gave up
        throw new ApiError(524, 'A timeout occurred', undefined);
      }
      if (n === 4) throw new TypeError('Failed to fetch');
      segments[sessionId] = 1;
      return { ok: true };
    };
  }

  it('reports exactly the completed and the confirmed-later entries', async () => {
    fiveEntryWorld();
    const reported: string[] = [];
    const { last } = await run([E1, E2, E3, E4, E5], {
      onSessionImported: (id) => reported.push(id),
    });
    expect(last.lines).toEqual([
      'Completed One',
      'Skipped Two (already in system)',
      'Failed Three: Failed to download audio.',
      'Completed Four',
      'Failed Five: the server did not confirm the import; run the import again to retry',
    ]);
    expect(reported).toEqual(['new-1', 'new-3']);
  });

  it('every progress state is byte-identical to the same run without the callback', async () => {
    fiveEntryWorld();
    const without = await run([E1, E2, E3, E4, E5]);
    vi.clearAllMocks();
    // A fresh world for the second run.
    segments = {};
    calls = [];
    creates = [];
    imports = [];
    deleted = [];
    memory = new Map();
    nextId = 1;
    fiveEntryWorld();
    const withCb = await run([E1, E2, E3, E4, E5], { onSessionImported: () => {} });
    expect(JSON.stringify(withCb.states)).toBe(JSON.stringify(without.states));
  });

  it("a retry into this import's own empty session that completes is reported", async () => {
    sessions = [sessionRow('mine', 'One')];
    memory.set(`youtube:${SHOW}:aaaaaaaaaaa`, 'mine');
    const reported: string[] = [];
    await run([E1], { onSessionImported: (id) => reported.push(id) });
    expect(reported).toEqual(['mine']);
  });

  it('a 409 still-importing retry is not reported', async () => {
    sessions = [sessionRow('mine', 'One')];
    memory.set(`youtube:${SHOW}:aaaaaaaaaaa`, 'mine');
    importImpl = async () => {
      throw jsonError(409, 'An import is already in progress for this session.');
    };
    const reported: string[] = [];
    await run([E1], { onSessionImported: (id) => reported.push(id) });
    expect(reported).toEqual([]);
  });

  it('after a 403 ends the part, the ids completed before it are reported and nothing after', async () => {
    importImpl = async (sessionId, n) => {
      if (n === 2)
        throw jsonError(403, 'This feature is limited to approved users on this server.');
      segments[sessionId] = 1;
      return { ok: true };
    };
    const reported: string[] = [];
    await run([E1, E2, E3], { onSessionImported: (id) => reported.push(id) });
    expect(reported).toEqual(['new-1']);
  });

  it('an abort reports nothing more', async () => {
    const ac = new AbortController();
    importImpl = async (sessionId, n) => {
      if (n === 2) {
        ac.abort();
        throw new DOMException('Aborted', 'AbortError');
      }
      segments[sessionId] = 1;
      return { ok: true };
    };
    const reported: string[] = [];
    await expect(
      run([E1, E2, E3], { signal: ac.signal, onSessionImported: (id) => reported.push(id) }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(reported).toEqual(['new-1']);
  });

  it("an interrupted earlier run: this import's remembered own session with audio is skipped, reported and forgotten", async () => {
    sessions = [sessionRow('mine', 'One')];
    segments.mine = 1;
    memory.set(`youtube:${SHOW}:aaaaaaaaaaa`, 'mine');
    const reported: string[] = [];
    const first = await run([E1], { onSessionImported: (id) => reported.push(id) });
    expect(first.last.lines).toEqual(['Skipped One (already in system)']);
    expect(reported).toEqual(['mine']);
    expect(memory.has(`youtube:${SHOW}:aaaaaaaaaaa`)).toBe(false);
    expect(importCalls()).toHaveLength(0);

    // A third run sees an ordinary existing session.
    const again: string[] = [];
    const second = await run([E1], { onSessionImported: (id) => again.push(id) });
    expect(second.last.lines).toEqual(['Skipped One (already in system)']);
    expect(again).toEqual([]);
  });

  it('a name match that is not remembered, or remembered for another video, is skipped and not reported', async () => {
    sessions = [sessionRow('theirs', 'One'), sessionRow('other', 'Two')];
    segments.theirs = 1;
    segments.other = 1;
    memory.set(`youtube:${SHOW}:zzzzzzzzzzz`, 'other');
    const reported: string[] = [];
    const { last } = await run([E1, E2], { onSessionImported: (id) => reported.push(id) });
    expect(last.lines).toEqual([
      'Skipped One (already in system)',
      'Skipped Two (already in system)',
    ]);
    expect(reported).toEqual([]);
    expect(memory.get(`youtube:${SHOW}:zzzzzzzzzzz`)).toBe('other');
  });
});
