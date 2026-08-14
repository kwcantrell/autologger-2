import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch } from '../../../api/client';
import { sessionKeys } from '../../../api/hooks/useSessions';
import type { Session } from '../../../api/types';
import { renderStrict } from '../../../test/renderStrict';
import { setNavigationImplForTesting } from '../navigation';
import { SessionRoute } from './SessionRoute';

// --- SessionRoute resolution-state tests (session-deep-links, task 4.3;
// spec: web-session-routing "Deep-link resolution states", all six
// scenarios) ---
//
// Mocked at module boundaries (the AppShell.test.tsx idiom): the fetch layer
// (`apiFetch`) is mocked — NOT the useSession/useRestoreSession hooks — so
// resolution runs through a real react-query client configured with the
// production retry policy (`retry: 1`, main.tsx; retryDelay 0 for speed).
// WorkspaceStatic is a shallow sentinel; navigation is recorded through the
// navigation wrapper's test seam. (The settings modal is no longer mounted
// here — AppShell owns it directly since teams-settings-nav, design D1.)
//
// The not-found state is a single state by construction: the server masks
// nonexistent, deleted, and unauthorized ids behind one 404 (asserted server
// side), and the client maps that one 404 to one state — there is no signal
// left to distinguish the causes, so one 404 test covers all three.

vi.mock('../../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/client')>();
  return { ...actual, apiFetch: vi.fn() };
});

// The `chunkfail-1` id makes the workspace throw a webpack ChunkLoadError the
// instant it renders. That is the same observable a rejected `React.lazy`
// import produces — React re-throws the rejection reason during the render
// that would have mounted the component — so it exercises SessionRoute's
// boundary placement without needing a rejected module in the registry (which
// would poison this file's module cache for every other test here). The
// retry-actually-re-imports mechanics are proven in ChunkLoadBoundary.test.tsx.
vi.mock('./WorkspaceStatic', () => ({
  WorkspaceStatic: (props: { sessionId: string }) => {
    if (props.sessionId === 'chunkfail-1') {
      const err = new Error('Loading chunk 42 failed. (error: /_next/static/chunks/42-abc.js)');
      err.name = 'ChunkLoadError';
      throw err;
    }
    return <div data-testid="workspace-static" data-session-id={props.sessionId} />;
  },
}));

vi.mock('./HomeRoute', () => ({
  HomeRoute: (props: { onNewSession: () => void }) => (
    <div id="home-launch" data-testid="home-route">
      <button type="button" data-testid="home-route-new-session" onClick={props.onNewSession}>
        mock new session
      </button>
    </div>
  ),
}));

vi.mock('../../../shared/components/Toast', () => ({
  toast: { error: vi.fn() },
}));

vi.mock('../../../shared/utils/loadingVideo', () => ({
  AUTOLOGGER_LOADING_VIDEO_SRC: '',
}));

const mockedApiFetch = vi.mocked(apiFetch);

function sessionFixture(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    title: 'Ep 12 Live Log',
    deck_title: '',
    show_id: 'show-1',
    show_code: 'SH',
    show_name: 'Show One',
    episode: '12',
    notes: '',
    session_status: 'active',
    frame_rate: 30,
    start_offset_frames: 0,
    created_at_utc: '2026-07-14T00:00:00Z',
    episode_date: null,
    event_count: 0,
    is_rolling: false,
    current_take: 0,
    rolling_timecode: null,
    total_runtime_hms: '00:00:00',
    archived: false,
    ...overrides,
  };
}

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: 1, retryDelay: 0 } } });
}

let navRecord: string[] = [];

function renderRoute(
  sessionId: string,
  client: QueryClient = makeClient(),
  onNewSession: () => void = () => {},
) {
  const view = renderStrict(
    <QueryClientProvider client={client}>
      <SessionRoute sessionId={sessionId} onNewSession={onNewSession} />
    </QueryClientProvider>,
  );
  return { view, client };
}

const stateEl = (id: string) => document.querySelector(`#session-route-${id}`);
const workspace = () => screen.queryByTestId('workspace-static');
const detailCalls = (id: string) =>
  mockedApiFetch.mock.calls.filter(([path]) => path === `sessions/${id}`).length;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  mockedApiFetch.mockReset();
  navRecord = [];
  setNavigationImplForTesting((path) => navRecord.push(path));
});

afterEach(() => {
  setNavigationImplForTesting(null);
});

