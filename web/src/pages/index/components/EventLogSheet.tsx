import clsx from 'clsx';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { useDeleteEvent, useEvents, useUpdateEvent } from '../../../api/hooks/useEvents';
import { useSessionStatus } from '../../../api/hooks/useSessionStatus';
import { useShowCategories } from '../../../api/hooks/useShowCategories';
import type { LogEvent, SessionStatus } from '../../../api/types';
import { showToast } from '../../../shared/components/Toast';
import { useConfirm } from '../../../shared/ui/ConfirmDialog';
import { Popover, PopoverItem } from '../../../shared/ui/Popover';
import { eventTimelineSec } from '../../../shared/utils/audioClips';
import { isAutomaticLogEvent } from '../../../shared/utils/timecode';
import { useTimelineSeek } from '../hooks/useTimelineSeek';
import { clickSortReducer, type SortState as SharedSortState } from '../utils/sortReducer';
import { EventLogRow, type RowEditValues } from './EventLogRow';
import { FeedShell } from './FeedShell';
import { type ColumnDef, FEED_GLASS_BTN, FEED_GLASS_BTN_PRIMARY, FeedTable } from './FeedTable';
import { JUMP_COLUMN } from './JumpToTimeButton';

// --- feed-row-seek, task 6.2 (design D4) ---
//
// Resolves an event row's timeline second from `timecode_total_frames /
// frame_rate` DIRECTLY. Deliberately NOT `eventTimelineSec` (shared/utils/
// audioClips.ts) — that helper falls back to parsing the SMPTE `timecode`
// string as literal seconds when the frame count is absent, which (a)
// substitutes 0 for a missing/empty timecode (jumping the playhead to 0:00 —
// the exact defect this rule exists to eliminate) and (b) carries the
// non-integer-frame-rate drift `shared/utils/timelineSec.ts`'s converter was
// built to fix. An event with no frame count is UNRESOLVABLE: no control.
export function eventRowTimelineSec(event: LogEvent): number | null {
  const frames = event.timecode_total_frames;
  const fps = event.frame_rate;
  if (frames == null || fps == null) return null;
  if (!Number.isFinite(frames) || !Number.isFinite(fps) || fps <= 0) return null;
  const sec = frames / fps;
  // Whole-branch audit fix wave, finding M6: the spec requires a row's
  // resolved second to be finite AND non-negative (`sessionTimeToTimelineSec`
  // enforces the same `sec >= 0` floor). Not currently reachable — frames/fps
  // are both guarded finite and fps > 0 above — but a negative
  // `timecode_total_frames` isn't otherwise rejected, so this stays an
  // explicit invariant rather than an accident of the current data shape.
  if (!(sec >= 0)) return null;
  return sec;
}

// ---------------------------------------------------------------------------
// Sort
// ---------------------------------------------------------------------------

type SortKey = 'timecode' | 'utc' | 'category' | 'message';
type SortState = SharedSortState<SortKey>;
type SortAction = { type: 'CLICK'; key: SortKey } | { type: 'SET_VIEW_UTC'; utc: boolean };

function sortReducer(state: SortState, action: SortAction): SortState {
  switch (action.type) {
    case 'CLICK':
      return clickSortReducer(state, action.key);
    case 'SET_VIEW_UTC':
      if ((action.utc && state.key === 'timecode') || (!action.utc && state.key === 'utc')) {
        return { key: action.utc ? 'utc' : 'timecode', dir: 'asc' };
      }
      return state;
    default:
      return state;
  }
}

