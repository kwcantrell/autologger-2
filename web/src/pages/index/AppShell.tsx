import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useRoute } from 'wouter';
import { useProfile } from '../../api/hooks/useProfile';
import { useYoutubeImport } from '../../api/hooks/useSessions';
import { Toast, toast } from '../../shared/components/Toast';
import { SidebarProvider, useSidebar } from '../../shared/components/ui/sidebar';
import { isOverlayOpen } from '../../shared/ui/overlayOpen';
import { freezeAutologgerLoadingVideos } from '../../shared/utils/loadingVideo';
import { initPerfDebugUI } from '../../shared/utils/perfDebug';
import { LazyChunk } from './components/ChunkLoadBoundary';
import { OnboardingPanel } from './components/OnboardingPanel';
import { SessionRoute } from './components/SessionRoute';
import { isTypingTarget } from './components/ShortcutsDialog';
import {
  DEFAULT_SETTINGS_SECTION,
  SETTINGS_VIEW_SELECTOR,
  type SettingsSectionId,
  type SettingsState,
} from './components/settings/sections';
import { TopBar } from './components/TopBar';
import { V6Rail } from './components/V6Rail';
import { getTransportStatus, subscribeTransportStatus } from './coordination/transportStatus';
import { navigate } from './navigation';
import { useLoginReturnConsume } from './useLoginReturnConsume';

// --- Code-split edges (bundle route-splitting, plan C5) ---
//
// Everything below is reachable only behind a route match or an open flag, so
// none of it belongs in the homepage's initial download. Plain `React.lazy` is
// enough: wouter route components are ordinary React elements and the whole
// app already lives inside one `ssr: false` island (`IndexIsland`), so no
// router- or framework-level dynamic-import support is involved.
//
// Static on purpose (do NOT lazify): `V6Rail`, `HomeRoute`, `LoginPage`,
// `RootGate`, `SessionRoute` itself — all of them render on the very first
// homepage paint, so splitting them would only buy a waterfall.
//
// Each split point is a module LOADER, mounted through `LazyChunk` (which owns
// the `React.lazy` instance, its `<Suspense>`, and its own error boundary).
// The loaders live at module scope because `LazyChunk` reads `load` at mount
// and on retry without watching its identity — and because a chunk fetch CAN
// fail (a redeploy rewrites content-hashed URLs out from under an open tab),
// in which case `lazy()` caches the rejection forever and only a fresh
// instance can recover. See `./components/ChunkLoadBoundary`.
//
// Five split points (web-frontend-platform "The client island is route-split behind recoverable
// boundaries"): the session workspace (SessionRoute's own), and the four overlays below. `/teams`
// has no chunk of its own any more: it opens the Settings view (redesign-show-ignition D3).

// Overlay-level: `fallback={null}`. These are already gated behind open flags
// and render as overlays over an unchanged page, so arriving one frame late
// costs nothing layout-wise (no CLS) — a loading frame would be the worse
// experience. (BatchImportModal's own inner dynamic import of the log-import
// client stays exactly as it was; this just adds an outer split.) Their
// boundaries are per-overlay, so a dead modal chunk shows a dismissible card
// over an intact route rather than taking the route down with it.
const loadNewSessionModal = () =>
  import('./components/NewSessionModal').then((m) => ({ default: m.NewSessionModal }));
const loadBatchImportModal = () =>
  import('./components/BatchImportModal').then((m) => ({ default: m.BatchImportModal }));
const loadYouTubeImportErrorModal = () =>
  import('./components/YouTubeImportErrorModal').then((m) => ({
    default: m.YouTubeImportErrorModal,
  }));
const loadSettingsView = () =>
  import('./components/settings/SettingsView').then((m) => ({ default: m.SettingsView }));

// Warm the settings chunk once the page has gone quiet, so the first
// interactive open is a cache hit rather than a network round trip. 2.5s is
// deliberately past the initial-load burst (profile + session list + the
// island's own chunks); the timer is cleared on unmount. Importing a module
// only evaluates it — it mounts nothing and renders nothing, which
// `AppShell.test.tsx` pins.
const SETTINGS_PREFETCH_DELAY_MS = 2500;

/**
 * The shell's one `[` listener (redesign-show-ignition D8; web-ui-system "Shell-level sidebar
 * shortcut"). Mounted inside the shell's `SidebarProvider` on every signed-in route, with or
 * without a session. It yields to text entry and to open dialogs and menus other than the
 * Settings view, like the console's single-key handlers; the primitive's own Ctrl/⌘+B is
 * unaffected.
 */
