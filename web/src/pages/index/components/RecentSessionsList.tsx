import { MoreVertical } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useSessionStatus } from '../../../api/hooks/useSessionStatus';
import {
  useArchiveSession,
  useDeleteSession,
  useRestoreSession,
  useUpdateSession,
} from '../../../api/hooks/useSessions';
import { useShowAccess } from '../../../api/hooks/useShowAccess';
import type { Session, SessionsResponse } from '../../../api/types';
import { Button } from '../../../shared/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../../shared/components/ui/dropdown-menu';
import { Field, FieldLabel } from '../../../shared/components/ui/field';
import { Input } from '../../../shared/components/ui/input';
import {
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from '../../../shared/components/ui/sidebar';
import { cn } from '../../../shared/lib/utils';
import { type ConfirmOptions, useConfirm } from '../../../shared/ui/ConfirmDialog';
import { Dialog } from '../../../shared/ui/Dialog';
import { Tooltip } from '../../../shared/ui/Tooltip';
import { fmtDateOnly } from '../../../shared/utils/fmtDateOnly';
import { AUTOLOGGER_LOADING_VIDEO_SRC } from '../../../shared/utils/loadingVideo';
import { showToast } from '../utils/toast';

// --- Session cards on the shadcn Sidebar (redesign-show-ignition D8, D10) ---
//
// Each card is a `SidebarMenuItem`: the openable card is a `SidebarMenuButton` (its `isActive`
// carries the one selected state, its `tooltip` names the session), and the ⋮ options menu is a
// `SidebarMenuAction` beside it, revealed on hover/focus. Archived and no-access cards are not
// openable, so they render the same two-line body in a plain row rather than a button. The look
// comes from the sidebar primitive and its tokens; the class strings below are layout only, plus
// the live treatment (a live badge: the 2px red outline and red timecode, kept from the old rail).

// Two-line card body inside the menu button / plain row.
const CARD_BODY = 'h-auto min-h-12 flex-col items-stretch justify-center gap-0.5 py-1.5';
// The plain (non-button) row: the menu button's box without its interactivity.
const CARD_ROW = 'flex w-full min-w-0 flex-col justify-center gap-0.5 rounded-ctl p-2 text-sm';
const CARD_TITLE = 'truncate font-semibold';

// Live (rolling and/or recording): a crisp 2px red outline on the card and a red timecode.
// `!` beats the menu button's own selected-state box shadow and the meta row's muted text.
const CARD_LIVE = 'rounded-ctl border-2! border-[#ef4444]!';
const DECK_RUNTIME_LIVE = 'text-[#ef4444]!';

const META_ROW = 'flex min-w-0 flex-row items-baseline justify-between gap-1';
const CARD_META = 'min-w-0 truncate text-xs font-normal text-muted-foreground';
const EMPTY_NOTE = 'm-0 px-2 py-1.5 text-[13px] leading-snug text-muted-foreground';
const DECK_RUNTIME = 'shrink-0 font-tc text-xs text-muted-foreground tabular-nums';

interface RenameModalProps {
  initialTitle: string;
  isPending: boolean;
  onSave: (title: string) => void;
  onClose: () => void;
}

function RenameSessionModal({ initialTitle, isPending, onSave, onClose }: RenameModalProps) {
  const [title, setTitle] = useState(initialTitle);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Slight defer so Radix Dialog autoFocus doesn't clobber select()
    const t = setTimeout(() => inputRef.current?.select(), 0);
    return () => clearTimeout(t);
  }, []);

  const handleSave = () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    onSave(trimmed);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Rename session">
      <Field className="mb-4">
        <FieldLabel htmlFor="rename-session-title">Session name</FieldLabel>
        <Input
          ref={inputRef}
          id="rename-session-title"
          type="text"
          maxLength={200}
          value={title}
          autoFocus
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSave();
          }}
        />
      </Field>
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={handleSave} disabled={isPending}>
          {isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </Dialog>
  );
}

function formatTimecodeHMS(tc: string | null): string {
  if (!tc) return '00:00:00';
  return tc.replace(/[:;]\d{2}$/, '');
}

