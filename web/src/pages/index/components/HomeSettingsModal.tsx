import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useEffect, useMemo, useState } from 'react';
import { useCreateShow, useProfile, useProfileMutation } from '../../../api/hooks/useProfile';
import { sessionStatusKeys } from '../../../api/hooks/useSessionStatus';
import type { ProfilePayload, Show } from '../../../api/types';
import { BTN_PRIMARY_SKY } from '../../../shared/theme/classnames';
import { useConfirm } from '../../../shared/ui/ConfirmDialog';
import { Dialog } from '../../../shared/ui/Dialog';
import { normalizePalette9 } from '../utils/palette9';
import { showToast } from '../utils/toast';
import type { EventButtonDraft } from './EventButtonsTable';
import { EventButtonsTable } from './EventButtonsTable';
import { FpsSelect } from './FpsSelect';
import { feedTabButtonClassName } from './feedTabStyles';
import { LazySelect } from './LazySelect';

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
].join(' ');

// `.section` tab-panel body — z above the tablist (same stacking as feed sheets). No top
// border: the grey seam under feed tabs is hidden by sheet overlap; settings uses the same
// idea plus an explicit border-t-0 so a residual hairline can't show between tabs.
const SECTION_CLASS =
  'relative z-[1] m-0 pt-4 px-[1.05rem] pb-[1.15rem] border border-t-0 border-x-(--v6-tab-panel-border) border-b-(--v6-tab-panel-border) rounded-[0_0.85rem_0.65rem_0.65rem] bg-[image:var(--v6-tab-panel-bg)] flex-[1_1_auto] min-h-0 overflow-auto [-webkit-overflow-scrolling:touch]';

// `.profileShowFieldsRow .profileShowField` base + the code/suffix/fps width variants.
const FIELD_BASE = 'flex-[1_1_0] min-w-[min(100%,8.5rem)] max-w-full';
const FIELD_CODE = 'flex-[0_1_5.5rem] min-w-16 max-w-[6.5rem]';
// Wider than FIELD_CODE — the Suffix select's "Episode Number" option label needs more room
// than the 3-4 char show code the field sat next to before (session-title-suffix, task 2.1).
const FIELD_SUFFIX = 'flex-[0_1_9rem] min-w-[8rem] max-w-[11rem]';
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
  title_suffix: 'date' | 'episode';
  categories: EventButtonDraft[];
  event_palette: string[];
  event_palette_preset: string;
  event_palette_custom: string[];
}

type TabId = 'general' | 'event-buttons' | 'autosync' | 'debug';

// ── Helpers ───────────────────────────────────────────────────────────────────

