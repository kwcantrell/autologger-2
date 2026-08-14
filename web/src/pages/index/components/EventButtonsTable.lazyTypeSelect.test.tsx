import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderStrict } from '../../../test/renderStrict';
import type { EventButtonDraft } from './EventButtonsTable';
import { EventButtonsTable } from './EventButtonsTable';

// --- Event-button rows defer their type control (settings-modal-mount-cost, task 4.1;
// spec: web-ui-system "Event-button rows defer their type control") ---
//
// Deliberately does NOT mock `./Select` (unlike `EventButtonsTable.test.tsx`, which
// mocks it wholesale for its own unrelated tests) — the assertions here are about the
// real Radix `Select` actually mounting (or not), so they need the real component.

// Radix Select needs a few DOM APIs jsdom does not implement. Same pattern as the
// ResizeObserver stub in `EventButtonsTable.test.tsx`.
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

// Spies on `@radix-ui/react-select`'s `Root` — the outermost component every Select
// instance renders through — so the tests can tell "a listbox-style overlay component
// mounted" apart from "the DOM happens to contain no visible listbox" (a closed real
// Select still mounts its whole item tree, just portalled into a detached
// `DocumentFragment` that `document.querySelector` cannot see — see design.md D3's
// measured-context section). Counting `Root` renders catches that regardless.
let selectRootMounts = 0;
vi.mock('@radix-ui/react-select', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@radix-ui/react-select')>();
  function RootSpy(props: Record<string, unknown>) {
    selectRootMounts += 1;
    // biome-ignore lint/suspicious/noExplicitAny: passthrough wrapper around the real Root
    return <actual.Root {...(props as any)} />;
  }
  return { ...actual, Root: RootSpy };
});

function makeDraft(over: Partial<EventButtonDraft> & { id: string }): EventButtonDraft {
  return {
    name: 'Sample',
    type: 'BUTTON',
    color: '#112233',
    dropdown_options: [],
    on_label: '',
    off_label: '',
    auto_instruction: '',
    ...over,
  };
}

function renderTable(buttons: EventButtonDraft[], onChange = vi.fn()) {
  renderStrict(
    <EventButtonsTable
      buttons={buttons}
      palette={[]}
      palettePreset="custom"
      paletteCustom={[]}
      otherShows={[]}
      onChange={onChange}
    />,
  );
  return onChange;
}

function makeButtons(n: number): EventButtonDraft[] {
  return Array.from({ length: n }, (_, i) => makeDraft({ id: `b${i}`, name: `Button ${i}` }));
}

beforeEach(() => {
  selectRootMounts = 0;
});

afterEach(() => {
  selectRootMounts = 0;
});

// The table's toolbar "Copy Buttons From" control is an ordinary, always-mounted
// `Select` — out of this change's scope (only the per-row type control defers). It
// mounts one `Root` regardless of row count, so it sets a non-zero floor that every
// assertion below must account for rather than assume away.
function mountedRootCountFor(n: number): number {
  selectRootMounts = 0;
  renderTable(makeButtons(n));
  const count = selectRootMounts;
  cleanup();
  return count;
}

describe('EventButtonsTable — lazy button-type control (scenario a)', () => {
  it('mounts no per-row listbox-style overlay component, and the count does not grow with row count', () => {
    const baseline = mountedRootCountFor(0);
    // Sanity: proves the spy actually counts something (the toolbar select), so a
    // baseline of 0 below would be a broken assertion, not a passing one.
    expect(baseline).toBeGreaterThan(0);
    expect(mountedRootCountFor(1)).toBe(baseline);
    expect(mountedRootCountFor(50)).toBe(baseline);
  });

  it('still renders every row as an inert trigger', () => {
    renderTable(makeButtons(50));
    expect(screen.getAllByRole('combobox', { name: 'Button type' })).toHaveLength(50);
  });

  it('the inert trigger carries data-state="closed" (audit finding M5)', () => {
    // `SELECT_TRIGGER_CLASSNAME` is shared with the real Radix trigger and already
    // includes a `data-[state=open]:` utility; the inert stand-in must expose the same
    // attribute (in its closed value) so a future utility keyed off `data-state` applies
    // to both, not just the upgraded control.
    renderTable(makeButtons(1));
    const trigger = screen.getByRole('combobox', { name: 'Button type' });
    expect(trigger.getAttribute('data-state')).toBe('closed');
  });
});

