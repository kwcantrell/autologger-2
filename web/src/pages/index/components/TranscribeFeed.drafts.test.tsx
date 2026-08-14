import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../../../api/client';
import type { SessionStatus, TranscriptWord } from '../../../api/types';
import { renderStrict } from '../../../test/renderStrict';
import { TranscribeFeed } from './TranscribeFeed';

// --- TranscribeFeed edit drafts across a virtual unmount (data-loss regression) ---
//
// This feed virtualizes its rows, and React fires NO blur when the virtualizer
// unmounts one. While a row's edit lived in its own `useState`, wheel-scrolling
// past a half-typed correction destroyed it silently: the row unmounted with
// nothing committed and nothing remembered, and scrolling back rendered the
// server text again — no error, no toast. That is the same failure EventLogSheet
// answered with a feed-owned draft store, and this feed now shares the
// primitive (`utils/draftStore`) rather than carrying a second copy of it.
//
// jsdom has no layout engine, so `@tanstack/react-virtual` is mocked here the
// way EventLogSheet.virtualization.test.tsx mocks it: a controllable window
// rather than a render-everything stub, because the unmount IS the bug.

vi.mock('../../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/client')>();
  return { ...actual, apiFetch: vi.fn() };
});

const virtualMock = vi.hoisted(() => ({
  /** Rendered window, [first, last) in row indexes. Moved per test. */
  first: 0,
  last: Number.POSITIVE_INFINITY,
  size: 0,
  /** Re-renders the feed after the window is moved — the real virtualizer's
   *  scroll subscription, which jsdom cannot drive for want of layout. */
  bump: null as null | (() => void),
}));

vi.mock('@tanstack/react-virtual', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-virtual')>();
  const { useState } = await import('react');
  return {
    ...actual,
    useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: () => number }) => {
      const [, force] = useState(0);
      virtualMock.bump = () => force((n) => n + 1);
      const size = estimateSize();
      virtualMock.size = size;
      const first = Math.min(virtualMock.first, count);
      const last = Math.min(virtualMock.last, count);
      const win = last <= first ? [] : Array.from({ length: last - first }, (_, i) => first + i);
      return {
        getVirtualItems: () =>
          win.map((index) => ({
            index,
            start: index * size,
            end: (index + 1) * size,
            key: index,
          })),
        getTotalSize: () => count * size,
        scrollToIndex: vi.fn(),
      };
    },
  };
});

class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof window.ResizeObserver === 'undefined') {
  window.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
}

const mockedApiFetch = vi.mocked(apiFetch);
const SESSION_ID = 'sess-transcribe-drafts-1';
const WORD_COUNT = 20;

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
    title: 'Transcribe drafts test session',
    deck_title: '',
    show_name: null,
    show_code: null,
    episode: '',
    session_created_at_utc: null,
    now_utc: '2026-07-28T12:00:30Z',
    notes: '',
    show_id: null,
    events_stream_revision: 1,
  };
}

function wordsFixture(count: number): TranscriptWord[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `w-${i}`,
    session_time: `00:00:${String(10 + i).padStart(2, '0')}:00`,
    speaker: '0',
    word: `word-${i}`,
    start_sec: 0,
    end_sec: 0,
    ordinal: i,
  }));
}

/** The served word list, mutable so a PATCH persists the way a real backend
 *  does — the refetch after a commit must carry the committed row. */
let serverWords: TranscriptWord[] = [];

/** Field names whose PATCH must reject — the state in which the feed
 *  deliberately KEEPS the operator's draft so the text stays recoverable. */
let patchFailsFor = new Set<string>();

beforeEach(() => {
  virtualMock.first = 0;
  virtualMock.last = Number.POSITIVE_INFINITY;
  patchFailsFor = new Set();
  serverWords = wordsFixture(WORD_COUNT);
  mockedApiFetch.mockReset();
  mockedApiFetch.mockImplementation(async (path: string, opts: RequestInit = {}) => {
    if (path === 'transcript-generation/status') return { in_flight: false };
    if (path.includes('/status')) return statusFixture();
    if (path.includes('/transcript-words/') && opts.method === 'PATCH') {
      const wordId = path.split('/transcript-words/')[1];
      const patch = JSON.parse(String(opts.body)) as Partial<TranscriptWord>;
      if (Object.keys(patch).some((field) => patchFailsFor.has(field))) {
        throw new Error('save failed');
      }
      const index = serverWords.findIndex((w) => w.id === wordId);
      if (index < 0) throw new Error(`unknown word: ${wordId}`);
      const updated = { ...serverWords[index], ...patch };
      serverWords = [...serverWords];
      serverWords[index] = updated;
      return updated;
    }
    if (path.includes('/transcript-words')) return { words: serverWords };
    throw new Error(`unexpected apiFetch call: ${path}`);
  });
});

function renderFeed() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderStrict(
    <QueryClientProvider client={queryClient}>
      <TranscribeFeed sessionId={SESSION_ID} />
    </QueryClientProvider>,
  );
}

/** Move the rendered window and re-render off it — the mock's stand-in for the
 *  scroll subscription the real virtualizer has. Only the WINDOW moves: the
 *  rows' props are untouched, so what this drives is mount/unmount. */
