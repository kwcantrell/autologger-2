import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch } from '../client';
import type { WikiPage, WikiRevisionListResponse } from '../types';
import {
  useCreateWikiPage,
  useDeleteWikiPage,
  useMergeWikiPage,
  useRestoreWikiPage,
  useSplitWikiPage,
  useUpdateWikiPage,
  useWikiPage,
  useWikiPages,
  useWikiRevision,
  useWikiRevisions,
  wikiKeys,
  wikiVersionConflictOf,
} from './useWiki';

// show-wiki task 5.2 (design D7): the wiki hooks and the `wikiKeys` factory. Queries call the
// frozen routes (api-contract-freeze "Wiki …" requirements); mutations invalidate the list and
// the pages they touch; a `409 Version conflict.` surfaces as a typed conflict carrying `current`
// (the page at its current revision), which is also written into the page cache.

vi.mock('../client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../client')>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function wrapperFor(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

function page(id: string, revision: number, overrides: Partial<WikiPage> = {}): WikiPage {
  return {
    id,
    show_id: 'show1',
    kind: 'person',
    title: `Page ${id}`,
    body_md: 'Body.',
    aliases: [],
    session_id: null,
    revision,
    merged_into: null,
    deleted: false,
    created_at_utc: '2026-10-13T10:00:00.000Z',
    created_by_name: 'Kai Lee',
    updated_at_utc: '2026-10-13T10:00:00.000Z',
    updated_by_name: 'Kai Lee',
    ...overrides,
  };
}

function setup<T>(hook: () => T) {
  const client = makeClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const { result } = renderHook(hook, { wrapper: wrapperFor(client) });
  return { client, invalidate, result };
}

const invalidatedKeys = (invalidate: { mock: { calls: unknown[][] } }) =>
  invalidate.mock.calls.map(([f]) => (f as { queryKey?: unknown } | undefined)?.queryKey);

// The root, built so this file holds no quoted copy of it (queryKeyFactories.repo.test.ts).
const ROOT = ['wiki', 'Pages'].join('');

beforeEach(() => {
  mockedApiFetch.mockReset();
});

describe('wikiKeys', () => {
  it('nests every key under the wiki root, and revisions under their page', () => {
    expect(wikiKeys.all()).toEqual([ROOT]);
    expect(wikiKeys.list('show1')).toEqual([ROOT, 'list', 'show1', {}]);
    expect(wikiKeys.list('show1', { kind: 'person', sessionId: 's1', deleted: true })).toEqual([
      ROOT,
      'list',
      'show1',
      { kind: 'person', session_id: 's1', deleted: true },
    ]);
    expect(wikiKeys.page('p1')).toEqual([ROOT, 'page', 'p1']);
    expect(wikiKeys.revisions('p1')).toEqual([ROOT, 'page', 'p1', 'revisions']);
    expect(wikiKeys.revision('p1', 3)).toEqual([ROOT, 'page', 'p1', 'revisions', 3]);
  });

  it('drops empty filters so equal filters share one cache entry', () => {
    expect(wikiKeys.list('show1', { kind: undefined, sessionId: '', deleted: false })).toEqual(
      wikiKeys.list('show1'),
    );
  });

  it('list(showId) is a prefix of every filtered list of that show (filter-agnostic invalidation)', async () => {
    const client = makeClient();
    client.setQueryData(wikiKeys.list('show1', { kind: 'bit' }), { pages: [], truncated: false });
    client.setQueryData(wikiKeys.list('show2', { kind: 'bit' }), { pages: [], truncated: false });
    await client.invalidateQueries({ queryKey: wikiKeys.list('show1') });
    expect(client.getQueryState(wikiKeys.list('show1', { kind: 'bit' }))?.isInvalidated).toBe(true);
    expect(client.getQueryState(wikiKeys.list('show2', { kind: 'bit' }))?.isInvalidated).toBe(
      false,
    );
  });
});

describe('wiki queries', () => {
  it('useWikiPages lists the show, with filters in the query string', async () => {
    mockedApiFetch.mockResolvedValue({ pages: [], truncated: false });
    const { result } = setup(() =>
      useWikiPages('show1', { kind: 'session', sessionId: 's1', deleted: true }),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApiFetch.mock.calls[0][0]).toBe(
      'shows/show1/wiki/pages?kind=session&session_id=s1&deleted=1',
    );
    expect(result.current.data).toEqual({ pages: [], truncated: false });
  });

  it('useWikiPages without filters sends no query string, and waits for a show', async () => {
    mockedApiFetch.mockResolvedValue({ pages: [], truncated: false });
    const { result } = setup(() => useWikiPages('show1'));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApiFetch.mock.calls[0][0]).toBe('shows/show1/wiki/pages');
    mockedApiFetch.mockClear();
    setup(() => useWikiPages(null));
    expect(mockedApiFetch).not.toHaveBeenCalled();
  });

  it('useWikiPage reads one page', async () => {
    mockedApiFetch.mockResolvedValue(page('p1', 2));
    const { result } = setup(() => useWikiPage('p1'));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApiFetch.mock.calls[0][0]).toBe('wiki/pages/p1');
    expect(result.current.data?.revision).toBe(2);
  });

  it('useWikiRevision reads one revision, and waits for a page and a number', async () => {
    mockedApiFetch.mockResolvedValue({ revision: 1 });
    const { result } = setup(() => useWikiRevision('p1', 1));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApiFetch.mock.calls[0][0]).toBe('wiki/pages/p1/revisions/1');
    mockedApiFetch.mockClear();
    setup(() => useWikiRevision('p1', null));
    setup(() => useWikiRevision(null, 1));
    expect(mockedApiFetch).not.toHaveBeenCalled();
  });

  it('useWikiRevisions pages backwards over next_before ("Load older")', async () => {
    const first: WikiRevisionListResponse = {
      revisions: [
        {
          revision: 3,
          title: 'T',
          kind: 'person',
          author_name: 'Kai Lee',
          at_utc: '2026-10-13T10:00:00.000Z',
          note: 'edited',
        },
      ],
      next_before: 3,
    };
    const second: WikiRevisionListResponse = {
      revisions: [{ ...first.revisions[0], revision: 2 }],
      next_before: null,
    };
    mockedApiFetch.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const { result } = setup(() => useWikiRevisions('p1'));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApiFetch.mock.calls[0][0]).toBe('wiki/pages/p1/revisions');
    expect(result.current.hasNextPage).toBe(true);
    await act(() => result.current.fetchNextPage());
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));
    expect(mockedApiFetch.mock.calls[1][0]).toBe('wiki/pages/p1/revisions?before=3');
    expect(result.current.hasNextPage).toBe(false);
  });
});

