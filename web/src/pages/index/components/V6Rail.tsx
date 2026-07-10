import clsx from 'clsx';
import { useSessions } from '../../../api/hooks/useSessions';
import type { ProfilePayload } from '../../../api/types';
import { ArchivedSessionsList, RecentSessionsList } from './RecentSessionsList';

// --- converted class strings (were V6Rail.module.css) ---
// The desktop collapse mechanism is DRIVEN by the body class `v6-app--rail-collapsed`
// (toggled in handleRailToggle). ADJUDICATION (audit cross-cutting #4 was WRONG):
// Vite CSS-modules hashes the hyphen-case descendant tokens as locals — the built
// selector was `.v6-app--rail-collapsed ._v6-rail-primary_<hash>`, i.e. it MATCHES
// the same hashed class the TSX emits. Verified live (built+served): toggling
// collapse took the rail 260px→64px, section-title opacity 1→0, primary
// justify-content flex-start→center. So the collapse rules are ALIVE and convert as
// [.v6-app--rail-collapsed_&]: ancestor variants (NOT deleted). The mobile drawer
// (≤767px) is `max-md:`. The 16 --v6-rail-* geometry vars live in tailwind.css.

const RAIL =
  'relative z-[4] flex h-screen h-[100dvh] max-h-screen max-h-[100dvh] w-(--v6-rail-w-expanded) flex-[0_0_auto] flex-shrink-0 flex-col items-stretch gap-0 self-start overflow-hidden box-border rounded-none border-r border-v5-border-strong bg-[linear-gradient(180deg,rgba(19,27,48,24%),rgba(8,14,28,9%))] p-(--v6-rail-pad) shadow-[inset_-1px_0_0_rgba(255,255,255,0.04)] [transition:width_var(--v6-rail-dur)_var(--v6-rail-ease),padding_var(--v6-rail-dur)_var(--v6-rail-ease),border-color_0.2s_ease] [.v6-app--rail-collapsed_&]:box-border [.v6-app--rail-collapsed_&]:w-(--v6-rail-w-collapsed) [.v6-app--rail-collapsed_&]:px-(--v6-rail-pad-collapsed-x) [.v6-app--rail-collapsed_&]:py-(--v6-rail-pad-collapsed-y) [&>*:not(.v6-rail-glow)]:relative [&>*:not(.v6-rail-glow)]:z-[1] max-md:fixed max-md:top-0 max-md:left-0 max-md:h-screen max-md:h-[100dvh] max-md:max-h-none max-md:w-[min(82vw,20rem)] max-md:z-(--z-rail-drawer) max-md:translate-x-[-100%] max-md:overflow-y-auto max-md:[transition:transform_0.28s_var(--v6-rail-ease)] max-md:[.v6-app--rail-collapsed_&]:w-[min(82vw,20rem)] max-md:[.v6-app--rail-collapsed_&]:p-(--v6-rail-pad)';

// Mobile-open modifier (drawer slid in). Only meaningful under max-md:. The `!`
// on translate-x guarantees the open state beats the base max-md:translate-x-[-100%]
// (same utility family — className order alone won't decide the winner).
const RAIL_MOBILE_OPEN = 'max-md:translate-x-0! max-md:shadow-[0_18px_50px_rgba(0,0,0,0.5)]';

const RAIL_GLOW =
  'v6-rail-glow pointer-events-none absolute inset-0 rounded-none bg-[radial-gradient(circle_at_50%_0%,rgba(56,189,248,0.12),transparent_45%),linear-gradient(180deg,rgba(255,255,255,0.04),transparent_35%)]';

// The collapse rule sizes menu/primary/nav together to a square inner tile.
const COLLAPSE_TILE =
  '[.v6-app--rail-collapsed_&]:m-[0.15rem_0.1rem_0.15rem_0] [.v6-app--rail-collapsed_&]:box-border [.v6-app--rail-collapsed_&]:h-(--v6-rail-collapsed-inner) [.v6-app--rail-collapsed_&]:max-h-(--v6-rail-collapsed-inner) [.v6-app--rail-collapsed_&]:min-h-(--v6-rail-collapsed-inner) [.v6-app--rail-collapsed_&]:w-full [.v6-app--rail-collapsed_&]:max-w-full [.v6-app--rail-collapsed_&]:flex-[0_0_auto] [.v6-app--rail-collapsed_&]:[aspect-ratio:unset] [.v6-app--rail-collapsed_&]:justify-center [.v6-app--rail-collapsed_&]:self-stretch [.v6-app--rail-collapsed_&]:p-0';

