import { fireEvent, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
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
// stub it globally for this file. Since session-edit-conflicts (D9, D10
// category 5) the topic save lives in TopicsFeed, which hands the row an
// `onUpdate` prop like TranscribeRow's; these cases assert what the row asks
// `onUpdate` to save, and the request itself (body, version guard) is tested in
// TopicsFeed.test.tsx.

class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof window !== 'undefined' && typeof window.ResizeObserver === 'undefined') {
  window.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
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
    created_at_utc: '2026-07-21T00:00:00Z',
    ...overrides,
  };
}

function renderRow(overrides: Partial<ComponentProps<typeof TopicsRow>> = {}) {
  const onJump = vi.fn();
  const onUpdate = vi.fn(async () => undefined);
  const utils = renderStrict(
    <table>
      <tbody>
        <TopicsRow
          row={topicFixture()}
          onUpdate={onUpdate}
          fps={24}
          onJump={onJump}
          jumpUnavailable={false}
          jumpReasonId="v5-topics-feed-jump-reason"
          transcriptAnchored={true}
          {...overrides}
        />
      </tbody>
    </table>,
  );
  return { ...utils, onJump, onUpdate };
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
  it('all four fields still focus and commit on blur', () => {
    const { onUpdate } = renderRow({ row: topicFixture() });

    const timeInput = screen.getByDisplayValue('00:00:10:00');
    fireEvent.focus(timeInput);
    fireEvent.change(timeInput, { target: { value: '00:00:20:00' } });
    fireEvent.blur(timeInput);
    expect(onUpdate).toHaveBeenLastCalledWith(
      'topic-1',
      { session_time: '00:00:20:00' },
      expect.any(Function),
    );

    const durationInput = screen.getByDisplayValue('30');
    fireEvent.focus(durationInput);
    fireEvent.change(durationInput, { target: { value: '45' } });
    fireEvent.blur(durationInput);
    expect(onUpdate).toHaveBeenLastCalledWith(
      'topic-1',
      { duration_sec: 45 },
      expect.any(Function),
    );

    const levelInput = screen.getByDisplayValue('1');
    fireEvent.focus(levelInput);
    fireEvent.change(levelInput, { target: { value: '3' } });
    fireEvent.blur(levelInput);
    expect(onUpdate).toHaveBeenLastCalledWith('topic-1', { topic_level: 3 }, expect.any(Function));

    const summaryInput = screen.getByDisplayValue('A summary');
    fireEvent.focus(summaryInput);
    fireEvent.change(summaryInput, { target: { value: 'New summary' } });
    fireEvent.blur(summaryInput);
    expect(onUpdate).toHaveBeenLastCalledWith(
      'topic-1',
      { summary: 'New summary' },
      expect.any(Function),
    );
  });

  it('activating the jump control focuses no field and begins no edit', () => {
    const { onUpdate } = renderRow({ row: topicFixture() });
    const tcInput = screen.getByDisplayValue('00:00:10:00');

    fireEvent.click(screen.getByRole('button', { name: /Jump to/ }));

    expect(document.activeElement).not.toBe(tcInput);
    expect(onUpdate).not.toHaveBeenCalled();
  });
});

