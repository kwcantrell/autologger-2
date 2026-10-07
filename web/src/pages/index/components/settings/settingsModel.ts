import type { QueryClient } from '@tanstack/react-query';
import { sessionStatusKeys } from '../../../../api/hooks/useSessionStatus';
import { showKeys } from '../../../../api/hooks/useShows';
import type { ProfilePayload, Show, ShowUpdateEntry } from '../../../../api/types';
import { normalizePalette9 } from '../../utils/palette9';
import type { EventButtonDraft } from '../EventButtonsTable';

// --- Settings save model (redesign-show-ignition D4) ---
//
// The rules the previous Settings dialog (`HomeSettingsModal`) applied when it built a profile
// write, lifted out unchanged so the Settings view's sections and the dialog (until task 10.1
// deletes it) share one copy:
//   - a show's draft and its `show_updates` entry (the category and option mapping, with the
//     `auto_instruction` trim gate);
//   - which show to select for a team, and which `active_show_id` a save echoes (an absent one
//     makes the server pick the team's FIRST show, so a careless save would switch shows);
//   - the team settings merge (the server replaces the `settings` blob wholesale);
//   - the shows query's unavailable states;
//   - the post-save invalidations.

export interface ShowDraft {
  name: string;
  show_code: string;
  title_suffix: 'date' | 'episode';
  categories: EventButtonDraft[];
  event_palette: string[];
  event_palette_preset: string;
  event_palette_custom: string[];
}

