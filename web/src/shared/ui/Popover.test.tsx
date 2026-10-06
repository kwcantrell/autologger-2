import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Popover, PopoverItem } from './Popover';

// shadcn-shared-wrappers D5: Popover rides the shadcn Popover primitive; PopoverItem unchanged.
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (typeof window.ResizeObserver === 'undefined') {
  window.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
}

describe('Popover', () => {
  it('renders open content through the shadcn primitive as a dialog named by ariaLabel', () => {
    render(
      <Popover open trigger={<button type="button">Menu</button>} ariaLabel="Session options">
        <PopoverItem>Rename</PopoverItem>
      </Popover>,
    );
    const content = screen.getByRole('dialog', { name: 'Session options' });
    expect(content.getAttribute('data-slot')).toBe('popover-content');
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeTruthy();
  });

  it('the trigger toggles an uncontrolled popover', () => {
    render(
      <Popover trigger={<button type="button">Menu</button>} ariaLabel="Admin actions">
        <PopoverItem>Promote</PopoverItem>
      </Popover>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    expect(screen.getByRole('dialog', { name: 'Admin actions' })).toBeTruthy();
  });
});

describe('PopoverItem', () => {
  it('maps ARIA state by role', () => {
    render(
      <div>
        <PopoverItem role="menuitemcheckbox" ariaChecked>
          Scene
        </PopoverItem>
        <PopoverItem role="option" selected>
          Timecode
        </PopoverItem>
        <PopoverItem>Plain</PopoverItem>
      </div>,
    );
    expect(
      screen.getByRole('menuitemcheckbox', { name: 'Scene' }).getAttribute('aria-checked'),
    ).toBe('true');
    expect(screen.getByRole('option', { name: 'Timecode' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    const plain = screen.getByRole('menuitem', { name: 'Plain' });
    expect(plain.hasAttribute('aria-checked') || plain.hasAttribute('aria-selected')).toBe(false);
  });

  it('danger text wins over selected', () => {
    render(
      <PopoverItem danger selected>
        Delete
      </PopoverItem>,
    );
    const tokens = screen.getByRole('menuitem', { name: 'Delete' }).className.split(/\s+/);
    expect(tokens).toContain('text-danger');
    expect(tokens).not.toContain('text-v5-primary');
  });

  it('onClick fires; disabled blocks it', () => {
    const onClick = vi.fn();
    render(
      <div>
        <PopoverItem onClick={onClick}>Go</PopoverItem>
        <PopoverItem onClick={onClick} disabled>
          No
        </PopoverItem>
      </div>,
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Go' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'No' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