function doSortEvents(
  events: LogEvent[],
  sort: SortState,
  status: SessionStatus | null | undefined,
): LogEvent[] {
  const { key, dir } = sort;
  const d = dir === 'asc' ? 1 : -1;
  return [...events].sort((a, b) => {
    if (key === 'timecode') {
      /* Frame-aware seconds (audioClips space) so same-second events keep frame order. */
      const ta = eventTimelineSec(a, status);
      const tb = eventTimelineSec(b, status);
      if (ta !== tb) return (ta - tb) * d;
      const ua = new Date(a.wall_time_utc ?? 0).getTime();
      const ub = new Date(b.wall_time_utc ?? 0).getTime();
      return (ua - ub) * d;
    }
    let va: string | number = '';
    let vb: string | number = '';
    if (key === 'utc') {
      va = new Date(a.wall_time_utc ?? 0).getTime();
      vb = new Date(b.wall_time_utc ?? 0).getTime();
    } else if (key === 'category') {
      va = (a.category_label ?? a.category ?? '').toLowerCase();
      vb = (b.category_label ?? b.category ?? '').toLowerCase();
    } else {
      va = (a.message ?? '').toLowerCase();
      vb = (b.message ?? '').toLowerCase();
    }
    if (va < vb) return -d;
    if (va > vb) return d;
    return 0;
  });
}

// ---------------------------------------------------------------------------
// Dropdown sub-components
// ---------------------------------------------------------------------------

