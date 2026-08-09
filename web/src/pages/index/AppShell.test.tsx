import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { useProfile } from '../../api/hooks/useProfile';
import { useYoutubeImport } from '../../api/hooks/useSessions';
import { renderStrict } from '../../test/renderStrict';
import { AppShell } from './AppShell';
import { register } from './coordination/registry';
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
// standing in for HomeSettingsModal's studio-switch save branch (its own
// branch logic is covered in HomeSettingsModal.test.tsx). Location is driven
// by `wouter/memory-location` (recorded history) except for the browser-Back
// test, which uses jsdom's real history.

vi.mock('../../api/hooks/useProfile', () => ({
  useProfile: vi.fn(),
}));

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

vi.mock('./components/V6Rail', () => ({
  V6Rail: (props: {
    activeSessionId: string;
    onSelectSession: (sid: string) => void;
    onCloseSession: () => void;
    onNewSession: () => void;
    onBatchImport: () => void;
    onOpenSettings: () => void;
  }) => (
    <div data-testid="rail" data-active-session-id={props.activeSessionId}>
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
  ),
}));

vi.mock('./components/SessionRoute', () => ({
  SessionRoute: (props: { sessionId: string }) => (
    <div data-testid="session-route" data-session-id={props.sessionId} />
  ),
}));

// HomeSettingsModal is the lift target (D1): AppShell now mounts it directly
// (beside the route switch, not routed-component-owned), so this file's
// concern is the WIRING (isOpen/onClose/onCloseSession reach the modal and
// survive route changes) — not the modal's own internals (profile hydration,
// save semantics), which HomeSettingsModal.test.tsx covers against the real
// component. The mock renders a real `role="dialog"` node only while open
// (mirroring Dialog/Radix's own mount-on-open behavior) plus a stand-in
// button for the studio-switch save branch, rewired here from the old
// SessionRoute-mock button (teams-settings-nav, design D1).
vi.mock('./components/HomeSettingsModal', () => ({
  HomeSettingsModal: (props: {
    isOpen: boolean;
    onClose: () => void;
    onCloseSession: () => void;
  }) =>
    props.isOpen ? (
      <div role="dialog" aria-label="Settings" data-testid="home-settings-modal">
        <button type="button" data-testid="settings-modal-close" onClick={props.onClose} />
        <button
          type="button"
          data-testid="studio-switch-close"
          onClick={() => props.onCloseSession()}
        />
      </div>
    ) : null,
}));

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

