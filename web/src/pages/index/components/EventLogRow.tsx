import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import type { Category, LogEvent } from '../../../api/types';
import { Tooltip } from '../../../shared/ui/Tooltip';
import {
  formatTimecodeHMS,
  formatWallUtcYmdHms,
  isAutomaticLogEvent,
  normalizeWallIso,
  parseYmdHmsUtcToIso,
} from '../../../shared/utils/timecode';
import type { DraftStore } from '../utils/draftStore';
import { JumpToTimeButton } from './JumpToTimeButton';
import { Select } from './Select';

// EventLogRow cell/row chrome (was EventLogSheet.module.css, shared @layer legacy). The row
// hover tint + hover-actions reveal use the `group`/`group-hover` pattern: the <tr> carries
// `group`, its tds/reveal use `[.group:hover_&]:` (arbitrary ancestor variant — composes with
// the hovered <tr> whether or not our custom `hover-always` would). Edit-mode/pending-delete
// cells set their OWN background and must NOT take the row-hover tint, so those cells get an
// exclusive background utility instead of the group-hover one.

/** Base sheet cell padding/border (was `.sheet td` + `.sheet-dense td`). `text-align`/
 *  `vertical-align` are set per cell (tc/cat: left+middle; the actions cell: center+middle via
 *  CELL_ACTIONS) so the two alignments never collide on one element.
 *  Row height trimmed in steps; another ~30% via tighter py + slight type/icon scale. */
const CELL_BASE =
  'px-[0.55rem] py-[0.17rem] text-[0.78rem] leading-none [border-bottom:1px_solid_var(--border)]';
/** Row-hover tint for non-edit cells (was `.sheet tbody tr:hover td`). */
const CELL_HOVER = '[.group:hover_&]:bg-[rgba(124,183,255,0.06)]';
/** Timecode cell (was `.sheet .tc`). feed-row-seek, task 6.2: the legacy
 *  `cursor:pointer!important` lock on td.tc + children is reconciled here —
 *  it had no handler behind it even before this change (a row-wide click
 *  design that was abandoned; see design D2), and the jump control now lives
 *  in its own leading column, never in this cell. An `!important` cursor
 *  claim on every descendant would defeat an unavailable-state cursor on
 *  anything rendered inside this cell in the future, so the assertion is
 *  dropped rather than carried forward as dead CSS. */
const CELL_TC =
  'text-left align-middle font-[family-name:var(--font-mono)] text-accent whitespace-nowrap';
/** Category cell (was `.sheetCat`). */
const CELL_CAT = 'text-left align-middle font-semibold whitespace-nowrap';
/** Message cell max-width (was `.sheet-dense .msg`, which beat `.sheet .msg`). */
const CELL_MSG = 'max-w-[min(28rem,38vw)]';
/** Message/actions cell chrome (was `.msg` + `.rowActions`). NOTE: `.rowActions`'s
 *  `text-align: center` was DEAD in the legacy cascade — `.sheet td { text-align: left }`
 *  (0,1,1) beat `.rowActions` (0,1,0), so the cell rendered LEFT. We keep that effective
 *  left alignment. `relative` (ui-refresh) makes this cell the containing block for the
 *  hover action cluster — without it the absolute cluster resolved against the sheet and
 *  every row's Delete button stacked at one detached point below the table. */
const CELL_ACTIONS = 'relative text-left whitespace-nowrap align-middle leading-none';
/** Positioning/geometry for the hover action cluster (was `.rowHoverActions`). Visibility is
 *  applied separately (ROW_ACTIONS_HIDDEN reveal-on-hover, or always-on in batch) so the two
 *  opacity/pointer-events states never stack on one element. */
const ROW_HOVER_ACTIONS =
  'absolute right-[0.4rem] top-1/2 -translate-y-1/2 inline-flex gap-[0.2rem] [transition:opacity_0.14s_ease]';
/** Compact in-row icon action (ui-refresh): replaces the legacy `.btn`-with-emoji delete. */
const ROW_ICON_BTN =
  'inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-[0.4rem] border border-v5-border-strong bg-[rgba(15,23,42,0.88)] p-0 text-v5-muted [transition:border-color_0.15s_ease,color_0.15s_ease,background_0.15s_ease] hover-always:border-[rgba(251,113,133,0.5)] hover-always:text-[#fda4af] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[rgba(56,189,248,0.55)]';
/** Reveal-on-hover/focus-within (non-batch): hidden until the row (`group`) is hovered. */
const ROW_ACTIONS_HIDDEN =
  'opacity-0 pointer-events-none [.group:hover_&]:opacity-100 [.group:hover_&]:pointer-events-auto [.group:focus-within_&]:opacity-100 [.group:focus-within_&]:pointer-events-auto';
/** Editable-cell background (was `--sheet-editable-cell-bg` default). Applied to edit cells
 *  INSTEAD of the row-hover tint. `!` beats the flat batch-edit rule ordering. */
