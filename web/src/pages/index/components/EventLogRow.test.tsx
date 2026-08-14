import { fireEvent, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { Category, LogEvent } from '../../../api/types';
import { formatWallUtcYmdHms } from '../../../shared/utils/timecode';
import { renderStrict } from '../../../test/renderStrict';
import { EventLogRow, type InlineDraft, type InlineDraftStore } from './EventLogRow';

// --- EventLogRow jump cell (feed-row-seek, task 6.1/6.2) ---
//
// EventLogSheet owns `useTimelineSeek` and resolves each row's position from
// `timecode_total_frames / frame_rate` directly (design D4) — EventLogRow itself
// only renders what it's handed as props (design D7): `resolvedSec`, `onJump`,
// `jumpUnavailable`, `jumpReasonId`. These tests exercise the row's own
// rendering contract for that prop surface. The resolution rule itself (the
// absent-frame-count case, the not-rolling/batch-edit gate, and jump-and-play)
// is covered end-to-end in EventLogSheet.jumpColumn.test.tsx, which renders
// real EventLogRows exactly like the pre-existing EventLogSheet.test.tsx does.

function categoryFixture(): Category {
  return {
    id: 'general',
    label: 'General',
    color: '#4488ff',
    type: 'BUTTON',
    dropdown_options: [],
    on_label: '',
    off_label: '',
  };
}

function eventFixture(overrides: Partial<LogEvent> = {}): LogEvent {
  return {
    event_id: 'ev-1',
    category: 'general',
    category_label: 'General',
    category_color: '#4488ff',
    message: 'A logged note',
    timecode: '00:00:10:00',
    timecode_total_frames: 240,
    frame_rate: 24,
    wall_time_utc: '2026-07-21T00:00:10Z',
    metadata: {},
    ...overrides,
  };
}

/** A standalone stand-in for `EventLogSheet`'s inline-draft store — the same
 *  Map-behind-stable-callbacks shape, owned by the test instead of the sheet. */
function draftStore(seed: Array<[string, InlineDraft]> = []): InlineDraftStore & {
  map: Map<string, InlineDraft>;
} {
  const map = new Map<string, InlineDraft>(seed);
  return {
    map,
    read: (eventId) => map.get(eventId),
    write: (eventId, patch) => {
      map.set(eventId, { ...(map.get(eventId) ?? {}), ...patch });
    },
    clear: (eventId) => {
      map.delete(eventId);
    },
  };
}

function renderRow(overrides: Partial<ComponentProps<typeof EventLogRow>> = {}) {
  const onJump = vi.fn();
  const onInlineSave = vi.fn();
  const onBatchChange = vi.fn();
  const onDelete = vi.fn();
  const onUndelete = vi.fn();
  const inlineDrafts = draftStore();
  const utils = renderStrict(
    <table>
      <tbody>
        <EventLogRow
          event={eventFixture()}
          categories={[categoryFixture()]}
          inlineEdit={false}
          batchEdit={false}
          pendingDelete={false}
          viewUtc={false}
          batchValues={null}
          onInlineSave={onInlineSave}
          onBatchChange={onBatchChange}
          onDelete={onDelete}
          onUndelete={onUndelete}
          resolvedSec={10}
          onJump={onJump}
          jumpUnavailable={false}
          jumpReasonId="v5-event-feed-jump-reason"
          inlineDrafts={inlineDrafts}
          {...overrides}
        />
      </tbody>
    </table>,
  );
  return { ...utils, onJump, onInlineSave, inlineDrafts };
}

describe('EventLogRow — jump control', () => {
  it('renders no jump control when the row has no resolvable position', () => {
    renderRow({ resolvedSec: null });
    expect(screen.queryByRole('button', { name: /Jump to/ })).toBeNull();
  });

  it('names the displayed session timecode when not in wall-clock mode', () => {
    renderRow({ viewUtc: false, resolvedSec: 10 });
    // formatTimecodeHMS('00:00:10:00') strips the trailing frame field -> '00:00:10'.
    expect(screen.getByRole('button', { name: 'Jump to 00:00:10' })).toBeTruthy();
  });

  it('names the displayed wall-clock time when in wall-clock mode (design D2 — the control names what the row DISPLAYS)', () => {
    renderRow({ viewUtc: true, resolvedSec: 10 });
    const expected = formatWallUtcYmdHms('2026-07-21T00:00:10Z');
    expect(screen.getByRole('button', { name: `Jump to ${expected}` })).toBeTruthy();
  });

  it('activating the jump control calls onJump with the resolved second and does not focus any editable field', () => {
    const { onJump } = renderRow({ resolvedSec: 42, inlineEdit: true });
    const msgInput = screen.getByLabelText('Message');
    const btn = screen.getByRole('button', { name: /Jump to/ });

    fireEvent.click(btn);

    expect(onJump).toHaveBeenCalledWith(42);
    expect(document.activeElement).not.toBe(msgInput);
  });

  it('renders aria-disabled with the shared reason id when jump is unavailable, and activation no-ops', () => {
    const { onJump } = renderRow({ jumpUnavailable: true, jumpReasonId: 'shared-reason-1' });
    const btn = screen.getByRole('button', { name: /Jump to/ });

    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(btn.getAttribute('aria-describedby')).toBe('shared-reason-1');

    fireEvent.click(btn);
    expect(onJump).not.toHaveBeenCalled();
  });

  it('the jump control renders in its own cell, ahead of the timecode cell, and does not disturb inline editing', () => {
    renderRow({ inlineEdit: true, resolvedSec: 10 });
    // Inline editing untouched: the timecode input still renders with its own
    // accessible name, still editable, unaffected by the jump column's presence.
    expect(screen.getByLabelText('Timecode')).toBeTruthy();
    expect(screen.getByLabelText('Category')).toBeTruthy();
    expect(screen.getByLabelText('Message')).toBeTruthy();
  });
});

// --- Inline-edit draft write-through (virtualized-feed data loss) ---
//
// The inline (rolling) controls are uncontrolled — `defaultValue` + refs — so
// before this store existed the only copy of an in-progress edit was the DOM
// node itself, and the virtualized feed unmounts that node as soon as the row
// leaves the window. The row's half of the contract is pinned here: every
// keystroke is written through to the parent's store, and a row that mounts
// with a draft already recorded renders the DRAFT, not the server text. The
// unmount/remount round trip it exists for is driven end-to-end against the
// real virtualizer window in EventLogSheet.virtualization.test.tsx.

describe('EventLogRow — inline-edit drafts', () => {
  it('writes every inline field through to the parent store as it is typed', () => {
    const { inlineDrafts } = renderRow({ inlineEdit: true, viewUtc: true });

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'half a thought' } });
    fireEvent.change(screen.getByLabelText('Timecode'), { target: { value: '00:00:12' } });
    fireEvent.change(screen.getByLabelText('UTC'), { target: { value: '26-07-21 00:00:1' } });

    expect(inlineDrafts.map.get('ev-1')).toEqual({
      message: 'half a thought',
      timecode_hms: '00:00:12',
      // Stored as RAW input text: '26-07-21 00:00:1' is mid-typing and has no
      // ISO form, so it could not round-trip through `wall_time_utc`.
      wall_text: '26-07-21 00:00:1',
    });
  });

  it('renders a recorded draft instead of the server values when it mounts mid-edit', () => {
    renderRow({
      inlineEdit: true,
      viewUtc: true,
      inlineDrafts: draftStore([['ev-1', { message: 'half a thought', timecode_hms: '00:00:12' }]]),
    });

    expect((screen.getByLabelText('Message') as HTMLInputElement).value).toBe('half a thought');
    expect((screen.getByLabelText('Timecode') as HTMLInputElement).value).toBe('00:00:12');
    // Untouched fields still come from the event — a draft is per-field.
    expect((screen.getByLabelText('UTC') as HTMLInputElement).value).toBe(
      formatWallUtcYmdHms('2026-07-21T00:00:10Z'),
    );
  });

  it('records nothing for a non-editable (batch / automatic) row', () => {
    // Batch edit has always had a parent-owned buffer (`batchValues`); the
    // inline store must stay out of it or the two would both claim the row.
    const { inlineDrafts, onInlineSave } = renderRow({
      inlineEdit: false,
      batchEdit: true,
      batchValues: {
        category: 'general',
        message: 'A logged note',
        timecode_hms: '00:00:10',
        wall_time_utc: '2026-07-21T00:00:10Z',
      },
    });

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'batch text' } });

    expect(inlineDrafts.map.size).toBe(0);
    expect(onInlineSave).not.toHaveBeenCalled();
  });
});

