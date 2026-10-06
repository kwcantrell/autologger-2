import clsx from 'clsx';
import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { TranscriptWord } from '../../../api/types';
import { TableCell, TableRow } from '../../../shared/components/ui/table';
import type { SaveOutcome } from '../../../shared/hooks/useVersionedSave';
import { formatTimelineSec, sessionTimeToTimelineSec } from '../../../shared/utils/timelineSec';
import type { DraftStore } from '../utils/draftStore';
import { type RowSeeds, useRowSeeds } from '../utils/rowHolds';
import { formatSpeaker, speakerFromInput } from '../utils/speakerOffset';
import {
  FEED_CELL,
  FEED_CELL_TIME,
  FEED_INLINE_INPUT,
  FEED_INLINE_INPUT_MONO,
  FEED_ROW,
} from './FeedTable';
import { JumpToTimeButton } from './JumpToTimeButton';

/** One row's in-progress edit, as raw input text — every field optional,
 *  because only the controls the operator actually touched are recorded.
 *
 *  This feed is virtualized too, so the edit CANNOT live only in this
 *  component: React fires no blur when the virtualizer unmounts a row, so a
 *  correction typed into a row that then scrolls past the overscan was
 *  committed by nothing and remembered by nothing — it silently reverted to the
 *  server text on the way back. `TranscribeFeed` owns the store (the same
 *  `utils/draftStore` primitive EventLogSheet's inline drafts use, not a second
 *  implementation of it); this row writes through on every keystroke and seeds
 *  itself from it when it mounts. */
export interface TranscribeDraft {
  session_time?: string;
  speaker?: string;
  word?: string;
}

/** Exhaustive field list for `DraftStore#clearMatching`, compiler-checked
 *  against the interface above. */
export const TRANSCRIBE_DRAFT_FIELDS = [
  'session_time',
  'speaker',
  'word',
] as const satisfies ReadonlyArray<keyof TranscribeDraft>;

export type TranscribeDraftStore = DraftStore<TranscribeDraft>;

type EditField = keyof TranscribeDraft;

/** The edit with the fields that no longer diverge from `seed` removed. */
function divergent(edit: TranscribeDraft, seed: TranscriptWord): TranscribeDraft {
  const next: TranscribeDraft = {};
  for (const f of TRANSCRIBE_DRAFT_FIELDS) {
    const v = edit[f];
    if (v !== undefined && v !== seed[f]) next[f] = v;
  }
  return next;
}

const isEmpty = (d: TranscribeDraft) => TRANSCRIBE_DRAFT_FIELDS.every((f) => d[f] === undefined);

export type WordSaveOutcome = SaveOutcome<TranscriptWord, TranscriptWord>;

/** Saves one field. `TranscribeFeed` resolves the outcome of its versioned save (`undefined`
 *  after a failure it has already reported). The row needs no step of its own on the outcome:
 *  the feed rebases the seed and the draft, and the row renders from both. */
type UpdateFn = (
  wordId: string,
  patch: { session_time?: string; speaker?: string; word?: string },
) => undefined | Promise<WordSaveOutcome | undefined>;

interface Props {
  row: TranscriptWord;
  speakerOffset: number;
  onUpdate: UpdateFn;
  /** `TranscribeFeed`'s draft store — one identity for the whole feed, stable
   *  for its lifetime (see `TranscribeDraft`). */
  drafts: TranscribeDraftStore;
  /** `TranscribeFeed`'s seeds (session-edit-conflicts D3): the server row each row's controls
   *  were filled from, which every save is based on and compared against, plus the holds that
   *  freeze a seed while its row has an edit. The feed always passes it; a row rendered on its
   *  own (component tests) keeps a store of its own, as a feed of one row. */
  seeds?: RowSeeds<TranscriptWord>;
  /** The session's ACTUAL (non-rounded) frame rate, for the D3 converter — `null`
   *  while session status hasn't loaded yet. Passed as a prop (design D7): the
   *  row must not subscribe to session status itself. */
  fps: number | null;
  /** `TranscribeFeed`'s `useTimelineSeek` `jump`, `useCallback`-stable and
   *  shared by every row in the feed (design D7). */
  onJump: (sec: number) => void;
  /** The feed-wide not-rolling/status-unloaded gate (design D5), shared by every row. */
  jumpUnavailable: boolean;
  /** id of the ONE reason node `TranscribeFeed` renders while unavailable — every
   *  row passes the same id (design D2 gate decision). */
  jumpReasonId?: string;
}

