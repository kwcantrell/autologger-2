import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch } from '../../../api/client';
import type { SessionStatus, SessionTopic } from '../../../api/types';
import { showToast } from '../../../shared/components/Toast';
import { renderStrict } from '../../../test/renderStrict';
import { TopicsFeed } from './TopicsFeed';

// --- I1 regression (whole-branch audit fix wave) ---
//
// `transcriptAnchored` used to be computed as
// `!transcriptWhollyAnchorless(words ?? [])`. Before `useTranscriptWords`
// resolves, `words` is `undefined`, coerced to `[]` by `?? []`, and
// `transcriptWhollyAnchorless([])` is `false` (its own deliberate
// empty-transcript exception, so a hand-entered-topics-no-transcript session
// isn't wrongly treated as anchorless) — so `transcriptAnchored` read as TRUE
// for the entire loading window, and PERMANENTLY if the request errors.
// Every Topics row with a parseable `session_time` would render a LIVE jump
// control against what might be a model-invented time (the exact hazard
// task 8.3 exists to guard against — under design D1 activating it PLAYS
// audio at that invented position). This test holds the transcript-words
// request pending indefinitely — never resolving it — while Topics data has
// already loaded, and asserts no jump control renders in that window.

vi.mock('../../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/client')>();
  return { ...actual, apiFetch: vi.fn() };
});

vi.mock('../../../shared/components/Toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/components/Toast')>();
  return { ...actual, showToast: vi.fn() };
});

class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof window !== 'undefined' && typeof window.ResizeObserver === 'undefined') {
  window.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
}

const mockedApiFetch = vi.mocked(apiFetch);
const SESSION_ID = 'sess-anchor-guard-1';

function statusFixture(): SessionStatus {
  return {
    is_rolling: false,
    timecode: '00:00:30:00',
    session_timecode: '00:00:30:00',
    master_timecode: '00:00:30:00',
    frame_rate: 24,
    current_take: 0,
    audio_recording_lease_alive: false,
    audio_recording_lease_holder_id: null,
    event_count: 0,
    logged_event_count: 0,
    title: 'Anchor guard test session',
    deck_title: '',
    show_name: null,
    show_code: null,
    episode: '',
    session_created_at_utc: null,
    now_utc: '2026-07-26T00:00:30Z',
    notes: '',
    show_id: null,
    events_stream_revision: 1,
  };
}

function topicFixture(overrides: Partial<SessionTopic> = {}): SessionTopic {
  return {
    version: 1,
    id: 'topic-1',
    session_time: '00:00:10:00',
    duration_sec: 30,
    topic_level: 1,
    summary: 'A summary',
    ordinal: 0,
    created_at_utc: '2026-07-26T00:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  mockedApiFetch.mockReset();
});

function renderFeed() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderStrict(
    <QueryClientProvider client={client}>
      <TopicsFeed sessionId={SESSION_ID} />
    </QueryClientProvider>,
  );
}

describe('TopicsFeed — transcript-anchored guard fails CLOSED while loading (finding I1)', () => {
  it('renders no jump control while useTranscriptWords is still pending, even though Topics/status have already loaded', async () => {
    let resolveWords: (() => void) | undefined;
    const wordsPromise = new Promise<{ words: [] }>((resolve) => {
      resolveWords = () => resolve({ words: [] });
    });
    mockedApiFetch.mockImplementation(async (path: string) => {
      if (path.includes('/status')) return statusFixture();
      if (path.includes('/transcript-words')) return wordsPromise;
      if (path.includes('/topics')) return { topics: [topicFixture()] };
      throw new Error(`unexpected apiFetch call: ${path}`);
    });
    renderFeed();

    // Topics data (and session status) have loaded; transcript words stay
    // pending throughout this assertion.
    await screen.findByDisplayValue('00:00:10:00');
    expect(screen.queryByRole('button', { name: /Jump to/ })).toBeNull();

    // Resolving the pending request — to a LOADED-but-EMPTY transcript —
    // flips the guard available, proving the absence above was genuinely the
    // loading gate (and preserving the deliberate empty-transcript
    // exception: a loaded `[]` still counts as anchored).
    resolveWords?.();
    await waitFor(() => expect(screen.getByRole('button', { name: /Jump to/ })).toBeTruthy());
  });
});

// --- Version conflicts on topic saves (session-edit-conflicts D3/D4/D5/D9, task 7.2) ---
//
// The topic save moved from TopicsRow up into this feed (one `useVersionedSave`, one seed store,
// one conflict dialog). The server mock enforces the version guard; "another person's change" is
// a direct write to `serverTopics` that the feed's cache only sees through a refetch or the 409's
// `current`.

let serverTopics: SessionTopic[] = [];
let topicPatches: Array<{ id: string; body: Record<string, unknown> }> = [];
let topicPatchFails = false;

