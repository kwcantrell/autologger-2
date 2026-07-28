import clsx from 'clsx';
import { OverlayScrollbarsComponent } from 'overlayscrollbars-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import {
  useArchiveSession,
  useDeleteSession,
  useRestoreSession,
  useUpdateSession,
} from '../../../api/hooks/useSessions';
import type { Session, SessionsResponse } from '../../../api/types';
import { type ConfirmOptions, useConfirm } from '../../../shared/ui/ConfirmDialog';
import { Dialog } from '../../../shared/ui/Dialog';
import { Popover, PopoverItem } from '../../../shared/ui/Popover';
import { Tooltip } from '../../../shared/ui/Tooltip';
import { fmtDateOnly } from '../../../shared/utils/fmtDateOnly';
import { AUTOLOGGER_LOADING_VIDEO_SRC } from '../../../shared/utils/loadingVideo';
import { showToast } from '../utils/toast';

// --- converted class strings (were RecentSessionsList.module.css) ---

// Outer session-card row. `group` drives the ⋮-menu reveal on card hover; the
// data-menu-open (present when the Popover is open) makes overflow visible so the
// portal-less trail can escape the fixed-height tile. Hover/focus-within tint the
// border (unguarded → hover-always:). --v6-rail-session-tile-h is never defined
// anywhere, so its 2.875rem fallback is load-bearing → inlined literally.
// ui-refresh: tile grew 2.875rem → 3.15rem so the title/meta type could step up
// to legible sizes (the 0.55rem meta line measured 8.8px — unreadable in the
// dim rooms this product targets).
const RAIL_SESSION =
  'group relative box-border flex h-[3.15rem] max-h-[3.15rem] min-h-[3.15rem] w-full max-w-full flex-shrink-0 cursor-pointer flex-col items-stretch justify-center overflow-hidden rounded-v5-md border border-v5-border bg-[rgba(255,255,255,0.03)] px-[0.55rem] py-[0.3rem] text-left font-[inherit] text-[inherit] [transition:border-color_0.15s_ease,background_0.15s_ease] hover-always:border-[color-mix(in_srgb,var(--v5-primary)_28%,var(--v5-border))] hover-always:bg-[rgba(255,255,255,0.05)] focus-within:border-[color-mix(in_srgb,var(--v5-primary)_28%,var(--v5-border))] focus-within:bg-[rgba(255,255,255,0.05)] data-menu-open:z-10 data-menu-open:overflow-visible';

// Active-session variant: replaces the base border + background (recipe 3 —
// exclusive branch), including its own heightened hover/focus-within values.
const RAIL_SESSION_ACTIVE =
  'border-[color-mix(in_srgb,var(--v5-primary)_40%,var(--v5-border))] bg-[linear-gradient(180deg,rgba(56,189,248,0.12),rgba(15,23,42,0.35))] hover-always:border-[color-mix(in_srgb,var(--v5-primary)_45%,var(--v5-border))] hover-always:bg-[linear-gradient(180deg,rgba(56,189,248,0.16),rgba(15,23,42,0.38))] focus-within:border-[color-mix(in_srgb,var(--v5-primary)_45%,var(--v5-border))] focus-within:bg-[linear-gradient(180deg,rgba(56,189,248,0.16),rgba(15,23,42,0.38))]';

// Inner link fills the row; always transparent (base + the former !important
// hover/focus neutralizer collapse to a single bg-transparent by layer order).
const CARD_LINK =
  'flex min-h-0 min-w-0 max-h-full flex-[1_1_auto] flex-col justify-center gap-[0.06rem] overflow-hidden m-0 p-0 bg-transparent text-inherit no-underline shadow-none';

const DECK_ROW = 'flex min-h-0 min-w-0 flex-[0_0_auto] flex-row items-center gap-[0.35rem]';
const DECK_TITLE =
  'flex-[1_1_auto] min-w-0 cursor-pointer overflow-hidden border-none bg-transparent p-0 text-left text-[0.72rem] font-semibold font-[inherit] leading-[1.2] tracking-[0.02em] text-ellipsis whitespace-nowrap text-inherit';