describe('SessionRoute resolution states', () => {
  it('shows the brand loading treatment while resolving — never a not-found flash — then mounts the workspace (fresh/created id resolves 200)', async () => {
    const d = deferred<Session>();
    mockedApiFetch.mockReturnValue(d.promise);

    renderRoute('fresh-1');

    // While in flight: loading treatment only. No not-found, no error, no
    // workspace (the mount is gated on resolution).
    expect(stateEl('loading')).not.toBeNull();
    expect(stateEl('not-found')).toBeNull();
    expect(stateEl('error')).toBeNull();
    expect(workspace()).toBeNull();

    // The id the server just returned from creation resolves 200 immediately.
    d.resolve(sessionFixture({ id: 'fresh-1' }));

    await waitFor(() => expect(workspace()?.getAttribute('data-session-id')).toBe('fresh-1'));
    expect(stateEl('not-found')).toBeNull();
    expect(stateEl('loading')).toBeNull();
  });

  it('mounts the workspace for a 200 non-archived session (deep link to an active session)', async () => {
    mockedApiFetch.mockResolvedValue(sessionFixture({ id: 'deep-1' }));

    renderRoute('deep-1');

    await waitFor(() => expect(workspace()?.getAttribute('data-session-id')).toBe('deep-1'));
  });

  it('renders the archived interstitial and Restore re-resolves the same URL to the workspace with no navigation', async () => {
    let archived = true;
    mockedApiFetch.mockImplementation(async (path: string) => {
      if (path === 'sessions/arch-1/restore') {
        archived = false;
        return { ok: true };
      }
      if (path === 'sessions/arch-1') {
        return sessionFixture({
          id: 'arch-1',
          title: 'Archived Ep',
          archived,
          session_status: archived ? 'archived' : 'active',
        });
      }
      throw new Error(`unexpected apiFetch path: ${path}`);
    });

    renderRoute('arch-1');

    await waitFor(() => expect(stateEl('archived')).not.toBeNull());
    // Identifies the session, is not the workspace.
    expect(screen.getByText('Archived Ep')).not.toBeNull();
    expect(workspace()).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /restore session/i }));

    await waitFor(() => expect(workspace()?.getAttribute('data-session-id')).toBe('arch-1'));
    expect(mockedApiFetch).toHaveBeenCalledWith('sessions/arch-1/restore', { method: 'POST' });
    // Same URL throughout: no navigation was issued.
    expect(navRecord).toEqual([]);
  });

  it('renders one not-found state for a 404 (nonexistent, deleted, and unauthorized are indistinguishable) with a way back to /', async () => {
    mockedApiFetch.mockRejectedValue(new ApiError(404, 'Session not found'));

    renderRoute('ghost-1');

    await waitFor(() => expect(stateEl('not-found')).not.toBeNull());
    expect(stateEl('error')).toBeNull();
    expect(workspace()).toBeNull();
    // Resolved deterministically: the masked 404 was not retried.
    expect(detailCalls('ghost-1')).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: /back to sessions/i }));
    expect(navRecord).toEqual(['/']);
  });

  it('renders the retryable error state — distinct from not-found — for a transient failure, and retry re-issues the query', async () => {
    mockedApiFetch.mockRejectedValue(new ApiError(503, 'Service unavailable'));

    renderRoute('flaky-1');

    await waitFor(() => expect(stateEl('error')).not.toBeNull());
    // A transient failure must never read as a missing session.
    expect(stateEl('not-found')).toBeNull();
    expect(workspace()).toBeNull();

    const callsAtError = detailCalls('flaky-1');
    mockedApiFetch.mockResolvedValue(sessionFixture({ id: 'flaky-1' }));

    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    await waitFor(() => expect(workspace()?.getAttribute('data-session-id')).toBe('flaky-1'));
    expect(detailCalls('flaky-1')).toBeGreaterThan(callsAtError);
  });

  it('does not evict a mounted workspace when the session vanishes from the polled list or is archived remotely', async () => {
    mockedApiFetch.mockResolvedValue(sessionFixture({ id: 'sess-1' }));
    const client = makeClient();

    renderRoute('sess-1', client);
    await waitFor(() => expect(workspace()?.getAttribute('data-session-id')).toBe('sess-1'));

    // Background world changes: the server now reports the session archived,
    // and the polled sessions list no longer contains it.
    mockedApiFetch.mockResolvedValue(
      sessionFixture({ id: 'sess-1', archived: true, session_status: 'archived' }),
    );
    client.setQueryData(['sessions'], { active: [], archived: [] });
    await client.invalidateQueries({ queryKey: ['sessions'] });
    // Focus/visibility revalidation must not re-resolve either (the query is
    // never stale — staleTime Infinity plus the explicit refetch opt-outs).
    window.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));

    await waitFor(() => expect(workspace()?.getAttribute('data-session-id')).toBe('sess-1'));
    expect(stateEl('archived')).toBeNull();
    // The per-id query was fetched exactly once — on route entry.
    expect(detailCalls('sess-1')).toBe(1);
  });

  it('re-resolves on every route entry — unmount then remount the same id refetches and reflects server state (gcTime 0)', async () => {
    mockedApiFetch.mockResolvedValue(sessionFixture({ id: 'reenter-1' }));
    const client = makeClient();

    const { view } = renderRoute('reenter-1', client);
    await waitFor(() => expect(workspace()?.getAttribute('data-session-id')).toBe('reenter-1'));
    expect(detailCalls('reenter-1')).toBe(1);

    // Navigate away: the route (and its useSession query) unmounts. With
    // `gcTime: 0` the cache entry evaporates — asynchronously, on the same
    // macrotask react-query schedules its gc timer on — rather than lingering
    // for the default 5-minute window; wait for that eviction to land before
    // re-entering, or a same-tick remount would still observe the stale entry.
    view.unmount();
    await waitFor(() =>
      expect(client.getQueryData(sessionKeys.detail('reenter-1'))).toBeUndefined(),
    );

    // Server-side state changed while the route was gone — the session was
    // deleted/became unauthorized, now masked behind a 404.
    mockedApiFetch.mockRejectedValue(new ApiError(404, 'Session not found'));

    // Re-enter the same id at a fresh mount (a real route re-entry would also
    // get a fresh QueryClient-scoped subscription, but the cache is what's
    // under test here — reusing `client` isolates gcTime as the variable).
    renderRoute('reenter-1', client);

    await waitFor(() => expect(stateEl('not-found')).not.toBeNull());
    expect(workspace()).toBeNull();
    // A second, fresh request was issued on re-entry — not served from cache.
    expect(detailCalls('reenter-1')).toBe(2);
  });

  it('renders the home view for the empty id without issuing any per-id request', () => {
    renderRoute('');

    expect(screen.getByTestId('home-route')).not.toBeNull();
    expect(workspace()).toBeNull();
    expect(mockedApiFetch).not.toHaveBeenCalled();
  });
});

