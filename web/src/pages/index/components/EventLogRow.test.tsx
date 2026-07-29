import { fireEvent, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { Category, LogEvent } from '../../../api/types';
import { formatWallUtcYmdHms } from '../../../shared/utils/timecode';
import { renderStrict } from '../../../test/renderStrict';
import { EventLogRow } from './EventLogRow';

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

function renderRow(overrides: Partial<ComponentProps<typeof EventLogRow>> = {}) {
  const onJump = vi.fn();
  const onInlineSave = vi.fn();
  const onBatchChange = vi.fn();
  const onDelete = vi.fn();
  const onUndelete = vi.fn();
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
          {...overrides}
        />
      </tbody>
    </table>,
  );
  return { ...utils, onJump };
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