const DECK_TRAIL =
  'inline-flex min-w-0 flex-[0_0_auto] flex-row items-center justify-end gap-[0.28rem]';
const DECK_RUNTIME =
  'flex-[0_0_auto] text-[0.62rem] font-semibold leading-[1.2] tracking-[0.03em] whitespace-nowrap text-v5-muted';

// ⋮ menu button: hidden until the card is hovered (group-hover-always:) or the
// Popover is open (data-open:). Hover/data-open also tint the button chrome.
const RAIL_MENU =
  'flex-[0_0_auto] m-0 h-[1.2rem] w-[1.2rem] cursor-pointer rounded-v5-sm border border-transparent bg-transparent p-0 text-[1rem] font-bold leading-none text-v5-muted opacity-0 [transition:opacity_0.15s_ease,background_0.15s_ease,border-color_0.15s_ease] group-hover-always:opacity-100 hover-always:border-v5-border-strong hover-always:bg-[rgba(15,23,42,0.55)] hover-always:text-v5-text focus-visible:opacity-100 focus-visible:border-v5-border-strong focus-visible:bg-[rgba(15,23,42,0.55)] focus-visible:text-v5-text data-open:border-v5-border-strong data-open:bg-[rgba(15,23,42,0.55)] data-open:text-v5-text data-open:opacity-100';

const META_ROW =
  'flex min-w-0 flex-[0_0_auto] flex-row items-baseline justify-between gap-[0.25rem]';
const CARD_META =
  'block min-h-0 min-w-0 flex-[1_1_auto] overflow-hidden text-[0.62rem] leading-[1.2] text-ellipsis whitespace-nowrap text-v5-muted';
const RAIL_SESSIONS = 'os-rail-sessions min-h-0 flex-[1_1_auto]';

/* Shared OverlayScrollbars config for the rail's two scroll surfaces (recent
 * + archived). Bars auto-hide on pointer leave; theme is the lib's built-in
 * light bar which reads well over the V5 dark glass background. */
const railOsOptions = {
  scrollbars: {
    theme: 'os-theme-light',
    autoHide: 'leave',
    autoHideDelay: 250,
  },
} as const;

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
      <input
        ref={inputRef}
        type="text"
        className="profile-select box-border w-full"
        maxLength={200}
        value={title}
        autoFocus
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleSave();
        }}
      />
      <div className="flex justify-end gap-2">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn primary" onClick={handleSave} disabled={isPending}>
          {isPending ? 'Saving…' : 'Save'}
        </button>
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
 * ⋮ menu scaffold (trail wrapper + Popover + trigger button) shared by both
 * card variants; the menu items differ per variant and arrive as children.
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
  return (
    <div className={DECK_TRAIL}>
      <Popover
        open={open}
        onOpenChange={onOpenChange}
        ariaLabel="Session options"
        trigger={
          <button
            type="button"
            className={RAIL_MENU}
            aria-label="Session options"
            data-open={open || undefined}
            onClick={(e) => e.stopPropagation()}
          >
            ⋮
          </button>
        }
      >
        {children}
      </Popover>
    </div>
  );
}

