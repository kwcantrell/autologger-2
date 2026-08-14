import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../client';
import { showKeys, useShow, useStudioShows } from './useShows';

// --- Show query keys + list→detail cache seeding (PR review finding 4) ---
//
// `GET /api/shows?studio_id=…` already returns each show's FULL config — the
// same bytes `GET /api/shows/:id` serves — so a `useShow` for a show the studio
// list already carried must be a cache hit, not a second request. The fetch
// layer is mocked at the module boundary (the useTeams.test.tsx idiom): no real
// network, real react-query cache semantics, so "served from cache" is observed
// as `apiFetch` never being called rather than by spying on internals.

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
    <StrictMode>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </StrictMode>
  );
}

function showFixture(id: string, studioId = 'studio-1') {
  return {
    id,
    studio_id: studioId,
    name: `Show ${id}`,
    show_code: id.toUpperCase(),
    title_suffix: 'date',
    categories: [],
    event_palette: [],
    event_palette_preset: 'custom',
    event_palette_custom: [],
  };
}

beforeEach(() => {
  mockedApiFetch.mockReset();
});

describe('showKeys', () => {
  // The key STRINGS are deliberately never written out here:
  // `queryKeyFactories.repo.test.ts` guards them as the factory module's
  // exclusive property, so these assertions pin COMPOSITION (root + id)
  // against the factory's own roots instead of restating the literals.
  it('nests each entry under its bare root, so prefix invalidation reaches it', () => {
    expect(showKeys.byStudio('studio-1')).toEqual([...showKeys.allStudios(), 'studio-1']);
    expect(showKeys.byId('show-1')).toEqual([...showKeys.all(), 'show-1']);
  });

  it('keeps the two roots distinct, so invalidating one does not match the other', () => {
    expect(showKeys.allStudios()).not.toEqual([...showKeys.all()]);
  });
});

describe('useStudioShows', () => {
  it('fetches the studio list under the factory key and seeds each show’s detail entry', async () => {
    const client = makeClient();
    const shows = [showFixture('show-1'), showFixture('show-2')];
    mockedApiFetch.mockResolvedValue({ shows });

    const { result } = renderHook(() => useStudioShows('studio-1'), {
      wrapper: wrapperFor(client),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApiFetch).toHaveBeenCalledWith('shows?studio_id=studio-1');
    expect(client.getQueryData(showKeys.byStudio('studio-1'))).toEqual({ shows });
    // Each listed show is now readable at its own key, in `useShow`'s shape.
    expect(client.getQueryData(showKeys.byId('show-1'))).toEqual({ show: shows[0] });
    expect(client.getQueryData(showKeys.byId('show-2'))).toEqual({ show: shows[1] });
  });

  it('issues no request for a null studio id', () => {
    const client = makeClient();
    renderHook(() => useStudioShows(null), { wrapper: wrapperFor(client) });

    expect(mockedApiFetch).not.toHaveBeenCalled();
  });
});

describe('useShow served from the seeded list', () => {
  it('resolves a listed show without a second request', async () => {
    const client = makeClient();
    const shows = [showFixture('show-1'), showFixture('show-2')];
    mockedApiFetch.mockResolvedValue({ shows });

    const list = renderHook(() => useStudioShows('studio-1'), { wrapper: wrapperFor(client) });
    await waitFor(() => expect(list.result.current.isSuccess).toBe(true));
    expect(mockedApiFetch).toHaveBeenCalledTimes(1);

    const detail = renderHook(() => useShow('show-2'), { wrapper: wrapperFor(client) });

    // Synchronously available on the first render — no loading window at all —
    // and the list request stays the only one that went out (the seeded entry
    // is fresh under the hook's own 30s staleTime).
    expect(detail.result.current.data).toEqual({ show: shows[1] });
    expect(mockedApiFetch).toHaveBeenCalledTimes(1);
  });

  it('still fetches a show the list never carried', async () => {
    const client = makeClient();
    mockedApiFetch.mockResolvedValue({ shows: [showFixture('show-1')] });

    const list = renderHook(() => useStudioShows('studio-1'), { wrapper: wrapperFor(client) });
    await waitFor(() => expect(list.result.current.isSuccess).toBe(true));

    const other = showFixture('show-9', 'studio-2');
    mockedApiFetch.mockResolvedValue({ show: other });
    const detail = renderHook(() => useShow('show-9'), { wrapper: wrapperFor(client) });

    await waitFor(() => expect(detail.result.current.isSuccess).toBe(true));
    expect(mockedApiFetch).toHaveBeenLastCalledWith('shows/show-9');
    expect(detail.result.current.data).toEqual({ show: other });
  });
});
