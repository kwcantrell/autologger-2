import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { useStudioShows } from '../../../../api/hooks/useShows';
import type { ProfilePayload, Show } from '../../../../api/types';
import type { SettingsSectionId } from './sections';
import { useSettingsSectionGuard } from './settingsGuard';
import {
  initDraftsForStudio,
  pickShowIdForStudio,
  profileStudioId,
  type ShowDraft,
  showsUnavailableState,
} from './settingsModel';

// --- The Settings view's data scopes (redesign-show-ignition D4) ---
//
// web-ui-system "The Settings modal costs nothing while closed" and "Settings modal defers inactive
// tab content": the VIEW owns the show drafts' saved baseline, so a section's save writes the same
// thing whichever other sections were visited, and the view (mounted only while open) is what gates
// the shows query. Each inline section owns its own slice of edits (`useInlineDraft`), compared
// against its snapshot to derive dirtiness.

export interface SettingsShowsScope {
  /** The active team the show-backed sections edit (`''` with no team). */
  studioId: string;
  /** The team's shows, full config, as the query last served them. */
  shows: Show[];
  /** True once the baseline belongs to `studioId` (always, for a team-less account). */
  ready: boolean;
  /** Why the shows are unavailable, when they are (never for a disabled query). */
  unavailable: 'error' | 'offline' | null;
  /** Re-issue a failed shows query. */
  retry: () => void;
  /** Each show's SAVED state, built once per team from the query and patched by saves. */
  baseline: Record<string, ShowDraft>;
  /** The show the sections edit: the profile's active show, else the team's first. */
  activeShowId: string;
  /** Record a show's saved state after a successful save. */
  commitShow: (showId: string, draft: ShowDraft) => void;
}

/**
 * The shows scope, called by the Settings view. The baseline is built ONCE per team, when that
 * team's shows first arrive, so a refetch (after a save, on window focus) never rewrites it under
 * unsaved edits; shows that appear later (a show added from Shows) are added without touching the
 * rest. Built during render, not in an effect, so there is no frame between "shows arrived" and
 * "drafts built".
 */
export function useSettingsShowsScopeState(
  profile: ProfilePayload | undefined,
): SettingsShowsScope {
  const studioId = profileStudioId(profile);
  const query = useStudioShows(studioId || null);
  const shows = useMemo(() => query.data?.shows ?? [], [query.data]);
  // A team-less account never fetches, so it is "loaded, empty" as soon as the profile is here.
  const loaded = Boolean(profile) && (studioId === '' || query.isSuccess);

  const [built, setBuilt] = useState<{
    studioId: string;
    drafts: Record<string, ShowDraft>;
  } | null>(null);
  if (loaded && built?.studioId !== studioId) {
    setBuilt({ studioId, drafts: initDraftsForStudio(shows, studioId) });
  } else if (loaded && built) {
    const added = shows.filter((s) => s.studio_id === studioId && !(s.id in built.drafts));
    if (added.length > 0) {
      setBuilt({
        studioId,
        drafts: { ...built.drafts, ...initDraftsForStudio(added, studioId) },
      });
    }
  }
  const ready = built?.studioId === studioId;

  const commitShow = useCallback((showId: string, draft: ShowDraft) => {
    setBuilt((prev) => (prev ? { ...prev, drafts: { ...prev.drafts, [showId]: draft } } : prev));
  }, []);
  const { refetch } = query;
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);

  const unavailable = ready ? null : showsUnavailableState(query, studioId);
  const activeShowId = ready && profile ? pickShowIdForStudio(profile, shows, studioId) : '';
  const baseline = ready && built ? built.drafts : EMPTY_DRAFTS;

  return useMemo(
    () => ({
      studioId,
      shows,
      ready,
      unavailable,
      retry,
      baseline,
      activeShowId,
      commitShow,
    }),
    [studioId, shows, ready, unavailable, retry, baseline, activeShowId, commitShow],
  );
}

const EMPTY_DRAFTS: Record<string, ShowDraft> = {};

export const SettingsShowsContext = createContext<SettingsShowsScope | null>(null);

export function useSettingsShows(): SettingsShowsScope {
  const scope = useContext(SettingsShowsContext);
  if (!scope) throw new Error('useSettingsShows must be used inside the Settings view.');
  return scope;
}

export interface InlineDraft<T> {
  /** The current edits, or `null` until the section's source is available. */
  value: T | null;
  /** The saved state the edits are compared against. */
  baseline: T | null;
  dirty: boolean;
  update: (patch: Partial<T>) => void;
  /** Record what was just saved as the new baseline (a partial save passes just its part). */
  markSaved: (saved: Partial<T>) => void;
}

/**
 * One inline section's slice (design D4): edits plus the snapshot they are compared against.
 * It initialises from `source` once per `key` (an open, a team, a show) and never re-reads it
 * otherwise, so a refetch cannot clobber edits. Dirtiness is derived, never hand-armed, and is
 * reported to the view's discard guard; a confirmed discard resets the edits to the snapshot.
 */
export function useInlineDraft<T extends object>(
  sectionId: SettingsSectionId,
  key: string | null,
  source: T | null,
): InlineDraft<T> {
  const [state, setState] = useState<{ key: string; baseline: T; value: T } | null>(null);
  if (key !== null && source !== null && state?.key !== key) {
    setState({ key, baseline: source, value: source });
  }
  const current = key !== null && state?.key === key ? state : null;
  const dirty =
    current !== null && JSON.stringify(current.value) !== JSON.stringify(current.baseline);

  useSettingsSectionGuard(sectionId, dirty, () =>
    setState((s) => (s ? { ...s, value: s.baseline } : s)),
  );

  const update = useCallback(
    (patch: Partial<T>) => setState((s) => (s ? { ...s, value: { ...s.value, ...patch } } : s)),
    [],
  );
  const markSaved = useCallback(
    (saved: Partial<T>) =>
      setState((s) => (s ? { ...s, baseline: { ...s.baseline, ...saved } } : s)),
    [],
  );

  return {
    value: current?.value ?? null,
    baseline: current?.baseline ?? null,
    dirty,
    update,
    markSaved,
  };
}
