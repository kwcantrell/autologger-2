import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useMemo, useReducer, useRef, useState } from 'react';
import {
  useGenerateTranscript,
  useInsertTranscriptWord,
  useTranscriptWords,
  useUpdateTranscriptWord,
} from '../../../api/hooks/useTranscriptWords';
import { toast } from '../../../shared/components/Toast';
import { clickSortReducer } from '../utils/sortReducer';
import { FeedShell } from './FeedShell';
import { type ColumnDef, FEED_GLASS_BTN, FeedTable } from './FeedTable';
import { TranscribeRow } from './TranscribeRow';

type SortKey = 'session_time' | 'speaker' | 'word';
const sortReducer = clickSortReducer<SortKey>;

const COLUMNS: ColumnDef[] = [
  {
    key: 'session_time',
    label: 'Session Time',
    sortKey: 'session_time',
    thClassName: 'text-left w-[6.5rem]',
  },
  { key: 'speaker', label: 'Speaker', sortKey: 'speaker', thClassName: 'text-left w-32' },
  { key: 'word', label: 'Word(s)', sortKey: 'word', thClassName: 'text-left min-w-40' },
];

// Approximate rendered height of a single TranscribeRow (input + cell padding + border).
const ROW_HEIGHT = 34;

interface Props {
  sessionId: string;
}

export function TranscribeFeed({ sessionId }: Props) {
  const { data: words, isLoading } = useTranscriptWords(sessionId);
  const generate = useGenerateTranscript(sessionId);
  const insert = useInsertTranscriptWord(sessionId);
  const update = useUpdateTranscriptWord(sessionId);
  const errorRef = useRef<string | null>(null);
  const [genError, setGenError] = useState<string | null>(null);
  const [sort, dispatchSort] = useReducer(sortReducer, { key: 'session_time', dir: 'desc' });
  // Reactive scroll viewport: OverlayScrollbars publishes its viewport via the
  // `scrollRef` callback below. Storing it in state (not a ref) re-renders so
  // useVirtualizer re-attaches the instant OS initializes, instead of waiting
  // for an unrelated background re-render (~1.5–2 s later).
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);

  function handleGenerate() {
    setGenError(null);
    generate.mutate(undefined, {
      onError: (err) => {
        const msg = err instanceof Error ? err.message : 'Generation failed.';
        setGenError(msg);
        errorRef.current = msg;
        toast.error(msg);
      },
    });
  }

  function handleInsert() {
    insert.mutate({});
  }

  const speakerOffset = useMemo(() => {
    if (!words || words.length === 0) return 0;
    const nums = words.map((w) => Number.parseInt(w.speaker, 10)).filter((n) => !Number.isNaN(n));
    if (nums.length === 0) return 0;
    return Math.min(...nums) === 0 ? 1 : 0;
  }, [words]);

  const sortedWords = useMemo(() => {
    if (!words) return words;
    const mul = sort.dir === 'asc' ? 1 : -1;
    return [...words].sort((a, b) => {
      if (sort.key === 'session_time') return mul * (a.ordinal - b.ordinal);
      if (sort.key === 'speaker')
        return mul * a.speaker.localeCompare(b.speaker, undefined, { numeric: true });
      if (sort.key === 'word')
        return mul * a.word.toLowerCase().localeCompare(b.word.toLowerCase());
      return 0;
    });
  }, [words, sort]);

  const handleUpdate = useCallback(
    (wordId: string, patch: { session_time?: string; speaker?: string; word?: string }) => {
      update.mutate({ wordId, patch });
    },
    [update],
  );

  const virtualizer = useVirtualizer({
    count: sortedWords?.length ?? 0,
    getScrollElement: () => scrollEl,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const paddingTop = virtualItems.length > 0 ? virtualItems[0].start : 0;
  const paddingBottom =
    virtualItems.length > 0 ? totalSize - virtualItems[virtualItems.length - 1].end : 0;

  const wordCount = words?.length ?? 0;

  const toolbar = (
    <>
      {genError && <span className="ml-2 text-[0.78rem] text-v5-danger">{genError}</span>}
      <button
        type="button"
        className={FEED_GLASS_BTN}
        disabled={generate.isPending}
        onClick={handleGenerate}
      >
        {generate.isPending ? 'Generating…' : 'Auto Generate'}
      </button>
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
      countLabel={`${wordCount} ${wordCount === 1 ? 'Word' : 'Words'}`}
      headerId="v5-transcribe-feed-head"
      feedAriaLabel="Transcript feed"
      toolbar={toolbar}
      toolbarAriaLabel="Transcript feed tools"
      // `v5-transcribe-feed` retained as a chrome hook; the flex-column panel layout
      // (was `:global(.v5-transcribe-feed)` in FeedTable.module.css) rides along as
      // utilities: fill the tab panel on desktop, cap + internal-scroll on phones.
      modifier="v5-transcribe-feed flex flex-col flex-[1_1_0] min-h-0 overflow-hidden max-md:flex-[0_0_auto] max-md:max-h-[70dvh]"
    >
      <FeedTable
        columns={COLUMNS}
        isLoading={isLoading}
        isEmpty={!words || words.length === 0}
        emptyMessage={
          generate.isPending ? (
            <>Generating transcript&hellip; this may take a couple minutes.</>
          ) : (
            <>
              No transcript yet. Click <strong>Auto Generate</strong> to transcribe audio.
            </>
          )
        }
        sortKey={sort.key}
        sortDir={sort.dir}
        onSort={(k) => dispatchSort(k as SortKey)}
        scrollRef={setScrollEl}
      >
        {paddingTop > 0 && (
          <tr>
            <td colSpan={3} style={{ height: paddingTop, padding: 0, border: 'none' }} />
          </tr>
        )}
        {sortedWords &&
          virtualItems.map((vRow) => {
            const w = sortedWords[vRow.index];
            return (
              <TranscribeRow
                key={w.id}
                row={w}
                speakerOffset={speakerOffset}
                onUpdate={handleUpdate}
              />
            );
          })}
        {paddingBottom > 0 && (
          <tr>
            <td colSpan={3} style={{ height: paddingBottom, padding: 0, border: 'none' }} />
          </tr>
        )}
      </FeedTable>
    </FeedShell>
  );
}