// --- feed-row-seek, task 7.2 (design D4); collapsed into one resolver by the
// quality fix wave (FIX 1) ---
//
// `transcribeRowTimelineSec` and a same-shaped `transcribeRowDisplayTime`
// used to be two functions maintaining the SAME branch structure by
// convention only — each independently parsed `row.session_time` via
// `sessionTimeToTimelineSec`, so a future edit to one branch (e.g. the
// `start_sec > 0` sentinel) could drift from the other without either test
// suite catching it, silently reintroducing the exact "display names one
// position, button jumps to another" defect finding I2 fixed. One resolver
// returning both facts makes display-matches-resolution true by
// construction: there is only one branch structure, and only one place a
// future edit could touch.
//
// Resolves a transcript row's timeline second from its STORED (last
// committed) `session_time` when it parses, falling back to `start_sec` only
// when the string does NOT parse — the reverse of the intuitive rule.
// `insertTranscriptWord` omits `start_sec` (column default `0.0`), so a
// hand-inserted row has a real typed `session_time` and `start_sec === 0`;
// using the number there would jump to 0:00. `updateTranscriptWord` patches
// only `session_time`/`speaker`/`word`, so editing the displayed timecode
// NEVER recomputes `start_sec`; using the number there would jump to the
// stale pre-edit position, silently and permanently.
//
// `start_sec === 0` doubles as the anchorless sentinel (ai-v2-dashboards'
// degenerate-timing discipline) — a word truly positioned at second zero is
// indistinguishable from "no timing data" on the wire, so `0` never counts as
// a resolvable fallback. Takes `row` directly (never the `edit`/`vals`
// buffer) so a row mid-edit still resolves to its last committed position.
//
// `display` is what becomes the jump button's `aria-label` ("Jump to
// <time>") — the stored string when it resolved the jump, or `start_sec`
// formatted back through `formatTimelineSec` (the D3 converter's exact
// inverse) when the string didn't parse and the number did. Single-caller
// module helper — not exported (FIX 4: it had zero importers repo-wide as
// `transcribeRowTimelineSec`).
function resolveTranscribeJump(
  row: TranscriptWord,
  fps: number | null,
): { sec: number; display: string } | null {
  if (fps != null) {
    const fromString = sessionTimeToTimelineSec(row.session_time, fps);
    if (fromString != null) return { sec: fromString, display: row.session_time };
  }
  if (row.start_sec > 0) {
    // fps not yet loaded: no HH:MM:SS:FF rendering is possible yet, but the
    // button may still be in the tree (aria-disabled) — a plain-seconds
    // fallback beats an empty name.
    const display =
      (fps != null && formatTimelineSec(row.start_sec, fps)) || `${row.start_sec.toFixed(1)}s`;
    return { sec: row.start_sec, display };
  }
  return null;
}