const RAIL_MENU = clsx(
  COLLAPSE_TILE,
  'box-border flex h-(--v6-rail-btn-h) w-full max-w-full items-center justify-center self-center rounded-v5-sm border border-v5-border-strong bg-[rgba(255,255,255,0.04)] px-(--v6-rail-btn-pad-x) mb-2 cursor-pointer text-[rgba(229,238,252,0.72)] [transition:border-color_0.15s_ease,background_0.15s_ease,color_0.15s_ease] hover-always:text-v5-text hover-always:border-[color-mix(in_srgb,var(--v5-primary)_35%,var(--v5-border-strong))] hover-always:bg-[rgba(255,255,255,0.06)] focus-visible:text-v5-text focus-visible:border-[color-mix(in_srgb,var(--v5-primary)_35%,var(--v5-border-strong))] focus-visible:bg-[rgba(255,255,255,0.06)] [&>svg]:flex-shrink-0',
);

const RAIL_PRIMARY = clsx(
  COLLAPSE_TILE,
  // bg-transparent zeroes the native <button> buttonface; the gradient rides on
  // background-image over it (the legacy `background:<gradient>` shorthand did both).
  'box-border flex w-full min-h-[2.5rem] max-h-(--v6-rail-btn-h) flex-row items-center justify-start gap-(--v6-rail-gap) rounded-v5-sm border border-v5-border-strong bg-transparent bg-[linear-gradient(165deg,rgba(255,255,255,0.08),rgba(15,23,42,0.45))] px-(--v6-rail-btn-pad-x) mt-2 cursor-pointer font-[inherit] text-[0.8125rem] font-semibold tracking-[0.04em] normal-case text-v5-text [transition:border-color_0.15s_ease,background_0.15s_ease,box-shadow_0.15s_ease] hover-always:border-[color-mix(in_srgb,var(--v5-primary)_42%,var(--v5-border-strong))] hover-always:bg-[linear-gradient(165deg,rgba(255,255,255,0.1),rgba(15,23,42,0.52))] focus-visible:border-[color-mix(in_srgb,var(--v5-primary)_42%,var(--v5-border-strong))] focus-visible:bg-[linear-gradient(165deg,rgba(255,255,255,0.1),rgba(15,23,42,0.52))] [.v6-app--rail-collapsed_&]:justify-center [.v6-app--rail-collapsed_&]:gap-0 [.v6-app--rail-collapsed_&]:min-h-[unset] [.v6-app--rail-collapsed_&]:max-h-none',
);

const RAIL_PRIMARY_ICON =
  'inline-flex flex-shrink-0 items-center justify-center text-[rgba(229,238,252,0.72)] [&>svg]:block [.v6-app--rail-collapsed_&]:text-[rgba(229,238,252,0.85)]';

// Labels hide when collapsed, but the mobile drawer reverts them to visible.
const RAIL_PRIMARY_LABEL =
  'min-w-0 overflow-hidden text-left text-ellipsis whitespace-nowrap [.v6-app--rail-collapsed_&]:hidden max-md:[.v6-app--rail-collapsed_&]:[display:revert]';

const RAIL_SECTION_TITLE =
  'm-0 flex-shrink-0 max-h-16 px-0 pt-0 pb-2 pl-[0.15rem] text-[0.625rem] font-semibold tracking-[0.18em] uppercase text-v5-muted [transition:opacity_calc(var(--v6-rail-dur)*0.85)_ease,max-height_var(--v6-rail-dur)_var(--v6-rail-ease),padding_var(--v6-rail-dur)_var(--v6-rail-ease),margin_var(--v6-rail-dur)_var(--v6-rail-ease)] [.v6-app--rail-collapsed_&]:m-0 [.v6-app--rail-collapsed_&]:max-h-0 [.v6-app--rail-collapsed_&]:overflow-hidden [.v6-app--rail-collapsed_&]:p-0 [.v6-app--rail-collapsed_&]:opacity-0 max-md:[.v6-app--rail-collapsed_&]:[display:revert] max-md:[.v6-app--rail-collapsed_&]:max-h-none max-md:[.v6-app--rail-collapsed_&]:opacity-100';

