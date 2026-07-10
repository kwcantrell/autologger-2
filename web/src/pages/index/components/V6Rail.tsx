import clsx from 'clsx';
import { useSessions } from '../../../api/hooks/useSessions';
import type { ProfilePayload } from '../../../api/types';
import { ArchivedSessionsList, RecentSessionsList } from './RecentSessionsList';

import styles from './V6Rail.module.css';

interface Props {
  activeSessionId: string;
  profile: ProfilePayload | undefined;
  onSelectSession: (sid: string) => void;
  onCloseSession: () => void;
  onNewSession: () => void;
  onOpenSettings: () => void;
  /** Phone-first (≤767px): the rail renders as an off-canvas drawer. */
  isMobile?: boolean;
  mobileOpen?: boolean;
  onMobileClose?: () => void;
}

export function V6Rail({
  activeSessionId,
  profile,
  onSelectSession,
  onCloseSession,
  onNewSession,
  onOpenSettings,
  isMobile = false,
  mobileOpen = false,
  onMobileClose,
}: Props) {
  const { data: sessions, isLoading } = useSessions();

  const auth = profile?.auth;
  const oauthConfigured = Boolean(auth?.oauth_configured);
  const loggedIn = Boolean(auth?.logged_in);
  const showLogin = oauthConfigured && !loggedIn;
  const showSettings = !oauthConfigured || loggedIn;

  const handleRailToggle = () => {
    // On the mobile drawer the menu button closes the off-canvas rail; on
    // desktop it stays the in-place collapse toggle.
    if (isMobile) {
      onMobileClose?.();
      return;
    }
    document.body.classList.toggle('v6-app--rail-collapsed');
    const rail = document.getElementById('v6-rail');
    const main = document.getElementById('v3-main');
    const isNowCollapsed = document.body.classList.contains('v6-app--rail-collapsed');
    if (rail) rail.setAttribute('aria-expanded', String(!isNowCollapsed));
    if (main) main.classList.toggle('v6-workspace--rail-collapsed', isNowCollapsed);
  };

  const handleSearchClick = () => {
    const inp = document.getElementById('top-bar-search') as HTMLInputElement | null;
    if (inp) {
      inp.removeAttribute('tabindex');
      inp.focus({ preventScroll: true });
    }
  };

  return (
    <aside
      className={clsx(styles.v6Rail, mobileOpen && styles.v6RailMobileOpen)}
      id="v6-rail"
      aria-label="Navigation"
      inert={isMobile && !mobileOpen ? true : undefined}
    >
      <div className={styles.v6RailGlow} aria-hidden="true" />
      <button
        type="button"
        className={styles.v6RailMenu}
        id="v6-rail-toggle"
        aria-expanded="true"
        aria-label="Toggle navigation"
        onClick={handleRailToggle}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M4 7H20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <path d="M4 12H20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <path d="M4 17H15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </button>

      <button
        type="button"
        className={styles.v6RailPrimary}
        id="v6-btn-new-session"
        onClick={onNewSession}
      >
        <span className={styles.v6RailPrimaryIcon} aria-hidden="true">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 5V19" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            <path d="M5 12H19" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </span>
        <span className={styles.v6RailPrimaryLabel}>New Session</span>
      </button>

      <button
        type="button"
        className={styles.v6RailPrimary}
        id="v6-btn-search-logs"
        onClick={handleSearchClick}
      >
        <span className={styles.v6RailPrimaryIcon} aria-hidden="true">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="10.5" cy="10.5" r="6.25" stroke="currentColor" strokeWidth="1.75" />
            <path
              d="M15.5 15.5L20 20"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
            />
          </svg>
        </span>
        <span className={styles.v6RailPrimaryLabel}>Search logs</span>
      </button>

      <div className={styles.v6RailRecentShelf}>
        <p className={styles.v6RailSectionTitle}>RECENT SESSIONS</p>
        <div className={styles.v6RailSessionsWrap}>
          <RecentSessionsList
            sessions={sessions}
            isLoading={isLoading}
            activeSessionId={activeSessionId}
            onSelectSession={onSelectSession}
            onCloseSession={onCloseSession}
          />
        </div>
      </div>

      {(sessions?.archived ?? []).length > 0 && (
        <div className={styles.v6RailArchivedShelf}>
          <p className={styles.v6RailSectionTitle}>ARCHIVED</p>
          <div className={styles.v6RailSessionsWrap}>
            <ArchivedSessionsList sessions={sessions?.archived ?? []} />
          </div>
        </div>
      )}

      <div className={styles.v6RailSearchOffscreen}>
        <input
          className="v4-search-input"
          type="search"
          placeholder="Search through logs…"
          aria-label="Search through logs"
          id="top-bar-search"
          tabIndex={-1}
        />
      </div>

      <div className={styles.v6RailFooter}>
        <button
          type="button"
          className={clsx(styles.v6RailNav, styles.v6RailNavGoogleSignin, !showLogin && 'hidden')}
          id="v6-btn-login"
          aria-label="Sign in with Google"
          onClick={() => {
            window.location.href = '/auth/google/start';
          }}
        >
          <span
            className={clsx(styles.v6RailNavIcon, styles.v6RailNavIconGoogle)}
            aria-hidden="true"
          >
            <svg
              className={styles.v6GoogleMark}
              width="20"
              height="20"
              viewBox="0 0 48 48"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
            >
              <path
                fill="#EA4335"
                d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
              />
              <path
                fill="#4285F4"
                d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6C44.98 37.03 48 31.06 48 24c0-1.67-.14-3.29-.41-4.84z"
              />
              <path
                fill="#FBBC05"
                d="M6.99 29.16c-.65-1.95-1-4.02-1-6.16 0-2.15.35-4.22 1-6.16l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.35L6.99 29.16z"
              />
              <path
                fill="#34A853"
                d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.35 0-11.72-4.27-13.59-10.08l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
              />
            </svg>
          </span>
          <span className={clsx(styles.v6RailNavLabel, styles.v6RailNavLabelGoogle)}>
            Sign in with Google
          </span>
        </button>

        <button
          type="button"
          className={clsx(styles.v6RailNav, !showSettings && 'hidden')}
          id="v6-btn-settings"
          onClick={onOpenSettings}
        >
          <span className={styles.v6RailNavIcon} aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M12 15.25C13.7949 15.25 15.25 13.7949 15.25 12C15.25 10.2051 13.7949 8.75 12 8.75C10.2051 8.75 8.75 10.2051 8.75 12C8.75 13.7949 10.2051 15.25 12 15.25Z"
                stroke="currentColor"
                strokeWidth="1.6"
              />
              <path
                d="M19.4 15A1.66 1.66 0 0 0 19.73 16.83L19.79 16.89A2 2 0 1 1 16.96 19.72L16.9 19.66A1.66 1.66 0 0 0 15.07 19.33A1.66 1.66 0 0 0 14 20.85V21A2 2 0 1 1 10 21V20.91A1.66 1.66 0 0 0 8.91 19.39A1.66 1.66 0 0 0 7.09 19.72L7.03 19.78A2 2 0 1 1 4.2 16.95L4.26 16.89A1.66 1.66 0 0 0 4.59 15.06A1.66 1.66 0 0 0 3.07 14H3A2 2 0 1 1 3 10H3.09A1.66 1.66 0 0 0 4.61 8.91A1.66 1.66 0 0 0 4.28 7.09L4.22 7.03A2 2 0 1 1 7.05 4.2L7.11 4.26A1.66 1.66 0 0 0 8.94 4.59H9A1.66 1.66 0 0 0 10 3.07V3A2 2 0 1 1 14 3V3.09A1.66 1.66 0 0 0 15.09 4.61A1.66 1.66 0 0 0 16.91 4.28L16.97 4.22A2 2 0 1 1 19.8 7.05L19.74 7.11A1.66 1.66 0 0 0 19.41 8.94V9A1.66 1.66 0 0 0 20.93 10H21A2 2 0 1 1 21 14H20.91A1.66 1.66 0 0 0 19.39 15.09L19.4 15Z"
                stroke="currentColor"
                strokeWidth="1.3"
              />
            </svg>
          </span>
          <span className={styles.v6RailNavLabel}>Settings</span>
        </button>
      </div>
    </aside>
  );
}
