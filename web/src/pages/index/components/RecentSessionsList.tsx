import clsx from 'clsx';
import { OverlayScrollbarsComponent } from 'overlayscrollbars-react';
import { useEffect, useRef, useState } from 'react';
import {
  useArchiveSession,
  useDeleteSession,
  useRestoreSession,
  useUpdateSession,
} from '../../../api/hooks/useSessions';
import type { Session, SessionsResponse } from '../../../api/types';
import { Dialog } from '../../../shared/ui/Dialog';
import { Popover, PopoverItem } from '../../../shared/ui/Popover';
import { Tooltip } from '../../../shared/ui/Tooltip';
import { AUTOLOGGER_LOADING_VIDEO_SRC } from '../../../shared/utils/loadingVideo';
import { showToast } from '../utils/toast';

import styles from './RecentSessionsList.module.css';

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
        className={clsx('profile-select', styles.v6RenameModalInput)}
        maxLength={200}
        value={title}
        autoFocus
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleSave();
        }}
      />
      <div className={styles.v6RenameModalActions}>
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

function fmtDateOnly(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatTimecodeHMS(tc: string | null): string {
  if (!tc) return '00:00:00';
  return tc.replace(/[:;]\d{2}$/, '');
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
  const { mutate: deleteSession } = useDeleteSession();

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

  const handleArchive = () => {
    if (!confirm('Archive this session? You can restore it later from Archived sessions.')) return;
    archiveSession(s.id, {
      onSuccess: () => showToast('Session archived.'),
      onError: (err: unknown) =>
        showToast(err instanceof Error ? err.message : 'Failed to archive', true),
    });
  };

  const handleDelete = () => {
    if (!confirm('Permanently delete this session? This action cannot be undone.')) return;
    deleteSession(s.id, {
      onSuccess: () => showToast('Session permanently deleted.'),
      onError: (err: unknown) =>
        showToast(err instanceof Error ? err.message : 'Failed to delete', true),
    });
  };

  const rowClass = clsx(styles.v6RailSession, isActive && styles.sessionCardOpenActive);
  const runtime = (s.total_runtime_hms || '00:00:00').trim() || '00:00:00';
  const evCount = Number(s.event_count);
  const metaLine = `${fmtDateOnly(s.episode_date ?? s.created_at_utc)} · ${Number.isFinite(evCount) ? evCount : 0} events`;

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
      <div
        className={clsx(styles.sessionCardLink, styles.sessionCardPanel)}
        data-start-offset={s.start_offset_frames || 0}
      >
        {isActive && <output className={styles.sessionCardActiveLabel}>ACTIVE SESSION</output>}
        <div className={styles.v6RailDeckRow}>
          <button
            type="button"
            className={styles.v6RailDeckTitle}
            onClick={(e) => {
              e.stopPropagation();
              if (!isActive) {
                onSelect();
                return;
              }
            }}
          >
            {s.title}
          </button>
          <div className={styles.v6RailDeckTrail}>
            <Popover
              open={menuOpen}
              onOpenChange={setMenuOpen}
              ariaLabel="Session options"
              trigger={
                <button
                  type="button"
                  className={styles.v6RailSessionMenu}
                  aria-label="Session options"
                  data-open={menuOpen || undefined}
                  onClick={(e) => e.stopPropagation()}
                >
                  ⋮
                </button>
              }
            >
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
            </Popover>
          </div>
        </div>
        <div className={styles.v6RailMetaRow}>
          <span className={styles.sessionCardMeta}>{metaLine}</span>
          <Tooltip content="Total runtime">
            <span className={clsx(styles.v6RailDeckRuntime, 'mono')}>{runtime}</span>
          </Tooltip>
        </div>
        {s.is_rolling && (
          <span className={styles.sessionRollingBadge}>
            ● Rolling - {formatTimecodeHMS(s.rolling_timecode)}
          </span>
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
    </div>
  );
}

function ArchivedSessionCard({ session: s }: { session: Session }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { mutate: restoreSession } = useRestoreSession();
  const { mutate: deleteSession } = useDeleteSession();

  const handleRestore = () => {
    if (!confirm('Restore this archived session?')) return;
    restoreSession(s.id, {
      onSuccess: () => showToast('Session restored.'),
      onError: (err: unknown) =>
        showToast(err instanceof Error ? err.message : 'Failed to restore', true),
    });
  };

  const handleDelete = () => {
    if (!confirm('Permanently delete this session? This action cannot be undone.')) return;
    deleteSession(s.id, {
      onSuccess: () => showToast('Session permanently deleted.'),
      onError: (err: unknown) =>
        showToast(err instanceof Error ? err.message : 'Failed to delete', true),
    });
  };

  const evCount = Number(s.event_count);
  const metaLine = `${fmtDateOnly(s.episode_date ?? s.created_at_utc)} · ${Number.isFinite(evCount) ? evCount : 0} events`;
  const runtime = (s.total_runtime_hms || '00:00:00').trim() || '00:00:00';

  return (
    <div
      className={styles.v6RailSession}
      data-session-id={s.id}
      data-menu-open={menuOpen || undefined}
    >
      <div className={clsx(styles.sessionCardLink, styles.sessionCardPanel)}>
        <div className={styles.v6RailDeckRow}>
          <span className={styles.v6RailDeckTitle}>{s.title}</span>
          <div className={styles.v6RailDeckTrail}>
            <Popover
              open={menuOpen}
              onOpenChange={setMenuOpen}
              ariaLabel="Session options"
              trigger={
                <button
                  type="button"
                  className={styles.v6RailSessionMenu}
                  aria-label="Session options"
                  data-open={menuOpen || undefined}
                  onClick={(e) => e.stopPropagation()}
                >
                  ⋮
                </button>
              }
            >
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
            </Popover>
          </div>
        </div>
        <div className={styles.v6RailMetaRow}>
          <span className={styles.sessionCardMeta}>{metaLine}</span>
          <Tooltip content="Total runtime">
            <span className={clsx(styles.v6RailDeckRuntime, 'mono')}>{runtime}</span>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}

interface Props {
  sessions: SessionsResponse | undefined;
  isLoading: boolean;
  activeSessionId: string;
  onSelectSession: (sid: string) => void;
  onCloseSession: () => void;
}

export function RecentSessionsList({
  sessions,
  isLoading,
  activeSessionId,
  onSelectSession,
  onCloseSession,
}: Props) {
  if (isLoading && !sessions) {
    return (
      <output
        className={clsx(styles.v6RailLoading, 'muted')}
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
      <p className={clsx(styles.v6RailEmpty, 'muted')} id="session-empty">
        No sessions yet. Create one to start logging.
      </p>
    );
  }

  return (
    <OverlayScrollbarsComponent
      element="div"
      id="session-list"
      className={styles.v6RailSessions}
      defer
      options={railOsOptions}
    >
      {active.map((s) => (
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

export function ArchivedSessionsList({ sessions }: { sessions: Session[] }) {
  return (
    <OverlayScrollbarsComponent
      element="div"
      id="archived-list"
      className={styles.v6RailSessions}
      defer
      options={railOsOptions}
    >
      {sessions.map((s) => (
        <ArchivedSessionCard key={s.id} session={s} />
      ))}
    </OverlayScrollbarsComponent>
  );
}
