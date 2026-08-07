import clsx from 'clsx';
import { useState } from 'react';
import type { Show, ShowDropdownOption } from '../../../api/types';
import { BTN_PRIMARY_SKY } from '../../../shared/theme/classnames';
import { Popover } from '../../../shared/ui/Popover';
import { RadioGroup } from '../../../shared/ui/RadioGroup';
import { DEFAULT_PALETTE, normalizePalette9, PALETTE_SLOT_INDICES } from '../utils/palette9';
import { EventInstructionModal } from './EventInstructionModal';
import { EventOptionsModal } from './EventOptionsModal';
import { Select } from './Select';

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
const ROW_ICON_BTN =
  'btn btn-icon p-0 min-w-0 w-[1.45rem] h-6 max-h-6 inline-flex items-center justify-center align-middle';

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

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EventButtonDraft {
  id: string;
  name: string;
  type: 'BUTTON' | 'DROPDOWN' | 'TEXT' | 'ON_OFF';
  color: string;
  /** Options carry their own optional `auto_instruction` (wire key) — the draft
   * passes them through verbatim (auto-generate-event-logs). */
  dropdown_options: ShowDropdownOption[];
  on_label: string;
  off_label: string;
  /** Whole-button generation instruction (auto-generate-event-logs). Draft-local
   * `''` means absent; the save mapping emits the `auto_instruction` wire key only
   * when non-empty. ON_OFF drafts always hold `''` (never instruction-bearing). */
  auto_instruction: string;
}

/**
 * Single instruction-bearing definition (auto-event-generation spec): the button's
 * own instruction is non-empty, or — DROPDOWN only — at least one option's is.
 * ON_OFF never bears, and option instructions lingering on a non-DROPDOWN draft
 * (after a type switch away from DROPDOWN) do not count.
 */
function isInstructionBearing(btn: EventButtonDraft): boolean {
  if (btn.type === 'ON_OFF') return false;
  if (btn.auto_instruction.trim()) return true;
  return (
    btn.type === 'DROPDOWN' &&
    btn.dropdown_options.some((o) => (o.auto_instruction ?? '').trim().length > 0)
  );
}

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

const EVENT_COLOR_PRESETS: Record<string, string[]> = {
  default: [
    '#ff7a7a',
    '#ffd98a',
    '#e7ff95',
    '#83fff3',
    '#50caff',
    '#aa57ff',
    '#ff87d9',
    '#e1a8ff',
    '#d6dfff',
  ],
  neon: [
    '#ff2525',
    '#ff9229',
    '#fff725',
    '#7aff25',
    '#25ffec',
    '#2567ff',
    '#4c25ff',
    '#be25ff',
    '#ff25b8',
  ],
  desert: [
    '#ebe1bd',
    '#fad0ba',
    '#f18565',
    '#d34c34',
    '#a53f45',
    '#967d62',
    '#a9bb96',
    '#85cb48',
    '#57b4e4',
  ],
  aqua: [
    '#a6d5dd',
    '#6fa9c2',
    '#038c95',
    '#3ee6e0',
    '#47f39b',
    '#7fcba4',
    '#9cde56',
    '#bdee11',
    '#cfe583',
  ],
};
function onOffSummary(onLabel: string, offLabel: string): string {
  const s = `${onLabel.trim() || 'ON'}, ${offLabel.trim() || 'OFF'}`;
  return s.length > 42 ? `${s.slice(0, 40)}…` : s;
}

/** Per-option chip in the Options column — width follows the label text. */
const OPTION_BUBBLE =
  'inline-flex w-fit max-w-full shrink-0 items-center rounded-full border border-[rgba(255,255,255,0.18)] bg-[rgba(255,255,255,0.08)] px-[0.45rem] py-[0.12rem] text-[0.65rem] font-semibold leading-none tracking-[0.04em] text-[rgba(229,238,252,0.9)]';

