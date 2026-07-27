import clsx from 'clsx';
import { memo, useState } from 'react';
import type { TranscriptWord } from '../../../api/types';
import { formatTimelineSec, sessionTimeToTimelineSec } from '../../../shared/utils/timelineSec';
import {
  FEED_CELL,
  FEED_CELL_TIME,
  FEED_INLINE_INPUT,
  FEED_INLINE_INPUT_MONO,
  FEED_ROW,
} from './FeedTable';
import { JumpToTimeButton } from './JumpToTimeButton';

interface EditState {
  session_time: string;
  speaker: string;
  word: string;
}

type UpdateFn = (
  wordId: string,
  patch: { session_time?: string; speaker?: string; word?: string },
) => void;

interface Props {
  row: TranscriptWord;
  speakerOffset: number;
  onUpdate: UpdateFn;
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

function formatSpeaker(speaker: string, offset: number): string {
  const n = Number.parseInt(speaker, 10);
  if (!Number.isNaN(n) && String(n) === speaker.trim()) {
    return `Person ${n + offset}`;
  }
  return speaker;
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
  fps,
  onJump,
  jumpUnavailable,
  jumpReasonId,
}: Props) {
  const [edit, setEdit] = useState<EditState | null>(null);

  function startEdit() {
    setEdit({ session_time: row.session_time, speaker: row.speaker, word: row.word });
  }

  // feed-row-seek, task 9.2: dirty check mirroring `EventLogRow.handleBlur`'s
  // comparison against the row's current value. `edit` is set by `onFocus`
  // and is therefore always truthy by blur time, so the early `if (!edit)
  // return;` above never actually gated a same-value blur — every blur wrote,
  // even an unchanged one. That matters now that a jump control shares the
  // row: clicking it while a field is focused blurs that field, and an
  // unconditional commit would fire an unchanged-value PATCH (invalidating
  // the query under a virtualized list) on every such jump. Compares against
  // `row[field]` (the last COMMITTED value), not a focus-time snapshot, same
  // as `EventLogRow`'s comparison against its current `event` prop.
  function commitField(field: keyof EditState, value: string) {
    if (!edit) return;
    setEdit((p) => (p ? { ...p, [field]: value } : p));
    if (value === row[field]) return;
    onUpdate(row.id, { [field]: value });
  }

  const vals = edit ?? { session_time: row.session_time, speaker: row.speaker, word: row.word };
  const jumpTarget = resolveTranscribeJump(row, fps);

  return (
    <tr className={FEED_ROW}>
      {/* Jump column (feed-row-seek, design D2/D7): its own leading cell, never
          inside the session-time cell — inline editing's contents/width/
          containing block are untouched by this. */}
      <td className={clsx(FEED_CELL, 'align-middle text-center')}>
        <JumpToTimeButton
          resolvedSec={jumpTarget?.sec ?? null}
          displayTime={jumpTarget?.display ?? ''}
          onJump={onJump}
          unavailable={jumpUnavailable}
          reasonId={jumpReasonId}
        />
      </td>
      <td className={clsx(FEED_CELL, 'align-middle', FEED_CELL_TIME)}>
        <input
          className={clsx(FEED_INLINE_INPUT, FEED_INLINE_INPUT_MONO, 'mono')}
          value={vals.session_time}
          onFocus={startEdit}
          onChange={(e) => setEdit((p) => (p ? { ...p, session_time: e.target.value } : p))}
          onBlur={(e) => commitField('session_time', e.target.value)}
        />
      </td>
      <td className={clsx(FEED_CELL, 'align-middle')}>
        <input
          className={FEED_INLINE_INPUT}
          value={formatSpeaker(vals.speaker, speakerOffset)}
          placeholder="Unknown"
          onFocus={startEdit}
          onChange={(e) => setEdit((p) => (p ? { ...p, speaker: e.target.value } : p))}
          onBlur={(e) => commitField('speaker', e.target.value)}
        />
      </td>
      <td className={clsx(FEED_CELL, 'align-middle')}>
        <input
          className={FEED_INLINE_INPUT}
          value={vals.word}
          onFocus={startEdit}
          onChange={(e) => setEdit((p) => (p ? { ...p, word: e.target.value } : p))}
          onBlur={(e) => commitField('word', e.target.value)}
        />
      </td>
    </tr>
  );
});