/** Meta row (date · event count + runtime tooltip) shared by both variants. */
function SessionCardMetaRow({ session }: { session: Session }) {
  const { metaLine, runtime } = sessionCardMeta(session);
  return (
    <div className={META_ROW}>
      <span className={CARD_META}>{metaLine}</span>
      <Tooltip content="Total runtime">
        <span className={clsx(DECK_RUNTIME, 'mono')}>{runtime}</span>
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

  const handleCardClick = (e: React.MouseEvent) => {
    const target = e.target as Element;
    if (target.closest('button, a, input, select, textarea')) return;
    onSelect();
  };

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

  const rowClass = clsx(RAIL_SESSION, isActive && RAIL_SESSION_ACTIVE);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: clickable-card convenience around real <button>s (selection also via the inner title button); a native button is impossible here due to nested interactive children
    <div
      className={rowClass}
      data-session-id={s.id}
      data-menu-open={menuOpen || undefined}
      onClick={handleCardClick}
      onKeyDown={(e: React.KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') onSelect();
      }}
    >
      <div className={CARD_LINK} data-start-offset={s.start_offset_frames || 0}>
        {isActive && <output className="hidden">ACTIVE SESSION</output>}
        <div className={DECK_ROW}>
          <button
            type="button"
            className={DECK_TITLE}
            // On the active card the title is a no-op (the session is already
            // selected); aria-disabled says so to AT without changing the
            // rendered look or the tab order (code-health-tail 4.8).
            aria-disabled={isActive || undefined}
            onClick={(e) => {
              e.stopPropagation();
              if (!isActive) onSelect();
            }}
          >
            {s.title}
          </button>
          <SessionCardMenu open={menuOpen} onOpenChange={setMenuOpen}>
            {isActive && (
              <PopoverItem
                onClick={() => {
                  setMenuOpen(false);
                  onClose();
                }}
              >
                Close session
              </PopoverItem>
            )}
            <PopoverItem
              onClick={() => {
                setMenuOpen(false);
                setEditing(true);
              }}
            >
              Rename
            </PopoverItem>
            <PopoverItem
              onClick={() => {
                setMenuOpen(false);
                handleArchive();
              }}
            >
              Archive
            </PopoverItem>
            <PopoverItem
              danger
              onClick={() => {
                setMenuOpen(false);
                handleDelete();
              }}
            >
              Delete
            </PopoverItem>
          </SessionCardMenu>
        </div>
        <SessionCardMetaRow session={s} />
        {s.is_rolling && (
          <span className="hidden">● Rolling - {formatTimecodeHMS(s.rolling_timecode)}</span>
        )}
      </div>
      {editing && (
        <RenameSessionModal
          initialTitle={s.title}
          isPending={renamePending}
          onSave={handleRename}
          onClose={() => setEditing(false)}
        />
      )}
      {confirmElement}
    </div>
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
    <div className={RAIL_SESSION} data-session-id={s.id} data-menu-open={menuOpen || undefined}>
      <div className={CARD_LINK}>
        <div className={DECK_ROW}>
          <span className={DECK_TITLE}>{s.title}</span>
          <SessionCardMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <PopoverItem
              onClick={() => {
                setMenuOpen(false);
                handleRestore();
              }}
            >
              Restore
            </PopoverItem>
            <PopoverItem
              danger
              onClick={() => {
                setMenuOpen(false);
                handleDelete();
              }}
            >
              Delete
            </PopoverItem>
          </SessionCardMenu>
        </div>
        <SessionCardMetaRow session={s} />
      </div>
      {confirmElement}
    </div>
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
      <p
        className="muted m-0 px-[0.15rem] py-[0.35rem] text-[0.72rem] leading-[1.35]"
        id="session-empty"
      >
        No sessions yet. Create one to start logging.
      </p>
    );
  }

  const visible = active.filter((s) => matchesFilter(s, filter));

  if (visible.length === 0) {
    return (
      <p
        className="muted m-0 px-[0.15rem] py-[0.35rem] text-[0.72rem] leading-[1.35]"
        id="session-empty"
      >
        No sessions match “{filter.trim()}”.
      </p>
    );
  }

  return (
    <OverlayScrollbarsComponent
      element="div"
      id="session-list"
      className={RAIL_SESSIONS}
      defer
      options={railOsOptions}
    >
      {visible.map((s) => (
        <SessionCard
          key={s.id}
          session={s}
          isActive={s.id === activeSessionId}
          onSelect={() => onSelectSession(s.id)}
          onClose={onCloseSession}
        />
      ))}
    </OverlayScrollbarsComponent>
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
  const visible = sessions.filter((s) => matchesFilter(s, filter));

  if (visible.length === 0) {
    return (
      <p className="muted m-0 px-[0.15rem] py-[0.35rem] text-[0.72rem] leading-[1.35]">
        No archived sessions match “{filter.trim()}”.
      </p>
    );
  }

  return (
    <OverlayScrollbarsComponent
      element="div"
      id="archived-list"
      className={RAIL_SESSIONS}
      defer
      options={railOsOptions}
    >
      {visible.map((s) => (
        <ArchivedSessionCard key={s.id} session={s} />
      ))}
    </OverlayScrollbarsComponent>
  );
}
