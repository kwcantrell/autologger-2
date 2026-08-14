import { useQuery } from '@tanstack/react-query';
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

/** Every show in one studio, full config — one request per studio switch,
 * rather than N per-show requests. `GET /api/shows?studio_id=…`. */
export function useStudioShows(studioId: string | null) {
  return useQuery({
    queryKey: ['studio-shows', studioId],
    queryFn: () =>
      apiFetch<{ shows: Show[] }>(`shows?studio_id=${encodeURIComponent(studioId ?? '')}`),
    enabled: Boolean(studioId),
    staleTime: 30_000,
  });
}

/** One show's full config, by id, without knowing its studio —
 * `GET /api/shows/:showId` (404s for a show the caller cannot reach). */
export function useShow(showId: string | null) {
  return useQuery({
    queryKey: ['show', showId],
    queryFn: () => apiFetch<{ show: Show }>(`shows/${showId}`),
    enabled: Boolean(showId),
    staleTime: 30_000,
  });
}
