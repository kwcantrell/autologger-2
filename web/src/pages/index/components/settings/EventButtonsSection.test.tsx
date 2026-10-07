import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../../../../api/client';
import type { ProfilePayload, Show, ShowCategory, TeamRole } from '../../../../api/types';
import { renderStrict } from '../../../../test/renderStrict';
import { EVENT_COLOR_PRESETS } from './eventButtonsModel';
import { SettingsView } from './SettingsView';
import type { SettingsSectionId } from './sections';

// --- Settings › Event buttons (redesign-show-ignition 9.1-9.2; design D6; web-ui-system
// "Generation instruction fields in Settings", "Honest save model in Settings") ---
//
// The real view, section, hooks and QueryClient; `apiFetch` plays a small server whose profile
// write applies `show_updates` to the shows the next GET serves. The list is one card (Palette,
// Colours, a row per button, Add button) plus Copy from another show; each button is edited in a
// side panel whose Save writes the show's whole category array.

vi.mock('../../../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../api/client')>();
  return { ...actual, apiFetch: vi.fn() };
});
vi.mock('../../utils/toast', () => ({ showToast: vi.fn() }));
// The Radix select is a popper; a native stand-in keeps the copy-from choice one change event.
vi.mock('../Select', () => ({
  Select: (props: {
    value: string;
    ariaLabel?: string;
    disabled?: boolean;
    onChange: (value: string) => void;
    options: { value: string; label: string }[];
  }) => (
    <select
      aria-label={props.ariaLabel}
      value={props.value}
      disabled={props.disabled}
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

const mockedApiFetch = vi.mocked(apiFetch);

const cat = (c: Partial<ShowCategory> & { id: string; name: string }): ShowCategory =>
  ({
    color: '#112233',
    type: 'BUTTON',
    dropdown_options: [],
    on_label: '',
    off_label: '',
    ...c,
  }) as ShowCategory;

const PALETTE = [
  '#111111',
  '#222222',
  '#333333',
  '#444444',
  '#555555',
  '#666666',
  '#777777',
  '#888888',
  '#999999',
];

function makeShows(): Show[] {
  return [
    {
      id: 'show-1',
      studio_id: 'team-a',
      name: 'Morning Desk',
      show_code: 'MD',
      title_suffix: 'date',
      categories: [
        cat({ id: 'cat-1', name: 'Roll Call', auto_instruction: 'Log every roll call' }),
        cat({
          id: 'cat-2',
          name: 'Camera',
          type: 'DROPDOWN',
          color: '#222222',
          dropdown_options: [
            { label: 'Wide', needs_context: false, auto_instruction: 'When a wide shot is called' },
            { label: 'Close', needs_context: true },
            { label: 'Drone', needs_context: false },
          ],
        }),
        cat({ id: 'cat-3', name: 'Mic', type: 'ON_OFF', on_label: 'LIVE', off_label: 'MUTED' }),
        cat({ id: 'cat-4', name: 'Note', type: 'TEXT' }),
      ],
      event_palette: PALETTE,
      event_palette_preset: 'custom',
      event_palette_custom: PALETTE,
    },
    {
      id: 'show-2',
      studio_id: 'team-a',
      name: 'Late Edition',
      show_code: 'LE',
      title_suffix: 'episode',
      categories: [
        cat({ id: 'src-1', name: 'Applause', auto_instruction: 'When the audience claps' }),
        cat({
          id: 'src-2',
          name: 'Guest',
          type: 'DROPDOWN',
          dropdown_options: [
            { label: 'Arrives', needs_context: false, auto_instruction: 'On entry' },
          ],
        }),
      ],
      event_palette: EVENT_COLOR_PRESETS.aqua,
      event_palette_preset: 'aqua',
      event_palette_custom: PALETTE,
    },
  ] as unknown as Show[];
}

let shows: Show[];
let profile: ProfilePayload;
let failPut: Error | null = null;

function profileAs(role: TeamRole): ProfilePayload {
  return {
    active_studio_id: 'team-a',
    active_show_id: 'show-1',
    active_studio: { id: 'team-a', name: 'Team A', categories: [] },
    studios: [{ id: 'team-a', name: 'Team A', categories: [] }],
    studio_settings: {},
    shows: shows.map(({ id, studio_id, name, show_code, title_suffix }) => ({
      id,
      studio_id,
      name,
      show_code,
      title_suffix,
      can_access: true,
    })),
    new_session_defaults: { title_prefix: '', default_frame_rate: 25 },
    admin: { restart_supported: false, restart_needs_token: false },
    auth: {
      logged_in: true,
      oauth_configured: true,
      user: {
        id: 'me',
        email: 'me@example.com',
        given_name: 'Me',
        family_name: '',
        picture_url: null,
        teams: [{ id: 'team-a', name: 'Team A', role }],
      },
    },
  } as unknown as ProfilePayload;
}

function route() {
  mockedApiFetch.mockImplementation(async (path: string, opts?: RequestInit) => {
    const method = opts?.method ?? 'GET';
    if (path === 'profile' && method === 'GET') return profile;
    if (path === 'profile' && method === 'PUT') {
      if (failPut) throw failPut;
      const body = JSON.parse(String(opts?.body));
      for (const u of body.show_updates ?? []) {
        shows = shows.map((s) => (s.id === u.show_id ? ({ ...s, ...u } as Show) : s));
      }
      return profile;
    }
    if (path === 'shows?studio_id=team-a') return { shows: structuredClone(shows) };
    throw new Error(`unexpected apiFetch: ${method} ${path}`);
  });
}

function Harness() {
  const [section, setSection] = useState<SettingsSectionId>('event-buttons');
  return (
    <SettingsView
      section={section}
      onSectionChange={setSection}
      onClose={vi.fn()}
      onCloseSession={vi.fn()}
      backLabel="Back to sessions"
    />
  );
}

function renderButtons(role: TeamRole = 'owner') {
  profile = profileAs(role);
  route();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['profile'], profile);
  renderStrict(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
}

type PutBody = {
  active_studio_id: string;
  active_show_id: string;
  show_updates: {
    show_id: string;
    categories: Record<string, unknown>[];
    event_palette: string[];
    event_palette_preset: string;
    event_palette_custom: string[];
  }[];
};

const section = () => document.getElementById('settings-section-event-buttons') as HTMLElement;
const inSection = () => within(section());
const putBodies = () =>
  mockedApiFetch.mock.calls
    .filter(([p, o]) => p === 'profile' && o?.method === 'PUT')
    .map(([, o]) => JSON.parse(String(o?.body)) as PutBody);
const findRow = (name: string) => screen.findByTestId(`event-button-row-${name}`);
const rowNames = () =>
  [...section().querySelectorAll('[data-row]')].map((r) => r.getAttribute('data-row'));
const openPanel = async (name: string) => {
  fireEvent.click(within(await findRow(name)).getByRole('button', { name: `Edit ${name}` }));
  return screen.findByRole('dialog', { name: 'Edit button' });
};
const panelSave = (panel: HTMLElement, name = 'Save') =>
  within(panel).getByRole('button', { name }) as HTMLButtonElement;
const savedCategories = (i = 0) => putBodies()[i].show_updates[0].categories;

beforeEach(() => {
  mockedApiFetch.mockReset();
  failPut = null;
  shows = makeShows();
});

describe('Event buttons list', () => {
  it('one card: Palette, Colours, then a row per button with key, name, summary, colour and Edit, then Add button', async () => {
    renderButtons();
    await findRow('Roll Call');
    expect(rowNames()).toEqual([
      'palette',
      'colours',
      'button',
      'button',
      'button',
      'button',
      'add',
    ]);
    const card = section().querySelector('[data-row="palette"]')?.closest('[data-slot="card"]');
    expect(card?.querySelector('[data-row="add"]')).not.toBeNull();

    const row = await findRow('Camera');
    expect(row.querySelector('[data-slot="kbd"]')?.textContent).toBe('2');
    expect(within(row).getByText('Camera')).not.toBeNull();
    expect(within(row).getByRole('button', { name: 'Edit Camera' })).not.toBeNull();
    expect(
      (row.querySelector('[data-slot="event-button-colour"]') as HTMLElement).style.backgroundColor,
    ).toBe('rgb(34, 34, 34)');
    expect(within(await findRow('Mic')).getByText('On / Off · LIVE / MUTED')).not.toBeNull();
    expect(within(await findRow('Note')).getByText('Text')).not.toBeNull();
    expect(within(await findRow('Roll Call')).getByText('Button · Auto-generates')).not.toBeNull();
    expect(inSection().getByRole('button', { name: 'Add button' })).not.toBeNull();
    expect(inSection().queryByRole('button', { name: /Open previous Settings/ })).toBeNull();
    // Drag reorder is gone; position moves to the panel.
    expect(inSection().queryByRole('button', { name: /drag/i })).toBeNull();
  });

  it('keys run 1–9; a tenth button has no key', async () => {
    shows[0].categories = Array.from({ length: 10 }, (_, i) =>
      cat({ id: `c${i}`, name: `B${i + 1}` }),
    );
    renderButtons();
    expect((await findRow('B9')).querySelector('[data-slot="kbd"]')?.textContent).toBe('9');
    expect((await findRow('B10')).querySelector('[data-slot="kbd"]')?.textContent).toBe('–');
  });

  it('Option-only instructions light the indicator', async () => {
    renderButtons();
    const row = await findRow('Camera');
    expect(within(row).getByText('Dropdown · 3 options · Auto-generates')).not.toBeNull();
    expect(row.getAttribute('data-instruction-bearing')).toBe('true');
    expect((await findRow('Note')).getAttribute('data-instruction-bearing')).toBe('false');
    expect((await findRow('Mic')).getAttribute('data-instruction-bearing')).toBe('false');
  });

  it('a preset change arms the section save bar, and Save writes the palette with the team and show', async () => {
    renderButtons();
    await findRow('Roll Call');
    const bar = () =>
      within(section().querySelector('[data-slot="settings-save-bar"]') as HTMLElement);
    expect((bar().getByRole('button', { name: 'Saved' }) as HTMLButtonElement).disabled).toBe(true);
    const presets = inSection().getByRole('radiogroup', { name: 'Palette' });
    expect(
      within(presets)
        .getAllByRole('radio')
        .map((r) => r.textContent),
    ).toEqual(['Custom', 'Default', 'Neon', 'Desert', 'Aqua']);
    fireEvent.click(within(presets).getByRole('radio', { name: 'Neon' }));
    const save = bar().getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(bar().getByRole('button', { name: 'Saved' })).not.toBeNull());

    expect(putBodies()).toHaveLength(1);
    const body = putBodies()[0];
    expect(body.active_studio_id).toBe('team-a');
    expect(body.active_show_id).toBe('show-1');
    expect(body.show_updates[0]).toMatchObject({
      show_id: 'show-1',
      event_palette_preset: 'neon',
      event_palette: EVENT_COLOR_PRESETS.neon,
      event_palette_custom: PALETTE,
    });
    // The buttons go back unchanged, instructions included.
    expect(body.show_updates[0].categories.map((c) => c.id)).toEqual([
      'cat-1',
      'cat-2',
      'cat-3',
      'cat-4',
    ]);
    expect(body.show_updates[0].categories[0]).toMatchObject({
      auto_instruction: 'Log every roll call',
    });
  });

  it('editing a colour slot makes the palette Custom and arms Save', async () => {
    renderButtons();
    await findRow('Roll Call');
    fireEvent.click(
      within(inSection().getByRole('radiogroup', { name: 'Palette' })).getByRole('radio', {
        name: 'Desert',
      }),
    );
    fireEvent.change(inSection().getByLabelText('Colour 3'), { target: { value: '#ABCDEF' } });
    expect(
      within(inSection().getByRole('radiogroup', { name: 'Palette' }))
        .getByRole('radio', { name: 'Custom' })
        .getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('Copy from show preserves instructions', async () => {
    renderButtons();
    await findRow('Roll Call');
    fireEvent.change(inSection().getByLabelText('Show to copy buttons from'), {
      target: { value: 'show-2' },
    });
    fireEvent.click(inSection().getByRole('button', { name: 'Copy' }));
    // It replaces this show's buttons, so it asks first.
    const confirm = await screen.findByRole('alertdialog');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Replace buttons' }));
    await waitFor(() => expect(putBodies()).toHaveLength(1));

    const update = putBodies()[0].show_updates[0];
    expect(putBodies()[0].active_show_id).toBe('show-1');
    expect(update.show_id).toBe('show-1');
    expect(update.categories).toHaveLength(2);
    expect(update.categories[0]).toMatchObject({
      name: 'Applause',
      auto_instruction: 'When the audience claps',
    });
    expect(update.categories[1]).toMatchObject({
      name: 'Guest',
      dropdown_options: [{ label: 'Arrives', needs_context: false, auto_instruction: 'On entry' }],
    });
    // Fresh ids, so the two shows never share a category id.
    expect(update.categories.map((c) => c.id)).not.toContain('src-1');
    expect(update.event_palette_preset).toBe('aqua');
    expect(await findRow('Applause')).not.toBeNull();
  });

  it('a show with no other show says so instead of offering a copy', async () => {
    shows = shows.slice(0, 1);
    renderButtons();
    await findRow('Roll Call');
    expect(inSection().getByText('No other shows on this team')).not.toBeNull();
    expect(inSection().queryByRole('button', { name: 'Copy' })).toBeNull();
  });

  it('members see the controls disabled under the role notice', async () => {
    renderButtons('member');
    const row = await findRow('Camera');
    expect(section().querySelector('[data-slot="settings-role-notice"]')?.textContent).toContain(
      'You’re a member of Team A',
    );
    expect(
      (within(row).getByRole('button', { name: 'Edit Camera' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (inSection().getByRole('button', { name: 'Add button' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    for (const radio of within(
      inSection().getByRole('radiogroup', { name: 'Palette' }),
    ).getAllByRole('radio'))
      expect((radio as HTMLButtonElement).disabled).toBe(true);
    expect((inSection().getByLabelText('Colour 1') as HTMLInputElement).disabled).toBe(true);
    expect(
      (inSection().getByLabelText('Show to copy buttons from') as HTMLSelectElement).disabled,
    ).toBe(true);
  });
});

describe('Event-button panel', () => {
  it('holds a preview, name, type, colour, instruction, position and delete', async () => {
    renderButtons();
    const panel = await openPanel('Roll Call');
    expect(within(panel).getByTestId('event-button-preview').textContent).toContain('Roll Call');
    expect((within(panel).getByLabelText('Name') as HTMLInputElement).value).toBe('Roll Call');
    const type = within(panel).getByRole('radiogroup', { name: 'Type' });
    expect(
      within(type)
        .getAllByRole('radio')
        .map((r) => r.textContent),
    ).toEqual(['Button', 'Dropdown', 'Text', 'On / Off']);
    expect(panel.textContent).toContain('Logs one event with the button’s name.');
    const colours = within(panel).getByRole('radiogroup', { name: 'Colour' });
    expect(within(colours).getAllByRole('radio')).toHaveLength(9);
    expect(
      (within(panel).getByLabelText('Auto-generate instruction') as HTMLTextAreaElement).value,
    ).toBe('Log every roll call');
    expect(
      within(panel).getByLabelText('Auto-generate instruction').getAttribute('maxlength'),
    ).toBe('2000');
    expect(within(panel).getByText('Key 1')).not.toBeNull();
    expect(
      (within(panel).getByRole('button', { name: 'Move up' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(within(panel).getByRole('button', { name: 'Delete' })).not.toBeNull();
    expect(panelSave(panel).disabled).toBe(true);
  });

  it('Editing an instruction arms Save', async () => {
    renderButtons();
    const panel = await openPanel('Note');
    fireEvent.change(within(panel).getByLabelText('Auto-generate instruction'), {
      target: { value: 'Log notes the director calls out' },
    });
    expect(panelSave(panel).disabled).toBe(false);
    fireEvent.keyDown(within(panel).getByLabelText('Auto-generate instruction'), {
      key: 'Escape',
    });
    expect(await screen.findByRole('alertdialog')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(
      (within(panel).getByLabelText('Auto-generate instruction') as HTMLTextAreaElement).value,
    ).toBe('Log notes the director calls out');
  });

  it('an instruction cleared to empty is saved as absent', async () => {
    renderButtons();
    const panel = await openPanel('Roll Call');
    fireEvent.change(within(panel).getByLabelText('Auto-generate instruction'), {
      target: { value: '   ' },
    });
    fireEvent.click(panelSave(panel));
    await waitFor(() => expect(putBodies()).toHaveLength(1));
    expect(savedCategories()[0]).not.toHaveProperty('auto_instruction');
  });

  it('Dropdown options carry their own instructions', async () => {
    renderButtons();
    let panel = await openPanel('Camera');
    const options = within(panel).getByRole('group', { name: 'Options' });
    const labels = within(options).getAllByLabelText(/^Option \d label$/) as HTMLInputElement[];
    expect(labels.map((l) => l.value)).toEqual(['Wide', 'Close', 'Drone']);
    expect(
      (within(options).getByLabelText('Option 2 needs context') as HTMLElement).getAttribute(
        'aria-checked',
      ),
    ).toBe('true');
    const instr = within(options).getAllByLabelText(
      /^Option \d instruction$/,
    ) as HTMLTextAreaElement[];
    expect(instr.map((t) => t.value)).toEqual(['When a wide shot is called', '', '']);
    // The whole-button instruction is still editable.
    expect(within(panel).getByLabelText('Auto-generate instruction')).not.toBeNull();

    fireEvent.change(instr[1], { target: { value: '  When we go close  ' } });
    fireEvent.change(within(panel).getByLabelText('Auto-generate instruction'), {
      target: { value: 'Any camera change' },
    });
    fireEvent.click(within(options).getByRole('button', { name: 'Remove option 3' }));
    fireEvent.click(within(options).getByRole('button', { name: 'Add option' }));
    fireEvent.change(within(options).getByLabelText('Option 3 label'), {
      target: { value: 'Crane' },
    });
    fireEvent.click(panelSave(panel));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit button' })).toBeNull());

    expect(savedCategories()[1]).toMatchObject({
      id: 'cat-2',
      type: 'DROPDOWN',
      auto_instruction: 'Any camera change',
      dropdown_options: [
        { label: 'Wide', needs_context: false, auto_instruction: 'When a wide shot is called' },
        { label: 'Close', needs_context: true, auto_instruction: 'When we go close' },
        { label: 'Crane', needs_context: false },
      ],
    });

    // Reopened, the saved values round-trip.
    panel = await openPanel('Camera');
    expect(
      (within(panel).getAllByLabelText(/^Option \d instruction$/) as HTMLTextAreaElement[]).map(
        (t) => t.value,
      ),
    ).toEqual(['When a wide shot is called', 'When we go close', '']);
    expect(
      (within(panel).getByLabelText('Auto-generate instruction') as HTMLTextAreaElement).value,
    ).toBe('Any camera change');
  });

  it('ON_OFF buttons offer no instruction field', async () => {
    renderButtons();
    let panel = await openPanel('Mic');
    expect(within(panel).queryByLabelText('Auto-generate instruction')).toBeNull();
    expect(within(panel).queryByLabelText(/instruction/i)).toBeNull();
    expect((within(panel).getByLabelText('On label') as HTMLInputElement).value).toBe('LIVE');
    expect((within(panel).getByLabelText('Off label') as HTMLInputElement).value).toBe('MUTED');
    fireEvent.click(within(panel).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit button' })).toBeNull());

    // Switching an instruction-bearing BUTTON to On / Off drops its instruction.
    panel = await openPanel('Roll Call');
    fireEvent.click(within(panel).getByRole('radio', { name: 'On / Off' }));
    expect(within(panel).queryByLabelText('Auto-generate instruction')).toBeNull();
    expect((within(panel).getByLabelText('On label') as HTMLInputElement).value).toBe('ON');
    fireEvent.click(panelSave(panel));
    await waitFor(() => expect(putBodies()).toHaveLength(1));
    expect(savedCategories()[0]).toMatchObject({ id: 'cat-1', type: 'ON_OFF', on_label: 'ON' });
    expect(savedCategories()[0]).not.toHaveProperty('auto_instruction');
    await waitFor(async () =>
      expect((await findRow('Roll Call')).getAttribute('data-instruction-bearing')).toBe('false'),
    );
  });

  it('a colour swatch picks the button colour', async () => {
    renderButtons();
    const panel = await openPanel('Note');
    fireEvent.click(
      within(within(panel).getByRole('radiogroup', { name: 'Colour' })).getByRole('radio', {
        name: 'Colour 5 #555555',
      }),
    );
    fireEvent.click(panelSave(panel));
    await waitFor(() => expect(putBodies()).toHaveLength(1));
    expect(savedCategories()[3]).toMatchObject({ id: 'cat-4', color: '#555555' });
  });

  it('Move up changes the key number', async () => {
    renderButtons();
    const panel = await openPanel('Camera');
    expect(within(panel).getByText('Key 2')).not.toBeNull();
    fireEvent.click(within(panel).getByRole('button', { name: 'Move up' }));
    expect(within(panel).getByText('Key 1')).not.toBeNull();
    expect(within(panel).getByTestId('event-button-preview').textContent).toContain('1');
    expect(panelSave(panel).disabled).toBe(false);
    fireEvent.click(panelSave(panel));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit button' })).toBeNull());

    expect(savedCategories().map((c) => c.id)).toEqual(['cat-2', 'cat-1', 'cat-3', 'cat-4']);
    await waitFor(async () =>
      expect((await findRow('Camera')).querySelector('[data-slot="kbd"]')?.textContent).toBe('1'),
    );
  });

  it('Move down then Move up is no change', async () => {
    renderButtons();
    const panel = await openPanel('Camera');
    fireEvent.click(within(panel).getByRole('button', { name: 'Move down' }));
    expect(within(panel).getByText('Key 3')).not.toBeNull();
    fireEvent.click(within(panel).getByRole('button', { name: 'Move up' }));
    expect(panelSave(panel).disabled).toBe(true);
  });

  it('Delete needs a second click', async () => {
    renderButtons();
    const panel = await openPanel('Note');
    fireEvent.click(within(panel).getByRole('button', { name: 'Delete' }));
    expect(putBodies()).toHaveLength(0);
    fireEvent.click(within(panel).getByRole('button', { name: 'Click again to delete' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit button' })).toBeNull());

    expect(savedCategories().map((c) => c.id)).toEqual(['cat-1', 'cat-2', 'cat-3']);
    expect(putBodies()[0].active_show_id).toBe('show-1');
    await waitFor(() => expect(screen.queryByTestId('event-button-row-Note')).toBeNull());
  });

  it('Add button opens an empty panel whose Add needs a name, and appends the button', async () => {
    renderButtons();
    await findRow('Roll Call');
    fireEvent.click(inSection().getByRole('button', { name: 'Add button' }));
    const panel = await screen.findByRole('dialog', { name: 'New button' });
    expect((within(panel).getByLabelText('Name') as HTMLInputElement).value).toBe('');
    expect(within(panel).queryByRole('button', { name: 'Move up' })).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(panelSave(panel, 'Add button').disabled).toBe(true);
    fireEvent.change(within(panel).getByLabelText('Name'), { target: { value: 'Applause' } });
    fireEvent.click(panelSave(panel, 'Add button'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New button' })).toBeNull());

    const saved = savedCategories();
    expect(saved).toHaveLength(5);
    expect(saved[4]).toMatchObject({ name: 'Applause', type: 'BUTTON', color: '#111111' });
    expect(saved[4]).not.toHaveProperty('auto_instruction');
    expect((await findRow('Applause')).querySelector('[data-slot="kbd"]')?.textContent).toBe('5');
  });

  it('a failed save keeps the panel open and names what did not apply', async () => {
    renderButtons();
    const panel = await openPanel('Note');
    failPut = new Error('Show update refused.');
    fireEvent.change(within(panel).getByLabelText('Name'), { target: { value: 'Notes' } });
    fireEvent.click(panelSave(panel));
    expect(
      await within(panel).findByText('Couldn’t save the button: Show update refused.'),
    ).not.toBeNull();
    expect(screen.getByRole('dialog', { name: 'Edit button' })).not.toBeNull();
  });
});