beforeEach(() => {
  mockedUseProfile.mockReturnValue({ data: undefined } as unknown as ReturnType<typeof useProfile>);
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

  it('creating a session navigates to its /sessions/:id like selection', () => {
    const { memory } = renderShell();

    fireEvent.click(screen.getByTestId('rail-new'));
    fireEvent.click(screen.getByTestId('new-session-create'));

    expect(memory.history).toEqual(['/', '/sessions/created-1']);
    expect(workspaceSessionId()).toBe('created-1');
  });

  it('Batch Import opens the empty batch-import modal and closes via its close control', () => {
    renderShell();

    expect(screen.queryByTestId('batch-import-modal')).toBeNull();
    fireEvent.click(screen.getByTestId('rail-batch'));
    expect(screen.getByTestId('batch-import-modal')).not.toBeNull();

    fireEvent.click(screen.getByTestId('batch-import-close'));
    expect(screen.queryByTestId('batch-import-modal')).toBeNull();
  });

  it('the studio-switch save path navigates to / like the close control, stopping an originated roll', () => {
    const stop = vi.fn();
    register('stopTransportIfNeeded', stop);
    const { memory } = renderShell('/sessions/sess-1');
    markOriginated('sess-1');

    // Rewired to the AppShell-level modal (teams-settings-nav, D1): the
    // studio-switch save branch lives inside HomeSettingsModal, now mounted
    // directly by AppShell rather than threaded through a mocked SessionRoute.
    fireEvent.click(document.getElementById('v6-btn-settings') as HTMLElement);
    fireEvent.click(screen.getByTestId('studio-switch-close'));

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

  it('navigating to /teams hides the session/home view and mounts TeamsRoute; browser Back restores the previous view (teams-self-serve, task 5.2)', async () => {
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
    await waitFor(() => expect(screen.queryByTestId('teams-route')).not.toBeNull());
    expect(screen.queryByTestId('session-route')).toBeNull();

    window.history.back();
    await waitFor(() => expect(window.location.pathname).toBe('/sessions/sess-1'));
    await waitFor(() => expect(workspaceSessionId()).toBe('sess-1'));
    expect(screen.queryByTestId('teams-route')).toBeNull();
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

describe('AppShell settings modal (teams-settings-nav, D1: lifted to AppShell)', () => {
  it('settings opens on /teams (the rail Settings button now works there)', () => {
    renderShell('/teams');

    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(document.getElementById('v6-btn-settings') as HTMLElement);
    expect(screen.getByRole('dialog')).not.toBeNull();
  });

  it('settings still opens on /', () => {
    renderShell('/');
    fireEvent.click(document.getElementById('v6-btn-settings') as HTMLElement);
    expect(screen.getByRole('dialog')).not.toBeNull();
  });

  it('settings still opens on /sessions/:id', () => {
    renderShell('/sessions/sess-1');
    fireEvent.click(document.getElementById('v6-btn-settings') as HTMLElement);
    expect(screen.getByRole('dialog')).not.toBeNull();
  });

  it('closes via its own onClose control, wired straight through AppShell to handleCloseSettings (web-coordination-seam D4: replaces the retired AutoLogger_closeSettingsModal global)', () => {
    renderShell('/');
    fireEvent.click(document.getElementById('v6-btn-settings') as HTMLElement);
    expect(screen.getByRole('dialog')).not.toBeNull();

    fireEvent.click(screen.getByTestId('settings-modal-close'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('an open modal survives a route change (browser Back between / and /teams)', async () => {
    window.history.replaceState(null, '', '/');
    renderStrict(<AppShell />);

    fireEvent.click(document.getElementById('v6-btn-settings') as HTMLElement);
    expect(screen.getByRole('dialog')).not.toBeNull();

    navigate('/teams');
    await waitFor(() => expect(window.location.pathname).toBe('/teams'));
    // Still open and functional: the shell's Settings state never
    // desynchronizes from what is rendered (spec scenario).
    expect(screen.getByRole('dialog')).not.toBeNull();

    window.history.back();
    await waitFor(() => expect(window.location.pathname).toBe('/'));
    expect(screen.getByRole('dialog')).not.toBeNull();
  });

  it('the modal mounts closed during the profile-loading window (profile still undefined)', () => {
    // beforeEach stubs useProfile to `{ data: undefined }` — the
    // profile-loading window (before `needsOnboarding` can resolve). The
    // modal mounts (the mock renders null while `isOpen` is false) rather
    // than being absent, so no dialog is present without a click.
    renderShell('/');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('studio-switch save on /teams does not navigate (no open session to close)', () => {
    const { memory } = renderShell('/teams');

    fireEvent.click(document.getElementById('v6-btn-settings') as HTMLElement);
    fireEvent.click(screen.getByTestId('studio-switch-close'));

    expect(memory.history).toEqual(['/teams']);
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
  // `SessionRoute` and `HomeSettingsModal`, which ARE module-mocked here
  // (design D8's counter-example) and so cannot host a meaningful assertion
  // for handles either of THEM owns (seekAudio, stopTransportIfNeeded, ...).
  // These three globals were different: `AppShell.tsx`'s own mount-once boot
  // effect (see its header comment) installed all three directly, so
  // `AppShell` mounting here — which it always does — is the correct place.
  // Exercises the exact interactions that used to route through them: open
  // + close the settings modal (`AutoLogger_closeSettingsModal`) and select a
  // session (`Home_reloadSessionList` / `Home_clearSessionList` fired on the
  // session-list refetch path).
  it('defines no AutoLogger_closeSettingsModal / Home_reloadSessionList / Home_clearSessionList globals (web-coordination-seam D4)', () => {
    renderShell();

    fireEvent.click(document.getElementById('v6-btn-settings') as HTMLElement);
    fireEvent.click(screen.getByTestId('settings-modal-close'));
    fireEvent.click(screen.getByTestId('rail-select-s1'));

    expect('AutoLogger_closeSettingsModal' in window).toBe(false);
    expect('Home_reloadSessionList' in window).toBe(false);
    expect('Home_clearSessionList' in window).toBe(false);
  });
});
