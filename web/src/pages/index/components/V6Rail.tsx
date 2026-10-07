import { Plus, Search, Settings, Upload, X } from 'lucide-react';
import { type ReactNode, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useSessions } from '../../../api/hooks/useSessions';
import { useShowAccess } from '../../../api/hooks/useShowAccess';
import { APP_VERSION } from '../../../shared/appVersion';
import { Button } from '../../../shared/components/ui/button';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  useSidebar,
} from '../../../shared/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../shared/components/ui/tooltip';
import { ArchivedSessionsList, RecentSessionsList } from './RecentSessionsList';

// --- The app rail on the shadcn Sidebar (redesign-show-ignition D8, D10) ---
//
// `Sidebar collapsible="icon"` inside the shell's `SidebarProvider` (AppShell): 272px expanded,
// a 68px icon strip collapsed, and the primitive's own Sheet on phones. The open state persists
// in localStorage (`autologger:sidebar`, the primitive's). It is toggled by the top bar's
// `SidebarTrigger`, the shell's `[` listener and the primitive's Ctrl/⌘+B — never from here.
//
//   - Header: New session and Import (only when the active team has a show the user can
//     access; web-home-launch "Session actions follow show access"), then the session search.
//   - Content: the Recent and Archived session cards (`RecentSessionsList`), hidden in the icon
//     strip like the approved preview's rail.
//   - Footer: Settings and the version.
//
// The sidebar container keeps the `#v6-rail` id, which the ignition tint targets
// (shared/theme/tailwind.css). The look is the primitive's and the `--sidebar-*` tokens';
// class strings here are layout only.

// In the icon strip a label stays in the accessible name but is not drawn.
const ICON_ONLY_LABEL = 'group-data-[collapsible=icon]:sr-only';

/** A tooltip shown only in the desktop icon strip, as `SidebarMenuButton`'s own is (held shut
 * elsewhere, so a focused button in the phone sheet opens no invisible layer that eats Escape). */
