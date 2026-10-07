import { describe, expect, it, vi } from 'vitest';
import { showKeys } from '../../../../api/hooks/useShows';
import type { ProfilePayload, Show } from '../../../../api/types';
import {
  activeShowIdForSave,
  invalidateAfterProfileSave,
  pickShowIdForStudio,
  showDraftToUpdate,
  showsUnavailableState,
  showToShowDraft,
} from './settingsModel';

// --- The Settings save model (redesign-show-ignition D4) ---
//
// Ported in task 10.1 from the previous Settings dialog's tests (HomeSettingsModal.test.tsx:
// "category round-trip", "preserves the active show on an account-only save", "offline-paused
// shows fetch", "shows arrive asynchronously"), which exercised these rules through the retired
// dialog. The section tests cover the main paths end to end; these pin the edge cases.

const show = (over: Partial<Show> & { id: string }): Show =>
  ({
    studio_id: 'team-a',
    name: 'Show',
    show_code: 'SH',
    title_suffix: 'date',
    categories: [],
    event_palette: [],
    event_palette_preset: 'custom',
    event_palette_custom: [],
    ...over,
  }) as unknown as Show;

const profile = (over: Partial<ProfilePayload> = {}): ProfilePayload =>
  ({
    active_studio_id: 'team-a',
    active_show_id: 'show-2',
    studios: [{ id: 'team-a', name: 'Team A' }],
    ...over,
  }) as unknown as ProfilePayload;

describe('showToShowDraft → showDraftToUpdate (category round-trip)', () => {
  const source = show({
    id: 'show-1',
    categories: [
      {
        id: 'cat-1',
        name: 'Roll Call',
        color: '#112233',
        type: 'BUTTON',
        dropdown_options: [],
        on_label: '',
        off_label: '',
        auto_instruction: '  Log every roll call  ',
      },
      {
        id: 'cat-2',
        name: 'Camera',
        color: '#223344',
        type: 'DROPDOWN',
        dropdown_options: [
          { label: 'Wide', needs_context: false, auto_instruction: '  When wide  ' },
          { label: 'Close', needs_context: true, auto_instruction: '   ' },
        ],
        on_label: '',
        off_label: '',
        auto_instruction: '   ',
      },
    ],
  } as Partial<Show> & { id: string });

  it('hydrates category names from a name-keyed show', () => {
    expect(showToShowDraft(source).categories.map((c) => c.name)).toEqual(['Roll Call', 'Camera']);
  });

  it('posts categories carrying name, and instructions trimmed or omitted when whitespace-only', () => {
    const update = showDraftToUpdate('show-1', showToShowDraft(source));
    expect(update.show_id).toBe('show-1');
    const [roll, camera] = update.categories ?? [];
    expect(roll).toMatchObject({ id: 'cat-1', name: 'Roll Call' });
    expect(roll.auto_instruction).toBe('Log every roll call');
    expect(camera).toMatchObject({ id: 'cat-2', name: 'Camera' });
    expect(camera).not.toHaveProperty('auto_instruction');
    expect(camera.dropdown_options).toEqual([
      { label: 'Wide', needs_context: false, auto_instruction: 'When wide' },
      { label: 'Close', needs_context: true },
    ]);
  });
});

describe('activeShowIdForSave (an absent show makes the server pick the first)', () => {
  it('sends the selected show once the shows are ready', () => {
    expect(
      activeShowIdForSave(profile(), 'team-a', { ready: true, selectedShowId: 'show-3' }),
    ).toBe('show-3');
  });

  it('omits it for a team that genuinely has no shows', () => {
    expect(
      activeShowIdForSave(profile(), 'team-a', { ready: true, selectedShowId: '' }),
    ).toBeUndefined();
  });

  it('echoes the profile’s show while the shows are loading or unavailable', () => {
    expect(activeShowIdForSave(profile(), 'team-a', { ready: false, selectedShowId: '' })).toBe(
      'show-2',
    );
  });

  it('omits it mid-switch, when the profile’s show belongs to the old team', () => {
    expect(
      activeShowIdForSave(profile(), 'team-b', { ready: false, selectedShowId: '' }),
    ).toBeUndefined();
  });
});

describe('pickShowIdForStudio', () => {
  const shows = [
    show({ id: 'show-1' }),
    show({ id: 'show-2' }),
    show({ id: 'b-1', studio_id: 'team-b' }),
  ];

  it('keeps the profile’s show even when it is not first in the list', () => {
    expect(pickShowIdForStudio(profile(), shows, 'team-a')).toBe('show-2');
  });

  it('picks another team’s first show', () => {
    expect(pickShowIdForStudio(profile(), shows, 'team-b')).toBe('b-1');
  });
});

describe('showsUnavailableState', () => {
  it('names a failed fetch and an offline-paused pending fetch', () => {
    expect(showsUnavailableState({ isError: true }, 'team-a')).toBe('error');
    expect(showsUnavailableState({ isPending: true, fetchStatus: 'paused' }, 'team-a')).toBe(
      'offline',
    );
  });

  it('says nothing about a paused background refetch over shows already on screen', () => {
    expect(showsUnavailableState({ isPending: false, fetchStatus: 'paused' }, 'team-a')).toBeNull();
  });

  it('leaves a genuinely in-flight fetch alone, and a disabled query says nothing', () => {
    expect(
      showsUnavailableState({ isPending: true, fetchStatus: 'fetching' }, 'team-a'),
    ).toBeNull();
    expect(showsUnavailableState({ isError: true }, '')).toBeNull();
  });
});

describe('invalidateAfterProfileSave', () => {
  it('does not invalidate either show cache when the save carried no show_updates', () => {
    const invalidateQueries = vi.fn();
    invalidateAfterProfileSave({ invalidateQueries }, { showUpdates: false });
    const keys = invalidateQueries.mock.calls.map(([f]) => JSON.stringify(f.queryKey));
    expect(keys).toContain(JSON.stringify(['sessions']));
    expect(keys).toContain(JSON.stringify(['show-categories']));
    expect(keys).not.toContain(JSON.stringify(showKeys.allStudios()));
    expect(keys).not.toContain(JSON.stringify(showKeys.all()));
  });
});
