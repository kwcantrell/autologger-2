import clsx from 'clsx';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { SessionTopic } from '../../../api/types';
import { TableCell, TableRow } from '../../../shared/components/ui/table';
import type { SaveOutcome } from '../../../shared/hooks/useVersionedSave';
import { sessionTimeToTimelineSec } from '../../../shared/utils/timelineSec';
import { type RowSeeds, useRowSeeds } from '../utils/rowHolds';
import {
  FEED_CELL,
  FEED_CELL_TEXT,
  FEED_CELL_TIME,
  FEED_INLINE_INPUT,
  FEED_INLINE_INPUT_NUM,
  FEED_INLINE_INPUT_TC,
    FEED_ROW,
  FEED_SUMMARY_TEXTAREA,
} from './FeedTable';
import { JumpToTimeButton } from './JumpToTimeButton';

/** A row's whole edit: every control's raw text. */
export interface TopicEditState {
  session_time: string;
  duration_sec: string;
  topic_level: string;
  summary: string;
}
type EditState = TopicEditState;

export const TOPIC_EDIT_FIELDS = [
  'session_time',
  'duration_sec',
  'topic_level',
  'summary',
] as const satisfies ReadonlyArray<keyof TopicEditState>;

export interface TopicPatch {
  session_time?: string;
  duration_sec?: number;
  topic_level?: number;
  summary?: string;
}

export type TopicSaveOutcome = SaveOutcome<SessionTopic, SessionTopic>;

/** Saves one field (session-edit-conflicts D9: `TopicsFeed` owns the versioned save).
 *  `yours` reads, when a conflict is prompted, every field whose text in this row's edit
 *  differs from its seed, so the prompt lists all the operator's text. Resolves the outcome,
 *  or `undefined` after a failure the feed has already reported. */
export type TopicUpdateFn = (
  topicId: string,
  patch: TopicPatch,
  yours: () => Partial<TopicEditState>,
) => undefined | Promise<TopicSaveOutcome | undefined>;

function editOf(t: SessionTopic): EditState {
  return {
    session_time: t.session_time,
    duration_sec: String(t.duration_sec),
    topic_level: String(t.topic_level),
    summary: t.summary,
  };
}

/** One control's text as the value a save would send (the numeric fields are coerced). */
function patchFor(field: keyof EditState, value: string): TopicPatch {
  if (field === 'duration_sec') return { duration_sec: Number(value) || 0 };
  if (field === 'topic_level') return { topic_level: Math.max(1, Number(value) || 1) };
  return { [field]: value };
}

/** The control's text means the same value as `t`'s field (so saving it would change nothing). */
function sameAs(field: keyof EditState, value: string, t: SessionTopic): boolean {
  return patchFor(field, value)[field] === t[field];
}

/** The edit with the fields that no longer diverge from `t` removed. */
function divergent(edit: Partial<EditState>, t: SessionTopic): Partial<EditState> {
  const next: Partial<EditState> = {};
  for (const f of TOPIC_EDIT_FIELDS) {
    const v = edit[f];
    if (v !== undefined && !sameAs(f, v, t)) next[f] = v;
  }
  return next;
}

const isEmpty = (e: Partial<EditState>) => TOPIC_EDIT_FIELDS.every((f) => e[f] === undefined);

