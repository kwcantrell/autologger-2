import { useMemo, useReducer, useState } from 'react';
import { ApiError } from '../../../api/client';
import { useGenerateTopics, useInsertTopic, useTopics } from '../../../api/hooks/useTopics';
import { clickSortReducer } from '../utils/sortReducer';
import { FeedShell } from './FeedShell';
import { type ColumnDef, FEED_GLASS_BTN, FeedTable } from './FeedTable';
import { TopicsRow } from './TopicsRow';

type SortKey = 'session_time' | 'duration_sec' | 'topic_level' | 'summary';
const sortReducer = clickSortReducer<SortKey>;

const COLUMNS: ColumnDef[] = [
  {
    key: 'session_time',
    label: 'Session Time',
    sortKey: 'session_time',
    thClassName: 'text-left w-[6.5rem]',
  },
  {
    key: 'duration_sec',
    label: 'Duration (s)',
    sortKey: 'duration_sec',
    thClassName: 'text-left w-24',
  },
  { key: 'topic_level', label: 'Level', sortKey: 'topic_level', thClassName: 'text-left w-16' },
  { key: 'summary', label: 'Summary', sortKey: 'summary', thClassName: 'text-left min-w-56' },
];

interface Props {
  sessionId: string;
}

export function TopicsFeed({ sessionId }: Props) {
  const { data: topics, isLoading } = useTopics(sessionId);
  const generate = useGenerateTopics(sessionId);
  const insert = useInsertTopic(sessionId);
  const [genError, setGenError] = useState<string | null>(null);
  // Latched on the first 503 (ui-refresh D9: honest capability gate — topic generation has no
  // external integration wired up on this deployment). Persists across session switches (this
  // panel is mounted-hidden and unkeyed); cleared only by a full page reload.
  const [genUnavailable, setGenUnavailable] = useState(false);
  const [sort, dispatchSort] = useReducer(sortReducer, { key: 'session_time', dir: 'desc' });

  function handleGenerate() {
    setGenError(null);
    generate.mutate(undefined, {
      // Single error channel (ui-refresh): inline in the panel only, no duplicate toast.
      onError: (err) => {
        if (err instanceof ApiError && err.status === 503) {
          setGenUnavailable(true);
          return;
        }
        setGenError(err instanceof Error ? err.message : 'Generation failed.');
      },
    });
  }

  function handleInsert() {
    insert.mutate({});
  }

  const sortedTopics = useMemo(() => {
    if (!topics) return topics;
    const mul = sort.dir === 'asc' ? 1 : -1;
    return [...topics].sort((a, b) => {
      if (sort.key === 'session_time') return mul * (a.ordinal - b.ordinal);
      if (sort.key === 'duration_sec') return mul * (a.duration_sec - b.duration_sec);
      if (sort.key === 'topic_level') return mul * (a.topic_level - b.topic_level);
      if (sort.key === 'summary')
        return mul * a.summary.toLowerCase().localeCompare(b.summary.toLowerCase());
      return 0;
    });
  }, [topics, sort]);

  const topicCount = topics?.length ?? 0;

  // A11y divergence from the spike (spec-mandated, D9): the spike used `disabled` + a mouse
  // `title`, unreachable via keyboard/AT. Here the control stays focusable via `aria-disabled`
  // (not `disabled`) with the reason exposed via `aria-describedby` + an always-visible span,
  // and the click handler no-ops while latched. See TranscribeFeed for the fuller rationale.
  const genReasonId = 'v5-topics-gen-reason';
  const toolbar = (
    <>
      {genError && (
        <span role="alert" className="ml-2 self-center text-[0.78rem] text-v5-danger">
          {genError}
        </span>
      )}
      <button
        type="button"
        className={`${FEED_GLASS_BTN} aria-disabled:pointer-events-none aria-disabled:cursor-not-allowed aria-disabled:opacity-45`}
        disabled={generate.isPending}
        aria-disabled={genUnavailable || undefined}
        aria-describedby={genUnavailable ? genReasonId : undefined}
        onClick={() => {
          if (genUnavailable) return;
          handleGenerate();
        }}
      >
        {generate.isPending ? 'Generating…' : 'Auto Generate'}
      </button>
      {genUnavailable && (
        <span id={genReasonId} className="ml-2 self-center text-[0.78rem] text-v5-muted">
          Topic generation isn&apos;t available on this server (no integration configured).
        </span>
      )}
      <button
        type="button"
        className={FEED_GLASS_BTN}
        disabled={insert.isPending}
        onClick={handleInsert}
      >
        Insert
      </button>
    </>
  );

  return (
    <FeedShell
      countLabel={`${topicCount} ${topicCount === 1 ? 'Topic' : 'Topics'}`}
      headerId="v5-topics-feed-head"
      feedAriaLabel="Topics feed"
      toolbar={toolbar}
      toolbarAriaLabel="Topics feed tools"
      // `v5-topics-feed` retained as a chrome hook; the flex-column panel layout
      // (was `:global(.v5-topics-feed)` in FeedTable.module.css) rides along as
      // utilities: fill the tab panel on desktop, cap + internal-scroll on phones.
      modifier="v5-topics-feed flex flex-col flex-[1_1_0] min-h-0 overflow-hidden max-md:flex-[0_0_auto] max-md:max-h-[70dvh]"
    >
      <FeedTable
        columns={COLUMNS}
        isLoading={isLoading}
        isEmpty={!topics || topics.length === 0}
        emptyMessage={
          genUnavailable ? (
            <>
              Topic generation isn&apos;t available on this server — no topic-generation integration
              is configured. You can still add topics by hand with <strong>Insert</strong>, or
              design a dashboard from the <strong>Dashboards</strong> tab.
            </>
          ) : (
            <>
              No topics yet. Generate a transcript first, then click <strong>Auto Generate</strong>.
            </>
          )
        }
        sortKey={sort.key}
        sortDir={sort.dir}
        onSort={(k) => dispatchSort(k as SortKey)}
      >
        {sortedTopics?.map((t) => (
          <TopicsRow key={t.id} row={t} sessionId={sessionId} />
        ))}
      </FeedTable>
    </FeedShell>
  );
}
