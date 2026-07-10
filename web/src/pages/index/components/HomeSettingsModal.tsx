import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useEffect, useState } from 'react';
import { useCreateShow, useProfile, useProfileMutation } from '../../../api/hooks/useProfile';
import type { ProfilePayload, Show } from '../../../api/types';
import { Dialog } from '../../../shared/ui/Dialog';
import { showToast } from '../utils/toast';
import type { EventButtonDraft } from './EventButtonsTable';
import { EventButtonsTable } from './EventButtonsTable';
import { FpsSelect } from './FpsSelect';
import styles from './HomeSettingsModal.module.css';
import { Select } from './Select';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

interface ShowDraft {
  name: string;
  show_code: string;
  next_episode: number;
  categories: EventButtonDraft[];
  event_palette: string[];
  event_palette_preset: string;
  event_palette_custom: string[];
}

type TabId = 'general' | 'event-buttons' | 'autosync' | 'debug';

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizePalette9(arr: string[]): string[] {
  const defaults = [
    '#64748b',
    '#e53935',
    '#fb8c00',
    '#fdd835',
    '#43a047',
    '#00acc1',
    '#1e88e5',
    '#8e24aa',
    '#ec407a',
  ];
  const out: string[] = [];
  for (let i = 0; i < 9; i++) {
    const h = (arr[i] ?? '').toLowerCase();
    out.push(/^#[0-9a-f]{6}$/.test(h) ? h : defaults[i % defaults.length]);
  }
  return out;
}

function showToShowDraft(show: Show): ShowDraft {
  const palette = normalizePalette9(show.event_palette ?? []);
  const custom = normalizePalette9(
    show.event_palette_custom?.length ? show.event_palette_custom : palette,
  );
  return {
    name: show.name ?? '',
    show_code: show.show_code ?? '',
    next_episode: show.next_episode ?? 1,
    categories: (show.categories ?? []).map((c) => ({
      id: c.id,
      name: c.label ?? '',
      type: c.type,
      color: c.color,
      dropdown_options: c.dropdown_options ?? [],
      on_label: c.on_label ?? '',
      off_label: c.off_label ?? '',
    })),
    event_palette: palette,
    event_palette_preset: show.event_palette_preset ?? 'custom',
    event_palette_custom: custom,
  };
}

function initDraftsForStudio(shows: Show[], studioId: string): Record<string, ShowDraft> {
  const result: Record<string, ShowDraft> = {};
  for (const s of shows) {
    if (s.studio_id === studioId) {
      result[s.id] = showToShowDraft(s);
    }
  }
  return result;
}

function getDefaultFps(profile: ProfilePayload, studioId: string): number {
  const s = (profile.studio_settings?.[studioId] ?? {}) as { default_frame_rate?: number };
  return typeof s.default_frame_rate === 'number' ? s.default_frame_rate : 24;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function HomeSettingsModal({ isOpen, onClose }: Props) {
  const { data: profile } = useProfile();
  const mutation = useProfileMutation();
  const createShow = useCreateShow();
  const queryClient = useQueryClient();

  const [activeTab, setActiveTab] = useState<TabId>('general');
  const [activeStudioId, setActiveStudioId] = useState('');
  const [activeShowId, setActiveShowId] = useState('');
  const [defaultFps, setDefaultFps] = useState(24);
  const [showDrafts, setShowDrafts] = useState<Record<string, ShowDraft>>({});
  const [givenName, setGivenName] = useState('');
  const [familyName, setFamilyName] = useState('');

  const [initialized, setInitialized] = useState(false);

  // Reset form each time modal opens so stale drafts don't linger
  useEffect(() => {
    if (isOpen) setInitialized(false);
  }, [isOpen]);

  // Initialise form once when profile first loads (or after reset above)
  useEffect(() => {
    if (!profile || initialized) return;
    const sid = profile.active_studio_id ?? profile.studios[0]?.id ?? '';
    setActiveStudioId(sid);
    setDefaultFps(getDefaultFps(profile, sid));
    setShowDrafts(initDraftsForStudio(profile.shows, sid));
    const showsForStudio = profile.shows.filter((s) => s.studio_id === sid);
    const preferredShow =
      showsForStudio.find((s) => s.id === profile.active_show_id) ?? showsForStudio[0];
    setActiveShowId(preferredShow?.id ?? '');
    if (profile.auth.user) {
      setGivenName(profile.auth.user.given_name ?? '');
      setFamilyName(profile.auth.user.family_name ?? '');
    }
    setInitialized(true);
  }, [profile, initialized]);

  function handleStudioChange(studioId: string) {
    if (!profile) return;
    setActiveStudioId(studioId);
    setDefaultFps(getDefaultFps(profile, studioId));
    const drafts = initDraftsForStudio(profile.shows, studioId);
    setShowDrafts(drafts);
    const showsForStudio = profile.shows.filter((s) => s.studio_id === studioId);
    setActiveShowId(showsForStudio[0]?.id ?? '');
  }

  const showsForStudio = (profile?.shows ?? []).filter((s) => s.studio_id === activeStudioId);
  const currentDraft = activeShowId ? showDrafts[activeShowId] : undefined;
  const otherShows = showsForStudio.filter((s) => s.id !== activeShowId);

  function updateShowDraft(patch: Partial<ShowDraft>) {
    if (!activeShowId) return;
    setShowDrafts((prev) => ({
      ...prev,
      [activeShowId]: { ...prev[activeShowId], ...patch },
    }));
  }

  async function handleSave() {
    if (!profile) return;
    const prevStudioId = profile.active_studio_id;

    // Preserve existing studio settings, only update default_frame_rate
    const existingSettings = (profile.studio_settings?.[activeStudioId] ?? {}) as Record<
      string,
      unknown
    >;
    const settings = { ...existingSettings, default_frame_rate: defaultFps };

    const show_updates = showsForStudio
      .map((s) => {
        const draft = showDrafts[s.id];
        if (!draft) return null;
        return {
          show_id: s.id,
          name: draft.name,
          show_code: draft.show_code,
          next_episode: draft.next_episode,
          categories: draft.categories.map((c) => ({
            id: c.id,
            label: c.name,
            color: c.color,
            type: c.type,
            dropdown_options: c.dropdown_options,
            on_label: c.on_label,
            off_label: c.off_label,
          })),
          event_palette: normalizePalette9(draft.event_palette),
          event_palette_preset: draft.event_palette_preset,
          event_palette_custom: normalizePalette9(draft.event_palette_custom),
        };
      })
      .filter((x) => x !== null);

    const body: Parameters<typeof mutation.mutateAsync>[0] = {
      active_studio_id: activeStudioId,
      active_show_id: activeShowId || undefined,
      settings,
      show_updates: show_updates.length ? show_updates : undefined,
    };

    if (profile.auth.logged_in) {
      body.given_name = givenName.trim();
      body.family_name = familyName.trim();
    }

    try {
      await mutation.mutateAsync(body);
      showToast('Saved.');
      if (activeStudioId !== prevStudioId) {
        window.V3_closeSession?.();
      }
      window.Home_reloadSessionList?.();
      queryClient.invalidateQueries({ queryKey: ['events'] });
      queryClient.invalidateQueries({ queryKey: ['session-status'] });
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Save failed.', true);
    }
  }

  async function handleAddShow() {
    if (!profile || !activeStudioId) return;
    const name = window.prompt('Show name (you can update the code after):')?.trim();
    if (!name) return;
    try {
      const { show } = await createShow.mutateAsync({ studio_id: activeStudioId, name });
      const draft = showToShowDraft(show as Show);
      setShowDrafts((prev) => ({ ...prev, [show.id]: draft }));
      setActiveShowId(show.id);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not create show.', true);
    }
  }

  const tabs: { id: TabId; label: string }[] = [
    { id: 'general', label: 'General' },
    { id: 'event-buttons', label: 'Event Buttons' },
    { id: 'autosync', label: 'Auto Sync' },
    { id: 'debug', label: 'Debug' },
  ];

  const currentInitials = currentDraft?.name
    .trim()
    .split(/\s+/)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
  const showAcronymWarn =
    currentDraft?.name.trim() &&
    currentDraft.show_code.trim() &&
    currentDraft.show_code.trim().toUpperCase() !== currentInitials;

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(o) => !o && onClose()}
      // Desktop full-screen override. `md:!` reclaims the top/left/transform/size/padding
      // that Dialog's base utilities now own (legacy .settingsDialog would lose to them);
      // md-scoped so the ≤767px bottom-sheet is untouched.
      // On mobile the legacy .settingsDialog height/max-height (calc(100vh-2rem)) used to
      // win over the sheet base max-height (88dvh) by bundle order — now the sheet's
      // max-h-[88dvh] utility would beat it, shrinking the sheet. Re-assert the taller box
      // for ≤767px so the baseline sheet height is preserved (`max-md:!`).
      className={clsx(
        styles.settingsDialog,
        'md:!inset-4 md:!top-4 md:!left-4 md:![transform:none] md:!h-[calc(100vh-2rem)] md:!max-h-[calc(100vh-2rem)] md:!w-[calc(100vw-2rem)] md:!max-w-none md:!flex md:!flex-col md:!px-5 md:!pt-4 md:!pb-5',
        'max-md:!h-[calc(100vh-2rem)] max-md:!max-h-[calc(100vh-2rem)] max-md:!px-5 max-md:!pt-4 max-md:!pb-5',
      )}
      hideTitle
      title="Settings"
    >
      {/* Header toolbar */}
      <div className={styles.toolbar}>
        <div className={styles.toolbarMain}>
          <h2 id="modal-app-settings-title" className={styles.toolbarTitle}>
            Settings
          </h2>
          <div className={styles.toolbarSelects}>
            {/* Studio selector */}
            <Select
              id="profile-studio-select"
              className={styles.teamSelect}
              ariaLabel="Team"
              value={activeStudioId}
              onChange={handleStudioChange}
              options={(profile?.studios ?? []).map((s) => ({ value: s.id, label: s.name }))}
            />
            {/* Show selector */}
            <Select
              id="profile-show-select"
              className={styles.showSelect}
              ariaLabel="Show to edit"
              value={activeShowId}
              onChange={setActiveShowId}
              options={
                showsForStudio.length === 0
                  ? [{ value: '', label: '— No shows —', disabled: true }]
                  : showsForStudio.map((s) => ({
                      value: s.id,
                      label: s.name || s.show_code || s.id,
                    }))
              }
              disabled={showsForStudio.length === 0}
            />
          </div>
        </div>
        <div className={styles.toolbarActions}>
          <button
            type="button"
            className="btn primary"
            id="profile-save"
            disabled={mutation.isPending}
            onClick={handleSave}
          >
            {mutation.isPending ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            className={clsx('btn', styles.toolbarClose)}
            aria-label="Close"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>

      {/* Tabs + content */}
      <section className={styles.settingsPanel}>
        <div className={styles.options} role="tablist" aria-label="Settings sections">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`v6-settings-tab-${tab.id}`}
              className={clsx(styles.option, activeTab === tab.id && styles.optionActive)}
              aria-selected={activeTab === tab.id}
              aria-controls={`v6-settings-section-${tab.id}`}
              tabIndex={activeTab === tab.id ? 0 : -1}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* General tab */}
        <div
          id="v6-settings-section-general"
          className={styles.section}
          role="tabpanel"
          aria-labelledby="v6-settings-tab-general"
          hidden={activeTab !== 'general'}
        >
          {/* Show details */}
          {currentDraft ? (
            <div
              id="profile-show-fields"
              className={clsx('admin-settings-block', styles.profileShowFields)}
            >
              <div className={styles.profileShowFieldsHead}>
                <h2 className="settings-subheading">Show Details</h2>
              </div>
              <div className={styles.profileShowFieldsRow}>
                <label className={clsx('field', styles.profileShowField)}>
                  <span>Name:</span>
                  <input
                    type="text"
                    id="profile-show-name"
                    className="profile-select"
                    maxLength={200}
                    autoComplete="off"
                    value={currentDraft.name}
                    onChange={(e) => updateShowDraft({ name: e.target.value })}
                  />
                </label>
                <label
                  className={clsx('field', styles.profileShowField, styles.profileShowFieldCode)}
                >
                  <span>Code:</span>
                  <input
                    type="text"
                    id="profile-show-code"
                    className="profile-select mono"
                    maxLength={40}
                    autoComplete="off"
                    spellCheck={false}
                    value={currentDraft.show_code}
                    onChange={(e) => updateShowDraft({ show_code: e.target.value.toUpperCase() })}
                  />
                </label>
                <label
                  className={clsx('field', styles.profileShowField, styles.profileShowFieldNextEp)}
                >
                  <span>Next Ep:</span>
                  <input
                    type="number"
                    id="profile-show-next-ep"
                    className="profile-select"
                    min={1}
                    max={999999}
                    step={1}
                    value={currentDraft.next_episode}
                    onChange={(e) =>
                      updateShowDraft({
                        next_episode: Math.max(1, Number.parseInt(e.target.value, 10) || 1),
                      })
                    }
                  />
                </label>
                <label
                  className={clsx('field', styles.profileShowField, styles.profileShowFieldFps)}
                  htmlFor="profile-default-fps"
                >
                  <span>Default Frame Rate:</span>
                  <FpsSelect id="profile-default-fps" value={defaultFps} onChange={setDefaultFps} />
                </label>
              </div>
              {showAcronymWarn && (
                <p className="modal-hint" id="profile-show-acronym-warn">
                  Tip: show code is usually initials of the show name (e.g.{' '}
                  {currentDraft.name.trim()} &rarr;{' '}
                  {currentDraft.name
                    .trim()
                    .split(/\s+/)
                    .map((w) => w[0]?.toUpperCase() ?? '')
                    .join('')}
                  ). Yours differs — that is fine if intentional.
                </p>
              )}
            </div>
          ) : (
            <p className="modal-hint muted" style={{ marginBottom: '0.75rem' }}>
              {showsForStudio.length === 0
                ? 'No shows for this team yet. Add one below.'
                : 'Select a show above to view details.'}
            </p>
          )}

          {/* Account section */}
          {profile?.auth.logged_in && profile.auth.user && (
            <div id="v6-settings-account" className={clsx('admin-settings-block', styles.account)}>
              <div className={styles.profileShowFieldsHead}>
                <h2 className="settings-subheading">Account</h2>
              </div>
              <div className={styles.profileShowFieldsRow}>
                <label className={clsx('field', styles.profileShowField)}>
                  <span>Account</span>
                  <input
                    type="email"
                    id="profile-account-email"
                    className="profile-select"
                    disabled
                    autoComplete="username"
                    value={profile.auth.user.email}
                    readOnly
                  />
                </label>
                <label className={clsx('field', styles.profileShowField)}>
                  <span>First name</span>
                  <input
                    type="text"
                    id="profile-account-given"
                    className="profile-select"
                    maxLength={200}
                    autoComplete="given-name"
                    value={givenName}
                    onChange={(e) => setGivenName(e.target.value)}
                  />
                </label>
                <label className={clsx('field', styles.profileShowField)}>
                  <span>Last name</span>
                  <input
                    type="text"
                    id="profile-account-family"
                    className="profile-select"
                    maxLength={200}
                    autoComplete="family-name"
                    value={familyName}
                    onChange={(e) => setFamilyName(e.target.value)}
                  />
                </label>
              </div>
              {profile.auth.user.teams.length > 0 && (
                <div className={styles.accountTeams}>
                  <span className="muted">Teams you can access</span>
                  <ul id="profile-account-teams" className={styles.accountTeamsList}>
                    {profile.auth.user.teams.map((t) => (
                      <li key={t.id}>{t.name}</li>
                    ))}
                  </ul>
                </div>
              )}
              <div className={styles.accountActions}>
                <a
                  href="/auth/logout"
                  className={clsx('btn', styles.logoutBtn)}
                  id="profile-account-logout"
                >
                  Log out
                </a>
              </div>
            </div>
          )}

          {/* Add new show */}
          <div className={clsx('settings-actions', styles.addShowActions)}>
            <button
              type="button"
              className="btn"
              id="profile-show-add"
              hidden={!activeStudioId || (profile?.studios ?? []).length === 0}
              disabled={createShow.isPending}
              onClick={handleAddShow}
            >
              {`Add New Show to ${(profile?.studios ?? []).find((s) => s.id === activeStudioId)?.name ?? 'this team'}`}
            </button>
          </div>
        </div>

        {/* Event Buttons tab */}
        <div
          id="v6-settings-section-events"
          className={styles.section}
          role="tabpanel"
          aria-labelledby="v6-settings-tab-event-buttons"
          hidden={activeTab !== 'event-buttons'}
        >
          {currentDraft ? (
            <>
              <p className={clsx('modal-hint', styles.eventsIntro)}>
                With the Custom palette preset, slot colors save automatically. Update button colors
                maps each event&rsquo;s color to the nearest slot color without changing the
                palette. Drag rows to set session order (auto-saves).
              </p>
              <EventButtonsTable
                buttons={currentDraft.categories}
                palette={currentDraft.event_palette}
                palettePreset={currentDraft.event_palette_preset}
                paletteCustom={currentDraft.event_palette_custom}
                otherShows={otherShows}
                onChange={(cats, pal, preset, custom) =>
                  updateShowDraft({
                    categories: cats,
                    event_palette: pal,
                    event_palette_preset: preset,
                    event_palette_custom: custom,
                  })
                }
              />
            </>
          ) : (
            <p className="modal-hint muted">Select a show above to edit its event buttons.</p>
          )}
        </div>

        {/* Auto Sync tab */}
        <div
          id="v6-settings-section-autosync"
          className={styles.section}
          role="tabpanel"
          aria-labelledby="v6-settings-tab-autosync"
          hidden={activeTab !== 'autosync'}
        >
          <p className="modal-hint muted">Coming soon.</p>
          <p className={clsx('modal-hint', styles.autosyncHint)}>
            When available, options here will use the team selected in the header above.
          </p>
        </div>

        {/* Debug tab */}
        <div
          id="v6-settings-section-debug"
          className={styles.section}
          role="tabpanel"
          aria-labelledby="v6-settings-tab-debug"
          hidden={activeTab !== 'debug'}
        >
          <p className={clsx('modal-hint', styles.sectionLead)}>
            Lag and layout A/B toggles (saved in this browser).
          </p>
          <div id="v6-settings-perf-debug-mount" className={styles.perfDebugMount} />
        </div>
      </section>
    </Dialog>
  );
}