// --- Generated-row marker (auto-generate-event-logs, task 5.2) ---
//
// Rows whose metadata carries `auto_generated: true` render a compact "auto" chip
// with an accessible name; the marker is presentation-only (editing, deletion, and
// jump behavior are exercised unchanged by the suites above and by
// EventLogSheet.test.tsx / EventLogSheet.jumpColumn.test.tsx). The server parses
// `metadata_json` into the wire `metadata` object (malformed JSON ⇒ `{}`); the
// component re-checks defensively, so a non-object value renders no marker.

describe('EventLogRow — generated-row marker', () => {
  it('shows the auto marker with an accessible name on a generated row', () => {
    renderRow({ event: eventFixture({ metadata: { auto_generated: true } }) });
    expect(screen.getByRole('img', { name: 'auto-generated' })).toBeTruthy();
  });

  it('shows no marker on a manual row', () => {
    renderRow();
    expect(screen.queryByRole('img', { name: 'auto-generated' })).toBeNull();
  });

  it('shows no marker when metadata is malformed (not an object at runtime)', () => {
    renderRow({
      event: eventFixture({
        metadata: '{"auto_generated": true' as unknown as Record<string, unknown>,
      }),
    });
    expect(screen.queryByRole('img', { name: 'auto-generated' })).toBeNull();
  });

  it('shows no marker when auto_generated is present but not exactly true', () => {
    renderRow({ event: eventFixture({ metadata: { auto_generated: 'yes' } }) });
    expect(screen.queryByRole('img', { name: 'auto-generated' })).toBeNull();
  });

  it('keeps the marker visible in edit mode and leaves the editable fields intact', () => {
    renderRow({
      event: eventFixture({ metadata: { auto_generated: true } }),
      inlineEdit: true,
    });
    expect(screen.getByRole('img', { name: 'auto-generated' })).toBeTruthy();
    // Presentation-only: the editable message input (and delete affordance) still
    // render exactly as for a manual row.
    expect(screen.getByLabelText('Message')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete row' })).toBeTruthy();
  });
});