describe('EventButtonsTable — lazy button-type control (scenario b: single activation)', () => {
  it('a mouse click upgrades and opens the control, operable, with the same options and selected value', () => {
    const onChange = renderTable([makeDraft({ id: 'b1', type: 'DROPDOWN' })]);
    const trigger = screen.getByRole('combobox', { name: 'Button type' });
    const beforeActivation = selectRootMounts; // the toolbar select's own Root

    // Realistic mouse gesture: pointerdown (focuses the target per browser default
    // action) precedes click.
    fireEvent.pointerDown(trigger, { pointerType: 'mouse', button: 0 });
    fireEvent.focus(trigger);
    fireEvent.pointerUp(trigger, { pointerType: 'mouse', button: 0 });
    fireEvent.click(trigger);

    expect(selectRootMounts).toBeGreaterThan(beforeActivation);
    const listbox = screen.getByRole('listbox');
    expect(listbox).toBeTruthy();
    // Same options as before this change (the ItemIndicator's "✓" is `aria-hidden`, so
    // it is excluded from each option's accessible name).
    for (const label of ['BUTTON', 'DROPDOWN', 'TEXT', 'ON / OFF']) {
      expect(screen.getByRole('option', { name: label })).toBeTruthy();
    }
    expect(screen.getByRole('option', { name: 'DROPDOWN' }).getAttribute('data-state')).toBe(
      'checked',
    );

    fireEvent.click(screen.getByRole('option', { name: 'TEXT' }));
    expect(onChange).toHaveBeenCalled();
    const [newButtons] = onChange.mock.lastCall as [EventButtonDraft[]];
    expect(newButtons[0].type).toBe('TEXT');
  });

  it('a bare click with no preceding pointer or focus events upgrades and opens the control (touch/AT path)', () => {
    const onChange = renderTable([makeDraft({ id: 'b1', type: 'BUTTON' })]);
    const trigger = screen.getByRole('combobox', { name: 'Button type' });
    const beforeActivation = selectRootMounts;

    // No pointerdown, no focus — exactly what a touch tap or an assistive-technology
    // synthesized activation delivers.
    fireEvent.click(trigger);

    expect(selectRootMounts).toBeGreaterThan(beforeActivation);
    expect(screen.getByRole('listbox')).toBeTruthy();
    for (const label of ['BUTTON', 'DROPDOWN', 'TEXT', 'ON / OFF']) {
      expect(screen.getByRole('option', { name: label })).toBeTruthy();
    }
    expect(screen.getByRole('option', { name: 'BUTTON' }).getAttribute('data-state')).toBe(
      'checked',
    );

    fireEvent.click(screen.getByRole('option', { name: 'ON / OFF' }));
    expect(onChange).toHaveBeenCalled();
    const [newButtons] = onChange.mock.lastCall as [EventButtonDraft[]];
    expect(newButtons[0].type).toBe('ON_OFF');
  });
});

describe('EventButtonsTable — lazy button-type control (regression: M4, pointerActiveRef stuck true)', () => {
  it('recovers when a pointerdown is never followed by pointerup, blur, or click (press, drag off, release elsewhere)', () => {
    renderTable([makeDraft({ id: 'b1', type: 'DROPDOWN' })]);
    const trigger = screen.getByRole('combobox', { name: 'Button type' });

    // Press-and-drag-off-and-release-elsewhere: on Safari/Firefox on macOS a <button>
    // is not focused as part of mousedown's default action, and the release lands off
    // the element with no pointer capture for mouse — so this gesture fires pointerdown,
    // then a pointerleave as the pointer moves off the element mid-drag, and nothing
    // else on the trigger (no pointerup, no blur — it was never focused).
    // `pointerActiveRef` is set true by the pointerdown and, without M4's fix, has no
    // way left to clear.
    fireEvent.pointerDown(trigger, { pointerType: 'mouse', button: 0 });
    fireEvent.pointerLeave(trigger, { pointerType: 'mouse' });

    // Later, an unrelated keyboard Tab focuses the control. A real Radix trigger opens
    // on the following ArrowDown; the guarded `onFocus` here must not treat this as the
    // tail of the earlier pointer gesture (there is no click coming to open it).
    fireEvent.focus(trigger);
    const stillTrigger = screen.getByRole('combobox', { name: 'Button type' });
    fireEvent.keyDown(stillTrigger, { key: 'ArrowDown' });

    expect(screen.getByRole('listbox')).toBeTruthy();
  });
});

describe('EventButtonsTable — lazy button-type control (scenario c: keyboard focus)', () => {
  it('tabbing to the control upgrades it and leaves focus on it, with matching accessible name/role/ARIA state, operable by keyboard alone', () => {
    renderTable([makeDraft({ id: 'b1', type: 'DROPDOWN' })]);
    const inertTrigger = screen.getByRole('combobox', { name: 'Button type' });
    expect(inertTrigger.getAttribute('aria-expanded')).toBe('false');
    const beforeFocus = selectRootMounts;

    // Pure keyboard focus — no pointerdown at all.
    fireEvent.focus(inertTrigger);

    expect(selectRootMounts).toBeGreaterThan(beforeFocus);
    // Focus must land ON the upgraded control, not body/next element.
    const upgraded = screen.getByRole('combobox', { name: 'Button type' });
    expect(document.activeElement).toBe(upgraded);
    expect(upgraded.getAttribute('aria-expanded')).toBe('false');
    // A bare focus pre-warms but does not itself open the control.
    expect(screen.queryByRole('listbox')).toBeNull();

    // Now fully keyboard-operable: no pointer event anywhere in this sequence.
    fireEvent.keyDown(upgraded, { key: 'Enter' });
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(screen.getByRole('option', { name: 'DROPDOWN' }).getAttribute('data-state')).toBe(
      'checked',
    );
  });
});
