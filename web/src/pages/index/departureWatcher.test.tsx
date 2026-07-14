import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderStrict } from '../../test/renderStrict';
import { AppShell } from './AppShell';
import { navigate, setNavigationImplForTesting } from './navigation';
import {
  getOriginatedSessionId,
  markOriginated,
  resetOriginationForTesting,
} from './transportOrigination';

// --- Departure-watcher tests (session-deep-links, task 5.2; spec:
// web-session-routing "Originator-scoped transport stop on route departure",
// all three scenarios; design D4) ---
//
// Same mocking idiom as AppShell.test.tsx (heavy children mocked at the
// module boundary) — this file exercises the real navigation.ts,
// departureWatcher.ts, and transportOrigination.ts modules end-to-end through
// AppShell's actual navigation call sites (handleCloseSession,
// handleSelectSession, and browser Back/Forward), rather than mocking
// `navigate()` itself. The SessionRoute mock adds one affordance
// AppShell.test.tsx's doesn't need: an "originate" button that calls the real
// `markOriginated`, standing in for "this client issued transport-start"
// (TransportControls.tsx's real call site, exercised in isolation — this
// file's concern is the departure side, not the mutation call).

vi.mock('../../api/hooks/useProfile', () => ({
  useProfile: vi.fn(() => ({ data: undefined })),
}));

vi.mock('../../api/hooks/useSessions', () => ({
  useYoutubeImport: vi.fn(() => ({ mutateAsync: vi.fn().mockResolvedValue(undefined) })),
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
    </div>
  ),
}));

vi.mock('./components/SessionRoute', () => ({
  SessionRoute: (props: { sessionId: string; onCloseSession: () => void }) => (
    <div data-testid="session-route" data-session-id={props.sessionId}>
      <button
        type="button"
        data-testid="originate"
        onClick={() => {
          if (props.sessionId) markOriginated(props.sessionId);
        }}
      />
    </div>
  ),
}));

vi.mock('./components/NewSessionModal', () => ({
  NewSessionModal: () => null,
}));

vi.mock('./components/YouTubeImportErrorModal', () => ({
  YouTubeImportErrorModal: () => null,
}));

function renderShell(initialPath = '/') {
  // Real jsdom history + wouter's default browser location — no
  // memory-location Router wrapper — so `navigate()` goes through real
  // pushState (needed for the popstate/Back tests) and select/close/switch
  // all go through the one navigation wrapper under test.
  window.history.replaceState(null, '', initialPath);
  return renderStrict(<AppShell />);
}

const workspaceSessionId = () =>
  screen.getByTestId('session-route').getAttribute('data-session-id');

let stop: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  stop = vi.fn();
  window.AutoLogger_stopTransportIfNeeded = stop;
});

afterEach(() => {
  setNavigationImplForTesting(null);
  window.AutoLogger_stopTransportIfNeeded = undefined;
  window.history.replaceState(null, '', '/');
  resetOriginationForTesting();
  vi.clearAllMocks();
});

