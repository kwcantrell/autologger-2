import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../../../api/client';
import type { SessionTopic } from '../../../api/types';
import { renderStrict } from '../../../test/renderStrict';
import { transcriptWhollyAnchorless } from './TopicsFeed';
import { TopicsRow } from './TopicsRow';

// --- TopicsRow jump cell (feed-row-seek, task 8.1/8.2/8.3) ---
//
// TopicsFeed owns `useTimelineSeek` (design D7) and hands each row a stable
// `onJump` + the feed-wide `jumpUnavailable`/`jumpReasonId`, mirroring
// EventLogRow/TranscribeRow. Resolution, though, mirrors TranscribeRow, not
// EventLogRow: TopicsRow has the SAME edit-buffer situation
// (`vals.session_time` is the uncommitted buffer while the field has focus,
// design D4's "stored, not displayed" distinction is only visible inside the
// row), so TopicsRow resolves its OWN position from `row.session_time`
// (never `vals`), via the module-private `topicsRowTimelineSec` — exercised
// only indirectly here, through the rendered `TopicsRow` (it has no
// importers outside this file, so it is not exported; quality fix wave,
// FIX 4). Unlike Transcript, Topics has no numeric fallback field on the wire
// (`SessionTopic` carries only the string) — an unparseable/empty
// session_time is simply unresolvable, full stop.
//
// Frame arithmetic itself (D3) is covered by shared/utils/timelineSec.test.ts;
// these tests fix fps=24 throughout.
//
// Task 8.3 (spec "Topic jumps require an anchored transcript"): Topic
// session_time values are model-authored. When the session's transcript is
// wholly anchorless the model had no [HH:MM:SS] prefixes to copy and
// invented elapsed-from-zero times that parse perfectly — so a
// `transcriptAnchored` prop (computed once by TopicsFeed from the session's
// transcript words, passed down like `fps`) gates resolution ahead of the
// per-row parse, and `transcriptWhollyAnchorless` (the feed-level predicate)
// is unit-tested directly too.
//
// Setup: jsdom has no ResizeObserver, and TopicsRow constructs one
// unconditionally in a useLayoutEffect (the summary textarea auto-grow) —
// stub it globally for this file. TopicsRow calls `useUpdateTopic`
// internally (unlike TranscribeRow, which receives `onUpdate` as a prop), so
// every render needs a QueryClientProvider, and `apiFetch` is mocked at the
// module boundary so blur-commits resolve without a real network call.

class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof window !== 'undefined' && typeof window.ResizeObserver === 'undefined') {
  window.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
}

vi.mock('../../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/client')>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

beforeEach(() => {
  mockedApiFetch.mockReset();
  mockedApiFetch.mockResolvedValue({});
});

function topicFixture(overrides: Partial<SessionTopic> = {}): SessionTopic {
  return {
    id: 'topic-1',
    session_time: '00:00:10:00',
    duration_sec: 30,
    topic_level: 1,
    summary: 'A summary',
    ordinal: 0,
    created_at_utc: '2026-07-21T00:00:00Z',
    ...overrides,
  };
}

function renderRow(overrides: Partial<ComponentProps<typeof TopicsRow>> = {}) {
  const onJump = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = renderStrict(
    <QueryClientProvider client={client}>
      <table>
        <tbody>
          <TopicsRow
            row={topicFixture()}
            sessionId="sess-1"
            fps={24}
            onJump={onJump}
            jumpUnavailable={false}
            jumpReasonId="v5-topics-feed-jump-reason"
            transcriptAnchored={true}
            {...overrides}
          />
        </tbody>
      </table>
    </QueryClientProvider>,
  );
  return { ...utils, onJump };
}

