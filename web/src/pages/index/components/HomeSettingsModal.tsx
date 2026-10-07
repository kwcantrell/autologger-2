import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useEffect, useMemo, useState } from 'react';
import { useCreateShow, useProfile, useProfileMutation } from '../../../api/hooks/useProfile';
import { showAccessFrom } from '../../../api/hooks/useShowAccess';
import { useStudioShows } from '../../../api/hooks/useShows';
import type { Show } from '../../../api/types';
import { Button, TOUCH_TARGET } from '../../../shared/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '../../../shared/components/ui/field';
import { Input } from '../../../shared/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../shared/components/ui/tabs';
import { useConfirm } from '../../../shared/ui/ConfirmDialog';
import { Dialog, DialogActions } from '../../../shared/ui/Dialog';
import { showToast } from '../utils/toast';
import { EventButtonsTable } from './EventButtonsTable';
import { FpsSelect } from './FpsSelect';
import { LazySelect } from './LazySelect';
import {
  activeShowIdForSave as activeShowIdForSaveRule,
  getDefaultFps,
  initDraftsForStudio,
  invalidateAfterProfileSave,
  pickShowIdForStudio,
  type ShowDraft,
  showDraftToUpdate,
  showsUnavailableState,
  showToShowDraft,
  teamSettingsWithFps,
} from './settings/settingsModel';

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

// Legacy chrome re-expressed as utilities (shadcn-port-settings D2): the computed values of
// `.admin-settings-block`, `.settings-subheading`, `.settings-actions` and `.modal-hint` (those
// rules were since deleted). The `mb-4` on inputs is `.profile-select`'s former margin.
const SETTINGS_BLOCK = 'mt-4 mb-5 pb-4 border-b border-legacy-border';
const SETTINGS_SUBHEAD = 'm-0 text-[1rem] font-semibold text-(--text)';
const HINT = 'm-0 mb-[0.65rem] text-[0.78rem] leading-[1.45] text-legacy-muted';
const HS_INPUT = clsx('mb-4', HS_INPUT_OVERRIDE);

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

type TabId = 'general' | 'event-buttons' | 'autosync' | 'debug';

// Shapes compared to derive dirtiness (D11: DERIVED, not hand-armed — a forgotten setDirty
// call at some future callsite fails in the dangerous direction, so dirtiness is instead
// computed from the initialized snapshot vs. current form state on every render).
//
// SPLIT IN TWO by scope (PR review finding 2), because the two halves are fed by two
// different sources with two different failure modes. The account half comes from the
// profile, which is already in hand before the modal can open; the shows half comes from
// `GET /api/shows?studio_id=…`, which can be slow, can fail, and is re-fetched per studio.
// One combined snapshot made the account fields hostage to that query: a 500 meant no
// snapshot at all, so the account fields never hydrated, `dirty` never armed, and Save
// stayed disabled — bricking account-only saves that the save handler has always supported.
interface AccountSnapshot {
  activeStudioId: string;
  defaultFps: number;
  givenName: string;
  familyName: string;
}

interface ShowsSnapshot {
  activeShowId: string;
  showDrafts: Record<string, ShowDraft>;
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
  // Activate a tab and record its first visit in one step (click, mouse-down or arrow-key
  // focus — Radix automatic activation — all land here).
  const selectTab = (id: TabId) => {
    setActiveTab(id);
    setVisitedTabs((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  };
  const [activeStudioId, setActiveStudioId] = useState('');
  const [activeShowId, setActiveShowId] = useState('');
  const [defaultFps, setDefaultFps] = useState(24);
  const [showDrafts, setShowDrafts] = useState<Record<string, ShowDraft>>({});
  const [givenName, setGivenName] = useState('');
  const [familyName, setFamilyName] = useState('');

  // The account fields initialise from the profile alone, once per open (review finding 2).
  // The shows scope has no boolean twin: its init is keyed to the STUDIO via `draftsStudioId`
  // below, not to the open (review finding 1) — see the shows init effect.
  const [accountInitialized, setAccountInitialized] = useState(false);
  // Which studio the drafts in `showDrafts` — and the shows snapshot they were baselined
  // into — were built for. `null` = not built yet this open. Compared against
  // `targetStudioId` below, this is what makes the async draft (re)build idempotent: once it
  // has run for a studio it never runs again for that studio, so a refetch (save, add-show,
  // window focus) cannot clobber in-progress edits.
  const [draftsStudioId, setDraftsStudioId] = useState<string | null>(null);
  // The initialized snapshots dirtiness is derived against (D11). `null` until the matching
  // init effect below runs; a `null` snapshot always reads clean regardless of form state —
  // which is exactly what keeps a never-loaded shows section from arming Save on its own.
  const [accountSnapshot, setAccountSnapshot] = useState<AccountSnapshot | null>(null);
  const [showsSnapshot, setShowsSnapshot] = useState<ShowsSnapshot | null>(null);

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
      setAccountInitialized(false);
      setAccountSnapshot(null);
      setShowsSnapshot(null);
      setActiveTab('general');
      setVisitedTabs(new Set(['general']));
      // profile-shows-slimming: the studio selection has to be reset too, not
      // just the init flag. `targetStudioId` below falls back to the profile's
      // active studio only while `activeStudioId` is empty — leaving last
      // open's switched-to studio in state would reopen the modal on it (and
      // fetch ITS shows), where the previous code always re-derived the
      // studio from the profile inside the init effect.
      setActiveStudioId('');
      setActiveShowId('');
      setShowDrafts({});
      setDraftsStudioId(null);
    }
  }

