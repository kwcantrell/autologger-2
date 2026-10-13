import {
  type QueryClient,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { apiFetch } from '../client';
import type {
  WikiKind,
  WikiMergeBody,
  WikiMergeResponse,
  WikiPage,
  WikiPageCreateBody,
  WikiPageListResponse,
  WikiPageUpdateBody,
  WikiRevision,
  WikiRevisionListResponse,
  WikiSplitBody,
  WikiSplitResponse,
  WikiVersionConflict,
} from '../types';
import { versionConflictOf } from '../versionConflict';

// --- Show wiki hooks (show-wiki D7) ---
//
// The frozen routes (api-contract-freeze "Wiki …" requirements):
//   - `GET/POST shows/:showId/wiki/pages` list and create;
//   - `GET/PUT/DELETE wiki/pages/:pageId`, `POST …/restore`, `…/merge`, `…/split`;
//   - `GET wiki/pages/:pageId/revisions` (paged backwards by `before`) and `…/revisions/:rev`.
// Every write carries `expected_revision`; a stale one answers `409 Version conflict.` with the
// page at its current revision. On that 409 the hooks write `current` into the page cache and
// invalidate it (the cache holds server truth; the person's text lives in their draft), then the
// error still reaches the caller, who reads it with `wikiVersionConflictOf`.

export interface WikiPageFilters {
  kind?: WikiKind;
  sessionId?: string;
  /** List deleted pages instead of live ones. */
  deleted?: boolean;
}

/** The filters as the server spells them, empty ones dropped (one cache entry per filter set). */
function wireFilters({ kind, sessionId, deleted }: WikiPageFilters = {}) {
  return {
    ...(kind ? { kind } : {}),
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(deleted ? { deleted: true as const } : {}),
  };
}

/**
 * Query keys. Revisions nest under their page, so invalidating a page refreshes its history too.
 * `list(showId)` (no filters) is a prefix of every filtered list of that show.
 */
export const wikiKeys = {
  all: () => ['wikiPages'] as const,
  list: (showId: string, filters?: WikiPageFilters) =>
    ['wikiPages', 'list', showId, wireFilters(filters)] as const,
  page: (pageId: string) => ['wikiPages', 'page', pageId] as const,
  revisions: (pageId: string) => ['wikiPages', 'page', pageId, 'revisions'] as const,
  revision: (pageId: string, revision: number) =>
    ['wikiPages', 'page', pageId, 'revisions', revision] as const,
};

/** The `shows/:showId/wiki/pages[?…]` path for these filters. */
export function wikiPagesPath(showId: string, filters?: WikiPageFilters): string {
  const f = wireFilters(filters);
  const params = new URLSearchParams();
  if (f.kind) params.set('kind', f.kind);
  if (f.session_id) params.set('session_id', f.session_id);
  if (f.deleted) params.set('deleted', '1');
  const qs = params.toString();
  return `shows/${showId}/wiki/pages${qs ? `?${qs}` : ''}`;
}

/** The typed body of a wiki `409 Version conflict.`, else `null`. */
export function wikiVersionConflictOf(e: unknown): WikiVersionConflict | null {
  return versionConflictOf<WikiVersionConflict>(e, 'revision');
}

export function useWikiPages(showId: string | null, filters?: WikiPageFilters) {
  return useQuery({
    queryKey: wikiKeys.list(showId ?? '', filters),
    queryFn: ({ signal }) =>
      apiFetch<WikiPageListResponse>(wikiPagesPath(showId ?? '', filters), { signal }),
    enabled: Boolean(showId),
  });
}

export function useWikiPage(pageId: string | null) {
  return useQuery({
    queryKey: wikiKeys.page(pageId ?? ''),
    queryFn: ({ signal }) => apiFetch<WikiPage>(`wiki/pages/${pageId}`, { signal }),
    enabled: Boolean(pageId),
  });
}

/** History, newest first; `fetchNextPage` ("Load older") follows `next_before`. */
export function useWikiRevisions(pageId: string | null) {
  return useInfiniteQuery({
    queryKey: wikiKeys.revisions(pageId ?? ''),
    queryFn: ({ pageParam, signal }) =>
      apiFetch<WikiRevisionListResponse>(
        `wiki/pages/${pageId}/revisions${pageParam == null ? '' : `?before=${pageParam}`}`,
        { signal },
      ),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.next_before,
    enabled: Boolean(pageId),
  });
}

export function useWikiRevision(pageId: string | null, revision: number | null) {
  return useQuery({
    queryKey: wikiKeys.revision(pageId ?? '', revision ?? 0),
    queryFn: ({ signal }) =>
      apiFetch<WikiRevision>(`wiki/pages/${pageId}/revisions/${revision}`, { signal }),
    enabled: Boolean(pageId) && revision != null,
    // A revision never changes once written.
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** Store a page the server returned and refresh it, its history and its show's lists. */
function settlePage(qc: QueryClient, page: WikiPage) {
  qc.setQueryData(wikiKeys.page(page.id), page);
  void qc.invalidateQueries({ queryKey: wikiKeys.page(page.id) });
  void qc.invalidateQueries({ queryKey: wikiKeys.list(page.show_id) });
}

function onWikiConflict(qc: QueryClient) {
  return (error: unknown) => {
    const conflict = wikiVersionConflictOf(error);
    if (!conflict) return;
    const { current } = conflict;
    qc.setQueryData(wikiKeys.page(current.id), current);
    // Not awaited: the caller's conflict prompt must not wait for the refetch.
    void qc.invalidateQueries({ queryKey: wikiKeys.page(current.id) });
  };
}

export function useCreateWikiPage(showId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: WikiPageCreateBody) =>
      apiFetch<WikiPage>(`shows/${showId}/wiki/pages`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: (page) => {
      qc.setQueryData(wikiKeys.page(page.id), page);
      void qc.invalidateQueries({ queryKey: wikiKeys.list(showId) });
    },
  });
}

export function useUpdateWikiPage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ pageId, body }: { pageId: string; body: WikiPageUpdateBody }) =>
      apiFetch<WikiPage>(`wiki/pages/${pageId}`, { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: (page) => settlePage(qc, page),
    onError: onWikiConflict(qc),
  });
}

