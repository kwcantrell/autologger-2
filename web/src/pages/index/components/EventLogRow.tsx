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
import { Select } from './Select';

// EventLogRow cell/row chrome (was EventLogSheet.module.css, shared @layer legacy). The row
// hover tint + hover-actions reveal use the `group`/`group-hover` pattern: the <tr> carries
// `group`, its tds/reveal use `[.group:hover_&]:` (arbitrary ancestor variant — composes with
// the hovered <tr> whether or not our custom `hover-always` would). Edit-mode/pending-delete
// cells set their OWN background and must NOT take the row-hover tint, so those cells get an
// exclusive background utility instead of the group-hover one.

/** Base sheet cell padding/border (was `.sheet td` + `.sheet-dense td`). `text-align`/
 *  `vertical-align` are set per cell (tc/cat: left+middle; the actions cell: center+middle via
 *  CELL_ACTIONS) so the two alignments never collide on one element. */
const CELL_BASE =
  'px-[0.55rem] py-[0.38rem] text-[0.84rem] [border-bottom:1px_solid_var(--border)]';
/** Row-hover tint for non-edit cells (was `.sheet tbody tr:hover td`). */
const CELL_HOVER = '[.group:hover_&]:bg-[rgba(124,183,255,0.06)]';
/** Timecode cell (was `.sheet .tc` + the `cursor:pointer!important` lock on td.tc + children). */
const CELL_TC =
  'text-left align-middle font-[family-name:var(--font-mono)] text-accent whitespace-nowrap !cursor-pointer [&_*]:!cursor-pointer';
/** Category cell (was `.sheetCat`). */
const CELL_CAT = 'text-left align-middle font-semibold whitespace-nowrap';
/** Message cell max-width (was `.sheet-dense .msg`, which beat `.sheet .msg`). */
const CELL_MSG = 'max-w-[min(28rem,38vw)]';
/** Message/actions cell chrome (was `.msg` + `.rowActions`). NOTE: `.rowActions`'s
 *  `text-align: center` was DEAD in the legacy cascade — `.sheet td { text-align: left }`
 *  (0,1,1) beat `.rowActions` (0,1,0), so the cell rendered LEFT. We keep that effective
 *  left alignment. */
const CELL_ACTIONS = 'text-left whitespace-nowrap align-middle leading-none';
/** Positioning/geometry for the hover action cluster (was `.rowHoverActions`). Visibility is
 *  applied separately (ROW_ACTIONS_HIDDEN reveal-on-hover, or always-on in batch) so the two
 *  opacity/pointer-events states never stack on one element. */
const ROW_HOVER_ACTIONS =
  'absolute right-8 top-1/2 -translate-y-1/2 inline-flex gap-[0.2rem] [transition:opacity_0.14s_ease]';
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

