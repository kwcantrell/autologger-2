import clsx from 'clsx';
import { useState } from 'react';
import type { DropdownOption, Show } from '../../../api/types';
import { Popover } from '../../../shared/ui/Popover';
import { RadioGroup } from '../../../shared/ui/RadioGroup';
import { Tooltip } from '../../../shared/ui/Tooltip';
import styles from './EventButtonsTable.module.css';
import { EventOptionsModal } from './EventOptionsModal';
import { Select } from './Select';

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
  dropdown_options: DropdownOption[];
  on_label: string;
  off_label: string;
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
const DEFAULT_PALETTE = [
  '#64748b',
  '#e53935',
  '#fb8c00',
  '#fdd835',
  '#43a047',
  '#00acc1',
  '#1e88e5',
  '#8e24aa',
  '#ec407a',
];

// Fixed positional slot indices — using array content (not .map index) avoids noArrayIndexKey lint
const PALETTE_SLOT_INDICES = [0, 1, 2, 3, 4, 5, 6, 7, 8] as const;

function normalizePalette9(arr: string[]): string[] {
  return PALETTE_SLOT_INDICES.map((i) => {
    const h = (arr[i] ?? '').toLowerCase();
    return /^#[0-9a-f]{6}$/.test(h) ? h : DEFAULT_PALETTE[i % DEFAULT_PALETTE.length];
  });
}

function optionsSummary(opts: DropdownOption[]): string {
  if (!opts.length) return '—';
  const s = opts.map((o) => o.label).join(', ');
  return s.length > 42 ? `${s.slice(0, 40)}…` : s;
}

