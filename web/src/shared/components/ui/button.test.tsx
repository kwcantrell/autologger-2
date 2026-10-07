import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './button';

// shadcn-foundation D6/D8: behaviour and variant hooks.
describe('Button (shared shadcn layer)', () => {
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

// redesign-show-ignition, web-ui-system "Single V5 component vocabulary" ("Shared-layer button
// renders the V5 vocabulary"): sentence-case labels at the shared control height and radius on a
// flat surface; the primary (default) variant accent-tinted, destructive red-tinted, and no hover
// response while disabled. Deliberate class checks: these pin the vocabulary, not behaviour.
describe('Button vocabulary (Show Ignition)', () => {
  const GLASS = /glass|gradient|shadow-glow|panel-elevate/;

  it.each([
    ['default', /--si-primary-tint/],
    ['outline', /bg-secondary/],
    ['secondary', /bg-secondary/],
    ['destructive', /--si-danger/],
  ] as const)('%s: control radius and height, sentence case, flat surface', (variant, surface) => {
    render(<Button variant={variant}>Save changes</Button>);
    const cls = screen.getByRole('button', { name: 'Save changes' }).className;
    expect(cls).toContain('rounded-ctl');
    expect(cls).toContain('h-(--h-ctl)');
    expect(cls).not.toMatch(/(^|\s)uppercase(\s|$)/);
    expect(cls).not.toMatch(GLASS);
    expect(cls).toMatch(surface);
  });

  it('the small size uses the small control height', () => {
    render(<Button size="sm">Edit</Button>);
    const cls = screen.getByRole('button', { name: 'Edit' }).className;
    expect(cls).toContain('h-(--h-sm)');
    expect(cls).toContain('rounded-ctl');
  });

  it('the feed toolbar variants are flat and sentence case too', () => {
    render(
      <div>
        <Button variant="glass">Filter</Button>
        <Button variant="glass-primary">Time display</Button>
      </div>,
    );
    for (const name of ['Filter', 'Time display']) {
      const cls = screen.getByRole('button', { name }).className;
      expect(cls).toContain('rounded-ctl');
      expect(cls).not.toMatch(/(^|\s)uppercase(\s|$)/);
      expect(cls).not.toMatch(GLASS);
    }
  });

  it('disabled: reduced opacity, muted text, and no hover change', () => {
    render(
      <Button variant="default" disabled>
        Create & open
      </Button>,
    );
    const cls = screen.getByRole('button', { name: 'Create & open' }).className;
    expect(cls).toContain('disabled:pointer-events-none');
    expect(cls).toContain('disabled:opacity-45');
    expect(cls).toContain('disabled:text-muted-foreground');
    // Every hover rule is gated on the control being enabled.
    for (const token of cls.split(/\s+/).filter((c) => c.includes('hover:'))) {
      expect(token.startsWith('enabled:hover:') || token.startsWith('not-disabled:hover')).toBe(
        true,
      );
    }
  });
});
