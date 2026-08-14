import { defaultRangeExtractor, type Range, useVirtualizer } from '@tanstack/react-virtual';
import clsx from 'clsx';
import { memo, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  useDeleteEvent,
  useEvents,
  useGenerateEvents,
  useUpdateEvent,
  WORKSPACE_EVENTS_LIMIT,
} from '../../../api/hooks/useEvents';
import { useSessionStatus } from '../../../api/hooks/useSessionStatus';
import { useShowCategories } from '../../../api/hooks/useShowCategories';
import type {
  EventGenerateSelection,
  EventsGenerateBody,
  LogEvent,
  SessionStatus,
} from '../../../api/types';
import { showToast } from '../../../shared/components/Toast';
import { useConfirm } from '../../../shared/ui/ConfirmDialog';
import { Popover, PopoverItem } from '../../../shared/ui/Popover';
import { eventTimelineSec } from '../../../shared/utils/audioClips';
import { isAutomaticLogEvent } from '../../../shared/utils/timecode';
import { useGatedGenerate } from '../hooks/useGatedGenerate';
import { useTimelineSeek } from '../hooks/useTimelineSeek';
import { useDraftStore } from '../utils/draftStore';
import { REVEAL_EVENT } from '../utils/revealEventInFeed';
import { clickSortReducer, type SortState as SharedSortState } from '../utils/sortReducer';
import { EventGenerateCustomModal } from './EventGenerateCustomModal';
import {
  EventLogRow,
  INLINE_DRAFT_FIELDS,
  type InlineDraft,
  type InlineFocusRecord,
  type InlineFocusStore,
  type RowEditValues,
} from './EventLogRow';
import { FeedShell } from './FeedShell';
import { type ColumnDef, FEED_GLASS_BTN, FEED_GLASS_BTN_PRIMARY, FeedTable } from './FeedTable';
import {
  FeedToolbarCaption,
  IconCheck,
  IconClock,
  IconFilter,
  IconPencil,
  IconSparkles,
  IconX,
} from './feedToolbarCaption';
import { GenerateToolbar } from './GenerateToolbar';
import { JUMP_COLUMN } from './JumpToTimeButton';

// Approximate rendered height of a single EventLogRow, established by
// TranscribeFeed's documented method (feed-row-seek task 7.3): measured in real
// headless Chromium against the actual compiled Tailwind CSS — jsdom has no
// layout engine — on a standalone `sheet sheet-dense` <table> built from the
// exact class strings EventLogRow/JumpToTimeButton render, served over a local
// HTTP server (file:// breaks variant matching).
//
// Measured ≈30.44px, identical for view rows and inline/batch-edit rows. The
// row's tallest cell is the LEADING JUMP CELL, not the text cells: the `h-6`
// (24px) jump button + CELL_BASE's `py-[0.17rem]` (2×2.72px) + the 1px bottom
// border = 30.44px, while every text cell is 12.48px of `leading-none` text in
// the same box = 18.92px. (The jump control's `scale-[0.75]` wrapper compiles to
// a transform, which shrinks it visually but not in layout.) 31 covers the
// measurement with a small margin, and lands on TranscribeFeed's own constant —
// consistent, since both rows are dominated by the same 24px jump button.
//
// No `measureElement`: every cell is `whitespace-nowrap` (CELL_TC / CELL_CAT /
// CELL_ACTIONS on the message cell), so a long message clips rather than
// wrapping and heights do not vary with content — confirmed by measuring a
// 165-char message row (30.44px, unchanged). The one shape that does measure
// shorter (18.92px) is a row whose timecode is unresolvable, since
// `JumpToTimeButton` renders null there — but the server stamps every event with
// `timecode_total_frames` + `frame_rate` on insert (`eventStore.addEvent`), so
// that shape only exists for rows whose stored frame count is NULL. Over-
// estimating those is the safe direction (extra scroll extent, never a short
// window), so the constant stays, matching TranscribeFeed.
const ROW_HEIGHT = 31;

