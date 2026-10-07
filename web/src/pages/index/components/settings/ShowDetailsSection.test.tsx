import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../../../../api/client';
import { sessionStatusKeys } from '../../../../api/hooks/useSessionStatus';
import { showKeys } from '../../../../api/hooks/useShows';
import type { ProfilePayload, Show } from '../../../../api/types';
import { renderStrict } from '../../../../test/renderStrict';
import { SettingsView } from './SettingsView';
import type { SettingsSectionId } from './sections';

// --- Settings › Show details (redesign-show-ignition 7.2) ---
//
// Ports the previous Settings dialog's Suffix tests (session-title-suffix "Show title-suffix
// preference") and its three shows-section states (web-ui-system "The Settings shows section says
// why it has nothing to show"), plus "Saving persists shows whose tab was never visited" and the
// member view (team-management "Member content access"). Real view, sections, hooks and
// QueryClient; `apiFetch` is the one seam, and the offline hold is react-query's own
// (`onlineManager`), not a hand-built shape.

vi.mock('../../../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../api/client')>();
  return { ...actual, apiFetch: vi.fn() };
});
vi.mock('../../utils/toast', () => ({ showToast: vi.fn() }));

const mockedApiFetch = vi.mocked(apiFetch);

const MORNING = {
  id: 'show-1',
  studio_id: 'studio-1',
  name: 'Morning News',
  show_code: 'MN',
  title_suffix: 'episode',
  categories: [
    {
      id: 'cat-1',
      name: 'Roll Call',
      color: '#112233',
      type: 'BUTTON',
      dropdown_options: [],
      on_label: '',
      off_label: '',
      auto_instruction: 'Log every roll call',
    },
  ],
  event_palette: ['#111111'],
  event_palette_preset: 'custom',
  event_palette_custom: ['#222222'],
} as unknown as Show;
const EVENING = { ...MORNING, id: 'show-2', name: 'Evening News', show_code: 'EN' } as Show;

function profileAs(
  role: 'owner' | 'admin' | 'member' | null,
  overrides: Partial<ProfilePayload> = {},
): ProfilePayload {
  return {
    active_studio_id: role ? 'studio-1' : '',
    active_show_id: role ? 'show-1' : '',
    active_studio: { id: 'studio-1', name: 'Studio One', categories: [] },
    studios: role ? [{ id: 'studio-1', name: 'Studio One', categories: [] }] : [],
    studio_settings: {},
    shows: role
      ? [MORNING, EVENING].map(({ id, studio_id, name, show_code, title_suffix }) => ({
          id,
          studio_id,
          name,
          show_code,
          title_suffix,
          can_access: true,
        }))
      : [],
    new_session_defaults: { title_prefix: '', default_frame_rate: 24 },
    admin: { restart_supported: false, restart_needs_token: false },
    auth: {
      logged_in: true,
      oauth_configured: true,
      user: {
        email: 'ada@example.com',
        given_name: 'Ada',
        family_name: 'Lovelace',
        teams: role ? [{ id: 'studio-1', name: 'Studio One', role }] : [],
      },
    },
    ...overrides,
  } as unknown as ProfilePayload;
}

let profile: ProfilePayload;
let shows: Show[];
let showsMode: 'ok' | 'error' | 'hang';

function route() {
  mockedApiFetch.mockImplementation(async (path: string, opts?: RequestInit) => {
    const method = opts?.method ?? 'GET';
    if (path === 'profile' && method === 'PUT') return profile;
    if (path === 'profile') return profile;
    if (path === 'shows?studio_id=studio-1') {
      if (showsMode === 'error') throw new Error('Internal error');
      if (showsMode === 'hang') return new Promise(() => {});
      return { shows };
    }
    throw new Error(`unexpected apiFetch: ${method} ${path}`);
  });
}

function Harness({ initial }: { initial: SettingsSectionId }) {
  const [section, setSection] = useState<SettingsSectionId>(initial);
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

function renderSection(initial: SettingsSectionId = 'show-details') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['profile'], profile);
  renderStrict(
    <QueryClientProvider client={client}>
      <Harness initial={initial} />
    </QueryClientProvider>,
  );
  return client;
}

const panel = () => document.getElementById('settings-section-show-details') as HTMLElement;
const inPanel = () => within(panel());
const save = () => inPanel().getByRole('button', { name: /^Save/ });
const putBodies = () =>
  mockedApiFetch.mock.calls
    .filter(([p, o]) => p === 'profile' && o?.method === 'PUT')
    .map(([, o]) => JSON.parse(String(o?.body)) as Record<string, unknown>);

beforeEach(() => {
  mockedApiFetch.mockReset();
  profile = profileAs('owner');
  shows = [MORNING, EVENING];
  showsMode = 'ok';
  route();
});

afterEach(() => {
  act(() => onlineManager.setOnline(true));
});

