import { useMemo, useReducer, useState } from 'react';
import { useGenerateTopics, useInsertTopic, useTopics } from '../../../api/hooks/useTopics';
import { toast } from '../../../shared/components/Toast';
import { clickSortReducer } from '../utils/sortReducer';
import { FeedShell } from './FeedShell';
import { type ColumnDef, FeedTable } from './FeedTable';
import styles from './FeedTable.module.css';
import { TopicsRow } from './TopicsRow';

type SortKey = 'session_time' | 'duration_sec' | 'topic_level' | 'summary';
const sortReducer = clickSortReducer<SortKey>;

const COLUMNS: ColumnDef[] = [
  { key: 'session_time', label: 'Session Time', sortKey: 'session_time', thModifier: 'feedThTime' },
  {
    key: 'duration_sec',
    label: 'Duration (s)',
    sortKey: 'duration_sec',
    thModifier: 'feedThDuration',
  },
  { key: 'topic_level', label: 'Level', sortKey: 'topic_level', thModifier: 'feedThLevel' },
  { key: 'summary', label: 'Summary', sortKey: 'summary', thModifier: 'feedThSummary' },
];

interface Props {
  sessionId: string;
}

export function TopicsFeed({ sessionId }: Props) {
  const { data: topics, isLoading } = useTopics(sessionId);
  const generate = useGenerateTopics(sessionId);
  const insert = useInsertTopic(sessionId);
  const [genError, setGenError] = useState<string | null>(null);
  const [sort, dispatchSort] = useReducer(sortReducer, { key: 'session_time', dir: 'desc' });

  function handleGenerate() {
    setGenError(null);
    generate.mutate(undefined, {
      onError: (err) => {
        const msg = err instanceof Error ? err.message : 'Generation failed.';
        setGenError(msg);
        toast.error(msg);
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

  const toolbar = (
    <>
      {genError && <span className={styles.feedError}>{genError}</span>}
      <button
        type="button"
        className={styles.feedGlassBtn}
        disabled={generate.isPending}
        onClick={handleGenerate}
      >
        {generate.isPending ? 'Generating…' : 'Auto Generate'}
      </button>
      <button
        type="button"
        className={styles.feedGlassBtn}
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
      modifier="v5-topics-feed"
    >
      <FeedTable
        columns={COLUMNS}
        isLoading={isLoading}
        isEmpty={!topics || topics.length === 0}
        emptyMessage={
          <>
            No topics yet. Generate a transcript first, then click <strong>Auto Generate</strong>.
          </>
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