  // The studio whose shows are being edited: the user's in-modal selection once
  // made, else the profile's active studio. Empty while the profile is still
  // loading, and while closed — `useStudioShows` is disabled on a null id, so a
  // closed modal issues no request at all (the whole point of the split).
  const profileStudioId = profile ? (profile.active_studio_id ?? profile.studios[0]?.id ?? '') : '';
  const targetStudioId = isOpen ? activeStudioId || profileStudioId : '';
  const studioShowsQuery = useStudioShows(targetStudioId || null);
  const studioShows = useMemo(() => studioShowsQuery.data?.shows ?? [], [studioShowsQuery.data]);
  // A caller with no teams has a `''` studio id: there is nothing to fetch, the
  // query stays disabled, and `isSuccess` would never arrive — so that case is
  // "loaded, empty" as soon as the profile is in hand. Without this the init
  // effect below would never run for a team-less account and the modal would
  // sit on a permanent skeleton.
  const showsLoaded = Boolean(profile) && (targetStudioId === '' || studioShowsQuery.isSuccess);
  // An UNAVAILABLE shows fetch — the one "we have nothing to show you, here's why" value, in
  // the two shapes that reach it. Both are states `showsLoaded` gets wrong, because it only
  // ever flips on `isSuccess`: without this the shows section would sit on its loading
  // skeleton forever, with no message and no way to retry.
  //
  //   'error'   — a FAILED fetch. Distinct from "still loading": the answer already came
  //               back, so a picker still saying "Loading shows…" is claiming to wait on a
  //               request that is over.
  //   'offline' — a PAUSED fetch, and the state BOTH of the other branches used to get
  //               wrong. With react-query's default `networkMode: 'online'` (nothing
  //               overrides it — see `IndexRoot`'s client), going offline HOLDS the fetch
  //               rather than running it, so `isPending` stays true and `isError` stays
  //               false INDEFINITELY. Read as "loading", that stranded the section on a
  //               skeleton promising an answer already on its way — Add-New-Show hidden,
  //               the picker disabled, and the Retry that recovers it living in the error
  //               branch, which is unreachable. Split out by `fetchStatus === 'paused'`,
  //               which is exactly react-query's own name for it —
  //               `EventGenerateCustomModal` gives its own paused `useShow` the same
  //               treatment, in the same mechanism and the same wording.
  //
  // Scoped to `isPending` on the offline side: a paused BACKGROUND refetch over drafts
  // already on screen withholds nothing, so it says nothing. Keyed on `targetStudioId`
  // because a DISABLED query (a caller with no teams) never errors and never pauses on a
  // fetch it was never going to make.
  //
  // Either way this scopes the SHOWS section only: neither state reaches `showsReady`, so
  // the shows scope contributes nothing to `dirty` and `handleSave` omits `show_updates` —
  // but the account scope stays fully editable and saveable regardless (review finding 2).
  const showsUnavailable = showsUnavailableState(studioShowsQuery, targetStudioId);

