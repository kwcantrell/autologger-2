import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ShowDropdownOption } from '../../../api/types';
import { renderStrict } from '../../../test/renderStrict';
import { EventOptionsModal } from './EventOptionsModal';

// --- EventOptionsModal instruction fields (auto-generate-event-logs, task 1.3;
// spec: web-ui-system "Generation instruction fields in Settings", scenario
// "Dropdown options carry their own instructions") ---
//
// The modal renders the real Radix Dialog (matchMedia is stubbed in test/setup.ts,
// keeping it on the desktop branch — same as ConfirmDialog.test.tsx).

const options: ShowDropdownOption[] = [
  { label: 'Cam A', needs_context: false, auto_instruction: 'When cam A goes live' },
  { label: 'Cam B', needs_context: false },
];

function renderModal(over: Partial<Parameters<typeof EventOptionsModal>[0]> = {}) {
  const onConfirm = vi.fn();
  renderStrict(
    <EventOptionsModal
      type="DROPDOWN"
      options={options}
      onLabel=""
      offLabel=""
      autoInstruction="Whole-button instruction"
      onConfirm={onConfirm}
      onClose={vi.fn()}
      {...over}
    />,
  );
  return onConfirm;
}

describe('EventOptionsModal instruction fields', () => {
  it('prefills the whole-button and per-option instruction fields (round-trip on reopen)', () => {
    renderModal();

    const whole = screen.getByLabelText('Generation instruction') as HTMLTextAreaElement;
    expect(whole.value).toBe('Whole-button instruction');
    expect(whole.maxLength).toBe(2000);

    const optFields = screen.getAllByLabelText('Option instruction') as HTMLTextAreaElement[];
    expect(optFields).toHaveLength(2);
    expect(optFields[0].value).toBe('When cam A goes live');
    expect(optFields[1].value).toBe('');
    expect(optFields[0].maxLength).toBe(2000);
  });

  it('confirms edited values; a whitespace-only option instruction is omitted, a padded one emits trimmed', () => {
    const onConfirm = renderModal();

    fireEvent.change(screen.getByLabelText('Generation instruction'), {
      target: { value: 'New whole-button instruction' },
    });
    const optFields = screen.getAllByLabelText('Option instruction');
    // Whitespace-only clears just like empty: the server drops it, so the wire
    // key must be omitted (never a phantom present-but-blank value).
    fireEvent.change(optFields[0], { target: { value: '   ' } });
    // Padded values emit trimmed — the server stores trimmed, so an untrimmed
    // emit would differ from what the post-save rebaseline reads back.
    fireEvent.change(optFields[1], { target: { value: '  When cam B goes live  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    const result = onConfirm.mock.calls[0][0] as {
      options: ShowDropdownOption[];
      onLabel: string;
      offLabel: string;
      autoInstruction: string;
    };
    expect(result.autoInstruction).toBe('New whole-button instruction');
    expect(result.options).toEqual([
      { label: 'Cam A', needs_context: false },
      { label: 'Cam B', needs_context: false, auto_instruction: 'When cam B goes live' },
    ]);
    // Pin wire absence: an empty instruction must not serialize as a present key.
    expect('auto_instruction' in result.options[0]).toBe(false);
  });

  it('round-trips unchanged values verbatim on Done (snapshot stays clean)', () => {
    const onConfirm = renderModal();

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(onConfirm.mock.calls[0][0]).toEqual({
      options,
      onLabel: '',
      offLabel: '',
      autoInstruction: 'Whole-button instruction',
    });
  });

  it('offers no instruction fields for ON_OFF and confirms an empty instruction', () => {
    const onConfirm = renderModal({
      type: 'ON_OFF',
      options: [],
      onLabel: 'ON',
      offLabel: 'OFF',
      // Defensive: even a stale non-empty value must confirm back to '' — ON_OFF
      // buttons never carry instructions (auto-event-generation definition).
      autoInstruction: 'stale',
    });

    expect(screen.queryByLabelText('Generation instruction')).toBeNull();
    expect(screen.queryByLabelText('Option instruction')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onConfirm.mock.calls[0][0]).toEqual({
      options: [],
      onLabel: 'ON',
      offLabel: 'OFF',
      autoInstruction: '',
    });
  });
});
