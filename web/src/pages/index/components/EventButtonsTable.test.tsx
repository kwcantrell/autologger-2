import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Show } from '../../../api/types';
import { renderStrict } from '../../../test/renderStrict';
import type { EventButtonDraft } from './EventButtonsTable';
import { EventButtonsTable } from './EventButtonsTable';

// Radix Popover (the per-row instruction editor) positions via floating-ui, which
// constructs a ResizeObserver; jsdom has none. Minimal no-op stub (same pattern as
// RecentSessionsList.test.tsx).
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (typeof window !== 'undefined' && typeof window.ResizeObserver === 'undefined') {
  window.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
}

// --- EventButtonsTable.copyFromShow (teams-settings-nav, task 1.1c) ---
//
// `profile.shows[].categories` (the `otherShows` prop's source) is served name-keyed
// (server: `showApiDict` passes stored `CategoryRecord` JSON through verbatim; see
// `server/src/db/showsStore.ts`). `copyFromShow` previously read `c.label` from that
// name-keyed shape, so copying from another show always produced blank names. This
// pins the fix: hydrate with `c.name ?? c.label ?? ''`. The fixture below is
// deliberately `name`-keyed with no `label` key, so a `label`-keyed fixture can't mask
// the bug.

vi.mock('./Select', () => ({
  Select: (props: {
    value: string;
    ariaLabel?: string;
    onChange: (value: string) => void;
    options: { value: string; label: string }[];
  }) => (
    <select
      aria-label={props.ariaLabel}
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
    >
      <option value="" />
      {props.options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  ),
}));

const sourceShow = {
  id: 'show-2',
  studio_id: 'studio-1',
  name: 'Evening News',
  show_code: 'EN',
  next_episode: 3,
  categories: [
    {
      id: 'cat-9',
      name: 'Break',
      color: '#445566',
      type: 'BUTTON',
      dropdown_options: [],
      on_label: '',
      off_label: '',
      // Wire key (auto-generate-event-logs): copy-from-show must carry it.
      auto_instruction: 'Log every commercial break',
    },
    {
      id: 'cat-10',
      name: 'Camera',
      color: '#556677',
      type: 'DROPDOWN',
      // Option-level instruction only — carried verbatim with the options.
      dropdown_options: [
        { label: 'Cam A', needs_context: false, auto_instruction: 'When cam A goes live' },
        { label: 'Cam B', needs_context: false },
      ],
      on_label: '',
      off_label: '',
    },
  ],
  event_palette: [],
  event_palette_preset: 'custom',
  event_palette_custom: [],
} as unknown as Show;

// Fully-populated draft builder for the instruction-editor tests below.
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

describe('EventButtonsTable.copyFromShow', () => {
  it('copies category names from a name-keyed source show', () => {
    const onChange = vi.fn();
    renderStrict(
      <EventButtonsTable
        buttons={[]}
        palette={[]}
        palettePreset="custom"
        paletteCustom={[]}
        otherShows={[sourceShow]}
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByLabelText('Show to copy event buttons from'), {
      target: { value: 'show-2' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const [newButtons] = onChange.mock.calls[0] as [Array<{ name: string }>];
    expect(newButtons).toHaveLength(2);
    expect(newButtons[0]).toMatchObject({ name: 'Break' });
  });

  it('carries button- and option-level auto_instruction with the copied buttons', () => {
    const onChange = vi.fn();
    renderStrict(
      <EventButtonsTable
        buttons={[]}
        palette={[]}
        palettePreset="custom"
        paletteCustom={[]}
        otherShows={[sourceShow]}
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByLabelText('Show to copy event buttons from'), {
      target: { value: 'show-2' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));

    const [newButtons] = onChange.mock.calls[0] as [EventButtonDraft[]];
    expect(newButtons[0].auto_instruction).toBe('Log every commercial break');
    // Option-level instructions ride along verbatim inside dropdown_options.
    expect(newButtons[1].auto_instruction).toBe('');
    expect(newButtons[1].dropdown_options).toEqual([
      { label: 'Cam A', needs_context: false, auto_instruction: 'When cam A goes live' },
      { label: 'Cam B', needs_context: false },
    ]);
  });
});

// --- Per-row generation-instruction editor (auto-generate-event-logs, task 1.3;
// spec: web-ui-system "Generation instruction fields in Settings") ---

describe('EventButtonsTable instruction editor', () => {
  it('saving the instruction modal propagates through onChange', async () => {
    const onChange = renderTable([makeDraft({ id: 'b1', name: 'Slate' })]);

    fireEvent.click(screen.getByLabelText('AI Rules'));
    const textarea = (await screen.findByLabelText(
      'Generation instruction',
    )) as HTMLTextAreaElement;
    expect(textarea.maxLength).toBe(2000);
    fireEvent.change(textarea, { target: { value: 'Log every slate call' } });
    // Draft only — not committed until Save.
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    const [newButtons] = onChange.mock.lastCall as [EventButtonDraft[]];
    expect(newButtons[0].auto_instruction).toBe('Log every slate call');
  });

  it('cancel discards draft edits without calling onChange', async () => {
    const onChange = renderTable([
      makeDraft({ id: 'b1', name: 'Slate', auto_instruction: 'Keep me' }),
    ]);

    fireEvent.click(screen.getByLabelText('AI Rules (has instructions)'));
    const textarea = (await screen.findByLabelText(
      'Generation instruction',
    )) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Discard me' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Generation instruction')).toBeNull();
  });

  it('auto-grows the instruction textarea to fit existing text when opened', async () => {
    // jsdom's scrollHeight is 0 — stub a content-driven height so the fit path
    // is observable (same approach TopicsRow relies on in a real browser).
    Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
      configurable: true,
      get(this: HTMLTextAreaElement) {
        return Math.max(1, this.value.split('\n').length) * 20;
      },
    });
    Object.defineProperty(HTMLTextAreaElement.prototype, 'offsetHeight', {
      configurable: true,
      get: () => 22,
    });
    Object.defineProperty(HTMLTextAreaElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => 20,
    });

    const long = 'Line one\nLine two\nLine three\nLine four\nLine five';
    renderTable([makeDraft({ id: 'b1', name: 'Slate', auto_instruction: long })]);

    fireEvent.click(screen.getByLabelText('AI Rules (has instructions)'));
    const textarea = (await screen.findByLabelText(
      'Generation instruction',
    )) as HTMLTextAreaElement;

    expect(textarea.style.height).toBe('102px'); // 5*20 + 2px border
  });

  it('offers the editor for BUTTON, DROPDOWN and TEXT rows but not ON_OFF', () => {
    renderTable([
      makeDraft({ id: 'b1', type: 'BUTTON' }),
      makeDraft({ id: 'b2', type: 'DROPDOWN' }),
      makeDraft({ id: 'b3', type: 'TEXT' }),
      makeDraft({ id: 'b4', type: 'ON_OFF', on_label: 'ON', off_label: 'OFF' }),
    ]);

    // Exactly three triggers: the ON_OFF row offers no instruction field at all.
    expect(screen.getAllByLabelText('AI Rules')).toHaveLength(3);
  });

  it('switching a type to ON_OFF drops button- and option-level instructions from the draft', () => {
    const onChange = renderTable([
      makeDraft({
        id: 'b1',
        type: 'DROPDOWN',
        auto_instruction: 'Whole-button instruction',
        dropdown_options: [
          { label: 'A', needs_context: false, auto_instruction: 'Option instruction' },
          { label: 'B', needs_context: false },
        ],
      }),
    ]);

    fireEvent.change(screen.getByLabelText('Button type'), { target: { value: 'ON_OFF' } });

    const [newButtons] = onChange.mock.lastCall as [EventButtonDraft[]];
    expect(newButtons[0].type).toBe('ON_OFF');
    expect(newButtons[0].auto_instruction).toBe('');
    expect(newButtons[0].dropdown_options).toEqual([]);
  });
});

