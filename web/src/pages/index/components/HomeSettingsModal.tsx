import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useEffect, useState } from 'react';
import { useCreateShow, useProfile, useProfileMutation } from '../../../api/hooks/useProfile';
import type { ProfilePayload, Show } from '../../../api/types';
import { BTN_PRIMARY_SKY } from '../../../shared/theme/classnames';
import { Dialog } from '../../../shared/ui/Dialog';
import { showToast } from '../utils/toast';
import type { EventButtonDraft } from './EventButtonsTable';
import { EventButtonsTable } from './EventButtonsTable';
import { FpsSelect } from './FpsSelect';
import { Select } from './Select';

// Compact toolbar-select box (ports the .teamSelect/.showSelect layout): auto width
// bounded 7–18rem, toolbar row height (2.5rem), slim horizontal padding, centered. `!` so it
// beats the Select trigger's base utilities.
const TOOLBAR_SELECT_BOX =
  '!flex-[1_1_8rem] !w-auto !min-w-[7rem] !max-w-[18rem] !h-[2.5rem] !min-h-0 !m-0 !self-center !px-[0.65rem] !py-0';

// Modal-scoped input chrome reach-in (was `.settings-dialog :global(.profile-select|.num)`):
// overrides only bg / border / color / radius over the chrome input base; font / padding /
// width / margin stay from chrome (.profile-select / .num). Same set as NewSessionModal.
const HS_INPUT_OVERRIDE =
  'bg-[rgba(255,255,255,0.05)] border border-v5-border-strong text-v5-text rounded-[0.5rem]';

// The `--v6-tab-*` cluster (formerly defined on `.settingsPanel`), applied as arbitrary-property
// utilities on the settings-panel element so its `.options`/`.section` descendants resolve them.
// Nearly-opaque panel bg so stacked overlapping tabs don't show through each other.
const TAB_VARS = [
  '[--v6-tab-panel-bg:linear-gradient(165deg,rgba(18,24,40,0.995)_0%,rgba(10,13,24,0.995)_100%)]',
  '[--v6-tab-panel-border:rgba(255,255,255,0.14)]',
  '[--v6-tab-inactive-bg:linear-gradient(180deg,rgba(26,32,48,0.98)_0%,rgba(12,15,26,0.99)_100%)]',
  '[--v6-tab-overlap:0.55rem]',
].join(' ');

// `.section` tab-panel body (shares the panel bg/border with the active tab, radius open at
// top-left where the tab attaches).
const SECTION_CLASS =
  'relative z-[1] m-0 pt-4 px-[1.05rem] pb-[1.15rem] border border-(--v6-tab-panel-border) rounded-[0_0.65rem_0.65rem_0.65rem] bg-[image:var(--v6-tab-panel-bg)] [box-shadow:inset_0_1px_0_rgba(255,255,255,0.04)] flex-[1_1_auto] min-h-0 overflow-auto [-webkit-overflow-scrolling:touch]';

// `.profileShowFieldsRow .profileShowField` base + the code/next-ep/fps width variants.
const FIELD_BASE = 'flex-[1_1_0] min-w-[min(100%,8.5rem)] max-w-full';
const FIELD_CODE_NEXTEP = 'flex-[0_1_5.5rem] min-w-16 max-w-[6.5rem]';
const FIELD_FPS = 'flex-[1_1_12rem] min-w-[min(100%,10rem)] max-w-full';
// `.profileShowFieldsRow` container.
const FIELDS_ROW =
  'flex flex-row flex-wrap items-end justify-evenly gap-x-2 gap-y-[0.65rem] w-full box-border';
// `.profileShowFieldsHead` container.
const FIELDS_HEAD = 'flex flex-row items-center justify-between gap-3 w-full mb-[0.55rem]';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /**
   * Close the active session (AppShell's close handler). Called by the save
   * path when the active studio changed — same behavior as the close-session
   * control, navigating to `/` (session-deep-links spec).
   */
  onCloseSession: () => void;
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