export function showToShowDraft(show: Show): ShowDraft {
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

/** `shows` comes from `useStudioShows(studioId)` and is already studio-scoped;
 * the filter stays as a belt against a cache entry ever being read under the
 * wrong key (profile-shows-slimming — the drafts used to be built from
 * `profile.shows`, which spanned every studio and HAD to be filtered). */
export function initDraftsForStudio(shows: Show[], studioId: string): Record<string, ShowDraft> {
  const result: Record<string, ShowDraft> = {};
  for (const s of shows) {
    if (s.studio_id === studioId) {
      result[s.id] = showToShowDraft(s);
    }
  }
  return result;
}

export const DEFAULT_FRAME_RATE = 24;

/** The team's default frame rate, from its settings blob on the profile. */
export function getDefaultFps(profile: ProfilePayload, studioId: string): number {
  const s = (profile.studio_settings?.[studioId] ?? {}) as { default_frame_rate?: number };
  return typeof s.default_frame_rate === 'number' ? s.default_frame_rate : DEFAULT_FRAME_RATE;
}

/**
 * The team settings blob to send for a frame-rate change. The server REPLACES the blob
 * wholesale, so the existing keys are carried over and only `default_frame_rate` changes.
 */
export function teamSettingsWithFps(
  profile: ProfilePayload,
  studioId: string,
  defaultFps: number,
): Record<string, unknown> {
  const existing = (profile.studio_settings?.[studioId] ?? {}) as Record<string, unknown>;
  return { ...existing, default_frame_rate: defaultFps };
}

/** The profile's active team, falling back to the first team (`''` with none). */
export function profileStudioId(profile: ProfilePayload | undefined): string {
  return profile ? (profile.active_studio_id ?? profile.studios[0]?.id ?? '') : '';
}

// Which show to select for a studio: the profile's actually-active show when the studio in
// question IS the profile's active studio, else that studio's first show. Shared by the init
// effect and handleStudioChange so re-selecting the originally-active studio reproduces the
// exact initial selection (D11: view-only selection round-tripping back must not read dirty).
export function pickShowIdForStudio(
  profile: ProfilePayload,
  shows: Show[],
  studioId: string,
): string {
  const showsForStudio = shows.filter((s) => s.studio_id === studioId);
  const isActiveStudio = studioId === (profile.active_studio_id ?? profile.studios[0]?.id ?? '');
  const preferredShow = isActiveStudio
    ? (showsForStudio.find((s) => s.id === profile.active_show_id) ?? showsForStudio[0])
    : showsForStudio[0];
  return preferredShow?.id ?? '';
}

/**
 * The `active_show_id` a profile write carries (web-ui-system "Honest save model in Settings").
 *
 * ABSENT `active_show_id` DOES NOT MEAN "leave unchanged". `server/src/routers/profile.ts` treats a
 * missing or blank field as a RESET (`nextShow = showsNow.length ? String(showsNow[0].id) : ''`),
 * re-pointing the caller at the team's FIRST show. So:
 *   - with the team's shows loaded (`shows.ready`), the selected show is sent; `undefined` only
 *     when the team genuinely has no shows, where the server's `''` fallback is right;
 *   - with the shows still loading or unavailable, the profile's own active show is echoed back,
 *     so a save of, say, a display name is a genuine no-op for the show selection;
 *   - mid-switch (the team being saved is not the profile's active team) it is omitted: the
 *     profile's show belongs to the OLD team and would 400 ("active_show_id must belong to the
 *     selected team"), and switching teams legitimately re-picks the show anyway.
 */
export function activeShowIdForSave(
  profile: ProfilePayload,
  studioId: string,
  shows: { ready: boolean; selectedShowId: string },
): string | undefined {
  if (shows.ready) return shows.selectedShowId || undefined;
  return studioId === profile.active_studio_id ? profile.active_show_id || undefined : undefined;
}

/** One show's `show_updates` entry: the whole show, from its draft. */
export function showDraftToUpdate(showId: string, draft: ShowDraft): ShowUpdateEntry {
  return {
    show_id: showId,
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
      dropdown_options: c.dropdown_options.map(({ label, needs_context, auto_instruction }) => ({
        label,
        needs_context,
        ...(auto_instruction?.trim() ? { auto_instruction: auto_instruction.trim() } : {}),
      })),
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
}

/**
 * An UNAVAILABLE shows fetch (web-ui-system "The Settings shows section says why it has nothing
 * to show"):
 *   'error'   — a FAILED fetch: the answer already came back, so "Loading shows…" would claim to
 *               wait on a request that is over.
 *   'offline' — a PAUSED fetch. With react-query's default `networkMode: 'online'`, going offline
 *               HOLDS the fetch, so `isPending` stays true and `isError` false indefinitely.
 *               Scoped to `isPending`: a paused BACKGROUND refetch over drafts already on screen
 *               withholds nothing, so it says nothing.
 * A DISABLED query (no team, so no studio id) never errors and never pauses: `null`.
 */
export function showsUnavailableState(
  query: { isError?: boolean; isPending?: boolean; fetchStatus?: string },
  studioId: string,
): 'error' | 'offline' | null {
  if (!studioId) return null;
  if (query.isError) return 'error';
  if (query.fetchStatus === 'paused' && query.isPending) return 'offline';
  return null;
}

/** The copy for each shows state the show-backed sections render. */
export const SHOWS_STATE_COPY = {
  offline: 'You’re offline — can’t load shows.',
  offlineRecovery: 'Shows will load on their own once you’re back online.',
  error: 'Couldn’t load shows.',
  loading: 'Loading shows…',
} as const;

/**
 * The caches a save that changed the active team, show or a show's configuration makes stale
 * (web-coordination-seam "The settings modal still refetches the session list"). The two show
 * roots are dropped only when the save carried `show_updates`: both are bare prefixes, so an
 * unconditional drop would refetch every show's config for a save that changed no show.
 */
export function invalidateAfterProfileSave(
  qc: Pick<QueryClient, 'invalidateQueries'>,
  { showUpdates }: { showUpdates: boolean },
): void {
  qc.invalidateQueries({ queryKey: ['sessions'] });
  qc.invalidateQueries({ queryKey: ['events'] });
  qc.invalidateQueries({ queryKey: sessionStatusKeys.all() });
  // A save can rename/delete categories; without this, an open session's button strip keeps
  // serving stale ones for its 30s staleTime (design D4).
  qc.invalidateQueries({ queryKey: ['show-categories'] });
  if (showUpdates) {
    qc.invalidateQueries({ queryKey: showKeys.allStudios() });
    qc.invalidateQueries({ queryKey: showKeys.all() });
  }
}
