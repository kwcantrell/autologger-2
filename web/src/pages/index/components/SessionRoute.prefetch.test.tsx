import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../../../api/client';
import { renderStrict } from '../../../test/renderStrict';
import { setNavigationImplForTesting } from '../navigation';
import { SessionRoute } from './SessionRoute';

// --- Workspace chunk warm-up (bundle route-splitting, review fix: serialized
// waterfall) ---
//
// The workspace is the app's largest chunk and sits behind BOTH the per-id
// resolution fetch and its own `lazy()` mount gate, so a cold deep link used to
// pay the two round trips strictly in series — resolve, then download — behind
// a single loading frame. `SessionRoute` now fires the module import from an
// effect on route entry, in parallel with resolution.
//
// This lives in its own file on purpose: the assertion "the workspace module
// has NOT been imported yet" is only meaningful against a fresh module
// registry, and vitest scopes one registry per test file. Any test in
// `SessionRoute.test.tsx` that mounts a resolved workspace would import the
// module and make it vacuous there. For the same reason both halves live in
// ONE test rather than two ordered ones.

const workspaceModule = vi.hoisted(() => ({ imported: false }));

vi.mock('../../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/client')>();
  return { ...actual, apiFetch: vi.fn() };
});

vi.mock('./WorkspaceStatic', () => {
  // Runs when — and only when — something actually imports the module, which
  // is exactly the observable under test.
  workspaceModule.imported = true;
  return {
    WorkspaceStatic: (props: { sessionId: string }) => (
      <div data-testid="workspace-static" data-session-id={props.sessionId} />
    ),
  };
});

vi.mock('./HomeRoute', () => ({
  HomeRoute: () => <div id="home-launch" data-testid="home-route" />,
}));

vi.mock('../../../shared/components/Toast', () => ({ toast: { error: vi.fn() } }));

vi.mock('../../../shared/utils/loadingVideo', () => ({
  AUTOLOGGER_LOADING_VIDEO_SRC: '',
}));

const mockedApiFetch = vi.mocked(apiFetch);

function renderRoute(sessionId: string) {
  return renderStrict(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <SessionRoute sessionId={sessionId} onNewSession={() => {}} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockedApiFetch.mockReset();
  setNavigationImplForTesting(() => {});
});

afterEach(() => {
  setNavigationImplForTesting(null);
});

describe('SessionRoute workspace chunk warm-up', () => {
  it('starts the workspace import while resolution is still in flight — and not at all for the home view', async () => {
    // The home view issues no per-id request and must not pull the workspace
    // chunk either (it is the whole point of the split).
    const home = renderRoute('');
    expect(screen.getByTestId('home-route')).not.toBeNull();
    expect(workspaceModule.imported).toBe(false);
    home.unmount();

    // A deep link whose resolution never settles: anything that imports the
    // workspace from here can only be the parallel warm-up, since the
    // resolution-gated `lazy()` mount is unreachable in this state.
    mockedApiFetch.mockReturnValue(new Promise(() => {}));
    renderRoute('deep-1');

    await waitFor(() => expect(workspaceModule.imported).toBe(true));

    // Still resolving, and the mount gate is intact — warming a chunk is not
    // mounting the workspace (the same property AppShell's idle-prefetch test
    // pins for the settings chunk).
    // Both halves of the wait's identity, pinned since `RouteLoadingState` became shared and
    // parameterized (PR review finding 3): the session route keeps the id other tests key on
    // AND keeps announcing the session — the defaults exist so this call site never changed.
    const loading = document.querySelector('#session-route-loading');
    expect(loading).not.toBeNull();
    expect(loading?.getAttribute('aria-label')).toBe('Loading session');
    expect(screen.queryByTestId('workspace-static')).toBeNull();
  });
});
