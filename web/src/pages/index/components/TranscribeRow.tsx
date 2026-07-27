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

// --- feed-row-seek, task 7.2 (design D4) ---
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
export function transcribeRowTimelineSec(row: TranscriptWord, fps: number | null): number | null {
  if (fps != null) {
    const fromString = sessionTimeToTimelineSec(row.session_time, fps);
    if (fromString != null) return fromString;
  }
  return row.start_sec > 0 ? row.start_sec : null;
}

// --- feed-row-seek whole-branch audit fix wave, finding I2 ---
//
// `displayTime` becomes the jump button's `aria-label` ("Jump to <time>"),
// and the spec requires that name identify the time the row is DISPLAYING —
// but `row.session_time` is only what's displayed when it's the value that
// resolved the jump. When it's blank or unparseable and `transcribeRowTimelineSec`
// fell back to `start_sec` instead (design D4), the input cell shows an empty
// or garbage string while the button silently jumps to a real, different
// position — an accessible name identifying nothing, or the wrong thing.
// This mirrors `transcribeRowTimelineSec`'s own string-then-number branching
// so the displayed name always matches whichever source actually resolved
// `resolvedSec`: the stored string when it parsed, or `start_sec` formatted
// back through `formatTimelineSec` (the D3 converter's exact inverse) when
// it didn't.
function transcribeRowDisplayTime(row: TranscriptWord, fps: number | null): string {
  if (fps != null && sessionTimeToTimelineSec(row.session_time, fps) != null) {
    return row.session_time;
  }
  if (row.start_sec > 0) {
    if (fps != null) {
      const formatted = formatTimelineSec(row.start_sec, fps);
      if (formatted != null) return formatted;
    }
    // fps not yet loaded: no HH:MM:SS:FF rendering is possible yet, but the
    // button may still be in the tree (aria-disabled) — a plain-seconds
    // fallback beats an empty name.
    return `${row.start_sec.toFixed(1)}s`;
  }
  return row.session_time;
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
  const resolvedSec = transcribeRowTimelineSec(row, fps);

  return (
    <tr className={FEED_ROW}>
      {/* Jump column (feed-row-seek, design D2/D7): its own leading cell, never
          inside the session-time cell — inline editing's contents/width/
          containing block are untouched by this. */}
      <td className={clsx(FEED_CELL, 'align-middle text-center')}>
        <JumpToTimeButton
          resolvedSec={resolvedSec}
          displayTime={transcribeRowDisplayTime(row, fps)}
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
