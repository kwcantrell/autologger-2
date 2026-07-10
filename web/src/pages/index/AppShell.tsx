import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useCallback, useEffect, useState } from 'react';
import { useProfile } from '../../api/hooks/useProfile';
import { useYoutubeImport } from '../../api/hooks/useSessions';
import { Toast, toast } from '../../shared/components/Toast';
import { useIsMobile } from '../../shared/ui/breakpoints';
import { freezeAutologgerLoadingVideos } from '../../shared/utils/loadingVideo';
import { initPerfDebugUI } from '../../shared/utils/perfDebug';
import styles from './AppShell.module.css';
import { NewSessionModal } from './components/NewSessionModal';
import { V6Rail } from './components/V6Rail';
import { WorkspaceStatic } from './components/WorkspaceStatic';
import { YouTubeImportErrorModal } from './components/YouTubeImportErrorModal';
import 'overlayscrollbars/overlayscrollbars.css';

declare global {
  interface Window {
    V3_selectSession?: (sid: string) => Promise<void>;
    V3_closeSession?: () => void;
    AutoLogger_closeSettingsModal?: () => void;
    Home_reloadSessionList?: () => void;
    Home_clearSessionList?: () => void;
    AutoLogger_invalidateEvents?: () => void;
    AutoLogger_seekAudio?: (sec: number) => void;
    AutoLogger_stopTransportIfNeeded?: () => void;
  }
}

function syncChrome() {
  const sid = (document.body.dataset.sessionId ?? '').trim();
  const hasSession = Boolean(sid);
  const placeholder = document.getElementById('v3-session-placeholder');
  const grid = document.getElementById('v3-session-grid');
  const sessionLoading = document.getElementById('v3-session-loading');
  if (placeholder) placeholder.classList.toggle('hidden', hasSession);
  if (grid) grid.classList.toggle('hidden', !hasSession);
  if (sessionLoading) sessionLoading.classList.add('hidden');
  // Sync page title
  if (!hasSession) {
    document.title = 'AutoLogger';
  }
}

export function AppShell() {
  const [activeSessionId, setActiveSessionId] = useState('');
  const [showNewSession, setShowNewSession] = useState(false);
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

  // Sync body dataset and chrome whenever active session changes
  useEffect(() => {
    document.body.dataset.sessionId = activeSessionId;
    syncChrome();
  }, [activeSessionId]);

  // Set up window globals and one-time boot tasks — runs once on mount
  useEffect(() => {
    const refetchSessions = () => queryClient.invalidateQueries({ queryKey: ['sessions'] });

    window.V3_selectSession = async (sid: string) => {
      document.body.dataset.sessionId = sid;
      setActiveSessionId(sid);
      requestAnimationFrame(syncChrome);
    };

    window.V3_closeSession = () => {
      window.AutoLogger_stopTransportIfNeeded?.();
      document.body.dataset.sessionId = '';
      setActiveSessionId('');
      requestAnimationFrame(() => {
        syncChrome();
        refetchSessions();
      });
    };

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
      document.body.dataset.sessionId = sid;
      setActiveSessionId(sid);
      requestAnimationFrame(syncChrome);
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
    [runYoutubeImport],
  );

  const handleCloseSession = useCallback(() => {
    window.AutoLogger_stopTransportIfNeeded?.();
    document.body.dataset.sessionId = '';
    setActiveSessionId('');
    requestAnimationFrame(() => {
      syncChrome();
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
    });
  }, [queryClient]);

  const handleOpenSettings = useCallback(() => {
    setShowSettings(true);
  }, []);

  const handleCloseSettings = useCallback(() => {
    setShowSettings(false);
  }, []);

  return (
    <>
      <Toast />
      <div className="shell shell-v3">
        <div className={clsx('v6-app', styles.v6App)} id="v6-app">
          {isMobile && railOpen && (
            <button
              type="button"
              className={styles.railScrim}
              aria-label="Close navigation"
              onClick={closeRail}
            />
          )}
          <V6Rail
            activeSessionId={activeSessionId}
            profile={profile}
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
            onOpenSettings={() => {
              handleOpenSettings();
              closeRail();
            }}
          />
          <main
            className={clsx('main-v3', 'v3-layout-session-focus', styles.v6Workspace)}
            id="v3-main"
          >
            <div className={styles.v6WorkspaceTopCluster}>
              <button
                type="button"
                className={styles.mobileRailToggle}
                aria-label="Open navigation"
                onClick={() => setRailOpen(true)}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M4 7H20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
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
              <header
                className={clsx(
                  'v4-top-bar',
                  styles.v6WorkspaceTopBar,
                  styles.v6WorkspaceTopBarVoid,
                )}
                id="v4-app-top-bar"
              />
              <output
                className={styles.v6WorkspaceRecordingBar}
                aria-live="polite"
                aria-label="Recording status"
              >
                <span className={styles.v4Recording} id="top-bar-recording">
                  RECORDING AUDIO
                </span>
                <span className={clsx(styles.v4Timecode, 'mono')} id="top-bar-recording-dur">
                  00:00:00
                </span>
              </output>
            </div>

            {showNewSession && (
              <NewSessionModal
                profile={profile}
                onClose={() => setShowNewSession(false)}
                onCreated={handleSelectSession}
              />
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

            {/* Settings modal + session workspace */}
            <WorkspaceStatic
              sessionId={activeSessionId}
              showSettings={showSettings}
              onCloseSettings={handleCloseSettings}
              ytImportPending={ytImportPending}
            />
          </main>
        </div>
      </div>
    </>
  );
}