export const TranscribeRow = memo(function TranscribeRow({
  row,
  speakerOffset,
  onUpdate,
  drafts,
  seeds: feedSeeds,
  fps,
  onJump,
  jumpUnavailable,
  jumpReasonId,
}: Props) {
  const ownSeeds = useRowSeeds<TranscriptWord>();
  const rowSeeds = feedSeeds ?? ownSeeds;
  const { store: seeds, holds } = rowSeeds;
  const trRef = useRef<HTMLTableRowElement>(null);

  // The row's CURRENT seed (session-edit-conflicts D3/D4), re-read whenever the
  // feed changes it. Untouched controls render from it while the row has an
  // edit, so every mounted copy, including one the virtualizer rebuilt while a
  // save was in flight, shows the saved row once the feed rebases the seed. A
  // snapshot of the seed frozen into row state would keep the old text, and a
  // later blur would send it against the newer base: a silent revert.
  const subscribeSeed = useCallback(
    (onChange: () => void) => rowSeeds.subscribe(row.id, onChange),
    [rowSeeds, row.id],
  );
  const readSeed = useCallback(() => rowSeeds.store.get(row.id), [rowSeeds, row.id]);
  const seed = useSyncExternalStore(subscribeSeed, readSeed, readSeed);

  // Only the fields the operator changed (diverging from the seed); `null` = no
  // edit, the controls show the row. Seeded from the feed-owned draft store, so
  // a row remounting after the virtualizer dropped it comes back holding what
  // was typed into it rather than the server text.
  const [edit, setEdit] = useState<TranscribeDraft | null>(() => drafts.read(row.id) ?? null);

  // While this row has an edit its seed is frozen (session-edit-conflicts D3): the feed's
  // follow rule skips held rows.
  const editing = edit !== null;
  useEffect(() => (editing ? holds.hold(row.id) : undefined), [editing, holds, row.id]);

  function focusIn(target: EventTarget | null): boolean {
    return target instanceof Node && trRef.current?.contains(target) === true;
  }

  // D4 three-way rebase, in every mounted copy: when the seed moves (a settled
  // save), a field still reading as the old seed is not the operator's text and
  // now shows the new seed; a field already reading as the new seed is spent.
  // An edit left with nothing, no draft and no focus releases the row.
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
      return isEmpty(next) && !stay && drafts.read(row.id) === undefined ? null : next;
    });
  }, [seed]);

  /** The seed this row's controls were filled from. Every row the feed shows has one; a row
   *  without (rendered on its own) takes the row it shows. */
  function seedOf(): TranscriptWord {
    const current = seeds.get(row.id);
    if (current) return current;
    seeds.set(row.id, row);
    return row;
  }

  function startEdit() {
    // Preserve an edit already in progress (a restored draft, another field of
    // this row typed a moment ago, or text a dismissed conflict kept). Only a
    // row with nothing to preserve starts one, and the row it shows becomes its
    // seed (D3: editing starts, the seed freezes).
    if (edit !== null) return;
    seeds.set(row.id, row);
    setEdit({});
  }

  // --- Value-space invariant ---
  //
  // EVERY layer below holds RAW (storage-space) text — `row`, `edit`, `vals`,
  // the feed-owned draft store, the `commitField` dirty check, and the PATCH
  // body. The ONLY display-space string in this component is the `value=` of
  // the speaker `<input>`, produced by `formatSpeaker` at the JSX site and
  // converted straight back by `speakerFromInput` in that same element's
  // `onChange`/`onBlur`. The conversion pair lives ON the element, not inside
  // `changeField`/`commitField`, so the two directions are visibly adjacent and
  // the field-generic handlers stay single-space.
  //
  // The inbound direction is `speakerFromInput`, not a bare `parseSpeaker`,
  // because the inverse is only correct for text the operator actually typed:
  // it pins the text the control was filled from (`speakerPin`: the seed's
  // speaker while editing, else `row.speaker`) whenever the input still reads
  // exactly as that value renders, so an untouched focus+blur is a no-op even on a row whose stored
  // label happens to LOOK like a generated one (the literal `"Person 2"`). See
  // `speakerFromInput`'s doc comment for the full invariant, including what now
  // happens to rows the old bug already corrupted (nothing, until edited).
  //
  // Raw is the right side of the boundary to store on (rather than seeding
  // drafts in display space) because two other things already compare against
  // raw: `commitField`'s same-value guard reads the seed's field, and
  // `TranscribeFeed.handleUpdate` reuses the PATCH it sent as the draft-space
  // reference for `drafts.clearMatching`. Storing display here would silently
  // break both — the guard would never fire (`'Person 1' !== '0'`), so a bare
  // focus+blur with no typing PATCHed the display string over the numeric
  // diarization id, permanently, and that row's label then stopped tracking
  // `speakerOffset`. Remount seeding still renders correctly because `vals`
  // flows through `formatSpeaker` on the way to the input like everything else.
  //
  // `session_time` and `word` have no display/raw distinction: identity both
  // ways, so they pass through unconverted.

  /** Write-through: local state renders the (controlled) input, the store is
   *  what survives this row's next unmount. Takes RAW text (see the invariant
   *  above). */
  function changeField(field: EditField, value: string) {
    if (edit === null) seeds.set(row.id, row);
    setEdit((prev) => ({ ...(prev ?? {}), [field]: value }));
    drafts.write(row.id, { [field]: value });
  }

  // feed-row-seek, task 9.2: dirty check mirroring `EventLogRow.handleBlur`'s
  // comparison against the row's current value. `edit` is set by `onFocus`
  // and is therefore always truthy by blur time, so the early `if (!edit)
  // return;` above never actually gated a same-value blur — every blur wrote,
  // even an unchanged one. That matters now that a jump control shares the
  // row: clicking it while a field is focused blurs that field, and an
  // unconditional commit would fire an unchanged-value PATCH (invalidating
  // the query under a virtualized list) on every such jump. Takes RAW text —
  // `value === seed[field]` only means "unchanged" when both sides are in
  // storage space (see the invariant above).
  //
  // session-edit-conflicts D3: the comparison is against the SEED, not the live
  // `row`. While this row has an edit its controls show the seed's text, and a
  // refetch may already have moved `row` to another person's write; comparing
  // against `row` made an untyped focus+blur look like an edit and silently
  // sent the old text back over theirs.
  function commitField(field: EditField, value: string, focusNext: EventTarget | null) {
    if (!edit) return;
    const current = seedOf();
    if (value === current[field]) {
      // Nothing to commit for this field: its text is already exactly what the
      // controls were filled from, so its draft entry is spent. This clear
      // covers THIS field only — a sibling field's uncommitted text is outside
      // what the blur speaks for and stays alive. With nothing left, no draft
      // and focus gone from the row, the edit ends.
      drafts.clearMatching(row.id, { [field]: value }, [field]);
      const leaving = !focusIn(focusNext);
      setEdit((p) => {
        if (!p) return p;
        const { [field]: _spent, ...rest } = p;
        return isEmpty(rest) && leaving && drafts.read(row.id) === undefined ? null : rest;
      });
      return;
    }
    setEdit((p) => (p ? { ...p, [field]: value } : p));
    onUpdate(row.id, { [field]: value });
  }

  // What the controls were filled from: the seed while editing, else the row.
  const base = edit ? (seed ?? row) : row;

  // The speaker control's pinned committed identity (see `speakerFromInput`):
  // the text the control was filled from.
  function speakerPin(): string {
    return base.speaker;
  }

  // `??` per field: an edit carries only the fields the operator changed, and
  // an empty string is a real edited value.
  const vals = {
    session_time: edit?.session_time ?? base.session_time,
    speaker: edit?.speaker ?? base.speaker,
    word: edit?.word ?? base.word,
  };
  const jumpTarget = resolveTranscribeJump(row, fps);

  return (
    <TableRow ref={trRef} className={FEED_ROW}>
      {/* Jump column (feed-row-seek, design D2/D7): its own leading cell, never
          inside the session-time cell — inline editing's contents/width/
          containing block are untouched by this. */}
      <TableCell className={clsx(FEED_CELL, 'align-middle text-center')}>
        <JumpToTimeButton
          resolvedSec={jumpTarget?.sec ?? null}
          displayTime={jumpTarget?.display ?? ''}
          onJump={onJump}
          unavailable={jumpUnavailable}
          reasonId={jumpReasonId}
        />
      </TableCell>
      <TableCell className={clsx(FEED_CELL, 'align-middle', FEED_CELL_TIME)}>
        <input
          className={clsx(FEED_INLINE_INPUT, FEED_INLINE_INPUT_MONO, 'mono')}
          value={vals.session_time}
          onFocus={startEdit}
          onChange={(e) => changeField('session_time', e.target.value)}
          onBlur={(e) => commitField('session_time', e.target.value, e.relatedTarget)}
        />
      </TableCell>
      <TableCell className={clsx(FEED_CELL, 'align-middle')}>
        {/* The one display-space control in this row: `formatSpeaker` out,
            `speakerFromInput` back in on BOTH edges, so nothing downstream of
            these handlers ever sees a "Person N" label (see the value-space
            invariant above). Both edges pass `speakerPin()` as the pinned
            identity, so text the operator never changed converts to
            nothing. */}
        <input
          className={FEED_INLINE_INPUT}
          value={formatSpeaker(vals.speaker, speakerOffset)}
          placeholder="Unknown"
          onFocus={startEdit}
          onChange={(e) =>
            changeField('speaker', speakerFromInput(e.target.value, speakerPin(), speakerOffset))
          }
          onBlur={(e) =>
            commitField(
              'speaker',
              speakerFromInput(e.target.value, speakerPin(), speakerOffset),
              e.relatedTarget,
            )
          }
        />
      </TableCell>
      <TableCell className={clsx(FEED_CELL, 'align-middle')}>
        <input
          className={FEED_INLINE_INPUT}
          value={vals.word}
          onFocus={startEdit}
          onChange={(e) => changeField('word', e.target.value)}
          onBlur={(e) => commitField('word', e.target.value, e.relatedTarget)}
        />
      </TableCell>
    </TableRow>
  );
});