// How far outside the virtual window the row being inline-edited may be pinned
// (in rows) before the pin is dropped.
//
// TRADEOFF (the two-spacer padding-row idiom): this table holds its scroll
// extent with exactly two spacer <tr>s — one before the window, one after — so
// the rendered indexes MUST be contiguous. A non-contiguous range (the pinned
// row plus a window far away) has no representation here: the pinned <tr> would
// render immediately after the top spacer and shove the real window up by the
// height of the gap. So the pin CLAMPS INTO THE WINDOW instead: the range is
// extended contiguously to reach the pinned index.
//
// Cost: while an edit is pinned off-window, the gap rows render too. Bounded at
// 50 (~1550px of extra DOM at ROW_HEIGHT) because the case this exists for is
// small — under a descending sort, incoming events prepend and push the edited
// row down a few rows at a time — while the pathological case (the operator
// scrolls to the far end of a 5000-row feed with an edit open) would otherwise
// render the entire list and cost more than virtualization saves. Past the
// bound the row unmounts as it did before: its text still survives in
// `InlineDraftStore`, and `InlineFocusStore` restores focus + caret when it
// scrolls back into view.
const PINNED_ROW_MAX_EXTRA_ROWS = 50;

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
          <FeedToolbarCaption label="Time Display" icon={<IconClock />} />
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
  categories,
  hiddenCategoryIds,
  showInternal,
  disabled,
  onToggleCategory,
  onChange,
}: {
  categories: Array<{ id: string; label: string; color: string }>;
  hiddenCategoryIds: Set<string>;
  showInternal: boolean;
  disabled: boolean;
  onToggleCategory: (categoryId: string) => void;
  onChange: (show: boolean) => void;
}) {
  // Keep selected tint off; leave text color to the per-category style below.
  const checkedClass = 'aria-checked:!bg-transparent';
  const label = (checked: boolean, text: string, color?: string) => (
    <span
      className="flex items-center gap-2"
      style={color ? { color } : { color: 'var(--color-muted)' }}
    >
      <span aria-hidden="true" className="inline-flex h-3 w-3 shrink-0 items-center justify-center">
        {checked ? (
          <svg
            data-testid="filter-check"
            aria-hidden="true"
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            className="text-current"
          >
            <path
              d="M2.25 6.25L4.75 8.75L9.75 3.25"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : null}
      </span>
      {text}
    </span>
  );
  return (
    <Popover
      ariaLabel="Filter events"
      trigger={
        <button type="button" className={FEED_GLASS_BTN} aria-haspopup="menu" disabled={disabled}>
          <FeedToolbarCaption label="Filter" icon={<IconFilter />} />
        </button>
      }
    >
      {categories.map((category) => {
        const checked = !hiddenCategoryIds.has(category.id);
        return (
          <PopoverItem
            key={category.id}
            role="menuitemcheckbox"
            ariaChecked={checked}
            selected={false}
            className={checkedClass}
            onClick={() => onToggleCategory(category.id)}
          >
            {label(checked, category.label || category.id, category.color)}
          </PopoverItem>
        );
      })}
      <PopoverItem
        role="menuitemcheckbox"
        ariaChecked={showInternal}
        selected={false}
        className={checkedClass}
        onClick={() => onChange(!showInternal)}
      >
        {label(showInternal, 'Internal')}
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

// Render-isolation memo (the WorkspaceStatic/TranscribeRow idiom). INVARIANT: every
// prop passed here must stay referentially stable across a SessionWorkspace render —
// today that is `sessionId` alone, memoized into `feedPanels` — or the playback-tick
// (~60/s) render isolation this buys reopens.
export const EventLogSheet = memo(function EventLogSheet({ sessionId }: Props) {
  // --- Transport state ---
  const { data: status } = useSessionStatus(sessionId);
  const isRolling = Boolean(status?.is_rolling);
  const isRecording = Boolean(status?.audio_recording_lease_alive);
  const isLogSheetRolling = isRolling || isRecording;
  const canBatchEdit = !isLogSheetRolling;

  // --- Data ---
  const { data: categoriesData } = useShowCategories(sessionId);
  // `loadedLimit` is a RENDER window, not a fetch size. It used to be passed
  // straight to `useEvents`, where `limit` is part of the React Query key
  // (`useEvents.ts`'s key factory) — so this sheet fetched, under a second
  // key, rows the workspace query had already fetched. That is the exact
  // divergence `useEvents.ts`'s header forbids ("every full-session consumer
  // MUST use this same value to dedupe onto one cache entry — a divergent
  // limit is a second full fetch"), and every infinite-scroll step minted
  // another permanent cache entry (200, 400, 600 …). Fetching at the shared
  // WORKSPACE_EVENTS_LIMIT dedupes onto the one entry SessionWorkspace and
  // MarkerNav already populate; the window is applied locally below.
  const [loadedLimit, setLoadedLimit] = useState(200);
  // Fetch-once + WS-driven invalidation (event.changed) — no polling.
  const { data, isPending } = useEvents(sessionId, { limit: WORKSPACE_EVENTS_LIMIT });

  // Stable identities (the `MarkerNav.tsx:90` idiom) — both feed the `sorted`
  // useMemo below, whose deps include them, so a fresh array per render made
  // that memo unable to hit. Correctness fix; no performance claim is made.
  const categories = useMemo(() => categoriesData?.categories ?? [], [categoriesData]);
  const fetchedEvents = useMemo(() => data?.events ?? [], [data]);
  // The rendered window. Applied before filter/sort so everything downstream
  // — `sorted`, the pagination sentinel, the row list — sees exactly what it
  // saw when the server did the limiting: the oldest `loadedLimit` rows.
  // Returns `fetchedEvents` itself when no slicing is needed, so the identity
  // stays stable for the memo below.
  const events = useMemo(
    () =>
      fetchedEvents.length <= loadedLimit ? fetchedEvents : fetchedEvents.slice(0, loadedLimit),
    [fetchedEvents, loadedLimit],
  );
  const total = data?.total ?? 0;
  const loggedTotal = data?.logged_event_count ?? 0;

  // --- View state ---
  // Default direction is oldest-first across all three feeds (owner decision
  // 2026-08-06, PR#4 review) — the log reads top-down like a sheet.
  const [sortState, dispatchSort] = useReducer(sortReducer, { key: 'timecode', dir: 'asc' });
  const [showInternal, setShowInternal] = useState(true);
  const [hiddenCategoryIds, setHiddenCategoryIds] = useState<Set<string>>(new Set());
  const [viewUtc, setViewUtc] = useState(false);
  const [generateMenuOpen, setGenerateMenuOpen] = useState(false);
  const [customGenerateOpen, setCustomGenerateOpen] = useState(false);
  // Reactive scroll viewport (the TranscribeFeed idiom): OverlayScrollbars
  // publishes its viewport via FeedTable's `scrollRef` callback below. Storing
  // it in state (not a ref) re-renders so useVirtualizer re-attaches the instant
  // OS initializes, instead of waiting for an unrelated background re-render.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);

  // --- Batch edit ---
  const [batchEditMode, setBatchEditMode] = useState(false);
  const [batchEdits, setBatchEdits] = useState<Map<string, RowEditValues>>(new Map());
  const [pendingDeleteIds, setPendingDeleteIds] = useState<Set<string>>(new Set());
  const [batchSaving, setBatchSaving] = useState(false);

  // --- Inline edit drafts ---
  // The inline (rolling) counterpart of `batchEdits`: the in-progress text of
  // every inline edit, held HERE rather than in each row's DOM so it survives
  // the row unmounting when the virtual window moves past it. Kept in a ref,
  // not state, because nothing renders from it except the `defaultValue` of a
  // row that is mounting anyway — see `InlineDraftStore` for the full
  // rationale. Cleared per row once its save has round-tripped, and wholesale
  // when inline-edit mode ends or the session changes.
  const inlineDrafts = useDraftStore<InlineDraft>(INLINE_DRAFT_FIELDS);

  // --- Inline edit focus ---
  // Which row is being inline-edited right now, and where its caret sits. Same
  // ref-not-state rationale as the draft store (a caret move must not re-render
  // the feed), and read from two places: `rangeExtractor` below pins this row
  // into the virtual window, and a remounting row restores focus from it. See
  // `InlineFocusStore`.
  const inlineFocusRef = useRef<InlineFocusRecord | null>(null);
  const inlineFocus = useMemo<InlineFocusStore>(
    () => ({
      read: () => inlineFocusRef.current,
      // The clock is stamped HERE, not by callers: `recordedAt` bounds how long
      // a record may still pull focus back (see
      // `INLINE_FOCUS_RESTORE_MAX_AGE_MS`), and a caller that forgot to refresh
      // it would let a live edit look abandoned.
      record: (record) => {
        inlineFocusRef.current = { ...record, recordedAt: Date.now() };
      },
      clear: (eventId) => {
        if (inlineFocusRef.current?.eventId === eventId) inlineFocusRef.current = null;
      },
    }),
    [],
  );

  // --- Mutations ---
  const updateEvent = useUpdateEvent(sessionId);
  const deleteEvent = useDeleteEvent(sessionId);

  // --- AUTO GENERATE (auto-generate-event-logs design D9) ---
  // Same machinery as Transcribe/Topics: `useGatedGenerate` owns the 503
  // latch (per MOUNTED panel — this sheet is mounted-hidden and unkeyed, so
  // the latch deliberately persists across session switches and clears only
  // on reload) and the single inline non-503 error channel.
  const generateEvents = useGenerateEvents(sessionId);
  const { genError, genUnavailable, handleGenerate } = useGatedGenerate(generateEvents.mutate);
  // Run/outcome state is KEYED BY THE SESSION THE RUN STARTED FOR (spec
  // "Session switch mid-run does not leak state" — the AiV2Panel lesson for
  // this unkeyed panel): `genRunSessionId` records the starting session, and
  // pending/outcome/error render ONLY while it matches the current
  // `sessionId`. A mid-run switch leaves the request running (the mutation —
  // and the server-side run — always complete); the new session's control
  // reads idle, and returning to the starting session shows its outcome.
  // Deliberately NOT cleared by the session-change reset effect below.
  const [genRunSessionId, setGenRunSessionId] = useState<string | null>(null);
  const genRunIsThisSession = genRunSessionId === sessionId;
  const generatePending = generateEvents.isPending && genRunIsThisSession;
  const genOutcome =
    genRunIsThisSession && !generateEvents.isPending ? generateEvents.data : undefined;
  const handleAutoGenerate = (body?: EventsGenerateBody) => {
    setGenRunSessionId(sessionId);
    handleGenerate(body);
  };
  // No-instructions gate (spec "No instructions configured"): a DISTINCT
  // non-actionable state from the 503 latch — derived live from the
  // show-categories query, so configuring instructions in Settings re-arms
  // the control without a reload. Only an explicit `false` gates; while the
  // query is unresolved the control stays actionable (a click would surface
  // the server's own pre-spawn detail inline, never invent state).
  const noInstructions = categoriesData?.auto_instructions_present === false;
  // Generate/Regenerate label source (event-generate-hardening D7): the
  // server-computed `has_auto_generated` field of THIS sheet's own events
  // query response — never a row-scan — so it stays truthful for auto rows
  // beyond any client-side page or the server's list clamp. Undefined while
  // the response is unavailable (initial load) defaults to `false`, the
  // non-destructive Generate All label and click behavior.
  // The workspace-wide query below remains for the timeline-reveal
  // page-growth lookup (id→index), unrelated to this label.
  const { data: allEventsData } = useEvents(sessionId, { limit: WORKSPACE_EVENTS_LIMIT });
  const hasAutoGeneratedEvents = data?.has_auto_generated ?? false;

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

  // Leaving inline-edit mode (timecode stopped, recording ended, or batch edit
  // entered) unmounts every inline control — the closest thing this mode has to
  // a cancel, and the point where a draft stops being recoverable UI state.
  // Drop them all rather than let them resurface if rolling resumes.
  useEffect(() => {
    if (inlineEdit) return;
    inlineDrafts.clearAll();
    // Nothing is being inline-edited any more, so nothing stays pinned.
    inlineFocusRef.current = null;
  }, [inlineEdit, inlineDrafts]);

  // Abandonment: drop the focus record on the first pointerdown or focusin
  // OUTSIDE the edited row.
  //
  // Installed here rather than in the row because the case that matters is a
  // row that is no longer mounted: the operator types, wheel-scrolls the row
  // past the pin bound (wheel scrolling moves neither focus nor
  // `document.activeElement`, so nothing else in this feed can tell that the
  // edit was abandoned), and goes off to do something else. Left armed, the
  // record keeps up to `PINNED_ROW_MAX_EXTRA_ROWS` gap rows pinned, and grabs
  // the caret out of nowhere if the row ever scrolls back. A click or a focus
  // move anywhere else is the operator saying they are done with it.
  //
  // The DRAFT is deliberately untouched — abandoning the caret is not
  // abandoning the text, which stays recoverable until it is saved or
  // inline-edit mode ends.
  useEffect(() => {
    if (!inlineEdit) return;
    const onAbandon = (e: Event) => {
      const rec = inlineFocusRef.current;
      if (!rec) return;
      // This row's own category listbox is portaled outside the row, so a click
      // in it looks exactly like a click elsewhere. It isn't.
      if (rec.selectOpen) return;
      const target = e.target;
      if (target instanceof Element) {
        const row = target.closest('tr[data-event-id]');
        if (row?.getAttribute('data-event-id') === rec.eventId) return;
      }
      inlineFocusRef.current = null;
    };
    // Capture phase: a handler that stops propagation elsewhere must not be
    // able to hide the gesture from this.
    document.addEventListener('pointerdown', onAbandon, true);
    document.addEventListener('focusin', onAbandon, true);
    return () => {
      document.removeEventListener('pointerdown', onAbandon, true);
      document.removeEventListener('focusin', onAbandon, true);
    };
  }, [inlineEdit]);

  // Memoized (code-health-tail 4.8, perf only): the filter+sort re-ran on
  // every render (each keystroke in an inline edit re-sorts the whole feed);
  // keyed on its actual inputs, output unchanged.
  const sorted = useMemo(() => {
    // Only hide rows whose category is a known show button the operator
    // toggled off — orphan/unknown categories stay visible.
    const knownIds = new Set(categories.map((c) => c.id));
    const filtered = events.filter((event) => {
      if (!showInternal && event.category.toLowerCase() === 'internal') return false;
      if (knownIds.has(event.category) && hiddenCategoryIds.has(event.category)) return false;
      return true;
    });
    return doSortEvents(filtered, sortState, status);
  }, [events, hiddenCategoryIds, categories, showInternal, sortState, status]);

  // `rangeExtractor` runs inside the virtualizer's own measurement, outside the
  // React render it was created in, so it reads the current rendered order
  // through a ref (the `allEventsRef` idiom above) rather than a closure.
  const sortedRef = useRef(sorted);
  sortedRef.current = sorted;

  // Pin the row being inline-edited into the rendered window (@tanstack/
  // react-virtual's documented `rangeExtractor` seam, over its own
  // `defaultRangeExtractor`).
  //
  // Without it, inline editing and virtualization are in direct conflict: inline
  // edit is live exactly while timecode rolls, which is exactly when new events
  // are arriving — and under a descending sort each one prepends at index 0 and
  // shifts the edited row down. Past the overscan the focused <tr> unmounts,
  // focus falls to <body>, and the operator's next keystrokes go nowhere at all
  // (the deferred blur-to-save also bails on the now-null row ref, so nothing is
  // even saved).
  //
  // Referentially stable (`useCallback` with no deps) on purpose: the
  // virtualizer treats a new `rangeExtractor` identity as an options change, so
  // an inline arrow here would churn it on every render. Everything it varies
  // on is read from refs.
  const rangeExtractor = useCallback((range: Range) => {
    const base = defaultRangeExtractor(range);
    const pinnedId = inlineFocusRef.current?.eventId;
    if (!pinnedId || base.length === 0) return base;
    const pinned = sortedRef.current.findIndex((e) => e.event_id === pinnedId);
    if (pinned < 0) return base;
    const first = base[0];
    const last = base[base.length - 1];
    if (pinned >= first && pinned <= last) return base;
    // Contiguous clamp, bounded — see `PINNED_ROW_MAX_EXTRA_ROWS` for why the
    // pinned index is reached by extending the window rather than appended to
    // it, and what it costs.
    const extra = pinned < first ? first - pinned : pinned - last;
    if (extra > PINNED_ROW_MAX_EXTRA_ROWS) return base;
    const start = Math.min(first, pinned);
    const end = Math.max(last, pinned);
    const extended = new Array<number>(end - start + 1);
    for (let i = 0; i < extended.length; i++) extended[i] = start + i;
    return extended;
  }, []);

  // --- Virtualization (the TranscribeFeed precedent: padding rows inside the
  // real <table>, never a div grid). Only the visible window (+overscan) of
  // <tr>s is mounted; two spacer rows hold the scroll height on either side.
  // Inline-edit drafts survive that unmount: EventLogRow's inline controls are
  // uncontrolled, so their keystrokes are ALSO written through to the
  // `inlineDrafts` store below and read back as `defaultValue` when the row
  // remounts (see `InlineDraftStore`). Batch-edit mode never had the exposure —
  // its drafts have always lived in the parent-owned `batchEdits` Map.
  const virtualizer = useVirtualizer({
    count: sorted.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
    rangeExtractor,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const paddingTop = virtualItems.length > 0 ? virtualItems[0].start : 0;
  const paddingBottom =
    virtualItems.length > 0 ? totalSize - virtualItems[virtualItems.length - 1].end : 0;

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

  // --- Timeline marker reveal (revealEventInFeed) ---
  // A marker can target any event in the workspace-wide query, but this sheet
  // mounts only its oldest `loadedLimit` rows — without growing the window, a
  // reveal for a newer event finds no row and silently does nothing. Grow just
  // enough to cover the target (the workspace-wide page is already cached
  // above, so the wider fetch is a cache hit); SessionWorkspace's retry loop
  // then scrolls once the row renders. Reads the event list through a ref so
  // the listener registers once.
  //
  // Virtualization adds a second way the reveal can silently no-op: a row
  // outside the mounted window has no DOM node at all, so the workspace's
  // `scrollAndFlashEventRowWithRetry` poll for `tr[data-event-id=…]` would never
  // find it however long it retried. The target id is therefore parked in
  // `pendingRevealId` and consumed by the effect below, which scrolls the
  // virtualizer to the row's index so it mounts; the workspace retry loop then
  // finds and flashes it. Parked in STATE rather than a ref on purpose: growing
  // `loadedLimit` is a no-op when the target is already inside the window, so a
  // ref would leave nothing to schedule the consuming effect on the (common)
  // already-loaded-but-unmounted path. The effect clears it back to `null`, so
  // revealing the SAME row twice still re-triggers.
  const allEventsRef = useRef(allEventsData);
  allEventsRef.current = allEventsData;
  const [pendingRevealId, setPendingRevealId] = useState<string | null>(null);
  useEffect(() => {
    const onReveal = (ev: Event) => {
      const eventId = String(
        (ev as CustomEvent<{ eventId?: string }>).detail?.eventId ?? '',
      ).trim();
      if (!eventId) return;
      setPendingRevealId(eventId);
      const all = allEventsRef.current?.events;
      setLoadedLimit((prev) => {
        // Workspace-wide page not resolved yet — cover the whole marker range.
        if (!all) return Math.max(prev, WORKSPACE_EVENTS_LIMIT);
        const idx = all.findIndex((e) => e.event_id === eventId);
        // idx === -1 (not a markable event) and already-loaded rows both keep prev.
        if (idx < prev) return prev;
        return Math.min(Math.ceil((idx + 1) / 200) * 200, WORKSPACE_EVENTS_LIMIT);
      });
    };
    document.body.addEventListener(REVEAL_EVENT, onReveal);
    return () => document.body.removeEventListener(REVEAL_EVENT, onReveal);
  }, []);

  // Mount the revealed row. The index MUST be resolved against `sorted` — the
  // rendered order after filter + sort — not against the raw event list, or a
  // descending sort (or a hidden category) would scroll to the wrong row.
  // Re-runs when `sorted` changes, which covers the reveal that had to grow
  // `loadedLimit` first: the target simply isn't found on the first pass and the
  // request stays parked until the wider window renders it. A target that never
  // appears (filtered out) stays parked harmlessly until the next reveal
  // replaces it.
  useEffect(() => {
    if (!pendingRevealId) return;
    const index = sorted.findIndex((e) => e.event_id === pendingRevealId);
    if (index < 0) return;
    setPendingRevealId(null);
    virtualizer.scrollToIndex(index, { align: 'center' });
  }, [pendingRevealId, sorted, virtualizer]);

  // --- Pagination sentinel ---
  const sentinelRef = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    const sentinel = sentinelRef.current;
    // `events.length >= total` is the original stop condition (everything the
    // session has is on screen). The second clause is new and matters only for
    // a session larger than WORKSPACE_EVENTS_LIMIT: the window can no longer
    // grow past what was fetched, so without it the sentinel would keep
    // enlarging `loadedLimit` forever against a slice that cannot yield more
    // rows. Previously that same scroll re-fetched under an ever-larger key
    // instead — same dead end, but paid for over the network each time.
    if (!sentinel || events.length >= total || events.length >= fetchedEvents.length) return;
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
  }, [events.length, fetchedEvents.length, total]);

  // --- Reset on session change ---
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is a prop, re-run when it changes
  useEffect(() => {
    setBatchEditMode(false);
    setBatchEdits(new Map());
    setPendingDeleteIds(new Set());
    inlineDrafts.clearAll();
    inlineFocusRef.current = null;
    setLoadedLimit(200);
    setHiddenCategoryIds(new Set());
    setGenerateMenuOpen(false);
    setCustomGenerateOpen(false);
    setPendingRevealId(null);
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
      const eventId = event.event_id;
      // What this save is committing, in DRAFT space. The row writes every
      // keystroke through to the store before it builds `values`, so the draft
      // as of right now IS the submitted text — and comparing in draft space
      // rather than against `values` is the only comparison that can be exact:
      // `values` is trimmed (message/timecode) and ISO-normalized (`wall_time_utc`
      // vs the draft's raw `wall_text`, which for a half-typed date has no ISO
      // form at all), so a field-by-field match against it would report a
      // divergence for text the operator never touched again.
      const submitted: InlineDraft = { ...inlineDrafts.read(eventId) };
      try {
        await updateEvent.mutateAsync({ eventId, body: values });
        // Committed — and `mutateAsync` resolves only after the mutation's
        // `invalidateQueries` refetch settles, so the row this draft belonged to
        // is already backed by fresh server state. Dropping the draft here
        // (rather than when the save is ISSUED) means a failed save leaves the
        // operator's text recoverable on the next remount instead of silently
        // reverting.
        //
        // But drop ONLY what this save actually persisted. A save round trip is
        // long enough to type into (blur commits, the operator refocuses the row
        // and keeps typing) and those keystrokes are in the store — deleting the
        // row's entry wholesale threw them away, silently, the moment the
        // virtualizer next unmounted the row: it remounted showing the server
        // value. Re-read the store HERE, at resolution time (never a value
        // captured before the await — StrictMode and overlapping saves both
        // make a captured one stale), and keep any field that has moved on —
        // the shared draft-space comparison (`DraftStore#clearMatching`) that
        // EventLogRow's server-sync effect and its nothing-to-commit branch
        // also go through, so the three cannot disagree about what "this field
        // is spent" means.
        inlineDrafts.clearMatching(eventId, submitted);
        showToast('Updated.');
      } catch (e) {
        showToast(e instanceof Error ? e.message : 'Update failed.', true);
      }
    },
    [updateEvent, inlineDrafts],
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

  const handleToggleCategory = (categoryId: string) => {
    setHiddenCategoryIds((previous) => {
      const next = new Set(previous);
      if (next.has(categoryId)) next.delete(categoryId);
      else next.add(categoryId);
      return next;
    });
  };

  const handleCustomGenerate = (selection: EventGenerateSelection[]) => {
    setCustomGenerateOpen(false);
    handleAutoGenerate({ selection });
  };

  // Generate All is append-only and fires immediately; Regenerate All runs a
  // multi-minute CLI run and DELETES every prior auto-generated row (including
  // operator-edited ones) only once that run succeeds — a failed run leaves
  // them in place (event-generate-hardening D2/D6) — so it confirms through
  // the shared themed dialog (same useConfirm channel as row delete / batch
  // discard).
  const handleGenerateAllClick = async () => {
    setGenerateMenuOpen(false);
    if (!hasAutoGeneratedEvents) {
      handleAutoGenerate(undefined);
      return;
    }
    const ok = await confirm({
      title: 'Regenerate all auto events',
      message:
        'Prior auto-generated events will be replaced once this run succeeds — a failed run, or a run that finds nothing to log, leaves them in place. Any edits made to those events during the run will be lost when it succeeds. This cannot be undone.',
      confirmLabel: 'Delete and regenerate',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!ok) return;
    handleAutoGenerate({ regenerate: true });
  };

  // --- Column definitions (time column label/sortKey are dynamic) ---
  // Event Feed: the <th> keeps its legacy `.sheet th { text-align: center }` (FEED_TH sets
  // no text-align, so that legacy rule still applies). The visible label reads left because
  // the full-width sort button is `text-left` — but the <th>'s own centering still governs
  // auto-layout column widths, so we must NOT force `text-left` here (doing so reflows the
  // columns and narrows the table by ~3px). Transcribe/Topics DO pass `text-left` (no
  // `.sheet` context — their legacy `.feedTh` was left-aligned).
  // Headers use FeedTable's default sticky `FEED_TH` (same as Transcribe/Topics).
  const eventColumns: ColumnDef[] = [
    JUMP_COLUMN,
    {
      key: 'time',
      label: viewUtc ? 'World Clock' : 'Session Time',
      sortKey: viewUtc ? 'utc' : 'timecode',
      thClassName: 'w-[6.5rem]',
    },
    {
      key: 'category',
      label: 'Event',
      sortKey: 'category',
      thClassName: 'w-32',
    },
    { key: 'message', label: 'Message', sortKey: 'message', thClassName: 'min-w-48' },
  ];

  const countLabel = `${loggedTotal} Event${loggedTotal !== 1 ? 's' : ''}`;

  // Shared aria-disabled toolbar fragment (the a11y rationale — focusable
  // aria-disabled button + `aria-describedby` reason span — lives on
  // GenerateToolbar). Two distinct non-actionable reasons share the one
  // reason span: the 503 latch (integration missing; reload to re-check)
  // takes precedence over the live no-instructions gate (point at Settings).
  // Presentation differs by cause: the latch keeps the always-visible span
  // (a discovered outage), while the AT-REST no-instructions gate — the
  // default state of every session — renders it sr-only so the toolbar shows
  // no extra visible text (an always-visible span overflows the shared
  // FEED_TOOLBAR row; see GenerateToolbar's `reasonVisuallyHidden` doc).
  const genReasonId = 'v5-event-feed-gen-reason';
  const genLatchedReason = (
    <>
      Event generation isn&apos;t available on this server (no integration configured). Reload after
      configuring to enable it — manual logging still works.
    </>
  );
  const genNoInstructionsReason = (
    <>
      No event buttons carry auto-generate instructions yet. Add instructions in the Settings
      event-buttons table first.
    </>
  );
  const generateUnavailable = genUnavailable || noInstructions;
  const generateControl = (
    <Popover
      open={generateMenuOpen}
      onOpenChange={(open) => {
        if (!generateUnavailable && !generatePending) setGenerateMenuOpen(open);
      }}
      ariaLabel="Auto Generate menu"
      trigger={
        <button
          type="button"
          className={`${FEED_GLASS_BTN} aria-disabled:pointer-events-none aria-disabled:cursor-not-allowed aria-disabled:opacity-45`}
          disabled={generatePending}
          aria-disabled={generateUnavailable || undefined}
          aria-describedby={generateUnavailable ? genReasonId : undefined}
          aria-haspopup="menu"
          onClick={(event) => {
            if (generateUnavailable) event.preventDefault();
          }}
        >
          <FeedToolbarCaption
            label={generatePending ? 'Generating…' : 'Auto Generate'}
            icon={<IconSparkles />}
          />
        </button>
      }
    >
      <PopoverItem onClick={handleGenerateAllClick}>
        {hasAutoGeneratedEvents ? 'Regenerate All' : 'Generate All'}
      </PopoverItem>
      <PopoverItem
        onClick={() => {
          setGenerateMenuOpen(false);
          setCustomGenerateOpen(true);
        }}
      >
        Custom
      </PopoverItem>
    </Popover>
  );
  const toolbar = (
    <>
      <GenerateToolbar
        genError={genRunIsThisSession ? genError : null}
        genUnavailable={generateUnavailable}
        onGenerate={handleAutoGenerate}
        generatePending={generatePending}
        reasonId={genReasonId}
        reason={genUnavailable ? genLatchedReason : genNoInstructionsReason}
        reasonVisuallyHidden={!genUnavailable}
        generateControl={generateControl}
        outcome={
          genOutcome &&
          `Created ${genOutcome.created} event${genOutcome.created === 1 ? '' : 's'}` +
            `${genOutcome.cap_hit ? ' — per-run cap reached' : ''}.`
        }
      />
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
          <FeedToolbarCaption label="Edit" icon={<IconPencil />} />
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
            <FeedToolbarCaption label="Save changes" icon={<IconCheck />} />
          </button>
          <button
            type="button"
            className={FEED_GLASS_BTN}
            disabled={batchSaving}
            onClick={handleCancelBatch}
          >
            <FeedToolbarCaption label="Cancel" icon={<IconX />} />
          </button>
        </span>
      )}
      <TimeDisplayDropdown viewUtc={viewUtc} disabled={batchEditMode} onChange={handleSetViewUtc} />
      <FilterDropdown
        categories={categories}
        hiddenCategoryIds={hiddenCategoryIds}
        showInternal={showInternal}
        disabled={batchEditMode}
        onToggleCategory={handleToggleCategory}
        onChange={setShowInternal}
      />
    </>
  );

  // `sheet sheet-dense` stay as retained literal chrome hooks (chrome.css `.sheet .mono`).
  // `.logSheetBatchEdit` is dropped — batch-edit cell styling moved onto EventLogRow
  // via its `batchEdit`/`pendingDelete` props.
  const tableClassName = 'sheet sheet-dense';

  return (
    <FeedShell
      countLabel={countLabel}
      headerId="v5-event-feed-head"
      feedAriaLabel="Event feed"
      toolbar={toolbar}
      toolbarAriaLabel="Event feed tools"
      // max-w-full clamps the toolbar row so its flex-wrap engages — with the
      // AUTO GENERATE button added, the unclamped max-content row overflowed
      // 390px viewports and pushed FILTER off-viewport (see FeedShell's
      // `toolbarClassName` doc).
      toolbarClassName="max-w-full"
      logBottomId="v4-log-bottom"
      sheetId="v4-log-sheet"
      after={
        <>
          {confirmElement}
          {customGenerateOpen && (
            <EventGenerateCustomModal
              showId={status?.show_id ?? null}
              onSubmit={handleCustomGenerate}
              onClose={() => setCustomGenerateOpen(false)}
            />
          )}
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
        // Loading and empty are DISTINCT states (the TranscribeFeed/TopicsFeed idiom):
        // FeedTable consults `isEmpty` only when `!isLoading`, so while the events query
        // is pending the loading row holds the sheet's height instead of the empty
        // message painting first and being replaced when rows arrive.
        isLoading={isPending}
        isEmpty={sorted.length === 0}
        emptyMessage={
          events.length === 0 ? (
            genUnavailable ? (
              // Honest-capability empty state (delta spec, MODIFIED "Honest
              // capability gating"): cause + remedy + the manual alternative.
              <>
                No logged items yet. Event generation isn&apos;t available on this server — no
                integration is configured (reload after configuring). You can still log events
                manually with the event buttons.
              </>
            ) : (
              '— No logged items yet.'
            )
          ) : (
            'No events logged.'
          )
        }
        colgroup={
          <colgroup>
            <col className="col-jump" />
            <col className="col-timecode" />
            <col className="col-category" />
            <col className="col-message" />
          </colgroup>
        }
        scrollRef={setScrollEl}
      >
        {paddingTop > 0 && (
          <tr>
            <td
              colSpan={eventColumns.length}
              style={{ height: paddingTop, padding: 0, border: 'none' }}
            />
          </tr>
        )}
        {virtualItems.map((vRow) => {
          const ev = sorted[vRow.index];
          return (
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
              inlineDrafts={inlineDrafts}
              inlineFocus={inlineFocus}
              onInlineSave={handleInlineSave}
              onBatchChange={handleBatchChange}
              onDelete={handleDelete}
              onUndelete={handleUndelete}
            />
          );
        })}
        {paddingBottom > 0 && (
          <tr>
            <td
              colSpan={eventColumns.length}
              style={{ height: paddingBottom, padding: 0, border: 'none' }}
            />
          </tr>
        )}
        {/* Sentinel stays AFTER the bottom spacer so it sits at the true end of
            the scroll extent — the IntersectionObserver semantics (grow the
            window when the end comes into view) are unchanged by virtualization. */}
        {events.length < total && (
          // `.logSheetSentinel td` centering/padding + `.sheet .utc` mono styling.
          <tr ref={sentinelRef} className="[&>td]:text-center [&>td]:px-2 [&>td]:py-[0.55rem]">
            <td
              colSpan={eventColumns.length}
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
});