export interface RowEditValues {
  category: string;
  message: string;
  timecode_hms: string;
  wall_time_utc: string;
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
  onInlineSave,
  onBatchChange,
  onDelete,
  onUndelete,
}: Props) {
  const isAuto = isAutomaticLogEvent(event);
  const editable = !isAuto && (inlineEdit || batchEdit);
  const color = event.category_color || undefined;
  const isInternal = event.category.toLowerCase() === 'internal';

  const catStyle = color ? { color } : undefined;
  const msgStyle = isInternal ? catStyle : { color: 'var(--color-text)' };

  // --- Refs for inline rolling edit (uncontrolled, blur-to-save) ---
  const tcRef = useRef<HTMLInputElement>(null);
  const wallRef = useRef<HTMLInputElement>(null);
  const msgRef = useRef<HTMLInputElement>(null);
  // Category is now controlled (Radix Select needs state) but still saves via blur of siblings.
  const [inlineCategory, setInlineCategory] = useState(event.category);

  // Keep inline inputs in sync when event changes (e.g., after save + refetch)
  // but only when not currently focused inside this row
  const rowRef = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    if (!inlineEdit) return;
    const row = rowRef.current;
    if (row?.contains(document.activeElement)) return;
    if (tcRef.current) tcRef.current.value = formatTimecodeHMS(event.timecode);
    if (wallRef.current) wallRef.current.value = formatWallUtcYmdHms(event.wall_time_utc);
    setInlineCategory(event.category);
    if (msgRef.current) msgRef.current.value = event.message ?? '';
  }, [event, inlineEdit]);

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
    )
      return;
    onInlineSave(event, { category: cat, message: msg, timecode_hms: tc, wall_time_utc: wall });
  };

  const handleBlur = () => {
    if (!inlineEdit || isAuto) return;
    // Defer to let focus settle
    setTimeout(() => {
      const row = rowRef.current;
      if (!row) return;
      if (row.contains(document.activeElement)) return;
      saveInline();
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
                defaultValue={batchEdit ? undefined : wallVal}
                value={batchEdit ? wallVal : undefined}
                aria-label="UTC"
                placeholder="YY-MM-DD HH:MM:SS"
                spellCheck={false}
                disabled={dis}
                onBlur={handleBlur}
                onChange={
                  batchEdit
                    ? (e) =>
                        fireBatchChange({
                          wall_time_utc: buildWallIso(e.target.value, event.wall_time_utc),
                        })
                    : undefined
                }
              />
              <input
                ref={batchEdit ? undefined : tcRef}
                type="text"
                // The legacy literals `sheet-cell-control sheet-input sheet-tc` matched NO CSS
                // rule (pre-module names; the hashed `.sheetCellControl`/`.sheetTc` never
                // applied here), so this input rendered bare. Dropped with that as-rendered
                // state preserved — no styling class.
                defaultValue={batchEdit ? undefined : tcVal}
                value={batchEdit ? tcVal : undefined}
                aria-label="Timecode"
                maxLength={8}
                spellCheck={false}
                disabled={dis}
                onBlur={handleBlur}
                onChange={
                  batchEdit
                    ? (e) => fireBatchChange({ timecode_hms: e.target.value.trim() })
                    : undefined
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
              defaultValue={batchEdit ? undefined : tcVal}
              value={batchEdit ? tcVal : undefined}
              aria-label="Timecode"
              maxLength={8}
              spellCheck={false}
              disabled={dis}
              onBlur={handleBlur}
              onChange={
                batchEdit
                  ? (e) => fireBatchChange({ timecode_hms: e.target.value.trim() })
                  : undefined
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
      value={catVal}
      onChange={(next) => {
        if (batchEdit) {
          fireBatchChange({ category: next });
        } else {
          setInlineCategory(next);
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
      defaultValue={batchEdit ? undefined : (event.message ?? '')}
      value={batchEdit ? msgVal : undefined}
      aria-label="Message"
      disabled={dis}
      onBlur={handleBlur}
      onChange={batchEdit ? (e) => fireBatchChange({ message: e.target.value }) : undefined}
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
          className="btn"
          aria-label="Delete row"
          onClick={() => onDelete(event.event_id)}
        >
          🗑
        </button>
      </Tooltip>
    </span>
  );

  // `group` on the <tr> drives the row-hover cell tint + hover-action reveal via the
  // `[.group:hover_&]:` ancestor variant (replaces `.sheet tbody tr:hover td` / `tr:hover
  // .rowHoverActions`). Editable cells opt out of the tint (they set their own bg).
  return (
    <tr ref={rowRef} data-event-id={event.event_id} className="group">
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
          {msgInput}
          {rowActions}
        </td>
      ) : (
        <td
          className={clsx(CELL_BASE, CELL_MSG, CELL_ACTIONS, CELL_HOVER)}
          data-event-id={event.event_id}
          style={msgStyle}
        >
          <span className="block">{event.message ?? ''}</span>
          {rowActions}
        </td>
      )}
    </tr>
  );
}
