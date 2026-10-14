import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, apiFetch } from '../client';
import type {
  WikiGenerateResponse,
  WikiSuggestion,
  WikiSuggestionAcceptBody,
  WikiSuggestionAcceptResponse,
  WikiSuggestionDetail,
  WikiSuggestionListResponse,
  WikiSuggestionResolvedConflict,
} from '../types';
import {
  onWikiConflict,
  settlePage,
  type WikiSuggestionFilters,
  wikiKeys,
  wireSuggestionFilters,
} from './useWiki';

// --- Wiki suggestion hooks (show-wiki-ai D6; show-wiki "Suggestions inbox") ---
//
// The frozen routes (api-contract-freeze "Wiki update endpoint", "Wiki suggestion list, read,
// accept and dismiss endpoints"):
//   - `GET shows/:showId/wiki/suggestions[?status&page_id]` and `GET wiki/suggestions/:id`;
//   - `POST wiki/suggestions/:id/accept` and `…/dismiss`;
//   - `POST sessions/:sessionId/wiki/generate`.
// The keys live on `wikiKeys` under the wiki root. Accept and dismiss refresh the suggestions, the
// page and the page list; generate refreshes the suggestions. A stale accept's `409 Version
// conflict.` is handled as every wiki write's is (`current` goes into the page cache) and reaches
// the caller, who reads it with `wikiVersionConflictOf` and redraws against the newer revision.

export type { WikiSuggestionFilters } from './useWiki';

/** The `shows/:showId/wiki/suggestions[?…]` path for these filters. */
export function wikiSuggestionsPath(showId: string, filters?: WikiSuggestionFilters): string {
  const f = wireSuggestionFilters(filters);
  const params = new URLSearchParams();
  if (f.status) params.set('status', f.status);
  if (f.page_id) params.set('page_id', f.page_id);
  const qs = params.toString();
  return `shows/${showId}/wiki/suggestions${qs ? `?${qs}` : ''}`;
}

/** The typed body of a `409 Suggestion already resolved.`, else `null`. */
export function wikiSuggestionResolvedOf(e: unknown): WikiSuggestionResolvedConflict | null {
  if (!(e instanceof ApiError) || e.status !== 409) return null;
  const body = e.body as { detail?: unknown; status?: unknown } | null | undefined;
  if (body?.detail !== 'Suggestion already resolved.' || typeof body.status !== 'string') {
    return null;
  }
  return body as WikiSuggestionResolvedConflict;
}

export function useWikiSuggestions(showId: string | null, filters?: WikiSuggestionFilters) {
  return useQuery({
    queryKey: wikiKeys.suggestions(showId ?? '', filters),
    queryFn: ({ signal }) =>
      apiFetch<WikiSuggestionListResponse>(wikiSuggestionsPath(showId ?? '', filters), { signal }),
    enabled: Boolean(showId),
  });
}

export function useWikiSuggestion(suggestionId: string | null) {
  return useQuery({
    queryKey: wikiKeys.suggestion(suggestionId ?? ''),
    queryFn: ({ signal }) =>
      apiFetch<WikiSuggestionDetail>(`wiki/suggestions/${suggestionId}`, { signal }),
    enabled: Boolean(suggestionId),
  });
}

/** Refresh one suggestion and its show's lists (and, when known, its target page). */
function settleSuggestion(qc: QueryClient, s: WikiSuggestion) {
  void qc.invalidateQueries({ queryKey: wikiKeys.suggestion(s.id) });
  void qc.invalidateQueries({ queryKey: wikiKeys.suggestions(s.show_id) });
  void qc.invalidateQueries({ queryKey: wikiKeys.list(s.show_id) });
  if (s.page_id) void qc.invalidateQueries({ queryKey: wikiKeys.page(s.page_id) });
}

/** Any other `409` (resolved, merged, deleted, a clash) means the cached suggestion is out of date. */
function onSuggestionConflict(qc: QueryClient, suggestionId: string, error: unknown) {
  if (!(error instanceof ApiError) || error.status !== 409) return;
  void qc.invalidateQueries({ queryKey: wikiKeys.suggestion(suggestionId) });
  void qc.invalidateQueries({ queryKey: wikiKeys.allSuggestions() });
}

export function useAcceptWikiSuggestion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      suggestionId,
      body,
    }: {
      suggestionId: string;
      body: WikiSuggestionAcceptBody;
    }) =>
      apiFetch<WikiSuggestionAcceptResponse>(`wiki/suggestions/${suggestionId}/accept`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: ({ page, suggestion }) => {
      settlePage(qc, page);
      settleSuggestion(qc, { ...suggestion, page_id: page.id });
    },
    onError: (error, { suggestionId }) => {
      onWikiConflict(qc)(error);
      onSuggestionConflict(qc, suggestionId, error);
    },
  });
}

export function useDismissWikiSuggestion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ suggestionId }: { suggestionId: string }) =>
      apiFetch<WikiSuggestion>(`wiki/suggestions/${suggestionId}/dismiss`, { method: 'POST' }),
    onSuccess: (suggestion) => settleSuggestion(qc, suggestion),
    onError: (error, { suggestionId }) => onSuggestionConflict(qc, suggestionId, error),
  });
}

/**
 * Run the session's wiki update and refresh every suggestion list. The hook-free form, for the
 * session workspace, whose tests stub the query client to `useQueryClient` alone (as
 * `SessionWikiButton` does); `useGenerateWiki` wraps it.
 */
export async function generateWiki(
  qc: QueryClient,
  sessionId: string,
): Promise<WikiGenerateResponse> {
  const out = await apiFetch<WikiGenerateResponse>(`sessions/${sessionId}/wiki/generate`, {
    method: 'POST',
  });
  void qc.invalidateQueries({ queryKey: wikiKeys.allSuggestions() });
  return out;
}

export function useGenerateWiki(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => generateWiki(qc, sessionId) });
}
