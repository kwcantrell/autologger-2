import type { ShowDropdownOption } from '../../../../api/types';
import { DEFAULT_PALETTE, normalizePalette9 } from '../../utils/palette9';
import type { ShowDraft } from './settingsModel';

// --- Event buttons: the draft and its rules (redesign-show-ignition D6) ---
//
// One copy of the event-button rules, used by Settings › Event buttons (the list and its panel):
//   - the `EventButtonDraft` shape and the instruction-bearing definition;
//   - the type-switch rules (Dropdown seeds two options, On/Off seeds its labels and drops every
//     instruction);
//   - the palette presets and the custom-slot rule;
//   - the option clean-up applied when a Dropdown is saved;
//   - Copy from another show (instructions ride along).
// The draft-to-wire mapping (the `auto_instruction` trim gate) is `showDraftToUpdate` in
// `settingsModel.ts`.

export type EventButtonType = 'BUTTON' | 'DROPDOWN' | 'TEXT' | 'ON_OFF';

export interface EventButtonDraft {
  id: string;
  name: string;
  type: EventButtonType;
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

/** The longest instruction a button or option takes (auto-event-generation). */
export const INSTRUCTION_MAX = 2000;

/** The four types, their names and what each does when logging. */
export const EVENT_BUTTON_TYPES: readonly {
  value: EventButtonType;
  label: string;
  help: string;
}[] = [
  { value: 'BUTTON', label: 'Button', help: 'Logs one event with the button’s name.' },
  {
    value: 'DROPDOWN',
    label: 'Dropdown',
    help: 'You pick an option when logging. The option becomes the event message.',
  },
  { value: 'TEXT', label: 'Text', help: 'You type a short message when logging.' },
  { value: 'ON_OFF', label: 'On / Off', help: 'Toggles between two states and logs each change.' },
];

export const typeLabel = (t: EventButtonType) =>
  EVENT_BUTTON_TYPES.find((x) => x.value === t)?.label ?? t;

/**
 * Single instruction-bearing definition (auto-event-generation spec): the button's
 * own instruction is non-empty, or — DROPDOWN only — at least one option's is.
 * ON_OFF never bears, and option instructions lingering on a non-DROPDOWN draft
 * (after a type switch away from DROPDOWN) do not count.
 */
export function isInstructionBearing(btn: EventButtonDraft): boolean {
  if (btn.type === 'ON_OFF') return false;
  if (btn.auto_instruction.trim()) return true;
  return (
    btn.type === 'DROPDOWN' &&
    btn.dropdown_options.some((o) => (o.auto_instruction ?? '').trim().length > 0)
  );
}

/** A list row's one-line summary: "Dropdown · 3 options · Auto-generates". */
export function eventButtonSummary(btn: EventButtonDraft): string {
  const parts: string[] = [typeLabel(btn.type)];
  if (btn.type === 'DROPDOWN') {
    const n = btn.dropdown_options.length;
    parts.push(`${n} option${n === 1 ? '' : 's'}`);
  } else if (btn.type === 'ON_OFF') {
    parts.push(`${btn.on_label.trim() || 'ON'} / ${btn.off_label.trim() || 'OFF'}`);
  }
  if (isInstructionBearing(btn)) parts.push('Auto-generates');
  return parts.join(' · ');
}

/** The type-switch rules, applied to a draft. */
export function withButtonType(btn: EventButtonDraft, type: EventButtonType): EventButtonDraft {
  const next: EventButtonDraft = { ...btn, type };
  if (type === 'DROPDOWN' && !btn.dropdown_options.length) {
    next.dropdown_options = [
      { label: 'Option 1', needs_context: false },
      { label: 'Option 2', needs_context: false },
    ];
  }
  if (type === 'ON_OFF') {
    next.dropdown_options = [];
    next.on_label = btn.on_label || 'ON';
    next.off_label = btn.off_label || 'OFF';
    // ON_OFF buttons never carry generation instructions — a type switch drops
    // them from the draft (web-ui-system "Generation instruction fields in Settings").
    next.auto_instruction = '';
  }
  return next;
}

/** A fresh button in the palette's first colour. */
export function newEventButton(palette: string[], name = ''): EventButtonDraft {
  return {
    id: crypto.randomUUID(),
    name,
    type: 'BUTTON',
    color: normalizePalette9(palette)[0] ?? '#64748b',
    dropdown_options: [],
    on_label: '',
    off_label: '',
    auto_instruction: '',
  };
}

/**
 * A Dropdown's options as saved: blank labels dropped, each option's instruction kept only when
 * trim-non-empty and then trimmed (the server's normalization), so a saved value matches what
 * the post-save read gives back.
 */
export function cleanDropdownOptions(options: ShowDropdownOption[]): ShowDropdownOption[] {
  return options
    .filter((o) => o.label.trim())
    .map(({ label, needs_context, auto_instruction }) => ({
      label,
      needs_context,
      ...(auto_instruction?.trim() ? { auto_instruction: auto_instruction.trim() } : {}),
    }));
}

// ── Palette ──────────────────────────────────────────────────────────────────

export const EVENT_COLOR_PRESETS: Record<string, string[]> = {
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

export const PALETTE_PRESET_IDS = ['custom', 'default', 'neon', 'desert', 'aqua'] as const;

export const presetLabel = (id: string) => id.charAt(0).toUpperCase() + id.slice(1);

/** A show's palette fields, as the draft and `show_updates` carry them. */
export type PaletteFields = Pick<
  ShowDraft,
  'event_palette' | 'event_palette_preset' | 'event_palette_custom'
>;

/**
 * Choosing a preset. Custom restores the saved custom slots; a named preset fills the palette
 * and keeps the custom slots for a later return to Custom.
 */
export function applyPalettePreset(state: PaletteFields, preset: string): PaletteFields {
  const custom = state.event_palette_custom;
  if (preset === 'custom') {
    const palette = normalizePalette9(custom.length ? custom : state.event_palette);
    return {
      event_palette: palette,
      event_palette_preset: 'custom',
      event_palette_custom: palette.slice(),
    };
  }
  const palette = normalizePalette9(EVENT_COLOR_PRESETS[preset] ?? DEFAULT_PALETTE);
  return {
    event_palette: palette,
    event_palette_preset: preset,
    event_palette_custom: custom.length ? normalizePalette9(custom) : palette.slice(),
  };
}

/** Editing one slot makes the palette Custom. */
export function setPaletteSlot(state: PaletteFields, idx: number, hex: string): PaletteFields {
  const next = normalizePalette9(state.event_palette).map((c, i) =>
    i === idx ? hex.toLowerCase() : c,
  );
  return {
    event_palette: next,
    event_palette_preset: 'custom',
    event_palette_custom: next.slice(),
  };
}

/**
 * Copy from another show: its buttons under fresh ids, instructions on the button and on each
 * option included (web-ui-system "Copy from show preserves instructions"), and its palette.
 */
export function copyButtonsFrom(
  src: Pick<ShowDraft, 'categories'> & PaletteFields,
): { categories: EventButtonDraft[] } & PaletteFields {
  const palette = normalizePalette9(src.event_palette);
  return {
    categories: src.categories.map((c) => ({
      ...c,
      id: crypto.randomUUID(),
      dropdown_options: c.dropdown_options.map((o) => ({ ...o })),
    })),
    event_palette: palette,
    event_palette_preset: src.event_palette_preset || 'custom',
    event_palette_custom: normalizePalette9(
      src.event_palette_custom.length ? src.event_palette_custom : palette,
    ),
  };
}
