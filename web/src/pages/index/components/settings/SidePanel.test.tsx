import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Input } from '../../../../shared/components/ui/input';
import { renderStrict } from '../../../../test/renderStrict';
import { runSaveSteps, SidePanel } from './SidePanel';

// --- SidePanel (redesign-show-ignition 6.3; design D4, D10; web-ui-system "Honest save model in
// Settings", side panels) ---
//
// The shared right-hand panel the member, show and event-button editors open in (groups 8-9).
// A shadcn Sheet with Cancel/Save; dirtiness is the draft against the snapshot taken when the
// panel opened; every close path with unsaved edits goes through the themed confirm; a failed save
// stays open naming the step that failed.

function Harness({
  onSave = vi.fn().mockResolvedValue(undefined),
  required = false,
}: {
  onSave?: (draft: { name: string }) => Promise<void>;
  required?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ name: 'Alpha' });
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setDraft({ name: 'Alpha' });
          setOpen(true);
        }}
      >
        Edit
      </button>
      <SidePanel
        open={open}
        onClose={() => setOpen(false)}
        title="Edit button"
        description="Changes apply when you save."
        value={draft}
        valid={!required || draft.name.trim() !== ''}
        onSave={() => onSave(draft)}
      >
        <label htmlFor="panel-name">Name</label>
        <Input
          id="panel-name"
          value={draft.name}
          onChange={(e) => setDraft({ name: e.target.value })}
        />
      </SidePanel>
    </>
  );
}

const openPanel = () => fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
const panel = () => screen.queryByRole('dialog', { name: 'Edit button' });
const save = () => screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
const edit = (value: string) =>
  fireEvent.change(screen.getByLabelText('Name'), { target: { value } });

describe('SidePanel', () => {
  it('is a right-hand sheet titled and described by its header', () => {
    renderStrict(<Harness />);
    openPanel();
    const dialog = panel();
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute('data-slot')).toBe('sheet-content');
    expect(dialog?.textContent).toContain('Changes apply when you save.');
  });

  it('keeps Cancel and Save clear of the bottom-right corner, where the Perf toggle sits', () => {
    // The perf-debug toggle (`shared/utils/perfDebug.ts`, every build) is fixed 10px from the
    // bottom-right corner; the actions row reserves that corner instead of moving the tool.
    renderStrict(<Harness />);
    openPanel();
    const actions = save().parentElement as HTMLElement;
    expect(actions.getAttribute('data-slot')).toBe('side-panel-actions');
    expect(actions.className.split(/\s+/)).toContain('pr-16');
  });

  it('Save is disabled until a change, and again when the change is undone', () => {
    renderStrict(<Harness />);
    openPanel();
    expect(save().disabled).toBe(true);
    edit('Bravo');
    expect(save().disabled).toBe(false);
    edit('Alpha');
    expect(save().disabled).toBe(true);
  });

  it('Save stays disabled while a required field is invalid', () => {
    renderStrict(<Harness required />);
    openPanel();
    edit('');
    expect(save().disabled).toBe(true);
  });

  it('a clean close does not prompt', () => {
    renderStrict(<Harness />);
    openPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(panel()).toBeNull();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it.each([
    ['Cancel', () => fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))],
    ['the close control', () => fireEvent.click(screen.getByRole('button', { name: 'Close' }))],
    ['Escape', () => fireEvent.keyDown(screen.getByLabelText('Name'), { key: 'Escape' })],
  ])('a dirty close by %s prompts, and declining keeps the edits', async (_name, close) => {
    renderStrict(<Harness />);
    openPanel();
    edit('Bravo');
    close();

    expect(await screen.findByRole('alertdialog')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(panel()).not.toBeNull();
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Bravo');
  });

  it('a dirty close by a click outside prompts; discarding closes', async () => {
    renderStrict(<Harness />);
    openPanel();
    edit('Bravo');
    // Radix arms its outside-pointer listener a macrotask after the layer mounts.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    const overlay = document.querySelector('[data-slot="sheet-overlay"]') as HTMLElement;
    // This Radix defers an outside dismissal to the click that completes the press.
    fireEvent.pointerDown(overlay, { button: 0 });
    fireEvent.click(overlay);

    expect(await screen.findByRole('alertdialog')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(panel()).toBeNull());
  });

  it('a successful save closes the panel', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderStrict(<Harness onSave={onSave} />);
    openPanel();
    edit('Bravo');
    fireEvent.click(save());
    await waitFor(() => expect(panel()).toBeNull());
    expect(onSave).toHaveBeenCalledWith({ name: 'Bravo' });
  });

  it('an error stays open with a message naming the failed step', async () => {
    const onSave = vi.fn(() =>
      runSaveSteps([
        { label: 'change the role', run: () => Promise.resolve() },
        { label: 'grant Morning News', run: () => Promise.reject(new Error('Forbidden.')) },
        { label: 'remove the member', run: vi.fn() },
      ]),
    );
    renderStrict(<Harness onSave={onSave} />);
    openPanel();
    edit('Bravo');
    await act(async () => {
      fireEvent.click(save());
    });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Couldn’t grant Morning News');
    expect(alert.textContent).toContain('Forbidden.');
    expect(panel()).not.toBeNull();
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Bravo');
    // Save can be tried again.
    expect(save().disabled).toBe(false);
  });
});

describe('runSaveSteps', () => {
  it('runs the steps in order and stops at the first failure', async () => {
    const calls: string[] = [];
    const third = vi.fn();
    await expect(
      runSaveSteps([
        { label: 'one', run: async () => void calls.push('one') },
        {
          label: 'two',
          run: async () => {
            calls.push('two');
            throw new Error('nope');
          },
        },
        { label: 'three', run: third },
      ]),
    ).rejects.toMatchObject({ step: 'two', message: 'Couldn’t two: nope' });
    expect(calls).toEqual(['one', 'two']);
    expect(third).not.toHaveBeenCalled();
  });
});
