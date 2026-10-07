import { useQueryClient } from '@tanstack/react-query';
import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react';
import { useMemo, useSyncExternalStore } from 'react';
import { useProfile, useProfileMutation } from '../../../api/hooks/useProfile';
import { sessionStatusKeys } from '../../../api/hooks/useSessionStatus';
import { showAccessFrom } from '../../../api/hooks/useShowAccess';
import type { ProfileUpdateBody, TeamRole } from '../../../api/types';
import { Badge } from '../../../shared/components/ui/badge';
import { Button } from '../../../shared/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '../../../shared/components/ui/dropdown-menu';
import { SidebarTrigger } from '../../../shared/components/ui/sidebar';
import {
  getTransportStatus,
  type ShellTransportState,
  STOPPED_TRANSPORT_STATUS,
  subscribeTransportStatus,
} from '../coordination/transportStatus';
import { showToast } from '../utils/toast';

// --- The shell's top bar (redesign-show-ignition D5, D10; web-ui-system "Top bar names the
// active team, show and transport state") ---
//
// Sidebar control, then `Team ▾ › Show ▾ › status`, on one line at every width (names truncate).
// No wordmark and no Team/Show labels. The bar's tint is pure CSS on the shell's
// `data-transport` attribute (`[data-slot='topbar']` in tailwind.css).
//
// Switching writes `PUT /api/profile` immediately (D5):
//   - a team sends `{ active_studio_id }` with `active_show_id` omitted, so the server picks the
//     new team's first show (the Settings modal's mid-switch rule), then follows the
//     close-session path;
//   - a show sends `{ active_studio_id, active_show_id }` — the server 400s without the team
//     (`server/src/routers/profile.ts`), so the current team is echoed.
// Either then refetches the session list, events, session status and show categories, as the
// modal's save did (web-coordination-seam "The settings modal still refetches the session list").
// A failure leaves the cache — and so the shown selection — untouched and names the failure.
// With Settings open and holding unsaved edits, a switch first asks through the view's discard
// guard (`confirmSwitch`); declining keeps the edits and the selection.

const STATUS_LABEL: Record<ShellTransportState, string> = {
  stopped: 'STOPPED',
  rolling: 'ROLLING',
  recording: 'REC',
  playback: 'PLAY',
};

const ROLE_LABEL: Record<TeamRole, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };

// Crumb triggers: ghost buttons whose name truncates (22ch of the name's own size on desktop,
// narrower on phones so team, show and status stay on one line at 390px).
const CRUMB = 'min-w-0 shrink px-2 max-md:px-1.5';
const CRUMB_NAME =
  'min-w-0 max-w-[22ch] truncate text-[15px] max-md:max-w-[11ch] max-md:text-sm max-[400px]:max-w-[8ch]';
const CRUMB_SEP = 'size-3.5 shrink-0 text-si-dim';

interface Props {
  /** AppShell's close-session path (navigates to `/` only when a session is open). */
  onCloseSession: () => void;
  /** Return to the open session's console (closing Settings if it is open). */
  onReturnToSession: (sessionId: string) => void;
  /**
   * Asked before a switch: the open Settings view's discard guard (AppShell), so a switch never
   * drops unsaved Settings edits silently (web-ui-system "Honest save model in Settings").
   * `true` at once when nothing is dirty; a declined prompt leaves the selection unchanged.
   */
  confirmSwitch?: () => true | Promise<boolean>;
}

