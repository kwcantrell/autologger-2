import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Category, LogEvent } from '../../../api/types';
import { formatWallUtcYmdHms } from '../../../shared/utils/timecode';
import { renderStrict, StrictWrapper } from '../../../test/renderStrict';
import { createDraftStore } from '../utils/draftStore';
import {
  EventLogRow,
  INLINE_DRAFT_FIELDS,
  INLINE_FOCUS_RESTORE_MAX_AGE_MS,
  type InlineDraft,
  type InlineDraftStore,
  type InlineFocusRecord,
  type InlineFocusRecordInput,
  type InlineFocusStore,
  serverInlineDraft,
} from './EventLogRow';

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

/** The REAL store `EventLogSheet` hands its rows (`utils/draftStore`), owned by
 *  the test instead of the sheet — never a re-implementation, so a row driven
 *  here and a row driven by the sheet cannot see different clear semantics. */
function draftStore(seed: Array<[string, InlineDraft]> = []): InlineDraftStore {
  const store = createDraftStore<InlineDraft>(INLINE_DRAFT_FIELDS);
  for (const [eventId, draft] of seed) store.write(eventId, draft);
  return store;
}

/** A standalone stand-in for `EventLogSheet`'s inline-focus record — same
 *  ref-behind-stable-callbacks shape, and the same store-side `recordedAt`
 *  stamp (the restore staleness bound depends on it). `recordedAt` seeds the
 *  INITIAL record's stamp, so a test can hand the row an aged one. */
function focusStore(
  seed: InlineFocusRecordInput | null = null,
  recordedAt: number = Date.now(),
): InlineFocusStore & {
  current: () => InlineFocusRecord | null;
} {
  let record: InlineFocusRecord | null = seed ? { ...seed, recordedAt } : null;
  return {
    current: () => record,
    read: () => record,
    record: (next) => {
      record = { ...next, recordedAt: Date.now() };
    },
    clear: (eventId) => {
      if (record?.eventId === eventId) record = null;
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
  const inlineFocus = focusStore();
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
          inlineFocus={inlineFocus}
          {...overrides}
        />
      </tbody>
    </table>,
  );
  return { ...utils, onJump, onInlineSave, inlineDrafts, inlineFocus };
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

    expect(inlineDrafts.read('ev-1')).toEqual({
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

    expect(inlineDrafts.read('ev-1')).toBeUndefined();
    expect(onInlineSave).not.toHaveBeenCalled();
  });
});

// --- Inline-edit focus record + restore (virtualized-feed focus yank) ---
//
// The draft store keeps the TEXT across a virtual unmount; this keeps the
// CURSOR. While timecode rolls (the only time inline edit is live) new events
// arrive, and under a descending sort each one prepends and pushes the edited
// row down — past the overscan the focused <tr> is unmounted, focus falls to
// <body>, and further keystrokes go nowhere. EventLogSheet pins the recorded row
// into the virtual window to prevent that; this is the row's half of the
// contract — publishing where focus is, and taking it back on a remount the pin
// could not prevent. The pin itself, and the end-to-end unmount/remount round
// trip, are driven in EventLogSheet.virtualization.test.tsx.