const EDIT_CELL_BG = 'bg-[rgba(255,255,255,0.04)]';
/** Pending-delete cell background (#8d4545), replaces the editable bg. */
const PENDING_CELL_BG = 'bg-[#8d4545]';
/** The flat control reset inside editable cells (was `.sheetRowEditable .sheetCellControl`).
 *  `text-align` is set per control — tc/wall are centered (`.colTcCellEdit .sheetCellControl`
 *  { text-align: center }), the message input inherits its `text-align: inherit`. */
const CELL_CONTROL =
  'block w-full max-w-full box-border m-0 p-0 border-none rounded-none [background:#161825] shadow-none [font:inherit] text-inherit [text-align:inherit] min-h-0 min-w-0 focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--accent-dim)] focus-visible:-outline-offset-1';
/** Generated-row marker chip (auto-generate-event-logs): compact "auto" badge in the
 *  message cell, mirroring ROW_ICON_BTN's muted bordered look at text scale. Presentation
 *  only — it sits beside the message text / input and never carries handlers. */
const AUTO_CHIP =
  'ml-[0.4rem] inline-flex shrink-0 items-center rounded-[0.3rem] border border-v5-border-strong px-[0.24rem] py-px align-middle font-[family-name:var(--font-mono)] text-[0.55rem] uppercase tracking-[0.08em] text-v5-muted';

/** Generated-row detection (auto-generate-event-logs): true only when the row's metadata
 *  object carries `auto_generated: true`. The server parses `metadata_json` into the wire
 *  `metadata` field (`enrichEventRpc` in `server/src/studio.ts`; malformed JSON ⇒ `{}` ⇒
 *  no marker) — this guard is the client-side defensive re-check so a non-object or
 *  wrongly-typed value renders no marker rather than throwing. */
export function isAutoGeneratedEvent(event: LogEvent): boolean {
  const meta: unknown = event.metadata;
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return false;
  return (meta as Record<string, unknown>).auto_generated === true;
}

export interface RowEditValues {
  category: string;
  message: string;
  timecode_hms: string;
  wall_time_utc: string;
}

/** One row's in-progress INLINE (rolling) edit, as raw input text.
 *
 *  Every field is exactly what sits in the corresponding control, so a
 *  restored draft is keystroke-identical to what was typed — including
 *  `wall_text`, which is the displayed `YY-MM-DD HH:MM:SS` form and NOT the
 *  ISO string `RowEditValues.wall_time_utc` carries (a half-typed date has no
 *  ISO form at all). Fields are optional: only the controls the operator
 *  actually touched are recorded. */
export interface InlineDraft {
  category?: string;
  message?: string;
  timecode_hms?: string;
  wall_text?: string;
}

/** Every field an `InlineDraft` can carry, so a draft can be walked
 *  exhaustively (`DraftStore#clearMatching`). Compiler-checked against the
 *  interface: adding a field without listing it here fails the `satisfies`. */
export const INLINE_DRAFT_FIELDS = [
  'category',
  'message',
  'timecode_hms',
  'wall_text',
] as const satisfies ReadonlyArray<keyof InlineDraft>;

/** Parent-owned storage for inline-edit drafts, keyed by event id — the shared
 *  feed-draft primitive (`utils/draftStore`) at this feed's draft shape.
 *
 *  Inline-edit controls are UNCONTROLLED (`defaultValue` + refs), so the draft
 *  used to live only in the DOM — and the feed is virtualized, so the <tr>
 *  unmounts as soon as it scrolls past the overscan (or a reveal calls
 *  `scrollToIndex` elsewhere in the list), taking the draft with it.
 *  `EventLogSheet` owns the store so a draft outlives its row's DOM node; the
 *  row writes through on every keystroke and reads it back when it remounts.
 *
 *  Deliberately a mutable store behind stable callbacks rather than
 *  `useState` (the shape `batchEdits` uses): nothing RENDERS from a draft
 *  except the `defaultValue` of a freshly mounted input, so keystrokes must
 *  not re-render the sheet and every mounted row with it — inline edit is
 *  live exactly while timecode is rolling, the render-budget-critical state.
 *  Batch edit is unaffected either way: its drafts are already parent-owned
 *  (`batchValues`) and its inputs are controlled. */
export type InlineDraftStore = DraftStore<InlineDraft>;

/** The draft text this row's controls WOULD render from the given server event
 *  — the reference every "this field is spent" comparison in this file
 *  measures a stored draft against (`DraftStore#clearMatching`).
 *
 *  Draft space, field for field: `wall_text` is the displayed
 *  `YY-MM-DD HH:MM:SS` form the wall input shows (never the ISO string),
 *  `message` is untrimmed. Kept beside the `defaultValue`s it mirrors so the
 *  two cannot drift — a mismatch here would either strand a spent draft or
 *  delete a live one. */
export function serverInlineDraft(event: LogEvent): Required<InlineDraft> {
  return {
    category: event.category,
    message: event.message ?? '',
    timecode_hms: formatTimecodeHMS(event.timecode),
    wall_text: formatWallUtcYmdHms(event.wall_time_utc),
  };
}

/** The three text controls an inline edit can be focused in. The category
 *  control is a Radix `Select` trigger, not a text field — it has no caret to
 *  restore and blur-to-save never runs through it, so it is deliberately not a
 *  member (a record made for an open category Select carries `field: null`). */
