import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderStrict } from '../../../test/renderStrict';
import { LazySelect } from './LazySelect';

// --- LazySelect defers the real Select until the user shows intent (settings-modal-mount-cost
// D3) ---
//
// Ported in task 10.1 from `EventButtonsTable.lazyTypeSelect.test.tsx`, which pinned this
// behaviour through the retired table's per-row type control. The control now ships through
// `FpsSelect` (Settings › Team details), so its behaviour is tested on the component itself.
// Deliberately does NOT mock `./Select`: the assertions are about the real Radix select mounting
// (or not).

class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (typeof window !== 'undefined' && typeof window.ResizeObserver === 'undefined') {
  window.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
}
if (typeof Element !== 'undefined' && !Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (typeof Element !== 'undefined' && !Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
}
if (typeof Element !== 'undefined' && !Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// Spies on the shadcn Select primitive's root, the outermost component every real Select renders
// through, so "a listbox-style overlay component mounted" is observable (a closed real Select
// still mounts its item tree into a detached fragment `document.querySelector` cannot see).
let selectRootMounts = 0;
vi.mock('../../../shared/components/ui/select', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/components/ui/select')>();
  function RootSpy(props: Record<string, unknown>) {
    selectRootMounts += 1;
    // biome-ignore lint/suspicious/noExplicitAny: passthrough wrapper around the real Root
    return <actual.Select {...(props as any)} />;
  }
  return { ...actual, Select: RootSpy };
});

const OPTIONS = [
  { value: 'alpha', label: 'Alpha' },
  { value: 'beta', label: 'Beta' },
  { value: 'gamma', label: 'Gamma' },
];

function renderSelects(n: number, value = 'beta', onChange = vi.fn()) {
  renderStrict(
    <div>
      {Array.from({ length: n }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static fixture list
        <LazySelect key={i} ariaLabel="Pick" value={value} options={OPTIONS} onChange={onChange} />
      ))}
    </div>,
  );
  return onChange;
}

beforeEach(() => {
  selectRootMounts = 0;
});

afterEach(() => {
  selectRootMounts = 0;
});

describe('LazySelect — inert vs upgraded trigger parity', () => {
  it('has the same classes, role, name, ARIA state, and exactly one icon before and after the upgrade', async () => {
    renderSelects(1);
    const snapshot = (el: HTMLElement) => ({
      className: el.className,
      role: el.getAttribute('role'),
      name: el.getAttribute('aria-label'),
      expanded: el.getAttribute('aria-expanded'),
      state: el.getAttribute('data-state'),
      svgs: el.querySelectorAll('svg').length,
    });
    const inert = screen.getByRole('combobox', { name: 'Pick' });
    const before = snapshot(inert);
    act(() => {
      inert.focus();
    });
    const upgraded = await waitFor(() => {
      const el = screen.getByRole('combobox', { name: 'Pick' });
      expect(el).not.toBe(inert);
      return el;
    });
    expect(snapshot(upgraded)).toEqual(before);
    expect(before.svgs).toBe(1);
  });
});

describe('LazySelect — nothing mounts until intent', () => {
  it('mounts no listbox-style overlay component, however many are rendered', () => {
    renderSelects(1);
    expect(selectRootMounts).toBe(0);
    cleanup();
    renderSelects(50);
    expect(selectRootMounts).toBe(0);
    expect(screen.getAllByRole('combobox', { name: 'Pick' })).toHaveLength(50);
  });

  it('the inert trigger carries data-state="closed" (audit finding M5)', () => {
    renderSelects(1);
    expect(screen.getByRole('combobox', { name: 'Pick' }).getAttribute('data-state')).toBe(
      'closed',
    );
  });
});

describe('LazySelect — single activation', () => {
  it('a mouse click upgrades and opens the control, operable, with the same options and selected value', () => {
    const onChange = renderSelects(1);
    const trigger = screen.getByRole('combobox', { name: 'Pick' });

    fireEvent.pointerDown(trigger, { pointerType: 'mouse', button: 0 });
    fireEvent.focus(trigger);
    fireEvent.pointerUp(trigger, { pointerType: 'mouse', button: 0 });
    fireEvent.click(trigger);

    expect(selectRootMounts).toBeGreaterThan(0);
    expect(screen.getByRole('listbox')).toBeTruthy();
    for (const label of ['Alpha', 'Beta', 'Gamma']) {
      expect(screen.getByRole('option', { name: label })).toBeTruthy();
    }
    expect(screen.getByRole('option', { name: 'Beta' }).getAttribute('data-state')).toBe('checked');
    fireEvent.click(screen.getByRole('option', { name: 'Gamma' }));
    expect(onChange).toHaveBeenLastCalledWith('gamma');
  });

  it('a bare click with no preceding pointer or focus events upgrades and opens the control (touch/AT path)', () => {
    const onChange = renderSelects(1, 'alpha');
    fireEvent.click(screen.getByRole('combobox', { name: 'Pick' }));
    expect(selectRootMounts).toBeGreaterThan(0);
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Alpha' }).getAttribute('data-state')).toBe(
      'checked',
    );
    fireEvent.click(screen.getByRole('option', { name: 'Beta' }));
    expect(onChange).toHaveBeenLastCalledWith('beta');
  });
});

describe('LazySelect — regression M4 (pointerActiveRef stuck true)', () => {
  it('recovers when a pointerdown is never followed by pointerup, blur, or click', () => {
    renderSelects(1);
    const trigger = screen.getByRole('combobox', { name: 'Pick' });
    fireEvent.pointerDown(trigger, { pointerType: 'mouse', button: 0 });
    fireEvent.pointerLeave(trigger, { pointerType: 'mouse' });

    fireEvent.focus(trigger);
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Pick' }), { key: 'ArrowDown' });
    expect(screen.getByRole('listbox')).toBeTruthy();
  });
});

describe('LazySelect — keyboard focus', () => {
  it('tabbing to the control upgrades it and leaves focus on it, operable by keyboard alone', () => {
    renderSelects(1);
    const inert = screen.getByRole('combobox', { name: 'Pick' });
    expect(inert.getAttribute('aria-expanded')).toBe('false');

    fireEvent.focus(inert);

    expect(selectRootMounts).toBeGreaterThan(0);
    const upgraded = screen.getByRole('combobox', { name: 'Pick' });
    expect(document.activeElement).toBe(upgraded);
    expect(upgraded.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('listbox')).toBeNull();

    fireEvent.keyDown(upgraded, { key: 'Enter' });
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Beta' }).getAttribute('data-state')).toBe('checked');
  });
});
