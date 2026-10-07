import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { useProfile } from '../../api/hooks/useProfile';
import { useYoutubeImport } from '../../api/hooks/useSessions';
import { renderStrict } from '../../test/renderStrict';
import { AppShell } from './AppShell';
import { register } from './coordination/registry';
import { clearTransportStatus, publishTransportStatus } from './coordination/transportStatus';
import { navigate, setNavigationImplForTesting } from './navigation';
import { markOriginated, resetOriginationForTesting } from './transportOrigination';

// --- AppShell routing + legacy-spine-retirement tests (session-deep-links,
// task 3.3; spec: web-session-routing "URL-addressed session state" +
// "Legacy selection spine retired") ---
//
// These are routing/state tests, not integration tests: heavy children are
// mocked at the module boundary (the RootGate.test.tsx idiom). The V6Rail mock
// exposes buttons that fire the selection callbacks; the SessionRoute mock
// (the deep-link resolution layer that now wraps WorkspaceStatic — task 4.2;
// its own resolution states are covered in SessionRoute.test.tsx) reports the
// sessionId it received (the "workspace mount" observable) and a button
// standing in for a close-session caller (the team switch's own branch
// logic is covered in TopBar.test.tsx). Location is driven
// by `wouter/memory-location` (recorded history) except for the browser-Back
// test, which uses jsdom's real history.

vi.mock('../../api/hooks/useProfile', () => ({
  useProfile: vi.fn(),
  // The top bar's switch write (redesign-show-ignition 3.2); its body and refetches are
  // TopBar.test.tsx's concern, this file only needs it to resolve.
  useProfileMutation: () => ({ mutateAsync: profileWrite, isPending: false }),
}));

const profileWrite = vi.hoisted(() => vi.fn());