export function HomeSettingsModal({ isOpen, onClose, onCloseSession }: Props) {
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
        onCloseSession();
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
      // Desktop full-screen override. `md:!` reclaims the top/left/transform/size/padding/flex
      // that Dialog's base utilities now own (the deleted .settings-dialog rule used to supply
      // them); md-scoped so the ≤767px bottom-sheet is untouched.
      // On mobile the .settings-dialog height/max-height (calc(100vh-2rem)) used to win over the
      // sheet base max-height (88dvh) by layer order — now the sheet's max-h-[88dvh] utility
      // would beat it, shrinking the sheet. Re-assert the taller box + the flex-column layout
      // + padding for ≤767px so the baseline sheet is preserved (`max-md:!`).
      className={clsx(
        'md:!inset-4 md:!top-4 md:!left-4 md:![transform:none] md:!h-[calc(100vh-2rem)] md:!max-h-[calc(100vh-2rem)] md:!w-[calc(100vw-2rem)] md:!max-w-none md:!flex md:!flex-col md:!px-5 md:!pt-4 md:!pb-5',
        'max-md:!flex max-md:!flex-col max-md:!h-[calc(100vh-2rem)] max-md:!max-h-[calc(100vh-2rem)] max-md:!px-5 max-md:!pt-4 max-md:!pb-5',
      )}
      hideTitle
      title="Settings"
    >
      {/* Header toolbar */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] w-full mb-4 box-border min-w-0 shrink-0 items-center gap-x-5 gap-y-3">
        <div className="flex flex-nowrap items-center justify-start gap-x-4 gap-y-[0.65rem] min-w-0 min-h-[2.5rem] overflow-x-auto overflow-y-visible [-webkit-overflow-scrolling:touch]">
          <h2
            id="modal-app-settings-title"
            className="m-0 p-0 shrink-0 flex items-center self-center min-h-[2.5rem] text-[1rem] font-semibold leading-[1.1] tracking-[0.06em] uppercase text-v5-text"
          >
            Settings
          </h2>
          <div className="flex flex-nowrap items-center self-center gap-x-3 gap-y-2 min-w-0 flex-[1_1_auto]">
            {/* Studio selector */}
            <Select
              id="profile-studio-select"
              // Compact toolbar box (the .teamSelect layout, now ported into TOOLBAR_SELECT_BOX).
              className={TOOLBAR_SELECT_BOX}
              ariaLabel="Team"
              value={activeStudioId}
              onChange={handleStudioChange}
              options={(profile?.studios ?? []).map((s) => ({ value: s.id, label: s.name }))}
            />
            {/* Show selector */}
            <Select
              id="profile-show-select"
              className={TOOLBAR_SELECT_BOX}
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
        <div className="flex flex-nowrap items-center self-center shrink-0 gap-[0.2rem] min-h-[2.5rem]">
          <button
            type="button"
            className={clsx('btn primary', BTN_PRIMARY_SKY)}
            id="profile-save"
            disabled={mutation.isPending}
            onClick={handleSave}
          >
            {mutation.isPending ? 'Saving…' : 'Save'}
          </button>
          {/* .toolbarClose had no rule of its own (its only rule was purged in Task 2). */}
          <button type="button" className="btn" aria-label="Close" onClick={onClose}>
            Close
          </button>
        </div>
      </div>

      {/* Tabs + content */}
      <section className={clsx('flex-[1_1_auto] min-h-0 flex flex-col overflow-hidden', TAB_VARS)}>
        <div
          className="flex flex-row flex-nowrap items-end gap-0 mx-0 mt-0 mb-[-1px] px-[0.15rem] pt-[0.35rem] pb-0 relative z-[2] shrink-0 overflow-x-auto overflow-y-visible [-webkit-overflow-scrolling:touch] [scrollbar-width:thin]"
          role="tablist"
          aria-label="Settings sections"
        >
          {tabs.map((tab, tabIdx) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                id={`v6-settings-tab-${tab.id}`}
                // `.option` base + overlapping-folder-tab look. Per-tab z-index is positional
                // (was .option:nth-child(n)); the active tab lifts to z-20 (was z-index:20 !important).
                // first:ml-0 replaces .option:first-child { margin-left:0 }.
                style={{ zIndex: isActive ? 20 : tabIdx + 1 }}
                className={clsx(
                  // Legacy `font: inherit` also inherited the 1.45 line-height; a bare button's UA
                  // `normal` line-height would shrink each tab box ~2.4px → leading-[inherit].
                  // Legacy `.option:hover` (0,2,0) outranks `.optionActive` (0,1,0), so the hover
                  // wash applies to EVERY tab incl. the active one — put it on the base, not a branch.
                  'relative flex-[0_1_auto] min-w-[min(7.5rem,28vw)] first:!ml-0 ml-[calc(-1*var(--v6-tab-overlap))] text-center font-[inherit] leading-[inherit] text-[0.75rem] font-semibold tracking-[0.04em] uppercase rounded-t-[0.55rem] rounded-b-none border border-b-0 cursor-pointer [transition:transform_0.12s_ease,background_0.12s_ease,color_0.12s_ease,box-shadow_0.12s_ease,border-color_0.12s_ease] hover-always:bg-[linear-gradient(180deg,rgba(34,40,58,0.99)_0%,rgba(18,22,36,0.995)_100%)] hover-always:text-[rgba(229,238,252,0.88)]',
                  isActive
                    ? '[transform:translateY(0)] pt-[0.52rem] pb-[0.58rem] px-4 border-[rgba(56,189,248,0.45)] bg-[image:var(--v6-tab-panel-bg)] text-v5-primary [box-shadow:inset_0_1px_0_rgba(255,255,255,0.1),0_-1px_0_0_rgba(56,189,248,0.2),4px_0_14px_rgba(0,0,0,0.28)]'
                    : '[transform:translateY(3px)] pt-[0.42rem] pb-[0.48rem] px-4 border-(--v6-tab-panel-border) bg-[image:var(--v6-tab-inactive-bg)] text-[rgba(229,238,252,0.55)] [box-shadow:inset_0_1px_0_rgba(255,255,255,0.06),2px_0_6px_rgba(0,0,0,0.22)]',
                )}
                aria-selected={isActive}
                aria-controls={`v6-settings-section-${tab.id}`}
                tabIndex={isActive ? 0 : -1}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* General tab */}
        <div
          id="v6-settings-section-general"
          className={SECTION_CLASS}
          role="tabpanel"
          aria-labelledby="v6-settings-tab-general"
          hidden={activeTab !== 'general'}
        >
          {/* Show details. .profileShowFields sets border-b-0 (over admin-settings-block's border). */}
          {currentDraft ? (
            <div id="profile-show-fields" className="admin-settings-block border-b-0">
              <div className={FIELDS_HEAD}>
                {/* .profileShowFieldsHead :global(.settings-subheading) forced margin:0. */}
                <h2 className="settings-subheading !m-0">Show Details</h2>
              </div>
              <div className={FIELDS_ROW}>
                <label className={clsx('field', FIELD_BASE)}>
                  <span>Name:</span>
                  <input
                    type="text"
                    id="profile-show-name"
                    className={clsx('profile-select', HS_INPUT_OVERRIDE)}
                    maxLength={200}
                    autoComplete="off"
                    value={currentDraft.name}
                    onChange={(e) => updateShowDraft({ name: e.target.value })}
                  />
                </label>
                <label className={clsx('field', FIELD_CODE_NEXTEP)}>
                  <span>Code:</span>
                  <input
                    type="text"
                    id="profile-show-code"
                    className={clsx('profile-select mono', HS_INPUT_OVERRIDE)}
                    maxLength={40}
                    autoComplete="off"
                    spellCheck={false}
                    value={currentDraft.show_code}
                    onChange={(e) => updateShowDraft({ show_code: e.target.value.toUpperCase() })}
                  />
                </label>
                <label className={clsx('field', FIELD_CODE_NEXTEP)}>
                  <span>Next Ep:</span>
                  <input
                    type="number"
                    id="profile-show-next-ep"
                    className={clsx('profile-select', HS_INPUT_OVERRIDE)}
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
                <label className={clsx('field', FIELD_FPS)} htmlFor="profile-default-fps">
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
            <div
              id="v6-settings-account"
              className="admin-settings-block mt-5 pt-4 border-t border-v5-border"
            >
              <div className={FIELDS_HEAD}>
                <h2 className="settings-subheading !m-0">Account</h2>
              </div>
              <div className={FIELDS_ROW}>
                <label className={clsx('field', FIELD_BASE)}>
                  <span>Account</span>
                  <input
                    type="email"
                    id="profile-account-email"
                    className={clsx('profile-select', HS_INPUT_OVERRIDE)}
                    disabled
                    autoComplete="username"
                    value={profile.auth.user.email}
                    readOnly
                  />
                </label>
                <label className={clsx('field', FIELD_BASE)}>
                  <span>First name</span>
                  <input
                    type="text"
                    id="profile-account-given"
                    className={clsx('profile-select', HS_INPUT_OVERRIDE)}
                    maxLength={200}
                    autoComplete="given-name"
                    value={givenName}
                    onChange={(e) => setGivenName(e.target.value)}
                  />
                </label>
                <label className={clsx('field', FIELD_BASE)}>
                  <span>Last name</span>
                  <input
                    type="text"
                    id="profile-account-family"
                    className={clsx('profile-select', HS_INPUT_OVERRIDE)}
                    maxLength={200}
                    autoComplete="family-name"
                    value={familyName}
                    onChange={(e) => setFamilyName(e.target.value)}
                  />
                </label>
              </div>
              {profile.auth.user.teams.length > 0 && (
                <div className="mt-3">
                  <span className="muted">Teams you can access</span>
                  {/* .accountTeamsList: list-disc; color falls back (--v5-fg undefined). */}
                  <ul
                    id="profile-account-teams"
                    className="mt-[0.35rem] mx-0 mb-0 pl-[1.2rem] list-disc text-[rgba(255,255,255,0.88)]"
                  >
                    {profile.auth.user.teams.map((t) => (
                      <li key={t.id}>{t.name}</li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="mt-4 flex justify-end">
                {/* .logoutBtn tints the chrome .btn red. */}
                <a
                  href="/auth/logout"
                  className="btn text-[#fecaca] bg-[rgba(127,29,29,0.45)] border border-[rgba(248,113,113,0.5)] hover-always:bg-[rgba(153,27,27,0.65)]"
                  id="profile-account-logout"
                >
                  Log out
                </a>
              </div>
            </div>
          )}

          {/* Add new show. .addShowActions overrides .settings-actions justify/mt/pt/border-color. */}
          <div className="settings-actions justify-center mt-5 pt-4 border-t border-v5-border">
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
          className={SECTION_CLASS}
          role="tabpanel"
          aria-labelledby="v6-settings-tab-event-buttons"
          hidden={activeTab !== 'event-buttons'}
        >
          {currentDraft ? (
            <>
              {/* .eventsIntro: margin-top 0 over the .modal-hint base. */}
              <p className="modal-hint mt-0">
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
          className={SECTION_CLASS}
          role="tabpanel"
          aria-labelledby="v6-settings-tab-autosync"
          hidden={activeTab !== 'autosync'}
        >
          <p className="modal-hint muted">Coming soon.</p>
          {/* .autosyncHint: margin-top 0.35rem. */}
          <p className="modal-hint mt-[0.35rem]">
            When available, options here will use the team selected in the header above.
          </p>
        </div>

        {/* Debug tab */}
        <div
          id="v6-settings-section-debug"
          className={SECTION_CLASS}
          role="tabpanel"
          aria-labelledby="v6-settings-tab-debug"
          hidden={activeTab !== 'debug'}
        >
          {/* .sectionLead: margin-top 0, margin-bottom 0.65rem. */}
          <p className="modal-hint mt-0 mb-[0.65rem]">
            Lag and layout A/B toggles (saved in this browser).
          </p>
          <div id="v6-settings-perf-debug-mount" className="min-w-0" />
        </div>
      </section>
    </Dialog>
  );
}