export function useDeleteWikiPage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ pageId, expectedRevision }: { pageId: string; expectedRevision: number }) =>
      apiFetch<WikiPage>(`wiki/pages/${pageId}?expected_revision=${expectedRevision}`, {
        method: 'DELETE',
      }),
    onSuccess: (page) => settlePage(qc, page),
    onError: onWikiConflict(qc),
  });
}

export function useRestoreWikiPage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ pageId, expectedRevision }: { pageId: string; expectedRevision: number }) =>
      apiFetch<WikiPage>(`wiki/pages/${pageId}/restore`, {
        method: 'POST',
        body: JSON.stringify({ expected_revision: expectedRevision }),
      }),
    onSuccess: (page) => settlePage(qc, page),
    onError: onWikiConflict(qc),
  });
}

/** Merge `pageId` into `body.into_page_id`; answers the target. Both pages change. */
export function useMergeWikiPage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ pageId, body }: { pageId: string; body: WikiMergeBody }) =>
      apiFetch<WikiMergeResponse>(`wiki/pages/${pageId}/merge`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: ({ page }, { pageId }) => {
      void qc.invalidateQueries({ queryKey: wikiKeys.page(pageId) });
      settlePage(qc, page);
    },
    onError: onWikiConflict(qc),
  });
}

/** Split part of `pageId`'s body into a new page; answers both. */
export function useSplitWikiPage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ pageId, body }: { pageId: string; body: WikiSplitBody }) =>
      apiFetch<WikiSplitResponse>(`wiki/pages/${pageId}/split`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: ({ page, new_page }) => {
      qc.setQueryData(wikiKeys.page(new_page.id), new_page);
      settlePage(qc, page);
    },
    onError: onWikiConflict(qc),
  });
}