vi.mock('../../api/hooks/useSessions', () => ({
  useYoutubeImport: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock('../../shared/components/Toast', () => ({
  Toast: () => null,
  toast: { error: vi.fn() },
}));

vi.mock('../../shared/ui/breakpoints', () => ({
  useIsMobile: () => false,
}));

vi.mock('../../shared/utils/loadingVideo', () => ({
  AUTOLOGGER_LOADING_VIDEO_SRC: '',
  freezeAutologgerLoadingVideos: () => {},
}));

vi.mock('../../shared/utils/perfDebug', () => ({
  initPerfDebugUI: () => {},
}));

// The rail mock reads the shell's real `SidebarProvider` (redesign-show-ignition D8): it reports
// the sidebar state and holds a search input, for the `[` shortcut tests.
vi.mock('./components/V6Rail', async () => {
  const { useSidebar } = await import('../../shared/components/ui/sidebar');
  function V6Rail(props: {
    activeSessionId: string;
    onSelectSession: (sid: string) => void;
    onCloseSession: () => void;
    onNewSession: () => void;
    onBatchImport: () => void;
    onOpenSettings: () => void;
  }) {
    const { state } = useSidebar();
    return (
      <div
        data-testid="rail"
        data-active-session-id={props.activeSessionId}
        data-sidebar-state={state}
      >
        <input type="search" aria-label="Search sessions" />
        <button
          type="button"
          data-testid="rail-select-s1"
          onClick={() => props.onSelectSession('sess-1')}
        />
        <button
          type="button"
          data-testid="rail-select-s2"
          onClick={() => props.onSelectSession('sess-2')}
        />
        <button type="button" data-testid="rail-close" onClick={() => props.onCloseSession()} />
        <button type="button" data-testid="rail-new" onClick={() => props.onNewSession()} />
        <button type="button" data-testid="rail-batch" onClick={() => props.onBatchImport()} />
        <button type="button" id="v6-btn-settings" onClick={() => props.onOpenSettings()} />
      </div>
    );
  }
  return { V6Rail };
});

// --- render-isolation probe (settings-modal-mount-cost, task 2.1; design D0)
// ---
//
// `WorkspaceStatic` (the real `memo()`'d isolation boundary) sits two levels
// below this mock, inside the real `SessionRoute`. This file mocks
// `SessionRoute` wholesale (see the comment above), so the memo boundary
// itself isn't exercised here — but `SessionRoute` forwards `sessionId` /
// `ytImportPending` into `WorkspaceStatic` completely
// unchanged (no new object/closure created in between; see
// `SessionRoute.tsx`). So asserting that those props keep a stable identity
// as received by THIS mock is equivalent to asserting the real memo holds —
// and unlike a presence assertion, it can see a fresh-closure regression that
// would defeat the memo without ever changing what's on screen.
const sessionRouteProbe = vi.hoisted(() => ({
  renders: [] as Array<{
    sessionId: string;
    ytImportPending?: boolean;
    onNewSession: () => void;
  }>,
}));

vi.mock('./components/SessionRoute', () => ({
  SessionRoute: (props: {
    sessionId: string;
    ytImportPending?: boolean;
    onNewSession: () => void;
  }) => {
    sessionRouteProbe.renders.push(props);
    return <div data-testid="session-route" data-session-id={props.sessionId} />;
  },
}));

// The Settings view (redesign-show-ignition D3) is mounted by AppShell beside the route switch, so
// this file's concern is the WIRING: the shell's `settings` state (open, which section, closed),
// the `/teams` route opening it, and its close paths. The view's own internals (nav, deferral,
// guard, modal semantics) are SettingsView.test.tsx's, against the real component. The mock is a
// real `role="dialog"` node carrying the view's `data-slot`, plus stand-ins for its controls.
//
// `settingsChunk.fail` makes the settings surface throw a webpack
// ChunkLoadError on render — the same observable a rejected `React.lazy`
// import produces (React re-throws the rejection reason during the render that
// would have mounted the component), without a poisoned module registry that
// would leak into every other test in this file. Used by the code-splitting
// failure test below; the retry-re-imports mechanics live in
// ChunkLoadBoundary.test.tsx.
//
// `settingsChunk.importFails` is the *other* half of that observable: the LOAD itself
// failing, which is what the idle warm-up can hit with no UI to fall back on. It cannot be
// modelled by throwing from the factory — vitest calls the factory at most once per module
// graph, and the open-path tests above have already resolved it by the time the warm-up test
// runs — so the export is exposed as a GETTER, the one step `loadSettingsView` repeats
// on every call, and throwing from it rejects that loader's promise exactly like a dead chunk.
// `settingsChunk.loads` counts those getter reads: zero means the loader never ran, i.e. the
// view's module was not fetched.
const settingsChunk = vi.hoisted(() => ({
  fail: false,
  importFails: false,
  loads: 0,
  renders: 0,
  // A discard guard the mocked view registers, standing in for one with unsaved edits.
  guard: null as null | (() => true | Promise<boolean>),
}));

function chunkLoadError() {
  const err = new Error('Loading chunk 42 failed. (error: /_next/static/chunks/42-abc.js)');
  err.name = 'ChunkLoadError';
  return err;
}

vi.mock('./components/settings/SettingsView', async () => {
  const { useEffect } = await import('react');
  const SettingsView = (props: {
    section: string;
    onSectionChange: (section: string) => void;
    onClose: () => void;
    onCloseSession: () => void;
    backLabel: string;
    registerCloseGuard?: (guard: (() => true | Promise<boolean>) | null) => void;
  }) => {
    if (settingsChunk.fail) {
      throw chunkLoadError();
    }
    settingsChunk.renders += 1;
    const { registerCloseGuard } = props;
    useEffect(() => {
      const guard = settingsChunk.guard;
      if (!guard || !registerCloseGuard) return;
      registerCloseGuard(guard);
      return () => registerCloseGuard(null);
    }, [registerCloseGuard]);
    return (
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        data-slot="settings-view"
        data-testid="settings-view"
        data-section={props.section}
      >
        <button type="button" data-testid="settings-modal-close" onClick={props.onClose}>
          {props.backLabel}
        </button>
        <button
          type="button"
          data-testid="studio-switch-close"
          onClick={() => props.onCloseSession()}
        />
        <button
          type="button"
          data-testid="settings-go-account"
          onClick={() => props.onSectionChange('account')}
        />
      </div>
    );
  };
  return {
    get SettingsView() {
      settingsChunk.loads += 1;
      if (settingsChunk.importFails) throw chunkLoadError();
      return SettingsView;
    },
  };
});

vi.mock('./components/NewSessionModal', () => ({
  NewSessionModal: (props: { onCreated: (sessionId: string) => void }) => (
    <button
      type="button"
      data-testid="new-session-create"
      onClick={() => props.onCreated('created-1')}
    />
  ),
}));

vi.mock('./components/BatchImportModal', () => ({
  BatchImportModal: (props: { profile?: unknown; onClose: () => void }) => (
    <div role="dialog" aria-label="Batch Import" data-testid="batch-import-modal">
      <button type="button" data-testid="batch-import-close" onClick={props.onClose} />
    </div>
  ),
}));

vi.mock('./components/YouTubeImportErrorModal', () => ({
  YouTubeImportErrorModal: () => null,
}));

const mockedUseProfile = vi.mocked(useProfile);

// A signed-in profile with two teams, for the top-bar tests (the default `undefined` profile is
// the loading window most tests here want).
const twoTeamProfile = {
  active_studio_id: 'team-a',
  active_show_id: 'show-a',
  active_studio: { id: 'team-a', name: 'Team A', categories: [] },
  studios: [
    { id: 'team-a', name: 'Team A' },
    { id: 'team-b', name: 'Team B' },
  ],
  studio_settings: {},
  shows: [
    {
      id: 'show-a',
      studio_id: 'team-a',
      name: 'Show A',
      show_code: 'A',
      title_suffix: 'date',
      can_access: true,
    },
    {
      id: 'show-b',
      studio_id: 'team-b',
      name: 'Show B',
      show_code: 'B',
      title_suffix: 'date',
      can_access: true,
    },
  ],
  auth: {
    logged_in: true,
    oauth_configured: true,
    user: {
      id: 'u1',
      email: 'u1@example.com',
      given_name: 'U',
      family_name: 'One',
      picture_url: null,
      teams: [
        { id: 'team-a', name: 'Team A', role: 'owner' },
        { id: 'team-b', name: 'Team B', role: 'member' },
      ],
    },
  },
};
const mockedUseYoutubeImport = vi.mocked(useYoutubeImport);

function renderShell(initialPath = '/') {
  const memory = memoryLocation({ path: initialPath, record: true });
  setNavigationImplForTesting((path, options) => memory.navigate(path, options));
  const view = renderStrict(
    <Router hook={memory.hook}>
      <AppShell />
    </Router>,
  );
  return { view, memory };
}

const workspaceSessionId = () =>
  screen.getByTestId('session-route').getAttribute('data-session-id');

const settingsSection = () => screen.getByTestId('settings-view').getAttribute('data-section');
const openSettingsFromRail = () =>
  fireEvent.click(document.getElementById('v6-btn-settings') as HTMLElement);

beforeEach(() => {
  settingsChunk.fail = false;
  settingsChunk.importFails = false;
  settingsChunk.loads = 0;
  settingsChunk.renders = 0;
  settingsChunk.guard = null;
  mockedUseProfile.mockReturnValue({ data: undefined } as unknown as ReturnType<typeof useProfile>);
  profileWrite.mockResolvedValue(undefined);
  mockedUseYoutubeImport.mockReturnValue({
    mutateAsync: vi.fn().mockResolvedValue(undefined),
  } as unknown as ReturnType<typeof useYoutubeImport>);
});

afterEach(() => {
  setNavigationImplForTesting(null);
  window.history.replaceState(null, '', '/');
  resetOriginationForTesting();
  vi.clearAllMocks();
});

describe('AppShell routing (URL-addressed session state)', () => {
  it('selecting a session pushes /sessions/:id and mounts the workspace', () => {
    const { memory } = renderShell();
    expect(workspaceSessionId()).toBe('');

    fireEvent.click(screen.getByTestId('rail-select-s1'));

    expect(memory.history).toEqual(['/', '/sessions/sess-1']);
    expect(workspaceSessionId()).toBe('sess-1');
  });

  it('re-selecting the active session adds no history entry', () => {
    const { memory } = renderShell();
    fireEvent.click(screen.getByTestId('rail-select-s1'));
    fireEvent.click(screen.getByTestId('rail-select-s1'));

    expect(memory.history).toEqual(['/', '/sessions/sess-1']);
    expect(workspaceSessionId()).toBe('sess-1');
  });

  it('switching to another session pushes its /sessions/:id', () => {
    const { memory } = renderShell();
    fireEvent.click(screen.getByTestId('rail-select-s1'));
    fireEvent.click(screen.getByTestId('rail-select-s2'));

    expect(memory.history).toEqual(['/', '/sessions/sess-1', '/sessions/sess-2']);
    expect(workspaceSessionId()).toBe('sess-2');
  });

  it('a deep-linked initial location mounts the workspace for that id', () => {
    const { memory } = renderShell('/sessions/deep-1');

    expect(workspaceSessionId()).toBe('deep-1');
    expect(memory.history).toEqual(['/sessions/deep-1']);
  });

  it('closing pushes / , unmounts the workspace, and stops the transport this client originated (design D4 — full origination matrix in departureWatcher.test.tsx)', () => {
    const stop = vi.fn();
    register('stopTransportIfNeeded', stop);
    const { memory } = renderShell('/sessions/sess-1');
    expect(workspaceSessionId()).toBe('sess-1');
    markOriginated('sess-1');

    fireEvent.click(screen.getByTestId('rail-close'));

    expect(memory.history).toEqual(['/sessions/sess-1', '/']);
    expect(workspaceSessionId()).toBe('');
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('closing with no active session pushes no duplicate / entry', () => {
    const { memory } = renderShell();

    fireEvent.click(screen.getByTestId('rail-close'));

    expect(memory.history).toEqual(['/']);
  });

  it('creating a session navigates to its /sessions/:id like selection', async () => {
    const { memory } = renderShell();

    fireEvent.click(screen.getByTestId('rail-new'));
    fireEvent.click(await screen.findByTestId('new-session-create'));

    expect(memory.history).toEqual(['/', '/sessions/created-1']);
    expect(workspaceSessionId()).toBe('created-1');
  });

  it('Batch Import opens the empty batch-import modal and closes via its close control', async () => {
    renderShell();

    expect(screen.queryByTestId('batch-import-modal')).toBeNull();
    fireEvent.click(screen.getByTestId('rail-batch'));
    expect(await screen.findByTestId('batch-import-modal')).not.toBeNull();

    fireEvent.click(screen.getByTestId('batch-import-close'));
    expect(screen.queryByTestId('batch-import-modal')).toBeNull();
  });

  it('the studio-switch save path navigates to / like the close control, stopping an originated roll', async () => {
    const stop = vi.fn();
    register('stopTransportIfNeeded', stop);
    const { memory } = renderShell('/sessions/sess-1');
    markOriginated('sess-1');

    // The studio-switch save branch lives in Settings (the view's interim legacy dialog until
    // group 7), mounted directly by AppShell rather than threaded through a mocked SessionRoute.
    fireEvent.click(document.getElementById('v6-btn-settings') as HTMLElement);
    fireEvent.click(await screen.findByTestId('studio-switch-close'));

    expect(memory.history).toEqual(['/sessions/sess-1', '/']);
    expect(workspaceSessionId()).toBe('');
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('browser Back leaves the session (URL drives the workspace unmount)', async () => {
    // Real jsdom history + wouter's default browser location: no Router
    // wrapper and no navigation-impl override, so `navigate()` goes through
    // pushState and Back fires popstate.
    window.history.replaceState(null, '', '/');
    renderStrict(<AppShell />);

    fireEvent.click(screen.getByTestId('rail-select-s1'));
    expect(window.location.pathname).toBe('/sessions/sess-1');
    expect(workspaceSessionId()).toBe('sess-1');

    window.history.back();
    await waitFor(() => expect(window.location.pathname).toBe('/'));
    await waitFor(() => expect(workspaceSessionId()).toBe(''));
  });

  it('Teams route is a first-class app route: /teams renders the home view with Settings open on Members, and browser Back returns to the previous view', async () => {
    // Real jsdom history (no memory-location Router), same idiom as the
    // "browser Back leaves the session" test above — Back needs real
    // popstate behavior.
    window.history.replaceState(null, '', '/');
    renderStrict(<AppShell />);

    fireEvent.click(screen.getByTestId('rail-select-s1'));
    expect(window.location.pathname).toBe('/sessions/sess-1');
    expect(workspaceSessionId()).toBe('sess-1');

    navigate('/teams');
    await waitFor(() => expect(window.location.pathname).toBe('/teams'));
    // The home view underneath (no session), the view over it on Members.
    await waitFor(() => expect(workspaceSessionId()).toBe(''));
    expect(await screen.findByTestId('settings-view')).not.toBeNull();
    expect(settingsSection()).toBe('members');

    window.history.back();
    await waitFor(() => expect(window.location.pathname).toBe('/sessions/sess-1'));
    await waitFor(() => expect(workspaceSessionId()).toBe('sess-1'));
    // Shell state, not the URL, gates the view: it stays open across the route change.
    expect(settingsSection()).toBe('members');
  });

  it('The teams route announces its own chunk wait: the home view with nothing overlaid', () => {
    // Synchronous on purpose: `LazyChunk`'s `lazy()` suspends on its FIRST render whatever
    // the module cache holds, so the overlay boundary's `null` fallback is what the initial
    // `/teams` commit paints. `/teams` has no chunk or loading frame of its own any more.
    renderShell('/teams');

    expect(workspaceSessionId()).toBe('');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('#teams-route-loading')).toBeNull();
    expect(document.querySelector('#session-route-loading')).toBeNull();
  });

  it('The teams route announces its own chunk failure: a dismissible card over the home view', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      settingsChunk.fail = true;
      const { memory } = renderShell('/teams');

      const card = await screen.findByTestId('chunk-load-error');
      expect(card.getAttribute('data-variant')).toBe('overlay');
      expect(workspaceSessionId()).toBe('');
      expect(screen.getByTestId('rail')).not.toBeNull();

      // Dismissing closes the view, which on /teams goes home.
      fireEvent.click(screen.getByTestId('chunk-load-dismiss'));
      expect(screen.queryByTestId('chunk-load-error')).toBeNull();
      expect(memory.history).toEqual(['/teams', '/']);
    } finally {
      logged.mockRestore();
    }
  });

  it('an unmatched path renders the home view without rewriting the URL', () => {
    const { memory } = renderShell('/src/pages/index/index.html');

    expect(workspaceSessionId()).toBe('');
    expect(memory.history).toEqual(['/src/pages/index/index.html']);
  });

  it('resets document.title to AutoLogger when no session is active', () => {
    document.title = 'Some Session — elsewhere';
    const { view } = renderShell();
    expect(document.title).toBe('AutoLogger');
    view.unmount();

    // Reset happens on close too, not just on the no-session mount.
    document.title = 'Some Session — elsewhere';
    const shell = renderShell('/sessions/sess-1');
    expect(document.title).toBe('Some Session — elsewhere');
    fireEvent.click(screen.getByTestId('rail-close'));
    expect(document.title).toBe('AutoLogger');
    shell.view.unmount();
  });
});

describe('AppShell Settings view state (redesign-show-ignition D3)', () => {
  // Assertions on the view are `findBy*`/`waitFor` since it sits behind `React.lazy`: the
  // mount lands a microtask after the click, not synchronously with it. The negative
  // assertions stay synchronous on purpose — "no dialog yet" must hold at the instant it is
  // checked, and awaiting one would weaken it into "no dialog eventually".

  it('Settings opens from /teams: loading /teams shows Settings › Members', async () => {
    const { memory } = renderShell('/teams');
    expect(await screen.findByTestId('settings-view')).not.toBeNull();
    expect(settingsSection()).toBe('members');
    expect(workspaceSessionId()).toBe('');
    expect(memory.history).toEqual(['/teams']);
  });

  it('settings opens on /', async () => {
    renderShell('/');
    openSettingsFromRail();
    expect(await screen.findByRole('dialog')).not.toBeNull();
  });

  it('settings opens on /sessions/:id, with a back control that names the session', async () => {
    renderShell('/sessions/sess-1');
    openSettingsFromRail();
    expect(await screen.findByRole('dialog')).not.toBeNull();
    expect(screen.getByTestId('settings-modal-close').textContent).toBe('Back to session');
  });

  it('the first open lands on Show details; a later open returns to the section last visited', async () => {
    renderShell('/');
    openSettingsFromRail();
    await screen.findByTestId('settings-view');
    expect(settingsSection()).toBe('show-details');

    fireEvent.click(screen.getByTestId('settings-go-account'));
    expect(settingsSection()).toBe('account');
    fireEvent.click(screen.getByTestId('settings-modal-close'));
    expect(screen.queryByTestId('settings-view')).toBeNull();

    openSettingsFromRail();
    expect(await screen.findByTestId('settings-view')).not.toBeNull();
    expect(settingsSection()).toBe('account');
  });

  it('closes via its own onClose control, wired straight through AppShell (web-coordination-seam D4: replaces the retired AutoLogger_closeSettingsModal global)', async () => {
    const { memory } = renderShell('/');
    openSettingsFromRail();
    expect(await screen.findByRole('dialog')).not.toBeNull();

    fireEvent.click(screen.getByTestId('settings-modal-close'));
    expect(screen.queryByRole('dialog')).toBeNull();
    // Off /teams, closing navigates nowhere.
    expect(memory.history).toEqual(['/']);
  });

  it('Teams page offers a way back in every state: closing on /teams lands on /', async () => {
    const { memory } = renderShell('/teams');
    await screen.findByTestId('settings-view');

    fireEvent.click(screen.getByTestId('settings-modal-close'));

    expect(memory.history).toEqual(['/teams', '/']);
    expect(screen.queryByTestId('settings-view')).toBeNull();
    expect(workspaceSessionId()).toBe('');
  });

  it('Open modal survives route changes: a route change with Settings open never desynchronises', async () => {
    window.history.replaceState(null, '', '/');
    renderStrict(<AppShell />);

    openSettingsFromRail();
    expect(await screen.findByRole('dialog')).not.toBeNull();
    expect(settingsSection()).toBe('show-details');

    navigate('/teams');
    await waitFor(() => expect(window.location.pathname).toBe('/teams'));
    // Still open — SYNCHRONOUSLY (the route change must not unmount and re-suspend an
    // already-open view) — and now on Members, because arriving at /teams opens it there.
    expect(screen.getByRole('dialog')).not.toBeNull();
    expect(settingsSection()).toBe('members');

    window.history.back();
    await waitFor(() => expect(window.location.pathname).toBe('/'));
    expect(screen.getByRole('dialog')).not.toBeNull();
    expect(settingsSection()).toBe('members');

    // Closed through its own close path on `/`: no navigation.
    fireEvent.click(screen.getByTestId('settings-modal-close'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(window.location.pathname).toBe('/');
  });

  it('An open modal is unaffected: it keeps its section across a route change', async () => {
    const { memory } = renderShell('/');
    openSettingsFromRail();
    await screen.findByTestId('settings-view');
    fireEvent.click(screen.getByTestId('settings-go-account'));

    fireEvent.click(screen.getByTestId('rail-select-s1'));
    expect(memory.history).toEqual(['/', '/sessions/sess-1']);
    expect(settingsSection()).toBe('account');
    expect(workspaceSessionId()).toBe('sess-1');
  });

  it('renders no dialog during the profile-loading window until Settings is clicked (profile still undefined)', () => {
    renderShell('/');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('studio-switch save on /teams does not navigate (no open session to close)', async () => {
    const { memory } = renderShell('/teams');

    fireEvent.click(await screen.findByTestId('studio-switch-close'));

    expect(memory.history).toEqual(['/teams']);
  });
});

// --- The Settings view costs nothing while closed (web-ui-system "The Settings modal costs
// nothing while closed"): the shell's mount gate. The view owns both initialisation scopes, so a
// view that is neither fetched nor rendered initialises nothing; the per-scope assertions arrive
// with the sections that own them (groups 7-9).
describe('The Settings modal costs nothing while closed', () => {
  it('A closed modal renders nothing: not mounted, and its module not fetched', () => {
    renderShell('/');
    expect(screen.queryByTestId('settings-view')).toBeNull();
    expect(settingsChunk.loads).toBe(0);
    expect(settingsChunk.renders).toBe(0);
  });

  it('Initialisation is deferred until the modal opens', async () => {
    mockedUseProfile.mockReturnValue({
      data: twoTeamProfile,
    } as unknown as ReturnType<typeof useProfile>);
    renderShell('/');
    // The profile resolved while closed: still nothing fetched or rendered.
    expect(settingsChunk.loads).toBe(0);
    expect(settingsChunk.renders).toBe(0);

    openSettingsFromRail();
    expect(await screen.findByTestId('settings-view')).not.toBeNull();
    expect(settingsChunk.loads).toBeGreaterThan(0);
  });
});

// --- Settings chunk splitting (bundle route-splitting, plan C5.5) ---
//
// The Settings view is a `settings`-state-gated `React.lazy` mount (it took
// over the previous Settings dialog's split point), with an idle prefetch warming the chunk. Two
// properties are pinned here: the open path still works across the async
// boundary, and the prefetch is import-only — it must never mount, render, or
// otherwise put the modal on screen on its own.
describe('AppShell settings modal code-splitting (plan C5.5)', () => {
  it('A cold first open traverses the chunk boundary: nothing on screen at the instant of the click, the view after the lazy boundary resolves', async () => {
    renderShell('/');
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(document.getElementById('v6-btn-settings') as HTMLElement);

    const dialog = await screen.findByRole('dialog');
    expect(dialog).not.toBeNull();
    expect(screen.getByTestId('settings-view')).not.toBeNull();
  });

  it('the idle prefetch mounts nothing — advancing past its delay leaves the DOM unchanged', async () => {
    vi.useFakeTimers();
    try {
      renderShell('/');
      expect(screen.queryByRole('dialog')).toBeNull();

      // Past the 2.5s prefetch delay, and then some.
      await act(async () => {
        vi.advanceTimersByTime(5000);
      });
      // Let any import() microtasks the prefetch kicked off settle.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      // Warming the chunk is not opening the modal.
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.queryByTestId('settings-view')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // A warm-up is fire-and-forget by construction, so the ONLY way its failure can surface is
  // as an unhandled rejection — a redeploy that rotates the content-hashed chunk URL out from
  // under an idle tab makes that the common case, not the exotic one. Nothing is on screen to
  // degrade and `LazyChunk` still owns the real open, so the warm-up must swallow it.
  it('a failed warm-up import is swallowed — no unhandled rejection, nothing on screen', async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onUnhandled);
    vi.useFakeTimers();
    try {
      settingsChunk.importFails = true;
      renderShell('/');

      await act(async () => {
        vi.advanceTimersByTime(5000);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      vi.useRealTimers();
      // Node reports unhandled rejections a macrotask after the microtask queue drains, so
      // the assertion has to be behind a real tick — under fake timers it would always pass.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(rejections).toEqual([]);
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.queryByTestId('chunk-load-error')).toBeNull();
    } finally {
      vi.useRealTimers();
      process.off('unhandledRejection', onUnhandled);
    }
  });

  // --- Chunk-failure containment (review fix) ---
  //
  // Each split point gets its OWN error boundary, so a dead chunk degrades the
  // surface that needed it and nothing else. Without one, the throw travels up
  // through `<Suspense>` and out of the `ssr: false` island — there is no
  // `error.page.tsx` above it (pageExtensions is pinned) — and the entire app
  // unmounts to a blank page that only a manual reload can recover.
  it('a failed settings chunk shows a dismissible retry card and leaves the route mounted', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      settingsChunk.fail = true;
      renderShell('/sessions/sess-1');
      expect(workspaceSessionId()).toBe('sess-1');

      fireEvent.click(document.getElementById('v6-btn-settings') as HTMLElement);

      const card = await screen.findByTestId('chunk-load-error');
      expect(card.getAttribute('data-variant')).toBe('overlay');
      // Containment: the route, the rail, and the shell all survived a failure
      // in an overlay-level chunk.
      expect(workspaceSessionId()).toBe('sess-1');
      expect(screen.getByTestId('rail')).not.toBeNull();
      expect(screen.queryByTestId('settings-view')).toBeNull();

      // The overlay's dismiss closes the shell state that opened it, so the
      // user is not stuck behind a card whose own close button is inside the
      // chunk that failed to load.
      fireEvent.click(screen.getByTestId('chunk-load-dismiss'));
      expect(screen.queryByTestId('chunk-load-error')).toBeNull();
      expect(workspaceSessionId()).toBe('sess-1');
    } finally {
      logged.mockRestore();
    }
  });
});

describe('AppShell workspace render isolation (settings-modal-mount-cost, D0)', () => {
  // Spec: "The shell-to-workspace render boundary stays memoizable" — every
  // prop crossing the AppShell -> SessionRoute -> WorkspaceStatic boundary
  // must hold a stable identity across shell renders, or WorkspaceStatic's
  // memo never bails out. These tests assert exactly that: prop identity
  // survives each of five shell state changes. They assert nothing about how
  // often the workspace actually re-renders in practice.
  //
  // An earlier version of this comment cited a profiled win for this fix
  // (+11,097 re-renders, 70 ms -> 101 ms). That figure was withdrawn — it came
  // from the `agent-browser react renders` instrument, which was found to
  // over-count for this app; ground truth (console.log at the top of the
  // render body) shows the workspace re-renders zero times on a settings
  // click, with or without this fix. See design.md D0 and
  // `.apply/phase2-diagnostic.md`. The fix is kept for correctness (it removes
  // a real, mutation-checked memo defeat), not for a measured performance
  // consequence.

  beforeEach(() => {
    sessionRouteProbe.renders.length = 0;
  });

  function lastRender() {
    const last = sessionRouteProbe.renders.at(-1);
    if (!last) throw new Error('SessionRoute mock never rendered');
    return last;
  }

  it('opening the settings modal keeps the SessionRoute boundary props referentially stable', async () => {
    renderShell('/sessions/sess-1');
    const before = lastRender();
    expect(before.sessionId).toBe('sess-1');

    fireEvent.click(document.getElementById('v6-btn-settings') as HTMLElement);
    expect(await screen.findByRole('dialog')).not.toBeNull();

    const after = lastRender();
    expect(after.sessionId).toBe('sess-1');
    expect(after.onNewSession).toBe(before.onNewSession);
  });

  it('closing the settings modal keeps the SessionRoute boundary props referentially stable', async () => {
    renderShell('/sessions/sess-1');
    fireEvent.click(document.getElementById('v6-btn-settings') as HTMLElement);
    await screen.findByRole('dialog');
    const before = lastRender();

    fireEvent.click(screen.getByTestId('settings-modal-close'));
    expect(screen.queryByRole('dialog')).toBeNull();

    const after = lastRender();
    expect(after.onNewSession).toBe(before.onNewSession);
  });

  it('opening the New Session modal keeps the SessionRoute boundary props referentially stable', async () => {
    renderShell('/sessions/sess-1');
    const before = lastRender();

    fireEvent.click(screen.getByTestId('rail-new'));
    expect(await screen.findByTestId('new-session-create')).not.toBeNull();

    const after = lastRender();
    expect(after.onNewSession).toBe(before.onNewSession);
  });

  it('opening the Batch Import modal keeps the SessionRoute boundary props referentially stable', async () => {
    renderShell('/sessions/sess-1');
    const before = lastRender();

    fireEvent.click(screen.getByTestId('rail-batch'));
    expect(await screen.findByTestId('batch-import-modal')).not.toBeNull();

    const after = lastRender();
    expect(after.onNewSession).toBe(before.onNewSession);
  });

  it('toggling the navigation sidebar keeps the SessionRoute boundary props referentially stable', () => {
    // redesign-show-ignition D8: the rail opens and closes from the top bar's sidebar trigger
    // (on phones, the sidebar's sheet), not from a callback threaded into the workspace.
    renderShell('/sessions/sess-1');
    const before = lastRender();

    fireEvent.click(screen.getByRole('button', { name: /toggle sidebar/i }));
    expect(screen.getByTestId('rail').getAttribute('data-sidebar-state')).toBe('collapsed');

    const after = lastRender();
    expect(after.sessionId).toBe(before.sessionId);
    expect(after.ytImportPending).toBe(before.ytImportPending);
    expect(after.onNewSession).toBe(before.onNewSession);
    expect('onOpenMobileNav' in after).toBe(false);
  });
});

describe('AppShell legacy spine retirement', () => {
  it('writes no body.dataset.sessionId and defines no V3_* globals across transitions', () => {
    renderShell();

    fireEvent.click(screen.getByTestId('rail-select-s1'));
    fireEvent.click(screen.getByTestId('rail-select-s2'));
    fireEvent.click(screen.getByTestId('rail-close'));

    expect('sessionId' in document.body.dataset).toBe(false);
    expect('V3_selectSession' in window).toBe(false);
    expect('V3_closeSession' in window).toBe(false);
  });

  // --- web-coordination-seam task 5.2 (spec "Enforcement checks are proven
  // non-vacuous": "A negative runtime assertion ... SHALL be made in a
  // context where that handle's owning component actually mounts") ---
  //
  // `AppShell` is the real, unmocked SUT in every test in this file — unlike
  // `SessionRoute` and the Settings view, which ARE module-mocked here
  // (design D8's counter-example) and so cannot host a meaningful assertion
  // for handles either of THEM owns (seekAudio, stopTransportIfNeeded, ...).
  // These three globals were different: `AppShell.tsx`'s own mount-once boot
  // effect (see its header comment) installed all three directly, so
  // `AppShell` mounting here — which it always does — is the correct place.
  // Exercises the exact interactions that used to route through them: open
  // + close the settings modal (`AutoLogger_closeSettingsModal`) and select a
  // session (`Home_reloadSessionList` / `Home_clearSessionList` fired on the
  // session-list refetch path).
  it('defines no AutoLogger_closeSettingsModal / Home_reloadSessionList / Home_clearSessionList globals (web-coordination-seam D4)', async () => {
    renderShell();

    fireEvent.click(document.getElementById('v6-btn-settings') as HTMLElement);
    fireEvent.click(await screen.findByTestId('settings-modal-close'));
    fireEvent.click(screen.getByTestId('rail-select-s1'));

    expect('AutoLogger_closeSettingsModal' in window).toBe(false);
    expect('Home_reloadSessionList' in window).toBe(false);
    expect('Home_clearSessionList' in window).toBe(false);
  });
});

// --- Shell transport tint (redesign-show-ignition D2, task 2.3) ---
//
// AppShell reads the transport-status store and sets `data-transport` on the
// app root, which wraps the rail and main; the tints are pure CSS on it.
describe('AppShell transport tint (data-transport)', () => {
  const appRoot = () => {
    const roots = document.querySelectorAll('[data-transport]');
    expect(roots).toHaveLength(1);
    const root = roots[0] as HTMLElement;
    expect(root.contains(screen.getByTestId('rail'))).toBe(true);
    expect(root.contains(screen.getByTestId('session-route'))).toBe(true);
    return root;
  };

  it('is stopped with no session open', () => {
    renderShell('/');
    expect(appRoot().getAttribute('data-transport')).toBe('stopped');
  });

  it("follows the store's four states", () => {
    renderShell('/sessions/sess-1');
    const owner = {};
    for (const state of ['recording', 'rolling', 'playback', 'stopped'] as const) {
      act(() => {
        publishTransportStatus(owner, { state, sessionId: 'sess-1', title: 'Ep 1' });
      });
      expect(appRoot().getAttribute('data-transport')).toBe(state);
    }
    act(() => {
      publishTransportStatus(owner, { state: 'recording', sessionId: 'sess-1', title: 'Ep 1' });
    });
    act(() => {
      clearTransportStatus(owner);
    });
    expect(appRoot().getAttribute('data-transport')).toBe('stopped');
  });
});

// --- Top bar (redesign-show-ignition 3.1-3.3; web-ui-system "Top bar names the active team, show
// and transport state"; web-session-routing "Studio-switch close path still works") ---
//
// The real TopBar, mounted by AppShell: a team switch goes through AppShell's close-session path,
// and the status control returns to the open session, closing Settings.
describe('AppShell top bar', () => {
  beforeEach(() => {
    mockedUseProfile.mockReturnValue({
      data: twoTeamProfile,
    } as unknown as ReturnType<typeof useProfile>);
  });

  async function chooseTeamB() {
    fireEvent.pointerDown(screen.getByRole('button', { name: /switch team/i }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /team b/i }));
    await waitFor(() => expect(profileWrite).toHaveBeenCalledWith({ active_studio_id: 'team-b' }));
  }

  it('spans the shell above the rail and the main column, inside the transport root', () => {
    renderShell('/');
    // By slot, not role: the retained void `#v4-app-top-bar` <header> inside <main> is also
    // reported as a banner by jsdom (browsers scope a header inside <main> out of the role).
    const bar = document.querySelector("[data-slot='topbar']") as HTMLElement;
    expect(bar).not.toBeNull();
    expect(bar.tagName).toBe('HEADER');
    const root = document.querySelector('[data-transport]') as HTMLElement;
    expect(root.contains(bar)).toBe(true);
    const rail = screen.getByTestId('rail');
    // Not inside the rail's row: the bar precedes the row that holds rail and main.
    expect(bar.contains(rail)).toBe(false);
    expect(bar.compareDocumentPosition(rail) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.getElementById('v6-app')?.contains(bar)).toBe(false);
  });

  it('switching team on /sessions/:id follows the close-session path to /', async () => {
    const stop = vi.fn();
    register('stopTransportIfNeeded', stop);
    const { memory } = renderShell('/sessions/sess-1');
    markOriginated('sess-1');

    await chooseTeamB();

    await waitFor(() => expect(memory.history).toEqual(['/sessions/sess-1', '/']));
    expect(workspaceSessionId()).toBe('');
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('switching team on /teams does not navigate', async () => {
    const { memory } = renderShell('/teams');
    await chooseTeamB();
    expect(memory.history).toEqual(['/teams']);
  });

  it('with Settings open over a recording session, the status closes Settings and shows the console', async () => {
    const { memory } = renderShell('/sessions/sess-1');
    act(() => {
      publishTransportStatus({}, { state: 'recording', sessionId: 'sess-1', title: 'Ep 1' });
    });
    fireEvent.click(document.getElementById('v6-btn-settings') as HTMLElement);
    expect(await screen.findByRole('dialog', { name: 'Settings' })).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /REC, Ep 1\. Return to session/ }));

    expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull();
    expect(workspaceSessionId()).toBe('sess-1');
    expect(memory.history).toEqual(['/sessions/sess-1']);
  });

  it('the status asks the view first: a declined discard keeps Settings open, a confirmed one closes it', async () => {
    let answer = false;
    settingsChunk.guard = () => Promise.resolve(answer);
    const { memory } = renderShell('/');
    act(() => {
      publishTransportStatus({}, { state: 'recording', sessionId: 'sess-1', title: 'Ep 1' });
    });
    fireEvent.click(document.getElementById('v6-btn-settings') as HTMLElement);
    await screen.findByRole('dialog', { name: 'Settings' });
    const status = screen.getByRole('button', { name: /REC, Ep 1\. Return to session/ });

    await act(async () => {
      fireEvent.click(status);
    });
    expect(screen.getByRole('dialog', { name: 'Settings' })).not.toBeNull();
    expect(memory.history).toEqual(['/']);

    answer = true;
    await act(async () => {
      fireEvent.click(status);
    });
    expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull();
    expect(memory.history).toEqual(['/', '/sessions/sess-1']);
  });

  it('a team switch with unsaved Settings edits asks first: declining keeps the edits and the team, confirming switches', async () => {
    let answer = false;
    const guard = vi.fn(() => Promise.resolve(answer));
    settingsChunk.guard = guard;
    const { memory } = renderShell('/');
    fireEvent.click(document.getElementById('v6-btn-settings') as HTMLElement);
    await screen.findByRole('dialog', { name: 'Settings' });

    fireEvent.pointerDown(screen.getByRole('button', { name: /switch team/i }), {
      button: 0,
      ctrlKey: false,
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole('menuitemradio', { name: /team b/i }));
    });
    expect(guard).toHaveBeenCalledTimes(1);
    expect(profileWrite).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Settings' })).not.toBeNull();

    answer = true;
    await chooseTeamB();
    expect(guard).toHaveBeenCalledTimes(2);
    // The view stays open on the new team; only the edits went.
    expect(screen.getByRole('dialog', { name: 'Settings' })).not.toBeNull();
    expect(memory.history).toEqual(['/']);
  });

  it('a team switch with Settings closed consults no guard', async () => {
    const guard = vi.fn(() => Promise.resolve(false));
    settingsChunk.guard = guard;
    renderShell('/');
    await chooseTeamB();
    expect(guard).not.toHaveBeenCalled();
  });

  it('the status returns to its session from another route', () => {
    const { memory } = renderShell('/teams');
    act(() => {
      publishTransportStatus({}, { state: 'rolling', sessionId: 'sess-9', title: 'Ep 9' });
    });
    fireEvent.click(screen.getByRole('button', { name: /return to session/i }));
    expect(memory.history).toEqual(['/teams', '/sessions/sess-9']);
  });
});

// --- Shell-level sidebar shortcut (redesign-show-ignition D8, task 4.1; web-ui-system
// "Shell-level sidebar shortcut") ---
//
// AppShell owns one `[` listener on every signed-in route, with or without a session; it yields
// to typing targets and open dialogs/menus. Ctrl/⌘+B stays the primitive's own.
describe('AppShell sidebar shortcut', () => {
  const railState = () => screen.getByTestId('rail').getAttribute('data-sidebar-state');
  const press = (target: Element = document.body, init: KeyboardEventInit = {}) =>
    fireEvent.keyDown(target, { key: '[', code: 'BracketLeft', ...init });

  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it('on / with no session, `[` collapses the sidebar and `[` again expands it', () => {
    renderShell('/');
    expect(workspaceSessionId()).toBe('');
    expect(railState()).toBe('expanded');
    press();
    expect(railState()).toBe('collapsed');
    press();
    expect(railState()).toBe('expanded');
  });

  it('also toggles with a session open', () => {
    renderShell('/sessions/sess-1');
    press();
    expect(railState()).toBe('collapsed');
  });

  it('does nothing while focus is in the search input', () => {
    renderShell('/');
    const input = screen.getByRole('searchbox', { name: 'Search sessions' });
    input.focus();
    press(input);
    expect(railState()).toBe('expanded');
  });

  it('does nothing while a dialog is open', async () => {
    renderShell('/');
    fireEvent.click(screen.getByTestId('rail-batch'));
    expect(await screen.findByRole('dialog', { name: 'Batch Import' })).not.toBeNull();
    press();
    expect(railState()).toBe('expanded');
  });

  it('still toggles over the Settings view, the one dialog that lets `[` through', async () => {
    renderShell('/');
    openSettingsFromRail();
    expect(await screen.findByTestId('settings-view')).not.toBeNull();
    press();
    expect(railState()).toBe('collapsed');
  });

  it('ignores modified brackets', () => {
    renderShell('/');
    press(document.body, { ctrlKey: true });
    press(document.body, { metaKey: true });
    press(document.body, { altKey: true });
    expect(railState()).toBe('expanded');
  });

  it('the state set by `[` persists across a remount', () => {
    const first = renderShell('/');
    press();
    expect(railState()).toBe('collapsed');
    first.view.unmount();
    renderShell('/');
    expect(railState()).toBe('collapsed');
  });

  it('storage that throws defaults to expanded, and `[` still toggles', () => {
    const own = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('denied');
      },
    });
    try {
      renderShell('/');
      expect(railState()).toBe('expanded');
      press();
      expect(railState()).toBe('collapsed');
    } finally {
      if (own) Object.defineProperty(window, 'localStorage', own);
      else delete (window as unknown as Record<string, unknown>).localStorage;
    }
  });
});
