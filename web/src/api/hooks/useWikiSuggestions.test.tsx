import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch } from '../client';
import type { WikiPage, WikiSuggestion } from '../types';
import { wikiKeys, wikiVersionConflictOf } from './useWiki';
import {
  generateWiki,
  useAcceptWikiSuggestion,
  useDismissWikiSuggestion,
  useGenerateWiki,
  useWikiSuggestion,
  useWikiSuggestions,
  wikiSuggestionResolvedOf,
} from './useWikiSuggestions';

// show-wiki-ai task 6.2 (design D6; show-wiki "Suggestions inbox"): the suggestion hooks and their
// `wikiKeys` entries. The keys sit under the wiki root, so `wikiKeys.all()` covers them. Queries
// call the frozen routes (api-contract-freeze "Wiki suggestion list, read, accept and dismiss
// endpoints", "Wiki update endpoint"); accept and dismiss refresh the suggestions, the page and the
// page list; generate refreshes the suggestions; a `409 Version conflict.` on accept surfaces as a
// wiki version conflict and writes `current` into the page cache.

vi.mock('../client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../client')>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function setup<T>(hook: () => T) {
  const client = makeClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const { result } = renderHook(hook, {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  return { client, invalidate, result };
}

const invalidatedKeys = (invalidate: { mock: { calls: unknown[][] } }) =>
  invalidate.mock.calls.map(([f]) => (f as { queryKey?: unknown } | undefined)?.queryKey);

// The root, built so this file holds no quoted copy of it (queryKeyFactories.repo.test.ts).
const ROOT = ['wiki', 'Pages'].join('');

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

function suggestion(overrides: Partial<WikiSuggestion> = {}): WikiSuggestion {
  return {
    id: 'sg1',
    show_id: 'show1',
    session_id: 'sess1',
    status: 'pending',
    page_id: 'p1',
    base_revision: 3,
    kind: 'person',
    title: 'Page p1',
    aliases: [],
    rationale: 'She opens this session.',
    page: { title: 'Page p1', revision: 3, state: 'live' },
    stale: false,
    created_at_utc: '2026-10-13T10:00:00.000Z',
    created_by_name: 'Kai Lee',
    resolved_at_utc: null,
    resolved_by_name: null,
    resolved_revision: null,
    ...overrides,
  };
}

beforeEach(() => {
  mockedApiFetch.mockReset();
});

describe('wikiKeys: the suggestion entries', () => {
  it('nest under the wiki root, so wikiKeys.all() covers them', () => {
    expect(wikiKeys.allSuggestions()).toEqual([ROOT, 'suggestions']);
    expect(wikiKeys.suggestions('show1')).toEqual([ROOT, 'suggestions', 'show1', {}]);
    expect(wikiKeys.suggestions('show1', { status: 'accepted', pageId: 'p1' })).toEqual([
      ROOT,
      'suggestions',
      'show1',
      { status: 'accepted', page_id: 'p1' },
    ]);
    expect(wikiKeys.suggestion('sg1')).toEqual([ROOT, 'suggestion', 'sg1']);
  });

  it('pending is the default, so an explicit pending shares the unfiltered entry', () => {
    expect(wikiKeys.suggestions('show1', { status: 'pending', pageId: '' })).toEqual(
      wikiKeys.suggestions('show1'),
    );
  });

  it('suggestions(showId) is a prefix of every filtered list of that show', async () => {
    const client = makeClient();
    const empty = { suggestions: [], truncated: false };
    client.setQueryData(wikiKeys.suggestions('show1', { pageId: 'p1' }), empty);
    client.setQueryData(wikiKeys.suggestions('show2', { pageId: 'p1' }), empty);
    await client.invalidateQueries({ queryKey: wikiKeys.suggestions('show1') });
    expect(
      client.getQueryState(wikiKeys.suggestions('show1', { pageId: 'p1' }))?.isInvalidated,
    ).toBe(true);
    expect(
      client.getQueryState(wikiKeys.suggestions('show2', { pageId: 'p1' }))?.isInvalidated,
    ).toBe(false);
    await client.invalidateQueries({ queryKey: wikiKeys.all() });
    expect(
      client.getQueryState(wikiKeys.suggestions('show2', { pageId: 'p1' }))?.isInvalidated,
    ).toBe(true);
  });
});

describe('suggestion queries', () => {
  it('useWikiSuggestions lists the show, with status and page_id in the query string', async () => {
    mockedApiFetch.mockResolvedValue({ suggestions: [], truncated: false });
    const { result } = setup(() =>
      useWikiSuggestions('show1', { status: 'dismissed', pageId: 'p1' }),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApiFetch.mock.calls[0][0]).toBe(
      'shows/show1/wiki/suggestions?status=dismissed&page_id=p1',
    );
  });

  it('useWikiSuggestions without filters sends no query string, and waits for a show', async () => {
    mockedApiFetch.mockResolvedValue({ suggestions: [], truncated: false });
    const { result } = setup(() => useWikiSuggestions('show1'));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApiFetch.mock.calls[0][0]).toBe('shows/show1/wiki/suggestions');
    mockedApiFetch.mockClear();
    setup(() => useWikiSuggestions(null));
    expect(mockedApiFetch).not.toHaveBeenCalled();
  });

  it('useWikiSuggestion reads one suggestion with its body, and waits for an id', async () => {
    mockedApiFetch.mockResolvedValue({ ...suggestion(), body_md: 'New body.' });
    const { result } = setup(() => useWikiSuggestion('sg1'));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApiFetch.mock.calls[0][0]).toBe('wiki/suggestions/sg1');
    expect(result.current.data?.body_md).toBe('New body.');
    mockedApiFetch.mockClear();
    setup(() => useWikiSuggestion(null));
    expect(mockedApiFetch).not.toHaveBeenCalled();
  });
});

