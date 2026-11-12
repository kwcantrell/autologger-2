import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutogenerateBlocked, ProfilePayload } from '../../../api/types';
import {
  AUTOGENERATE_MAY_HAVE_STARTED_LINE,
  type StartAutogenerateAfterImportOptions,
  startAutogenerateAfterImport,
} from './autogenerateAfterImport';

// playlist-import-autogenerate task 3.1 (design D4, D5, D12; batch-audio-import "YouTube playlist
// import can autogenerate afterwards", "End-of-run start", "One re-scope on 404"): the end-of-run
// preview + start over the real `apiFetch`, with `fetch` stubbed, and the profile and session-list
// reads injected.

const TEAM = 'team-1';
const PREVIEW = `/api/teams/${TEAM}/autogenerate-jobs/preview`;
const START = `/api/teams/${TEAM}/autogenerate-jobs`;
const SETTINGS = 'Start it in Settings → Batch autogenerate.';
const FAILED = `Autogenerate not started: the request failed. ${SETTINGS}`;
const NO_VIDEO = 'Autogenerate not started: no video was imported by this import.';
const OTHER_USER =
  'Autogenerate not started: you are signed in as a different user than the one who confirmed.';
const LIVE =
  'Autogenerate not started: a batch job is already running for this team. Start one for this show in Settings → Batch autogenerate when it ends.';
const MAY =
  'Autogenerate may have started; check Settings → Batch autogenerate before starting it again.';

type Answer = Response | Error | ((signal?: AbortSignal | null) => Promise<Response>);
let previewAnswers: Answer[];
let startAnswers: Answer[];
let requests: Array<{ url: string; body: Record<string, unknown> }>;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const preview = (sessions: number, maxRuns: number, blocked: AutogenerateBlocked | null = null) =>
  json(200, {
    sessions,
    steps: ['transcript', 'topics'],
    runs: { transcript: sessions, topics: sessions },
    max_runs: maxRuns,
    blocked,
  });
const started = () => json(201, { job: { id: 'job-9' } });
const notFound = () => json(404, { detail: 'Session not found' });

function answer(a: Answer | undefined, signal?: AbortSignal | null): Promise<Response> {
  if (a === undefined) return Promise.reject(new Error('no answer queued'));
  if (a instanceof Error) return Promise.reject(a);
  if (typeof a === 'function') return a(signal);
  return Promise.resolve(a);
}