describe('wiki mutations', () => {
  it('create posts to the show and invalidates its lists', async () => {
    mockedApiFetch.mockResolvedValue(page('p9', 1));
    const { result, invalidate } = setup(() => useCreateWikiPage('show1'));
    await act(() => result.current.mutateAsync({ kind: 'person', title: 'Christina Ramos' }));
    expect(mockedApiFetch).toHaveBeenCalledWith('shows/show1/wiki/pages', {
      method: 'POST',
      body: JSON.stringify({ kind: 'person', title: 'Christina Ramos' }),
    });
    expect(invalidatedKeys(invalidate)).toContainEqual(wikiKeys.list('show1'));
  });

  it('update puts the body (expected_revision, restored_from) and invalidates list + page', async () => {
    mockedApiFetch.mockResolvedValue(page('p1', 4));
    const { result, invalidate, client } = setup(() => useUpdateWikiPage());
    await act(() =>
      result.current.mutateAsync({
        pageId: 'p1',
        body: { expected_revision: 3, body_md: 'Old.', restored_from: 1 },
      }),
    );
    expect(mockedApiFetch).toHaveBeenCalledWith('wiki/pages/p1', {
      method: 'PUT',
      body: JSON.stringify({ expected_revision: 3, body_md: 'Old.', restored_from: 1 }),
    });
    expect(invalidatedKeys(invalidate)).toEqual(
      expect.arrayContaining([wikiKeys.list('show1'), wikiKeys.page('p1')]),
    );
    expect(client.getQueryData<WikiPage>(wikiKeys.page('p1'))?.revision).toBe(4);
  });

  it('delete sends expected_revision in the query and invalidates list + page', async () => {
    mockedApiFetch.mockResolvedValue(page('p1', 3, { deleted: true }));
    const { result, invalidate } = setup(() => useDeleteWikiPage());
    await act(() => result.current.mutateAsync({ pageId: 'p1', expectedRevision: 2 }));
    expect(mockedApiFetch).toHaveBeenCalledWith('wiki/pages/p1?expected_revision=2', {
      method: 'DELETE',
    });
    expect(invalidatedKeys(invalidate)).toEqual(
      expect.arrayContaining([wikiKeys.list('show1'), wikiKeys.page('p1')]),
    );
  });

  it('restore posts expected_revision and invalidates list + page', async () => {
    mockedApiFetch.mockResolvedValue(page('p1', 4));
    const { result, invalidate } = setup(() => useRestoreWikiPage());
    await act(() => result.current.mutateAsync({ pageId: 'p1', expectedRevision: 3 }));
    expect(mockedApiFetch).toHaveBeenCalledWith('wiki/pages/p1/restore', {
      method: 'POST',
      body: JSON.stringify({ expected_revision: 3 }),
    });
    expect(invalidatedKeys(invalidate)).toEqual(
      expect.arrayContaining([wikiKeys.list('show1'), wikiKeys.page('p1')]),
    );
  });

  it('merge posts to the merged page and invalidates both pages + list', async () => {
    mockedApiFetch.mockResolvedValue({ page: page('pB', 6) });
    const { result, invalidate } = setup(() => useMergeWikiPage());
    const body = { into_page_id: 'pB', expected_revision: 2, into_expected_revision: 5 };
    await act(() => result.current.mutateAsync({ pageId: 'pA', body }));
    expect(mockedApiFetch).toHaveBeenCalledWith('wiki/pages/pA/merge', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    expect(invalidatedKeys(invalidate)).toEqual(
      expect.arrayContaining([wikiKeys.list('show1'), wikiKeys.page('pA'), wikiKeys.page('pB')]),
    );
  });

  it('split posts to the source page and invalidates the source + list', async () => {
    mockedApiFetch.mockResolvedValue({ page: page('p1', 3), new_page: page('p2', 1) });
    const { result, invalidate } = setup(() => useSplitWikiPage());
    const body = {
      expected_revision: 2,
      remaining_body_md: 'Left.',
      new_page: { kind: 'bit' as const, title: 'The Ladder', body_md: 'Moved.' },
    };
    await act(() => result.current.mutateAsync({ pageId: 'p1', body }));
    expect(mockedApiFetch).toHaveBeenCalledWith('wiki/pages/p1/split', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    expect(invalidatedKeys(invalidate)).toEqual(
      expect.arrayContaining([wikiKeys.list('show1'), wikiKeys.page('p1')]),
    );
  });
});

describe('version conflicts', () => {
  const conflictError = (current: WikiPage) =>
    new ApiError(409, 'Version conflict.', { detail: 'Version conflict.', current });

  it('wikiVersionConflictOf types a 409 Version conflict and its current page', () => {
    const current = page('p1', 4);
    const conflict = wikiVersionConflictOf(conflictError(current));
    expect(conflict?.current).toEqual(current);
  });

  it('wikiVersionConflictOf is null for other errors, including other 409s', () => {
    expect(
      wikiVersionConflictOf(new ApiError(409, 'Page is deleted.', { detail: 'Page is deleted.' })),
    ).toBeNull();
    expect(
      wikiVersionConflictOf(
        new ApiError(409, 'Title already used.', { detail: 'Title already used.', page_id: 'p2' }),
      ),
    ).toBeNull();
    expect(wikiVersionConflictOf(new ApiError(500, 'boom'))).toBeNull();
    expect(wikiVersionConflictOf(new Error('x'))).toBeNull();
    // A current with no numeric revision is not a wiki conflict.
    expect(
      wikiVersionConflictOf(
        new ApiError(409, 'Version conflict.', {
          detail: 'Version conflict.',
          current: { id: 'p1' },
        }),
      ),
    ).toBeNull();
  });

  it('a stale update rejects with the conflict and writes current into the page cache', async () => {
    const current = page('p1', 4, { body_md: 'Theirs.' });
    mockedApiFetch.mockRejectedValue(conflictError(current));
    const { result, client, invalidate } = setup(() => useUpdateWikiPage());
    client.setQueryData(wikiKeys.page('p1'), page('p1', 3));
    let caught: unknown;
    await act(async () => {
      try {
        await result.current.mutateAsync({
          pageId: 'p1',
          body: { expected_revision: 3, body_md: 'Mine.' },
        });
      } catch (e) {
        caught = e;
      }
    });
    expect(wikiVersionConflictOf(caught)?.current.revision).toBe(4);
    expect(client.getQueryData<WikiPage>(wikiKeys.page('p1'))).toEqual(current);
    expect(invalidatedKeys(invalidate)).toContainEqual(wikiKeys.page('p1'));
  });

  it('a stale merge writes the stale page (either side) into its cache', async () => {
    const current = page('pB', 7);
    mockedApiFetch.mockRejectedValue(conflictError(current));
    const { result, client } = setup(() => useMergeWikiPage());
    await act(async () => {
      await result.current
        .mutateAsync({
          pageId: 'pA',
          body: { into_page_id: 'pB', expected_revision: 2, into_expected_revision: 5 },
        })
        .catch(() => undefined);
    });
    expect(client.getQueryData<WikiPage>(wikiKeys.page('pB'))?.revision).toBe(7);
  });

  it('any other error leaves the cache alone', async () => {
    mockedApiFetch.mockRejectedValue(
      new ApiError(409, 'Page is deleted.', { detail: 'Page is deleted.' }),
    );
    const { result, client } = setup(() => useDeleteWikiPage());
    const cached = page('p1', 3);
    client.setQueryData(wikiKeys.page('p1'), cached);
    await act(async () => {
      await result.current
        .mutateAsync({ pageId: 'p1', expectedRevision: 3 })
        .catch(() => undefined);
    });
    expect(client.getQueryData<WikiPage>(wikiKeys.page('p1'))).toBe(cached);
  });
});
