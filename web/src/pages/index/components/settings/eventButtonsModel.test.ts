import { describe, expect, it } from 'vitest';
import {
  cleanDropdownOptions,
  copyButtonsFrom,
  type EventButtonDraft,
  isInstructionBearing,
  withButtonType,
} from './eventButtonsModel';

// --- The event-button rules (redesign-show-ignition D6; web-ui-system "Generation instruction
// fields in Settings") ---
//
// Ported in task 10.1 from the previous table's and options dialog's tests
// (EventButtonsTable.test.tsx "instruction-bearing indicator" / "copyFromShow" / the ON_OFF type
// switch, EventOptionsModal.test.tsx's option-instruction trim), which exercised these rules
// through the retired UI. The Event buttons section's tests cover the same rules end to end; these
// pin the edge cases that section does not reach.

const draft = (over: Partial<EventButtonDraft> = {}): EventButtonDraft => ({
  id: 'b1',
  name: 'Button',
  type: 'BUTTON',
  color: '#112233',
  dropdown_options: [],
  on_label: '',
  off_label: '',
  auto_instruction: '',
  ...over,
});

describe('isInstructionBearing', () => {
  it('lights for a button-level instruction', () => {
    expect(isInstructionBearing(draft({ auto_instruction: 'Log it' }))).toBe(true);
  });

  it('lights for an option-only DROPDOWN', () => {
    expect(
      isInstructionBearing(
        draft({
          type: 'DROPDOWN',
          dropdown_options: [
            { label: 'A', needs_context: false },
            { label: 'B', needs_context: false, auto_instruction: 'When B' },
          ],
        }),
      ),
    ).toBe(true);
  });

  it('does not light without instructions, or with whitespace-only ones', () => {
    expect(isInstructionBearing(draft())).toBe(false);
    expect(isInstructionBearing(draft({ auto_instruction: '   ' }))).toBe(false);
  });

  it('does not light for stale option instructions on a non-DROPDOWN type', () => {
    expect(
      isInstructionBearing(
        draft({
          type: 'TEXT',
          dropdown_options: [{ label: 'A', needs_context: false, auto_instruction: 'stale' }],
        }),
      ),
    ).toBe(false);
  });

  it('never lights for ON_OFF, even with stale draft values', () => {
    expect(
      isInstructionBearing(
        draft({
          type: 'ON_OFF',
          auto_instruction: 'stale',
          dropdown_options: [{ label: 'A', needs_context: false, auto_instruction: 'stale' }],
        }),
      ),
    ).toBe(false);
  });
});

describe('withButtonType', () => {
  it('switching to ON_OFF drops button- and option-level instructions and seeds the labels', () => {
    const next = withButtonType(
      draft({
        type: 'DROPDOWN',
        auto_instruction: 'Any camera change',
        dropdown_options: [{ label: 'Wide', needs_context: false, auto_instruction: 'When wide' }],
      }),
      'ON_OFF',
    );
    expect(next.auto_instruction).toBe('');
    expect(next.dropdown_options).toEqual([]);
    expect(next.on_label).toBe('ON');
    expect(next.off_label).toBe('OFF');
    expect(isInstructionBearing(next)).toBe(false);
  });

  it('switching to DROPDOWN seeds two options only when there are none', () => {
    expect(withButtonType(draft(), 'DROPDOWN').dropdown_options).toHaveLength(2);
    const kept = [{ label: 'Only', needs_context: true }];
    expect(withButtonType(draft({ dropdown_options: kept }), 'DROPDOWN').dropdown_options).toBe(
      kept,
    );
  });
});

describe('cleanDropdownOptions', () => {
  it('drops blank labels; a whitespace-only instruction is omitted, a padded one emits trimmed', () => {
    expect(
      cleanDropdownOptions([
        { label: 'Wide', needs_context: false, auto_instruction: '  When wide  ' },
        { label: 'Close', needs_context: true, auto_instruction: '   ' },
        { label: '  ', needs_context: false, auto_instruction: 'orphan' },
      ]),
    ).toEqual([
      { label: 'Wide', needs_context: false, auto_instruction: 'When wide' },
      { label: 'Close', needs_context: true },
    ]);
  });
});

describe('copyButtonsFrom', () => {
  it('copies names and button- and option-level instructions under fresh ids', () => {
    const src = {
      categories: [
        draft({ id: 'src-1', name: 'Applause', auto_instruction: 'When the audience claps' }),
        draft({
          id: 'src-2',
          name: 'Guest',
          type: 'DROPDOWN',
          dropdown_options: [
            { label: 'Arrives', needs_context: false, auto_instruction: 'On entry' },
          ],
        }),
      ],
      event_palette: [],
      event_palette_preset: 'aqua',
      event_palette_custom: [],
    };
    const copied = copyButtonsFrom(src);
    expect(copied.categories.map((c) => c.name)).toEqual(['Applause', 'Guest']);
    expect(copied.categories[0].auto_instruction).toBe('When the audience claps');
    expect(copied.categories[1].dropdown_options).toEqual([
      { label: 'Arrives', needs_context: false, auto_instruction: 'On entry' },
    ]);
    expect(copied.categories.map((c) => c.id)).not.toContain('src-1');
    // The copy's options are its own, not shared with the source.
    expect(copied.categories[1].dropdown_options[0]).not.toBe(
      src.categories[1].dropdown_options[0],
    );
    expect(copied.event_palette_preset).toBe('aqua');
  });
});