describe('suggestion mutations', () => {
  it('accept posts the body and refreshes the suggestions, the page and the page list', async () => {
    const updated = page('p1', 4);
    mockedApiFetch.mockResolvedValue({
      page: updated,
      suggestion: suggestion({ status: 'accepted', resolved_revision: 4 }),
    });
    const { result, invalidate, client } = setup(() => useAcceptWikiSuggestion());
    await act(() =>
      result.current.mutateAsync({
        suggestionId: 'sg1',
        body: { expected_revision: 3, title: 'Edited' },
      }),
    );
    expect(mockedApiFetch).toHaveBeenCalledWith('wiki/suggestions/sg1/accept', {
      method: 'POST',
      body: JSON.stringify({ expected_revision: 3, title: 'Edited' }),
    });
    expect(invalidatedKeys(invalidate)).toEqual(
      expect.arrayContaining([
        wikiKeys.suggestions('show1'),
        wikiKeys.suggestion('sg1'),
        wikiKeys.page('p1'),
        wikiKeys.list('show1'),
      ]),
    );
    expect(client.getQueryData<WikiPage>(wikiKeys.page('p1'))?.revision).toBe(4);
  });

  it('dismiss posts no body and refreshes the suggestions, the page and the page list', async () => {
    mockedApiFetch.mockResolvedValue(suggestion({ status: 'dismissed' }));
    const { result, invalidate } = setup(() => useDismissWikiSuggestion());
    await act(() => result.current.mutateAsync({ suggestionId: 'sg1' }));
    expect(mockedApiFetch).toHaveBeenCalledWith('wiki/suggestions/sg1/dismiss', {
      method: 'POST',
    });
    expect(invalidatedKeys(invalidate)).toEqual(
      expect.arrayContaining([
        wikiKeys.suggestions('show1'),
        wikiKeys.suggestion('sg1'),
        wikiKeys.page('p1'),
        wikiKeys.list('show1'),
      ]),
    );
  });

  it('dismissing a new-page suggestion refreshes the suggestions and the page list', async () => {
    mockedApiFetch.mockResolvedValue(
      suggestion({ status: 'dismissed', page_id: null, base_revision: null, page: null }),
    );
    const { result, invalidate } = setup(() => useDismissWikiSuggestion());
    await act(() => result.current.mutateAsync({ suggestionId: 'sg1' }));
    expect(invalidatedKeys(invalidate)).toEqual(
      expect.arrayContaining([wikiKeys.suggestions('show1'), wikiKeys.list('show1')]),
    );
  });

  it('generate posts to the session and refreshes every suggestion list', async () => {
    mockedApiFetch.mockResolvedValue({ suggestions: [suggestion()] });
    const { result, invalidate } = setup(() => useGenerateWiki('sess1'));
    let out: unknown;
    await act(async () => {
      out = await result.current.mutateAsync();
    });
    expect(mockedApiFetch).toHaveBeenCalledWith('sessions/sess1/wiki/generate', {
      method: 'POST',
    });
    expect((out as { suggestions: unknown[] }).suggestions).toHaveLength(1);
    expect(invalidatedKeys(invalidate)).toContainEqual(wikiKeys.allSuggestions());
  });

  it('generateWiki (the hook-free form the workspace uses) does the same', async () => {
    mockedApiFetch.mockResolvedValue({ suggestions: [] });
    const client = makeClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await expect(generateWiki(client, 'sess1')).resolves.toEqual({ suggestions: [] });
    expect(mockedApiFetch).toHaveBeenCalledWith('sessions/sess1/wiki/generate', {
      method: 'POST',
    });
    expect(invalidatedKeys(invalidate)).toContainEqual(wikiKeys.allSuggestions());
  });
});

describe('accept conflicts', () => {
  it('a stale accept rejects with a wiki version conflict and writes current into the page cache', async () => {
    const current = page('p1', 5, { body_md: 'Theirs.' });
    mockedApiFetch.mockRejectedValue(
      new ApiError(409, 'Version conflict.', { detail: 'Version conflict.', current }),
    );
    const { result, client, invalidate } = setup(() => useAcceptWikiSuggestion());
    client.setQueryData(wikiKeys.page('p1'), page('p1', 4));
    let caught: unknown;
    await act(async () => {
      try {
        await result.current.mutateAsync({ suggestionId: 'sg1', body: { expected_revision: 4 } });
      } catch (e) {
        caught = e;
      }
    });
    expect(wikiVersionConflictOf(caught)?.current.revision).toBe(5);
    expect(client.getQueryData<WikiPage>(wikiKeys.page('p1'))).toEqual(current);
    expect(invalidatedKeys(invalidate)).toContainEqual(wikiKeys.page('p1'));
  });

  it('an already-resolved suggestion is typed, and refreshes the suggestion and the lists', async () => {
    const err = new ApiError(409, 'Suggestion already resolved.', {
      detail: 'Suggestion already resolved.',
      status: 'accepted',
    });
    expect(wikiSuggestionResolvedOf(err)?.status).toBe('accepted');
    expect(wikiSuggestionResolvedOf(new ApiError(409, 'Page is deleted.', {}))).toBeNull();
    expect(wikiSuggestionResolvedOf(new Error('x'))).toBeNull();
    mockedApiFetch.mockRejectedValue(err);
    const { result, invalidate } = setup(() => useDismissWikiSuggestion());
    await act(async () => {
      await result.current.mutateAsync({ suggestionId: 'sg1' }).catch(() => {});
    });
    expect(invalidatedKeys(invalidate)).toEqual(
      expect.arrayContaining([wikiKeys.suggestion('sg1'), wikiKeys.allSuggestions()]),
    );
  });
});
