import clsx from 'clsx';
import { useLayoutEffect, useRef, useState } from 'react';
import { useUpdateTopic } from '../../../api/hooks/useTopics';
import type { SessionTopic } from '../../../api/types';
import {
  FEED_CELL,
  FEED_CELL_TIME,
  FEED_INLINE_INPUT,
  FEED_INLINE_INPUT_MONO,
  FEED_ROW,
  FEED_SUMMARY_TEXTAREA,
} from './FeedTable';

interface EditState {
  session_time: string;
  duration_sec: string;
  topic_level: string;
  summary: string;
}

interface Props {
  row: SessionTopic;
  sessionId: string;
}

export function TopicsRow({ row, sessionId }: Props) {
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

  function commitField(field: keyof EditState, value: string) {
    if (!edit) return;
    setEdit((p) => (p ? { ...p, [field]: value } : p));
    const patch: Record<string, string | number> = {};
    if (field === 'session_time') patch.session_time = value;
    if (field === 'duration_sec') patch.duration_sec = Number(value) || 0;
    if (field === 'topic_level') patch.topic_level = Math.max(1, Number(value) || 1);
    if (field === 'summary') patch.summary = value;
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

  return (
    <tr className={FEED_ROW}>
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
