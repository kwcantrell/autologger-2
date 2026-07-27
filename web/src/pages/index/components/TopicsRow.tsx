import clsx from 'clsx';
import { useLayoutEffect, useRef, useState } from 'react';
import { useUpdateTopic } from '../../../api/hooks/useTopics';
import type { SessionTopic } from '../../../api/types';
import { sessionTimeToTimelineSec } from '../../../shared/utils/timelineSec';
import {
  FEED_CELL,
  FEED_CELL_TIME,
  FEED_INLINE_INPUT,
  FEED_INLINE_INPUT_MONO,
  FEED_ROW,
  FEED_SUMMARY_TEXTAREA,
} from './FeedTable';
import { JumpToTimeButton } from './JumpToTimeButton';

interface EditState {
  session_time: string;
  duration_sec: string;
  topic_level: string;
  summary: string;
}

interface Props {
  row: SessionTopic;
  sessionId: string;
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
// directly, never `vals`/`edit`, mirroring `transcribeRowTimelineSec`.
//
// Unlike Transcript, `SessionTopic` carries no numeric fallback field on the
// wire — an unparseable or empty `session_time` is simply unresolvable, full
// stop; there is nothing else to fall back to.
//
// `transcriptAnchored` gates ahead of the parse: while the session's
// transcript is wholly anchorless, this returns `null` even for a row whose
// `session_time` parses cleanly, per the spec requirement above.
export function topicsRowTimelineSec(
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
  sessionId,
  fps,
  onJump,
  jumpUnavailable,
  jumpReasonId,
  transcriptAnchored,
}: Props) {
  const update = useUpdateTopic(sessionId);
  const [edit, setEdit] = useState<EditState | null>(null);

  function startEdit() {
    setEdit({
      session_time: row.session_time,
      duration_sec: String(row.duration_sec),
      topic_level: String(row.topic_level),
      summary: row.summary,
    });
  }

  // feed-row-seek, task 9.2: dirty check mirroring `EventLogRow.handleBlur`'s
  // comparison against the row's current value (see the fuller rationale in
  // `TranscribeRow.commitField`, which has the identical defect). Compares
  // the COERCED patch value — the same value that would be sent — against
  // `row[field]`, so a numeric field re-typed identically (e.g. "30" blurred
  // back to 30) is correctly recognized as unchanged too.
  function commitField(field: keyof EditState, value: string) {
    if (!edit) return;
    setEdit((p) => (p ? { ...p, [field]: value } : p));
    const patch: Record<string, string | number> = {};
    if (field === 'session_time') patch.session_time = value;
    if (field === 'duration_sec') patch.duration_sec = Number(value) || 0;
    if (field === 'topic_level') patch.topic_level = Math.max(1, Number(value) || 1);
    if (field === 'summary') patch.summary = value;
    if (patch[field] === row[field]) return;
    update.mutate({ topicId: row.id, patch });
  }

  const vals = edit ?? {
    session_time: row.session_time,
    duration_sec: String(row.duration_sec),
    topic_level: String(row.topic_level),
    summary: row.summary,
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
    const fit = () => {
      el.style.height = 'auto';
      // `scrollHeight` excludes the border, but `box-sizing: border-box` makes
      // the CSS height include it — add the border delta so the content isn't
      // clipped by the 1px transparent top/bottom border.
      const borderY = el.offsetHeight - el.clientHeight;
      el.style.height = `${el.scrollHeight + borderY}px`;
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [vals.summary]);

  const resolvedSec = topicsRowTimelineSec(row, fps, transcriptAnchored);

  return (
    <tr className={FEED_ROW}>
      {/* Jump column (feed-row-seek, design D2/D7): its own leading cell,
          never inside the session-time cell — inline editing's contents/
          width/containing block are untouched by this. */}
      <td className={clsx(FEED_CELL, 'align-top text-center')}>
        <JumpToTimeButton
          resolvedSec={resolvedSec}
          displayTime={row.session_time}
          onJump={onJump}
          unavailable={jumpUnavailable}
          reasonId={jumpReasonId}
        />
      </td>
      <td className={clsx(FEED_CELL, 'align-top', FEED_CELL_TIME)}>
        <input
          className={clsx(FEED_INLINE_INPUT, FEED_INLINE_INPUT_MONO, 'mono')}
          value={vals.session_time}
          onFocus={startEdit}
          onChange={(e) => setEdit((p) => (p ? { ...p, session_time: e.target.value } : p))}
          onBlur={(e) => commitField('session_time', e.target.value)}
        />
      </td>
      <td className={clsx(FEED_CELL, 'align-top')}>
        <input
          className={clsx(FEED_INLINE_INPUT, FEED_INLINE_INPUT_MONO, 'mono', 'max-w-20')}
          type="number"
          min={0}
          step={1}
          value={vals.duration_sec}
          onFocus={startEdit}
          onChange={(e) => setEdit((p) => (p ? { ...p, duration_sec: e.target.value } : p))}
          onBlur={(e) => commitField('duration_sec', e.target.value)}
        />
      </td>
      <td className={clsx(FEED_CELL, 'align-top')}>
        <input
          className={clsx(FEED_INLINE_INPUT, FEED_INLINE_INPUT_MONO, 'mono', 'max-w-20')}
          type="number"
          min={1}
          max={10}
          step={1}
          value={vals.topic_level}
          onFocus={startEdit}
          onChange={(e) => setEdit((p) => (p ? { ...p, topic_level: e.target.value } : p))}
          onBlur={(e) => commitField('topic_level', e.target.value)}
        />
      </td>
      <td className={clsx(FEED_CELL, 'align-top')}>
        <textarea
          ref={summaryRef}
          className={clsx(FEED_INLINE_INPUT, FEED_SUMMARY_TEXTAREA)}
          rows={1}
          value={vals.summary}
          onFocus={startEdit}
          onChange={(e) => setEdit((p) => (p ? { ...p, summary: e.target.value } : p))}
          onBlur={(e) => commitField('summary', e.target.value)}
        />
      </td>
    </tr>
  );
}