interface Props {
  row: SessionTopic;
  /** `TopicsFeed`'s versioned save for one field. */
  onUpdate: TopicUpdateFn;
  /** `TopicsFeed`'s seeds (session-edit-conflicts D3): the server row each row's controls were
   *  filled from, which every save is based on and compared against, plus the holds that freeze
   *  a seed while its row has an edit. The feed always passes it; a row rendered on its own
   *  (component tests) keeps a store of its own, as a feed of one row. */
  seeds?: RowSeeds<SessionTopic>;
  /** The session's ACTUAL (non-rounded) frame rate, for the D3 converter —
   *  `null` while session status hasn't loaded yet. Passed as a prop (design
   *  D7): the row must not subscribe to session status itself. */
  fps: number | null;
  /** `TopicsFeed`'s `useTimelineSeek` `jump`, `useCallback`-stable and shared
   *  by every row in the feed (design D7). */
  onJump: (sec: number) => void;
  /** The feed-wide not-rolling/status-unloaded gate (design D5), shared by
   *  every row. */
  jumpUnavailable: boolean;
  /** id of the ONE reason node `TopicsFeed` renders while unavailable — every
   *  row passes the same id (design D2 gate decision). */
  jumpReasonId?: string;
  /** False when the session's transcript is wholly anchorless (spec "Topic
   *  jumps require an anchored transcript", task 8.3) — computed ONCE by
   *  `TopicsFeed` from the session's transcript words and passed down like
   *  `fps`, never re-derived per row. While false, no Topics row resolves a
   *  position regardless of whether its own `session_time` parses: a
   *  generation model with no `[HH:MM:SS]` prefixes to copy invents
   *  elapsed-from-zero times that parse perfectly, and under design D1 a
   *  jump now plays — so a parseable invented time is the exact silent-
   *  wrong-second hazard this guards against. */
  transcriptAnchored: boolean;
}

// --- feed-row-seek, task 8.2/8.3 (design D4, spec "Topic jumps require an
// anchored transcript") ---
//
// Resolves a Topics row's timeline second from its STORED (last committed)
// `session_time` via the D3 frame-arithmetic converter. Topics has the SAME
// edit-buffer situation as TranscribeRow — `vals.session_time` below is the
// UNCOMMITTED buffer while the field has focus — so this takes `row`
// directly, never `vals`/`edit`, mirroring `resolveTranscribeJump` in
// TranscribeRow.tsx.
//
// Unlike Transcript, `SessionTopic` carries no numeric fallback field on the
// wire — an unparseable or empty `session_time` is simply unresolvable, full
// stop; there is nothing else to fall back to.
//
// `transcriptAnchored` gates ahead of the parse: while the session's
// transcript is wholly anchorless, this returns `null` even for a row whose
// `session_time` parses cleanly, per the spec requirement above.
//
// Not exported (quality fix wave, FIX 4): single-caller module helper, and
// `export` had zero importers repo-wide — TopicsRow.test.tsx exercises it
// only indirectly, through the rendered component.
function topicsRowTimelineSec(
  row: SessionTopic,
  fps: number | null,
  transcriptAnchored: boolean,
): number | null {
  if (!transcriptAnchored) return null;
  if (fps == null) return null;
  return sessionTimeToTimelineSec(row.session_time, fps);
}