describe('Originator-scoped transport stop on route departure (design D4)', () => {
  it("originator's departure via the close control stops the roll exactly once", () => {
    renderShell('/sessions/sess-1');
    expect(workspaceSessionId()).toBe('sess-1');

    fireEvent.click(screen.getByTestId('originate'));
    expect(getOriginatedSessionId()).toBe('sess-1');

    fireEvent.click(screen.getByTestId('rail-close'));

    expect(window.location.pathname).toBe('/');
    expect(stop).toHaveBeenCalledTimes(1);
    // The flag is consumed — a further departure (were there one) can't
    // re-fire it.
    expect(getOriginatedSessionId()).toBeNull();
  });

  it("originator's departure via browser Back (popstate) stops the roll exactly once", async () => {
    renderShell('/');
    fireEvent.click(screen.getByTestId('rail-select-s1'));
    expect(window.location.pathname).toBe('/sessions/sess-1');
    expect(workspaceSessionId()).toBe('sess-1');

    fireEvent.click(screen.getByTestId('originate'));
    expect(getOriginatedSessionId()).toBe('sess-1');

    window.history.back();

    await waitFor(() => expect(window.location.pathname).toBe('/'));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(getOriginatedSessionId()).toBeNull();
  });

  it("originator's departure via switching to another session id stops the roll exactly once", () => {
    renderShell('/sessions/sess-1');
    fireEvent.click(screen.getByTestId('originate'));
    expect(getOriginatedSessionId()).toBe('sess-1');

    fireEvent.click(screen.getByTestId('rail-select-s2'));

    expect(window.location.pathname).toBe('/sessions/sess-2');
    expect(workspaceSessionId()).toBe('sess-2');
    expect(stop).toHaveBeenCalledTimes(1);

    // The flag was consumed by that departure — switching again (sess-2 was
    // never originated) must not fire a second time.
    fireEvent.click(screen.getByTestId('rail-select-s1'));
    expect(window.location.pathname).toBe('/sessions/sess-1');
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('originator\'s departure to /teams stops the roll exactly once (teams-self-serve, spec: web-session-routing "Departure to the teams route stops the originator\'s roll")', () => {
    renderShell('/sessions/sess-1');
    fireEvent.click(screen.getByTestId('originate'));
    expect(getOriginatedSessionId()).toBe('sess-1');

    navigate('/teams');

    expect(window.location.pathname).toBe('/teams');
    expect(stop).toHaveBeenCalledTimes(1);
    expect(getOriginatedSessionId()).toBeNull();
  });

  it('a non-originator navigating to /teams never stops the roll', () => {
    renderShell('/sessions/sess-1');
    // No "originate" click: this client never issued transport-start.

    navigate('/teams');

    expect(window.location.pathname).toBe('/teams');
    expect(stop).not.toHaveBeenCalled();
  });

  it('a non-originator (deep-linked into an already-rolling session) never stops the roll — close or switch', () => {
    renderShell('/sessions/sess-1');
    expect(workspaceSessionId()).toBe('sess-1');
    // No "originate" click: this client never issued transport-start.

    fireEvent.click(screen.getByTestId('rail-select-s2'));
    expect(window.location.pathname).toBe('/sessions/sess-2');
    expect(stop).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('rail-close'));
    expect(window.location.pathname).toBe('/');
    expect(stop).not.toHaveBeenCalled();
  });

  it('a non-originator never stops the roll via browser Back (popstate) either', async () => {
    renderShell('/');
    fireEvent.click(screen.getByTestId('rail-select-s1'));
    expect(window.location.pathname).toBe('/sessions/sess-1');
    // No "originate" click.

    window.history.back();

    await waitFor(() => expect(window.location.pathname).toBe('/'));
    expect(stop).not.toHaveBeenCalled();
  });

  it('StrictMode double-invoke on mount issues no transport-stop command', () => {
    renderShell('/sessions/sess-1');
    expect(workspaceSessionId()).toBe('sess-1');

    // Mounting alone (StrictMode double-renders/double-invokes effects here —
    // renderStrict wraps in <StrictMode>) must never call the stop global:
    // the watcher is subscription-based (navigate()/popstate), not
    // effect-based, so nothing about mounting can trigger it.
    expect(stop).not.toHaveBeenCalled();
    expect(getOriginatedSessionId()).toBeNull();
  });

  // The async-gap origination race (phase-5 review: markOriginated's caller,
  // TransportControls.tsx, awaits the transport-start mutation before calling
  // it, so the flag write must be guarded against the client having already
  // navigated away) is exercised at its actual call site in
  // `TransportControls.test.tsx` — the guard lives there (mountedRef +
  // latestSessionIdRef), not in `markOriginated` itself, which stays a plain
  // setter here and in AppShell.test.tsx's direct-call preconditions.

  it('navigating to the same session id (e.g. a replace navigation) neither fires the stop nor clears the flag', () => {
    renderShell('/sessions/sess-1');
    fireEvent.click(screen.getByTestId('originate'));
    expect(getOriginatedSessionId()).toBe('sess-1');

    // Mirrors phase 6's post-login stash-return replace-navigate, which goes
    // through this same navigate() wrapper and can land on the session the
    // client is already viewing.
    navigate('/sessions/sess-1', { replace: true });

    expect(window.location.pathname).toBe('/sessions/sess-1');
    expect(stop).not.toHaveBeenCalled();
    expect(getOriginatedSessionId()).toBe('sess-1');
  });
});