describe('TopicsRow — jump control resolution (design D3/D4)', () => {
  it('resolves a parseable stored session_time via the D3 converter', () => {
    // 00:00:10:00 @ 24fps -> 240 frames / 24 = 10s.
    const { onJump } = renderRow({ row: topicFixture({ session_time: '00:00:10:00' }) });

    fireEvent.click(screen.getByRole('button', { name: /Jump to/ }));

    expect(onJump).toHaveBeenCalledWith(10);
  });

  it('renders no control for an empty session_time', () => {
    renderRow({ row: topicFixture({ session_time: '' }) });

    expect(screen.queryByRole('button', { name: /Jump to/ })).toBeNull();
  });

  it('renders no control for an unparseable session_time', () => {
    renderRow({ row: topicFixture({ session_time: 'not-a-time' }) });

    expect(screen.queryByRole('button', { name: /Jump to/ })).toBeNull();
  });

  it('resolves from the STORED session_time, not the uncommitted edit buffer', () => {
    const { onJump } = renderRow({ row: topicFixture({ session_time: '00:00:10:00' }) });
    const tcInput = screen.getByDisplayValue('00:00:10:00');

    // Focus + type without blurring: the edit buffer now holds a DIFFERENT,
    // uncommitted session_time. The resolved jump target must be unaffected.
    fireEvent.focus(tcInput);
    fireEvent.change(tcInput, { target: { value: '00:05:00:00' } });

    fireEvent.click(screen.getByRole('button', { name: /Jump to/ }));

    expect(onJump).toHaveBeenCalledWith(10);
    expect(onJump).not.toHaveBeenCalledWith(300);
  });
});

describe('TopicsRow — inline editing untouched', () => {
  it('all four fields still focus and commit on blur', async () => {
    renderRow({ row: topicFixture() });

    const timeInput = screen.getByDisplayValue('00:00:10:00');
    fireEvent.focus(timeInput);
    fireEvent.change(timeInput, { target: { value: '00:00:20:00' } });
    fireEvent.blur(timeInput);
    await waitFor(() =>
      expect(mockedApiFetch).toHaveBeenLastCalledWith(
        'sessions/sess-1/topics/topic-1',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ session_time: '00:00:20:00' }),
        }),
      ),
    );

    const durationInput = screen.getByDisplayValue('30');
    fireEvent.focus(durationInput);
    fireEvent.change(durationInput, { target: { value: '45' } });
    fireEvent.blur(durationInput);
    await waitFor(() =>
      expect(mockedApiFetch).toHaveBeenLastCalledWith(
        'sessions/sess-1/topics/topic-1',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ duration_sec: 45 }),
        }),
      ),
    );

    const levelInput = screen.getByDisplayValue('1');
    fireEvent.focus(levelInput);
    fireEvent.change(levelInput, { target: { value: '3' } });
    fireEvent.blur(levelInput);
    await waitFor(() =>
      expect(mockedApiFetch).toHaveBeenLastCalledWith(
        'sessions/sess-1/topics/topic-1',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ topic_level: 3 }),
        }),
      ),
    );

    const summaryInput = screen.getByDisplayValue('A summary');
    fireEvent.focus(summaryInput);
    fireEvent.change(summaryInput, { target: { value: 'New summary' } });
    fireEvent.blur(summaryInput);
    await waitFor(() =>
      expect(mockedApiFetch).toHaveBeenLastCalledWith(
        'sessions/sess-1/topics/topic-1',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ summary: 'New summary' }),
        }),
      ),
    );
  });

  it('activating the jump control focuses no field and begins no edit', () => {
    renderRow({ row: topicFixture() });
    const tcInput = screen.getByDisplayValue('00:00:10:00');

    fireEvent.click(screen.getByRole('button', { name: /Jump to/ }));

    expect(document.activeElement).not.toBe(tcInput);
    expect(mockedApiFetch).not.toHaveBeenCalled();
  });
});

