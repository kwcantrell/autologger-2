import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../client';
import {
  teamKeys,
  useChangeMemberRole,
  useCreateTeam,
  useDeleteTeam,
  useInviteToTeam,
  useLeaveTeam,
  useRemoveMember,
  useRenameTeam,
  useRevokeInvite,
  useTeam,
} from './useTeams';

// --- useTeam + team mutation hook tests (teams-self-serve, task 6.1; design
// D7) ---
//
// The fetch layer is mocked at the module boundary (the useSession.test.tsx
// idiom) so these stay unit tests: no real network, real react-query
// invalidation semantics. Each mutation's `onSuccess` is asserted through the
// public, observable effect — the target query keys report `isStale: true`
// (or are dropped from the cache for delete/leave) — rather than by spying on
// `invalidateQueries` directly, so the tests don't couple to the
// implementation's internal call shape.

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

/** Seed the cache with fresh (non-stale) data at a key, so invalidation is
 * observable as a stale-flip rather than "there was never data to begin
 * with". */
function seedFresh(client: QueryClient, queryKey: readonly unknown[], data: unknown) {
  client.setQueryData(queryKey, data);
  const state = client.getQueryState(queryKey);
  expect(state?.isInvalidated).toBe(false);
}

beforeEach(() => {
  mockedApiFetch.mockReset();
});

describe('useTeam', () => {
  it('fetches GET /api/teams/:id, re-encoding the id', async () => {
    mockedApiFetch.mockResolvedValue({
      id: 'a/b',
      name: 'Team',
      role: 'admin',
      enabled_admin_count: 1,
      members: [],
    });

    renderHook(() => useTeam('a/b'), { wrapper: wrapperFor(makeClient()) });

    await waitFor(() => expect(mockedApiFetch).toHaveBeenCalledWith('teams/a%2Fb'));
  });

  it('issues no request for the empty id (collapsed / built-in cards)', () => {
    const { result } = renderHook(() => useTeam(''), { wrapper: wrapperFor(makeClient()) });

    expect(result.current.fetchStatus).toBe('idle');
    expect(mockedApiFetch).not.toHaveBeenCalled();
  });
});

describe('mutation invalidation wiring', () => {
  it('useCreateTeam invalidates the profile (no prior detail cache entry to invalidate)', async () => {
    mockedApiFetch.mockResolvedValue({ id: 'my-crew', name: 'My Crew', role: 'admin' });
    const client = makeClient();
    seedFresh(client, ['profile'], { auth: { user: { teams: [] } } });

    const { result } = renderHook(() => useCreateTeam(), { wrapper: wrapperFor(client) });
    result.current.mutate({ id: 'my-crew', display_name: 'My Crew' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(client.getQueryState(['profile'])?.isInvalidated).toBe(true);
  });

  it('useRenameTeam invalidates both the team detail key and the profile', async () => {
    mockedApiFetch.mockResolvedValue({ id: 'my-crew', name: 'New Name' });
    const client = makeClient();
    seedFresh(client, teamKeys.detail('my-crew'), { id: 'my-crew', name: 'Old Name' });
    seedFresh(client, ['profile'], {});

    const { result } = renderHook(() => useRenameTeam('my-crew'), { wrapper: wrapperFor(client) });
    result.current.mutate({ display_name: 'New Name' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(client.getQueryState(teamKeys.detail('my-crew'))?.isInvalidated).toBe(true);
    expect(client.getQueryState(['profile'])?.isInvalidated).toBe(true);
  });

  it('useInviteToTeam invalidates both keys (so a newly pending invite shows up without reload)', async () => {
    mockedApiFetch.mockResolvedValue({ ok: true });
    const client = makeClient();
    seedFresh(client, teamKeys.detail('my-crew'), { id: 'my-crew', invites: [] });
    seedFresh(client, ['profile'], {});

    const { result } = renderHook(() => useInviteToTeam('my-crew'), {
      wrapper: wrapperFor(client),
    });
    result.current.mutate({ email: 'new@example.com' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApiFetch).toHaveBeenCalledWith(
      'teams/my-crew/invites',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(client.getQueryState(teamKeys.detail('my-crew'))?.isInvalidated).toBe(true);
    expect(client.getQueryState(['profile'])?.isInvalidated).toBe(true);
  });

  it('useRevokeInvite invalidates both keys and encodes the email path segment', async () => {
    mockedApiFetch.mockResolvedValue({ ok: true });
    const client = makeClient();
    seedFresh(client, teamKeys.detail('my-crew'), { id: 'my-crew', invites: [] });
    seedFresh(client, ['profile'], {});

    const { result } = renderHook(() => useRevokeInvite('my-crew'), {
      wrapper: wrapperFor(client),
    });
    result.current.mutate('new@example.com');

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApiFetch).toHaveBeenCalledWith(
      'teams/my-crew/invites/new%40example.com',
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(client.getQueryState(teamKeys.detail('my-crew'))?.isInvalidated).toBe(true);
    expect(client.getQueryState(['profile'])?.isInvalidated).toBe(true);
  });

  it('useChangeMemberRole invalidates both keys', async () => {
    mockedApiFetch.mockResolvedValue({ ok: true, role: 'admin' });
    const client = makeClient();
    seedFresh(client, teamKeys.detail('my-crew'), { id: 'my-crew' });
    seedFresh(client, ['profile'], {});

    const { result } = renderHook(() => useChangeMemberRole('my-crew'), {
      wrapper: wrapperFor(client),
    });
    result.current.mutate({ userId: 'user-2', role: 'admin' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(client.getQueryState(teamKeys.detail('my-crew'))?.isInvalidated).toBe(true);
    expect(client.getQueryState(['profile'])?.isInvalidated).toBe(true);
  });

  it('useRemoveMember invalidates both keys', async () => {
    mockedApiFetch.mockResolvedValue({ ok: true });
    const client = makeClient();
    seedFresh(client, teamKeys.detail('my-crew'), { id: 'my-crew' });
    seedFresh(client, ['profile'], {});

    const { result } = renderHook(() => useRemoveMember('my-crew'), {
      wrapper: wrapperFor(client),
    });
    result.current.mutate('user-2');

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(client.getQueryState(teamKeys.detail('my-crew'))?.isInvalidated).toBe(true);
    expect(client.getQueryState(['profile'])?.isInvalidated).toBe(true);
  });

  it('useDeleteTeam drops the detail cache entry and invalidates the profile', async () => {
    mockedApiFetch.mockResolvedValue({ ok: true });
    const client = makeClient();
    seedFresh(client, teamKeys.detail('my-crew'), { id: 'my-crew' });
    seedFresh(client, ['profile'], {});

    const { result } = renderHook(() => useDeleteTeam('my-crew'), { wrapper: wrapperFor(client) });
    result.current.mutate();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(client.getQueryState(teamKeys.detail('my-crew'))).toBeUndefined();
    expect(client.getQueryState(['profile'])?.isInvalidated).toBe(true);
  });

  it('useLeaveTeam drops the detail cache entry and invalidates the profile', async () => {
    mockedApiFetch.mockResolvedValue({ ok: true });
    const client = makeClient();
    seedFresh(client, teamKeys.detail('my-crew'), { id: 'my-crew' });
    seedFresh(client, ['profile'], {});

    const { result } = renderHook(() => useLeaveTeam('my-crew'), { wrapper: wrapperFor(client) });
    result.current.mutate();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(client.getQueryState(teamKeys.detail('my-crew'))).toBeUndefined();
    expect(client.getQueryState(['profile'])?.isInvalidated).toBe(true);
  });
});
