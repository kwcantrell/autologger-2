import { useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { useRoute } from 'wouter';
import { useProfile } from '../../api/hooks/useProfile';
import { useYoutubeImport } from '../../api/hooks/useSessions';
import { Toast, toast } from '../../shared/components/Toast';
import { useIsMobile } from '../../shared/ui/breakpoints';
import { freezeAutologgerLoadingVideos } from '../../shared/utils/loadingVideo';
import { initPerfDebugUI } from '../../shared/utils/perfDebug';
import { OnboardingPanel } from './components/OnboardingPanel';
import { RouteLoadingState } from './components/RouteLoadingState';
import { SessionRoute } from './components/SessionRoute';
import { V6Rail } from './components/V6Rail';
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
// Route-level: gets the shared brand loading frame, identical to the one
// SessionRoute renders while resolving (`RouteLoadingState`) — a bare `null`
// here would blank the main column for the chunk fetch.
const TeamsRoute = lazy(() =>
  import('./components/TeamsRoute').then((m) => ({ default: m.TeamsRoute })),
);

// Overlay-level: `fallback={null}`. These are already gated behind open flags
// and render as overlays over an unchanged page, so arriving one frame late
// costs nothing layout-wise (no CLS) — a loading frame would be the worse
// experience. (BatchImportModal's own inner dynamic import of the log-import
// client stays exactly as it was; this just adds an outer split.)
const NewSessionModal = lazy(() =>
  import('./components/NewSessionModal').then((m) => ({ default: m.NewSessionModal })),
);
const BatchImportModal = lazy(() =>
  import('./components/BatchImportModal').then((m) => ({ default: m.BatchImportModal })),
);
const YouTubeImportErrorModal = lazy(() =>
  import('./components/YouTubeImportErrorModal').then((m) => ({
    default: m.YouTubeImportErrorModal,
  })),
);
const HomeSettingsModal = lazy(() =>
  import('./components/HomeSettingsModal').then((m) => ({ default: m.HomeSettingsModal })),
);

// Warm the settings chunk once the page has gone quiet, so the first
// interactive open is a cache hit rather than a network round trip. 2.5s is
// deliberately past the initial-load burst (profile + session list + the
// island's own chunks); the timer is cleared on unmount. Importing a module
// only evaluates it — it mounts nothing and renders nothing, which
// `AppShell.test.tsx` pins.
const SETTINGS_PREFETCH_DELAY_MS = 2500;
// overlayscrollbars.css import moved to the Next app/ route-group layouts
// (nextjs-frontend-migration, task 2.3; design D5) -- centralizing both CSS
// imports in the layout (not a leaf component) pins App Router's otherwise-
// unspecified cascade order (`tailwind.css` before `overlayscrollbars.css`).
// See `web/src/app/(index)/layout.page.tsx` / `(admin)/layout.page.tsx`.

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
  const [onTeamsRoute] = useRoute('/teams');
  const [showNewSession, setShowNewSession] = useState(false);
  const [showBatchImport, setShowBatchImport] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [ytImportPending, setYtImportPending] = useState(false);
  const [ytImportError, setYtImportError] = useState<{
    sessionId: string;
    lastUrl: string;
  } | null>(null);
  const [railOpen, setRailOpen] = useState(false);
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();
  const { data: profile } = useProfile();
  const { mutateAsync: runYoutubeImport } = useYoutubeImport();

  // Post-login deep-link return (design D6): keyed explicitly on
  // `auth.logged_in === true`, never on this component merely mounting —
  // dev anonymous mode mounts AppShell with `logged_in: false` and must
  // never consume a stashed path.
  useLoginReturnConsume(profile?.auth.logged_in === true);

  const closeRail = useCallback(() => setRailOpen(false), []);

  // Drop any open-drawer state when leaving the mobile breakpoint, and close
  // the drawer on Escape while it is open.
  useEffect(() => {
    if (!isMobile) {
      setRailOpen(false);
      return;
    }
    if (!railOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setRailOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isMobile, railOpen]);

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
  // `HomeSettingsModal`, the second is now inlined there via the shared query
  // client, and the third was an identical duplicate of the second.)
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
  // mount on `showSettings` would otherwise turn a cold first open into a
  // chunk fetch; warming it after the load burst keeps interactive opens fast
  // without putting the bytes on the homepage's critical path.
  useEffect(() => {
    const t = setTimeout(() => {
      void import('./components/HomeSettingsModal');
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

  const handleOpenSettings = useCallback(() => {
    setShowSettings(true);
  }, []);

  // Stable callback for the home launch surface's New Session action (design
  // D10), threaded AppShell -> SessionRoute -> HomeRoute, so a fresh closure
  // on every AppShell render doesn't defeat memoization downstream.
  const handleOpenNewSession = useCallback(() => {
    setShowNewSession(true);
  }, []);

  const handleCloseSettings = useCallback(() => {
    setShowSettings(false);
  }, []);

  // Stable identity for the mobile-rail-open trigger threaded down to
  // WorkspaceStatic (settings-modal-mount-cost, design D0). An inline arrow
  // here gives WorkspaceStatic's memo a fresh prop reference on every AppShell
  // render, so the memo's shallow comparison can never bail. Matches the
  // useCallback treatment already given to handleOpenSettings /
  // handleCloseSettings / handleOpenNewSession above.
  //
  // Scope of the claim (deliberately narrow): this keeps the boundary props
  // referentially stable, which is what AppShell.test.tsx asserts. It is NOT
  // known to change how often the workspace actually renders — the change that
  // introduced it originally claimed a large re-render win, and that claim was
  // withdrawn when the render counts behind it turned out to be an artifact of
  // the profiling tool (ground truth: SessionWorkspace renders zero times on a
  // settings click, with or without this callback). Do not restore a
  // performance rationale here without a measurement that does not come from
  // `agent-browser react renders`.
  const handleOpenMobileNav = useCallback(() => {
    setRailOpen(true);
  }, []);

  // Zero-membership onboarding (teams-self-serve, task 6.3; design D8): a
  // render switch INSIDE the authed shell, keyed on `logged_in && teams
  // .length === 0` — never on `studios` emptiness alone, so this can't
  // misfire for dev-anonymous (whose profile always reports the built-in
  // studio in `studios` but has `logged_in: false` / `user: null`) or for a
  // still-loading profile (`profile === undefined`). A team-less logged-in
  // user has no active studio to drive the rail/workspace, so this replaces
  // the whole shell rather than degrading part of it.
  const needsOnboarding = profile?.auth.logged_in && profile.auth.user?.teams.length === 0;

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
      <div className="shell shell-v3 max-w-none w-full mx-0 px-0 pb-0">
        {/* v6-app string retained; desktop flex row filling viewport, max-md block. */}
        <div
          className="v6-app flex flex-row items-stretch flex-1 w-full min-w-0 overflow-hidden min-h-[100dvh] max-md:block max-md:overflow-visible max-md:min-h-0"
          id="v6-app"
        >
          {isMobile && railOpen && (
            <button
              type="button"
              className="fixed inset-0 z-(--z-rail-scrim) appearance-none border-none p-0 bg-[rgba(6,9,16,0.55)] [backdrop-filter:blur(1.5px)] cursor-pointer animate-rail-scrim-fade"
              aria-label="Close navigation"
              onClick={closeRail}
            />
          )}
          <V6Rail
            activeSessionId={activeSessionId}
            isMobile={isMobile}
            mobileOpen={railOpen}
            onMobileClose={closeRail}
            onSelectSession={(sid) => {
              handleSelectSession(sid);
              closeRail();
            }}
            onCloseSession={() => {
              handleCloseSession();
              closeRail();
            }}
            onNewSession={() => {
              setShowNewSession(true);
              closeRail();
            }}
            onBatchImport={() => {
              setShowBatchImport(true);
              closeRail();
            }}
            onOpenSettings={() => {
              handleOpenSettings();
              closeRail();
            }}
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
              {/* Hamburger: home/teams only on mobile. Active session mounts the menu
                  beside session controls in MaximizeLogStrip. md:hidden + inline-flex
                  (not hidden+max-md:inline-flex) avoids utility-order hiding the button. */}
              {!activeSessionId && (
                <button
                  type="button"
                  className="md:hidden inline-flex items-center justify-center w-11 h-11 mt-[0.6rem] ml-3 box-border rounded-v5-sm border border-v5-border-strong bg-white/[0.04] text-v5-text cursor-pointer"
                  aria-label="Open navigation"
                  onClick={() => setRailOpen(true)}
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path
                      d="M4 7H20"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                    />
                    <path
                      d="M4 12H20"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                    />
                    <path
                      d="M4 17H15"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              )}
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
              <Suspense fallback={null}>
                <NewSessionModal
                  profile={profile}
                  onClose={() => setShowNewSession(false)}
                  onCreated={handleSelectSession}
                />
              </Suspense>
            )}

            {showBatchImport && (
              <Suspense fallback={null}>
                <BatchImportModal profile={profile} onClose={() => setShowBatchImport(false)} />
              </Suspense>
            )}

            {ytImportError && (
              <Suspense fallback={null}>
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
                        toast.error(err instanceof Error ? err.message : 'YouTube import failed.');
                        setYtImportError({ sessionId: sid, lastUrl: newUrl });
                      });
                  }}
                  onContinue={() => setYtImportError(null)}
                  onCancel={() => {
                    setYtImportError(null);
                    handleCloseSession();
                  }}
                />
              </Suspense>
            )}

            {/* Settings modal: mounted here, beside the route switch, so the
                rail's Settings button works on every route (`/`, `/sessions/:id`,
                `/teams`) — a route-branch-coupled mount was the bug class itself
                (teams-settings-nav, design D1). That invariant is unchanged by
                the code split (plan C5.5): the gate below is `showSettings`, a
                piece of AppShell state, and NEVER the URL — so an open modal
                still survives route changes instead of desyncing `showSettings`
                from what's rendered.
                What did change: the mount is now conditional rather than
                unconditional. It used to rely on Radix Dialog rendering nothing
                while `open` is false; with the modal behind `React.lazy` that
                would download the chunk on every page load, defeating the split.
                Gating on `showSettings` keeps the bytes off the homepage; the
                idle prefetch above keeps the first open warm. The
                settings-modal-mount-cost optimizations live INSIDE the modal and
                are untouched. */}
            {showSettings && (
              <Suspense fallback={null}>
                <HomeSettingsModal
                  isOpen
                  onClose={handleCloseSettings}
                  onCloseSession={handleCloseSession}
                />
              </Suspense>
            )}

            {/* Session workspace, behind deep-link resolution: SessionRoute
                resolves the routed id through the per-id query and gates the
                workspace mount on it (task 4.2, design D5); the empty id renders
                the dedicated home route component (design D10). At `/teams`
                (teams-self-serve, task 5.2), TeamsRoute mounts in SessionRoute's
                place instead — since SessionRoute is what renders the no-session
                home view (HomeRoute) for the empty id, swapping it out is what
                hides that home view at the teams route. */}
            {onTeamsRoute ? (
              <Suspense fallback={<RouteLoadingState />}>
                <TeamsRoute />
              </Suspense>
            ) : (
              <SessionRoute
                sessionId={activeSessionId}
                ytImportPending={ytImportPending}
                onNewSession={handleOpenNewSession}
                onOpenMobileNav={handleOpenMobileNav}
              />
            )}
          </main>
        </div>
      </div>
    </>
  );
}