function showToShowDraft(show: Show): ShowDraft {
  const palette = normalizePalette9(show.event_palette ?? []);
  const custom = normalizePalette9(
    show.event_palette_custom?.length ? show.event_palette_custom : palette,
  );
  return {
    name: show.name ?? '',
    show_code: show.show_code ?? '',
    // session-title-suffix task 2.1: hydrate from the show's persisted Suffix
    // preference. Defensive default to 'date' if a payload ever omits it —
    // the real server always emits it (showApiDict, task 1.4).
    title_suffix: show.title_suffix === 'episode' ? 'episode' : 'date',
    categories: (show.categories ?? []).map((c) => ({
      id: c.id,
      // `show.categories` is wire-accurate `name`-keyed (server: `showApiDict` passes
      // stored `CategoryRecord` JSON through verbatim — `server/src/db/showsStore.ts`);
      // `c.label` falls back defensively should a `label`-keyed shape ever feed this
      // (teams-settings-nav, D3).
      name: c.name ?? c.label ?? '',
      type: c.type,
      color: c.color,
      // Options pass through verbatim, per-option `auto_instruction` included
      // (auto-generate-event-logs).
      dropdown_options: c.dropdown_options ?? [],
      on_label: c.on_label ?? '',
      off_label: c.off_label ?? '',
      // Draft-local `''` = absent; the save mapping emits the wire key only when
      // non-empty, so hydrate→save round-trips stay snapshot-clean.
      auto_instruction: c.auto_instruction ?? '',
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

// Which show to select for a studio: the profile's actually-active show when the studio in
// question IS the profile's active studio, else that studio's first show. Shared by the init
// effect and handleStudioChange so re-selecting the originally-active studio reproduces the
// exact initial selection (D11: view-only selection round-tripping back must not read dirty).
function pickShowIdForStudio(profile: ProfilePayload, studioId: string): string {
  const showsForStudio = profile.shows.filter((s) => s.studio_id === studioId);
  const isActiveStudio = studioId === (profile.active_studio_id ?? profile.studios[0]?.id ?? '');
  const preferredShow = isActiveStudio
    ? (showsForStudio.find((s) => s.id === profile.active_show_id) ?? showsForStudio[0])
    : showsForStudio[0];
  return preferredShow?.id ?? '';
}

// Shape compared to derive dirtiness (D11: DERIVED, not hand-armed — a forgotten setDirty
// call at some future callsite fails in the dangerous direction, so dirtiness is instead
// computed from the initialized snapshot vs. current form state on every render).
interface FormSnapshot {
  activeStudioId: string;
  activeShowId: string;
  defaultFps: number;
  showDrafts: Record<string, ShowDraft>;
  givenName: string;
  familyName: string;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function HomeSettingsModal({ isOpen, onClose, onCloseSession }: Props) {
  const { data: profile } = useProfile();
  const mutation = useProfileMutation();
  const createShow = useCreateShow();
  const queryClient = useQueryClient();

  const [activeTab, setActiveTab] = useState<TabId>('general');
  // Which tabs have ever been activated this open, so their content mounts once and stays
  // mounted (settings-modal-mount-cost, D2) instead of every tab paying its mount cost up
  // front. Seeded with 'general' since the modal always opens there.
  const [visitedTabs, setVisitedTabs] = useState<Set<TabId>>(() => new Set(['general']));
  const [activeStudioId, setActiveStudioId] = useState('');
  const [activeShowId, setActiveShowId] = useState('');
  const [defaultFps, setDefaultFps] = useState(24);
  const [showDrafts, setShowDrafts] = useState<Record<string, ShowDraft>>({});
  const [givenName, setGivenName] = useState('');
  const [familyName, setFamilyName] = useState('');

  const [initialized, setInitialized] = useState(false);
  // The initialized snapshot dirtiness is derived against (D11). `null` until the init effect
  // below runs; a `null` snapshot always reads clean regardless of form state.
  const [initialSnapshot, setInitialSnapshot] = useState<FormSnapshot | null>(null);

  // ui-refresh: unsaved-changes tracking. Save is a no-op until something changed, and Close
  // warns before discarding edits — the old header offered Save + Close with no hint which
  // edits were already committed.
  const { confirm, confirmElement } = useConfirm();

  // Themed replacement for the window.prompt Add-Show flow (ui-refresh, D2).
  const [addShowOpen, setAddShowOpen] = useState(false);
  const [newShowName, setNewShowName] = useState('');

  // Reset form each time modal opens so stale drafts don't linger. `activeTab` and
  // `visitedTabs` reset here too (teams-settings-nav, D1; settings-modal-mount-cost, D2):
  // the modal now survives route changes while open instead of unmounting, so unmount can
  // no longer be relied on to reset it back to General between opens.
  //
  // This adjusts state during render rather than in a passive `useEffect` (React's
  // adjust-state-during-render pattern, `prevOpen`/`setPrevOpen` below). A `useEffect` runs
  // after the reopen commit, which would let that commit paint with the *previous* open's
  // stale `activeTab`/`visitedTabs` — mounting whatever tab was active when the modal was
  // last closed — and only unmount it once the effect fires and re-renders. Doing the reset
  // during render means the reopen's first commit already reflects the reset state, so the
  // stale tab's content is never committed to the DOM at all.
  const [prevOpen, setPrevOpen] = useState(isOpen);
  if (isOpen !== prevOpen) {
    setPrevOpen(isOpen);
    if (isOpen) {
      setInitialized(false);
      setInitialSnapshot(null);
      setActiveTab('general');
      setVisitedTabs(new Set(['general']));
    }
  }

  // Initialise form once when profile first loads (or after reset above), and record the
  // snapshot dirtiness is compared against. Gated on `isOpen` (settings-modal-mount-cost,
  // D4): without it, this runs the moment `useProfile` resolves regardless of open state,
  // then runs again on open once the reset above clears `initialized`. `isOpen` is in the
  // dep array too, not just the guard — the effect has to re-run on the render where the
  // guard first passes (the open transition), which a deps-only-on-[profile, initialized]
  // array would miss.
  useEffect(() => {
    if (!isOpen || !profile || initialized) return;
    const sid = profile.active_studio_id ?? profile.studios[0]?.id ?? '';
    const fps = getDefaultFps(profile, sid);
    const drafts = initDraftsForStudio(profile.shows, sid);
    const showId = pickShowIdForStudio(profile, sid);
    const given = profile.auth.user?.given_name ?? '';
    const family = profile.auth.user?.family_name ?? '';

    setActiveStudioId(sid);
    setDefaultFps(fps);
    setShowDrafts(drafts);
    setActiveShowId(showId);
    if (profile.auth.user) {
      setGivenName(given);
      setFamilyName(family);
    }
    setInitialSnapshot({
      activeStudioId: sid,
      activeShowId: showId,
      defaultFps: fps,
      showDrafts: drafts,
      givenName: given,
      familyName: family,
    });
    setInitialized(true);
  }, [isOpen, profile, initialized]);

  function handleStudioChange(studioId: string) {
    if (!profile) return;
    setActiveStudioId(studioId);
    setDefaultFps(getDefaultFps(profile, studioId));
    setShowDrafts(initDraftsForStudio(profile.shows, studioId));
    setActiveShowId(pickShowIdForStudio(profile, studioId));
  }

  // Derived dirtiness (D11, panel-revised — the spike hand-armed a per-callsite `dirty` flag;
  // that fails in the dangerous direction if a future edit path forgets to arm it, both
  // bricking Save and skipping the discard guard). Deep-compare against the initialized
  // snapshot instead; JSON.stringify of this stable-shaped object is an acceptable deep
  // comparison since both sides are built by the same functions from the same source data.
  const dirty = useMemo(() => {
    if (!initialSnapshot) return false;
    const current: FormSnapshot = {
      activeStudioId,
      activeShowId,
      defaultFps,
      showDrafts,
      givenName,
      familyName,
    };
    return JSON.stringify(current) !== JSON.stringify(initialSnapshot);
  }, [
    initialSnapshot,
    activeStudioId,
    activeShowId,
    defaultFps,
    showDrafts,
    givenName,
    familyName,
  ]);

  // Below every hook, so hook order stays unconditional, and below the render-phase
  // `prevOpen` reset above, which must keep running on the reopen render even though this
  // return then discards its result until `isOpen` flips back to true (settings-modal-
  // mount-cost, D4). Radix already renders nothing to the DOM for a closed dialog (no
  // `forceMount`), so this changes nothing about what commits — it only skips constructing
  // the tree below (both `Select` option arrays, the four tab-panel wrappers, `confirmElement`,
  // and the nested Add-Show `Dialog`) on every render while closed.
  if (!isOpen) return null;

  const showsForStudio = (profile?.shows ?? []).filter((s) => s.studio_id === activeStudioId);
  const currentDraft = activeShowId ? showDrafts[activeShowId] : undefined;
  const otherShows = showsForStudio.filter((s) => s.id !== activeShowId);

  async function handleRequestClose() {
    if (dirty) {
      const ok = await confirm({
        title: 'Discard changes',
        message: 'You have unsaved settings changes. Discard them?',
        confirmLabel: 'Discard',
        cancelLabel: 'Keep editing',
        danger: true,
      });
      if (!ok) return;
    }
    onClose();
  }

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
          title_suffix: draft.title_suffix,
          categories: draft.categories.map((c) => ({
            id: c.id,
            // The update validator requires `name` (`server/src/studio.ts`
            // `validateCategoriesList`), matching the `name`-keyed read shape above.
            name: c.name,
            color: c.color,
            type: c.type,
            // Per-option belt (auto-generate-event-logs audit M6): the same
            // trim/omit gate as the category level below, applied here as a
            // second enforcing site alongside EventOptionsModal's confirm
            // mapping — a draft option that never went through that modal
            // (hydrated then saved untouched, or padded by a future editor)
            // must still post the wire rule: key only when trim-non-empty,
            // emitted TRIMMED, matching server normalization.
            dropdown_options: c.dropdown_options.map(
              ({ label, needs_context, auto_instruction }) => ({
                label,
                needs_context,
                ...(auto_instruction?.trim() ? { auto_instruction: auto_instruction.trim() } : {}),
              }),
            ),
            on_label: c.on_label,
            off_label: c.off_label,
            // Wire key `auto_instruction` (auto-generate-event-logs): this mapping
            // rebuilds categories from a fixed field set, so the key must be carried
            // explicitly or a save would silently strip saved instructions. Gated on
            // trim() and emitted trimmed, matching server normalization (which trims,
            // drops empties, and drops it on ON_OFF) — a truthy whitespace-only draft
            // would otherwise post a key the server drops, leaving a phantom local
            // value after the post-save rebaseline.
            ...(c.auto_instruction.trim() ? { auto_instruction: c.auto_instruction.trim() } : {}),
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
      // Rebaseline: every field just submitted is now the saved state, so re-snapshot from
      // current form state to return Save to disabled/"Saved" (D11).
      setInitialSnapshot({
        activeStudioId,
        activeShowId,
        defaultFps,
        showDrafts,
        givenName,
        familyName,
      });
      showToast('Saved.');
      if (activeStudioId !== prevStudioId) {
        onCloseSession();
      }
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      queryClient.invalidateQueries({ queryKey: ['events'] });
      queryClient.invalidateQueries({ queryKey: sessionStatusKeys.all() });
      // A now-working save can rename/delete categories; without this, an open session's
      // button strip keeps serving stale ones for its 30s staleTime (design D4).
      queryClient.invalidateQueries({ queryKey: ['show-categories'] });
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Save failed.', true);
    }
  }

  // ui-refresh: themed Add-Show dialog (was window.prompt browser chrome).
  async function submitAddShow() {
    const name = newShowName.trim();
    if (!profile || !activeStudioId || !name) return;
    try {
      const { show } = await createShow.mutateAsync({ studio_id: activeStudioId, name });
      const draft = showToShowDraft(show as Show);
      setShowDrafts((prev) => ({ ...prev, [show.id]: draft }));
      setActiveShowId(show.id);
      // The new show is already persisted by this mutation (not by Save), so patch it into
      // the snapshot too — otherwise it would read as an unsaved edit even though there's
      // nothing to save. Only this key is patched: any other genuinely-unsaved draft edits
      // stay dirty against their original snapshot values.
      setInitialSnapshot((prev) =>
        prev ? { ...prev, showDrafts: { ...prev.showDrafts, [show.id]: draft } } : prev,
      );
      setAddShowOpen(false);
      setNewShowName('');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not create show.', true);
    }
  }

  function handleAddShow() {
    if (!profile || !activeStudioId) return;
    setNewShowName('');
    setAddShowOpen(true);
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
      onOpenChange={(o) => {
        if (!o) void handleRequestClose();
      }}
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
            <LazySelect
              id="profile-studio-select"
              // Compact toolbar box (the .teamSelect layout, now ported into TOOLBAR_SELECT_BOX).
              className={TOOLBAR_SELECT_BOX}
              ariaLabel="Team"
              value={activeStudioId}
              onChange={handleStudioChange}
              options={(profile?.studios ?? []).map((s) => ({ value: s.id, label: s.name }))}
            />
            {/* Show selector */}
            <LazySelect
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
            // ui-refresh: disabled until something changed, so "is this saved?" is answerable
            // from the header at a glance (D11).
            disabled={mutation.isPending || !dirty}
            title={dirty ? undefined : 'No unsaved changes'}
            onClick={handleSave}
          >
            {mutation.isPending ? 'Saving…' : dirty ? 'Save' : 'Saved'}
          </button>
          {/* .toolbarClose had no rule of its own (its only rule was purged in Task 2). */}
          <button
            type="button"
            className="btn"
            aria-label="Close"
            onClick={() => void handleRequestClose()}
          >
            Close
          </button>
        </div>
      </div>

      {/* Tabs + content */}
      <section className={clsx('flex-[1_1_auto] min-h-0 flex flex-col overflow-hidden', TAB_VARS)}>
        <div
          // Same stacking/overlap as SessionWorkspace feed tabs: tablist under the panel
          // (z-0 / z-1). -mb-2 tucks the panel under the tab bottoms. pt ≥ the active tab's
          // cyan ::before glow (0 0 12px) so overflow-y:hidden doesn't clip it; overflow-x
          // only on small screens (same as feed) so desktop keeps overflow-y:visible for the
          // glow — overflow-x:auto would force overflow-y to auto and re-clip.
          className="relative z-0 flex shrink-0 flex-row flex-nowrap items-end gap-[0.18rem] -mb-2 px-[0.15rem] pt-[14px] max-md:overflow-x-auto max-md:overflow-y-hidden max-md:[-webkit-overflow-scrolling:touch] max-md:[scrollbar-width:none]"
          role="tablist"
          aria-label="Settings sections"
        >
          {tabs.map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                id={`v6-settings-tab-${tab.id}`}
                // Shared glass-tab chrome with Event Feed / Transcript / … (cyan top stripe,
                // no bottom border — feedTabStyles).
                className={feedTabButtonClassName(isActive)}
                aria-selected={isActive}
                aria-controls={`v6-settings-section-${tab.id}`}
                tabIndex={isActive ? 0 : -1}
                onClick={() => {
                  setActiveTab(tab.id);
                  setVisitedTabs((prev) => {
                    if (prev.has(tab.id)) return prev;
                    const next = new Set(prev);
                    next.add(tab.id);
                    return next;
                  });
                }}
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
          {/* Deferred mount (settings-modal-mount-cost, D2): only the wrapper above is
              unconditional (its id/role/aria-labelledby/hidden keep every aria-controls
              target resolvable and this tab's e2e surface intact) — the content below
              mounts once this tab has been visited and then stays mounted. */}
          {visitedTabs.has('general') && (
            <>
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
                    <label className={clsx('field', FIELD_CODE)}>
                      <span>Code:</span>
                      <input
                        type="text"
                        id="profile-show-code"
                        className={clsx('profile-select mono', HS_INPUT_OVERRIDE)}
                        maxLength={40}
                        autoComplete="off"
                        spellCheck={false}
                        value={currentDraft.show_code}
                        onChange={(e) =>
                          updateShowDraft({ show_code: e.target.value.toUpperCase() })
                        }
                      />
                    </label>
                    {/* session-title-suffix task 2.1: replaces the removed Next Ep counter
                    control. Maps to the show's `title_suffix` preference, which the
                    server uses to derive untitled-create titles (design D5-D8). */}
                    <label className={clsx('field', FIELD_SUFFIX)} htmlFor="profile-show-suffix">
                      <span>Suffix:</span>
                      <LazySelect
                        id="profile-show-suffix"
                        ariaLabel="Suffix"
                        value={currentDraft.title_suffix}
                        onChange={(v) =>
                          updateShowDraft({ title_suffix: v === 'episode' ? 'episode' : 'date' })
                        }
                        options={[
                          { value: 'date', label: 'Date' },
                          { value: 'episode', label: 'Episode Number' },
                        ]}
                      />
                    </label>
                    <label className={clsx('field', FIELD_FPS)} htmlFor="profile-default-fps">
                      <span>Default Frame Rate:</span>
                      <FpsSelect
                        id="profile-default-fps"
                        value={defaultFps}
                        onChange={setDefaultFps}
                      />
                    </label>
                  </div>
                  {showAcronymWarn && (
                    <p className="modal-hint" id="profile-show-acronym-warn">
                      Tip: show code is usually initials of the show name (e.g.{' '}
                      {currentDraft.name.trim()} &rarr; {currentInitials}). Yours differs — that is
                      fine if intentional.
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
            </>
          )}
        </div>

        {/* Event Buttons tab */}
        <div
          id="v6-settings-section-event-buttons"
          className={SECTION_CLASS}
          role="tabpanel"
          aria-labelledby="v6-settings-tab-event-buttons"
          hidden={activeTab !== 'event-buttons'}
        >
          {/* Deferred mount (settings-modal-mount-cost, D2/D3): this is the tab the change
              exists for — EventButtonsTable's per-row Radix Selects dominate the modal's
              mount cost, so this content only mounts once the tab has been activated. */}
          {visitedTabs.has('event-buttons') &&
            (currentDraft ? (
              <>
                {/* .eventsIntro: margin-top 0 over the .modal-hint base.
                    ui-refresh: the old copy claimed slot colors and drag order "save
                    automatically" — they don't; every edit in this tab is a draft applied by
                    Save (updateShowDraft). Copy now matches the actual save model (D11). */}
                <p className="modal-hint mt-0">
                  Update button colors maps each event&rsquo;s color to the nearest slot color
                  without changing the palette. Drag rows to set session order. Changes here apply
                  when you click <strong>Save</strong>.
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
            ))}
        </div>

        {/* Auto Sync tab */}
        <div
          id="v6-settings-section-autosync"
          className={SECTION_CLASS}
          role="tabpanel"
          aria-labelledby="v6-settings-tab-autosync"
          hidden={activeTab !== 'autosync'}
        >
          {/* Deferred mount (settings-modal-mount-cost, D2): this tab's own content is cheap
              (two <p>s) — deferred anyway so the discipline is uniform across all four tabs
              rather than special-cased per tab (see design D2's alternatives). */}
          {visitedTabs.has('autosync') && (
            <>
              <p className="modal-hint muted">Coming soon.</p>
              {/* .autosyncHint: margin-top 0.35rem. */}
              <p className="modal-hint mt-[0.35rem]">
                When available, options here will use the team selected in the header above.
              </p>
            </>
          )}
        </div>

        {/* Debug tab */}
        <div
          id="v6-settings-section-debug"
          className={SECTION_CLASS}
          role="tabpanel"
          aria-labelledby="v6-settings-tab-debug"
          hidden={activeTab !== 'debug'}
        >
          {/* Deferred mount (settings-modal-mount-cost, D2) — same uniform discipline as the
              other three tabs. */}
          {visitedTabs.has('debug') && (
            <>
              {/* .sectionLead: margin-top 0, margin-bottom 0.65rem. */}
              <p className="modal-hint mt-0 mb-[0.65rem]">
                Lag and layout A/B toggles (saved in this browser).
              </p>
              <div id="v6-settings-perf-debug-mount" className="min-w-0" />
            </>
          )}
        </div>
      </section>

      {confirmElement}

      {/* Themed Add-Show dialog (ui-refresh: was window.prompt). */}
      <Dialog
        open={addShowOpen}
        onOpenChange={(o) => !o && setAddShowOpen(false)}
        title="Add show"
        description="You can update the show code and details after creating it."
      >
        <label className="field">
          <span>Show name</span>
          <input
            type="text"
            className={clsx('profile-select', HS_INPUT_OVERRIDE)}
            id="profile-show-add-name"
            maxLength={200}
            autoComplete="off"
            autoFocus
            value={newShowName}
            onChange={(e) => setNewShowName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void submitAddShow();
              }
            }}
          />
        </label>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={() => setAddShowOpen(false)}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={createShow.isPending || newShowName.trim() === ''}
            onClick={() => void submitAddShow()}
          >
            {createShow.isPending ? 'Creating…' : 'Create show'}
          </button>
        </div>
      </Dialog>
    </Dialog>
  );
}