export function TopicsRow({
  row,
  onUpdate,
  seeds: feedSeeds,
  fps,
  onJump,
  jumpUnavailable,
  jumpReasonId,
  transcriptAnchored,
}: Props) {
  // The feed's seeds; a standalone row (unit tests) gets a store of its own.
  const rowSeeds = useRowSeeds<SessionTopic>(feedSeeds);
  const { store: seeds, holds } = rowSeeds;
  const trRef = useRef<HTMLTableRowElement>(null);

  // The row's CURRENT seed (session-edit-conflicts D3/D4), re-read whenever the
  // feed changes it. Untouched controls render from it while the row has an
  // edit, so a settled save (an Overwrite may bring in another person's sibling
  // fields) shows the saved row with no row-local step; a snapshot frozen into
  // row state would keep the old text and a later blur would send it.
  const subscribeSeed = useCallback(
    (onChange: () => void) => rowSeeds.subscribe(row.id, onChange),
    [rowSeeds, row.id],
  );
  const readSeed = useCallback(() => rowSeeds.store.get(row.id), [rowSeeds, row.id]);
  const seed = useSyncExternalStore(subscribeSeed, readSeed, readSeed);

  // Only the fields the operator changed (diverging from the seed); `null` = no
  // edit, the controls show the row.
  const [edit, setEdit] = useState<Partial<EditState> | null>(null);
  // The latest edit, for `onUpdate`'s `yours` (read when a conflict is prompted).
  const editRef = useRef(edit);
  useLayoutEffect(() => {
    editRef.current = edit;
  }, [edit]);

  // While this row has an edit its seed is frozen (session-edit-conflicts D3): the feed's
  // follow rule skips held rows.
  const editing = edit !== null;
  useEffect(() => (editing ? holds.hold(row.id) : undefined), [editing, holds, row.id]);

  function focusIn(target: EventTarget | null): boolean {
    return target instanceof Node && trRef.current?.contains(target) === true;
  }

  // D4 three-way rebase: when the seed moves (a settled save), a field still
  // meaning the old seed's value is not the operator's text and now shows the
  // new seed; a field already meaning the new seed's value is spent. An edit
  // left with nothing, with focus gone from the row, releases the row.
  const prevSeedRef = useRef(seed);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on a seed change only
  useEffect(() => {
    const prev = prevSeedRef.current;
    prevSeedRef.current = seed;
    if (!prev || !seed || prev === seed) return;
    const stay = typeof document !== 'undefined' && focusIn(document.activeElement);
    setEdit((p) => {
      if (!p) return p;
      const next = divergent(divergent(p, prev), seed);
      return isEmpty(next) && !stay ? null : next;
    });
  }, [seed]);

  /** The seed this row's controls were filled from. Every row the feed shows has one; a row
   *  without (rendered on its own) takes the row it shows. */
  function seedOf(): SessionTopic {
    const current = seeds.get(row.id);
    if (current) return current;
    seeds.set(row.id, row);
    return row;
  }

  function startEdit() {
    // Keep an edit already in progress: another field of this row typed a
    // moment ago, or text a dismissed conflict or a failed save kept
    // (session-edit-conflicts panel finding 2: re-snapshotting the row here
    // replaced the operator's text with theirs, and the next blur sent nothing).
    // Only a row with nothing to keep starts one, and the row it shows becomes
    // its seed (D3: editing starts, the seed freezes).
    if (edit !== null) return;
    seeds.set(row.id, row);
    setEdit({});
  }

  // feed-row-seek, task 9.2: dirty check (see the fuller rationale in
  // `TranscribeRow.commitField`, which had the identical defect). Compares
  // the COERCED patch value — the same value that would be sent — so a numeric
  // field re-typed identically (e.g. "30" blurred back to 30) is correctly
  // recognized as unchanged too.
  //
  // session-edit-conflicts D3: the comparison is against the SEED, not the live
  // `row`, so focusing and leaving without typing sends nothing even after a
  // refetch brought in another person's write; and D9: the save is the feed's
  // versioned save. Keep theirs ends the edit; dismissal or a failure keeps it,
  // so saving again asks again; a save rebases through the seed (above).
  function commitField(field: keyof EditState, value: string, focusNext: EventTarget | null) {
    if (!edit) return;
    const current = seedOf();
    const patch = patchFor(field, value);
    if (patch[field] === current[field]) {
      const leaving = !focusIn(focusNext);
      setEdit((p) => {
        if (!p) return p;
        const { [field]: _spent, ...rest } = p;
        return isEmpty(rest) && leaving ? null : rest;
      });
      return;
    }
    setEdit((p) => (p ? { ...p, [field]: value } : p));
    const committed = { ...edit, [field]: value };
    const pending = onUpdate(row.id, patch, () =>
      divergent(editRef.current ?? committed, seeds.get(row.id) ?? current),
    );
    if (!pending) return;
    void pending.then((outcome) => {
      // The feed made `current` the seed and the cache holds it: show it.
      if (outcome?.kind === 'keptTheirs') setEdit(null);
    });
  }

  // What the controls were filled from: the seed while editing, else the row.
  const base = editOf(edit ? (seed ?? row) : row);
  const vals: EditState = {
    session_time: edit?.session_time ?? base.session_time,
    duration_sec: edit?.duration_sec ?? base.duration_sec,
    topic_level: edit?.topic_level ?? base.topic_level,
    summary: edit?.summary ?? base.summary,
  };

  // Auto-grow the summary textarea so long topic summaries wrap and are fully
  // visible instead of being clipped inside a single-line field. Re-fits on
  // text change (initial load, typing, Auto Generate) and on column-width
  // change (panel/window resize) via a ResizeObserver.
  const summaryRef = useRef<HTMLTextAreaElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-fit when summary text changes; height is read from the DOM, not the closure
  useLayoutEffect(() => {
    const el = summaryRef.current;
    if (!el) return undefined;
    // Named `fitHeight`, not `fit`: biome's noFocusedTests rule reads a bare
    // `fit(...)` call as a focused test and its autofix rewrites it to `it()`.
    const fitHeight = () => {
      el.style.height = 'auto';
      // `scrollHeight` excludes the border, but `box-sizing: border-box` makes
      // the CSS height include it — add the border delta so the content isn't
      // clipped by the 1px transparent top/bottom border.
      const borderY = el.offsetHeight - el.clientHeight;
      el.style.height = `${el.scrollHeight + borderY}px`;
    };
    fitHeight();
    const ro = new ResizeObserver(fitHeight);
    ro.observe(el);
    return () => ro.disconnect();
  }, [vals.summary]);

  const resolvedSec = topicsRowTimelineSec(row, fps, transcriptAnchored);

  return (
    <TableRow ref={trRef} className={FEED_ROW}>
      {/* Jump column (feed-row-seek, design D2/D7): its own leading cell,
          never inside the session-time cell — inline editing's contents/
          width/containing block are untouched by this. */}
      <TableCell className={clsx(FEED_CELL, 'align-top text-center')}>
        <JumpToTimeButton
          resolvedSec={resolvedSec}
          displayTime={row.session_time}
          onJump={onJump}
          unavailable={jumpUnavailable}
          reasonId={jumpReasonId}
        />
      </TableCell>
      <TableCell className={clsx(FEED_CELL, 'align-top', FEED_CELL_TIME)}>
        <input
          className={clsx(FEED_INLINE_INPUT, FEED_INLINE_INPUT_TC)}
          value={vals.session_time}
          onFocus={startEdit}
          onChange={(e) => setEdit((p) => (p ? { ...p, session_time: e.target.value } : p))}
          onBlur={(e) => commitField('session_time', e.target.value, e.relatedTarget)}
        />
      </TableCell>
      <TableCell className={clsx(FEED_CELL, 'align-top', FEED_CELL_TEXT)}>
        <input
          className={clsx(FEED_INLINE_INPUT, FEED_INLINE_INPUT_NUM, 'max-w-20')}
          type="number"
          min={0}
          step={1}
          value={vals.duration_sec}
          onFocus={startEdit}
          onChange={(e) => setEdit((p) => (p ? { ...p, duration_sec: e.target.value } : p))}
          onBlur={(e) => commitField('duration_sec', e.target.value, e.relatedTarget)}
        />
      </TableCell>
      <TableCell className={clsx(FEED_CELL, 'align-top', FEED_CELL_TEXT)}>
        <input
          className={clsx(FEED_INLINE_INPUT, FEED_INLINE_INPUT_NUM, 'max-w-20')}
          type="number"
          min={1}
          max={10}
          step={1}
          value={vals.topic_level}
          onFocus={startEdit}
          onChange={(e) => setEdit((p) => (p ? { ...p, topic_level: e.target.value } : p))}
          onBlur={(e) => commitField('topic_level', e.target.value, e.relatedTarget)}
        />
      </TableCell>
      <TableCell className={clsx(FEED_CELL, 'align-top', FEED_CELL_TEXT)}>
        <textarea
          ref={summaryRef}
          className={clsx(FEED_INLINE_INPUT, FEED_SUMMARY_TEXTAREA)}
          rows={1}
          value={vals.summary}
          onFocus={startEdit}
          onChange={(e) => setEdit((p) => (p ? { ...p, summary: e.target.value } : p))}
          onBlur={(e) => commitField('summary', e.target.value, e.relatedTarget)}
        />
      </TableCell>
    </TableRow>
  );
}
