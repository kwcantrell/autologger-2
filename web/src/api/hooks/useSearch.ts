import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../client';
import type { SearchResponse } from '../types';

// --- Catalog search (catalog-search D7, D9) ---
//
// `GET /api/search`. The server bounds the cost (one 3 s statement, two searches at once); the
// client keeps its side small:
//   - no request below 2 characters (or above 200) after trimming, the server's own `q` bounds;
//   - `retry: false`: a 503 (timed out or busy) is an answer to show, and retrying it would only
//     take another of the two search slots;
//   - react-query's AbortSignal goes to the fetch, so a superseded query is cancelled.
// Empty filters are omitted: the server treats `studio_id=` as an id, not as "no filter".

export const SEARCH_Q_MIN = 2;
export const SEARCH_Q_MAX = 200;

export interface SearchParams {
  q: string;
  studioId?: string;
  showId?: string;
  limit?: number;
}

export const searchKeys = {
  all: () => ['search'] as const,
  query: ({ q, studioId, showId, limit }: SearchParams) =>
    ['search', q.trim(), studioId || null, showId || null, limit ?? null] as const,
};

/** The `search?…` path for these parameters (trimmed `q`, empty filters left out). */
export function searchPath({ q, studioId, showId, limit }: SearchParams): string {
  const params = new URLSearchParams({ q: q.trim() });
  if (studioId) params.set('studio_id', studioId);
  if (showId) params.set('show_id', showId);
  if (limit != null) params.set('limit', String(limit));
  return `search?${params.toString()}`;
}

/** Whether `q` is long enough (and short enough) to send. */
export function isSearchableQuery(q: string): boolean {
  const n = q.trim().length;
  return n >= SEARCH_Q_MIN && n <= SEARCH_Q_MAX;
}

export function useSearch(params: SearchParams) {
  return useQuery({
    queryKey: searchKeys.query(params),
    queryFn: ({ signal }) => apiFetch<SearchResponse>(searchPath(params), { signal }),
    enabled: isSearchableQuery(params.q),
    retry: false,
    staleTime: 30_000,
  });
}