const RAIL_RECENT_SHELF =
  'box-border flex min-h-0 max-h-(--v6-rail-recent-shelf-max-h) flex-[1_1_auto] flex-col overflow-hidden rounded-[var(--v6-rail-recent-shelf-radius)] bg-[image:var(--v6-rail-recent-shelf-bg)] mt-(--v6-rail-recent-shelf-mt) p-(--v6-rail-recent-shelf-pad) [transition:opacity_calc(var(--v6-rail-dur)*0.7)_ease,max-height_var(--v6-rail-dur)_var(--v6-rail-ease),margin_var(--v6-rail-dur)_var(--v6-rail-ease),padding_var(--v6-rail-dur)_var(--v6-rail-ease)] [.v6-app--rail-collapsed_&]:pointer-events-none [.v6-app--rail-collapsed_&]:flex-[0_0_0] [.v6-app--rail-collapsed_&]:min-h-0 [.v6-app--rail-collapsed_&]:max-h-0 [.v6-app--rail-collapsed_&]:mt-0 [.v6-app--rail-collapsed_&]:overflow-hidden [.v6-app--rail-collapsed_&]:p-0 [.v6-app--rail-collapsed_&]:opacity-0 max-md:[.v6-app--rail-collapsed_&]:pointer-events-auto max-md:[.v6-app--rail-collapsed_&]:flex-[1_1_auto] max-md:[.v6-app--rail-collapsed_&]:max-h-(--v6-rail-recent-shelf-max-h) max-md:[.v6-app--rail-collapsed_&]:opacity-100';

const RAIL_ARCHIVED_SHELF =
  'box-border flex min-h-0 max-h-48 flex-[0_1_auto] flex-col overflow-hidden rounded-[var(--v6-rail-recent-shelf-radius)] bg-[image:var(--v6-rail-recent-shelf-bg)] mt-(--v6-rail-recent-shelf-mt) p-(--v6-rail-recent-shelf-pad) [transition:opacity_calc(var(--v6-rail-dur)*0.7)_ease,max-height_var(--v6-rail-dur)_var(--v6-rail-ease),margin_var(--v6-rail-dur)_var(--v6-rail-ease),padding_var(--v6-rail-dur)_var(--v6-rail-ease)] [.v6-app--rail-collapsed_&]:pointer-events-none [.v6-app--rail-collapsed_&]:flex-[0_0_0] [.v6-app--rail-collapsed_&]:min-h-0 [.v6-app--rail-collapsed_&]:max-h-0 [.v6-app--rail-collapsed_&]:mt-0 [.v6-app--rail-collapsed_&]:overflow-hidden [.v6-app--rail-collapsed_&]:p-0 [.v6-app--rail-collapsed_&]:opacity-0 max-md:[.v6-app--rail-collapsed_&]:pointer-events-auto max-md:[.v6-app--rail-collapsed_&]:flex-[1_1_auto] max-md:[.v6-app--rail-collapsed_&]:max-h-(--v6-rail-recent-shelf-max-h) max-md:[.v6-app--rail-collapsed_&]:opacity-100';

const RAIL_SESSIONS_WRAP = 'flex min-h-0 flex-[1_1_auto] flex-col overflow-hidden';

// `.v4-search-input` (formerly two separate :global(.v4-search-input) rule
// blocks in AppShell.module.css). Base shape/typography from the first block
// (flex/min-w-0/h-full/border-none/bg-transparent/font-poppins/text-sm/
// font-normal; base color/placeholder #000 were themselves overridden by the
// second block below in source order, so only the final cascade values are
// kept). Color/placeholder from the second, later block (color: var(--v5-text);
// ::placeholder color rgba(255,255,255,0.35), opacity 1) — later wins at equal
// specificity. `placeholder:font-thin` restores the first block's
// `font-weight: 100` on ::placeholder (never overridden). Retained as a literal
// class string (not just Tailwind utilities) — perfDebug-era hooks may still
// query it.
const SEARCH_INPUT =
  'v4-search-input flex min-w-0 h-full border-none bg-transparent font-poppins text-sm font-normal text-v5-text placeholder:font-thin placeholder:text-white/35 placeholder:opacity-100';

// Offscreen-but-focusable search box wrapper (sr-only-style clip).
const RAIL_SEARCH_OFFSCREEN =
  'fixed top-0 left-[-10000px] m-0 h-px w-px overflow-hidden whitespace-nowrap border-0 p-0 [clip:rect(0,0,0,0)] [clip-path:inset(50%)]';

const RAIL_FOOTER = 'mt-auto flex w-full flex-shrink-0 justify-center';

const RAIL_NAV = clsx(
  COLLAPSE_TILE,
  'box-border inline-flex h-(--v6-rail-btn-h) w-full flex-row items-center justify-center gap-[0.55rem] rounded-v5-sm border border-v5-border-strong bg-[rgba(255,255,255,0.03)] px-(--v6-rail-btn-pad-x) cursor-pointer text-[0.8125rem] font-semibold tracking-[0.04em] normal-case text-v5-muted [transition:border-color_0.15s_ease,background_0.15s_ease,color_0.15s_ease] hover-always:text-v5-text hover-always:border-v5-border-strong hover-always:bg-[rgba(255,255,255,0.05)] focus-visible:text-v5-text focus-visible:border-v5-border-strong focus-visible:bg-[rgba(255,255,255,0.05)]',
);

