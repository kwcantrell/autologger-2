import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dialog } from './Dialog';

// shadcn-shared-wrappers D2: the shared Dialog is the shadcn Dialog on desktop and the vaul
// Drawer (bottom sheet) on mobile, behind the unchanged public API.

const realMatchMedia = window.matchMedia;
function setMobile(matches: boolean) {
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
afterEach(() => {
  window.matchMedia = realMatchMedia;
});

describe('Dialog (desktop)', () => {
  it('renders a dialog named by its title', () => {
    setMobile(false);
    render(
      <Dialog open onOpenChange={() => {}} title="Batch Import">
        body
      </Dialog>,
    );
    expect(screen.getByRole('dialog', { name: 'Batch Import' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  });

  it('hideTitle keeps the accessible name', () => {
    setMobile(false);
    render(
      <Dialog open onOpenChange={() => {}} title="New Session" hideTitle>
        body
      </Dialog>,
    );
    expect(screen.getByRole('dialog', { name: 'New Session' })).toBeTruthy();
  });

  it('closeOnOverlayClick={false} ignores an outside pointer-down', () => {
    setMobile(false);
    const onOpenChange = vi.fn();
    render(
      <Dialog open onOpenChange={onOpenChange} title="Failed" closeOnOverlayClick={false}>
        body
      </Dialog>,
    );
    fireEvent.pointerDown(document.body);
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

describe('Dialog (mobile bottom sheet)', () => {
  it('renders the vaul drawer as a dialog named by its title, with a drag handle', async () => {
    setMobile(true);
    render(
      <Dialog open onOpenChange={() => {}} title="Settings">
        body
      </Dialog>,
    );
    const sheet = await screen.findByRole('dialog', { name: 'Settings' });
    expect(sheet.hasAttribute('data-vaul-drawer')).toBe(true);
    expect(sheet.querySelector('[data-vaul-handle]')).not.toBeNull();
  });

  it('Escape asks to close', async () => {
    setMobile(true);
    const onOpenChange = vi.fn();
    render(
      <Dialog open onOpenChange={onOpenChange} title="Settings">
        body
      </Dialog>,
    );
    const sheet = await screen.findByRole('dialog', { name: 'Settings' });
    fireEvent.keyDown(sheet, { key: 'Escape' });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('moves focus into the sheet on open (not left on the trigger behind it)', async () => {
    setMobile(true);
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Delete row
          </button>
          <Dialog open={open} onOpenChange={setOpen} title="Delete row?">
            <button type="button">Keep</button>
          </Dialog>
        </>
      );
    }
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Delete row' });
    trigger.focus();
    fireEvent.click(trigger);
    const sheet = await screen.findByRole('dialog', { name: 'Delete row?' });
    await waitFor(() => expect(sheet.contains(document.activeElement)).toBe(true));
  });

  it('a vetoed close keeps the same sheet node and child state, and resets the drag transform', async () => {
    setMobile(true);
    function Child() {
      const [text, setText] = useState('');
      return <input aria-label="Draft" value={text} onChange={(e) => setText(e.target.value)} />;
    }
    // Parent vetoes every close (a dirty form's "Keep editing" pattern).
    render(
      <Dialog open onOpenChange={() => {}} title="Settings">
        <Child />
      </Dialog>,
    );
    const sheet = await screen.findByRole('dialog', { name: 'Settings' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Draft' }), {
      target: { value: 'edited' },
    });
    sheet.style.transform = 'translate3d(0, 180px, 0)'; // as left by an aborted drag
    fireEvent.keyDown(sheet, { key: 'Escape' });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBe(sheet);
    expect((screen.getByRole('textbox', { name: 'Draft' }) as HTMLInputElement).value).toBe(
      'edited',
    );
    expect(sheet.style.transform).toBe('translate3d(0, 0, 0)');
  });
});

// A dialog keeps the mode it opened in until it closes (shadcn-shared-wrappers D2): crossing the
// md breakpoint while open (window resize, tablet rotation) must not swap card ↔ sheet, which
// would remount the content and drop child state (e.g. Settings' nested Event options dialog).
describe('Dialog keeps its open-time mode across a breakpoint change', () => {
  it('stays the same desktop dialog node, with child state, when the viewport goes mobile', async () => {
    let matches = false;
    const listeners = new Set<(e: { matches: boolean }) => void>();
    window.matchMedia = ((query: string) => ({
      get matches() {
        return matches;
      },
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: (_t: string, cb: (e: { matches: boolean }) => void) => listeners.add(cb),
      removeEventListener: (_t: string, cb: (e: { matches: boolean }) => void) =>
        listeners.delete(cb),
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;

    function Child() {
      const [text, setText] = useState('');
      return <input aria-label="Draft" value={text} onChange={(e) => setText(e.target.value)} />;
    }
    render(
      <Dialog open onOpenChange={() => {}} title="Settings">
        <Child />
      </Dialog>,
    );
    const card = screen.getByRole('dialog', { name: 'Settings' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Draft' }), {
      target: { value: 'edited' },
    });

    act(() => {
      matches = true;
      for (const cb of listeners) cb({ matches: true });
    });

    const after = screen.getByRole('dialog', { name: 'Settings' });
    expect(after).toBe(card);
    expect(after.hasAttribute('data-vaul-drawer')).toBe(false);
    expect((screen.getByRole('textbox', { name: 'Draft' }) as HTMLInputElement).value).toBe(
      'edited',
    );
  });
});

// shadcn-port-settings D2: the shared action row (the former `.modal-actions` look).
describe('DialogActions', () => {
  it('renders a dialog-actions row with its children in order', async () => {
    const { DialogActions } = await import('./Dialog');
    render(
      <DialogActions>
        <button type="button">Cancel</button>
        <button type="button">Save</button>
      </DialogActions>,
    );
    const row = document.querySelector('[data-slot="dialog-actions"]') as HTMLElement;
    expect(row).not.toBeNull();
    expect([...row.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      'Cancel',
      'Save',
    ]);
  });
});

describe('TOUCH_TARGET', () => {
  it('is the 44px mobile floor the legacy .btn had (D2b)', async () => {
    const { TOUCH_TARGET } = await import('../components/ui/button');
    expect(TOUCH_TARGET).toBe('max-md:min-h-11');
  });
});