beforeEach(() => {
  previewAnswers = [];
  startAnswers = [];
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init?.body)) });
      if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (url === PREVIEW) return answer(previewAnswers.shift(), init?.signal);
      if (url === START) return answer(startAnswers.shift(), init?.signal);
      throw new Error(`unexpected ${url}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const me = (id = 'me') => ({ auth: { user: { id } } }) as unknown as ProfilePayload;

function opts(over: Partial<StartAutogenerateAfterImportOptions> = {}) {
  return {
    teamId: TEAM,
    sessionIds: ['s1', 's2', 's3'],
    steps: ['topics', 'transcript'] as StartAutogenerateAfterImportOptions['steps'],
    wikiMode: 'accept' as const,
    confirmedUserId: 'me',
    readProfile: vi.fn(async () => me()),
    listShowSessionIds: vi.fn(async () => ['s1', 's2', 's3']),
    signal: new AbortController().signal,
    ...over,
  };
}

const previews = () => requests.filter((r) => r.url === PREVIEW);
const starts = () => requests.filter((r) => r.url === START);

describe('startAutogenerateAfterImport — before any request', () => {
  it('no qualifying id: the no-video line and no request', async () => {
    const o = opts({ sessionIds: [] });
    expect(await startAutogenerateAfterImport(o)).toEqual([NO_VIDEO]);
    expect(requests).toEqual([]);
    expect(o.readProfile).not.toHaveBeenCalled();
  });

  it('another signed-in user: the different-user line and no preview or start', async () => {
    const o = opts({ readProfile: vi.fn(async () => me('someone-else')) });
    expect(await startAutogenerateAfterImport(o)).toEqual([OTHER_USER]);
    expect(requests).toEqual([]);
  });

  it('a failed profile read: the request failed and no preview', async () => {
    const o = opts({ readProfile: vi.fn(async () => Promise.reject(new TypeError('offline'))) });
    expect(await startAutogenerateAfterImport(o)).toEqual([FAILED]);
    expect(requests).toEqual([]);
  });
});

describe('startAutogenerateAfterImport — preview then start', () => {
  it('previews the exact ids in run order, starts with the preview count, logs the started line', async () => {
    previewAnswers = [preview(2, 4)]; // deliberately not the id count (3)
    startAnswers = [started()];
    const lines = await startAutogenerateAfterImport(opts());
    expect(requests.map((r) => r.url)).toEqual([PREVIEW, START]);
    expect(requests[0].body).toEqual({
      session_ids: ['s1', 's2', 's3'],
      steps: ['transcript', 'topics'],
      wiki_mode: 'accept',
    });
    expect(requests[1].body).toEqual({
      session_ids: ['s1', 's2', 's3'],
      steps: ['transcript', 'topics'],
      wiki_mode: 'accept',
      expected_sessions: 2,
    });
    expect(lines).toEqual([
      'Autogenerate started for 2 sessions (at most 4 runs); follow it in Settings → Batch autogenerate.',
    ]);
  });

  it.each([
    [
      'unconfigured-stt',
      'Add a speech-to-text key in Settings → Advanced to generate transcripts.',
    ],
    ['unconfigured-llm', 'Add a language model in Settings → Advanced to autogenerate.'],
    [
      'not-approved',
      'Batch autogenerate is limited to approved users on this server. Ask the operator for approval.',
    ],
  ] as const)('a preview blocked %s ends with its Settings text and no start', async (b, text) => {
    previewAnswers = [preview(3, 6, b)];
    expect(await startAutogenerateAfterImport(opts())).toEqual([
      `Autogenerate not started: ${text}`,
    ]);
    expect(starts()).toEqual([]);
  });
});

describe('startAutogenerateAfterImport — one re-scope on 404 Session not found', () => {
  it('a preview 404: one list read, the left-out line, one more preview and start over the rest', async () => {
    const o = opts({ listShowSessionIds: vi.fn(async () => ['s1', 's3', 'unrelated']) });
    previewAnswers = [notFound(), preview(2, 4)];
    startAnswers = [started()];
    const lines = await startAutogenerateAfterImport(o);
    expect(o.listShowSessionIds).toHaveBeenCalledTimes(1);
    expect(previews().map((r) => r.body.session_ids)).toEqual([
      ['s1', 's2', 's3'],
      ['s1', 's3'],
    ]);
    expect(starts().map((r) => r.body.session_ids)).toEqual([['s1', 's3']]);
    expect(lines).toEqual([
      'Autogenerate: left out 1 imported session(s) that no longer exist.',
      'Autogenerate started for 2 sessions (at most 4 runs); follow it in Settings → Batch autogenerate.',
    ]);
  });

  it('the same for a start 404', async () => {
    const o = opts({ listShowSessionIds: vi.fn(async () => ['s2']) });
    previewAnswers = [preview(3, 6), preview(1, 2)];
    startAnswers = [notFound(), started()];
    const lines = await startAutogenerateAfterImport(o);
    expect(o.listShowSessionIds).toHaveBeenCalledTimes(1);
    expect(previews()).toHaveLength(2);
    expect(starts().map((r) => [r.body.session_ids, r.body.expected_sessions])).toEqual([
      [['s1', 's2', 's3'], 3],
      [['s2'], 1],
    ]);
    expect(lines).toEqual([
      'Autogenerate: left out 2 imported session(s) that no longer exist.',
      'Autogenerate started for 1 sessions (at most 2 runs); follow it in Settings → Batch autogenerate.',
    ]);
  });

  it('a second 404 ends with the detail line and no third preview', async () => {
    const o = opts({ listShowSessionIds: vi.fn(async () => ['s1', 's2']) });
    previewAnswers = [notFound(), notFound()];
    const lines = await startAutogenerateAfterImport(o);
    expect(previews()).toHaveLength(2);
    expect(starts()).toEqual([]);
    expect(lines).toEqual([
      'Autogenerate: left out 1 imported session(s) that no longer exist.',
      `Autogenerate not started: Session not found ${SETTINGS}`,
    ]);
  });

  it('every id gone: the left-out line, then the no-video line', async () => {
    const o = opts({ listShowSessionIds: vi.fn(async () => []) });
    previewAnswers = [notFound()];
    expect(await startAutogenerateAfterImport(o)).toEqual([
      'Autogenerate: left out 3 imported session(s) that no longer exist.',
      NO_VIDEO,
    ]);
    expect(previews()).toHaveLength(1);
  });

  it('a failed session-list read: the request failed', async () => {
    const o = opts({ listShowSessionIds: vi.fn(async () => Promise.reject(new TypeError('x'))) });
    previewAnswers = [notFound()];
    expect(await startAutogenerateAfterImport(o)).toEqual([FAILED]);
    expect(requests).toHaveLength(1);
  });

  it('a 404 for the team is not re-scoped', async () => {
    const o = opts();
    previewAnswers = [json(404, { detail: 'Team not found' })];
    expect(await startAutogenerateAfterImport(o)).toEqual([
      `Autogenerate not started: Team not found ${SETTINGS}`,
    ]);
    expect(o.listShowSessionIds).not.toHaveBeenCalled();
  });
});

describe('startAutogenerateAfterImport — the outcome table', () => {
  it('start 409 with job_id: the live-job line', async () => {
    previewAnswers = [preview(3, 6)];
    startAnswers = [
      json(409, { detail: 'A batch job is already running for this team.', job_id: 'j' }),
    ];
    expect(await startAutogenerateAfterImport(opts())).toEqual([LIVE]);
  });

  it.each([
    [409, { detail: 'The sessions changed; preview again.', sessions: 4 }],
    [400, { detail: 'No sessions to process.' }],
    [403, { detail: 'Admin role required.' }],
    [403, { detail: 'Batch autogenerate is limited to approved users on this server.' }],
    [404, { detail: 'Team not found' }],
    [503, { detail: 'Add a speech-to-text key in Settings → Advanced.' }],
    [503, { detail: 'Add a language model in Settings → Advanced.' }],
  ] as const)('start %i with a string detail: the detail line', async (status, body) => {
    previewAnswers = [preview(3, 6)];
    startAnswers = [json(status, body)];
    expect(await startAutogenerateAfterImport(opts())).toEqual([
      `Autogenerate not started: ${body.detail} ${SETTINGS}`,
    ]);
    expect(starts()).toHaveLength(1);
  });

  it.each([
    [400, 'No sessions to process.'],
    [404, 'Team not found'],
    [403, 'Admin role required.'],
    [503, 'Add a language model in Settings → Advanced.'],
  ] as const)('preview %i with a string detail: the detail line, no start', async (status, d) => {
    previewAnswers = [json(status, { detail: d })];
    expect(await startAutogenerateAfterImport(opts())).toEqual([
      `Autogenerate not started: ${d} ${SETTINGS}`,
    ]);
    expect(starts()).toEqual([]);
  });

  it.each([
    ['422', () => json(422, { detail: [{ code: 'x', path: ['steps'], message: 'Bad' }] })],
    ['500', () => json(500, { detail: 'Internal error' })],
    ['a non-JSON 524', () => new Response('<html>timeout</html>', { status: 524 })],
    ['a network error', () => new TypeError('Failed to fetch')],
  ])('preview %s: the request failed, no start', async (_label, make) => {
    previewAnswers = [make()];
    expect(await startAutogenerateAfterImport(opts())).toEqual([FAILED]);
    expect(starts()).toEqual([]);
  });

  it('start 422: the request failed', async () => {
    previewAnswers = [preview(3, 6)];
    startAnswers = [json(422, { detail: [{ code: 'x', path: ['steps'], message: 'Bad' }] })];
    expect(await startAutogenerateAfterImport(opts())).toEqual([FAILED]);
  });

  it.each([
    ['500', () => json(500, { detail: 'Internal error' })],
    ['a non-JSON 524', () => new Response('<html>timeout</html>', { status: 524 })],
    ['a network error', () => new TypeError('Failed to fetch')],
  ])('start %s: may have started, and the start is not sent again', async (_label, make) => {
    previewAnswers = [preview(3, 6)];
    startAnswers = [make()];
    const lines = await startAutogenerateAfterImport(opts());
    expect(lines).toEqual([MAY]);
    expect(lines.at(-1)).toBe(AUTOGENERATE_MAY_HAVE_STARTED_LINE);
    expect(previews()).toHaveLength(1);
    expect(starts()).toHaveLength(1);
  });
});

describe('startAutogenerateAfterImport — abort', () => {
  it('aborted before: resolves [] with no request', async () => {
    const ac = new AbortController();
    ac.abort();
    const o = opts({ signal: ac.signal });
    expect(await startAutogenerateAfterImport(o)).toEqual([]);
    expect(requests).toEqual([]);
  });

  it('aborted during the profile read: resolves [] with no request', async () => {
    const ac = new AbortController();
    const o = opts({
      signal: ac.signal,
      readProfile: vi.fn(async () => {
        ac.abort();
        throw new DOMException('Aborted', 'AbortError');
      }),
    });
    expect(await startAutogenerateAfterImport(o)).toEqual([]);
    expect(requests).toEqual([]);
  });

  it('aborted during the preview: resolves [] with no start', async () => {
    const ac = new AbortController();
    previewAnswers = [
      async () => {
        ac.abort();
        throw new DOMException('Aborted', 'AbortError');
      },
    ];
    expect(await startAutogenerateAfterImport(opts({ signal: ac.signal }))).toEqual([]);
    expect(starts()).toEqual([]);
  });

  it('aborted while the preview answer is read: resolves [] with no start', async () => {
    const ac = new AbortController();
    previewAnswers = [
      async () => {
        ac.abort();
        return preview(3, 6);
      },
    ];
    expect(await startAutogenerateAfterImport(opts({ signal: ac.signal }))).toEqual([]);
    expect(starts()).toEqual([]);
  });

  it('aborted during the start: resolves [] and nothing further', async () => {
    const ac = new AbortController();
    previewAnswers = [preview(3, 6)];
    startAnswers = [
      async () => {
        ac.abort();
        throw new DOMException('Aborted', 'AbortError');
      },
    ];
    expect(await startAutogenerateAfterImport(opts({ signal: ac.signal }))).toEqual([]);
    expect(requests).toHaveLength(2);
  });

  it('passes the signal to both requests', async () => {
    const ac = new AbortController();
    previewAnswers = [preview(3, 6)];
    startAnswers = [started()];
    await startAutogenerateAfterImport(opts({ signal: ac.signal }));
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls.map((c) => (c[1] as RequestInit).signal)).toEqual([ac.signal, ac.signal]);
  });
});

describe('startAutogenerateAfterImport — never rejects', () => {
  it('an unexpected throw from an injected read is the request-failed line', async () => {
    const o = opts({
      readProfile: vi.fn(() => {
        throw new Error('sync boom');
      }),
    });
    expect(await startAutogenerateAfterImport(o)).toEqual([FAILED]);
  });
});