describe('Settings › Show details: the Suffix control', () => {
  it('renders Suffix immediately after Code, and no Next Ep control exists', async () => {
    renderSection();
    await inPanel().findByLabelText('Show name');
    const labels = Array.from(panel().querySelectorAll('[data-slot="field-label"]')).map(
      (l) => l.textContent,
    );
    expect(labels).toEqual(['Show name', 'Code', 'Suffix']);
    expect(inPanel().queryByText(/Next Ep/i)).toBeNull();
    expect(document.getElementById('profile-show-next-ep')).toBeNull();
    expect(inPanel().queryByRole('button', { name: 'Open previous Settings' })).toBeNull();
  });

  it("hydrates the Suffix from the show's title_suffix", async () => {
    renderSection();
    const group = await inPanel().findByRole('radiogroup', { name: 'Suffix' });
    expect(
      within(group).getByRole('radio', { name: 'Episode Number' }).getAttribute('aria-checked'),
    ).toBe('true');
    expect(within(group).getByRole('radio', { name: 'Date' }).getAttribute('aria-checked')).toBe(
      'false',
    );
  });

  it('offers Date and Episode Number as the only two Suffix options', async () => {
    renderSection();
    const group = await inPanel().findByRole('radiogroup', { name: 'Suffix' });
    expect(
      within(group)
        .getAllByRole('radio')
        .map((r) => r.textContent),
    ).toEqual(['Date', 'Episode Number']);
  });

  it('persists an edited Suffix via show_updates[].title_suffix, with no next_episode key', async () => {
    renderSection();
    const group = await inPanel().findByRole('radiogroup', { name: 'Suffix' });
    fireEvent.click(within(group).getByRole('radio', { name: 'Date' }));
    expect(save().textContent).toBe('Save');
    fireEvent.click(save());

    await waitFor(() => expect(putBodies()).toHaveLength(1));
    const body = putBodies()[0] as { show_updates: Array<Record<string, unknown>> };
    expect(body.show_updates).toHaveLength(1);
    expect(body.show_updates[0].title_suffix).toBe('date');
    expect('next_episode' in body.show_updates[0]).toBe(false);
    await waitFor(() => expect(save().textContent).toBe('Saved'));
  });
});

describe('Settings › Show details: saving', () => {
  it('Saving persists shows whose tab was never visited: a name edit submits the whole show update', async () => {
    renderSection();
    fireEvent.change(await inPanel().findByLabelText('Show name'), {
      target: { value: 'Morning Report' },
    });
    fireEvent.click(save());

    await waitFor(() => expect(putBodies()).toHaveLength(1));
    expect(putBodies()[0]).toEqual({
      active_studio_id: 'studio-1',
      active_show_id: 'show-1',
      show_updates: [
        {
          show_id: 'show-1',
          name: 'Morning Report',
          show_code: 'MN',
          title_suffix: 'episode',
          // Unchanged categories and palette ride along, exactly as an Event buttons visit
          // would have left them (the instruction is trimmed and kept).
          categories: [
            {
              id: 'cat-1',
              name: 'Roll Call',
              color: '#112233',
              type: 'BUTTON',
              dropdown_options: [],
              on_label: '',
              off_label: '',
              auto_instruction: 'Log every roll call',
            },
          ],
          event_palette: expect.any(Array),
          event_palette_preset: 'custom',
          event_palette_custom: expect.any(Array),
        },
      ],
    });
    // Team settings are Team details' write, never this section's.
    expect(putBodies()[0]).not.toHaveProperty('settings');
    // The section returns to its saved state.
    await waitFor(() => expect(save().textContent).toBe('Saved'));
  });

  it('edits the active show, not the first one', async () => {
    profile = profileAs('owner', { active_show_id: 'show-2' });
    renderSection();
    expect(((await inPanel().findByLabelText('Show name')) as HTMLInputElement).value).toBe(
      'Evening News',
    );
    fireEvent.change(inPanel().getByLabelText('Code'), { target: { value: 'en2' } });
    // Codes are upper-cased as typed, as before.
    expect((inPanel().getByLabelText('Code') as HTMLInputElement).value).toBe('EN2');
    fireEvent.click(save());
    await waitFor(() => expect(putBodies()).toHaveLength(1));
    const body = putBodies()[0] as {
      active_show_id: string;
      show_updates: Array<{ show_id: string }>;
    };
    expect(body.active_show_id).toBe('show-2');
    expect(body.show_updates.map((u) => u.show_id)).toEqual(['show-2']);
  });

  it('refetches the session list, events, status, categories and both show caches after a save', async () => {
    const client = renderSection();
    const spy = vi.spyOn(client, 'invalidateQueries');
    fireEvent.change(await inPanel().findByLabelText('Show name'), { target: { value: 'X' } });
    fireEvent.click(save());
    await waitFor(() => expect(save().textContent).toBe('Saved'));
    const keys = spy.mock.calls.map(([f]) => JSON.stringify(f?.queryKey));
    for (const k of [
      ['sessions'],
      ['events'],
      sessionStatusKeys.all(),
      ['show-categories'],
      showKeys.allStudios(),
      showKeys.all(),
    ]) {
      expect(keys).toContain(JSON.stringify(k));
    }
  });
});