// --- commitField dirty check (feed-row-seek, task 9.2) ---
//
// Before this task, `commitField` fired `update.mutate` unconditionally on
// blur — mirrors the same defect fixed in `TranscribeRow`. Mirrors
// `EventLogRow.handleBlur`'s dirty check (compare the committed/coerced value
// against the row's current field value; skip the mutation when they match),
// without `EventLogRow`'s `setTimeout` defer or `row.contains(activeElement)`
// check — those exist there for an aggregate multi-field save with a
// sibling-focus race; each TopicsRow field commits independently on its own
// blur, so there is no such race here.
describe('TopicsRow — commitField dirty check (task 9.2)', () => {
  it('blurring an unchanged session_time field issues no PATCH', async () => {
    renderRow({ row: topicFixture({ session_time: '00:00:10:00' }) });
    const timeInput = screen.getByDisplayValue('00:00:10:00');

    fireEvent.focus(timeInput);
    fireEvent.blur(timeInput);

    // A mutation's fetch call lands asynchronously relative to the blur
    // event (react-query schedules it), so flush before asserting absence —
    // an immediate synchronous check would pass trivially either way.
    await new Promise((r) => setTimeout(r, 20));
    expect(mockedApiFetch).not.toHaveBeenCalled();
  });

  it('blurring an unchanged numeric field (duration_sec) issues no PATCH despite Number coercion', async () => {
    renderRow({ row: topicFixture({ duration_sec: 30 }) });
    const durationInput = screen.getByDisplayValue('30');

    fireEvent.focus(durationInput);
    fireEvent.blur(durationInput);

    await new Promise((r) => setTimeout(r, 20));
    expect(mockedApiFetch).not.toHaveBeenCalled();
  });

  it('a CHANGED field still commits exactly as before, same PATCH payload', async () => {
    renderRow({ row: topicFixture({ session_time: '00:00:10:00' }) });
    const timeInput = screen.getByDisplayValue('00:00:10:00');

    fireEvent.focus(timeInput);
    fireEvent.change(timeInput, { target: { value: '00:00:20:00' } });
    fireEvent.blur(timeInput);

    await waitFor(() =>
      expect(mockedApiFetch).toHaveBeenLastCalledWith(
        'sessions/sess-1/topics/topic-1',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ session_time: '00:00:20:00' }),
        }),
      ),
    );
  });

  it('focusing a field, changing nothing, then activating the jump fires no PATCH', async () => {
    const { onJump } = renderRow({ row: topicFixture({ session_time: '00:00:10:00' }) });
    const timeInput = screen.getByDisplayValue('00:00:10:00');

    fireEvent.focus(timeInput);
    fireEvent.click(screen.getByRole('button', { name: /Jump to/ }));
    fireEvent.blur(timeInput);

    expect(onJump).toHaveBeenCalledWith(10);
    await new Promise((r) => setTimeout(r, 20));
    expect(mockedApiFetch).not.toHaveBeenCalled();
  });
});

describe('TopicsRow — feed-wide gate (design D5/D7)', () => {
  it('renders aria-disabled with the shared reason id when jump is unavailable, and activation no-ops', () => {
    const { onJump } = renderRow({ jumpUnavailable: true, jumpReasonId: 'shared-reason-x' });
    const btn = screen.getByRole('button', { name: /Jump to/ });

    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(btn.getAttribute('aria-describedby')).toBe('shared-reason-x');

    fireEvent.click(btn);
    expect(onJump).not.toHaveBeenCalled();
  });
});

describe('TopicsRow — topic jumps require an anchored transcript (spec, task 8.3)', () => {
  it('renders no control while the transcript is wholly anchorless, even for a parseable session_time', () => {
    renderRow({
      row: topicFixture({ session_time: '00:00:10:00' }),
      transcriptAnchored: false,
    });

    expect(screen.queryByRole('button', { name: /Jump to/ })).toBeNull();
  });

  it('renders a control when the transcript is anchored and the session_time parses', () => {
    renderRow({
      row: topicFixture({ session_time: '00:00:10:00' }),
      transcriptAnchored: true,
    });

    expect(screen.getByRole('button', { name: /Jump to/ })).toBeTruthy();
  });
});

describe('transcriptWhollyAnchorless (feed-level predicate, task 8.3)', () => {
  it('is true when every word has an empty session_time', () => {
    expect(
      transcriptWhollyAnchorless([
        // biome-ignore lint/suspicious/noExplicitAny: minimal TranscriptWord shape for the predicate
        { session_time: '' } as any,
        // biome-ignore lint/suspicious/noExplicitAny: minimal TranscriptWord shape for the predicate
        { session_time: '  ' } as any,
      ]),
    ).toBe(true);
  });

  it('is false when at least one word carries a session_time', () => {
    expect(
      transcriptWhollyAnchorless([
        // biome-ignore lint/suspicious/noExplicitAny: minimal TranscriptWord shape for the predicate
        { session_time: '' } as any,
        // biome-ignore lint/suspicious/noExplicitAny: minimal TranscriptWord shape for the predicate
        { session_time: '00:00:05:00' } as any,
      ]),
    ).toBe(false);
  });

  it('is false for an EMPTY transcript (no words at all) — a real hand-entered-topics case, not a degenerate one', () => {
    expect(transcriptWhollyAnchorless([])).toBe(false);
  });
});
