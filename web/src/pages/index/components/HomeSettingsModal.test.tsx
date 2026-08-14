import { fireEvent, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCreateShow, useProfile, useProfileMutation } from '../../../api/hooks/useProfile';
import type { ProfilePayload } from '../../../api/types';
import { renderStrict, StrictWrapper } from '../../../test/renderStrict';
import { HomeSettingsModal } from './HomeSettingsModal';

// --- HomeSettingsModal studio-switch tests (session-deep-links, task 3.3;
// spec: web-session-routing "Studio-switch close path still works") ---
//
// The save handler's studio-switch branch was the sole in-app caller of the
// retired `window.V3_closeSession` global; it now calls the onCloseSession
// prop (AppShell's close handler, which navigates to `/`). These tests pin
// that branch: prop called exactly once on a studio change, not called when
// the studio is unchanged. Profile hooks, react-query, and chrome-heavy
// children (Dialog, Select, FpsSelect, EventButtonsTable) are mocked at the
// module boundary — AppShell.test.tsx covers what the prop does.

vi.mock('../../../api/hooks/useProfile', () => ({
  useProfile: vi.fn(),
  useProfileMutation: vi.fn(),
  useCreateShow: vi.fn(),
}));

// Shared across every `useQueryClient()` call (the component calls the hook fresh each
// render) so tests can pin `invalidateQueries` calls made from any render pass.
//
// `eventButtonsMountCount` is the mount counter for `./EventButtonsTable`
// (settings-modal-mount-cost, task 3.1): the reopen scenario asserts on *mounts*, not
// settled DOM — a transient mount-then-unmount within one close/reopen transition would be
// invisible to any assertion that only inspects the final tree. Incremented from a
// mount-only effect (empty dep array) on the mock component itself, so it counts real
// (re)mounts of the component instance and not ordinary re-renders. Tests render via
// `renderStrict` (`<StrictMode>`), which may double-invoke a mount's effects in dev, so the
// exact increment per mount is not pinned to 1 — tests compare against a baseline captured
// at runtime (before/after a transition) rather than against a hardcoded literal.
// `dialogRenderCount` and `normalizePalette9CallCount` back the "costs nothing while
// closed" tests (settings-modal-mount-cost, task 6.1): the closed-modal DOM is already
// empty either way (the mocked — and the real Radix — Dialog already renders nothing
// when `open` is false), so a DOM assertion alone cannot tell "HomeSettingsModal built a
// full tree and handed it to a closed Dialog that discarded it" apart from "HomeSettingsModal
// returned null and never touched Dialog". These two spies observe the two independent D4
// gates directly: whether Dialog was invoked at all, and whether the hydration path ran.
const {
  invalidateQueriesMock,
  eventButtonsMountCount,
  dialogRenderCount,
  normalizePalette9CallCount,
} = vi.hoisted(() => ({
  invalidateQueriesMock: vi.fn(),
  eventButtonsMountCount: { current: 0 },
  dialogRenderCount: { current: 0 },
  normalizePalette9CallCount: { current: 0 },
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: invalidateQueriesMock }),
}));

vi.mock('../utils/toast', () => ({
  showToast: vi.fn(),
}));

vi.mock('../../../shared/ui/Dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => {
    dialogRenderCount.current += 1;
    return open ? <div role="dialog">{children}</div> : null;
  },
}));

// Wraps the real implementation (not a behavior replacement) purely to count calls —
// `showToShowDraft` (the hydration path exercised by the init effect) is the only caller
// that runs before a Save in these tests, so a nonzero count while closed is a direct
// observable of the init effect having run.
vi.mock('../utils/palette9', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/palette9')>();
  return {
    ...actual,
    normalizePalette9: (arr: string[]) => {
      normalizePalette9CallCount.current += 1;
      return actual.normalizePalette9(arr);
    },
  };
});

// `LazySelect` is the deferred-mount stand-in for `Select` (settings-modal-mount-cost D3,
// widened to the modal's own always-mounted selects). It is a pure mount-cost optimisation
// with the same contract, so both modules share one native-`<select>` stub — these tests
// are about the modal's logic, and the deferral/upgrade behaviour itself is exercised
// against the real component in EventButtonsTable.test.tsx.
vi.mock('./Select', () => ({ Select: selectStub }));
// Resolves to the mocked './Select' above, so `LazySelect` stands in as the same native
// `<select>` — the swap is deliberate and must stay a re-export rather than a second stub,
// or the two would be free to drift apart.
vi.mock('./LazySelect', async () => ({ LazySelect: (await import('./Select')).Select }));