function scrollWindowTo(first: number, last: number) {
  act(() => {
    virtualMock.first = first;
    virtualMock.last = last;
    virtualMock.bump?.();
  });
}

function wordInput(word: string): HTMLInputElement {
  return screen.getByDisplayValue(word) as HTMLInputElement;
}

describe('TranscribeFeed edit drafts', () => {
  it('restores an in-progress edit when the virtualizer unmounts and remounts the row', async () => {
    virtualMock.first = 0;
    virtualMock.last = 3;
    renderFeed();
    await waitFor(() => expect(screen.getByDisplayValue('word-0')).toBeTruthy());

    const input = wordInput('word-0');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'half-typed correction' } });

    // Scroll far enough that w-0 leaves the window entirely. No blur fires.
    scrollWindowTo(10, 13);
    expect(screen.queryByDisplayValue('half-typed correction')).toBeNull();

    // ...and back. Before the draft store this rendered the server text again.
    scrollWindowTo(0, 3);
    expect(screen.getByDisplayValue('half-typed correction')).toBeTruthy();
    // Untyped rows are untouched, and no other row inherits the draft.
    expect(screen.getByDisplayValue('word-1')).toBeTruthy();
  });

  it('drops the draft once the update has round-tripped', async () => {
    virtualMock.first = 0;
    virtualMock.last = 3;
    renderFeed();
    await waitFor(() => expect(screen.getByDisplayValue('word-0')).toBeTruthy());

    const input = wordInput('word-0');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'committed word' } });
    await act(async () => {
      fireEvent.blur(input, { target: { value: 'committed word' } });
    });

    await waitFor(() => expect(serverWords[0].word).toBe('committed word'));
    // Let the mutation's own continuation (which forgets the draft) run.
    await act(async () => {});

    scrollWindowTo(10, 13);
    scrollWindowTo(0, 3);

    // Server state, not a stale draft shadowing it — and nothing reverted.
    expect(screen.getByDisplayValue('committed word')).toBeTruthy();
  });

  // --- A save drops only the fields it PERSISTED (review finding 1) ---
  //
  // A row commits ONE blurred field at a time, so the PATCH carries one field —
  // but the save-resolution clear used to measure the row's WHOLE stored draft
  // against itself. Every untouched sibling field trivially matched, so nothing
  // looked diverged and all of them were dropped: the next remount rendered the
  // server text for corrections no save had ever sent. `DraftStore#clearMatching`
  // now takes the covered field set explicitly, and this feed passes exactly
  // what it PATCHed.
  //
  // The unmount/remount round trip is load-bearing in both tests below: until
  // the row unmounts, its own `edit` state still shows the text whether or not
  // the store kept it.

  it('keeps an uncommitted sibling-field draft when a single-field save round-trips', async () => {
    virtualMock.first = 0;
    virtualMock.last = 3;
    renderFeed();
    await waitFor(() => expect(screen.getByDisplayValue('word-0')).toBeTruthy());

    // Typed into `word` and never blurred: nothing PATCHed it, and the draft
    // store is the only copy.
    const word = wordInput('word-0');
    fireEvent.focus(word);
    fireEvent.change(word, { target: { value: 'uncommitted correction' } });

    // A DIFFERENT field of the same row is then edited and committed, so the
    // PATCH carries `session_time` alone.
    const time = wordInput('00:00:10:00');
    fireEvent.focus(time);
    fireEvent.change(time, { target: { value: '00:01:30:00' } });
    await act(async () => {
      fireEvent.blur(time, { target: { value: '00:01:30:00' } });
    });
    await waitFor(() => expect(serverWords[0].session_time).toBe('00:01:30:00'));
    // Let the mutation's own continuation (which forgets the spent draft) run.
    await act(async () => {});
    // Nothing persisted `word` — the server still has the original.
    expect(serverWords[0].word).toBe('word-0');

    scrollWindowTo(10, 13);
    scrollWindowTo(0, 3);

    expect(screen.getByDisplayValue('uncommitted correction')).toBeTruthy();
  });

  it('keeps the text a FAILED save left recoverable when a sibling field saves next', async () => {
    virtualMock.first = 0;
    virtualMock.last = 3;
    patchFailsFor = new Set(['word']);
    renderFeed();
    await waitFor(() => expect(screen.getByDisplayValue('word-0')).toBeTruthy());

    // The `word` save fails, so the feed deliberately keeps its draft.
    const word = wordInput('word-0');
    fireEvent.focus(word);
    fireEvent.change(word, { target: { value: 'failed but kept' } });
    await act(async () => {
      fireEvent.blur(word, { target: { value: 'failed but kept' } });
    });
    await act(async () => {});
    expect(serverWords[0].word).toBe('word-0');

    // A sibling field then saves successfully. It persisted nothing about
    // `word`, so it must not discard what the failure kept.
    const time = wordInput('00:00:10:00');
    fireEvent.focus(time);
    fireEvent.change(time, { target: { value: '00:01:30:00' } });
    await act(async () => {
      fireEvent.blur(time, { target: { value: '00:01:30:00' } });
    });
    await waitFor(() => expect(serverWords[0].session_time).toBe('00:01:30:00'));
    await act(async () => {});

    scrollWindowTo(10, 13);
    scrollWindowTo(0, 3);

    expect(screen.getByDisplayValue('failed but kept')).toBeTruthy();
  });
});