// --- Shared card pieces (code-health-tail 4.7, finding 2.9) ---
// The material below was verbatim-duplicated between SessionCard and
// ArchivedSessionCard. Extraction only, not unification: the two variants
// remain separate components and keep their genuinely different behavior
// (container selectability, title button-vs-span, rename-modal ownership,
// data-start-offset, hidden a11y markers, per-variant menu items).

/**
 * Confirm-then-delete flow shared by both card variants. Takes the caller's
 * `confirm` (rather than owning its own `useConfirm`) so each variant keeps a
 * single ConfirmDialog instance serving all of its confirmations.
 */
function useDeleteSessionConfirm(
  session: Session,
  confirm: (opts: ConfirmOptions) => Promise<boolean>,
) {
  const { mutate: deleteSession } = useDeleteSession();
  return async () => {
    const ok = await confirm({
      title: 'Delete session',
      message: `Permanently delete “${session.title}”? This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    deleteSession(session.id, {
      onSuccess: () => showToast('Session permanently deleted.'),
      onError: (err: unknown) =>
        showToast(err instanceof Error ? err.message : 'Failed to delete', true),
    });
  };
}

/** Meta-line + runtime derivation shared by both card variants. */
function sessionCardMeta(s: Session): { metaLine: string; runtime: string } {
  const evCount = Number(s.event_count);
  const metaLine = `${fmtDateOnly(s.episode_date ?? s.created_at_utc)} · ${Number.isFinite(evCount) ? evCount : 0} events`;
  const runtime = (s.total_runtime_hms || '00:00:00').trim() || '00:00:00';
  return { metaLine, runtime };
}

/**
 * ⋮ menu scaffold (a `SidebarMenuAction` trigger + DropdownMenu) shared by both card variants;
 * the menu items differ per variant and arrive as children.
 */
function SessionCardMenu({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  // shadcn-port-shell D3: a shadcn DropdownMenu (role="menu", arrow keys, typeahead). Non-modal
  // (`modal={false}`): items open dialogs (rename, themed confirms), and a modal Radix menu closing
  // underneath a just-opened dialog leaves `pointer-events: none` stuck on <body>.
  // The trigger is a sibling of the card's open button, never inside it, so using the menu can't
  // select the session; the content still stops click/keydown propagation through the portal.
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange} modal={false}>
      <DropdownMenuTrigger asChild>
        <SidebarMenuAction showOnHover aria-label="Session options">
          <MoreVertical aria-hidden="true" />
        </SidebarMenuAction>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="right"
        align="start"
        sideOffset={6}
        onClick={stop}
        onKeyDown={stop}
      >
        <DropdownMenuGroup>{children}</DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Meta row (date · event count + runtime/timecode tooltip) shared by both variants. */
function SessionCardMetaRow({
  session,
  liveTimecode,
}: {
  session: Session;
  /** When set, the right-hand value is the live rolling/recording timecode. */
  liveTimecode?: string | null;
}) {
  const { metaLine, runtime } = sessionCardMeta(session);
  const showLive = liveTimecode != null && liveTimecode !== '';
  return (
    <div className={META_ROW}>
      <span className={CARD_META}>{metaLine}</span>
      <Tooltip content={showLive ? 'Current timecode' : 'Total runtime'}>
        <span className={cn(DECK_RUNTIME, showLive && DECK_RUNTIME_LIVE)}>
          {showLive ? liveTimecode : runtime}
        </span>
      </Tooltip>
    </div>
  );
}

interface SessionCardProps {
  session: Session;
  isActive: boolean;
  onSelect: () => void;
  onClose: () => void;
}

function SessionCard({ session: s, isActive, onSelect, onClose }: SessionCardProps) {
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const { mutate: updateSession, isPending: renamePending } = useUpdateSession(s.id);
  const { mutate: archiveSession } = useArchiveSession();
  const { confirm, confirmElement } = useConfirm();
  const handleDelete = useDeleteSessionConfirm(s, confirm);
  // Subscribe to the per-session status query only for the OPEN session — that
  // query is shared with the workspace's own status subscription (same query
  // key), so selecting it adds no poller beyond the workspace's. Background
  // (non-open) cards, rolling or not, derive their live badge and timecode
  // from the sessions-list poll's own row fields instead (`is_rolling`,
  // `rolling_timecode`, refreshed at that poll's ~5s cadence in `HH:MM:SS`
  // form — no frame field; see recent-sessions-single-poll).
  const { data: status } = useSessionStatus(isActive ? s.id : null);
  const isLive = Boolean(s.is_rolling || status?.is_rolling || status?.audio_recording_lease_alive);
  const liveTimecode = isLive ? (status?.timecode ?? formatTimecodeHMS(s.rolling_timecode)) : null;

  const handleRename = (newTitle: string) => {
    updateSession(
      { title: newTitle, start_offset_frames: s.start_offset_frames ?? 0 },
      {
        onSuccess: () => {
          showToast('Session updated.');
          setEditing(false);
        },
        onError: (err: unknown) =>
          showToast(err instanceof Error ? err.message : 'Failed to save', true),
      },
    );
  };

  const handleArchive = async () => {
    const ok = await confirm({
      title: 'Archive session',
      message: `Archive “${s.title}”? You can restore it later from Archived sessions.`,
      confirmLabel: 'Archive',
    });
    if (!ok) return;
    archiveSession(s.id, {
      onSuccess: () => showToast('Session archived.'),
      onError: (err: unknown) =>
        showToast(err instanceof Error ? err.message : 'Failed to archive', true),
    });
  };

  return (
    <SidebarMenuItem
      className={cn(isLive && CARD_LIVE)}
      data-session-id={s.id}
      data-live={isLive || undefined}
      data-menu-open={menuOpen || undefined}
    >
      {/* The open control. On the active card it is a no-op (the session is already shown;
          web-session-routing "Re-selecting the active session does not stack history"), and
          `aria-current` says so to assistive technology. */}
      <SidebarMenuButton
        size="lg"
        isActive={isActive}
        aria-current={isActive ? 'page' : undefined}
        tooltip={s.title}
        className={CARD_BODY}
        data-start-offset={s.start_offset_frames || 0}
        onClick={() => {
          if (!isActive) onSelect();
        }}
      >
        <span className={CARD_TITLE}>{s.title}</span>
        <SessionCardMetaRow session={s} liveTimecode={liveTimecode} />
        {isActive && <output className="hidden">ACTIVE SESSION</output>}
        {isLive && <output className="hidden">LIVE SESSION</output>}
      </SidebarMenuButton>
      <SessionCardMenu open={menuOpen} onOpenChange={setMenuOpen}>
        {isActive && (
          <DropdownMenuItem
            onSelect={() => {
              onClose();
            }}
          >
            Close session
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onSelect={() => {
            setEditing(true);
          }}
        >
          Rename
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            handleArchive();
          }}
        >
          Archive
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => {
            handleDelete();
          }}
        >
          Delete
        </DropdownMenuItem>
      </SessionCardMenu>
      {editing && (
        <RenameSessionModal
          initialTitle={s.title}
          isPending={renamePending}
          onSave={handleRename}
          onClose={() => setEditing(false)}
        />
      )}
      {confirmElement}
    </SidebarMenuItem>
  );
}

function ArchivedSessionCard({ session: s }: { session: Session }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { mutate: restoreSession } = useRestoreSession();
  const { confirm, confirmElement } = useConfirm();
  const handleDelete = useDeleteSessionConfirm(s, confirm);

  const handleRestore = async () => {
    const ok = await confirm({
      title: 'Restore session',
      message: `Restore “${s.title}” to Recent sessions?`,
      confirmLabel: 'Restore',
    });
    if (!ok) return;
    restoreSession(s.id, {
      onSuccess: () => showToast('Session restored.'),
      onError: (err: unknown) =>
        showToast(err instanceof Error ? err.message : 'Failed to restore', true),
    });
  };

  return (
    <SidebarMenuItem data-session-id={s.id} data-menu-open={menuOpen || undefined}>
      <div className={cn(CARD_ROW, 'pr-8')}>
        <span className={CARD_TITLE}>{s.title}</span>
        <SessionCardMetaRow session={s} />
      </div>
      <SessionCardMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuItem
          onSelect={() => {
            handleRestore();
          }}
        >
          Restore
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => {
            handleDelete();
          }}
        >
          Delete
        </DropdownMenuItem>
      </SessionCardMenu>
      {confirmElement}
    </SidebarMenuItem>
  );
}

/** A card of a session whose show the user can't access (show-grants D13; web-home-launch
 * "Session actions follow show access"): the title as plain text with the no-access hint, no ⋮
 * menu, no selection. Used for Recent and Archived alike. */
function NoAccessSessionCard({ session: s }: { session: Session }) {
  return (
    <SidebarMenuItem data-session-id={s.id} data-no-access="true">
      <div className={cn(CARD_ROW, 'cursor-default')}>
        <span className={cn(CARD_TITLE, 'text-muted-foreground')}>{s.title}</span>
        <span className={CARD_META}>No access — ask a team admin</span>
      </div>
    </SidebarMenuItem>
  );
}

/** Rail search match (ui-refresh): case-insensitive on the session title. */
function matchesFilter(s: Session, filter: string): boolean {
  const q = filter.trim().toLowerCase();
  if (!q) return true;
  return s.title.toLowerCase().includes(q);
}

interface Props {
  sessions: SessionsResponse | undefined;
  isLoading: boolean;
  activeSessionId: string;
  onSelectSession: (sid: string) => void;
  onCloseSession: () => void;
  /** Rail search query; empty shows everything. */
  filter?: string;
}

export function RecentSessionsList({
  sessions,
  isLoading,
  activeSessionId,
  onSelectSession,
  onCloseSession,
  filter = '',
}: Props) {
  const access = useShowAccess();
  if (isLoading && !sessions) {
    return (
      <output
        className="muted flex min-h-[3.5rem] items-center justify-center"
        id="session-loading"
        aria-busy="true"
        aria-live="polite"
        aria-label="Loading"
      >
        <div className="autologger-loading-video">
          <video
            className="autologger-loading-video__media"
            src={AUTOLOGGER_LOADING_VIDEO_SRC}
            preload="auto"
            muted
            playsInline
            autoPlay
            loop
          />
        </div>
      </output>
    );
  }

  const active = sessions?.active ?? [];

  if (active.length === 0) {
    return (
      <p className={EMPTY_NOTE} id="session-empty">
        No sessions yet. Create one to start logging.
      </p>
    );
  }

  const visible = active.filter((s) => matchesFilter(s, filter));

  if (visible.length === 0) {
    return (
      <p className={EMPTY_NOTE} id="session-empty">
        No sessions match “{filter.trim()}”.
      </p>
    );
  }

  return (
    <SidebarMenu id="session-list">
      {visible.map((s) =>
        access.canAccessShow(s.show_id) ? (
          <SessionCard
            key={s.id}
            session={s}
            isActive={s.id === activeSessionId}
            onSelect={() => onSelectSession(s.id)}
            onClose={onCloseSession}
          />
        ) : (
          <NoAccessSessionCard key={s.id} session={s} />
        ),
      )}
    </SidebarMenu>
  );
}

export function ArchivedSessionsList({
  sessions,
  filter = '',
}: {
  sessions: Session[];
  /** Rail search query; empty shows everything. */
  filter?: string;
}) {
  const access = useShowAccess();
  const visible = sessions.filter((s) => matchesFilter(s, filter));

  if (visible.length === 0) {
    return <p className={EMPTY_NOTE}>No archived sessions match “{filter.trim()}”.</p>;
  }

  return (
    <SidebarMenu id="archived-list">
      {visible.map((s) =>
        access.canAccessShow(s.show_id) ? (
          <ArchivedSessionCard key={s.id} session={s} />
        ) : (
          <NoAccessSessionCard key={s.id} session={s} />
        ),
      )}
    </SidebarMenu>
  );
}