const DragGrip = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden="true"
  >
    <circle cx="9" cy="6" r="1.5" />
    <circle cx="15" cy="6" r="1.5" />
    <circle cx="9" cy="12" r="1.5" />
    <circle cx="15" cy="12" r="1.5" />
    <circle cx="9" cy="18" r="1.5" />
    <circle cx="15" cy="18" r="1.5" />
  </svg>
);

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
    let newPalette: string[];
    let newCustom: string[];
    if (preset === 'custom') {
      newPalette = normalizePalette9(paletteCustom.length ? paletteCustom : palette);
      newCustom = newPalette.slice();
    } else {
      newPalette = normalizePalette9(EVENT_COLOR_PRESETS[preset] ?? DEFAULT_PALETTE);
      newCustom = paletteCustom.length ? normalizePalette9(paletteCustom) : newPalette.slice();
    }
    onChange(buttons, newPalette, preset, newCustom);
  }

  function updatePaletteSlot(idx: number, hex: string) {
    const next = normPalette.map((c, i) => (i === idx ? hex.toLowerCase() : c));
    onChange(buttons, next, 'custom', next.slice());
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
      [
        {
          id: crypto.randomUUID(),
          name: 'Sample Button',
          type: 'BUTTON',
          color: normPalette[0] ?? '#64748b',
          dropdown_options: [],
          on_label: '',
          off_label: '',
          auto_instruction: '',
        },
        ...buttons,
      ],
      palette,
      palettePreset,
      paletteCustom,
    );
  }

  function copyFromShow() {
    if (!copyFromId) return;
    const src = otherShows.find((s) => s.id === copyFromId);
    if (!src) return;
    const newButtons: EventButtonDraft[] = (src.categories ?? []).map((c) => ({
      id: crypto.randomUUID(),
      // `src.categories` (from `otherShows`, i.e. `profile.shows[]`) is wire-accurate
      // `name`-keyed; `c.label` falls back defensively (teams-settings-nav, D3).
      name: c.name ?? c.label ?? '',
      type: c.type,
      color: c.color,
      // Options ride along verbatim, per-option `auto_instruction` included.
      dropdown_options: c.dropdown_options ?? [],
      on_label: c.on_label ?? '',
      off_label: c.off_label ?? '',
      auto_instruction: c.auto_instruction ?? '',
    }));
    const srcPalette = normalizePalette9(src.event_palette ?? []);
    const srcPreset = src.event_palette_preset ?? 'custom';
    const srcCustom = normalizePalette9(
      src.event_palette_custom?.length ? src.event_palette_custom : srcPalette,
    );
    onChange(newButtons, srcPalette, srcPreset, srcCustom);
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
      <div className="admin-settings-block mb-4 pb-3 border-b border-v5-border">
        {/* .eventsSubheading overrides settings-subheading font-size/color, adds spacing/caps. */}
        <h3 className="settings-subheading m-0 mb-2 text-[0.78rem] tracking-[0.06em] uppercase text-[rgba(229,238,252,0.72)]">
          Event colors
        </h3>
        <div className="flex flex-row flex-wrap items-center justify-start gap-x-[0.85rem] gap-y-[0.6rem] w-full box-border">
          <div className="flex flex-row flex-wrap items-center justify-start gap-x-[0.65rem] gap-y-[0.45rem] flex-[1_1_12rem] min-w-0">
            <RadioGroup
              ariaLabel="Color palette preset"
              className="flex flex-wrap items-center gap-x-[0.45rem] gap-y-[0.35rem] m-0"
              value={palettePreset}
              onChange={applyPreset}
              options={(['custom', 'default', 'neon', 'desert', 'aqua'] as const).map((id) => ({
                value: id,
                label: id.charAt(0).toUpperCase() + id.slice(1),
              }))}
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
          {/* .headNewBtn had no live rule; sky-tint comes from the dialog .btn.primary reach-in. */}
          <button
            type="button"
            className={clsx('btn primary', BTN_PRIMARY_SKY)}
            disabled={!copyFromId}
            onClick={copyFromShow}
          >
            Copy
          </button>
        </div>
        <button type="button" className={clsx('btn primary', BTN_PRIMARY_SKY)} onClick={addButton}>
          Add new button
        </button>
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
                    <button
                      type="button"
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
                      <DragGrip />
                    </button>
                  </td>

                  {/* colNameWrap (2nd child): card cell, text-left, extra left padding. */}
                  {/* pl-2 (0.5rem, was td:nth-child(2)) must beat TD_CARD's px-[0.4rem] left;
                    same-property utilities resolve by CSS order, so force it with `!`. */}
                  <td className={clsx(TD_BASE, TD_CARD, rowDim, 'min-w-0 text-left !pl-2')}>
                    <input
                      type="text"
                      className={clsx('profile-select', ROW_FIELD, '!w-full !px-2')}
                      value={btn.name}
                      maxLength={200}
                      placeholder="Event name"
                      onChange={(e) => updateButton(btn.id, { name: e.target.value })}
                    />
                  </td>

                  <td className={clsx(TD_BASE, TD_CARD, rowDim, 'min-w-0 overflow-hidden')}>
                    <Select
                      ariaLabel="Button type"
                      value={btn.type}
                      className={clsx(
                        ROW_FIELD,
                        '!w-full !gap-1 !px-1.5 !text-[0.68rem] !rounded-[0.4rem] overflow-hidden',
                        // Radix Value is the first span — truncate so DROPDOWN/ON_OFF never spill.
                        '[&>span:first-child]:min-w-0 [&>span:first-child]:truncate',
                      )}
                      onChange={(value) => {
                        const t = value as EventButtonDraft['type'];
                        const patch: Partial<EventButtonDraft> = { type: t };
                        if (t === 'DROPDOWN' && !btn.dropdown_options.length) {
                          patch.dropdown_options = [
                            { label: 'Option 1', needs_context: false },
                            { label: 'Option 2', needs_context: false },
                          ];
                        }
                        if (t === 'ON_OFF') {
                          patch.dropdown_options = [];
                          patch.on_label = btn.on_label || 'ON';
                          patch.off_label = btn.off_label || 'OFF';
                          // ON_OFF buttons never carry generation instructions — a
                          // type switch drops them from the draft (web-ui-system spec).
                          patch.auto_instruction = '';
                        }
                        updateButton(btn.id, patch);
                      }}
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
                        className={clsx(
                          'btn !m-0 !box-border !h-auto !min-h-0 !max-h-none !w-auto !max-w-full',
                          '!border-0 !bg-transparent !p-0 !shadow-none !normal-case !tracking-normal',
                          'inline-flex flex-wrap items-center justify-start gap-[0.3rem] align-middle',
                          'hover-always:!bg-transparent',
                        )}
                        onClick={() => setEditingOptsFor(btn.id)}
                      >
                        {btn.dropdown_options.length ? (
                          btn.dropdown_options.map((opt, optIdx) => (
                            <span key={`${btn.id}-opt-${optIdx}`} className={OPTION_BUBBLE}>
                              {opt.label.trim() || '—'}
                            </span>
                          ))
                        ) : (
                          <span className={OPTION_BUBBLE}>—</span>
                        )}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className={clsx(
                          'btn',
                          ROW_CONTROL,
                          '!w-auto !px-2 !text-[0.65rem] inline-flex items-center justify-center',
                        )}
                        disabled={!canEditOpts}
                        onClick={() => canEditOpts && setEditingOptsFor(btn.id)}
                      >
                        {btn.type === 'ON_OFF' ? onOffSummary(btn.on_label, btn.off_label) : 'N/A'}
                      </button>
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
                      <button
                        type="button"
                        // The aria-label wins the accessible-name computation, so the
                        // bearing state must live IN the label — a sibling sr-only
                        // span would never be announced (color alone isn't state).
                        aria-label={bearing ? 'AI Rules (has instructions)' : 'AI Rules'}
                        title="AI Rules"
                        className={clsx(
                          'btn !m-0 !box-border !h-[1.7rem] !max-h-[1.7rem] !min-h-0 !min-w-0 !py-0 !leading-none',
                          '!w-full !px-1 !text-[0.55rem] !tracking-[0.04em] inline-flex items-center justify-center align-middle',
                          'overflow-hidden',
                          bearing ? 'text-v5-primary' : 'text-[rgba(229,238,252,0.35)]',
                        )}
                        onClick={() => setOpenInstructionFor(btn.id)}
                      >
                        <span className="min-w-0 truncate">AI Rules</span>
                      </button>
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
                    <button
                      type="button"
                      className={clsx(
                        ROW_ICON_BTN,
                        'danger !flex !items-center !justify-center !gap-0 !p-0 !leading-none',
                      )}
                      aria-label="Remove event"
                      onClick={() => deleteButton(btn.id)}
                    >
                      {/* 16px → 12.8px (−20%); block + shrink-0 so flex centering is exact. */}
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="12.8"
                        height="12.8"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                        className="block shrink-0"
                      >
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        <line x1="10" y1="11" x2="10" y2="17" />
                        <line x1="14" y1="11" x2="14" y2="17" />
                      </svg>
                    </button>
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