  // ACCOUNT init — once per open, from the profile ALONE. Gated on `isOpen`
  // (settings-modal-mount-cost, D4): without it, this runs the moment `useProfile` resolves
  // regardless of open state, then runs again on open once the reset above clears
  // `accountInitialized`. `isOpen` is in the dep array too, not just the guard — the effect
  // has to re-run on the render where the guard first passes (the open transition), which a
  // deps-only-on-[profile, accountInitialized] array would miss.
  //
  // Deliberately NOT gated on `showsLoaded` (review finding 2). The profile is in hand
  // before the modal can open, so nothing about the name fields, the frame rate, or the
  // studio pointer has to wait on `GET /api/shows` — and when that request fails or hangs,
  // waiting on it meant the account fields never hydrated and Save never armed, with no way
  // out short of closing the modal.
  //
  // `profileStudioId`, not `targetStudioId`: on the first pass they are equal (the
  // in-modal selection is still `''`), and reading the profile's value directly keeps this
  // effect's source of truth unambiguously the profile. Later studio switches are owned by
  // `handleStudioChange`, not by a re-run of this effect.
  useEffect(() => {
    if (!isOpen || !profile || accountInitialized) return;

    const sid = profileStudioId;
    const fps = getDefaultFps(profile, sid);
    const given = profile.auth.user?.given_name ?? '';
    const family = profile.auth.user?.family_name ?? '';
    setActiveStudioId(sid);
    setDefaultFps(fps);
    if (profile.auth.user) {
      setGivenName(given);
      setFamilyName(family);
    }
    setAccountSnapshot({
      activeStudioId: sid,
      defaultFps: fps,
      givenName: given,
      familyName: family,
    });
    setAccountInitialized(true);
  }, [isOpen, profile, accountInitialized, profileStudioId]);

  // SHOWS init — profile-shows-slimming turned the draft source ASYNC. The drafts (and the
  // show selection derived from them) can only be built once
  // `useStudioShows(targetStudioId)` has resolved, so this effect gates on
  // `showsLoaded`, and covers BOTH the first build and every subsequent
  // studio switch — `handleStudioChange` can no longer rebuild drafts
  // synchronously, and duplicating the build in two places is exactly how the
  // two would drift.
  //
  // Re-entry is keyed on `draftsStudioId !== targetStudioId`, NOT on a
  // one-shot flag: that makes the rebuild fire once per studio and never again
  // for the same studio, so the refetches this modal itself triggers (save,
  // add-show, remount) cannot overwrite unsaved edits.
  //
  // The SHOWS SNAPSHOT is taken by the SAME pass that builds the drafts, so the baseline is
  // keyed to the studio exactly like `draftsStudioId` is (review finding 1). It used to be
  // taken once per OPEN instead, which decoupled the two: open on studio A (baseline = A),
  // switch to B while B's fetch fails or hangs, save the account scope (the rebaseline below
  // is skipped — correctly, the drafts map is empty and means "unknown"), then Retry. The
  // rebuild for B would then run with A's baseline still in place, so B's untouched drafts
  // read dirty forever after: Save armed over a form nobody edited, a phantom discard
  // warning on close, and a redundant full `show_updates` for B on the next save.
  //
  // Re-snapshotting per studio cannot lose a real edit, because the rebuild it rides along
  // with has already discarded any: drafts are rebuilt from server state whenever
  // `draftsStudioId !== targetStudioId`, and `handleStudioChange` clears them outright. It
  // also preserves D11 (view-only selection round-tripping must not read dirty): a studio
  // round trip A→B→A rebuilds A's drafts from A's cached response — a pure function of
  // server state — and re-baselines against those same bytes, so `dirty` returns to false
  // either way. And it still survives an errored-then-retried fetch for free: the pass only
  // runs once it actually has data, so an account-only save made while the fetch was down
  // never baselines an empty shows draft map.
  useEffect(() => {
    if (!isOpen || !profile || !showsLoaded) return;
    if (draftsStudioId === targetStudioId) return;

    const sid = targetStudioId;
    const drafts = initDraftsForStudio(studioShows, sid);
    const showId = pickShowIdForStudio(profile, studioShows, sid);
    setShowDrafts(drafts);
    setActiveShowId(showId);
    setDraftsStudioId(sid);
    setShowsSnapshot({ activeShowId: showId, showDrafts: drafts });
  }, [isOpen, profile, showsLoaded, studioShows, targetStudioId, draftsStudioId]);

  function handleStudioChange(studioId: string) {
    if (!profile) return;
    setActiveStudioId(studioId);
    setDefaultFps(getDefaultFps(profile, studioId));
    // Drafts/selection are rebuilt by the effect above once THIS studio's shows
    // arrive. Clearing them here rather than leaving the previous studio's in
    // place is what keeps the loading window honest: the shows section renders
    // its skeleton instead of another team's show details.
    setShowDrafts({});
    setActiveShowId('');
    // …and forget WHICH studio the (now-cleared) drafts belonged to. Leaving
    // the previous studio's id here is an A→B→A trap: if B's shows are still in
    // flight the rebuild effect early-returns on `!showsLoaded`, so
    // `draftsStudioId` would still read 'A' when the user switches back — and
    // the effect's idempotence guard (`draftsStudioId === targetStudioId`)
    // would then decline to rebuild, leaving the drafts map empty for the rest
    // of the open (dirty-compare arms Save; the save silently omits
    // `show_updates`). `null` cannot equal any studio id, so the return trip
    // always rebuilds — from A's already-cached response, reproducing the
    // snapshot's bytes so dirtiness round-trips back to clean (D11).
    setDraftsStudioId(null);
  }