function serveTopics() {
  mockedApiFetch.mockImplementation(async (path: string, opts: RequestInit = {}) => {
    if (path.includes('/status')) return statusFixture();
    if (path.includes('/transcript-words')) return { words: [] };
    if (path.includes('/topics/') && opts.method === 'PATCH') {
      const id = path.split('/topics/')[1];
      const body = JSON.parse(String(opts.body)) as Record<string, unknown>;
      topicPatches.push({ id, body });
      if (topicPatchFails) throw new ApiError(500, 'Topic save failed.');
      const { version, overwrite: _overwrite, ...patch } = body;
      const index = serverTopics.findIndex((t) => t.id === id);
      const current = serverTopics[index];
      if (version !== undefined && version !== current.version) {
        throw new ApiError(409, 'Version conflict.', { detail: 'Version conflict.', current });
      }
      const updated = { ...current, ...patch, version: current.version + 1 } as SessionTopic;
      serverTopics = serverTopics.map((t) => (t.id === id ? updated : t));
      return updated;
    }
    if (path.includes('/topics')) return { topics: serverTopics };
    throw new Error(`unexpected apiFetch call: ${path}`);
  });
}

function otherPersonEditsTopic(id: string, fields: Partial<SessionTopic>) {
  serverTopics = serverTopics.map((t) =>
    t.id === id ? { ...t, ...fields, version: t.version + 1 } : t,
  );
}

async function blurTopicField(el: HTMLElement) {
  await act(async () => {
    fireEvent.blur(el);
  });
  await act(async () => {});
}

async function editSummary(from: string, to: string) {
  const el = await screen.findByDisplayValue(from);
  fireEvent.focus(el);
  fireEvent.change(el, { target: { value: to } });
  await blurTopicField(el);
  return el;
}

async function chooseTopic(name: 'Overwrite' | 'Keep theirs') {
  const button = await screen.findByRole('button', { name });
  await act(async () => {
    fireEvent.click(button);
  });
  await act(async () => {});
}

async function escapeTopicDialog() {
  const d = await screen.findByRole('alertdialog');
  await act(async () => {
    fireEvent.keyDown(d, { key: 'Escape' });
  });
  await act(async () => {});
}