function selectStub(props: {
  id?: string;
  ariaLabel?: string;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  options: { value: string; label: string; disabled?: boolean }[];
}) {
  // A function *declaration*, not a const: `vi.mock` is hoisted above this point, and only
  // a declaration is hoisted with it so the factory can close over the stub.
  return (
    <select
      id={props.id}
      aria-label={props.ariaLabel}
      value={props.value}
      disabled={props.disabled}
      onChange={(e) => props.onChange(e.target.value)}
    >
      {props.options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

vi.mock('./FpsSelect', () => ({ FpsSelect: () => null }));
// Renders the `buttons` prop's names so hydration (D3) is observable; `(blank)` stands in
// for an empty name so a wrongly-blanked hydration is distinguishable from "not rendered".
// The set/clear-instruction buttons drive `onChange` exactly the way the real table's
// instruction editor does (auto-generate-event-logs, task 1.3), so the modal's REAL
// snapshot-comparison dirtiness path is exercised — the mock replaces only the table
// chrome, never the dirtiness derivation.
vi.mock('./EventButtonsTable', () => ({
  EventButtonsTable: ({
    buttons,
    palette,
    palettePreset,
    paletteCustom,
    onChange,
  }: {
    buttons: Array<{ id: string; name: string; auto_instruction: string }>;
    palette: string[];
    palettePreset: string;
    paletteCustom: string[];
    onChange: (
      buttons: Array<{ id: string; name: string; auto_instruction: string }>,
      palette: string[],
      palettePreset: string,
      paletteCustom: string[],
    ) => void;
  }) => {
    // Mount-only effect (empty deps): fires once per real mount of this component instance,
    // not on every re-render — the property the reopen scenario needs.
    useEffect(() => {
      eventButtonsMountCount.current += 1;
    }, []);
    return (
      <ul data-testid="event-buttons-mock">
        {buttons.map((b) => (
          <li key={b.id}>
            {b.name || '(blank)'}
            <button
              type="button"
              onClick={() =>
                onChange(
                  buttons.map((x) =>
                    x.id === b.id ? { ...x, auto_instruction: 'Log every slate call' } : x,
                  ),
                  palette,
                  palettePreset,
                  paletteCustom,
                )
              }
            >
              set-instruction-{b.id}
            </button>
            <button
              type="button"
              onClick={() =>
                onChange(
                  buttons.map((x) => (x.id === b.id ? { ...x, auto_instruction: '' } : x)),
                  palette,
                  palettePreset,
                  paletteCustom,
                )
              }
            >
              clear-instruction-{b.id}
            </button>
            <button
              type="button"
              onClick={() =>
                onChange(
                  buttons.map((x) => (x.id === b.id ? { ...x, auto_instruction: '   ' } : x)),
                  palette,
                  palettePreset,
                  paletteCustom,
                )
              }
            >
              whitespace-instruction-{b.id}
            </button>
          </li>
        ))}
      </ul>
    );
  },
}));

const mockedUseProfile = vi.mocked(useProfile);
const mockedUseProfileMutation = vi.mocked(useProfileMutation);
const mockedUseCreateShow = vi.mocked(useCreateShow);

const profile = {
  active_studio_id: 'studio-1',
  active_show_id: null,
  active_studio: { id: 'studio-1', name: 'Studio One', categories: [] },
  studios: [
    { id: 'studio-1', name: 'Studio One', categories: [] },
    { id: 'studio-2', name: 'Studio Two', categories: [] },
  ],
  studio_settings: {},
  shows: [],
  new_session_defaults: { title_prefix: '', default_frame_rate: 30 },
  admin: { restart_supported: false, restart_needs_token: false },
  auth: { logged_in: false, oauth_configured: true, user: null },
} as unknown as ProfilePayload;

// --- Category round-trip fixtures (teams-settings-nav, task 1.1/1.2) ---
//
// Wire-accurate: `profile.shows[].categories` is the raw stored `CategoryRecord`
// (server: `showApiDict` in `server/src/db/showsStore.ts` passes `categories_json`
// through verbatim) — keyed **`name`**, deliberately with NO `label` key, so a
// `c.label ?? ''` reader blanks it and a `label`-keyed fixture can't paper over the bug.
const showWithCategories = {
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
    },
  ],
  event_palette: [],
  event_palette_preset: 'custom',
  event_palette_custom: [],
};

const profileWithShow = {
  ...profile,
  active_show_id: 'show-1',
  shows: [showWithCategories],
} as unknown as ProfilePayload;

// --- Derived-dirty fixtures (ui-refresh D11) ---
//
// Two studios (so a studio round-trip is observable) with a show on studio-1 (so a draft
// field is editable) and a logged-in user (so an account field is editable).
const secondShow = {
  ...showWithCategories,
  id: 'show-2',
  name: 'Evening News',
  show_code: 'EN',
};

const profileFull = {
  ...profile,
  active_show_id: 'show-1',
  shows: [showWithCategories, secondShow],
  auth: {
    logged_in: true,
    oauth_configured: true,
    user: {
      email: 'ada@example.com',
      given_name: 'Ada',
      family_name: 'Lovelace',
      teams: [],
    },
  },
} as unknown as ProfilePayload;

let mutateAsync: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  eventButtonsMountCount.current = 0;
  dialogRenderCount.current = 0;
  normalizePalette9CallCount.current = 0;
  mutateAsync = vi.fn().mockResolvedValue({});
  mockedUseProfile.mockReturnValue({ data: profile } as unknown as ReturnType<typeof useProfile>);
  mockedUseProfileMutation.mockReturnValue({
    mutateAsync,
    isPending: false,
  } as unknown as ReturnType<typeof useProfileMutation>);
  mockedUseCreateShow.mockReturnValue({
    mutateAsync: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof useCreateShow>);
});