  // The shows section is READY exactly when the drafts on screen belong to the
  // studio currently selected — which is strictly later than `showsLoaded` (the
  // rebuild effect commits one render after the data lands) and strictly later
  // than a studio switch. Gating on this rather than on the query's own loading
  // flag is what stops the one-frame "Select a show above" / empty-selector
  // flash between "shows arrived" and "drafts built". Computed here, above the
  // dirtiness hooks that read it, rather than below the `isOpen` early return.
  const showsReady = draftsStudioId === targetStudioId;

  // Derived dirtiness (D11, panel-revised — the spike hand-armed a per-callsite `dirty` flag;
  // that fails in the dangerous direction if a future edit path forgets to arm it, both
  // bricking Save and skipping the discard guard). Deep-compare against the initialized
  // snapshot instead; JSON.stringify of this stable-shaped object is an acceptable deep
  // comparison since both sides are built by the same functions from the same source data.
  //
  // Computed PER SCOPE (review finding 2) so an unavailable shows query cannot suppress
  // account dirtiness: the account fields are live from the moment the modal opens.
  const accountDirty = useMemo(() => {
    if (!accountSnapshot) return false;
    const current: AccountSnapshot = { activeStudioId, defaultFps, givenName, familyName };
    return JSON.stringify(current) !== JSON.stringify(accountSnapshot);
  }, [accountSnapshot, activeStudioId, defaultFps, givenName, familyName]);

  // Shows dirtiness needs BOTH a snapshot (a rebuild has run at least once this open) and
  // `showsReady` (the drafts on screen belong to the selected studio). Without the second
  // condition the mid-switch window — snapshot from studio A, drafts cleared for B — reads
  // dirty over a form the user has not touched, which is the state the old `!showsReady`
  // Save gate existed to suppress. Folding that condition in HERE rather than into the Save
  // gate is what lets account-only saves through while shows are unavailable. `showsReady`
  // also settles WHOSE baseline this is: snapshot and `draftsStudioId` are written by the
  // same pass, so drafts-belong-to-the-selected-studio implies the snapshot does too.
  const showsDirty = useMemo(() => {
    if (!showsSnapshot || !showsReady) return false;
    const current: ShowsSnapshot = { activeShowId, showDrafts };
    return JSON.stringify(current) !== JSON.stringify(showsSnapshot);
  }, [showsSnapshot, showsReady, activeShowId, showDrafts]);

  const dirty = accountDirty || showsDirty;

  // Below every hook, so hook order stays unconditional, and below the render-phase
  // `prevOpen` reset above, which must keep running on the reopen render even though this
  // return then discards its result until `isOpen` flips back to true (settings-modal-
  // mount-cost, D4). Radix already renders nothing to the DOM for a closed dialog (no
  // `forceMount`), so this changes nothing about what commits — it only skips constructing
  // the tree below (both `Select` option arrays, the four tab-panel wrappers, `confirmElement`,
  // and the nested Add-Show `Dialog`) on every render while closed.
  if (!isOpen) return null;

  const showsForStudio = studioShows.filter((s) => s.studio_id === targetStudioId);
  // show-grants D13 (owner-confirmed member Settings view): when the selected team's role is
  // `member`, the team defaults (frame rate), show editing and "Add show" are not rendered, and
  // the save omits `settings` and `show_updates` (both owner/admin only on the server). The team
  // switch and the name fields stay.
  const isMemberView = showAccessFrom(profile).teamRole(activeStudioId) === 'member';
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
    const settings = teamSettingsWithFps(profile, activeStudioId, defaultFps);

    const show_updates = showsForStudio
      .map((s) => {
        const draft = showDrafts[s.id];
        return draft ? showDraftToUpdate(s.id, draft) : null;
      })
      .filter((x) => x !== null);

