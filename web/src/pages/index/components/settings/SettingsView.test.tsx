import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { createRef, useEffect, useState } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLogEvent } from '../../../../api/hooks/useEvents';
import { useShowCategories } from '../../../../api/hooks/useShowCategories';
import type { AudioSegment, Category } from '../../../../api/types';
import type { AudioClipLite } from '../../../../shared/utils/waveformMerge';
import { renderStrict } from '../../../../test/renderStrict';
import { AudioPlayer, type AudioPlayerHandle } from '../AudioPlayer';
import { CategoryButtonStrip } from '../CategoryButtonStrip';
import { SettingsView } from './SettingsView';
import { type SettingsSectionId, type SettingsState, settingsPanelId } from './sections';

// --- SettingsView shell (redesign-show-ignition 6.1; design D3, D10) ---
//
// The view's own discipline, against the real component: the nav, which sections mount when, the
// discard guard's arming, the modal semantics, and that console hotkeys stay inert beneath it.
// The sections' CONTENT is groups 7-9; here every section is a stub that counts its mounts, so the
// tests observe mounts rather than settled DOM (a transient mount-then-unmount is invisible to a
// DOM assertion). StrictMode may double-invoke a mount effect, so counts are compared against
// baselines rather than pinned to 1. Scenario names follow web-ui-system's deltas ("Settings modal
// defers inactive tab content", "The Settings modal costs nothing while closed", "The Settings view
// is modal to the console"); the closed-cost scenarios that live at the shell's mount gate are in
// AppShell.test.tsx.

const probe = vi.hoisted(() => ({
  mounts: {} as Record<string, number>,
  dirty: {} as Record<string, boolean>,
  discards: {} as Record<string, number>,
  profile: undefined as unknown,
}));

vi.mock('./SettingsSections', async () => {
  const { useSettingsSectionGuard: useGuard } =
    await vi.importActual<typeof import('./settingsGuard')>('./settingsGuard');
  const ids = ['account', 'members', 'shows', 'team-details', 'show-details', 'event-buttons'];
  const make = (id: SettingsSectionId) =>
    function SectionStub() {
      useEffect(() => {
        probe.mounts[id] = (probe.mounts[id] ?? 0) + 1;
      }, []);
      useGuard(id, probe.dirty[id] ?? false, () => {
        probe.discards[id] = (probe.discards[id] ?? 0) + 1;
      });
      return <div data-testid={`section-${id}`}>{id}</div>;
    };
  return {
    SETTINGS_SECTION_CONTENT: Object.fromEntries(
      ids.map((id) => [id, make(id as SettingsSectionId)]),
    ),
  };
});

// The hotkey scenarios mount the real logging strip beside the view.
vi.mock('../../../../api/hooks/useShowCategories', () => ({ useShowCategories: vi.fn() }));
vi.mock('../../../../api/hooks/useEvents', () => ({ useLogEvent: vi.fn() }));
vi.mock('../../../../shared/components/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../../../api/hooks/useProfile', () => ({
  useProfile: () => ({ data: probe.profile }),
}));
// The view owns the shows scope; with no profile its query is disabled (no team, no request).
vi.mock('../../../../api/hooks/useShows', () => ({
  useStudioShows: () => ({ data: undefined, isSuccess: false, isError: false, refetch: vi.fn() }),
}));

const mounts = (id: SettingsSectionId) => probe.mounts[id] ?? 0;

function clickNav(name: string) {
  // Radix Tabs activate on mouse-down (and keyboard focus), not on click.
  fireEvent.mouseDown(screen.getByRole('tab', { name }), { button: 0 });
}

/** The shell's gate, reduced: `settings` state, mounted only while open (AppShell owns the real one). */
function Shell({ initial = null, onClose }: { initial?: SettingsState; onClose?: () => void }) {
  const [settings, setSettings] = useState<SettingsState>(initial);
  return (
    <>
      <button type="button" onClick={() => setSettings({ section: 'show-details' })}>
        Open settings
      </button>
      <button type="button" onClick={() => setSettings({ section: 'members' })}>
        Open members
      </button>
      {settings && (
        <SettingsView
          section={settings.section}
          onSectionChange={(section) => setSettings({ section })}
          onClose={() => {
            onClose?.();
            setSettings(null);
          }}
          onCloseSession={vi.fn()}
          backLabel="Back to session"
        />
      )}
    </>
  );
}