function SidebarShortcut() {
  const { toggleSidebar } = useSidebar();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '[' || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      // The Settings view is the one dialog `[` reaches through (web-ui-system "The Settings view
      // is modal to the console": the shell owns `[`).
      if (isTypingTarget(e.target) || isOverlayOpen(document, SETTINGS_VIEW_SELECTOR)) return;
      e.preventDefault();
      toggleSidebar();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [toggleSidebar]);
  return null;
}

export function AppShell() {
  // Active session is URL-derived (design D2): `/sessions/:id` is the session
  // workspace; anything else — `/` or an unmatched path (e.g. the raw dev
  // entry `/src/pages/index/index.html`) — is the no-session home view, with
  // the address bar left as-is. There is deliberately no component-state copy
  // of the active session id that could disagree with the URL.
  const [onSessionRoute, sessionRouteParams] = useRoute('/sessions/:id');
  const activeSessionId = onSessionRoute ? (sessionRouteParams?.id ?? '') : '';
  // Teams route (teams-self-serve, design D6): a second `useRoute` alongside
  // the session one — the wouter-pattern mirror of the shared route module.
  // No <Route> tree (design D6's "gate above router" shape stays intact):
  // this is a plain boolean read off the URL, same idiom as onSessionRoute.
  // It renders the home view and opens Settings on Members (redesign-show-ignition D3).
  const [onTeamsRoute] = useRoute('/teams');
  const [showNewSession, setShowNewSession] = useState(false);
  const [showBatchImport, setShowBatchImport] = useState(false);
  // The Settings view's open state and section (redesign-show-ignition D3; web-ui-system "The
  // Settings modal costs nothing while closed"): shell state, NEVER the URL, so an open view
  // survives route changes. `/teams` opens it by setting this state, not by a route branch.
  const [settings, setSettings] = useState<SettingsState>(() =>
    onTeamsRoute ? { section: 'members' } : null,
  );
  // Arriving at `/teams` (load or navigation) opens Settings on Members. Adjusted during render,
  // so the arriving commit already holds the open state rather than painting closed first.
  const [prevOnTeamsRoute, setPrevOnTeamsRoute] = useState(onTeamsRoute);
  if (onTeamsRoute !== prevOnTeamsRoute) {
    setPrevOnTeamsRoute(onTeamsRoute);
    if (onTeamsRoute) setSettings({ section: 'members' });
  }
  // The section an open with no named section lands on: the last one visited this page load,
  // initially Show details (web-ui-system "Settings modal defers inactive tab content").
  const lastSettingsSection = useRef<SettingsSectionId>(DEFAULT_SETTINGS_SECTION);
  useEffect(() => {
    if (settings) lastSettingsSection.current = settings.section;
  }, [settings]);
  // The open view's discard guard, so the shell's own close path (the top bar's status) asks
  // before dropping unsaved inline edits. `true` at once when nothing is dirty.
  const settingsCloseGuard = useRef<(() => true | Promise<boolean>) | null>(null);
  const [ytImportPending, setYtImportPending] = useState(false);
  const [ytImportError, setYtImportError] = useState<{
    sessionId: string;
    lastUrl: string;
  } | null>(null);
  const queryClient = useQueryClient();
  const { data: profile } = useProfile();
  const { mutateAsync: runYoutubeImport } = useYoutubeImport();

  // Post-login deep-link return (design D6): keyed explicitly on
  // `auth.logged_in === true`, never on this component merely mounting.
  useLoginReturnConsume(profile?.auth.logged_in === true);

  // syncChrome's title-reset behavior, now route-driven (design D9): with no
  // active session the tab title returns to the app name. (Nothing currently
  // sets a per-session title; this keeps the reset observable regardless.)
  useEffect(() => {
    if (!activeSessionId) document.title = 'AutoLogger';
  }, [activeSessionId]);

  // One-time boot tasks — runs once on mount. (Formerly also installed the
  // `AutoLogger_closeSettingsModal` / `Home_reloadSessionList` /
  // `Home_clearSessionList` window globals — retired by web-coordination-seam:
  // the first duplicated the `onClose` prop already threaded to
  // the Settings view, the second is now inlined in its saves via the shared
  // query client, and the third was an identical duplicate of the second.)
  useEffect(() => {
    // Handle data-v6-modal-dismiss clicks (replaces v3.js listener)
    const handleModalDismiss = (e: MouseEvent) => {
      const target = e.target as Element;
      const dismissEl = target.closest('[data-v6-modal-dismiss]');
      if (!dismissEl) return;
      const dismissId = dismissEl.getAttribute('data-v6-modal-dismiss');
      if (!dismissId) return;
      if (dismissId === 'modal-new-session') {
        setShowNewSession(false);
        return;
      }
      const modal = document.getElementById(dismissId);
      modal?.classList.add('hidden');
    };
    document.addEventListener('click', handleModalDismiss);

    freezeAutologgerLoadingVideos(document);
    initPerfDebugUI();

    return () => document.removeEventListener('click', handleModalDismiss);
  }, []);

  // Idle prefetch of the now-split settings chunk (plan C5.5): the modal used
  // to be always-mounted, so opening it never touched the network. Gating the
  // mount on `settings` would otherwise turn a cold first open into a
  // chunk fetch; warming it after the load burst keeps interactive opens fast
  // without putting the bytes on the homepage's critical path.
  useEffect(() => {
    const t = setTimeout(() => {
      // A failed warm-up is harmless and must stay silent: nothing is on screen, and a real
      // open goes back through `LazyChunk`, which owns the retry and the error card. Without
      // the catch, a redeploy-rotated chunk URL or a network blip turns the warm-up into an
      // unhandled rejection (mirrors SessionRoute's workspace warm-up).
      void loadSettingsView().catch(() => {});
    }, SETTINGS_PREFETCH_DELAY_MS);
    return () => clearTimeout(t);
  }, []);

  const handleSelectSession = useCallback(
    (sid: string, ytUrl?: string, useYtPublishDate?: boolean) => {
      // Select (and create) push `/sessions/:id`; re-selecting the already
      // active session is a no-op so unguarded card clicks can't stack
      // duplicate history entries and deaden Back (design D3).
      if (sid !== activeSessionId) {
        navigate(`/sessions/${encodeURIComponent(sid)}`);
      }
      if (ytUrl) {
        setYtImportPending(true);
        runYoutubeImport({ sessionId: sid, url: ytUrl, usePublishDate: useYtPublishDate ?? false })
          .then(() => setYtImportPending(false))
          .catch((err) => {
            setYtImportPending(false);
            toast.error(err instanceof Error ? err.message : 'YouTube import failed.');
            setYtImportError({ sessionId: sid, lastUrl: ytUrl });
          });
      }
    },
    [activeSessionId, runYoutubeImport],
  );

  const handleCloseSession = useCallback(() => {
    // Navigate home only when a session is actually open, so callers reachable
    // without one (the settings modal's studio-switch branch) can't stack
    // duplicate `/` entries (design D3). The `navigate()` call itself is what
    // stops the roll — the originator-scoped departure watcher (design D4)
    // hangs off the navigation wrapper and invokes the `stopTransportIfNeeded`
    // coordination handle iff this client originated it; closing a roll
    // started by another client no longer stops it (the accepted behavior
    // change from the gate — see design D4).
    if (activeSessionId) navigate('/');
    queryClient.invalidateQueries({ queryKey: ['sessions'] });
  }, [activeSessionId, queryClient]);

  // The rail's Settings control names no section: the last one visited, else Show details.
  const handleOpenSettings = useCallback(() => {
    setSettings({ section: lastSettingsSection.current });
  }, []);

  const handleSettingsSectionChange = useCallback((section: SettingsSectionId) => {
    setSettings({ section });
  }, []);

  const registerSettingsCloseGuard = useCallback(
    (guard: (() => true | Promise<boolean>) | null) => {
      settingsCloseGuard.current = guard;
    },
    [],
  );

  // Stable callback for the home launch surface's New Session action (design
  // D10), threaded AppShell -> SessionRoute -> HomeRoute, so a fresh closure
  // on every AppShell render doesn't defeat memoization downstream.
  const handleOpenNewSession = useCallback(() => {
    setShowNewSession(true);
  }, []);

  const handleOpenBatchImport = useCallback(() => {
    setShowBatchImport(true);
  }, []);

  // Closing the view (its back control, Escape, or the failure card's dismiss). On `/teams` the
  // view is the page, so closing it goes home through the shared navigation wrapper
  // (team-management "Teams management page"); elsewhere the route underneath is already right.
  const handleCloseSettings = useCallback(() => {
    setSettings(null);
    if (onTeamsRoute) navigate('/');
  }, [onTeamsRoute]);

  // The top bar's status control (redesign-show-ignition 3.3; web-ui-system "Status returns to
  // the open session"): close Settings if it is open, through its discard guard, and show that
  // session's console, navigating only when the route is not already on it.
  const handleReturnToSession = useCallback(
    (sid: string) => {
      const proceed = () => {
        setSettings(null);
        if (sid !== activeSessionId) navigate(`/sessions/${encodeURIComponent(sid)}`);
      };
      const ok = settingsCloseGuard.current?.() ?? true;
      if (ok === true) proceed();
      else
        void ok.then((confirmed) => {
          if (confirmed) proceed();
        });
    },
    [activeSessionId],
  );

  // A top-bar team or show switch with Settings open asks the view's discard guard first, so it
  // never drops unsaved edits silently (web-ui-system "Honest save model in Settings"). The view
  // stays open on the new selection; `true` at once when it is closed or clean.
  const confirmSettingsDiscard = useCallback(
    (): true | Promise<boolean> => settingsCloseGuard.current?.() ?? true,
    [],
  );

  // Zero-membership onboarding (teams-self-serve, task 6.3; design D8): a
  // render switch INSIDE the authed shell, keyed on `logged_in && teams
  // .length === 0` — never on `studios` emptiness alone, so this can't
  // misfire for a still-loading profile (`profile === undefined`). A team-less logged-in
  // user has no active studio to drive the rail/workspace, so this replaces
  // the whole shell rather than degrading part of it.
  const needsOnboarding = profile?.auth.logged_in && profile.auth.user?.teams.length === 0;

  // Shell transport tint (redesign-show-ignition D2): the open session's
  // transport state, published by SessionWorkspace. The store changes only on
  // transitions, so this re-renders the shell only then; the tints themselves
  // are pure CSS on `data-transport` (shared/theme/tailwind.css).
  const transportState = useSyncExternalStore(
    subscribeTransportStatus,
    () => getTransportStatus().state,
    () => 'stopped' as const,
  );

  if (needsOnboarding) {
    return (
      <>
        <Toast />
        <OnboardingPanel />
      </>
    );
  }

  return (
    <>
      <Toast />
      {/* shell/shell-v3 strings retained (chrome.css .shell stays legacy until Task 11);
          the AppShell overrides that widen it convert to utilities here (win by layer). */}
      {/* Desktop: a viewport-high column — the top bar (redesign-show-ignition D5), full width,
          above the row that holds the rail and main. Phones: plain block flow (the page scrolls). */}
      {/* The SidebarProvider's wrapper is the shell root (redesign-show-ignition D8): the top bar's
          trigger, the `[` shortcut and the rail share its state. */}
      <SidebarProvider
        className="shell shell-v3 max-w-none w-full mx-0 px-0 pb-0 flex-col flex-1 min-h-0 h-[100dvh] max-md:block max-md:h-auto"
        data-transport={transportState}
      >
        <SidebarShortcut />
        <TopBar
          onCloseSession={handleCloseSession}
          onReturnToSession={handleReturnToSession}
          confirmSwitch={confirmSettingsDiscard}
        />
        {/* v6-app string retained; desktop flex row filling the height under the top bar, max-md block. */}
        <div
          className="v6-app flex flex-row items-stretch flex-1 w-full min-w-0 min-h-0 overflow-hidden max-md:block max-md:overflow-visible"
          id="v6-app"
        >
          <V6Rail
            activeSessionId={activeSessionId}
            onSelectSession={handleSelectSession}
            onCloseSession={handleCloseSession}
            onNewSession={handleOpenNewSession}
            onBatchImport={handleOpenBatchImport}
            onOpenSettings={handleOpenSettings}
          />
          {/* main-v3 / v3-layout-session-focus strings retained. Display comes from
              SessionWorkspace's `.main-v3` @layer rule (display:block — the app.css
              cascade, which is the baseline value on BOTH viewports); DO NOT set display
              here (an inline flex would beat that @layer rule and, on mobile, collapse
              the block flow so the hamburger cluster loses its height). The v6Workspace
              flex-ITEM sizing (flex:1 1 auto etc.) is inline. */}
          <main
            className="main-v3 v3-layout-session-focus flex-1 min-w-0 min-h-0 relative [overflow-x:clip] overflow-y-visible"
            id="v3-main"
          >
            <div
              className={
                activeSessionId
                  ? 'shrink-0 w-full box-border mb-0'
                  : 'shrink-0 w-full box-border mb-6'
              }
            >
              {/* The no-session mobile hamburger that sat here is replaced by the top bar's
                  sidebar control (redesign-show-ignition 3.1). */}
              {/* Void top-bar strip: the .v6WorkspaceTopBarVoid !important zero-height
                  war vs .v4-top-bar min-height is resolved here by writing the winning
                  values directly — both rules were AppShell's own and now live as
                  utilities on this one element, so the flags are dropped (layer order
                  suffices). v4-top-bar string retained (perfDebug shadow toggle). */}
              <header
                className="v4-top-bar w-full max-w-full flex-shrink-0 box-border h-0 min-h-0 max-h-0 p-0 m-0 border-none overflow-hidden opacity-0 pointer-events-none"
                id="v4-app-top-bar"
              />
              {/* Recording mic level + duration live in MaximizeLogStrip status
                  (above timecode). AudioRecorder still toggles body.v4-is-recording
                  and writes #top-bar-mic-level-fill / #top-bar-recording-dur. */}
            </div>

            {showNewSession && (
              <LazyChunk
                load={loadNewSessionModal}
                variant="overlay"
                onDismiss={() => setShowNewSession(false)}
              >
                {(NewSessionModal) => (
                  <NewSessionModal
                    profile={profile}
                    onClose={() => setShowNewSession(false)}
                    onCreated={handleSelectSession}
                  />
                )}
              </LazyChunk>
            )}

            {showBatchImport && (
              <LazyChunk
                load={loadBatchImportModal}
                variant="overlay"
                onDismiss={() => setShowBatchImport(false)}
              >
                {(BatchImportModal) => (
                  <BatchImportModal profile={profile} onClose={() => setShowBatchImport(false)} />
                )}
              </LazyChunk>
            )}

            {ytImportError && (
              <LazyChunk
                load={loadYouTubeImportErrorModal}
                variant="overlay"
                onDismiss={() => setYtImportError(null)}
              >
                {(YouTubeImportErrorModal) => (
                  <YouTubeImportErrorModal
                    sessionId={ytImportError.sessionId}
                    lastUrl={ytImportError.lastUrl}
                    onRetry={(newUrl) => {
                      const sid = ytImportError.sessionId;
                      setYtImportError(null);
                      setYtImportPending(true);
                      runYoutubeImport({ sessionId: sid, url: newUrl, usePublishDate: false })
                        .then(() => setYtImportPending(false))
                        .catch((err) => {
                          setYtImportPending(false);
                          toast.error(
                            err instanceof Error ? err.message : 'YouTube import failed.',
                          );
                          setYtImportError({ sessionId: sid, lastUrl: newUrl });
                        });
                    }}
                    onContinue={() => setYtImportError(null)}
                    onCancel={() => {
                      setYtImportError(null);
                      handleCloseSession();
                    }}
                  />
                )}
              </LazyChunk>
            )}

            {/* Settings view (redesign-show-ignition D3): mounted here, beside the route
                switch, so the rail's Settings control works on every route — a
                route-branch-coupled mount was the bug class itself (teams-settings-nav, design
                D1). The gate is `settings`, a piece of AppShell state, and NEVER the URL — so an
                open view survives route changes instead of desyncing from what's rendered; `/teams`
                opens it by setting that state. The mount is conditional rather than relying on a
                primitive to render nothing, which behind `React.lazy` would download the chunk on
                every page load; the idle prefetch above keeps the first open warm. Inside <main>,
                below the top bar and beside the rail: the view covers the console, not the bar,
                so the status control and menus stay reachable over it. */}
            {settings && (
              <LazyChunk load={loadSettingsView} variant="overlay" onDismiss={handleCloseSettings}>
                {(SettingsView) => (
                  <SettingsView
                    section={settings.section}
                    onSectionChange={handleSettingsSectionChange}
                    onClose={handleCloseSettings}
                    onCloseSession={handleCloseSession}
                    backLabel={activeSessionId ? 'Back to session' : 'Back to sessions'}
                    registerCloseGuard={registerSettingsCloseGuard}
                  />
                )}
              </LazyChunk>
            )}

            {/* Session workspace, behind deep-link resolution: SessionRoute
                resolves the routed id through the per-id query and gates the
                workspace mount on it (task 4.2, design D5); the empty id renders
                the dedicated home route component (design D10) — on `/` and, under
                the Settings view, on `/teams`. */}
            <SessionRoute
              sessionId={activeSessionId}
              ytImportPending={ytImportPending}
              onNewSession={handleOpenNewSession}
            />
          </main>
        </div>
      </SidebarProvider>
    </>
  );
}