export type InlineFocusField = 'timecode' | 'wall' | 'message';

/** Where the operator's cursor is inside an inline edit, as of the last focus
 *  or selection change. `selectionStart`/`selectionEnd` are the input's own
 *  values (null for a control that does not expose a selection). */
export interface InlineFocusRecord {
  eventId: string;
  /** `null` when the row is held for a reason with no caret to restore —
   *  today, only an open category Select. */
  field: InlineFocusField | null;
  selectionStart: number | null;
  selectionEnd: number | null;
  /** True while this row's category Select is open. Radix portals the listbox
   *  OUTSIDE the row, so neither DOM containment nor `document.activeElement`
   *  can tell "focus moved into this row's own dropdown" from "focus left the
   *  row"; the explicit flag can. Both the deferred blur handler and the
   *  sheet's abandon listener treat a flagged row as still being edited. */
  selectOpen?: boolean;
  /** When the store last accepted this record — stamped BY the store, so no
   *  caller can forget to. Read only by the remount focus restore, to refuse a
   *  record the operator has long since walked away from. */
  recordedAt: number;
}

/** What a caller hands `InlineFocusStore#record`: the store stamps the clock. */
export type InlineFocusRecordInput = Omit<InlineFocusRecord, 'recordedAt'>;

/** How stale a focus record may be and still pull focus back on remount.
 *
 *  INVARIANT: a restore may only happen for a row the operator is still
 *  plausibly editing. Every focus/caret/selection change re-stamps the record,
 *  so this measures time since the operator last touched THIS edit — not since
 *  it began. Past the bound the record is inert for focus purposes: the row
 *  remounts showing its draft (which is never dropped by age), just without
 *  grabbing the caret. */
export const INLINE_FOCUS_RESTORE_MAX_AGE_MS = 30_000;

/** Parent-owned record of WHICH row is being inline-edited, and where the caret
 *  sits in it — the focus counterpart of `InlineDraftStore`.
 *
 *  It exists for the same reason: the feed is virtualized. While timecode rolls,
 *  incoming events prepend at index 0 under a descending sort and push the row
 *  being edited down the list; once it passes the overscan the virtualizer
 *  unmounts the focused `<tr>`, focus falls to `<body>`, and further keystrokes
 *  go nowhere. `EventLogSheet` uses this record twice: to PIN the edited row's
 *  index into the virtual window (`rangeExtractor`), and — when a remount
 *  happens anyway — to let the remounting row put focus and caret back.
 *
 *  A ref-backed store rather than state, for `InlineDraftStore`'s reason: a
 *  caret move must not re-render the feed. */
export interface InlineFocusStore {
  read: () => InlineFocusRecord | null;
  record: (record: InlineFocusRecordInput) => void;
  /** Forgets the record only if it still belongs to `eventId` — a row must
   *  never clear a record that focus has already moved on to. */
  clear: (eventId: string) => void;
}

interface Props {
  event: LogEvent;
  categories: Category[];
  /** inline rolling edit — show inputs, blur-to-save */
  inlineEdit: boolean;
  /** batch edit mode — show inputs, tracked by parent */
  batchEdit: boolean;
  /** batch pending delete (only valid when batchEdit=true) */
  pendingDelete: boolean;
  viewUtc: boolean;
  batchValues: RowEditValues | null;
  /** This row's resolved timeline second (design D4: `timecode_total_frames /
   *  frame_rate`, resolved by `EventLogSheet`), or `null` when unresolvable.
   *  Passed as a prop, not derived here (design D7). */
  resolvedSec: number | null;
  /** `EventLogSheet`'s `useTimelineSeek` `jump`, `useCallback`-stable and
   *  shared by every row in the feed (design D7). */
  onJump: (sec: number) => void;
  /** The feed-wide not-rolling/batch-edit gate (design D5), shared by every row. */
  jumpUnavailable: boolean;
  /** id of the ONE reason node `EventLogSheet` renders while unavailable — every
   *  row passes the same id (design D2 gate decision). */
  jumpReasonId?: string;
  /** `EventLogSheet`'s inline-draft store (see `InlineDraftStore`) — one
   *  identity for the whole feed, stable for the sheet's lifetime. */
  inlineDrafts: InlineDraftStore;
  /** `EventLogSheet`'s inline-focus record (see `InlineFocusStore`) — likewise
   *  one identity for the whole feed. */
  inlineFocus: InlineFocusStore;
  onInlineSave: (event: LogEvent, values: RowEditValues) => void;
  onBatchChange: (eventId: string, values: RowEditValues) => void;
  onDelete: (eventId: string) => void;
  onUndelete: (eventId: string) => void;
}

function buildWallIso(wallInput: string, orig: string | null): string {
  const parsed = parseYmdHmsUtcToIso(wallInput.trim());
  if (parsed) return parsed;
  return normalizeWallIso(orig);
}