beforeEach(() => {
  probe.mounts = {};
  probe.dirty = {};
  probe.discards = {};
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('Settings modal defers inactive tab content', () => {
  it('Opening the modal mounts only the active tab’s content', () => {
    renderStrict(<Shell initial={{ section: 'show-details' }} />);

    expect(mounts('show-details')).toBeGreaterThan(0);
    for (const id of [
      'account',
      'members',
      'shows',
      'team-details',
      'event-buttons',
    ] as SettingsSectionId[]) {
      expect(mounts(id)).toBe(0);
    }
    // Every navigation control's aria-controls target resolves, mounted or not.
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual([
      'Account',
      'Members',
      'Shows',
      'Team details',
      'Show details',
      'Event buttons',
    ]);
    for (const tab of tabs) {
      const panel = document.getElementById(tab.getAttribute('aria-controls') ?? '');
      expect(panel?.getAttribute('role')).toBe('tabpanel');
      expect(panel?.getAttribute('aria-labelledby')).toBe(tab.id);
      expect(panel?.hasAttribute('hidden')).toBe(tab.getAttribute('aria-selected') !== 'true');
    }
    expect(document.getElementById(settingsPanelId('event-buttons'))?.childElementCount).toBe(0);
  });

  it('the nav is a vertical tablist grouped You › Team › Show', () => {
    renderStrict(<Shell initial={{ section: 'account' }} />);
    const list = screen.getByRole('tablist', { name: 'Settings sections' });
    expect(list.getAttribute('aria-orientation')).toBe('vertical');
    const labels = [...list.querySelectorAll('[data-slot="settings-nav-group"]')].map(
      (g) => g.textContent,
    );
    expect(labels).toEqual(['You', 'Team', 'Show']);
    // No kicker-over-name pairs (finish review fix round 1): without a team or show name the
    // scope word is the heading itself, and no muted scope hint is drawn.
    expect(list.querySelectorAll('[data-slot="settings-nav-scope"]')).toHaveLength(0);
    // The section shows its own heading.
    expect(screen.getByRole('tab', { name: 'Account' }).getAttribute('aria-selected')).toBe('true');
  });

  it('names the team and show as the group headings, with the scope as a muted hint after it', () => {
    probe.profile = {
      studios: [{ id: 'team-1', name: 'Test Team' }],
      active_studio_id: 'team-1',
      shows: [{ id: 'show-1', name: 'Test show', studio_id: 'team-1' }],
      active_show_id: 'show-1',
    };
    try {
      renderStrict(<Shell initial={{ section: 'account' }} />);
      const list = screen.getByRole('tablist', { name: 'Settings sections' });
      const headings = [...list.querySelectorAll('[data-slot="settings-nav-group"]')].map(
        (g) => g.textContent,
      );
      expect(headings).toEqual(['You', 'Test Team', 'Test show']);
      // The scope word follows the name as a hint, never sits above it as a kicker.
      const hints = [...list.querySelectorAll('[data-slot="settings-nav-scope"]')];
      expect(hints.map((h) => h.textContent)).toEqual(['Team', 'Show']);
      for (const hint of hints) {
        const heading = hint.parentElement?.querySelector('[data-slot="settings-nav-group"]');
        expect(
          heading && heading.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
      }
    } finally {
      probe.profile = undefined;
    }
  });

  // Finish review fix round 1: on phones the nav is one horizontally scrolling row of section
  // chips (not a ragged two-column grid), so the section's content starts in the first viewport.
  it('the phone nav is a single scrolling row, not a grid', () => {
    renderStrict(<Shell initial={{ section: 'account' }} />);
    const list = screen.getByRole('tablist', { name: 'Settings sections' });
    expect(list.className).not.toMatch(/grid/);
    expect(list.className).toMatch(/max-md:flex-row/);
    expect(list.className).toMatch(/max-md:overflow-x-auto/);
    for (const tab of screen.getAllByRole('tab')) {
      expect(tab.getAttribute('aria-controls')).toBeTruthy();
    }
  });

  it('keeps the current section chip in view in the phone row', () => {
    const calls: Array<{ el: Element; opts: unknown }> = [];
    const proto = Element.prototype as unknown as { scrollIntoView?: (o?: unknown) => void };
    const original = proto.scrollIntoView;
    proto.scrollIntoView = function (this: Element, opts?: unknown) {
      calls.push({ el: this, opts });
    };
    try {
      renderStrict(<Shell initial={{ section: 'event-buttons' }} />);
      const last = () => calls[calls.length - 1];
      expect(last()?.el).toBe(screen.getByRole('tab', { name: 'Event buttons' }));
      expect(last()?.opts).toEqual({ block: 'nearest', inline: 'nearest' });
      clickNav('Members');
      expect(last()?.el).toBe(screen.getByRole('tab', { name: 'Members' }));
    } finally {
      proto.scrollIntoView = original;
    }
  });

  it('Activating a tab mounts its content and keeps it mounted', () => {
    renderStrict(<Shell initial={{ section: 'show-details' }} />);
    expect(mounts('event-buttons')).toBe(0);

    clickNav('Event buttons');
    expect(mounts('event-buttons')).toBeGreaterThan(0);
    const mounted = mounts('event-buttons');
    expect(screen.getByRole('tab', { name: 'Event buttons' }).getAttribute('aria-selected')).toBe(
      'true',
    );

    clickNav('Show details');
    // Still mounted, hidden, never remounted.
    expect(mounts('event-buttons')).toBe(mounted);
    expect(screen.getByTestId('section-event-buttons')).not.toBeNull();
    expect(document.getElementById(settingsPanelId('event-buttons'))?.hasAttribute('hidden')).toBe(
      true,
    );
  });

  it('arrow keys move through the sections and visit them', async () => {
    renderStrict(<Shell initial={{ section: 'show-details' }} />);
    const current = screen.getByRole('tab', { name: 'Show details' });
    current.focus();
    fireEvent.keyDown(current, { key: 'ArrowDown' });
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Event buttons' }).getAttribute('aria-selected')).toBe(
        'true',
      ),
    );
    expect(mounts('event-buttons')).toBeGreaterThan(0);
  });

  it('Reopening never transiently mounts the previous tab’s content', () => {
    renderStrict(<Shell initial={{ section: 'show-details' }} />);
    clickNav('Event buttons');
    const afterVisit = mounts('event-buttons');
    expect(afterVisit).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Back to session' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open members' }));

    // Zero mounts of Event buttons across close and reopen, not merely absent afterwards.
    expect(mounts('event-buttons')).toBe(afterVisit);
    expect(screen.queryByTestId('section-event-buttons')).toBeNull();
    expect(screen.getByRole('tab', { name: 'Members' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('section-members')).not.toBeNull();
  });

  it('Removed sections are gone', () => {
    renderStrict(<Shell initial={{ section: 'show-details' }} />);
    expect(screen.queryByRole('tab', { name: /auto sync/i })).toBeNull();
    expect(screen.queryByRole('tab', { name: /debug/i })).toBeNull();
    expect(screen.queryByText(/auto sync/i)).toBeNull();
    expect(screen.queryByText(/debug/i)).toBeNull();
  });

  it('Mounting a deferred tab does not arm the discard guard', () => {
    const onClose = vi.fn();
    renderStrict(<Shell initial={{ section: 'show-details' }} onClose={onClose} />);
    clickNav('Event buttons');
    fireEvent.click(screen.getByRole('button', { name: 'Back to session' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('Settings view discard guard (Honest save model in Settings)', () => {
  it('closing with a dirty inline section asks first; keeping edits leaves the view open', async () => {
    probe.dirty['show-details'] = true;
    const onClose = vi.fn();
    renderStrict(<Shell initial={{ section: 'show-details' }} onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: 'Back to session' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm.textContent).toMatch(/Discard/);
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Settings' })).not.toBeNull();
    expect(probe.discards['show-details'] ?? 0).toBe(0);
  });

  it('switching section with a dirty inline section asks; discarding resets it and switches', async () => {
    probe.dirty['show-details'] = true;
    renderStrict(<Shell initial={{ section: 'show-details' }} />);

    clickNav('Account');
    await screen.findByRole('alertdialog');
    // The confirm hides the page from the accessibility tree while it is up.
    expect(
      screen.getByRole('tab', { name: 'Show details', hidden: true }).getAttribute('aria-selected'),
    ).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Account' }).getAttribute('aria-selected')).toBe(
        'true',
      ),
    );
    expect(probe.discards['show-details']).toBeGreaterThan(0);
  });
});

describe('The Settings view is modal to the console', () => {
  it('its root is a modal dialog labelled by its heading, inside the page rather than a portal', () => {
    const { container } = renderStrict(<Shell initial={{ section: 'show-details' }} />);
    const view = screen.getByRole('dialog', { name: 'Settings' });
    expect(view.getAttribute('aria-modal')).toBe('true');
    expect(view.getAttribute('data-slot')).toBe('settings-view');
    expect(container.contains(view)).toBe(true);
    const heading = document.getElementById(view.getAttribute('aria-labelledby') ?? '');
    expect(heading?.textContent).toBe('Settings');
  });

  it('moves focus in on open and returns it to the invoker on close', () => {
    renderStrict(<Shell />);
    const invoker = screen.getByRole('button', { name: 'Open settings' });
    invoker.focus();
    fireEvent.click(invoker);

    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Show details' }));

    fireEvent.click(screen.getByRole('button', { name: 'Back to session' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(invoker);
  });

  it('Escape closes the view, unless another layer already took it', () => {
    const onClose = vi.fn();
    renderStrict(<Shell initial={{ section: 'show-details' }} onClose={onClose} />);

    // A layer above (a menu, a panel) that handled Escape marks it handled.
    const handled = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    handled.preventDefault();
    act(() => {
      document.body.dispatchEvent(handled);
    });
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Show details' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  describe('over a live session', () => {
    beforeAll(() => {
      HTMLMediaElement.prototype.load = () => {};
      HTMLMediaElement.prototype.play = () => Promise.resolve();
      HTMLMediaElement.prototype.pause = () => {};
    });

    const categories: Category[] = [
      {
        id: 'cat-1',
        label: 'Alpha',
        color: '#4488ff',
        type: 'BUTTON',
        dropdown_options: [],
        on_label: '',
        off_label: '',
      },
    ];
    const segment: AudioSegment = {
      id: 'seg-1',
      ordinal: 0,
      recording_ordinal: 0,
      started_at_utc: null,
      ended_at_utc: null,
      mime_type: 'audio/webm',
      url: 'blob:seg-1',
      waveform_peaks: null,
      waveform_db_floor: null,
    };
    const clip: AudioClipLite = {
      segmentId: 'seg-1',
      url: 'blob:seg-1',
      startSec: 0,
      endSec: 10,
      duration: 10,
      missingAudio: false,
    };
    let logEvent: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      logEvent = vi.fn().mockResolvedValue({});
      vi.mocked(useShowCategories).mockReturnValue({
        data: { categories },
        isLoading: false,
      } as unknown as ReturnType<typeof useShowCategories>);
      vi.mocked(useLogEvent).mockReturnValue({
        mutateAsync: logEvent,
      } as unknown as ReturnType<typeof useLogEvent>);
    });

    /** A rolling console (the real 1-9 strip and Space handler) with Settings opened over it. */
    function renderOverRollingSession() {
      const player = createRef<AudioPlayerHandle>();
      renderStrict(
        <>
          <CategoryButtonStrip
            sessionId="sess-live"
            isRolling
            onOffState={new Map()}
            onToggle={vi.fn()}
          />
          <AudioPlayer ref={player} segments={[segment]} clips={[clip]} />
          <Shell />
        </>,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
      return player;
    }

    it('Digits do not log while Settings is open over a live session', () => {
      const player = renderOverRollingSession();
      const nav = screen.getByRole('tab', { name: 'Show details' });
      expect(document.activeElement).toBe(nav);

      fireEvent.keyDown(nav, { key: '1', code: 'Digit1' });
      fireEvent.keyDown(nav, { key: ' ', code: 'Space' });
      // Also with focus nowhere in particular: the view itself is what silences the console.
      fireEvent.keyDown(document.body, { key: '1', code: 'Digit1' });
      fireEvent.keyDown(document.body, { key: ' ', code: 'Space' });

      expect(logEvent).not.toHaveBeenCalled();
      expect(player.current?.isPlaying()).toBe(false);
    });

    it('Hotkeys resume after closing', async () => {
      renderOverRollingSession();
      fireEvent.click(screen.getByRole('button', { name: 'Back to session' }));
      expect(screen.queryByRole('dialog')).toBeNull();

      fireEvent.keyDown(document.body, { key: '1', code: 'Digit1' });
      await waitFor(() => expect(logEvent).toHaveBeenCalledTimes(1));
      expect(logEvent).toHaveBeenCalledWith({ category: 'cat-1', message: 'Alpha' });
    });
  });
});
