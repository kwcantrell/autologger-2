import clsx from 'clsx';
import { Menu, Plus, Search, Settings, Upload, Users, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { useRoute } from 'wouter';
import { useSessions } from '../../../api/hooks/useSessions';
import { useShowAccess } from '../../../api/hooks/useShowAccess';
import { APP_VERSION } from '../../../shared/appVersion';
import { Button } from '../../../shared/components/ui/button';
import { navigate } from '../navigation';
import { ArchivedSessionsList, RecentSessionsList } from './RecentSessionsList';
import { isDesktopRailCollapsed, toggleDesktopRailCollapsed } from './railCollapse';

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
// Desktop height: the rail stretches to its row, which sits under the full-width top bar
// (redesign-show-ignition 3.1), instead of claiming the whole viewport height.

const RAIL =
  'relative z-[4] flex w-(--v6-rail-w-expanded) flex-[0_0_auto] flex-shrink-0 flex-col items-stretch gap-0 self-stretch overflow-hidden box-border rounded-none border-r border-v5-border-strong bg-[linear-gradient(180deg,rgba(19,27,48,24%),rgba(8,14,28,9%))] p-(--v6-rail-pad) shadow-[inset_-1px_0_0_rgba(255,255,255,0.04)] [transition:width_var(--v6-rail-dur)_var(--v6-rail-ease),padding_var(--v6-rail-dur)_var(--v6-rail-ease),border-color_0.2s_ease] [.v6-app--rail-collapsed_&]:box-border [.v6-app--rail-collapsed_&]:w-(--v6-rail-w-collapsed) [.v6-app--rail-collapsed_&]:px-(--v6-rail-pad-collapsed-x) [.v6-app--rail-collapsed_&]:py-(--v6-rail-pad-collapsed-y) [&>*:not(.v6-rail-glow)]:relative [&>*:not(.v6-rail-glow)]:z-[1] max-md:fixed max-md:top-0 max-md:left-0 max-md:h-screen max-md:h-[100dvh] max-md:max-h-none max-md:w-[min(82vw,20rem)] max-md:z-(--z-rail-drawer) max-md:translate-x-[-100%] max-md:overflow-y-auto max-md:[transition:transform_0.28s_var(--v6-rail-ease)] max-md:[.v6-app--rail-collapsed_&]:w-[min(82vw,20rem)] max-md:[.v6-app--rail-collapsed_&]:p-(--v6-rail-pad)';

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

// ui-refresh: the fake "Search logs" affordance (a button that focused an input
// parked at left:-10000px) is replaced by a REAL inline session search. The
// field shares RAIL_PRIMARY's glass chrome; the input hides when the rail is
// collapsed (icon stays, click/keyboard expands + focuses), and the mobile
// drawer reverts it to visible like every other rail label. The legacy
// `v4-search-input` literal + offscreen `#top-bar-search` markup are gone with
// the dead affordance they served.
const RAIL_SEARCH_BOX = clsx(
  COLLAPSE_TILE,
  'box-border flex w-full min-h-[2.5rem] max-h-(--v6-rail-btn-h) flex-row items-center justify-start gap-(--v6-rail-gap) rounded-v5-sm border border-v5-border-strong bg-transparent bg-[linear-gradient(165deg,rgba(255,255,255,0.05),rgba(15,23,42,0.4))] px-(--v6-rail-btn-pad-x) mt-2 cursor-text [transition:border-color_0.15s_ease,background_0.15s_ease] hover-always:border-[color-mix(in_srgb,var(--v5-primary)_35%,var(--v5-border-strong))] focus-within:border-[color-mix(in_srgb,var(--v5-primary)_45%,var(--v5-border-strong))] focus-within:bg-[linear-gradient(165deg,rgba(255,255,255,0.07),rgba(15,23,42,0.46))] [.v6-app--rail-collapsed_&]:justify-center [.v6-app--rail-collapsed_&]:gap-0 [.v6-app--rail-collapsed_&]:min-h-[unset] [.v6-app--rail-collapsed_&]:max-h-none [.v6-app--rail-collapsed_&]:cursor-pointer',
);

// The collapsed-rail affordance must be a REAL focusable control (panel
// finding — the spike's `div onClick` wrapping only a decorative, aria-hidden
// icon span was keyboard-unreachable once the input itself hid via
// `[.v6-app--rail-collapsed_&]:hidden`). The icon becomes a genuine `<button>`
// — visible and functionally identical in both rail states, so there is one
// code path rather than a collapsed-only extra element — Tab reaches it and
// Enter/Space fire its onClick like any other button, which expands the rail
// (if collapsed) and focuses the visible input either way. The RAIL_SEARCH_BOX
// div keeps its own onClick below purely as a click-anywhere-in-the-box
// convenience for pointer users; it is not a substitute for this button.
const RAIL_SEARCH_ICON_BTN = clsx(
  RAIL_PRIMARY_ICON,
  'cursor-pointer rounded-v5-sm border-0 bg-transparent p-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[rgba(56,189,248,0.55)]',
);

const RAIL_SEARCH_INPUT =
  'min-w-0 flex-[1_1_auto] border-none bg-transparent p-0 font-[inherit] text-[0.8125rem] font-medium text-v5-text outline-none placeholder:text-[rgba(229,238,252,0.55)] placeholder:font-normal [&::-webkit-search-cancel-button]:[-webkit-appearance:none] [.v6-app--rail-collapsed_&]:hidden max-md:[.v6-app--rail-collapsed_&]:[display:revert]';

const RAIL_SEARCH_CLEAR =
  'inline-flex h-5 w-5 flex-shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-v5-muted hover-always:text-v5-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[rgba(56,189,248,0.55)] [.v6-app--rail-collapsed_&]:hidden max-md:[.v6-app--rail-collapsed_&]:[display:revert]';

// Pushes Teams/Settings + version to the bottom of the rail column.
const RAIL_FOOTER_STACK = 'mt-auto flex w-full flex-shrink-0 flex-col items-stretch gap-2';

// Expanded: Teams + Settings sit side-by-side. Collapsed: stack so the two
// icon tiles fit the narrow rail (side-by-side overflows --v6-rail-w-collapsed).
// Mobile drawer reverts to row like the other collapsed→drawer overrides.
const RAIL_FOOTER =
  'flex w-full flex-shrink-0 justify-center gap-2 [.v6-app--rail-collapsed_&]:flex-col [.v6-app--rail-collapsed_&]:items-stretch [.v6-app--rail-collapsed_&]:gap-1 max-md:[.v6-app--rail-collapsed_&]:flex-row max-md:[.v6-app--rail-collapsed_&]:items-center max-md:[.v6-app--rail-collapsed_&]:gap-2';
// Compact grey version chip — stays readable in the 4rem collapsed rail
// (inner ~3.5rem); ellipsis is a safety net if the version string ever grows.
// Pull up by half the rail's bottom pad so the version sits closer to the edge
// (expanded pad 1.1rem → 0.55rem; collapsed-y 0.45rem → 0.225rem).
const RAIL_VERSION =
  'm-0 -mb-[calc(var(--v6-rail-pad)/2)] w-full max-w-full flex-shrink-0 overflow-hidden text-center text-[0.58rem] font-medium leading-none tracking-[0.06em] text-v5-muted text-ellipsis whitespace-nowrap [font-variant-numeric:tabular-nums] select-none [.v6-app--rail-collapsed_&]:-mb-[calc(var(--v6-rail-pad-collapsed-y)/2)] max-md:[.v6-app--rail-collapsed_&]:-mb-[calc(var(--v6-rail-pad)/2)]';

const RAIL_NAV = clsx(
  COLLAPSE_TILE,
  'box-border inline-flex h-(--v6-rail-btn-h) w-full flex-row items-center justify-center gap-[0.55rem] rounded-v5-sm border border-v5-border-strong bg-[rgba(255,255,255,0.03)] px-(--v6-rail-btn-pad-x) cursor-pointer text-[0.8125rem] font-semibold tracking-[0.04em] normal-case text-v5-muted [transition:border-color_0.15s_ease,background_0.15s_ease,color_0.15s_ease] hover-always:text-v5-text hover-always:border-v5-border-strong hover-always:bg-[rgba(255,255,255,0.05)] focus-visible:text-v5-text focus-visible:border-v5-border-strong focus-visible:bg-[rgba(255,255,255,0.05)]',
);

const RAIL_NAV_ICON = 'inline-flex flex-shrink-0';
const RAIL_NAV_LABEL =
  '[.v6-app--rail-collapsed_&]:hidden max-md:[.v6-app--rail-collapsed_&]:[display:revert]';

interface Props {
  activeSessionId: string;
  onSelectSession: (sid: string) => void;
  onCloseSession: () => void;
  onNewSession: () => void;
  onBatchImport: () => void;
  onOpenSettings: () => void;
  /** Phone-first (≤767px): the rail renders as an off-canvas drawer. */
  isMobile?: boolean;
  mobileOpen?: boolean;
  onMobileClose?: () => void;
}

export function V6Rail({
  activeSessionId,
  onSelectSession,
  onCloseSession,
  onNewSession,
  onBatchImport,
  onOpenSettings,
  isMobile = false,
  mobileOpen = false,
  onMobileClose,
}: Props) {
  const { data: sessions, isLoading } = useSessions();
  const access = useShowAccess();
  const canCreate = access.accessibleShows(access.activeStudioId).length > 0;
  // Same-route guard (design D2 gate decision 1, mirroring AppShell's own
  // `onTeamsRoute` read): skip navigate when already on /teams, so repeated
  // clicks don't stack duplicate history entries and deaden browser Back.
  const [onTeamsRoute] = useRoute('/teams');
  // Real session search (ui-refresh): filters the Recent/Archived shelves.
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  const handleRailToggle = () => {
    // On the mobile drawer the menu button closes the off-canvas rail; on
    // desktop it stays the in-place collapse toggle.
    if (isMobile) {
      onMobileClose?.();
      return;
    }
    toggleDesktopRailCollapsed();
  };

  const handleSearchBoxClick = () => {
    // Collapsed desktop rail: the box is icon-only — expand first so the input
    // exists to type into, then focus it. Same action whether reached by
    // pointer (this handler and the box's own onClick) or keyboard (the real
    // button rendered inside the box, below) — the spec scenario requires
    // both paths to expand + focus identically.
    if (!isMobile && isDesktopRailCollapsed()) {
      handleRailToggle();
    }
    searchInputRef.current?.focus({ preventScroll: true });
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
        <Menu className="size-5" strokeWidth={1.8} aria-hidden="true" />
      </button>

      {/* show-grants D13: New Session and Batch Import only when the active team has a show the
          user can access (web-home-launch "Session actions follow show access"). */}
      {canCreate && (
        <>
          <button
            type="button"
            className={RAIL_PRIMARY}
            id="v6-btn-new-session"
            onClick={onNewSession}
          >
            <span className={RAIL_PRIMARY_ICON} aria-hidden="true">
              <Plus className="size-5" strokeWidth={1.8} aria-hidden="true" />
            </span>
            <span className={RAIL_PRIMARY_LABEL}>New Session</span>
          </button>

          <button
            type="button"
            className={RAIL_PRIMARY}
            id="v6-btn-batch-import"
            onClick={onBatchImport}
          >
            <span className={RAIL_PRIMARY_ICON} aria-hidden="true">
              <Upload className="size-5" strokeWidth={1.8} aria-hidden="true" />
            </span>
            <span className={RAIL_PRIMARY_LABEL}>Batch Import</span>
          </button>
        </>
      )}

      {/* biome-ignore lint/a11y/noStaticElementInteractions: click-to-focus convenience around the real <input>/<button>; keyboard users reach the button below directly */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the wrapped <button>/<input> are the keyboard surfaces; the div click only forwards focus */}
      <div className={RAIL_SEARCH_BOX} id="v6-btn-search-logs" onClick={handleSearchBoxClick}>
        {/* Real, always-focusable control (not a decorative span) — see
            RAIL_SEARCH_ICON_BTN's comment: this is what makes the collapsed
            state's search affordance keyboard-reachable. */}
        <Button
          variant="ghost"
          size="icon-sm"
          className={RAIL_SEARCH_ICON_BTN}
          aria-label="Search sessions"
          onClick={(e) => {
            e.stopPropagation();
            handleSearchBoxClick();
          }}
        >
          <Search className="size-5" strokeWidth={1.75} aria-hidden="true" />
        </Button>
        <input
          ref={searchInputRef}
          type="search"
          className={RAIL_SEARCH_INPUT}
          id="top-bar-search"
          placeholder="Search sessions…"
          aria-label="Search sessions"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && searchQuery) {
              e.stopPropagation();
              setSearchQuery('');
            }
          }}
        />
        {searchQuery !== '' && (
          <Button
            variant="ghost"
            size="icon-xs"
            className={RAIL_SEARCH_CLEAR}
            aria-label="Clear search"
            onClick={(e) => {
              e.stopPropagation();
              setSearchQuery('');
              searchInputRef.current?.focus({ preventScroll: true });
            }}
          >
            <X className="size-3" strokeWidth={2} aria-hidden="true" />
          </Button>
        )}
      </div>

      <div className={RAIL_RECENT_SHELF}>
        <p className={RAIL_SECTION_TITLE}>RECENT SESSIONS</p>
        <div className={RAIL_SESSIONS_WRAP}>
          <RecentSessionsList
            sessions={sessions}
            isLoading={isLoading}
            activeSessionId={activeSessionId}
            onSelectSession={onSelectSession}
            onCloseSession={onCloseSession}
            filter={searchQuery}
          />
        </div>
      </div>

      {(sessions?.archived ?? []).length > 0 && (
        <div className={RAIL_ARCHIVED_SHELF}>
          <p className={RAIL_SECTION_TITLE}>ARCHIVED</p>
          <div className={RAIL_SESSIONS_WRAP}>
            <ArchivedSessionsList sessions={sessions?.archived ?? []} filter={searchQuery} />
          </div>
        </div>
      )}

      <div className={RAIL_FOOTER_STACK}>
        <div className={RAIL_FOOTER}>
          {/* Shell affordance to reach `/teams` (teams-self-serve, task 6.2;
            team-management spec: "Teams management UI" — "reachable from the
            app shell"). Uses the navigation wrapper ONLY, same as every other
            in-app navigation (design D1/D4) — no direct history/wouter call. */}
          <button
            type="button"
            className={RAIL_NAV}
            id="v6-btn-teams"
            onClick={() => {
              if (!onTeamsRoute) navigate('/teams');
            }}
          >
            <span className={RAIL_NAV_ICON} aria-hidden="true">
              <Users className="size-5" strokeWidth={1.6} aria-hidden="true" />
            </span>
            <span className={RAIL_NAV_LABEL}>Teams</span>
          </button>
          <button type="button" className={RAIL_NAV} id="v6-btn-settings" onClick={onOpenSettings}>
            <span className={RAIL_NAV_ICON} aria-hidden="true">
              <Settings className="size-5" strokeWidth={1.6} aria-hidden="true" />
            </span>
            <span className={RAIL_NAV_LABEL}>Settings</span>
          </button>
        </div>
        <p className={RAIL_VERSION} title={`Autologger ${APP_VERSION}`}>
          v{APP_VERSION}
        </p>
      </div>
    </aside>
  );
}