function TimeDisplayDropdown({
  viewUtc,
  disabled,
  onChange,
}: {
  viewUtc: boolean;
  disabled: boolean;
  onChange: (utc: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      ariaLabel="Time display"
      trigger={
        <button
          type="button"
          className={FEED_GLASS_BTN}
          aria-haspopup="listbox"
          disabled={disabled}
        >
          Time Display
        </button>
      }
    >
      <PopoverItem
        role="option"
        ariaSelected={!viewUtc}
        selected={!viewUtc}
        onClick={() => {
          onChange(false);
          setOpen(false);
        }}
      >
        Session Time
      </PopoverItem>
      <PopoverItem
        role="option"
        ariaSelected={viewUtc}
        selected={viewUtc}
        onClick={() => {
          onChange(true);
          setOpen(false);
        }}
      >
        World Clock
      </PopoverItem>
    </Popover>
  );
}

function FilterDropdown({
  showInternal,
  disabled,
  onChange,
}: {
  showInternal: boolean;
  disabled: boolean;
  onChange: (show: boolean) => void;
}) {
  return (
    <Popover
      ariaLabel="Filter events"
      trigger={
        <button type="button" className={FEED_GLASS_BTN} aria-haspopup="menu" disabled={disabled}>
          Filter
        </button>
      }
    >
      <PopoverItem
        role="menuitemcheckbox"
        ariaChecked={showInternal}
        selected={showInternal}
        onClick={() => onChange(!showInternal)}
      >
        Show internal events
      </PopoverItem>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface Props {
  sessionId: string;
}

export function EventLogSheet({ sessionId }: Props) {
  // --- Transport state ---
  const { data: status } = useSessionStatus(sessionId);
  const isRolling = Boolean(status?.is_rolling);
  const isRecording = Boolean(status?.audio_recording_lease_alive);
  const isLogSheetRolling = isRolling || isRecording;
  const canBatchEdit = !isLogSheetRolling;

  // --- Data ---
  const { data: categoriesData } = useShowCategories(sessionId);
  const [loadedLimit, setLoadedLimit] = useState(200);
  // Fetch-once + WS-driven invalidation (event.changed) — no polling.
  const { data, isPending } = useEvents(sessionId, { limit: loadedLimit });

  const categories = categoriesData?.categories ?? [];
  const events = data?.events ?? [];
  const total = data?.total ?? 0;
  const loggedTotal = data?.logged_event_count ?? 0;

  // --- View state ---
  const [sortState, dispatchSort] = useReducer(sortReducer, { key: 'timecode', dir: 'desc' });
  const [showInternal, setShowInternal] = useState(true);
  const [viewUtc, setViewUtc] = useState(false);

  // --- Batch edit ---
  const [batchEditMode, setBatchEditMode] = useState(false);
  const [batchEdits, setBatchEdits] = useState<Map<string, RowEditValues>>(new Map());
  const [pendingDeleteIds, setPendingDeleteIds] = useState<Set<string>>(new Set());
  const [batchSaving, setBatchSaving] = useState(false);

  // --- Mutations ---
  const updateEvent = useUpdateEvent(sessionId);
  const deleteEvent = useDeleteEvent(sessionId);

  // --- Feed row jump (feed-row-seek, design D5/D7): one hook call per feed,
  // its `unavailable`/`jump` handed to every row as a prop/stable callback.
  // `useTimelineSeek` reads the session-wide clip layout via
  // `AudioClipsContext` (whole-branch audit fix wave, finding C1) rather than
  // this feed's own (differently-limited) `events` — no `events` arg here. ---
  const { unavailable: jumpUnavailable, jump } = useTimelineSeek(sessionId, batchEditMode);
  const jumpReasonId = 'v5-event-feed-jump-reason';

  // Themed confirms (ui-refresh: replaces window.confirm browser chrome).
  const { confirm, confirmElement } = useConfirm();

  // --- Derived ---
  const inlineEdit = isLogSheetRolling && !batchEditMode;

  const filtered = showInternal
    ? events
    : events.filter((e) => e.category.toLowerCase() !== 'internal');
  const sorted = doSortEvents(filtered, sortState, status);

  // Mirror showInternal onto body so timeline markers can hide internal-cat markers via CSS.
  useEffect(() => {
    if (showInternal) {
      delete document.body.dataset.hideInternal;
    } else {
      document.body.dataset.hideInternal = '1';
    }
    return () => {
      delete document.body.dataset.hideInternal;
    };
  }, [showInternal]);

  // --- Pagination sentinel ---
  const sentinelRef = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || events.length >= total) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setLoadedLimit((prev) => prev + 200);
        }
      },
      { rootMargin: '120px', threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [events.length, total]);

  // --- Reset on session change ---
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is a prop, re-run when it changes
  useEffect(() => {
    setBatchEditMode(false);
    setBatchEdits(new Map());
    setPendingDeleteIds(new Set());
    setLoadedLimit(200);
  }, [sessionId]);

  // --- Handlers ---

  const handleEnterBatchEdit = () => {
    if (!canBatchEdit) {
      showToast('Stop timecode and recording to use batch edit.', true);
      return;
    }
    setBatchEdits(new Map());
    setPendingDeleteIds(new Set());
    setBatchEditMode(true);
  };

  const handleSaveBatch = async () => {
    setBatchSaving(true);
    try {
      for (const [eventId, edit] of batchEdits) {
        if (pendingDeleteIds.has(eventId)) continue;
        await updateEvent.mutateAsync({ eventId, body: edit });
      }
      for (const id of pendingDeleteIds) {
        await deleteEvent.mutateAsync(id);
      }
      setBatchEditMode(false);
      setBatchEdits(new Map());
      setPendingDeleteIds(new Set());
      showToast('Changes saved.');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Save failed.', true);
    } finally {
      setBatchSaving(false);
    }
  };

  const handleCancelBatch = useCallback(async () => {
    const anyDirty = pendingDeleteIds.size > 0 || batchEdits.size > 0;
    if (anyDirty) {
      const ok = await confirm({
        title: 'Discard changes',
        message: 'Discard all unsaved changes to the log sheet?',
        confirmLabel: 'Discard changes',
        cancelLabel: 'Keep editing',
        danger: true,
      });
      if (!ok) return;
    }
    setBatchEditMode(false);
    setBatchEdits(new Map());
    setPendingDeleteIds(new Set());
  }, [pendingDeleteIds, batchEdits, confirm]);

  // --- Escape to cancel batch ---
  useEffect(() => {
    if (!batchEditMode) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Radix's DismissableLayer (the discard-confirm dialog's own Escape
      // handling) calls preventDefault() on the Escape it consumes but does
      // NOT stopPropagation() — so with the discard dialog open, the same
      // Escape that just declined it would otherwise reach this listener too
      // and re-arm the dialog it was just dismissed from. Bail once something
      // upstream has already consumed the key.
      if (e.defaultPrevented) return;
      handleCancelBatch();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [batchEditMode, handleCancelBatch]);

  const handleInlineSave = useCallback(
    async (event: LogEvent, values: RowEditValues) => {
      try {
        await updateEvent.mutateAsync({ eventId: event.event_id, body: values });
        showToast('Updated.');
      } catch (e) {
        showToast(e instanceof Error ? e.message : 'Update failed.', true);
      }
    },
    [updateEvent],
  );

  const handleBatchChange = useCallback((eventId: string, values: RowEditValues) => {
    setBatchEdits((prev) => new Map(prev).set(eventId, values));
  }, []);

  const handleDelete = useCallback(
    async (eventId: string) => {
      if (batchEditMode) {
        setPendingDeleteIds((prev) => new Set([...prev, eventId]));
        return;
      }
      const ok = await confirm({
        title: 'Delete log row',
        message: 'Delete this log row? This cannot be undone.',
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      try {
        await deleteEvent.mutateAsync(eventId);
      } catch (e) {
        showToast(e instanceof Error ? e.message : 'Delete failed.', true);
      }
    },
    [batchEditMode, deleteEvent, confirm],
  );

  const handleUndelete = useCallback((eventId: string) => {
    setPendingDeleteIds((prev) => {
      const next = new Set(prev);
      next.delete(eventId);
      return next;
    });
  }, []);

  const handleSetViewUtc = (utc: boolean) => {
    setViewUtc(utc);
    dispatchSort({ type: 'SET_VIEW_UTC', utc });
  };

  // --- Column definitions (time column label/sortKey are dynamic) ---
  // Event Feed: the <th> keeps its legacy `.sheet th { text-align: center }` (FEED_TH sets
  // no text-align, so that legacy rule still applies). The visible label reads left because
  // the full-width sort button is `text-left` — but the <th>'s own centering still governs
  // auto-layout column widths, so we must NOT force `text-left` here (doing so reflows the
  // columns and narrows the table by ~3px). Transcribe/Topics DO pass `text-left` (no
  // `.sheet` context — their legacy `.feedTh` was left-aligned).
  // `!static` carries the extracted SessionWorkspace override `.v4-log-sheet .sheet th
  // { position: static }` — the Event Feed header is NOT sticky (unlike Transcribe/Topics).
  const eventColumns: ColumnDef[] = [
    // JUMP_COLUMN as shared across all three feeds (design D2), but its
    // `thClassName` is overridden here to `!static` — the Event Feed's other
    // headers all carry that override (its header row isn't sticky, unlike
    // Transcribe/Topics) and a sticky lone column among static siblings would
    // visibly desync on scroll. `key`/`label`/`ariaLabel` stay verbatim.
    { ...JUMP_COLUMN, thClassName: '!static w-8' },
    {
      key: 'time',
      label: viewUtc ? 'World Clock' : 'Session Time',
      sortKey: viewUtc ? 'utc' : 'timecode',
      thClassName: '!static w-[6.5rem]',
    },
    {
      key: 'category',
      label: 'Event',
      sortKey: 'category',
      thClassName: '!static w-32',
    },
    { key: 'message', label: 'Message', sortKey: 'message', thClassName: '!static min-w-48' },
  ];

  const countLabel = `${loggedTotal} Event${loggedTotal !== 1 ? 's' : ''}`;

  const toolbar = (
    <>
      {!batchEditMode && (
        <button
          type="button"
          className={FEED_GLASS_BTN}
          disabled={!canBatchEdit}
          title={
            canBatchEdit
              ? 'Edit multiple rows; changes apply when you click Save changes.'
              : 'Available when timecode is stopped and audio is not recording.'
          }
          onClick={handleEnterBatchEdit}
        >
          Edit
        </button>
      )}
      {batchEditMode && (
        // `.v5EventFeedToolbarBatch` — its `#v4-log-session` ancestor prefix was a pure
        // specificity hack; the layout applies to the span directly.
        <span className="inline-flex flex-wrap items-center gap-[0.35rem]">
          <button
            type="button"
            className={clsx(FEED_GLASS_BTN, FEED_GLASS_BTN_PRIMARY)}
            disabled={batchSaving}
            onClick={() => handleSaveBatch().catch(() => {})}
          >
            Save changes
          </button>
          <button
            type="button"
            className={FEED_GLASS_BTN}
            disabled={batchSaving}
            onClick={handleCancelBatch}
          >
            Cancel
          </button>
        </span>
      )}
      <TimeDisplayDropdown viewUtc={viewUtc} disabled={batchEditMode} onChange={handleSetViewUtc} />
      <FilterDropdown
        showInternal={showInternal}
        disabled={batchEditMode}
        onChange={setShowInternal}
      />
    </>
  );

  // `sheet sheet-dense` stay as retained literal chrome hooks (chrome.css `.sheet .mono`;
  // the SessionWorkspace `.v4-log-sheet .sheet th { position: static }` override is now
  // carried on the <th> below). `.logSheetBatchEdit` is dropped — batch-edit cell styling
  // moved onto EventLogRow via its `batchEdit`/`pendingDelete` props.
  const tableClassName = 'sheet sheet-dense';

  return (
    <FeedShell
      countLabel={countLabel}
      headerId="v5-event-feed-head"
      feedAriaLabel="Event feed"
      toolbar={toolbar}
      toolbarAriaLabel="Event feed tools"
      logBottomId="v4-log-bottom"
      sheetId="v4-log-sheet"
      after={
        <>
          {confirmElement}
          {/* `.v5FeedStateInputs` — the visually-hidden CSS-compat checkbox pair. The block
              matches `sr-only`; the inputs collapse to 0×0 (was the `#v4-log-session`-prefixed
              rules; that ancestor was a specificity hack). */}
          <div className="sr-only pointer-events-none" aria-hidden="true">
            <input
              type="checkbox"
              id="view-utc-log"
              className="absolute h-0 w-0 opacity-0"
              tabIndex={-1}
              readOnly
              checked={viewUtc}
            />
            <input
              type="checkbox"
              id="show-internal-log"
              className="absolute h-0 w-0 opacity-0"
              tabIndex={-1}
              readOnly
              checked={showInternal}
            />
          </div>
          {/* The ONE shared reason node every row's jump control references while
              unavailable (design D2 gate decision) — never one per row. Not
              aria-hidden: it must stay reachable via aria-describedby. */}
          {jumpUnavailable && (
            <span id={jumpReasonId} className="sr-only">
              Jump is unavailable while timecode is rolling, session status is loading, or batch
              edit is active.
            </span>
          )}
        </>
      }
    >
      <FeedTable
        columns={eventColumns}
        sortKey={sortState.key}
        sortDir={sortState.dir}
        onSort={(k) => dispatchSort({ type: 'CLICK', key: k as SortKey })}
        tableClassName={tableClassName}
        isEmpty={sorted.length === 0 && !isPending}
        emptyMessage={events.length === 0 ? '— No logged items yet.' : '— No rows visible.'}
        colgroup={
          <colgroup>
            <col className="col-jump" />
            <col className="col-timecode" />
            <col className="col-category" />
            <col className="col-message" />
          </colgroup>
        }
      >
        {sorted.map((ev) => (
          <EventLogRow
            key={ev.event_id}
            event={ev}
            categories={categories}
            inlineEdit={inlineEdit && !isAutomaticLogEvent(ev)}
            batchEdit={batchEditMode && !isAutomaticLogEvent(ev)}
            pendingDelete={pendingDeleteIds.has(ev.event_id)}
            viewUtc={viewUtc}
            batchValues={batchEdits.get(ev.event_id) ?? null}
            resolvedSec={eventRowTimelineSec(ev)}
            onJump={jump}
            jumpUnavailable={jumpUnavailable}
            jumpReasonId={jumpReasonId}
            onInlineSave={handleInlineSave}
            onBatchChange={handleBatchChange}
            onDelete={handleDelete}
            onUndelete={handleUndelete}
          />
        ))}
        {events.length < total && (
          // `.logSheetSentinel td` centering/padding + `.sheet .utc` mono styling.
          <tr ref={sentinelRef} className="[&>td]:text-center [&>td]:px-2 [&>td]:py-[0.55rem]">
            <td
              colSpan={4}
              className={clsx(
                'font-[family-name:var(--font-mono)] text-[0.8rem] text-muted whitespace-nowrap',
                'faint',
              )}
            />
          </tr>
        )}
      </FeedTable>
    </FeedShell>
  );
}