// Google sign-in variant: light surface. Its own hover/focus wash replaces the
// base nav hover (exclusive branch — but the light-surface bg/border are distinct
// properties so they compose; the shared border/bg values are overridden here).
const RAIL_NAV_GOOGLE =
  'justify-center gap-[0.55rem] px-(--v6-rail-btn-pad-x) rounded-v5-sm border border-[#747775] bg-white text-[#1f1f1f] [font-family:"Roboto",ui-sans-serif,system-ui,-apple-system,"Segoe_UI",sans-serif] text-[0.8125rem] font-semibold leading-[1.2] tracking-[0.04em] shadow-[0_1px_2px_rgba(0,0,0,0.12)] hover-always:bg-[#f8f9fa] hover-always:text-[#1f1f1f] hover-always:border-[#5f6368] hover-always:shadow-[0_1px_3px_rgba(0,0,0,0.16)] focus-visible:bg-[#f8f9fa] focus-visible:text-[#1f1f1f] focus-visible:border-[#5f6368] focus-visible:shadow-[0_0_0_2px_#e8f0fe,0_1px_3px_rgba(0,0,0,0.16)]';

const RAIL_NAV_ICON = 'inline-flex flex-shrink-0';
const RAIL_NAV_ICON_GOOGLE = 'items-center justify-center';
const RAIL_NAV_LABEL =
  '[.v6-app--rail-collapsed_&]:hidden max-md:[.v6-app--rail-collapsed_&]:[display:revert]';
const RAIL_NAV_LABEL_GOOGLE = 'min-w-0 overflow-hidden text-center text-ellipsis whitespace-nowrap';

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
      className={clsx(RAIL, mobileOpen && RAIL_MOBILE_OPEN)}
      id="v6-rail"
      aria-label="Navigation"
      inert={isMobile && !mobileOpen ? true : undefined}
    >
      <div className={RAIL_GLOW} aria-hidden="true" />
      <button
        type="button"
        className={RAIL_MENU}
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

      <button type="button" className={RAIL_PRIMARY} id="v6-btn-new-session" onClick={onNewSession}>
        <span className={RAIL_PRIMARY_ICON} aria-hidden="true">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 5V19" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            <path d="M5 12H19" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </span>
        <span className={RAIL_PRIMARY_LABEL}>New Session</span>
      </button>

      <button
        type="button"
        className={RAIL_PRIMARY}
        id="v6-btn-search-logs"
        onClick={handleSearchClick}
      >
        <span className={RAIL_PRIMARY_ICON} aria-hidden="true">
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
        <span className={RAIL_PRIMARY_LABEL}>Search logs</span>
      </button>

      <div className={RAIL_RECENT_SHELF}>
        <p className={RAIL_SECTION_TITLE}>RECENT SESSIONS</p>
        <div className={RAIL_SESSIONS_WRAP}>
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
        <div className={RAIL_ARCHIVED_SHELF}>
          <p className={RAIL_SECTION_TITLE}>ARCHIVED</p>
          <div className={RAIL_SESSIONS_WRAP}>
            <ArchivedSessionsList sessions={sessions?.archived ?? []} />
          </div>
        </div>
      )}

      <div className={RAIL_SEARCH_OFFSCREEN}>
        <input
          className={SEARCH_INPUT}
          type="search"
          placeholder="Search through logs…"
          aria-label="Search through logs"
          id="top-bar-search"
          tabIndex={-1}
        />
      </div>

      <div className={RAIL_FOOTER}>
        <button
          type="button"
          className={clsx(RAIL_NAV, RAIL_NAV_GOOGLE, !showLogin && 'hidden')}
          id="v6-btn-login"
          aria-label="Sign in with Google"
          onClick={() => {
            window.location.href = '/auth/google/start';
          }}
        >
          <span className={clsx(RAIL_NAV_ICON, RAIL_NAV_ICON_GOOGLE)} aria-hidden="true">
            <svg
              className={'v6-google-mark block'}
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
          <span className={clsx(RAIL_NAV_LABEL, RAIL_NAV_LABEL_GOOGLE)}>Sign in with Google</span>
        </button>

        <button
          type="button"
          className={clsx(RAIL_NAV, !showSettings && 'hidden')}
          id="v6-btn-settings"
          onClick={onOpenSettings}
        >
          <span className={RAIL_NAV_ICON} aria-hidden="true">
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
          <span className={RAIL_NAV_LABEL}>Settings</span>
        </button>
      </div>
    </aside>
  );
}