export function TopBar({ onCloseSession, onReturnToSession, confirmSwitch }: Props) {
  const { data: profile } = useProfile();
  const mutation = useProfileMutation();
  const queryClient = useQueryClient();
  const status = useSyncExternalStore(
    subscribeTransportStatus,
    getTransportStatus,
    () => STOPPED_TRANSPORT_STATUS,
  );

  const access = useMemo(() => showAccessFrom(profile), [profile]);
  const activeStudioId = access.activeStudioId;
  const activeShowId = profile?.active_show_id ?? '';
  const shows = profile?.shows ?? [];
  const teams = profile?.auth.user?.teams ?? profile?.studios ?? [];
  const activeTeamName =
    teams.find((t) => t.id === activeStudioId)?.name ?? profile?.active_studio?.name ?? '';
  const teamShows = shows.filter((s) => s.studio_id === activeStudioId);
  const activeShowName = teamShows.find((s) => s.id === activeShowId)?.name ?? '';

  // `what` names the switch in a failure ("Couldn't switch the team: …"); `closesSession` is true for
  // a team switch only.
  async function switchTo(what: string, closesSession: boolean, body: ProfileUpdateBody) {
    const allowed = confirmSwitch?.() ?? true;
    if (allowed !== true && !(await allowed)) return;
    try {
      await mutation.mutateAsync(body);
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'The change was not saved.';
      showToast(`Couldn't switch ${what}: ${detail}`, true);
      return;
    }
    if (closesSession) onCloseSession();
    queryClient.invalidateQueries({ queryKey: ['sessions'] });
    queryClient.invalidateQueries({ queryKey: ['events'] });
    queryClient.invalidateQueries({ queryKey: sessionStatusKeys.all() });
    queryClient.invalidateQueries({ queryKey: ['show-categories'] });
  }

  function chooseTeam(studioId: string) {
    if (!studioId || studioId === activeStudioId || mutation.isPending) return;
    void switchTo('the team', true, { active_studio_id: studioId });
  }

  function chooseShow(showId: string) {
    if (!showId || showId === activeShowId || mutation.isPending) return;
    void switchTo('the show', false, {
      active_studio_id: activeStudioId,
      active_show_id: showId,
    });
  }

  const label = STATUS_LABEL[status.state];
  const sessionTitle = status.title?.trim() || 'Untitled session';
  const statusBadge = (
    <Badge variant="transport">
      <span data-slot="live-dot" aria-hidden="true" className="size-2 rounded-full bg-current" />
      {label}
    </Badge>
  );

  return (
    <header
      data-slot="topbar"
      className="flex h-(--topbar-h) w-full min-w-0 shrink-0 items-center gap-2 px-3 md:gap-3 md:px-4"
    >
      {/* The shell's SidebarProvider (AppShell) owns the state; `[` and Ctrl/⌘+B toggle it too. */}
      <SidebarTrigger className="size-(--h-ctl) shrink-0" title="Toggle sidebar ( [ )" />

      <nav
        aria-label="Current team and show"
        className="flex min-w-0 flex-1 items-center gap-1 max-md:gap-0"
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className={CRUMB} title={activeTeamName || 'Switch team'}>
              <span className="sr-only">Switch team: </span>
              <span className={CRUMB_NAME}>{activeTeamName || 'No team'}</span>
              <ChevronDownIcon data-icon="inline-end" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[300px] max-w-[calc(100vw-1.5rem)]">
            <DropdownMenuLabel>Your teams</DropdownMenuLabel>
            <DropdownMenuGroup>
              <DropdownMenuRadioGroup value={activeStudioId} onValueChange={chooseTeam}>
                {teams.map((team) => {
                  const role = access.teamRole(team.id);
                  const count = shows.filter((s) => s.studio_id === team.id).length;
                  return (
                    <DropdownMenuRadioItem key={team.id} value={team.id}>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate">{team.name}</span>
                        <span className="text-xs font-normal text-muted-foreground">
                          {`${count} show${count === 1 ? '' : 's'}`}
                        </span>
                      </span>
                      {role && <Badge variant="outline">{ROLE_LABEL[role]}</Badge>}
                    </DropdownMenuRadioItem>
                  );
                })}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <ChevronRightIcon aria-hidden="true" className={CRUMB_SEP} />

        <DropdownMenu>
          <DropdownMenuTrigger asChild disabled={teamShows.length === 0}>
            <Button variant="ghost" className={CRUMB} title={activeShowName || 'Switch show'}>
              <span className="sr-only">Switch show: </span>
              <span className={CRUMB_NAME}>{activeShowName || 'No show'}</span>
              <ChevronDownIcon data-icon="inline-end" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[300px] max-w-[calc(100vw-1.5rem)]">
            <DropdownMenuLabel className="truncate">Shows in {activeTeamName}</DropdownMenuLabel>
            <DropdownMenuGroup>
              <DropdownMenuRadioGroup value={activeShowId} onValueChange={chooseShow}>
                {teamShows.map((show) => (
                  <DropdownMenuRadioItem key={show.id} value={show.id}>
                    <span className="truncate">{show.name}</span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <ChevronRightIcon aria-hidden="true" className={CRUMB_SEP} />

        {status.sessionId ? (
          <Button
            variant="ghost"
            className="shrink-0 px-1.5 md:min-w-0 md:shrink"
            aria-label={`${label}, ${sessionTitle}. Return to session`}
            title={`Return to ${sessionTitle}`}
            onClick={() => {
              if (status.sessionId) onReturnToSession(status.sessionId);
            }}
          >
            {statusBadge}
            <span className="min-w-0 truncate font-tc text-xs font-medium text-muted-foreground max-md:hidden">
              {sessionTitle}
            </span>
          </Button>
        ) : (
          <div
            data-slot="topbar-status"
            className="flex shrink-0 items-center gap-2 px-1.5 max-md:pr-0 md:min-w-0 md:shrink"
          >
            {statusBadge}
            {/* Phones keep the names legible: the line is read out but not drawn there. */}
            <span className="min-w-0 truncate text-xs text-muted-foreground max-md:sr-only">
              No session open
            </span>
          </div>
        )}
      </nav>

      {/* The transport's status for assistive technology: announced when the state changes,
          never on a timecode tick (the store only changes on transitions). */}
      <span role="status" className="sr-only">
        {`Transport ${label}`}
      </span>
    </header>
  );
}