    // The `active_show_id` rule (settingsModel `activeShowIdForSave`): an absent field makes the
    // server pick the team's first show, so an account-only save made while the shows query is
    // erroring or in flight echoes the profile's show back instead, and a mid-switch save omits it.
    const activeShowIdForSave = activeShowIdForSaveRule(profile, activeStudioId, {
      ready: showsReady,
      selectedShowId: activeShowId,
    });

    const body: Parameters<typeof mutation.mutateAsync>[0] = {
      active_studio_id: activeStudioId,
      active_show_id: activeShowIdForSave,
      ...(isMemberView
        ? {}
        : { settings, show_updates: show_updates.length ? show_updates : undefined }),
    };

    if (profile.auth.logged_in) {
      body.given_name = givenName.trim();
      body.family_name = familyName.trim();
    }

    try {
      await mutation.mutateAsync(body);
      // Rebaseline: every field just submitted is now the saved state, so re-snapshot from
      // current form state to return Save to disabled/"Saved" (D11).
      setAccountSnapshot({ activeStudioId, defaultFps, givenName, familyName });
      // Only the shows scope that was actually ON SCREEN gets rebaselined. On an
      // account-only save made while the shows query is erroring or still in flight, the
      // drafts map is empty and means "unknown", not "saved as empty" — baselining it would
      // make the shows section read dirty the moment a retry finally delivered the real
      // drafts (review finding 2). Skipping is safe because `showsSnapshot` is keyed to the
      // studio, not to the open (review finding 1): `!showsReady` means no rebuild has run
      // for the selected studio yet, so whatever the snapshot holds — `null`, or an earlier
      // studio's baseline — is superseded by the rebuild that fires when the data lands.
      if (showsReady) {
        setShowsSnapshot({ activeShowId, showDrafts });
      }
      showToast('Saved.');
      if (activeStudioId !== prevStudioId) {
        onCloseSession();
      }
      // Sessions, events, status and show categories; both lazy show caches only when this
      // save carried `show_updates` (settingsModel `invalidateAfterProfileSave`).
      invalidateAfterProfileSave(queryClient, { showUpdates: Boolean(body.show_updates) });
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
      setShowsSnapshot((prev) =>
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
                // FIVE states now, not two: loading is distinct from empty
                // (profile-shows-slimming) — a studio's shows arrive over the
                // wire, so "— No shows —" must not be shown before the answer
                // is known — a failed fetch is distinct from loading, or the
                // picker claims to still be waiting on a request that already
                // came back, and an offline HOLD is distinct from both: the
                // request has not come back and is not on its way either.
                !showsReady
                  ? [
                      {
                        value: '',
                        label:
                          showsUnavailable === 'offline'
                            ? '— Offline —'
                            : showsUnavailable === 'error'
                              ? '— Unavailable —'
                              : 'Loading shows…',
                        disabled: true,
                      },
                    ]
                  : showsForStudio.length === 0
                    ? [{ value: '', label: '— No shows —', disabled: true }]
                    : showsForStudio.map((s) => ({
                        value: s.id,
                        label: s.name || s.show_code || s.id,
                      }))
              }
              disabled={!showsReady || showsForStudio.length === 0}
            />
          </div>
        </div>
        <div className="flex flex-nowrap items-center self-center shrink-0 gap-[0.2rem] min-h-[2.5rem]">
          {/* The reason lives on a wrapper: a disabled Button has pointer events off, so a title
              on the button itself would never show (shadcn-port-settings D2). */}
          <span className="inline-flex" title={dirty ? undefined : 'No unsaved changes'}>
            <Button
              className={TOUCH_TARGET}
              id="profile-save"
              // ui-refresh: disabled until something changed, so "is this saved?" is answerable
              // from the header at a glance (D11).
              // No `!showsReady` term any more (review finding 2): that made an unavailable
              // shows query brick account-only saves, which the save handler has always
              // supported. The property it protected — never submitting a drafts map that
              // does not belong to the selected studio — now lives in `showsDirty` (which
              // requires `showsReady`) and in `handleSave`, which omits `show_updates`
              // entirely rather than posting a partial one.
              disabled={mutation.isPending || !dirty}
              onClick={handleSave}
            >
              {mutation.isPending ? 'Saving…' : dirty ? 'Save' : 'Saved'}
            </Button>
          </span>
          {/* .toolbarClose had no rule of its own (its only rule was purged in Task 2). */}
          <Button
            variant="outline"
            className={TOUCH_TARGET}
            aria-label="Close"
            onClick={() => void handleRequestClose()}
          >
            Close
          </Button>
        </div>
      </div>

      {/* Tabs + content */}
      <Tabs value={activeTab} onValueChange={(v) => selectTab(v as TabId)} asChild>
        <section
          className={clsx('flex-[1_1_auto] min-h-0 flex flex-col overflow-hidden', TAB_VARS)}
        >
          {/* shadcn Tabs (shadcn-port-settings D1). Same stacking/overlap as the feed tabs:
            tablist under the panel (z-0 / z-1); -mb-2 tucks the panel under the tab bottoms;
            pt ≥ the active tab's cyan ::before glow so overflow-y:hidden doesn't clip it;
            overflow-x only on small screens. The lid chrome is the themed TabsTrigger. The
            explicit ids / aria-controls keep the v6-settings-* pairing (Radix spreads ours
            last). */}
          <TabsList
            aria-label="Settings sections"
            className="relative z-0 flex-none shrink-0 gap-[0.18rem] -mb-2 px-[0.15rem] pt-[14px] max-md:overflow-x-auto max-md:overflow-y-hidden max-md:[-webkit-overflow-scrolling:touch] max-md:[scrollbar-width:none]"
          >
            {tabs.map((tab) => (
              <TabsTrigger
                key={tab.id}
                value={tab.id}
                id={`v6-settings-tab-${tab.id}`}
                aria-controls={`v6-settings-section-${tab.id}`}
              >
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>

          {/* General tab */}
          <TabsContent
            value="general"
            forceMount
            id="v6-settings-section-general"
            className={SECTION_CLASS}
            aria-labelledby="v6-settings-tab-general"
            hidden={activeTab !== 'general'}
          >
            {/* Deferred mount (settings-modal-mount-cost, D2): only the wrapper above is
              unconditional (its id/role/aria-labelledby/hidden keep every aria-controls
              target resolvable and this tab's e2e surface intact) — the content below
              mounts once this tab has been visited and then stays mounted. */}
            {visitedTabs.has('general') && (
              <>
                {/* Show details (border-b-0 over the settings block's bottom border). */}
                {isMemberView ? (
                  <p className={clsx(HINT, 'mb-3')} id="profile-show-fields-member">
                    Only the team’s owner and admins can edit shows and team defaults.
                  </p>
                ) : currentDraft ? (
                  <div id="profile-show-fields" className={clsx(SETTINGS_BLOCK, 'border-b-0')}>
                    <div className={FIELDS_HEAD}>
                      <h2 className={SETTINGS_SUBHEAD}>Show Details</h2>
                    </div>
                    <div className={FIELDS_ROW}>
                      <Field className={FIELD_BASE}>
                        <FieldLabel htmlFor="profile-show-name">Name:</FieldLabel>
                        <Input
                          type="text"
                          id="profile-show-name"
                          className={HS_INPUT}
                          maxLength={200}
                          autoComplete="off"
                          value={currentDraft.name}
                          onChange={(e) => updateShowDraft({ name: e.target.value })}
                        />
                      </Field>
                      <Field className={FIELD_CODE}>
                        <FieldLabel htmlFor="profile-show-code">Code:</FieldLabel>
                        <Input
                          type="text"
                          id="profile-show-code"
                          className={clsx(HS_INPUT, 'font-mono')}
                          maxLength={40}
                          autoComplete="off"
                          spellCheck={false}
                          value={currentDraft.show_code}
                          onChange={(e) =>
                            updateShowDraft({ show_code: e.target.value.toUpperCase() })
                          }
                        />
                      </Field>
                      {/* session-title-suffix task 2.1: replaces the removed Next Ep counter
                    control. Maps to the show's `title_suffix` preference, which the
                    server uses to derive untitled-create titles (design D5-D8). */}
                      <Field className={FIELD_SUFFIX}>
                        <FieldLabel htmlFor="profile-show-suffix">Suffix:</FieldLabel>
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
                      </Field>
                      <Field className={FIELD_FPS}>
                        <FieldLabel htmlFor="profile-default-fps">Default Frame Rate:</FieldLabel>
                        <FpsSelect
                          id="profile-default-fps"
                          value={defaultFps}
                          onChange={setDefaultFps}
                        />
                      </Field>
                    </div>
                    {showAcronymWarn && (
                      <FieldDescription className="mb-[0.65rem]" id="profile-show-acronym-warn">
                        Tip: show code is usually initials of the show name (e.g.{' '}
                        {currentDraft.name.trim()} &rarr; {currentInitials}). Yours differs — that
                        is fine if intentional.
                      </FieldDescription>
                    )}
                  </div>
                ) : (
                  <>
                    <p className={clsx(HINT, 'mb-3')} id="profile-show-fields-placeholder">
                      {showsUnavailable === 'offline'
                        ? 'You’re offline — can’t load shows.'
                        : showsUnavailable === 'error'
                          ? 'Couldn’t load shows.'
                          : !showsReady
                            ? 'Loading shows…'
                            : showsForStudio.length === 0
                              ? 'No shows for this team yet. Add one below.'
                              : 'Select a show above to view details.'}
                    </p>
                    {/* ERROR only. It is the one way out of a FAILED fetch without
                      reopening the modal — `showsLoaded` never flips on an errored
                      query, so nothing else re-arms the section.

                      Deliberately NOT offered for the offline hold, where it would
                      be a dead control: `refetch()` on a paused query reaches
                      `Query#fetch` with `fetchStatus === 'paused'` and `data ===
                      undefined`, which takes the `retryer.continueRetry()` branch —
                      that only clears the retry-cancelled flag and hands back the
                      still-pending promise. No fetch starts. What actually resumes a
                      paused query is `onlineManager` firing on reconnect, which
                      continues the retryer's paused promise with or without a click,
                      so the honest affordance here is saying so. */}
                    {showsUnavailable === 'error' && (
                      <Button
                        variant="outline"
                        className={clsx(TOUCH_TARGET, 'mb-3')}
                        id="profile-shows-retry"
                        onClick={() => {
                          void studioShowsQuery.refetch();
                        }}
                      >
                        Retry
                      </Button>
                    )}
                    {showsUnavailable === 'offline' && (
                      <p className={clsx(HINT, 'mb-3')} id="profile-shows-offline-recovery">
                        Shows will load on their own once you’re back online.
                      </p>
                    )}
                  </>
                )}

                {/* Account section */}
                {profile?.auth.logged_in && profile.auth.user && (
                  <div
                    id="v6-settings-account"
                    className={clsx(SETTINGS_BLOCK, 'mt-5 pt-4 border-t border-v5-border')}
                  >
                    <div className={FIELDS_HEAD}>
                      <h2 className={SETTINGS_SUBHEAD}>Account</h2>
                    </div>
                    <div className={FIELDS_ROW}>
                      <Field className={FIELD_BASE}>
                        <FieldLabel htmlFor="profile-account-email">Account</FieldLabel>
                        <Input
                          type="email"
                          id="profile-account-email"
                          className={HS_INPUT}
                          disabled
                          autoComplete="username"
                          value={profile.auth.user.email}
                          readOnly
                        />
                      </Field>
                      <Field className={FIELD_BASE}>
                        <FieldLabel htmlFor="profile-account-given">First name</FieldLabel>
                        <Input
                          type="text"
                          id="profile-account-given"
                          className={HS_INPUT}
                          maxLength={200}
                          autoComplete="given-name"
                          value={givenName}
                          onChange={(e) => setGivenName(e.target.value)}
                        />
                      </Field>
                      <Field className={FIELD_BASE}>
                        <FieldLabel htmlFor="profile-account-family">Last name</FieldLabel>
                        <Input
                          type="text"
                          id="profile-account-family"
                          className={HS_INPUT}
                          maxLength={200}
                          autoComplete="family-name"
                          value={familyName}
                          onChange={(e) => setFamilyName(e.target.value)}
                        />
                      </Field>
                    </div>
                    {profile.auth.user.teams.length > 0 && (
                      <div className="mt-3">
                        <span className="text-v5-soft">Teams you can access</span>
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
                      {/* A real link (full-page logout), rendered as the destructive Button. */}
                      <Button variant="destructive" className={TOUCH_TARGET} asChild>
                        <a href="/auth/logout" id="profile-account-logout">
                          Log out
                        </a>
                      </Button>
                    </div>
                  </div>
                )}

                {/* Add new show (centered actions row with a top divider).
                  Not rendered in the member view (show-grants D13). */}
                {!isMemberView && (
                  <div className="flex flex-wrap items-center justify-center gap-[0.6rem] mt-5 pt-4 border-t border-v5-border">
                    <Button
                      variant="outline"
                      className={TOUCH_TARGET}
                      id="profile-show-add"
                      // `!showsReady` here as well as on `disabled`: the account init now
                      // commits the studio selection immediately (review finding 2), so
                      // `activeStudioId` alone no longer implies the shows section is usable —
                      // and offering Add-New-Show over a section that is still loading, or that
                      // failed to load, would advertise an action that cannot work.
                      hidden={
                        !showsReady || !activeStudioId || (profile?.studios ?? []).length === 0
                      }
                      // Creating a show while the studio's shows are still in
                      // flight would land the new draft in a map the rebuild
                      // effect is about to replace.
                      disabled={createShow.isPending || !showsReady}
                      onClick={handleAddShow}
                    >
                      {`Add New Show to ${(profile?.studios ?? []).find((s) => s.id === activeStudioId)?.name ?? 'this team'}`}
                    </Button>
                  </div>
                )}
              </>
            )}
          </TabsContent>

          {/* Event Buttons tab */}
          <TabsContent
            value="event-buttons"
            forceMount
            id="v6-settings-section-event-buttons"
            className={SECTION_CLASS}
            aria-labelledby="v6-settings-tab-event-buttons"
            hidden={activeTab !== 'event-buttons'}
          >
            {/* Deferred mount (settings-modal-mount-cost, D2/D3): this is the tab the change
              exists for — EventButtonsTable's per-row Radix Selects dominate the modal's
              mount cost, so this content only mounts once the tab has been activated. */}
            {visitedTabs.has('event-buttons') &&
              (isMemberView ? (
                <p className={HINT} id="event-buttons-member">
                  Only the team’s owner and admins can edit event buttons.
                </p>
              ) : currentDraft ? (
                <>
                  {/* .eventsIntro: margin-top 0 over the .modal-hint base.
                    ui-refresh: the old copy claimed slot colors and drag order "save
                    automatically" — they don't; every edit in this tab is a draft applied by
                    Save (updateShowDraft). Copy now matches the actual save model (D11). */}
                  <p className={clsx(HINT, 'mt-0')}>
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
                <p className={HINT}>
                  {showsUnavailable === 'offline'
                    ? 'You’re offline — can’t load shows.'
                    : showsUnavailable === 'error'
                      ? 'Couldn’t load shows.'
                      : showsReady
                        ? 'Select a show above to edit its event buttons.'
                        : 'Loading shows…'}
                </p>
              ))}
          </TabsContent>

          {/* Auto Sync tab */}
          <TabsContent
            value="autosync"
            forceMount
            id="v6-settings-section-autosync"
            className={SECTION_CLASS}
            aria-labelledby="v6-settings-tab-autosync"
            hidden={activeTab !== 'autosync'}
          >
            {/* Deferred mount (settings-modal-mount-cost, D2): this tab's own content is cheap
              (two <p>s) — deferred anyway so the discipline is uniform across all four tabs
              rather than special-cased per tab (see design D2's alternatives). */}
            {visitedTabs.has('autosync') && (
              <>
                <p className={HINT}>Coming soon.</p>
                {/* .autosyncHint: margin-top 0.35rem. */}
                <p className={clsx(HINT, 'mt-[0.35rem]')}>
                  When available, options here will use the team selected in the header above.
                </p>
              </>
            )}
          </TabsContent>

          {/* Debug tab */}
          <TabsContent
            value="debug"
            forceMount
            id="v6-settings-section-debug"
            className={SECTION_CLASS}
            aria-labelledby="v6-settings-tab-debug"
            hidden={activeTab !== 'debug'}
          >
            {/* Deferred mount (settings-modal-mount-cost, D2) — same uniform discipline as the
              other three tabs. */}
            {visitedTabs.has('debug') && (
              <>
                {/* .sectionLead: margin-top 0, margin-bottom 0.65rem. */}
                <p className={clsx(HINT, 'mt-0')}>
                  Lag and layout A/B toggles (saved in this browser).
                </p>
                <div id="v6-settings-perf-debug-mount" className="min-w-0" />
              </>
            )}
          </TabsContent>
        </section>
      </Tabs>

      {confirmElement}

      {/* Themed Add-Show dialog (ui-refresh: was window.prompt). */}
      <Dialog
        open={addShowOpen}
        onOpenChange={(o) => !o && setAddShowOpen(false)}
        title="Add show"
        description="You can update the show code and details after creating it."
      >
        <Field>
          <FieldLabel htmlFor="profile-show-add-name">Show name</FieldLabel>
          <Input
            type="text"
            className={HS_INPUT_OVERRIDE}
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
        </Field>
        <DialogActions>
          <Button variant="outline" className={TOUCH_TARGET} onClick={() => setAddShowOpen(false)}>
            Cancel
          </Button>
          <Button
            className={TOUCH_TARGET}
            disabled={createShow.isPending || newShowName.trim() === ''}
            onClick={() => void submitAddShow()}
          >
            {createShow.isPending ? 'Creating…' : 'Create show'}
          </Button>
        </DialogActions>
      </Dialog>
    </Dialog>
  );
}