function StripTooltip({ label, children }: { label: string; children: ReactNode }) {
  const { state, isMobile } = useSidebar();
  const [open, setOpen] = useState(false);
  const enabled = state === 'collapsed' && !isMobile;
  return (
    <Tooltip open={enabled && open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right" align="center" hidden={!enabled}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

interface Props {
  activeSessionId: string;
  onSelectSession: (sid: string) => void;
  onCloseSession: () => void;
  onNewSession: () => void;
  onBatchImport: () => void;
  onOpenSettings: () => void;
}

export function V6Rail({
  activeSessionId,
  onSelectSession,
  onCloseSession,
  onNewSession,
  onBatchImport,
  onOpenSettings,
}: Props) {
  const { data: sessions, isLoading } = useSessions();
  const access = useShowAccess();
  const canCreate = access.accessibleShows(access.activeStudioId).length > 0;
  const { state, isMobile, setOpen, setOpenMobile } = useSidebar();
  // Real session search (ui-refresh): filters the Recent/Archived lists.
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Every rail action closes the phone sheet, as the old drawer did.
  const thenCloseSheet =
    <A extends unknown[]>(fn: (...args: A) => void) =>
    (...args: A) => {
      if (isMobile) setOpenMobile(false);
      fn(...args);
    };

  // The icon strip's search affordance (web-home-launch "Real rail session search"): a real
  // button, so Tab reaches it and Enter/Space activate it. It expands the sidebar first —
  // synchronously, so the input is displayed again — and then focuses the input.
  const expandAndFocusSearch = () => {
    if (!isMobile && state === 'collapsed') flushSync(() => setOpen(true));
    searchInputRef.current?.focus({ preventScroll: true });
  };

  const archived = sessions?.archived ?? [];

  return (
    // Desktop: the fixed sidebar container starts under the shell's top bar (--topbar-h).
    <Sidebar
      collapsible="icon"
      id="v6-rail"
      aria-label="Navigation"
      className="top-(--topbar-h) h-[calc(100svh-var(--topbar-h))]"
    >
      <SidebarHeader className="gap-3 px-3 pt-3 group-data-[collapsible=icon]:px-2">
        {canCreate && (
          <div className="grid grid-cols-2 gap-1.5 group-data-[collapsible=icon]:grid-cols-1">
            <StripTooltip label="New session">
              <Button
                id="v6-btn-new-session"
                className="w-full min-w-0"
                onClick={thenCloseSheet(onNewSession)}
              >
                <Plus aria-hidden="true" data-icon="inline-start" />
                <span className={ICON_ONLY_LABEL}>New session</span>
              </Button>
            </StripTooltip>
            <StripTooltip label="Import">
              <Button
                id="v6-btn-batch-import"
                variant="outline"
                className="w-full min-w-0"
                onClick={thenCloseSheet(onBatchImport)}
              >
                <Upload aria-hidden="true" data-icon="inline-start" />
                <span className={ICON_ONLY_LABEL}>Import</span>
              </Button>
            </StripTooltip>
          </div>
        )}

        {/* Icon strip: the search collapses to this button. (Not the `hidden` utility: the app's
            legacy `.hidden` hook is `display: none !important`, which no variant can undo.) */}
        <div className="[display:none] group-data-[collapsible=icon]:block">
          <StripTooltip label="Search sessions">
            <Button
              variant="outline"
              className="w-full"
              aria-label="Search sessions"
              onClick={expandAndFocusSearch}
            >
              <Search aria-hidden="true" />
            </Button>
          </StripTooltip>
        </div>

        {/* Expanded (and the phone sheet): the visible search input. */}
        <div className="relative group-data-[collapsible=icon]:hidden" id="v6-btn-search-logs">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <SidebarInput
            ref={searchInputRef}
            type="search"
            id="top-bar-search"
            className="h-(--h-ctl) pr-8 pl-8 [&::-webkit-search-cancel-button]:appearance-none"
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
              className="absolute top-1/2 right-1.5 -translate-y-1/2"
              aria-label="Clear search"
              onClick={() => {
                setSearchQuery('');
                searchInputRef.current?.focus({ preventScroll: true });
              }}
            >
              <X aria-hidden="true" />
            </Button>
          )}
        </div>
      </SidebarHeader>

      {/* The icon strip hides the lists (kept in layout so the footer stays at the bottom). */}
      <SidebarContent className="gap-0 group-data-[collapsible=icon]:invisible">
        <SidebarGroup>
          <SidebarGroupLabel>Recent sessions</SidebarGroupLabel>
          <SidebarGroupContent>
            <RecentSessionsList
              sessions={sessions}
              isLoading={isLoading}
              activeSessionId={activeSessionId}
              onSelectSession={thenCloseSheet(onSelectSession)}
              onCloseSession={thenCloseSheet(onCloseSession)}
              filter={searchQuery}
            />
          </SidebarGroupContent>
        </SidebarGroup>

        {archived.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel>Archived</SidebarGroupLabel>
            <SidebarGroupContent>
              <ArchivedSessionsList sessions={archived} filter={searchQuery} />
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>

      <SidebarSeparator className="mx-0" />
      <SidebarFooter className="px-3 group-data-[collapsible=icon]:px-2">
        <SidebarMenu className="group-data-[collapsible=icon]:items-center">
          <SidebarMenuItem>
            <SidebarMenuButton
              id="v6-btn-settings"
              tooltip="Settings"
              onClick={thenCloseSheet(onOpenSettings)}
            >
              <Settings aria-hidden="true" />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <p
          className="m-0 truncate text-center font-tc text-[0.625rem] text-muted-foreground select-none"
          title={`Autologger ${APP_VERSION}`}
        >
          v{APP_VERSION}
        </p>
      </SidebarFooter>
    </Sidebar>
  );
}