describe('TopicsFeed version conflicts (task 7.2)', () => {
  beforeEach(() => {
    serverTopics = [
      topicFixture(),
      topicFixture({ id: 'topic-2', summary: 'Second summary', ordinal: 1 }),
    ];
    topicPatches = [];
    topicPatchFails = false;
    vi.mocked(showToast).mockClear();
    serveTopics();
  });

  it('the PATCH carries the seed version', async () => {
    renderFeed();
    await editSummary('A summary', 'Mine');

    await waitFor(() => expect(serverTopics[0].summary).toBe('Mine'));
    expect(topicPatches).toEqual([{ id: 'topic-1', body: { summary: 'Mine', version: 1 } }]);
  });

  it('conflict then Overwrite: the retry carries current.version and overwrite', async () => {
    renderFeed();
    await screen.findByDisplayValue('A summary');
    otherPersonEditsTopic('topic-1', { duration_sec: 99 });
    await editSummary('A summary', 'Mine');

    expect(await screen.findByRole('alertdialog')).toBeTruthy();
    await chooseTopic('Overwrite');

    await waitFor(() => expect(serverTopics[0].summary).toBe('Mine'));
    expect(topicPatches.map((p) => p.body)).toEqual([
      { summary: 'Mine', version: 1 },
      { summary: 'Mine', version: 2, overwrite: true },
    ]);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByDisplayValue('Mine')).toBeTruthy();
  });

  it('conflict then Keep theirs: the row shows theirs and nothing more is sent', async () => {
    renderFeed();
    await screen.findByDisplayValue('A summary');
    otherPersonEditsTopic('topic-1', { summary: 'Theirs' });
    await editSummary('A summary', 'Mine');

    await chooseTopic('Keep theirs');

    await waitFor(() => expect(screen.getByDisplayValue('Theirs')).toBeTruthy());
    expect(screen.queryByDisplayValue('Mine')).toBeNull();
    expect(topicPatches).toHaveLength(1);
  });

  it('dismiss keeps the text; refocus and blur shows the dialog again (the startEdit guard)', async () => {
    renderFeed();
    await screen.findByDisplayValue('A summary');
    otherPersonEditsTopic('topic-1', { summary: 'Theirs' });
    await editSummary('A summary', 'Mine');

    await escapeTopicDialog();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    // The 409's `current` is in the cache by now; the operator's text must survive a refocus.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const el = screen.getByDisplayValue('Mine');
    fireEvent.focus(el);
    expect(screen.getByDisplayValue('Mine')).toBe(el);
    await blurTopicField(el);

    expect(await screen.findByRole('alertdialog')).toBeTruthy();
    expect(topicPatches.map((p) => p.body)).toEqual([
      { summary: 'Mine', version: 1 },
      { summary: 'Mine', version: 1 },
    ]);
    expect(serverTopics[0].summary).toBe('Theirs');
  });

  it('an Overwrite that pulled in a sibling change, then a blur of that untouched sibling: nothing stale is sent', async () => {
    renderFeed();
    const summary = await screen.findByDisplayValue('A summary');
    const time = within(summary.closest('tr') as HTMLElement).getByDisplayValue('00:00:10:00');
    otherPersonEditsTopic('topic-1', { duration_sec: 99 });
    fireEvent.focus(summary);
    fireEvent.change(summary, { target: { value: 'Mine' } });
    // A sibling holds unsaved text, so the row keeps its edit through the save.
    fireEvent.focus(time);
    fireEvent.change(time, { target: { value: '00:09:09:00' } });
    await blurTopicField(summary);
    await chooseTopic('Overwrite');
    await waitFor(() => expect(serverTopics[0].summary).toBe('Mine'));

    const duration = await screen.findByDisplayValue('99');
    fireEvent.focus(duration);
    await blurTopicField(duration);

    expect(topicPatches.filter((p) => 'duration_sec' in p.body)).toEqual([]);
    expect(serverTopics[0].duration_sec).toBe(99);
  });

  it('a server error shows a toast and keeps the edit', async () => {
    renderFeed();
    topicPatchFails = true;
    await editSummary('A summary', 'Mine');

    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Topic save failed.', true));
    expect(screen.getByDisplayValue('Mine')).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('one dialog serves the whole feed: two rows in conflict are asked one after the other', async () => {
    renderFeed();
    // Both rows are typed into before either save is sent (a refetch after the first conflict
    // would otherwise show the second row's new text before the operator typed over it).
    const first = await screen.findByDisplayValue('A summary');
    const second = screen.getByDisplayValue('Second summary');
    fireEvent.focus(first);
    fireEvent.change(first, { target: { value: 'Mine 1' } });
    fireEvent.focus(second);
    fireEvent.change(second, { target: { value: 'Mine 2' } });
    otherPersonEditsTopic('topic-1', { summary: 'Theirs 1' });
    otherPersonEditsTopic('topic-2', { summary: 'Theirs 2' });
    await blurTopicField(first);
    await blurTopicField(second);

    await screen.findByRole('alertdialog');
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    expect(screen.getByRole('alertdialog').textContent).toContain('Theirs 1');

    await chooseTopic('Keep theirs');
    await waitFor(() => expect(screen.getByRole('alertdialog').textContent).toContain('Theirs 2'));
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    await chooseTopic('Keep theirs');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(topicPatches).toHaveLength(2);
  });
});

// redesign-show-ignition 11.3 item e follow-up: the heading reads like the Event feed's
// ("10 events"): sentence case, singular at one.
describe('TopicsFeed heading copy', () => {
  it.each([
    [1, '1 topic'],
    [2, '2 topics'],
  ])('%i topic(s) reads "%s"', async (n, label) => {
    mockedApiFetch.mockImplementation(async (path: string) => {
      if (path.includes('/status')) return statusFixture();
      if (path.includes('/transcript-words')) return { words: [] };
      if (path.includes('/topics'))
        return {
          topics: Array.from({ length: n }, (_, i) =>
            topicFixture({ id: `topic-${i}`, ordinal: i }),
          ),
        };
      throw new Error(`unexpected apiFetch call: ${path}`);
    });
    renderFeed();
    await waitFor(() =>
      expect(screen.getByRole('status', { name: 'Topics feed' }).textContent).toBe(label),
    );
  });
});

// Finish review fix round 1: below md the feed drops the Duration and Level columns (they fold
// under the session time in each row), so the summary wraps inside a 390px card.
describe('TopicsFeed on phones', () => {
  it('has no Duration or Level column header', async () => {
    const original = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(max-width: 767px)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    mockedApiFetch.mockImplementation(async (path: string) => {
      if (path.includes('/status')) return statusFixture();
      if (path.includes('/transcript-words')) return { words: [] };
      if (path.includes('/topics')) return { topics: [topicFixture()] };
      throw new Error(`unexpected apiFetch call: ${path}`);
    });
    try {
      renderFeed();
      await screen.findByDisplayValue('00:00:10:00');
      expect(screen.queryByRole('columnheader', { name: /Duration/ })).toBeNull();
      expect(screen.queryByRole('columnheader', { name: 'Level' })).toBeNull();
      expect(screen.getByRole('columnheader', { name: 'Summary' })).not.toBeNull();
      expect(screen.getByLabelText('Duration (s)')).not.toBeNull();
    } finally {
      window.matchMedia = original;
    }
  });
});
