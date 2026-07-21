// ai-v2-dashboards — topic_timeline catalog widget (task 4.3). `sessionTime`
// is a raw, format-unvalidated string (server D2a: `session_time` is
// `z.string().max(20)` with no numeric guarantee) — this widget deliberately
// renders topics as a chronological LIST rather than a proportionally
// positioned lane, because computing a bar/segment width from an unparsed
// string would be inventing numeric precision the stored data doesn't have
// (the same discipline aggregates.ts's own comment states for this field).
// An empty list is a real, measured empty session (never "unavailable" —
// aggregates.ts: topics carry no timing-degeneracy problem).

import type { TopicTimelineDataT } from './widgetTypes';

export function TopicTimelineWidget({ data }: { data: TopicTimelineDataT }) {
  if (data.entries.length === 0) {
    return (
      <p
        className="m-0 flex-1 text-[0.85rem] text-v5-muted"
        data-testid="aiv2-widget-topic_timeline"
      >
        No topics recorded for this session.
      </p>
    );
  }
  return (
    <ol
      className="m-0 flex flex-1 min-h-0 list-none flex-col gap-1.5 overflow-y-auto p-0"
      data-testid="aiv2-widget-topic_timeline"
    >
      {data.entries.map((entry) => (
        <li
          key={entry.topicId}
          className="flex items-baseline gap-2 rounded-[0.4rem] border border-[rgba(56,189,248,0.26)] bg-[rgba(56,189,248,0.08)] px-2 py-1"
        >
          {/* Raw, verbatim session_time string — never parsed/reformatted. */}
          <span className="shrink-0 whitespace-nowrap font-mono text-[0.72rem] text-v5-soft">
            {entry.sessionTime}
          </span>
          <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[0.8rem] text-v5-text">
            {entry.summary}
          </span>
        </li>
      ))}
    </ol>
  );
}
