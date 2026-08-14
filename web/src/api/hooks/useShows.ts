import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../client';
import type { Show } from '../types';

// Lazy full-show config (profile-shows-slimming). `/api/profile` carries only
// `ShowBrief` entries now, so the two surfaces that need a show's categories
// and palettes fetch them here instead — both from closed-by-default modals,
// so nothing loads until a modal opens.
//
// Both hooks mirror `useShowCategories`: `enabled` on the id so a null id
// never fires a request, and a 30s `staleTime` so reopening a modal inside
// that window is free. That staleness window is why `HomeSettingsModal`'s save
// path invalidates BOTH keys below alongside `show-categories` — without it,
// the generate modal could render categories the user just edited away.

/**
 * Query-key factory for the two show domains this module owns — the single
 * owner of the `'studio-shows'` and `'show'` literals, guarded by
 * `queryKeyFactories.repo.test.ts` (the `sessionStatusKeys`/`audioSegmentsKeys`
 * idiom). The bare-prefix members (`allStudios()`, `all()`) exist for
 * invalidation via React Query prefix matching — `HomeSettingsModal` drops both
 * roots after a save that carried `show_updates`, and `useCreateShow` drops the
 * studio list after a create.
 */
export const showKeys = {
  allStudios: () => ['studio-shows'] as const,
  byStudio: (studioId: string | null) => ['studio-shows', studioId] as const,
  all: () => ['show'] as const,
  byId: (showId: string | null) => ['show', showId] as const,
};

/** Every show in one studio, full config — one request per studio switch,
 * rather than N per-show requests. `GET /api/shows?studio_id=…`. */
export function useStudioShows(studioId: string | null) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: showKeys.byStudio(studioId),
    queryFn: async () => {
      const data = await apiFetch<{ shows: Show[] }>(
        `shows?studio_id=${encodeURIComponent(studioId ?? '')}`,
      );
      // Seed the per-show cache from the list response: `GET /api/shows?studio_id=`
      // already carries each show's FULL config, in exactly the `{ show }` shape
      // `useShow` serves, so a subsequent `useShow(id)` for a listed show is a
      // cache hit rather than a second request for bytes already in hand
      // (EventGenerateCustomModal opening over a studio the settings modal
      // already listed). Written from the queryFn, not a `useQuery` callback:
      // v5 removed per-query `onSuccess`, and doing it here runs it exactly
      // once per real fetch. The write refreshes `dataUpdatedAt`, so the seeded
      // entries carry the same 30s staleTime window as the list itself.
      for (const show of data.shows) qc.setQueryData(showKeys.byId(show.id), { show });
      return data;
    },
    enabled: Boolean(studioId),
    staleTime: 30_000,
  });
}

/** One show's full config, by id, without knowing its studio —
 * `GET /api/shows/:showId` (404s for a show the caller cannot reach). */
export function useShow(showId: string | null) {
  return useQuery({
    queryKey: showKeys.byId(showId),
    queryFn: () => apiFetch<{ show: Show }>(`shows/${showId}`),
    enabled: Boolean(showId),
    staleTime: 30_000,
  });
}