export function EventLogRow({
  event,
  categories,
  inlineEdit,
  batchEdit,
  pendingDelete,
  viewUtc,
  batchValues,
  resolvedSec,
  onJump,
  jumpUnavailable,
  jumpReasonId,
  inlineDrafts,
  inlineFocus,
  onInlineSave,
  onBatchChange,
  onDelete,
  onUndelete,
}: Props) {
  const isAuto = isAutomaticLogEvent(event);
  const editable = !isAuto && (inlineEdit || batchEdit);
  // Inline (rolling) edit only — batch edit keeps its own parent-owned buffer.
  const inlineEditable = !isAuto && inlineEdit;
  // The surviving draft for THIS row, if the operator was mid-edit when the
  // virtualizer last unmounted it (or is mid-edit right now). Read during
  // render because that is where it is needed: as the `defaultValue` of the
  // uncontrolled controls below, and as the initial inline category.
  const draft = inlineEditable ? inlineDrafts.read(event.event_id) : undefined;
  /** Record a keystroke so it survives this row's next unmount. */
  const writeDraft = (patch: InlineDraft) => {
    if (!inlineEditable) return;
    inlineDrafts.write(event.event_id, patch);
  };
  // Generated-row marker (auto-generate-event-logs): rendered in the message cell in
  // both view and edit branches (batch edit is the cleanup mode, so the marker must
  // survive it). `role="img"` + aria-label gives the chip a queryable accessible name.
  const autoMarker = isAutoGeneratedEvent(event) ? (
    <span role="img" aria-label="auto-generated" title="auto-generated" className={AUTO_CHIP}>
      auto
    </span>
  ) : null;
  const color = event.category_color || undefined;
  const isInternal = event.category.toLowerCase() === 'internal';

  const catStyle = color ? { color } : undefined;
  const msgStyle = isInternal ? catStyle : { color: 'var(--color-text)' };

  // --- Refs for inline rolling edit (uncontrolled, blur-to-save) ---
  const tcRef = useRef<HTMLInputElement>(null);
  const wallRef = useRef<HTMLInputElement>(null);
  const msgRef = useRef<HTMLInputElement>(null);
  // Category is now controlled (Radix Select needs state) but still saves via blur of siblings.
  const [inlineCategory, setInlineCategory] = useState(draft?.category ?? event.category);

  // Keep inline inputs in sync when event changes (e.g., after save + refetch)
  // but only when not currently focused inside this row
  const rowRef = useRef<HTMLTableRowElement>(null);
  // The `event` object this row last reconciled its inputs against, seeded with
  // the mount-time one. The reset below must run for SERVER-DRIVEN changes only
  // — on the mount pass the controls already carry draft-or-server values, and
  // resetting there would wipe a draft the virtualizer just restored (React
  // StrictMode's second mount pass makes an "is this the first run" flag
  // useless; object identity does not care how many times the effect runs).
  const syncedEventRef = useRef(event);
  useEffect(() => {
    if (!inlineEdit) return;
    if (syncedEventRef.current === event) return;
    const row = rowRef.current;
    if (row?.contains(document.activeElement)) return;
    syncedEventRef.current = event;
    const server = serverInlineDraft(event);
    // A draft field that MATCHES the incoming server text is spent — leaving it
    // would let it shadow this fresh row on the next remount. A field that
    // DIVERGES is unsaved operator text and must survive: either the sheet's
    // save-resolution clear just deliberately preserved it (keystrokes typed
    // during the round trip) or the operator typed it into a blurred row while
    // an unrelated refetch was in flight. Clearing wholesale here deleted
    // exactly those survivors — and a later failed save then had nothing to
    // recover. Same comparison discipline as every other clear in this feed:
    // draft space, one shared helper.
    inlineDrafts.clearMatching(event.event_id, server);
    const survivors = inlineDrafts.read(event.event_id);
    // ...and refresh only the controls whose draft did NOT survive. The others
    // are still displaying the operator's text; overwriting them with server
    // values would lose it on screen even though the store kept it.
    if (survivors?.timecode_hms === undefined && tcRef.current) {
      tcRef.current.value = server.timecode_hms;
    }
    if (survivors?.wall_text === undefined && wallRef.current) {
      wallRef.current.value = server.wall_text;
    }
    if (survivors?.category === undefined) setInlineCategory(server.category);
    if (survivors?.message === undefined && msgRef.current) msgRef.current.value = server.message;
  }, [event, inlineEdit, inlineDrafts]);

  const inputForField = (field: InlineFocusField): HTMLInputElement | null =>
    field === 'timecode' ? tcRef.current : field === 'wall' ? wallRef.current : msgRef.current;

  /** Record that THIS row holds the inline-edit focus, and where its caret is.
   *  Called on focus and on every selection change (React's `onSelect` fires for
   *  a collapsed caret move too, so typing keeps the offset current). Cheap by
   *  construction: a ref write in the parent, no render. */
  const recordFocus = (field: InlineFocusField, el: HTMLInputElement | null) => {
    if (!inlineEditable || !el) return;
    inlineFocus.record({
      eventId: event.event_id,
      field,
      selectionStart: el.selectionStart,
      selectionEnd: el.selectionEnd,
    });
  };

  // Focus restore across an unavoidable remount (mount-only). The sheet pins the
  // edited row into the virtual window, but the pin is bounded (see
  // `PINNED_ROW_MAX_EXTRA_ROWS` there) and a far-off-window row still unmounts —
  // taking focus with it, since the browser drops focus to <body> when the
  // focused node is removed. On the way back in, put the operator's cursor
  // exactly where it was.
  //
  // The guard is deliberately narrow: restore ONLY when focus is currently
  // nowhere (<body>/<html>), which is precisely the state a focus-stealing
  // unmount leaves behind. If the operator has since focused anything at all,
  // the remount must not yank it away.
  //
  // "Focus is nowhere" is necessary but NOT sufficient, because wheel scrolling
  // never moves focus: a record left behind by an edit the operator walked away
  // from stays eligible forever, and the remount would then steal the caret out
  // of nowhere minutes later. Two bounds close that (see
  // `INLINE_FOCUS_RESTORE_MAX_AGE_MS` for the invariant): the record expires,
  // and `preventScroll` means even a restore that does fire can never yank the
  // viewport the operator is looking at. The third bound lives in
  // `EventLogSheet`, which drops the record on the first pointerdown/focusin
  // outside the row — the abandonment signal a scroll wheel cannot give.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only — this restores the focus the PREVIOUS unmount destroyed; re-running on prop changes would re-grab focus mid-edit.
  useEffect(() => {
    if (!inlineEditable) return;
    const rec = inlineFocus.read();
    if (!rec || rec.eventId !== event.event_id) return;
    // No caret to put back (the record is holding the row for an open category
    // Select, not for a text control).
    if (rec.field === null) return;
    if (Date.now() - rec.recordedAt > INLINE_FOCUS_RESTORE_MAX_AGE_MS) return;
    const active = document.activeElement;
    // `active.isConnected` covers the browsers that leave a REMOVED node as
    // `document.activeElement` instead of resetting to <body> — focus is just
    // as gone either way.
    if (active && active !== document.body && active !== document.documentElement) {
      if (active.isConnected) return;
    }
    const el = inputForField(rec.field);
    if (!el) return;
    // `preventScroll`: this row may be mounting at the far edge of the
    // overscan, and a default `focus()` would scroll it into view — yanking the
    // viewport out from under an operator who is scrolling, not editing.
    el.focus({ preventScroll: true });
    if (rec.selectionStart != null) {
      el.setSelectionRange(rec.selectionStart, rec.selectionEnd ?? rec.selectionStart);
    }
    // `el.focus()` fired this row's own `onFocus`, which re-recorded the caret
    // as it stood BEFORE the range was restored; put the real one back.
    inlineFocus.record(rec);
  }, []);

  const saveInline = (catOverride?: string) => {
    if (!inlineEdit || isAuto) return;
    const tc = tcRef.current?.value.trim() ?? formatTimecodeHMS(event.timecode);
    const wall = buildWallIso(wallRef.current?.value ?? '', event.wall_time_utc);
    const cat = catOverride ?? inlineCategory;
    const msg = (msgRef.current?.value ?? event.message ?? '').trim();
    const origTc = formatTimecodeHMS(event.timecode);
    const origWall = normalizeWallIso(event.wall_time_utc);
    if (
      cat === event.category &&
      msg === (event.message ?? '').trim() &&
      tc === origTc &&
      wall === origWall
    ) {
      // Nothing to COMMIT — but that is not the same as nothing to keep. The
      // comparison above is in VALUE space: it trims, and it runs the wall
      // field through `buildWallIso`, which falls back to the original ISO for
      // any text that does not parse. So a half-typed date ("26-07-2") compares
      // equal while the input still displays it, and a message the operator
      // only added spaces to does too. Clearing the whole draft there left the
      // mounted row showing text the store no longer had, which the next
      // remount silently reverted.
      //
      // Clear in DRAFT space instead — only fields whose RAW text is exactly
      // what this row renders from the server event — through the same helper
      // the server-sync effect above and the sheet's save-resolution clear use.
      // (The committed path does NOT clear here: `EventLogSheet` drops it once
      // the save has round-tripped, so a FAILED save leaves the operator's text
      // recoverable rather than silently reverting on the next remount.)
      inlineDrafts.clearMatching(event.event_id, serverInlineDraft(event));
      return;
    }
    onInlineSave(event, { category: cat, message: msg, timecode_hms: tc, wall_time_utc: wall });
  };

  /** Is the record currently held by THIS row's open category Select? */
  const selectIsOpenForThisRow = (): boolean => {
    const rec = inlineFocus.read();
    return rec?.eventId === event.event_id && rec.selectOpen === true;
  };

  const handleBlur = () => {
    if (!inlineEdit || isAuto) return;
    // Defer to let focus settle
    setTimeout(() => {
      const row = rowRef.current;
      // Row gone: the virtualizer unmounted it while focus was settling, so
      // there is nothing left to read a save out of (the draft store holds the
      // text). The focus record is deliberately NOT cleared here — it is what
      // the remount uses to put the operator's cursor back.
      if (!row) return;
      if (row.contains(document.activeElement)) return;
      // Focus genuinely left a row that is still on screen: this row is no
      // longer the one being edited, so it stops being pinned — UNLESS what
      // took the focus is this row's own category Select, whose listbox Radix
      // portals outside the <tr> (so containment above cannot see it). Dropping
      // the pin there unmounts the row mid-choice on the next incoming event
      // and discards the selection. The text controls' save still runs either
      // way: opening the dropdown is a legitimate blur-to-commit for them.
      if (!selectIsOpenForThisRow()) inlineFocus.clear(event.event_id);
      saveInline();
    }, 0);
  };

  /** Hold the pin for as long as the category dropdown is open.
   *
   *  Radix's `onOpenChange` is the explicit signal — preferred over inspecting
   *  the portal's DOM position, which is an implementation detail of where
   *  Radix chooses to render. */
  const handleCategoryOpenChange = (open: boolean) => {
    if (!inlineEditable) return;
    const rec = inlineFocus.read();
    if (open) {
      // Preserve the caret this row already recorded (the operator may have
      // been typing in the message field before reaching for the dropdown);
      // otherwise start a caret-less record, since the trigger has none.
      const base: InlineFocusRecordInput =
        rec?.eventId === event.event_id
          ? rec
          : { eventId: event.event_id, field: null, selectionStart: null, selectionEnd: null };
      inlineFocus.record({ ...base, selectOpen: true });
      return;
    }
    if (rec?.eventId !== event.event_id) return;
    inlineFocus.record({ ...rec, selectOpen: false });
    // Closed. Radix returns focus to the trigger — inside this row — so the row
    // stays pinned; normal blur semantics resume. Defer one tick to let that
    // focus return land, then release the pin if focus really did leave (the
    // trigger has no blur handler of its own, and the sheet's abandon listener
    // covers a later click elsewhere).
    setTimeout(() => {
      if (selectIsOpenForThisRow()) return;
      const row = rowRef.current;
      // Row gone: same rule as `handleBlur` — the record is what a remount
      // restores from, so an unmount must not clear it.
      if (!row) return;
      if (row.contains(document.activeElement)) return;
      inlineFocus.clear(event.event_id);
    }, 0);
  };

  const fireBatchChange = (overrides: Partial<RowEditValues> = {}) => {
    const base: RowEditValues = batchValues ?? {
      category: event.category,
      message: event.message ?? '',
      timecode_hms: formatTimecodeHMS(event.timecode),
      wall_time_utc: normalizeWallIso(event.wall_time_utc),
    };
    onBatchChange(event.event_id, { ...base, ...overrides });
  };

  // --- Column 1: timecode/UTC cell ---
  const col1View =
    viewUtc && event.wall_time_utc
      ? formatWallUtcYmdHms(event.wall_time_utc)
      : formatTimecodeHMS(event.timecode);

  const dis = pendingDelete;

  const tcStack = editable
    ? viewUtc
      ? // Wall + TC inputs stacked
        (() => {
          const wallVal = batchEdit
            ? batchValues?.wall_time_utc
              ? formatWallUtcYmdHms(batchValues.wall_time_utc)
              : ''
            : formatWallUtcYmdHms(event.wall_time_utc);
          const tcVal = batchEdit
            ? (batchValues?.timecode_hms ?? formatTimecodeHMS(event.timecode))
            : formatTimecodeHMS(event.timecode);
          return (
            // `.sheetTcStack.sheetTcStackInline`: flex row, tc + wall side by side.
            <div className="flex flex-row flex-nowrap items-center justify-center gap-[0.35rem] w-full min-h-0">
              <input
                ref={batchEdit ? undefined : wallRef}
                type="text"
                // `.sheetCellControl` reset + `.sheetTcStackInline .sheetWall` sizing.
                className={clsx(CELL_CONTROL, 'flex-[1_1_auto] min-w-0 text-center')}
                defaultValue={batchEdit ? undefined : (draft?.wall_text ?? wallVal)}
                value={batchEdit ? wallVal : undefined}
                aria-label="UTC"
                placeholder="YY-MM-DD HH:MM:SS"
                spellCheck={false}
                disabled={dis}
                onFocus={(e) => recordFocus('wall', e.currentTarget)}
                onSelect={(e) => recordFocus('wall', e.currentTarget)}
                onBlur={handleBlur}
                onChange={
                  batchEdit
                    ? (e) =>
                        fireBatchChange({
                          wall_time_utc: buildWallIso(e.target.value, event.wall_time_utc),
                        })
                    : (e) => writeDraft({ wall_text: e.target.value })
                }
              />
              <input
                ref={batchEdit ? undefined : tcRef}
                type="text"
                // The legacy literals `sheet-cell-control sheet-input sheet-tc` matched NO CSS
                // rule (pre-module names; the hashed `.sheetCellControl`/`.sheetTc` never
                // applied here), so this input rendered bare. Dropped with that as-rendered
                // state preserved — no styling class.
                defaultValue={batchEdit ? undefined : (draft?.timecode_hms ?? tcVal)}
                value={batchEdit ? tcVal : undefined}
                aria-label="Timecode"
                maxLength={8}
                spellCheck={false}
                disabled={dis}
                onFocus={(e) => recordFocus('timecode', e.currentTarget)}
                onSelect={(e) => recordFocus('timecode', e.currentTarget)}
                onBlur={handleBlur}
                onChange={
                  batchEdit
                    ? (e) => fireBatchChange({ timecode_hms: e.target.value.trim() })
                    : (e) => writeDraft({ timecode_hms: e.target.value })
                }
              />
            </div>
          );
        })()
      : (() => {
          const tcVal = batchEdit
            ? (batchValues?.timecode_hms ?? formatTimecodeHMS(event.timecode))
            : formatTimecodeHMS(event.timecode);
          return (
            <input
              ref={batchEdit ? undefined : tcRef}
              type="text"
              // `.sheetCellControl` reset; text-align inherits the edit cell's `text-center`.
              className={CELL_CONTROL}
              defaultValue={batchEdit ? undefined : (draft?.timecode_hms ?? tcVal)}
              value={batchEdit ? tcVal : undefined}
              aria-label="Timecode"
              maxLength={8}
              spellCheck={false}
              disabled={dis}
              onFocus={(e) => recordFocus('timecode', e.currentTarget)}
              onSelect={(e) => recordFocus('timecode', e.currentTarget)}
              onBlur={handleBlur}
              onChange={
                batchEdit
                  ? (e) => fireBatchChange({ timecode_hms: e.target.value.trim() })
                  : (e) => writeDraft({ timecode_hms: e.target.value })
              }
            />
          );
        })()
    : null;

  // Edit-cell background/strikethrough state. `pendingDelete` is only ever set in batch mode,
  // so it implies batch. Edit cells set their own bg (replacing the row-hover tint, which they
  // never take). Strikethrough overlay + relative positioning apply only when pending-delete.
  const editCellBg = editable ? (pendingDelete ? PENDING_CELL_BG : EDIT_CELL_BG) : '';
  // Common pending-delete strikethrough `::after` bits; each cell adds its own left/right.
  const strike =
    "relative after:content-[''] after:absolute after:top-1/2 after:h-px after:-mt-[0.5px] after:bg-[rgba(255,255,255,0.55)] after:pointer-events-none after:z-[5]";

  // --- Category select ---
  const catVal = batchEdit ? (batchValues?.category ?? event.category) : inlineCategory;
  const catOptions = [
    ...categories.map((c) => ({ value: c.id, label: c.label ?? c.id })),
    ...(categories.some((c) => c.id === event.category)
      ? []
      : [{ value: event.category, label: event.category }]),
  ];
  const catSelect = editable ? (
    <Select
      // The legacy `.sheetRowEditable .sheetCellControl` reset (compact inline
      // trigger: block, no padding/border/radius, flat #161825 bg, inherited
      // font, tiny chevron) lives in @layer legacy and now LOSES to the Select
      // trigger's converted utilities. Re-assert the compact box as `!` utilities
      // so it wins within the utilities layer until EventLogSheet is converted.
      className={
        // `.sheetRowEditable .sheetCellControl` reset + `.sheetCatEdit .sheetCatSelect`
        // (cursor-pointer, gap, tiny chevron). `!` beats the Select trigger's own utilities.
        '!block !w-full !max-w-full !box-border !m-0 !min-h-0 !min-w-0 !gap-1 !rounded-none !border-none !p-0 !text-inherit !text-left !shadow-none ![background:#161825] ![font:inherit] !cursor-pointer [&_svg]:!h-[5px] [&_svg]:!w-2'
      }
      ariaLabel="Category"
      disabled={dis}
      // Inline only: the pin exists for the rolling feed, and batch edit
      // neither pins nor virtualizes its drafts away.
      onOpenChange={inlineEditable ? handleCategoryOpenChange : undefined}
      value={catVal}
      onChange={(next) => {
        if (batchEdit) {
          fireBatchChange({ category: next });
        } else {
          setInlineCategory(next);
          // Recorded before the save so a remount mid-round-trip shows the
          // chosen category rather than snapping back to the stale server one.
          writeDraft({ category: next });
          // Inline mode has no traditional blur signal — save immediately.
          saveInline(next);
        }
      }}
      options={catOptions}
    />
  ) : null;

  // --- Message input ---
  const msgVal = batchEdit ? (batchValues?.message ?? event.message ?? '') : (event.message ?? '');
  const msgInput = editable ? (
    <input
      ref={batchEdit ? undefined : msgRef}
      type="text"
      className={CELL_CONTROL}
      defaultValue={batchEdit ? undefined : (draft?.message ?? event.message ?? '')}
      value={batchEdit ? msgVal : undefined}
      aria-label="Message"
      disabled={dis}
      onFocus={(e) => recordFocus('message', e.currentTarget)}
      onSelect={(e) => recordFocus('message', e.currentTarget)}
      onBlur={handleBlur}
      onChange={
        batchEdit
          ? (e) => fireBatchChange({ message: e.target.value })
          : (e) => writeDraft({ message: e.target.value })
      }
    />
  ) : null;

  // --- Delete/undelete hover action ---
  // In batch mode the cluster is always visible (was `.logSheetBatchEdit .rowHoverActions
  // { opacity:1 }`); otherwise it reveals on row hover/focus-within. Pending rows lift it
  // above the strikethrough overlay (z-8, was `.sheetRowPendingDelete .rowHoverActions`).
  // Orphan literals `btn-undelete-row`/`btn-delete` matched no CSS/JS hooks — dropped. `btn`
  // (chrome) stays; the inert `.btnRow` margin-zeroing (`.btn` has no margin) is dropped.
  const rowActionsCls = clsx(
    ROW_HOVER_ACTIONS,
    // Batch mode: always visible. Otherwise: reveal on row hover/focus-within (exclusive —
    // the two visibility states never both land on the element).
    batchEdit ? 'opacity-100 pointer-events-auto' : ROW_ACTIONS_HIDDEN,
    pendingDelete && 'z-[8]',
  );
  const rowActions = isAuto ? null : editable && pendingDelete ? (
    <span className={rowActionsCls}>
      <Tooltip content="Restore row">
        <button
          type="button"
          className="btn"
          aria-label="Restore row"
          onClick={() => onUndelete(event.event_id)}
        >
          UNDELETE
        </button>
      </Tooltip>
    </span>
  ) : (
    <span className={rowActionsCls}>
      <Tooltip content="Delete row">
        <button
          type="button"
          className={ROW_ICON_BTN}
          aria-label="Delete row"
          onClick={() => onDelete(event.event_id)}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M4 7H20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            <path
              d="M9 7V5C9 4.44772 9.44772 4 10 4H14C14.5523 4 15 4.44772 15 5V7"
              stroke="currentColor"
              strokeWidth="1.8"
            />
            <path
              d="M6.5 7L7.4 19.1C7.44 19.61 7.86 20 8.37 20H15.63C16.14 20 16.56 19.61 16.6 19.1L17.5 7"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
            <path
              d="M10 11V16M14 11V16"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </Tooltip>
    </span>
  );

  // `group` on the <tr> drives the row-hover cell tint + hover-action reveal via the
  // `[.group:hover_&]:` ancestor variant (replaces `.sheet tbody tr:hover td` / `tr:hover
  // .rowHoverActions`). Editable cells opt out of the tint (they set their own bg).
  return (
    <tr ref={rowRef} data-event-id={event.event_id} className="group">
      {/* Jump column (feed-row-seek, design D2/D7): its own leading cell, never
          inside the timecode cell — inline editing's contents/width/containing
          block are untouched by this. */}
      <td className={clsx(CELL_BASE, 'text-center align-middle')}>
        {/* Slight scale so the shared h-6 jump control does not dominate row height. */}
        <span className="inline-flex origin-center scale-[0.75]">
          <JumpToTimeButton
            resolvedSec={resolvedSec}
            displayTime={col1View}
            onJump={onJump}
            unavailable={jumpUnavailable}
            reasonId={jumpReasonId}
          />
        </span>
      </td>
      {editable ? (
        // `.colTcCellEdit`: centered (was `td.colTcCellEdit { text-align: center }`, the input
        // inherits it) + edit bg + (batch) white text; pending adds strikethrough (left:2rem).
        <td
          className={clsx(
            CELL_BASE,
            CELL_TC,
            '!text-center',
            editCellBg,
            batchEdit && '!text-white cursor-text',
            pendingDelete && clsx(strike, 'after:left-8 after:right-0'),
          )}
        >
          {tcStack}
        </td>
      ) : (
        <td className={clsx(CELL_BASE, CELL_TC, CELL_HOVER)}>{col1View}</td>
      )}

      {editable ? (
        // `.sheetCatEdit`: edit bg; pending → white text + strikethrough (left:0 right:0).
        <td
          className={clsx(
            CELL_BASE,
            CELL_CAT,
            editCellBg,
            pendingDelete && clsx('!text-white', strike, 'after:left-0 after:right-0'),
          )}
          style={catStyle}
        >
          {catSelect}
        </td>
      ) : (
        <td className={clsx(CELL_BASE, CELL_CAT, CELL_HOVER)} style={catStyle}>
          {event.category_label ?? event.category ?? '—'}
        </td>
      )}

      {editable ? (
        // `.sheetMsgCell`: edit bg; pending strikethrough (right:9.25rem clearance for UNDELETE).
        <td
          className={clsx(
            CELL_BASE,
            CELL_MSG,
            CELL_ACTIONS,
            editCellBg,
            pendingDelete && clsx(strike, 'after:left-0 after:right-[9.25rem]'),
          )}
          data-event-id={event.event_id}
          style={msgStyle}
        >
          {autoMarker ? (
            // Marker beside the input on one line: the input's `min-w-0` lets it shrink
            // by the chip's width; editing behavior (blur-to-save, batch onChange) is
            // untouched — the wrapper carries no handlers.
            <span className="flex items-center">
              {msgInput}
              {autoMarker}
            </span>
          ) : (
            msgInput
          )}
          {rowActions}
        </td>
      ) : (
        <td
          className={clsx(CELL_BASE, CELL_MSG, CELL_ACTIONS, CELL_HOVER)}
          data-event-id={event.event_id}
          style={msgStyle}
        >
          <span className="block">
            {event.message ?? ''}
            {autoMarker}
          </span>
          {rowActions}
        </td>
      )}
    </tr>
  );
}
