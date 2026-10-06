import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './button';

// shadcn-foundation D6/D8: behaviour and variant hooks only; no class-string assertions.
describe('Button (shared shadcn layer, V5 variants)', () => {
  it('renders a button with the default variant and size hooks', () => {
    render(<Button>Save</Button>);
    const btn = screen.getByRole('button', { name: 'Save' });
    expect(btn.getAttribute('data-slot')).toBe('button');
    expect(btn.getAttribute('data-variant')).toBe('default');
    expect(btn.getAttribute('data-size')).toBe('default');
  });

  it('exposes destructive as a distinct variant', () => {
    render(<Button variant="destructive">Delete</Button>);
    expect(screen.getByRole('button', { name: 'Delete' }).getAttribute('data-variant')).toBe(
      'destructive',
    );
  });

  it('disabled blocks clicks', () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Go
      </Button>,
    );
    const btn = screen.getByRole('button', { name: 'Go' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('asChild renders the child element (a link) with button hooks', () => {
    render(
      <Button asChild variant="outline">
        <a href="/teams">Teams</a>
      </Button>,
    );
    const link = screen.getByRole('link', { name: 'Teams' });
    expect(link.getAttribute('href')).toBe('/teams');
    expect(link.getAttribute('data-variant')).toBe('outline');
  });
});
