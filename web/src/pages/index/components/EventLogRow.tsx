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
import styles from './EventLogSheet.module.css';
import { Select } from './Select';

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
  const msgStyle = isInternal ? catStyle : { color: 'var(--text)' };

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
            <div className={clsx(styles.sheetTcStack, styles.sheetTcStackInline)}>
              <input
                ref={batchEdit ? undefined : wallRef}
                type="text"
                className={clsx(styles.sheetCellControl, styles.sheetWall)}
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
                className="sheet-cell-control sheet-input sheet-tc"
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
              className={clsx(styles.sheetCellControl, styles.sheetTc)}
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

  const rowClass = editable
    ? clsx(styles.sheetRowEditable, pendingDelete && styles.sheetRowPendingDelete)
    : undefined;

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
      className={clsx(
        styles.sheetCellControl,
        styles.sheetCatSelect,
        '!block !min-h-0 !gap-1 !rounded-none !border-none !p-0 !text-inherit ![background:#161825] ![font:inherit] [&_svg]:!h-[5px] [&_svg]:!w-2',
      )}
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
      className={styles.sheetCellControl}
      defaultValue={batchEdit ? undefined : (event.message ?? '')}
      value={batchEdit ? msgVal : undefined}
      aria-label="Message"
      disabled={dis}
      onBlur={handleBlur}
      onChange={batchEdit ? (e) => fireBatchChange({ message: e.target.value }) : undefined}
    />
  ) : null;

  // --- Delete/undelete hover action ---
  const rowActions = isAuto ? null : editable && pendingDelete ? (
    <span className={styles.rowHoverActions}>
      <Tooltip content="Restore row">
        <button
          type="button"
          className={clsx('btn', styles.btnRow, 'btn-undelete-row')}
          aria-label="Restore row"
          onClick={() => onUndelete(event.event_id)}
        >
          UNDELETE
        </button>
      </Tooltip>
    </span>
  ) : (
    <span className={styles.rowHoverActions}>
      <Tooltip content="Delete row">
        <button
          type="button"
          className={clsx('btn', styles.btnRow, 'btn-delete')}
          aria-label="Delete row"
          onClick={() => onDelete(event.event_id)}
        >
          🗑
        </button>
      </Tooltip>
    </span>
  );

  return (
    <tr ref={rowRef} data-event-id={event.event_id} className={rowClass ?? undefined}>
      {editable ? (
        <td className={clsx(styles.tc, styles.colTcCellEdit)}>{tcStack}</td>
      ) : (
        <td className={styles.tc}>{col1View}</td>
      )}

      {editable ? (
        <td className={clsx(styles.sheetCat, styles.sheetCatEdit)} style={catStyle}>
          {catSelect}
        </td>
      ) : (
        <td className={styles.sheetCat} style={catStyle}>
          {event.category_label ?? event.category ?? '—'}
        </td>
      )}

      {editable ? (
        <td
          className={clsx(styles.msg, styles.rowActions, styles.sheetMsgCell)}
          data-event-id={event.event_id}
          style={msgStyle}
        >
          {msgInput}
          {rowActions}
        </td>
      ) : (
        <td
          className={clsx(styles.msg, styles.rowActions)}
          data-event-id={event.event_id}
          style={msgStyle}
        >
          <span className={styles.rowMsgText}>{event.message ?? ''}</span>
          {rowActions}
        </td>
      )}
    </tr>
  );
}