// --- activeTab reset (teams-settings-nav, D1) ---
//
// The modal now survives route changes while open (AppShell mounts it
// unconditionally), so a tab switch can no longer be reset by unmount —
// the reset-on-open effect now resets `activeTab` back to General itself.
describe('HomeSettingsModal activeTab reset on reopen', () => {
  it('reopening after switching tabs starts back on General', () => {
    const { rerender } = renderStrict(
      <HomeSettingsModal isOpen onClose={vi.fn()} onCloseSession={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Event Buttons' }));
    expect(screen.getByRole('tab', { name: 'Event Buttons' }).getAttribute('aria-selected')).toBe(
      'true',
    );

    // Close (isOpen: false) then reopen — no unmount in between (the modal stays mounted
    // across route changes post-lift). `rerender` is re-wrapped in the same
    // `<StrictWrapper>` the initial `renderStrict` call used: passing the bare
    // `<HomeSettingsModal>` element here would change the root element type and make React
    // replace the whole tree (a real unmount+remount, resetting state for free) instead of
    // updating the existing one in place — which would make this test pass even if the
    // production reset logic were removed entirely (settings-modal-mount-cost, task 3.1).
    rerender(
      <StrictWrapper>
        <HomeSettingsModal isOpen={false} onClose={vi.fn()} onCloseSession={vi.fn()} />
      </StrictWrapper>,
    );
    rerender(
      <StrictWrapper>
        <HomeSettingsModal isOpen onClose={vi.fn()} onCloseSession={vi.fn()} />
      </StrictWrapper>,
    );

    expect(screen.getByRole('tab', { name: 'General' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Event Buttons' }).getAttribute('aria-selected')).toBe(
      'false',
    );
  });
});

describe('HomeSettingsModal studio-switch save branch', () => {
  it('calls onCloseSession exactly once when the save changed the active studio', async () => {
    const onCloseSession = vi.fn();
    renderStrict(<HomeSettingsModal isOpen onClose={vi.fn()} onCloseSession={onCloseSession} />);

    // Save starts disabled (D11: derived dirty, nothing edited yet); switching Team is
    // itself the edit that arms it.
    fireEvent.change(screen.getByLabelText('Team'), { target: { value: 'studio-2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0]).toMatchObject({ active_studio_id: 'studio-2' });
    await waitFor(() => expect(onCloseSession).toHaveBeenCalledTimes(1));
  });

  it('does not call onCloseSession when the active studio is unchanged', async () => {
    // ui-refresh D11: Save is disabled until form state diverges from the initialized
    // snapshot, and re-selecting the originally-active studio round-trips back to that
    // snapshot (view-only selection must not read dirty) — so arming Save here without
    // touching the active studio requires a real fixture with an editable show/account field.
    mockedUseProfile.mockReturnValue({
      data: profileFull,
    } as unknown as ReturnType<typeof useProfile>);
    const onCloseSession = vi.fn();
    renderStrict(<HomeSettingsModal isOpen onClose={vi.fn()} onCloseSession={onCloseSession} />);

    fireEvent.change(screen.getByLabelText('Name:'), { target: { value: 'Renamed Show' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0]).toMatchObject({ active_studio_id: 'studio-1' });
    expect(onCloseSession).not.toHaveBeenCalled();
  });
});

// --- Session-list refetch on save (web-coordination-seam, tasks 3.1/3.2) ---
//
// Before this change, the `['sessions']` invalidation on a successful save ran through
// `window.Home_reloadSessionList` — a global only `AppShell`'s mount-once effect ever
// assigned. `AppShell` never mounts in this file (the profile/react-query/chrome
// boundary above is module-mocked), so that global is never defined here and the
// invocation is a silent no-op — this test is necessarily RED against pre-inline code.
// Pinned to the shared query client (the mechanism that survives the handle's removal),
// not to the retired global.
describe('HomeSettingsModal session-list refetch on save', () => {
  it('invalidates the sessions query on a successful save', async () => {
    renderStrict(<HomeSettingsModal isOpen onClose={vi.fn()} onCloseSession={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Team'), { target: { value: 'studio-2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(invalidateQueriesMock).toHaveBeenCalledWith({ queryKey: ['sessions'] }),
    );
  });
});

// --- Derived dirty tracking (ui-refresh D11) ---
//
// Save is disabled + labeled "Saved" until form state diverges from the initialized
// snapshot (comparing current vs. init, NOT a hand-armed per-callsite flag). A round-trip
// back to the initial value (studio/show re-selection) must read clean again.
describe('HomeSettingsModal derived dirty tracking', () => {
  beforeEach(() => {
    mockedUseProfile.mockReturnValue({
      data: profileFull,
    } as unknown as ReturnType<typeof useProfile>);
  });

  it('starts with Save disabled and labeled "Saved"', () => {
    renderStrict(<HomeSettingsModal isOpen onClose={vi.fn()} onCloseSession={vi.fn()} />);

    const save = screen.getByRole('button', { name: 'Saved' });
    expect(save.hasAttribute('disabled')).toBe(true);
  });

  it('editing a draft field (show name) enables Save; a successful save returns it to Saved', async () => {
    renderStrict(<HomeSettingsModal isOpen onClose={vi.fn()} onCloseSession={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Name:'), { target: { value: 'Renamed Show' } });
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save.hasAttribute('disabled')).toBe(false);

    fireEvent.click(save);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Saved' }).hasAttribute('disabled')).toBe(true),
    );
  });

  it('editing an account field (first name) enables Save', () => {
    renderStrict(<HomeSettingsModal isOpen onClose={vi.fn()} onCloseSession={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Grace' } });
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(false);
  });

  it('re-selecting the originally-active studio round-trips back to clean (view-only selection)', () => {
    renderStrict(<HomeSettingsModal isOpen onClose={vi.fn()} onCloseSession={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Team'), { target: { value: 'studio-2' } });
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(false);

    fireEvent.change(screen.getByLabelText('Team'), { target: { value: 'studio-1' } });
    expect(screen.getByRole('button', { name: 'Saved' }).hasAttribute('disabled')).toBe(true);
  });

  it('re-selecting the originally-active show round-trips back to clean (view-only selection)', () => {
    renderStrict(<HomeSettingsModal isOpen onClose={vi.fn()} onCloseSession={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Show to edit'), { target: { value: 'show-2' } });
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(false);

    fireEvent.change(screen.getByLabelText('Show to edit'), { target: { value: 'show-1' } });
    expect(screen.getByRole('button', { name: 'Saved' }).hasAttribute('disabled')).toBe(true);
  });
});

// --- Category round-trip (teams-settings-nav, D3/D4) ---
//
// `showToShowDraft` hydrates from `show.categories`, and `handleSave` posts
// `show_updates[].categories` — both must use the wire key `name`, not `label`.
describe('HomeSettingsModal category round-trip', () => {
  beforeEach(() => {
    mockedUseProfile.mockReturnValue({
      data: profileWithShow,
    } as unknown as ReturnType<typeof useProfile>);
  });

  it('hydrates existing category names (non-blank) from a name-keyed show', () => {
    renderStrict(<HomeSettingsModal isOpen onClose={vi.fn()} onCloseSession={vi.fn()} />);

    fireEvent.click(screen.getByRole('tab', { name: 'Event Buttons' }));

    expect(screen.getByText('Roll Call')).not.toBeNull();
    expect(screen.queryByText('(blank)')).toBeNull();
  });

  it('posts categories whose entries carry name (task 1.1b)', async () => {
    renderStrict(<HomeSettingsModal isOpen onClose={vi.fn()} onCloseSession={vi.fn()} />);

    // ui-refresh D11: Save is disabled until something changed — arm it with a draft edit
    // that doesn't touch the categories under test.
    fireEvent.change(screen.getByLabelText('Name:'), { target: { value: 'Renamed Show' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    const body = mutateAsync.mock.calls[0][0] as {
      show_updates?: Array<{ show_id: string; categories?: unknown[] }>;
    };
    const showUpdate = body.show_updates?.find((u) => u.show_id === 'show-1');
    expect(showUpdate?.categories?.[0]).toEqual({
      id: 'cat-1',
      name: 'Roll Call',
      color: '#112233',
      type: 'BUTTON',
      dropdown_options: [],
      on_label: '',
      off_label: '',
    });
  });

  it('posts button- and option-level auto_instruction through the save mapping (task 1.3)', async () => {
    // Wire-accurate fixture: instruction keys exactly as the server round-trips them —
    // present only when non-empty (`auto_instruction`, category and option level).
    const showWithInstructions = {
      ...showWithCategories,
      categories: [
        { ...showWithCategories.categories[0], auto_instruction: 'Log each roll call' },
        {
          id: 'cat-2',
          name: 'Camera',
          color: '#223344',
          type: 'DROPDOWN',
          dropdown_options: [
            { label: 'Cam A', needs_context: false, auto_instruction: 'When cam A goes live' },
            { label: 'Cam B', needs_context: false },
            // Option-level belt cases (audit M6): a padded instruction must post
            // TRIMMED; a whitespace-only one must post NO key (the server trims
            // and drops empties — posting either verbatim leaves a phantom local
            // value after the post-save rebaseline).
            { label: 'Cam C', needs_context: false, auto_instruction: '  When cam C cuts in  ' },
            { label: 'Cam D', needs_context: true, auto_instruction: '   ' },
          ],
          on_label: '',
          off_label: '',
        },
      ],
    };
    mockedUseProfile.mockReturnValue({
      data: { ...profileWithShow, shows: [showWithInstructions] },
    } as unknown as ReturnType<typeof useProfile>);
    renderStrict(<HomeSettingsModal isOpen onClose={vi.fn()} onCloseSession={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Name:'), { target: { value: 'Renamed Show' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    const body = mutateAsync.mock.calls[0][0] as {
      show_updates?: Array<{ show_id: string; categories?: Array<Record<string, unknown>> }>;
    };
    const cats = body.show_updates?.find((u) => u.show_id === 'show-1')?.categories ?? [];
    expect(cats[0]).toEqual({
      id: 'cat-1',
      name: 'Roll Call',
      color: '#112233',
      type: 'BUTTON',
      dropdown_options: [],
      on_label: '',
      off_label: '',
      auto_instruction: 'Log each roll call',
    });
    expect(cats[1]).toEqual({
      id: 'cat-2',
      name: 'Camera',
      color: '#223344',
      type: 'DROPDOWN',
      dropdown_options: [
        { label: 'Cam A', needs_context: false, auto_instruction: 'When cam A goes live' },
        { label: 'Cam B', needs_context: false },
        // Padded posts trimmed; whitespace-only posts no key (option-level belt,
        // audit M6 — same trim gate as the category level).
        { label: 'Cam C', needs_context: false, auto_instruction: 'When cam C cuts in' },
        { label: 'Cam D', needs_context: true },
      ],
      on_label: '',
      off_label: '',
    });
    // Option-only category: no button-level key on the wire (empty means absent).
    expect('auto_instruction' in cats[1]).toBe(false);
    expect('auto_instruction' in (cats[1].dropdown_options as object[])[0]).toBe(true);
    expect('auto_instruction' in (cats[1].dropdown_options as object[])[3]).toBe(false);
  });

  it('a whitespace-only instruction draft posts no auto_instruction key (trim gate matches the server)', async () => {
    // Server normalization trims and drops empty instructions: gating the wire key
    // on truthiness alone would post a key the server drops, leaving a phantom
    // local value after the post-save rebaseline. The save mapping must gate on
    // trim() — whitespace-only means absent.
    renderStrict(<HomeSettingsModal isOpen onClose={vi.fn()} onCloseSession={vi.fn()} />);

    fireEvent.click(screen.getByRole('tab', { name: 'Event Buttons' }));
    fireEvent.click(screen.getByRole('button', { name: 'whitespace-instruction-cat-1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    const body = mutateAsync.mock.calls[0][0] as {
      show_updates?: Array<{ show_id: string; categories?: Array<Record<string, unknown>> }>;
    };
    const cats = body.show_updates?.find((u) => u.show_id === 'show-1')?.categories ?? [];
    expect('auto_instruction' in cats[0]).toBe(false);
  });

  it('an instruction edit arms Save via the snapshot comparison, and clearing it round-trips clean', () => {
    renderStrict(<HomeSettingsModal isOpen onClose={vi.fn()} onCloseSession={vi.fn()} />);

    fireEvent.click(screen.getByRole('tab', { name: 'Event Buttons' }));
    expect(screen.getByRole('button', { name: 'Saved' }).hasAttribute('disabled')).toBe(true);

    // The mocked table drives the same onChange the real instruction editor calls.
    fireEvent.click(screen.getByRole('button', { name: 'set-instruction-cat-1' }));
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(false);

    // Round-trip back to the hydrated value ('' — no instruction on the fixture): the
    // DERIVED snapshot comparison must read clean again, which a hand-armed dirty
    // flag could not do (ui-refresh D11).
    fireEvent.click(screen.getByRole('button', { name: 'clear-instruction-cat-1' }));
    expect(screen.getByRole('button', { name: 'Saved' }).hasAttribute('disabled')).toBe(true);
  });

  it('invalidates the show-categories query on save (D4)', async () => {
    renderStrict(<HomeSettingsModal isOpen onClose={vi.fn()} onCloseSession={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Name:'), { target: { value: 'Renamed Show' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(invalidateQueriesMock).toHaveBeenCalledWith({ queryKey: ['show-categories'] }),
    );
  });
});

// --- Suffix control (session-title-suffix, task 2.1) ---
//
// Replaces the removed Next Ep counter control. `showWithCategories` carries
// `title_suffix: 'episode'`, matching the migration default for pre-existing
// shows (design D7).
describe('HomeSettingsModal Suffix control', () => {
  beforeEach(() => {
    mockedUseProfile.mockReturnValue({
      data: profileWithShow,
    } as unknown as ReturnType<typeof useProfile>);
  });

  it('renders the Suffix select immediately after Code, and no Next Ep control exists', () => {
    renderStrict(<HomeSettingsModal isOpen onClose={vi.fn()} onCloseSession={vi.fn()} />);

    const fieldsRow = document.getElementById('profile-show-fields');
    const labels = Array.from(fieldsRow?.querySelectorAll('label') ?? []).map(
      (l) => l.querySelector('span')?.textContent,
    );
    expect(labels).toEqual(['Name:', 'Code:', 'Suffix:', 'Default Frame Rate:']);

    expect(screen.queryByText('Next Ep:')).toBeNull();
    expect(document.getElementById('profile-show-next-ep')).toBeNull();
  });

  it("hydrates the Suffix select from the show's title_suffix", () => {
    renderStrict(<HomeSettingsModal isOpen onClose={vi.fn()} onCloseSession={vi.fn()} />);

    expect((screen.getByLabelText('Suffix') as HTMLSelectElement).value).toBe('episode');
  });

  it('offers Date and Episode Number as the only two Suffix options', () => {
    renderStrict(<HomeSettingsModal isOpen onClose={vi.fn()} onCloseSession={vi.fn()} />);

    const select = screen.getByLabelText('Suffix') as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => ({
      value: o.value,
      label: o.textContent,
    }));
    expect(options).toEqual([
      { value: 'date', label: 'Date' },
      { value: 'episode', label: 'Episode Number' },
    ]);
  });

  it('persists an edited Suffix via show_updates[].title_suffix, with no next_episode key on the wire', async () => {
    renderStrict(<HomeSettingsModal isOpen onClose={vi.fn()} onCloseSession={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Suffix'), { target: { value: 'date' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    const body = mutateAsync.mock.calls[0][0] as {
      show_updates?: Array<{ show_id: string; title_suffix?: string }>;
    };
    const showUpdate = body.show_updates?.find((u) => u.show_id === 'show-1');
    expect(showUpdate?.title_suffix).toBe('date');
    expect(showUpdate && 'next_episode' in showUpdate).toBe(false);
  });
});

// --- Deferred tab content (settings-modal-mount-cost, task 3.1) ---
//
// Spec: "Settings modal defers inactive tab content". `profileFull` gives the modal a real
// show on the active studio, so `currentDraft` is truthy and the Event Buttons panel would
// (pre-deferral) mount `EventButtonsTable` immediately regardless of `activeTab`. The mount
// counter (above) distinguishes a genuine (re)mount from an ordinary re-render, which a
// settled-DOM assertion alone cannot: a reset applied one commit late would mount the table
// and then unmount it within the same reopen transition, invisible to any check that only
// runs after things settle.
describe('HomeSettingsModal defers inactive tab content', () => {
  beforeEach(() => {
    mockedUseProfile.mockReturnValue({
      data: profileFull,
    } as unknown as ReturnType<typeof useProfile>);
  });

  it('opening mounts only General’s content while all four aria-controls targets resolve', () => {
    renderStrict(<HomeSettingsModal isOpen onClose={vi.fn()} onCloseSession={vi.fn()} />);

    // Event Buttons content (the mocked table) has not mounted.
    expect(eventButtonsMountCount.current).toBe(0);
    // General's own content mounted.
    expect(screen.getByLabelText('Name:')).not.toBeNull();
    // Every tab's aria-controls target resolves to a present element regardless of whether
    // that panel's content has mounted.
    for (const id of ['general', 'event-buttons', 'autosync', 'debug']) {
      expect(document.getElementById(`v6-settings-section-${id}`)).not.toBeNull();
    }
  });

  it('activating Event Buttons mounts it and switching back keeps it mounted', () => {
    renderStrict(<HomeSettingsModal isOpen onClose={vi.fn()} onCloseSession={vi.fn()} />);
    expect(eventButtonsMountCount.current).toBe(0);

    fireEvent.click(screen.getByRole('tab', { name: 'Event Buttons' }));
    // A real mount happened (StrictMode may double-invoke the mount effect, so the exact
    // count is not pinned to 1 — what matters is that it moved off zero, and stays put).
    expect(eventButtonsMountCount.current).toBeGreaterThan(0);
    const mountedCount = eventButtonsMountCount.current;
    expect(screen.getByTestId('event-buttons-mock')).not.toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'General' }));
    // Switching away and back does not remount it.
    expect(eventButtonsMountCount.current).toBe(mountedCount);
    expect(screen.getByTestId('event-buttons-mock')).not.toBeNull();
  });

  it('close-then-reopen records zero mounts of the panel content across the transition', () => {
    const { rerender } = renderStrict(
      <HomeSettingsModal isOpen onClose={vi.fn()} onCloseSession={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Event Buttons' }));
    const mountedAfterActivation = eventButtonsMountCount.current;
    expect(mountedAfterActivation).toBeGreaterThan(0);

    // Close, then reopen — no unmount of HomeSettingsModal itself in between (AppShell
    // mounts it unconditionally); this is the reopen transition the spec's tripwire
    // scenario targets. `rerender` must be re-wrapped in the same `<StrictWrapper>` used by
    // the initial `renderStrict` call, not passed the bare `<HomeSettingsModal>` element —
    // rerendering with a different root element type than the container was created with
    // makes React replace the whole tree (a real unmount+remount) instead of updating the
    // existing one in place, which would reset all local state for free and mask the very
    // bug this test exists to catch. The count must not move at any point during the
    // transition: a reset applied one commit late (in the passive `isOpen` effect) would
    // commit the stale Event-Buttons-active tab first — mounting the table — and only
    // unmount it on a later commit once the effect fires, which this single before/after
    // comparison catches either way (it counts mounts, not renders after settling).
    rerender(
      <StrictWrapper>
        <HomeSettingsModal isOpen={false} onClose={vi.fn()} onCloseSession={vi.fn()} />
      </StrictWrapper>,
    );
    rerender(
      <StrictWrapper>
        <HomeSettingsModal isOpen onClose={vi.fn()} onCloseSession={vi.fn()} />
      </StrictWrapper>,
    );

    expect(eventButtonsMountCount.current).toBe(mountedAfterActivation);
    // Settled state: back on General, Event Buttons content unmounted.
    expect(screen.getByRole('tab', { name: 'General' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByTestId('event-buttons-mock')).toBeNull();
  });

  it('editing General and saving without ever activating Event Buttons still submits the same show_updates', async () => {
    mockedUseProfile.mockReturnValue({
      data: profileWithShow,
    } as unknown as ReturnType<typeof useProfile>);
    renderStrict(<HomeSettingsModal isOpen onClose={vi.fn()} onCloseSession={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Name:'), { target: { value: 'Renamed Show' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    // The Event Buttons tab was never activated, so its content never mounted — the save
    // still reads the show's categories from the modal's own `showDrafts` state.
    expect(eventButtonsMountCount.current).toBe(0);
    const body = mutateAsync.mock.calls[0][0] as {
      show_updates?: Array<{ show_id: string; categories?: unknown[] }>;
    };
    const showUpdate = body.show_updates?.find((u) => u.show_id === 'show-1');
    expect(showUpdate?.categories?.[0]).toEqual({
      id: 'cat-1',
      name: 'Roll Call',
      color: '#112233',
      type: 'BUTTON',
      dropdown_options: [],
      on_label: '',
      off_label: '',
    });
  });

  it('activating Event Buttons, editing nothing, and closing raises no discard confirmation', () => {
    const onClose = vi.fn();
    renderStrict(<HomeSettingsModal isOpen onClose={onClose} onCloseSession={vi.fn()} />);

    fireEvent.click(screen.getByRole('tab', { name: 'Event Buttons' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('You have unsaved settings changes. Discard them?')).toBeNull();
  });
});

// --- Costs nothing while closed (settings-modal-mount-cost, task 6.1) ---
//
// Spec: "The Settings modal costs nothing while closed" (design D4). Two independent
// gates: the init effect must not hydrate drafts behind a closed dialog (today its guard
// is `!profile || initialized`, with no `isOpen` check, so it fires the moment `useProfile`
// resolves regardless of open state), and the component must return `null` while closed
// instead of building the full tree and handing it to Dialog to discard. Both costs are
// invisible to a plain DOM assertion — the mocked Dialog (matching real Radix, which uses
// no `forceMount`) already renders nothing while closed either way — so these tests spy on
// two collaborators that are only reachable through the wasted work.
describe('HomeSettingsModal costs nothing while closed', () => {
  beforeEach(() => {
    mockedUseProfile.mockReturnValue({
      data: profileWithShow,
    } as unknown as ReturnType<typeof useProfile>);
  });

  it('does not hydrate drafts or initialise form state while closed', () => {
    renderStrict(<HomeSettingsModal isOpen={false} onClose={vi.fn()} onCloseSession={vi.fn()} />);

    // showToShowDraft (the hydration path the init effect drives) is the only caller of
    // normalizePalette9 exercised by this test — it must not have run at all behind a
    // closed modal.
    expect(normalizePalette9CallCount.current).toBe(0);
  });

  it('hydrates exactly once, on first open, even when the profile resolved while closed', () => {
    const { rerender } = renderStrict(
      <HomeSettingsModal isOpen={false} onClose={vi.fn()} onCloseSession={vi.fn()} />,
    );
    expect(normalizePalette9CallCount.current).toBe(0);

    rerender(
      <StrictWrapper>
        <HomeSettingsModal isOpen onClose={vi.fn()} onCloseSession={vi.fn()} />
      </StrictWrapper>,
    );

    // One hydration pass over the fixture's single show: normalizePalette9 called twice
    // (event_palette, event_palette_custom). Before the fix this ran once behind the
    // closed dialog and again on open, for 4 calls.
    expect(normalizePalette9CallCount.current).toBe(2);
    expect(screen.getByLabelText('Name:')).not.toBeNull();
  });

  it('a closed modal renders nothing', () => {
    const { container } = renderStrict(
      <HomeSettingsModal isOpen={false} onClose={vi.fn()} onCloseSession={vi.fn()} />,
    );

    expect(container.innerHTML).toBe('');
    // The Dialog primitive is never invoked while closed — HomeSettingsModal returns null
    // itself instead of rendering <Dialog open={false}>{fullTree}</Dialog> and relying on
    // Dialog to discard the tree it was handed.
    expect(dialogRenderCount.current).toBe(0);
  });

  it('opening still yields a fully-initialised modal on the General tab, and it survives an unrelated re-render while open', () => {
    const { rerender } = renderStrict(
      <HomeSettingsModal isOpen onClose={vi.fn()} onCloseSession={vi.fn()} />,
    );

    expect(screen.getByRole('tab', { name: 'General' }).getAttribute('aria-selected')).toBe('true');
    expect((screen.getByLabelText('Name:') as HTMLInputElement).value).toBe('Morning News');

    // Simulate the modal surviving a route change while open (teams-settings-nav, D1):
    // AppShell mounts it unconditionally, so a route change re-renders the shell with the
    // same isOpen=true prop rather than unmounting the modal.
    rerender(
      <StrictWrapper>
        <HomeSettingsModal isOpen onClose={vi.fn()} onCloseSession={vi.fn()} />
      </StrictWrapper>,
    );

    expect(screen.getByRole('tab', { name: 'General' }).getAttribute('aria-selected')).toBe('true');
    expect((screen.getByLabelText('Name:') as HTMLInputElement).value).toBe('Morning News');
  });
});