describe('EventLogRow — inline-edit focus record', () => {
  it('records the focused field and caret offsets on focus', () => {
    const { inlineFocus } = renderRow({ inlineEdit: true });
    const input = screen.getByLabelText('Message') as HTMLInputElement;

    input.setSelectionRange(3, 7);
    input.focus();

    expect(inlineFocus.current()).toEqual({
      eventId: 'ev-1',
      field: 'message',
      selectionStart: 3,
      selectionEnd: 7,
      recordedAt: expect.any(Number),
    });
  });

  it('keeps the caret current as it moves within the focused field', () => {
    const { inlineFocus } = renderRow({ inlineEdit: true });
    const input = screen.getByLabelText('Message') as HTMLInputElement;
    input.focus();

    input.setSelectionRange(5, 5);
    // React derives `onSelect` from keyup (among others), not from a native
    // 'select' event — this is the same path a keystroke takes.
    fireEvent.keyUp(input);

    expect(inlineFocus.current()?.selectionStart).toBe(5);
  });

  it('records the field, so a caret in the timecode input restores there and not in the message', () => {
    const { inlineFocus } = renderRow({ inlineEdit: true });
    (screen.getByLabelText('Timecode') as HTMLInputElement).focus();
    expect(inlineFocus.current()?.field).toBe('timecode');
  });

  it('records nothing for a non-editable (batch) row', () => {
    const inlineFocus = focusStore();
    renderRow({ inlineEdit: false, batchEdit: true, inlineFocus });
    (screen.getByLabelText('Message') as HTMLInputElement).focus();
    expect(inlineFocus.current()).toBeNull();
  });

  it('restores focus and caret when it mounts as the recorded row', () => {
    const inlineFocus = focusStore({
      eventId: 'ev-1',
      field: 'message',
      selectionStart: 4,
      selectionEnd: 6,
    });
    renderRow({ inlineEdit: true, inlineFocus });

    const input = screen.getByLabelText('Message') as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(4);
    expect(input.selectionEnd).toBe(6);
    // Its own onFocus re-recorded the caret as it stood before the range was
    // restored; the record must end up holding the restored one.
    expect(inlineFocus.current()).toEqual({
      eventId: 'ev-1',
      field: 'message',
      selectionStart: 4,
      selectionEnd: 6,
      recordedAt: expect.any(Number),
    });
  });

  it('does not restore focus for a record belonging to another row', () => {
    const inlineFocus = focusStore({
      eventId: 'ev-other',
      field: 'message',
      selectionStart: 0,
      selectionEnd: 0,
    });
    renderRow({ inlineEdit: true, inlineFocus });
    expect(document.activeElement).not.toBe(screen.getByLabelText('Message'));
  });

  it('does not steal focus from wherever it already is', () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();

    const inlineFocus = focusStore({
      eventId: 'ev-1',
      field: 'message',
      selectionStart: 0,
      selectionEnd: 0,
    });
    renderRow({ inlineEdit: true, inlineFocus });

    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it('forgets the record when focus leaves a row that is still mounted', async () => {
    const { inlineFocus } = renderRow({ inlineEdit: true });
    const input = screen.getByLabelText('Message') as HTMLInputElement;
    input.focus();
    expect(inlineFocus.current()?.eventId).toBe('ev-1');

    await act(async () => {
      input.blur();
      // Blur-to-save defers a tick to let focus settle.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(inlineFocus.current()).toBeNull();
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

// --- One definition of "this draft field is spent" (review findings 1 and 4) ---
//
// Three paths drop inline-draft fields: the sheet's save-resolution clear, this
// row's server-sync effect, and `saveInline`'s nothing-to-commit branch. All
// three now go through the SAME comparison — `DraftStore#clearMatching`, in
// DRAFT space (raw control text) against `serverInlineDraft(event)` — because
// two of them used to clear the row's whole entry instead, and both lost text
// the row was still displaying:
//
//  * the sync effect deleted the fields the save-resolution clear had just
//    deliberately preserved (keystrokes typed during a round trip, or the text
//    a FAILED save left recoverable), whenever the row happened to be blurred
//    when a refetch landed;
//  * the nothing-to-commit branch compared in VALUE space — trimmed, and with
//    `buildWallIso` falling back to the original ISO for anything unparseable —
//    so a half-typed date read as "unchanged" while the input still showed it.

/** Renders the row in its own <table>, re-renderable with a new `event` (what a
 *  refetch hands it) while keeping the same draft/focus stores. */
function mountRow(overrides: Partial<ComponentProps<typeof EventLogRow>> = {}) {
  const inlineDrafts = overrides.inlineDrafts ?? draftStore();
  const inlineFocus = overrides.inlineFocus ?? focusStore();
  const onInlineSave = vi.fn();
  const tree = (event: LogEvent) => (
    <StrictWrapper>
      <table>
        <tbody>
          <EventLogRow
            event={event}
            categories={[categoryFixture()]}
            inlineEdit
            batchEdit={false}
            pendingDelete={false}
            viewUtc
            batchValues={null}
            onInlineSave={onInlineSave}
            onBatchChange={vi.fn()}
            onDelete={vi.fn()}
            onUndelete={vi.fn()}
            resolvedSec={10}
            onJump={vi.fn()}
            jumpUnavailable={false}
            {...overrides}
            inlineDrafts={inlineDrafts}
            inlineFocus={inlineFocus}
          />
        </tbody>
      </table>
    </StrictWrapper>
  );
  const view = render(tree(overrides.event ?? eventFixture()));
  return {
    ...view,
    inlineDrafts,
    inlineFocus,
    onInlineSave,
    /** A refetch delivering a new object for this row. */
    serverUpdate: (event: LogEvent) => act(() => view.rerender(tree(event))),
  };
}

const input = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

describe('EventLogRow — server-driven refresh vs. unsaved draft text (finding 1)', () => {
  it('keeps draft fields that diverge from the incoming server row, and refreshes the rest', () => {
    const { inlineDrafts, serverUpdate } = mountRow();

    // Uncommitted text: what a failed save left recoverable, or keystrokes the
    // sheet's save-resolution clear kept. The row is NOT focused.
    fireEvent.change(input('Message'), { target: { value: 'text nothing has saved' } });

    // A refetch hands the row a new identity, with a field the operator never
    // touched changed by the server.
    serverUpdate(eventFixture({ timecode: '00:00:20:00', timecode_total_frames: 480 }));

    // The diverging field survives, in the store AND on screen...
    expect(inlineDrafts.read('ev-1')).toEqual({ message: 'text nothing has saved' });
    expect(input('Message').value).toBe('text nothing has saved');
    // ...and the untouched one still refreshes — that is this effect's whole job.
    expect(input('Timecode').value).toBe('00:00:20');
  });

  it('still forgets a draft field the server has caught up with', () => {
    const { inlineDrafts, serverUpdate } = mountRow();

    fireEvent.change(input('Message'), { target: { value: 'committed note' } });
    serverUpdate(eventFixture({ message: 'committed note' }));

    // Spent: leaving it would shadow the fresh row on the next remount.
    expect(inlineDrafts.read('ev-1')).toBeUndefined();
    expect(input('Message').value).toBe('committed note');
  });
});

describe('EventLogRow — nothing-to-commit clears in draft space (finding 4)', () => {
  it('keeps a half-typed wall time that has no parsed form', async () => {
    const { inlineDrafts, onInlineSave } = mountRow();

    // Unparseable, so `buildWallIso` falls back to the original ISO and every
    // VALUE-space comparison reports "unchanged" — while the input shows this.
    act(() => input('UTC').focus());
    fireEvent.change(input('UTC'), { target: { value: '26-07-2' } });
    await act(async () => {
      input('UTC').blur();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(onInlineSave).not.toHaveBeenCalled();
    expect(inlineDrafts.read('ev-1')).toEqual({ wall_text: '26-07-2' });
    // The row is showing it, and a remount must keep showing it.
    expect(input('UTC').value).toBe('26-07-2');
  });

  it('keeps a message that differs from the server only by whitespace', async () => {
    const { inlineDrafts } = mountRow();

    act(() => input('Message').focus());
    fireEvent.change(input('Message'), { target: { value: 'A logged note  ' } });
    await act(async () => {
      input('Message').blur();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(inlineDrafts.read('ev-1')).toEqual({ message: 'A logged note  ' });
  });

  it('still forgets a field typed back to exactly the server text', async () => {
    const { inlineDrafts } = mountRow();

    act(() => input('UTC').focus());
    fireEvent.change(input('UTC'), { target: { value: '26-07-2' } });
    act(() => input('Message').focus());
    fireEvent.change(input('Message'), { target: { value: 'changed' } });
    fireEvent.change(input('Message'), { target: { value: 'A logged note' } });
    await act(async () => {
      input('Message').blur();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The message entry is spent; the half-typed sibling is not.
    expect(inlineDrafts.read('ev-1')).toEqual({ wall_text: '26-07-2' });
  });
});

// --- An abandoned focus record must not come back to life (finding 3) ---
//
// Wheel scrolling changes neither focus nor `document.activeElement`, so the
// mount-time restore's "focus is nowhere" guard stays satisfied indefinitely
// for a row the operator walked away from. Two bounds live here (the third —
// dropping the record on a pointerdown/focusin outside the row — is the sheet's,
// since it has to work while the row is unmounted).
describe('EventLogRow — focus restore is bounded (finding 3)', () => {
  const focusSpy = vi.spyOn(HTMLInputElement.prototype, 'focus');
  afterEach(() => focusSpy.mockClear());

  it('restores without scrolling the row into view', () => {
    const inlineFocus = focusStore({
      eventId: 'ev-1',
      field: 'message',
      selectionStart: 1,
      selectionEnd: 1,
    });
    renderRow({ inlineEdit: true, inlineFocus });

    expect(document.activeElement).toBe(screen.getByLabelText('Message'));
    // A default focus() scrolls the newly mounted row into view — yanking the
    // viewport out from under an operator who is scrolling, not editing.
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('refuses a record the operator has long since walked away from', () => {
    const inlineFocus = focusStore(
      { eventId: 'ev-1', field: 'message', selectionStart: 1, selectionEnd: 1 },
      Date.now() - INLINE_FOCUS_RESTORE_MAX_AGE_MS - 1,
    );
    renderRow({ inlineEdit: true, inlineFocus });

    expect(document.activeElement).not.toBe(screen.getByLabelText('Message'));
    expect(focusSpy).not.toHaveBeenCalled();
  });

  it('still restores a record the operator touched moments ago', () => {
    const inlineFocus = focusStore(
      { eventId: 'ev-1', field: 'message', selectionStart: 1, selectionEnd: 1 },
      Date.now() - 1_000,
    );
    renderRow({ inlineEdit: true, inlineFocus });

    expect(document.activeElement).toBe(screen.getByLabelText('Message'));
  });
});

describe('EventLogRow — serverInlineDraft mirrors what the controls render', () => {
  it('is draft space, field for field (raw wall text, untrimmed message)', () => {
    const event = eventFixture({ message: 'A logged note' });
    expect(serverInlineDraft(event)).toEqual({
      category: 'general',
      message: 'A logged note',
      timecode_hms: '00:00:10',
      wall_text: formatWallUtcYmdHms('2026-07-21T00:00:10Z'),
    });
  });
});