function onOffSummary(onLabel: string, offLabel: string): string {
  const s = `${onLabel.trim() || 'ON'}, ${offLabel.trim() || 'OFF'}`;
  return s.length > 42 ? `${s.slice(0, 40)}…` : s;
}

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
      name: c.label ?? '',
      type: c.type,
      color: c.color,
      dropdown_options: c.dropdown_options ?? [],
      on_label: c.on_label ?? '',
      off_label: c.off_label ?? '',
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

  return (
    <div className={styles.tableWrapReact}>
      {/* Palette section */}
      <div className={clsx(styles.paletteBlock, 'admin-settings-block')}>
        <h3 className={clsx('settings-subheading', styles.eventsSubheading)}>Event colors</h3>
        <div className={styles.paletteToolbar}>
          <div className={styles.paletteCluster}>
            <RadioGroup
              ariaLabel="Color palette preset"
              className={styles.palettePresets}
              value={palettePreset}
              onChange={applyPreset}
              options={(['custom', 'default', 'neon', 'desert', 'aqua'] as const).map((id) => ({
                value: id,
                label: id.charAt(0).toUpperCase() + id.slice(1),
              }))}
              itemClassName={(_id, checked) =>
                clsx(styles.presetBtn, checked && styles.presetBtnActive)
              }
            />
            {/* 9 palette swatches; PALETTE_SLOT_INDICES are static values, not .map() indices */}
            <div className={styles.paletteRow}>
              {PALETTE_SLOT_INDICES.map((slotIdx) => (
                <label key={slotIdx} title={`Slot ${slotIdx + 1}: ${normPalette[slotIdx]}`}>
                  <input
                    type="color"
                    className={styles.palSlot}
                    value={normPalette[slotIdx]}
                    onChange={(e) => updatePaletteSlot(slotIdx, e.target.value)}
                  />
                </label>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Toolbar */}
      <div
        className={styles.thToolbar}
        style={{
          marginBottom: '0.5rem',
          display: 'flex',
          gap: '0.5rem',
          flexWrap: 'wrap',
          alignItems: 'center',
        }}
      >
        <div className={styles.copyFromCluster}>
          <span className={styles.copyFromLabel}>Copy Buttons From</span>
          <Select
            className={styles.copyFromSelect}
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
          <button
            type="button"
            className={clsx('btn', 'primary', styles.headNewBtn)}
            disabled={!copyFromId}
            onClick={copyFromShow}
          >
            Copy
          </button>
        </div>
        <button
          type="button"
          className={clsx('btn', 'primary', styles.headNewBtn)}
          onClick={addButton}
        >
          Add new button
        </button>
      </div>

      {/* Event buttons table */}
      <table className={styles.table} aria-label="Event buttons">
        <thead>
          <tr>
            <th className={styles.thDrag} scope="col">
              <span className={styles.srOnly}>Reorder</span>
            </th>
            <th scope="col">Event name</th>
            <th scope="col">Button type</th>
            <th scope="col">Color</th>
            <th scope="col">Options</th>
            <th scope="col" className={styles.thActions}>
              <span className={styles.srOnly}>Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {buttons.map((btn, idx) => {
            const optsSummary =
              btn.type === 'DROPDOWN'
                ? optionsSummary(btn.dropdown_options)
                : btn.type === 'ON_OFF'
                  ? onOffSummary(btn.on_label, btn.off_label)
                  : 'N/A';
            const canEditOpts = btn.type === 'DROPDOWN' || btn.type === 'ON_OFF';

            return (
              <tr
                key={btn.id}
                className={clsx(styles.btnRow, dragOverIdx === idx && styles.btnRowDragOver)}
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
                <td className={styles.colDrag}>
                  <button
                    type="button"
                    className={clsx('btn', 'btn-icon', styles.dragHandle)}
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

                <td className={styles.colNameWrap}>
                  <input
                    type="text"
                    className={clsx('profile-select', styles.colName)}
                    value={btn.name}
                    maxLength={200}
                    placeholder="Event name"
                    onChange={(e) => updateButton(btn.id, { name: e.target.value })}
                  />
                </td>

                <td>
                  <Select
                    className={styles.colType}
                    ariaLabel="Button type"
                    value={btn.type}
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
                      }
                      updateButton(btn.id, patch);
                    }}
                    options={BUTTON_TYPE_OPTIONS}
                  />
                </td>

                <td className={styles.colColorCell}>
                  <Popover
                    open={openColorFor === btn.id}
                    onOpenChange={(o) => setOpenColorFor(o ? btn.id : null)}
                    ariaLabel="Event colors"
                    className={styles.colorPopover}
                    align="start"
                    trigger={
                      <Tooltip content="Pick color">
                        <button
                          type="button"
                          aria-label="Pick button color"
                          style={{
                            display: 'block',
                            width: '1.5rem',
                            height: '1.5rem',
                            borderRadius: '3px',
                            backgroundColor: btn.color,
                            border: '1px solid rgba(0,0,0,0.2)',
                            cursor: 'pointer',
                            padding: 0,
                          }}
                        />
                      </Tooltip>
                    }
                  >
                    {normPalette.map((hex) => (
                      <button
                        key={hex}
                        type="button"
                        className={styles.colorPopopt}
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

                <td className={styles.colOptionsWrap}>
                  <button
                    type="button"
                    className={clsx('btn', styles.colOptionsBtn)}
                    disabled={!canEditOpts}
                    onClick={() => canEditOpts && setEditingOptsFor(btn.id)}
                  >
                    {optsSummary}
                  </button>
                </td>

                <td>
                  <button
                    type="button"
                    className={clsx('btn', 'btn-icon', 'danger', styles.colDelete)}
                    aria-label="Remove event"
                    onClick={() => deleteButton(btn.id)}
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
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

      {editingBtn && (editingBtn.type === 'DROPDOWN' || editingBtn.type === 'ON_OFF') && (
        <EventOptionsModal
          type={editingBtn.type}
          options={editingBtn.dropdown_options}
          onLabel={editingBtn.on_label}
          offLabel={editingBtn.off_label}
          onConfirm={(result) => {
            updateButton(editingBtn.id, {
              dropdown_options: result.options,
              on_label: result.onLabel,
              off_label: result.offLabel,
            });
            setEditingOptsFor(null);
          }}
          onClose={() => setEditingOptsFor(null)}
        />
      )}
    </div>
  );
}