describe('EventButtonsTable instruction-bearing indicator', () => {
  // The trigger's accessible NAME is the indicator's assistive-tech surface: an
  // `aria-label` wins the accessible-name computation, so state must live in the
  // label itself ("… (has instructions)") — a sibling sr-only span would never be
  // announced and the state would be conveyed by color alone.
  const BEARING_NAME = 'AI Rules (has instructions)';
  const PLAIN_NAME = 'AI Rules';

  it('lights for an option-only DROPDOWN (single instruction-bearing definition)', () => {
    renderTable([
      makeDraft({
        id: 'b1',
        type: 'DROPDOWN',
        auto_instruction: '',
        dropdown_options: [
          { label: 'A', needs_context: false, auto_instruction: 'When A happens' },
          { label: 'B', needs_context: false },
        ],
      }),
    ]);

    expect(screen.getByRole('button', { name: BEARING_NAME })).not.toBeNull();
  });

  it('lights for a button-level instruction', () => {
    renderTable([makeDraft({ id: 'b1', auto_instruction: 'Log it' })]);
    expect(screen.getByRole('button', { name: BEARING_NAME })).not.toBeNull();
  });

  it('does not light without instructions', () => {
    renderTable([makeDraft({ id: 'b1' }), makeDraft({ id: 'b2', type: 'DROPDOWN' })]);
    expect(screen.queryByRole('button', { name: BEARING_NAME })).toBeNull();
    // The triggers are still there — just with the plain (non-bearing) name.
    expect(screen.getAllByRole('button', { name: PLAIN_NAME })).toHaveLength(2);
  });

  it('does not light for stale option instructions on a non-DROPDOWN type', () => {
    // The definition counts option instructions only for DROPDOWN buttons — options
    // lingering on a draft after a type switch away from DROPDOWN must not count.
    renderTable([
      makeDraft({
        id: 'b1',
        type: 'TEXT',
        dropdown_options: [{ label: 'A', needs_context: false, auto_instruction: 'stale' }],
      }),
    ]);
    expect(screen.queryByRole('button', { name: BEARING_NAME })).toBeNull();
    expect(screen.getByRole('button', { name: PLAIN_NAME })).not.toBeNull();
  });

  it('never lights for ON_OFF, even with stale draft values', () => {
    renderTable([
      makeDraft({
        id: 'b1',
        type: 'ON_OFF',
        on_label: 'ON',
        off_label: 'OFF',
        auto_instruction: 'stale',
      }),
    ]);
    expect(screen.queryByRole('button', { name: BEARING_NAME })).toBeNull();
    // ON_OFF offers no trigger at all.
    expect(screen.queryByRole('button', { name: PLAIN_NAME })).toBeNull();
  });
});
