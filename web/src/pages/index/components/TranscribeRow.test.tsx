import { fireEvent, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { TranscriptWord } from '../../../api/types';
import { renderStrict } from '../../../test/renderStrict';
import { TranscribeRow } from './TranscribeRow';

// --- TranscribeRow jump cell (feed-row-seek, task 7.1/7.2) ---
//
// TranscribeFeed owns `useTimelineSeek` (design D7) and hands each row a
// stable `onJump` + the feed-wide `jumpUnavailable`/`jumpReasonId`, but —
// unlike EventLogRow — TranscribeRow resolves its OWN position, because the
// resolution rule (design D4) hinges on a distinction only the row can make:
// `vals.session_time` is the UNCOMMITTED edit buffer while the session-time
// field has focus, but the jump must target the last COMMITTED value —
// `row.session_time`, via the frame-arithmetic converter — falling back to
// `row.start_sec` only when that string does not parse. Resolving in the
// parent (from a plain `TranscriptWord` snapshot) would be indistinguishable
// from resolving from the row's own `row` prop, so the row does it directly
// against `row`, never against `vals`/`edit`.
//
// Frame arithmetic itself (D3) is covered by shared/utils/timelineSec.test.ts;
// these tests fix fps=24 throughout and only exercise the D4 precedence rule
// (string-over-number) and the anchorless/no-control case.

function wordFixture(overrides: Partial<TranscriptWord> = {}): TranscriptWord {
  return {
    id: 'w-1',
    session_id: 'sess-1',
    session_time: '00:00:10:00',
    speaker: '0',
    word: 'hello',
    start_sec: 0,
    end_sec: 0,
    ordinal: 0,
    created_at_utc: '2026-07-21T00:00:00Z',
    ...overrides,
  };
}

function renderRow(overrides: Partial<ComponentProps<typeof TranscribeRow>> = {}) {
  const onUpdate = vi.fn();
  const onJump = vi.fn();
  const utils = renderStrict(
    <table>
      <tbody>
        <TranscribeRow
          row={wordFixture()}
          speakerOffset={0}
          onUpdate={onUpdate}
          fps={24}
          onJump={onJump}
          jumpUnavailable={false}
          jumpReasonId="v5-transcribe-feed-jump-reason"
          {...overrides}
        />
      </tbody>
    </table>,
  );
  return { ...utils, onUpdate, onJump };
}

describe('TranscribeRow — jump control resolution (design D4)', () => {
  it('resolves from the STORED session_time, not the uncommitted edit buffer', () => {
    // 00:00:10:00 @ 24fps -> 240 frames / 24 = 10s.
    const { onJump } = renderRow({ row: wordFixture({ session_time: '00:00:10:00' }) });
    const tcInput = screen.getByDisplayValue('00:00:10:00');

    // Focus + type without blurring: `edit`/`vals` now holds a DIFFERENT,
    // uncommitted session_time. The resolved jump target must be unaffected.
    fireEvent.focus(tcInput);
    fireEvent.change(tcInput, { target: { value: '00:05:00:00' } });

    fireEvent.click(screen.getByRole('button', { name: /Jump to/ }));

    expect(onJump).toHaveBeenCalledWith(10);
    expect(onJump).not.toHaveBeenCalledWith(300);
  });

  it('an edited (committed) row resolves to the edited time, not its stale start_sec', () => {
    // 00:00:20:00 @ 24fps -> 480 frames / 24 = 20s; start_sec left stale at 5.
    const { onJump } = renderRow({
      row: wordFixture({ session_time: '00:00:20:00', start_sec: 5 }),
    });

    fireEvent.click(screen.getByRole('button', { name: /Jump to/ }));

    expect(onJump).toHaveBeenCalledWith(20);
    expect(onJump).not.toHaveBeenCalledWith(5);
  });

  it('a hand-inserted row (start_sec === 0, real typed time) resolves to the typed time, not 0', () => {
    // 00:01:00:00 @ 24fps -> 1440 frames / 24 = 60s; insertTranscriptWord
    // omits start_sec, so it defaults to 0 even though the row has a real
    // typed position.
    const { onJump } = renderRow({
      row: wordFixture({ session_time: '00:01:00:00', start_sec: 0 }),
    });

    fireEvent.click(screen.getByRole('button', { name: /Jump to/ }));

    expect(onJump).toHaveBeenCalledWith(60);
    expect(onJump).not.toHaveBeenCalledWith(0);
  });

  it('an anchorless row (empty session_time, zeroed start_sec) renders no control', () => {
    renderRow({ row: wordFixture({ session_time: '', start_sec: 0 }) });

    expect(screen.queryByRole('button', { name: /Jump to/ })).toBeNull();
  });
});

// --- accessible name for the start_sec fallback (whole-branch audit fix
// wave, finding I2) ---
//
// `displayTime` used to be `row.session_time` unconditionally, even when
// `transcribeRowTimelineSec` fell back to `start_sec` (design D4's fallback,
// which fires when the stored string is blank or unparseable). That left the
// button's accessible name identifying an EMPTY or garbage string — "Jump to
// " (no name at all) or "Jump to later" while actually jumping to 742.5s —
// while it silently jumped to a real, different position derived from
// `start_sec`. `formatTimelineSec` (the D3 converter's exact inverse) now
// renders that resolved second back into the same `HH:MM:SS:FF` shape the
// stored-string path would show.
describe('TranscribeRow — jump control accessible name for the start_sec fallback (finding I2)', () => {
  it('names the FORMATTED start_sec when session_time is cleared (blank) but start_sec is live', () => {
    // start_sec=42 @ 24fps -> 1008 frames -> 00:00:42:00.
    renderRow({ row: wordFixture({ session_time: '', start_sec: 42 }) });

    const btn = screen.getByRole('button', { name: 'Jump to 00:00:42:00' });
    expect(btn.getAttribute('aria-label')).toBe('Jump to 00:00:42:00');
  });

  it('names the FORMATTED start_sec when session_time is unparseable garbage but start_sec is live', () => {
    // start_sec=5 @ 24fps -> 120 frames -> 00:00:05:00.
    renderRow({ row: wordFixture({ session_time: 'not-a-timecode', start_sec: 5 }) });

    expect(screen.getByRole('button', { name: 'Jump to 00:00:05:00' })).toBeTruthy();
  });

  it('still names the stored session_time verbatim when it parses (unchanged behavior)', () => {
    renderRow({ row: wordFixture({ session_time: '00:00:10:00', start_sec: 999 }) });

    // start_sec would format to a wildly different time — proves the STRING
    // path, not the fallback, is what named this button.
    expect(screen.getByRole('button', { name: 'Jump to 00:00:10:00' })).toBeTruthy();
  });
});

describe('TranscribeRow — inline editing untouched', () => {
  it('fields still focus and still commit on blur', () => {
    const { onUpdate } = renderRow();
    const wordInput = screen.getByDisplayValue('hello');

    fireEvent.focus(wordInput);
    fireEvent.change(wordInput, { target: { value: 'goodbye' } });
    fireEvent.blur(wordInput);

    expect(onUpdate).toHaveBeenCalledWith('w-1', { word: 'goodbye' });
  });

  it('activating the jump control focuses no field and begins no edit', () => {
    const { onUpdate } = renderRow();
    const tcInput = screen.getByDisplayValue('00:00:10:00');

    fireEvent.click(screen.getByRole('button', { name: /Jump to/ }));

    expect(document.activeElement).not.toBe(tcInput);
    expect(onUpdate).not.toHaveBeenCalled();
  });
});

// --- commitField dirty check (feed-row-seek, task 9.2) ---
//
// Before this task, `commitField` fired `onUpdate` unconditionally on blur —
// `edit` is set by `onFocus`, so it is always truthy by blur time, and the
// early `if (!edit) return;` never actually gates a same-value blur. Mirrors
// `EventLogRow.handleBlur`'s dirty check (compare the committed value against
// the row's current field value; skip the mutation when they match), taking
// only the comparison, not `EventLogRow`'s `setTimeout` defer or its
// `row.contains(document.activeElement)` check — those exist there to let a
// *sibling* field's focus settle before an aggregate multi-field save, which
// has no analogue here: each TranscribeRow field commits independently on
// its OWN blur, so there is no sibling-focus race to defer past.
describe('TranscribeRow — commitField dirty check (task 9.2)', () => {
  it('blurring an unchanged field issues no update', () => {
    const { onUpdate } = renderRow({ row: wordFixture({ session_time: '00:00:10:00' }) });
    const tcInput = screen.getByDisplayValue('00:00:10:00');

    fireEvent.focus(tcInput);
    fireEvent.blur(tcInput);

    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('a CHANGED field still commits exactly as before, same payload shape', () => {
    const { onUpdate } = renderRow({ row: wordFixture({ session_time: '00:00:10:00' }) });
    const tcInput = screen.getByDisplayValue('00:00:10:00');

    fireEvent.focus(tcInput);
    fireEvent.change(tcInput, { target: { value: '00:00:20:00' } });
    fireEvent.blur(tcInput);

    expect(onUpdate).toHaveBeenCalledWith('w-1', { session_time: '00:00:20:00' });
  });

  it('focusing a field, changing nothing, then activating the jump fires no update', () => {
    const { onUpdate, onJump } = renderRow({ row: wordFixture({ session_time: '00:00:10:00' }) });
    const tcInput = screen.getByDisplayValue('00:00:10:00');

    fireEvent.focus(tcInput);
    fireEvent.click(screen.getByRole('button', { name: /Jump to/ }));
    fireEvent.blur(tcInput);

    expect(onJump).toHaveBeenCalledWith(10);
    expect(onUpdate).not.toHaveBeenCalled();
  });
});

describe('TranscribeRow — feed-wide gate (design D5/D7)', () => {
  it('renders aria-disabled with the shared reason id when jump is unavailable, and activation no-ops', () => {
    const { onJump } = renderRow({ jumpUnavailable: true, jumpReasonId: 'shared-reason-x' });
    const btn = screen.getByRole('button', { name: /Jump to/ });

    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(btn.getAttribute('aria-describedby')).toBe('shared-reason-x');

    fireEvent.click(btn);
    expect(onJump).not.toHaveBeenCalled();
  });
});
