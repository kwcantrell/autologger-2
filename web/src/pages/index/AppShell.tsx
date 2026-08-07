import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { useRoute } from 'wouter';
import { useProfile } from '../../api/hooks/useProfile';
import { useYoutubeImport } from '../../api/hooks/useSessions';
import { Toast, toast } from '../../shared/components/Toast';
import { useIsMobile } from '../../shared/ui/breakpoints';
import { freezeAutologgerLoadingVideos } from '../../shared/utils/loadingVideo';
import { initPerfDebugUI } from '../../shared/utils/perfDebug';
import { BatchImportModal } from './components/BatchImportModal';
import { HomeSettingsModal } from './components/HomeSettingsModal';
import { NewSessionModal } from './components/NewSessionModal';
import { OnboardingPanel } from './components/OnboardingPanel';
import { SessionRoute } from './components/SessionRoute';
import { TeamsRoute } from './components/TeamsRoute';
import { V6Rail } from './components/V6Rail';
import { YouTubeImportErrorModal } from './components/YouTubeImportErrorModal';
import { navigate } from './navigation';
import { useLoginReturnConsume } from './useLoginReturnConsume';
import 'overlayscrollbars/overlayscrollbars.css';

declare global {
  interface Window {
    AutoLogger_closeSettingsModal?: () => void;
    Home_reloadSessionList?: () => void;
    Home_clearSessionList?: () => void;
    AutoLogger_invalidateEvents?: () => void;
    AutoLogger_seekAudio?: (sec: number) => void;
    AutoLogger_stopTransportIfNeeded?: () => void;
  }
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

  // Set up window globals and one-time boot tasks — runs once on mount
  useEffect(() => {
    const refetchSessions = () => queryClient.invalidateQueries({ queryKey: ['sessions'] });

    window.AutoLogger_closeSettingsModal = () => {
      setShowSettings(false);
    };

    window.Home_reloadSessionList = refetchSessions;
    window.Home_clearSessionList = refetchSessions;

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
  }, [queryClient]);

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
    // hangs off the navigation wrapper and fires
    // `window.AutoLogger_stopTransportIfNeeded` iff this client originated
    // it; closing a roll started by another client no longer stops it (the
    // accepted behavior change from the gate — see design D4).
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
              <NewSessionModal
                profile={profile}
                onClose={() => setShowNewSession(false)}
                onCreated={handleSelectSession}
              />
            )}

            {showBatchImport && (
              <BatchImportModal profile={profile} onClose={() => setShowBatchImport(false)} />
            )}

            {ytImportError && (
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
            )}

            {/* Settings modal: mounted once here, beside the route switch, so the
                rail's Settings button works on every route (`/`, `/sessions/:id`,
                `/teams`) — a route-branch-coupled mount was the bug class itself
                (teams-settings-nav, design D1). Mounting is unconditional (Radix
                Dialog renders nothing to the DOM while `open` is false), so the
                modal survives route changes while open instead of desyncing
                `showSettings` from what's rendered. */}
            <HomeSettingsModal
              isOpen={showSettings}
              onClose={handleCloseSettings}
              onCloseSession={handleCloseSession}
            />

            {/* Session workspace, behind deep-link resolution: SessionRoute
                resolves the routed id through the per-id query and gates the
                workspace mount on it (task 4.2, design D5); the empty id renders
                the dedicated home route component (design D10). At `/teams`
                (teams-self-serve, task 5.2), TeamsRoute mounts in SessionRoute's
                place instead — since SessionRoute is what renders the no-session
                home view (HomeRoute) for the empty id, swapping it out is what
                hides that home view at the teams route. */}
            {onTeamsRoute ? (
              <TeamsRoute />
            ) : (
              <SessionRoute
                sessionId={activeSessionId}
                ytImportPending={ytImportPending}
                onNewSession={handleOpenNewSession}
                onOpenMobileNav={() => setRailOpen(true)}
              />
            )}
          </main>
        </div>
      </div>
    </>
  );
}
