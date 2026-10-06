import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RadioGroup } from './RadioGroup';

// shadcn-shared-wrappers D5: the shadcn RadioGroup root with label-text items (no indicator
// circle), styled by the caller's itemClassName; arrow keys loop.
const OPTIONS = [
  { value: 'neon', label: 'Neon' },
  { value: 'pastel', label: 'Pastel' },
  { value: 'mono', label: 'Mono' },
];

describe('RadioGroup', () => {
  it('is a radiogroup named by ariaLabel, rendered through the shadcn root', () => {
    render(
      <RadioGroup
        value="neon"
        onChange={() => {}}
        options={OPTIONS}
        ariaLabel="Color palette preset"
      />,
    );
    const group = screen.getByRole('radiogroup', { name: 'Color palette preset' });
    expect(group.getAttribute('data-slot')).toBe('radio-group');
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    expect(screen.getByRole('radio', { name: 'Neon' }).getAttribute('aria-checked')).toBe('true');
  });

  it('itemClassName receives (value, checked) and items render no indicator', () => {
    render(
      <RadioGroup
        value="pastel"
        onChange={() => {}}
        options={OPTIONS}
        ariaLabel="Preset"
        itemClassName={(v, checked) => `pill-${v}${checked ? ' on' : ''}`}
      />,
    );
    const pastel = screen.getByRole('radio', { name: 'Pastel' });
    expect(pastel.className).toContain('pill-pastel on');
    expect(pastel.querySelector('svg')).toBeNull();
  });

  it('clicking an option calls onChange with its value', () => {
    const onChange = vi.fn();
    render(<RadioGroup value="neon" onChange={onChange} options={OPTIONS} ariaLabel="Preset" />);
    fireEvent.click(screen.getByRole('radio', { name: 'Mono' }));
    expect(onChange).toHaveBeenCalledWith('mono');
  });

  it('arrow keys loop from the last option to the first', async () => {
    const onChange = vi.fn();
    render(<RadioGroup value="mono" onChange={onChange} options={OPTIONS} ariaLabel="Preset" />);
    const mono = screen.getByRole('radio', { name: 'Mono' });
    mono.focus();
    fireEvent.keyDown(mono, { key: 'ArrowRight' });
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Neon' })),
    );
  });
});
