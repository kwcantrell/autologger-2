import clsx from 'clsx';
import { GripVertical, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { Show } from '../../../api/types';
import { Button, TOUCH_TARGET } from '../../../shared/components/ui/button';
import { Input } from '../../../shared/components/ui/input';
import { Popover } from '../../../shared/ui/Popover';
import { RadioGroup } from '../../../shared/ui/RadioGroup';
import { normalizePalette9, PALETTE_SLOT_INDICES } from '../utils/palette9';
import { EventInstructionModal } from './EventInstructionModal';
import { EventOptionsModal } from './EventOptionsModal';
import { LazySelect } from './LazySelect';
import { Select } from './Select';
import {
  applyPalettePreset,
  copyButtonsFrom,
  type EventButtonDraft,
  isInstructionBearing,
  newEventButton,
  PALETTE_PRESET_IDS,
  presetLabel,
  setPaletteSlot,
  withButtonType,
} from './settings/eventButtonsModel';
import { showToShowDraft } from './settings/settingsModel';

// The draft type and its rules live in `settings/eventButtonsModel.ts` (redesign-show-ignition
// D6), shared with Settings › Event buttons.
export type { EventButtonDraft };

// Compact event-buttons table (--v6-events-row-h/head-h were both 1.5rem = h-6). The legacy
// `!important` flags on td/dragHandle/colColorCell metrics only beat chrome/legacy rules; as
// utilities they win by layer order, so they are dropped. `--ev-r/g/b` were never set at runtime,
// so the row bg resolves to the static fallback rgb(80 90 110).
const TH_BASE =
  'h-6 px-[0.35rem] py-0 flex items-center text-left border-0 font-semibold text-[rgba(229,238,252,0.55)] text-[0.65rem] tracking-[0.08em] uppercase bg-transparent box-border';
// Shared row-cell metrics. Padding-x is intentionally NOT here: colDrag/colColorCell need their
// own tighter padding, and two competing px-[…] utilities on one element resolve by generated-CSS
// order (not class order) — so each cell supplies its own px explicitly.
// Body cells: h-6 (1.5rem) + 1.6rem → 3.1rem. Grid items ignore align-middle — flex centers instead.
const TD_BASE =
  'h-[3.1rem] min-h-0 max-h-[3.1rem] py-0 flex items-center text-left border-0 leading-none box-border';
// Non-color / non-drag body cells: card tint + hover brighten + the 0.4rem px.
// Hover is on the cell (not tr/group) because the table uses display:contents rows.
const TD_CARD =
  'px-[0.4rem] bg-[rgb(80_90_110/0.16)] [box-shadow:inset_0_1px_0_rgba(255,255,255,0.04)] hover-always:bg-[rgb(80_90_110/0.24)]';
// Shared compact metrics so every control fits the control band and sits on the vertical middle.
// `.profile-select` ships `margin: 0 0 1rem` and Select defaults to `min-h-9` — both fight
// `align-middle` unless overridden here.
const ROW_CONTROL = '!m-0 !box-border !h-6 !max-h-6 !min-h-0 !py-0 !leading-none align-middle';
// Event name + button type: h-6 + 0.5rem. min-w-0 so grid/minmax columns can clip cleanly.
const ROW_FIELD =
  '!m-0 !box-border !h-[2rem] !max-h-[2rem] !min-w-0 !max-w-full !py-0 !leading-none align-middle';
// Row icon buttons (drag / delete) on the shadcn icon-xs Button: 1.45rem × h-6 as before, plus
// the 44px phone floor the legacy `.btn` gave them (shadcn-port-settings D2b).
const ROW_ICON_BTN = clsx('p-0 min-w-0 w-[1.45rem] h-6 align-middle', TOUCH_TARGET);

// Column floors (px): name 300 + type 120 + color 55 + options 300 + auto 148 + delete 55.
// Type floor fits "DROPDOWN" + chevron; table scrolls only below drag + these floors.
const EV_COLS_MIN_SUM_PX = 300 + 120 + 55 + 300 + 148 + 55; // 978
// minmax(floor, %) so type/auto never collapse under their text at mid widths.
const EV_COL_TEMPLATE =
  '1.85rem minmax(300px, 1fr) minmax(120px, 10%) minmax(55px, 3%) minmax(300px, 35%) minmax(148px, 8%) minmax(55px, 3%)';

const BUTTON_TYPE_OPTIONS = [
  { value: 'BUTTON', label: 'BUTTON' },
  { value: 'DROPDOWN', label: 'DROPDOWN' },
  { value: 'TEXT', label: 'TEXT' },
  { value: 'ON_OFF', label: 'ON / OFF' },
];

interface Props {
  buttons: EventButtonDraft[];
  palette: string[];
  palettePreset: string;
  paletteCustom: string[];
  otherShows: Show[];
  onChange: (
    buttons: EventButtonDraft[],
    palette: string[],
    palettePreset: string,
    paletteCustom: string[],
  ) => void;
}

// ── Constants ─────────────────────────────────────────────────────────────────

function onOffSummary(onLabel: string, offLabel: string): string {
  const s = `${onLabel.trim() || 'ON'}, ${offLabel.trim() || 'OFF'}`;
  return s.length > 42 ? `${s.slice(0, 40)}…` : s;
}

/** Per-option chip in the Options column — width follows the label text. */
const OPTION_BUBBLE =
  'inline-flex w-fit max-w-full shrink-0 items-center rounded-full border border-[rgba(255,255,255,0.18)] bg-[rgba(255,255,255,0.08)] px-[0.45rem] py-[0.12rem] text-[0.65rem] font-semibold leading-none tracking-[0.04em] text-[rgba(229,238,252,0.9)]';

// ── Main component ────────────────────────────────────────────────────────────

export function EventButtonsTable({
  buttons,
  palette,
  palettePreset,
  paletteCustom,
  otherShows,
  onChange,
}: Props) {
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const [openColorFor, setOpenColorFor] = useState<string | null>(null);
  const [openInstructionFor, setOpenInstructionFor] = useState<string | null>(null);
  const [editingOptsFor, setEditingOptsFor] = useState<string | null>(null);
  const [copyFromId, setCopyFromId] = useState('');

  const normPalette = normalizePalette9(palette);

  // ── Helpers ────────────────────────────────────────────────────────────────

  function applyPreset(preset: string) {
    const next = applyPalettePreset(
      {
        event_palette: palette,
        event_palette_preset: palettePreset,
        event_palette_custom: paletteCustom,
      },
      preset,
    );
    onChange(buttons, next.event_palette, next.event_palette_preset, next.event_palette_custom);
  }

  function updatePaletteSlot(idx: number, hex: string) {
    const next = setPaletteSlot(
      {
        event_palette: palette,
        event_palette_preset: palettePreset,
        event_palette_custom: paletteCustom,
      },
      idx,
      hex,
    );
    onChange(buttons, next.event_palette, next.event_palette_preset, next.event_palette_custom);
  }

  function updateButton(id: string, patch: Partial<EventButtonDraft>) {
    onChange(
      buttons.map((b) => (b.id === id ? { ...b, ...patch } : b)),
      palette,
      palettePreset,
      paletteCustom,
    );
  }

  function deleteButton(id: string) {
    onChange(
      buttons.filter((b) => b.id !== id),
      palette,
      palettePreset,
      paletteCustom,
    );
  }

  function addButton() {
    onChange(
      [newEventButton(normPalette, 'Sample Button'), ...buttons],
      palette,
      palettePreset,
      paletteCustom,
    );
  }

  function copyFromShow() {
    if (!copyFromId) return;
    const src = otherShows.find((s) => s.id === copyFromId);
    if (!src) return;
    // Buttons under fresh ids with their instructions, and the source's palette.
    const copied = copyButtonsFrom(showToShowDraft(src));
    onChange(
      copied.categories,
      copied.event_palette,
      copied.event_palette_preset,
      copied.event_palette_custom,
    );
    setCopyFromId('');
  }

  function handleDrop(targetIdx: number) {
    if (dragIdx === null || dragIdx === targetIdx) {
      setDragIdx(null);
      setDragOverIdx(null);
      return;
    }
    const next = [...buttons];
    const [removed] = next.splice(dragIdx, 1);
    next.splice(targetIdx, 0, removed);
    onChange(next, palette, palettePreset, paletteCustom);
    setDragIdx(null);
    setDragOverIdx(null);
  }

  const editingBtn = editingOptsFor ? buttons.find((b) => b.id === editingOptsFor) : null;
  const instructionBtn = openInstructionFor
    ? buttons.find((b) => b.id === openInstructionFor)
    : null;

  // .tableWrapReact had no rules (reserved container); the wrapper div stays class-less.
  return (
    <div>
      {/* Palette section */}
      <div className="mt-4 mb-4 pb-3 border-b border-v5-border">
        <h3 className="m-0 mb-2 text-[0.78rem] font-semibold tracking-[0.06em] uppercase text-[rgba(229,238,252,0.72)]">
          Event colors
        </h3>
        <div className="flex flex-row flex-wrap items-center justify-start gap-x-[0.85rem] gap-y-[0.6rem] w-full box-border">
          <div className="flex flex-row flex-wrap items-center justify-start gap-x-[0.65rem] gap-y-[0.45rem] flex-[1_1_12rem] min-w-0">
            <RadioGroup
              ariaLabel="Color palette preset"
              className="flex flex-wrap items-center gap-x-[0.45rem] gap-y-[0.35rem] m-0"
              value={palettePreset}
              onChange={applyPreset}
              options={PALETTE_PRESET_IDS.map((id) => ({ value: id, label: presetLabel(id) }))}
              itemClassName={(_id, checked) =>
                clsx(
                  'px-[0.65rem] py-[0.28rem] text-[0.72rem] font-semibold tracking-[0.04em] rounded-full border cursor-pointer',
                  checked
                    ? 'border-[rgba(56,189,248,0.55)] bg-[rgba(56,189,248,0.18)] text-[#e8f4ff]'
                    : 'border-[rgba(255,255,255,0.14)] bg-[rgba(255,255,255,0.06)] text-[rgba(229,238,252,0.88)] hover-always:bg-[rgba(255,255,255,0.1)]',
                )
              }
            />
            {/* 9 palette swatches; PALETTE_SLOT_INDICES are static values, not .map() indices */}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-[0.4rem] m-0">
              {PALETTE_SLOT_INDICES.map((slotIdx) => (
                <label key={slotIdx} title={`Slot ${slotIdx + 1}: ${normPalette[slotIdx]}`}>
                  <input
                    type="color"
                    className="pal-slot"
                    value={normPalette[slotIdx]}
                    onChange={(e) => updatePaletteSlot(slotIdx, e.target.value)}
                  />
                </label>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Toolbar. .thToolbar row/justify/min-w/flex kept as utilities; the inline style (out of
          scope until Task 11) still supplies display/gap/wrap/items/margin-bottom. */}
      <div
        className="flex-row justify-end min-w-0 flex-[1_1_auto]"
        style={{
          marginBottom: '0.5rem',
          display: 'flex',
          gap: '0.5rem',
          flexWrap: 'wrap',
          alignItems: 'center',
        }}
      >
        <div className="flex flex-row flex-wrap items-center gap-x-[0.45rem] gap-y-[0.35rem] min-w-0">
          {/* .copyFromLabel */}
          <span className="text-[0.62rem] font-semibold tracking-[0.06em] uppercase text-[rgba(229,238,252,0.5)] whitespace-nowrap">
            Copy Buttons From
          </span>
          {/* .copyFromSelect had no live rule (its #modal-app-settings rule was purged). */}
          <Select
            value={copyFromId}
            onChange={setCopyFromId}
            disabled={!otherShows.length}
            ariaLabel="Show to copy event buttons from"
            placeholder={otherShows.length ? 'Select a show…' : 'No other shows on this team'}
            options={otherShows.map((s) => ({
              value: s.id,
              label: s.name || s.show_code || s.id,
            }))}
          />
          <Button className={TOUCH_TARGET} disabled={!copyFromId} onClick={copyFromShow}>
            Copy
          </Button>
        </div>
        <Button className={TOUCH_TARGET} onClick={addButton}>
          Add new button
        </Button>
      </div>

      {/* Event buttons table — CSS grid + minmax so column floors hold while width:100%
          still fits when the container is ≥ sum of mins (scroll only below that). */}
      <div className="overflow-x-auto">
        <table
          className="w-full gap-y-2 text-[0.75rem] [display:grid]"
          style={{
            minWidth: `calc(1.85rem + ${EV_COLS_MIN_SUM_PX}px)`,
            gridTemplateColumns: EV_COL_TEMPLATE,
          }}
          aria-label="Event buttons"
        >
          <thead className="contents">
            <tr className="contents">
              {/* th.thDrag: centered, slim padding (!px beats TH_BASE's 0.35rem). */}
              <th
                className={clsx(TH_BASE, 'min-w-0 justify-center !px-[0.15rem] !text-center')}
                scope="col"
              >
                <span className="sr-only">Reorder</span>
              </th>
              <th className={clsx(TH_BASE, 'min-w-0')} scope="col">
                Event name
              </th>
              <th className={clsx(TH_BASE, 'min-w-0')} scope="col">
                Button type
              </th>
              <th className={clsx(TH_BASE, 'min-w-0 justify-center !text-center')} scope="col">
                Color
              </th>
              <th className={clsx(TH_BASE, 'min-w-0')} scope="col">
                Options
              </th>
              <th className={clsx(TH_BASE, 'min-w-0 justify-end !text-right')} scope="col">
                Auto
              </th>
              <th className={clsx(TH_BASE, 'min-w-0 justify-center !text-center')} scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="contents">
            {buttons.map((btn, idx) => {
              const canEditOpts = btn.type === 'DROPDOWN' || btn.type === 'ON_OFF';
              const bearing = isInstructionBearing(btn);
              // tr is display:contents — opacity must land on the cells.
              const rowDim = dragOverIdx === idx && 'opacity-[0.55]';

              return (
                <tr
                  key={btn.id}
                  className="contents"
                  draggable
                  onDragStart={() => setDragIdx(idx)}
                  onDragEnd={() => {
                    setDragIdx(null);
                    setDragOverIdx(null);
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOverIdx(idx);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    handleDrop(idx);
                  }}
                >
                  {/* colDrag (first child): own bg, centered, left rounding. */}
                  <td
                    className={clsx(
                      TD_BASE,
                      rowDim,
                      // !text-center beats TD_BASE's text-left (same-property, CSS-order resolved).
                      'min-w-0 justify-center px-[0.1rem] !text-center bg-[rgba(255,255,255,0.04)] rounded-l-[0.65rem]',
                    )}
                  >
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className={clsx(
                        ROW_ICON_BTN,
                        'cursor-grab text-[rgba(229,238,252,0.55)] active:cursor-grabbing',
                      )}
                      aria-label="Drag to reorder"
                      draggable
                      onDragStart={(e) => {
                        e.stopPropagation();
                        setDragIdx(idx);
                      }}
                    >
                      <GripVertical className="size-3.5" aria-hidden="true" />
                    </Button>
                  </td>

                  {/* colNameWrap (2nd child): card cell, text-left, extra left padding. */}
                  {/* pl-2 (0.5rem, was td:nth-child(2)) must beat TD_CARD's px-[0.4rem] left;
                    same-property utilities resolve by CSS order, so force it with `!`. */}
                  <td className={clsx(TD_BASE, TD_CARD, rowDim, 'min-w-0 text-left !pl-2')}>
                    <Input
                      type="text"
                      className={clsx(ROW_FIELD, '!w-full !px-2')}
                      value={btn.name}
                      maxLength={200}
                      placeholder="Event name"
                      onChange={(e) => updateButton(btn.id, { name: e.target.value })}
                    />
                  </td>

                  <td className={clsx(TD_BASE, TD_CARD, rowDim, 'min-w-0 overflow-hidden')}>
                    <LazySelect
                      ariaLabel="Button type"
                      value={btn.type}
                      className={clsx(
                        ROW_FIELD,
                        '!w-full !gap-1 !px-1.5 !text-[0.68rem] !rounded-[0.4rem] overflow-hidden',
                        // Radix Value is the first span — truncate so DROPDOWN/ON_OFF never spill.
                        '[&>span:first-child]:min-w-0 [&>span:first-child]:truncate',
                      )}
                      onChange={(value) =>
                        updateButton(btn.id, withButtonType(btn, value as EventButtonDraft['type']))
                      }
                      options={BUTTON_TYPE_OPTIONS}
                    />
                  </td>

                  {/* Color swatch cell — same card tint as the rest of the row. */}
                  <td
                    className={clsx(
                      TD_BASE,
                      TD_CARD,
                      rowDim,
                      // `!text-center` beats TD_BASE's `text-left` (utility order ≠ class order).
                      'relative min-w-0 justify-center !px-0 !text-center cursor-pointer focus-visible:outline-2 focus-visible:outline-v5-primary focus-visible:-outline-offset-1 focus-visible:z-[1]',
                    )}
                  >
                    <Popover
                      open={openColorFor === btn.id}
                      onOpenChange={(o) => setOpenColorFor(o ? btn.id : null)}
                      ariaLabel="Event colors"
                      className="grid grid-cols-[repeat(3,2.75rem)] gap-[0.4rem] p-[0.35rem]"
                      align="center"
                      // Bare-button trigger (same as the instruction popover): a
                      // Tooltip wrapper swallows Radix trigger props so the 3×3
                      // palette never opens.
                      trigger={
                        <button
                          type="button"
                          aria-label="Pick button color"
                          title="Pick color"
                          className="inline-block h-[1.5rem] w-[1.5rem] align-middle rounded-[3px] border border-black/20 p-0 cursor-pointer"
                          style={{ backgroundColor: btn.color }}
                        />
                      }
                    >
                      {normPalette.map((hex) => (
                        <button
                          key={hex}
                          type="button"
                          className="w-[2.75rem] h-[2.75rem] p-0 m-0 border border-[rgba(255,255,255,0.2)] rounded-[0.4rem] cursor-pointer box-border focus-visible:outline-2 focus-visible:outline-v5-primary focus-visible:outline-offset-1"
                          style={{ backgroundColor: hex }}
                          aria-label={`Color ${hex}`}
                          onClick={() => {
                            updateButton(btn.id, { color: hex });
                            setOpenColorFor(null);
                          }}
                        />
                      ))}
                    </Popover>
                  </td>

                  {/* colOptionsWrap: DROPDOWN rows render one bubble per option (text-sized). */}
                  <td className={clsx(TD_BASE, TD_CARD, rowDim, 'min-w-0 text-left')}>
                    {btn.type === 'DROPDOWN' ? (
                      <button
                        type="button"
                        aria-label="Edit dropdown options"
                        // A chip container, not a styled button: unstyled, the chips carry the look.
                        className="m-0 box-border inline-flex w-auto max-w-full flex-wrap items-center justify-start gap-[0.3rem] border-0 bg-transparent p-0 align-middle cursor-pointer rounded-v5-sm focus-visible:outline-2 focus-visible:outline-v5-primary"
                        onClick={() => setEditingOptsFor(btn.id)}
                      >
                        {btn.dropdown_options.length ? (
                          btn.dropdown_options.map((opt, optIdx) => (
                            // biome-ignore lint/suspicious/noArrayIndexKey: read-only positional bubbles inside one button — options have no id, labels may legitimately duplicate, and the list never reorders in place (any edit replaces the whole array).
                            <span key={`${btn.id}-opt-${optIdx}`} className={OPTION_BUBBLE}>
                              {opt.label.trim() || '—'}
                            </span>
                          ))
                        ) : (
                          <span className={OPTION_BUBBLE}>—</span>
                        )}
                      </button>
                    ) : (
                      <Button
                        variant="outline"
                        size="xs"
                        className={clsx(ROW_CONTROL, '!w-auto !px-2 !text-[0.65rem]', TOUCH_TARGET)}
                        disabled={!canEditOpts}
                        onClick={() => canEditOpts && setEditingOptsFor(btn.id)}
                      >
                        {btn.type === 'ON_OFF' ? onOffSummary(btn.on_label, btn.off_label) : 'N/A'}
                      </Button>
                    )}
                  </td>

                  {/* Generation-instruction cell (auto-generate-event-logs): label
                    opens a centered modal editor. The lit trigger doubles as the
                    instruction-bearing indicator. ON_OFF rows offer no field. */}
                  <td
                    className={clsx(
                      TD_BASE,
                      TD_CARD,
                      rowDim,
                      'min-w-0 justify-end overflow-hidden !px-[0.15rem] !text-right',
                    )}
                  >
                    {btn.type === 'ON_OFF' ? (
                      <span
                        className="inline-block align-middle text-[rgba(229,238,252,0.35)]"
                        aria-hidden="true"
                      >
                        —
                      </span>
                    ) : (
                      <Button
                        variant="outline"
                        size="xs"
                        // The aria-label wins the accessible-name computation, so the
                        // bearing state must live IN the label — a sibling sr-only
                        // span would never be announced (color alone isn't state).
                        aria-label={bearing ? 'AI Rules (has instructions)' : 'AI Rules'}
                        title="AI Rules"
                        className={clsx(
                          '!m-0 !box-border !h-[1.7rem] !max-h-[1.7rem] !min-w-0 !py-0 !leading-none',
                          '!w-full !px-1 !text-[0.55rem] !tracking-[0.04em] align-middle',
                          'overflow-hidden',
                          TOUCH_TARGET,
                          // contrastTokens.test.ts regex-reads this expression: keep it verbatim.
                          bearing ? 'text-v5-primary' : 'text-v5-muted',
                        )}
                        onClick={() => setOpenInstructionFor(btn.id)}
                      >
                        <span className="min-w-0 truncate">AI Rules</span>
                      </Button>
                    )}
                  </td>

                  {/* Delete (last child): card cell, right rounding + right padding. */}
                  <td
                    className={clsx(
                      TD_BASE,
                      TD_CARD,
                      rowDim,
                      'min-w-0 justify-center rounded-r-[0.65rem] pr-[0.4rem] !text-center',
                    )}
                  >
                    {/* .colDelete: only the svg display:block/shrink-0 rule survived. */}
                    <Button
                      variant="destructive"
                      size="icon-xs"
                      className={ROW_ICON_BTN}
                      aria-label="Remove event"
                      onClick={() => deleteButton(btn.id)}
                    >
                      <Trash2 className="size-[0.8rem]" aria-hidden="true" />
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {editingBtn && (editingBtn.type === 'DROPDOWN' || editingBtn.type === 'ON_OFF') && (
        <EventOptionsModal
          type={editingBtn.type}
          options={editingBtn.dropdown_options}
          onLabel={editingBtn.on_label}
          offLabel={editingBtn.off_label}
          autoInstruction={editingBtn.auto_instruction}
          onConfirm={(result) => {
            updateButton(editingBtn.id, {
              dropdown_options: result.options,
              on_label: result.onLabel,
              off_label: result.offLabel,
              auto_instruction: result.autoInstruction,
            });
            setEditingOptsFor(null);
          }}
          onClose={() => setEditingOptsFor(null)}
        />
      )}

      {instructionBtn && (
        <EventInstructionModal
          buttonName={instructionBtn.name}
          initialInstruction={instructionBtn.auto_instruction}
          onSave={(instruction) => {
            updateButton(instructionBtn.id, { auto_instruction: instruction });
            setOpenInstructionFor(null);
          }}
          onClose={() => setOpenInstructionFor(null)}
        />
      )}
    </div>
  );
}