describe('Settings › Show details: the shows states', () => {
  it('A failed shows fetch is named and retryable', async () => {
    showsMode = 'error';
    renderSection();
    expect((await inPanel().findByText('Couldn’t load shows.')).textContent).toBe(
      'Couldn’t load shows.',
    );
    expect(inPanel().queryByText('Loading shows…')).toBeNull();
    expect(inPanel().queryByLabelText('Show name')).toBeNull();

    showsMode = 'ok';
    fireEvent.click(inPanel().getByRole('button', { name: 'Retry' }));
    expect(((await inPanel().findByLabelText('Show name')) as HTMLInputElement).value).toBe(
      'Morning News',
    );
    // A retried fetch baselines from scratch: nothing reads dirty.
    expect(save().textContent).toBe('Saved');
  });

  it('An offline hold is not shown as loading, and offers no dead Retry', async () => {
    act(() => onlineManager.setOnline(false));
    renderSection();
    expect(await inPanel().findByText('You’re offline — can’t load shows.')).not.toBeNull();
    expect(
      inPanel().getByText('Shows will load on their own once you’re back online.'),
    ).not.toBeNull();
    expect(inPanel().queryByText('Loading shows…')).toBeNull();
    expect(inPanel().queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('leaves a genuinely in-flight fetch on the loading state, with no Retry', async () => {
    showsMode = 'hang';
    renderSection();
    expect(await inPanel().findByText('Loading shows…')).not.toBeNull();
    expect(inPanel().queryByText('You’re offline — can’t load shows.')).toBeNull();
    expect(inPanel().queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('The account scope is unaffected by an unavailable shows query', async () => {
    showsMode = 'error';
    renderSection('account');
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Grace' } });
    const accountSave = within(
      document.getElementById('settings-section-account') as HTMLElement,
    ).getByRole('button', { name: 'Save' });
    fireEvent.click(accountSave);
    await waitFor(() => expect(putBodies()).toHaveLength(1));
    expect(putBodies()[0].given_name).toBe('Grace');
    expect(putBodies()[0]).not.toHaveProperty('show_updates');
  });

  it('A team-less account sees neither unavailable state', () => {
    profile = profileAs(null);
    renderSection();
    expect(inPanel().queryByText('Couldn’t load shows.')).toBeNull();
    expect(inPanel().queryByText('You’re offline — can’t load shows.')).toBeNull();
    expect(mockedApiFetch.mock.calls.some(([p]) => String(p).startsWith('shows'))).toBe(false);
  });

  it('does not clobber unsaved edits when the shows response is re-delivered', async () => {
    // Ported from the previous Settings dialog's "shows arrive asynchronously" block (10.1).
    const client = renderSection();
    fireEvent.change(await inPanel().findByLabelText('Show name'), {
      target: { value: 'Morning Report' },
    });
    shows = [{ ...MORNING, name: 'Renamed Elsewhere' } as Show, EVENING];
    await act(() => client.refetchQueries());
    expect((inPanel().getByLabelText('Show name') as HTMLInputElement).value).toBe(
      'Morning Report',
    );
    expect(save().textContent).not.toBe('Saved');
  });

  it('says so when the team has no shows yet', async () => {
    shows = [];
    renderSection();
    expect(await inPanel().findByText('No shows yet')).not.toBeNull();
  });
});

describe('Settings › Show details: member view', () => {
  it('a member sees the show’s details disabled under a notice naming their role', async () => {
    profile = profileAs('member');
    renderSection();
    const name = (await inPanel().findByLabelText('Show name')) as HTMLInputElement;
    expect(name.value).toBe('Morning News');
    expect(name.disabled).toBe(true);
    expect((inPanel().getByLabelText('Code') as HTMLInputElement).disabled).toBe(true);
    for (const radio of inPanel().getAllByRole('radio')) {
      expect(radio.hasAttribute('disabled')).toBe(true);
    }
    expect(inPanel().getByRole('status').textContent).toContain('You’re a member of Studio One');
    expect(save().hasAttribute('disabled')).toBe(true);
  });

  it('an admin edits without a notice', async () => {
    profile = profileAs('admin');
    renderSection();
    const name = (await inPanel().findByLabelText('Show name')) as HTMLInputElement;
    expect(name.disabled).toBe(false);
    expect(panel().querySelector('[data-slot="settings-role-notice"]')).toBeNull();
  });
});