describe('SessionRoute workspace chunk failure (route-level boundary)', () => {
  // Before the boundary existed this throw escaped `<Suspense>` and the island
  // root, unmounting the whole client tree to a permanently blank page. Here it
  // shows up as `render()` itself re-throwing — so this test failing to find
  // the retry card is indistinguishable from the regression.
  it('renders the retryable failure card in the route frame instead of throwing out of the tree', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      mockedApiFetch.mockResolvedValue(sessionFixture({ id: 'chunkfail-1' }));

      renderRoute('chunkfail-1');

      const card = await screen.findByTestId('chunk-load-error');
      expect(card.getAttribute('data-variant')).toBe('route');
      expect(screen.getByTestId('chunk-load-retry')).not.toBeNull();
      expect(workspace()).toBeNull();
      // Not a resolution failure: the session resolved fine, so none of the
      // per-id states may claim otherwise.
      expect(stateEl('error')).toBeNull();
      expect(stateEl('not-found')).toBeNull();
    } finally {
      logged.mockRestore();
    }
  });
});

// --- SessionRoute mount tests (ui-refresh, task 5.1; design D10,
// GATE-OVERRIDDEN) ---
//
// Replaces the old SessionWorkspace "visibility swap" tests (which pinned
// the retired `#v3-session-placeholder` element toggling against
// `#v3-session-grid`): with the home view promoted to its own route
// component, the swap this file's resolution-state tests already exercise
// (found/non-archived -> WorkspaceStatic, everything else that resolves to
// "no active session" -> HomeRoute) is what these two tests pin directly —
// `#home-launch` renders with no workspace mounted, and vice versa.

describe('SessionRoute mount (home vs workspace)', () => {
  it('renders #home-launch for the empty id, with no workspace mounted', () => {
    renderRoute('');

    expect(document.querySelector('#home-launch')).not.toBeNull();
    expect(workspace()).toBeNull();
  });

  it('renders the workspace for a resolved, non-archived session, with no #home-launch', async () => {
    mockedApiFetch.mockResolvedValue(sessionFixture({ id: 'sess-1' }));

    renderRoute('sess-1');

    await waitFor(() => expect(workspace()?.getAttribute('data-session-id')).toBe('sess-1'));
    expect(document.querySelector('#home-launch')).toBeNull();
  });

  it('threads onNewSession through to the home route', () => {
    const onNewSession = vi.fn();
    renderRoute('', makeClient(), onNewSession);

    fireEvent.click(screen.getByTestId('home-route-new-session'));
    expect(onNewSession).toHaveBeenCalledTimes(1);
  });
});