// --- commitField dirty check (feed-row-seek, task 9.2) ---
//
// Before this task, `commitField` fired the save unconditionally on
// blur — mirrors the same defect fixed in `TranscribeRow`. Mirrors
// `EventLogRow.handleBlur`'s dirty check (compare the committed/coerced value
// against the row's current field value; skip the mutation when they match),
// without `EventLogRow`'s `setTimeout` defer or `row.contains(activeElement)`
// check — those exist there for an aggregate multi-field save with a
// sibling-focus race; each TopicsRow field commits independently on its own
// blur, so there is no such race here.
describe('TopicsRow — commitField dirty check (task 9.2)', () => {
  it('blurring an unchanged session_time field issues no PATCH', () => {
    const { onUpdate } = renderRow({ row: topicFixture({ session_time: '00:00:10:00' }) });
    const timeInput = screen.getByDisplayValue('00:00:10:00');

    fireEvent.focus(timeInput);
    fireEvent.blur(timeInput);

    // `onUpdate` is called synchronously from the blur handler, so absence is
    // meaningful immediately.
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('blurring an unchanged numeric field (duration_sec) issues no PATCH despite Number coercion', () => {
    const { onUpdate } = renderRow({ row: topicFixture({ duration_sec: 30 }) });
    const durationInput = screen.getByDisplayValue('30');

    fireEvent.focus(durationInput);
    fireEvent.blur(durationInput);

    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('a CHANGED field still commits exactly as before, same PATCH payload', () => {
    const { onUpdate } = renderRow({ row: topicFixture({ session_time: '00:00:10:00' }) });
    const timeInput = screen.getByDisplayValue('00:00:10:00');

    fireEvent.focus(timeInput);
    fireEvent.change(timeInput, { target: { value: '00:00:20:00' } });
    fireEvent.blur(timeInput);

    expect(onUpdate).toHaveBeenLastCalledWith(
      'topic-1',
      { session_time: '00:00:20:00' },
      expect.any(Function),
    );
  });

  it('focusing a field, changing nothing, then activating the jump fires no PATCH', () => {
    const { onJump, onUpdate } = renderRow({ row: topicFixture({ session_time: '00:00:10:00' }) });
    const timeInput = screen.getByDisplayValue('00:00:10:00');

    fireEvent.focus(timeInput);
    fireEvent.click(screen.getByRole('button', { name: /Jump to/ }));
    fireEvent.blur(timeInput);

    expect(onJump).toHaveBeenCalledWith(10);
    expect(onUpdate).not.toHaveBeenCalled();
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

// shadcn-port-workspace D3 / task 3.2: the row renders through TableRow / TableCell, and its
// cells keep exactly the class lists they had before the port (the primitives carry no visual
// base; the snapshot was written against the raw <tr>/<td> markup).
describe('TopicsRow on the shadcn Table parts', () => {
  it('is a table-row of table-cells with unchanged cell classes', () => {
    renderRow();
    const tr = document.querySelector('tbody > tr') as HTMLTableRowElement;
    const cells = Array.from(tr.querySelectorAll(':scope > td'));
    expect({ row: tr.className, cells: cells.map((td) => td.className) }).toMatchSnapshot();
    expect(tr.getAttribute('data-slot')).toBe('table-row');
    for (const td of cells) expect(td.getAttribute('data-slot')).toBe('table-cell');
  });
});

// Finish review fix round 1: on phones Duration and Level fold under the session time (each with
// a visible short label), so the summary keeps the rest of the row and wraps there instead of
// pushing the table into a sideways scroll.
describe('TopicsRow folded for phones', () => {
  it('folds duration and level under the time and leaves the summary its own cell', () => {
    renderRow({ folded: true });
    const tr = document.querySelector('tbody > tr') as HTMLTableRowElement;
    const cells = Array.from(tr.querySelectorAll(':scope > td'));
    expect(cells).toHaveLength(3);
    expect(cells[1].contains(screen.getByDisplayValue('00:00:10:00'))).toBe(true);
    const duration = screen.getByLabelText('Duration (s)');
    const level = screen.getByLabelText('Level');
    expect(cells[1].contains(duration)).toBe(true);
    expect(cells[1].contains(level)).toBe(true);
    expect((duration as HTMLInputElement).value).toBe('30');
    expect((level as HTMLInputElement).value).toBe('1');
    expect(cells[2].contains(screen.getByDisplayValue('A summary'))).toBe(true);
  });

  it('keeps five cells on desktop', () => {
    renderRow();
    const tr = document.querySelector('tbody > tr') as HTMLTableRowElement;
    expect(tr.querySelectorAll(':scope > td')).toHaveLength(5);
  });
});

// Finish review fix round 2: the folded line reads as the desktop headers do, in words and in
// normal case ("Duration 30s · Level 1"), not tracked-caps abbreviations.
describe('TopicsRow folded labels', () => {
  it('reads Duration <n>s and Level <n> in normal case', () => {
    renderRow({ folded: true });
    const durationPair = screen.getByLabelText('Duration (s)').parentElement as HTMLElement;
    const levelPair = screen.getByLabelText('Level').parentElement as HTMLElement;
    expect(durationPair.textContent).toBe('Durations');
    expect(levelPair.textContent).toBe('Level');
    const line = durationPair.parentElement as HTMLElement;
    expect(line.contains(levelPair)).toBe(true);
    expect(line.className).not.toMatch(/\buppercase\b/);
    expect(line.className).not.toMatch(/tracking-\[/);
    expect(line.className).toMatch(/text-muted-foreground/);
    expect(screen.queryByText('Dur')).toBeNull();
    expect(screen.queryByText('Lvl')).toBeNull();
  });
});
