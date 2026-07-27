import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useMemo, useReducer, useRef, useState } from 'react';
import { ApiError } from '../../../api/client';
import { useSessionStatus } from '../../../api/hooks/useSessionStatus';
import {
  useGenerateTranscript,
  useInsertTranscriptWord,
  useTranscriptWords,
  useUpdateTranscriptWord,
} from '../../../api/hooks/useTranscriptWords';
import { useTimelineSeek } from '../hooks/useTimelineSeek';
import { clickSortReducer } from '../utils/sortReducer';
import { FeedShell } from './FeedShell';
import { type ColumnDef, FEED_GLASS_BTN, FeedTable } from './FeedTable';
import { JUMP_COLUMN } from './JumpToTimeButton';
import { TranscribeRow } from './TranscribeRow';

type SortKey = 'session_time' | 'speaker' | 'word';
const sortReducer = clickSortReducer<SortKey>;

const COLUMNS: ColumnDef[] = [
  JUMP_COLUMN,
  {
    key: 'session_time',
    label: 'Session Time',
    sortKey: 'session_time',
    thClassName: 'text-left w-[6.5rem]',
  },
  { key: 'speaker', label: 'Speaker', sortKey: 'speaker', thClassName: 'text-left w-32' },
  { key: 'word', label: 'Word(s)', sortKey: 'word', thClassName: 'text-left min-w-40' },
];

// Approximate rendered height of a single TranscribeRow: input/button + cell
// padding + border. feed-row-seek task 7.3: re-measured (real headless
// Chromium against the actual compiled Tailwind CSS — jsdom has no layout
// engine) both before and after adding the leading jump column. Baseline
// (session-time/speaker/word only) measured ≈29.98px; with the jump column's
// leading cell (a 24px/h-6 button in a shorter [0.1rem]-padded cell) added,
// the row measured ≈30.48px — the jump cell does not become the tallest cell
// (the session-time input cell still is), so the column adds only marginal
// height. 31 covers the measured post-column height with a small margin; the
// prior 34 was a looser overestimate.
const ROW_HEIGHT = 31;

interface Props {
  sessionId: string;
}

export function TranscribeFeed({ sessionId }: Props) {
  const { data: words, isLoading } = useTranscriptWords(sessionId);
  const generate = useGenerateTranscript(sessionId);
  const insert = useInsertTranscriptWord(sessionId);
  const update = useUpdateTranscriptWord(sessionId);
  // --- Feed row jump (feed-row-seek, design D5/D7): one hook call per feed,
  // its `available`/`jump` handed to every row as a prop/stable callback.
  // Transcript has no batch-edit mode (always editable), so the gate is just
  // loaded-status + not-rolling. `useTimelineSeek` reads the session-wide
  // clip layout via `AudioClipsContext` — no local `useEvents` call needed
  // here at all (whole-branch audit fix wave, finding C1/I3). ---
  const { data: status } = useSessionStatus(sessionId);
  const { unavailable: jumpUnavailable, jump } = useTimelineSeek(sessionId, false);
  const jumpReasonId = 'v5-transcribe-feed-jump-reason';
  const fps = status?.frame_rate ?? null;
  const errorRef = useRef<string | null>(null);
  const [genError, setGenError] = useState<string | null>(null);
  // Latched on the first 503 (ui-refresh D9: honest capability gate — the server has no
  // capability endpoint, so unavailability is learned on first attempt and then stated
  // plainly instead of inviting repeat failures). Persists across session switches because
  // this panel is mounted-hidden and unkeyed; cleared only by a full page reload, which is
  // deliberate — the copy below tells the operator to reload after configuring.
  const [genUnavailable, setGenUnavailable] = useState(false);
  const [sort, dispatchSort] = useReducer(sortReducer, { key: 'session_time', dir: 'desc' });
  // Reactive scroll viewport: OverlayScrollbars publishes its viewport via the
  // `scrollRef` callback below. Storing it in state (not a ref) re-renders so
  // useVirtualizer re-attaches the instant OS initializes, instead of waiting
  // for an unrelated background re-render (~1.5–2 s later).
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);

  function handleGenerate() {
    setGenError(null);
    generate.mutate(undefined, {
      // Single error channel (ui-refresh): inline in the panel only, no duplicate toast.
      // A 503 latches the control instead of surfacing a one-off error message.
      onError: (err) => {
        if (err instanceof ApiError && err.status === 503) {
          setGenUnavailable(true);
          errorRef.current = err.message;
          return;
        }
        const msg = err instanceof Error ? err.message : 'Generation failed.';
        setGenError(msg);
        errorRef.current = msg;
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

  // A11y divergence from the spike (spec-mandated, D9): the spike used `disabled` + a mouse
  // `title` — invisible to keyboard/AT users since a native-disabled control can't receive
  // focus and has no accessible description. Here the control stays a real, focusable button
  // (no `disabled` attribute) using `aria-disabled` instead, with the reason exposed two ways:
  // `aria-describedby` pointing at an always-visible reason span (not sr-only — sighted
  // keyboard users get it too), and the click handler no-ops while latched. Visual "disabled"
  // styling is reproduced via the `aria-disabled:` variant since `disabled:` utilities key off
  // the native attribute.
  const genReasonId = 'v5-transcribe-gen-reason';
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
          Transcription isn&apos;t configured on this server (needs <code>DEEPGRAM_API_KEY</code>).
          Reload after configuring.
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
      countLabel={`${wordCount} ${wordCount === 1 ? 'Word' : 'Words'}`}
      headerId="v5-transcribe-feed-head"
      feedAriaLabel="Transcript feed"
      toolbar={toolbar}
      toolbarAriaLabel="Transcript feed tools"
      // `v5-transcribe-feed` retained as a chrome hook; the flex-column panel layout
      // (was `:global(.v5-transcribe-feed)` in FeedTable.module.css) rides along as
      // utilities: fill the tab panel on desktop, cap + internal-scroll on phones.
      modifier="v5-transcribe-feed flex flex-col flex-[1_1_0] min-h-0 overflow-hidden max-md:flex-[0_0_auto] max-md:max-h-[70dvh]"
      after={
        // The ONE shared reason node every row's jump control references while
        // unavailable (design D2 gate decision) — never one per row.
        jumpUnavailable && (
          <span id={jumpReasonId} className="sr-only">
            Jump is unavailable while timecode is rolling or session status is loading.
          </span>
        )
      }
    >
      <FeedTable
        columns={COLUMNS}
        isLoading={isLoading}
        isEmpty={!words || words.length === 0}
        emptyMessage={
          generate.isPending ? (
            <>Generating transcript&hellip; this may take a couple minutes.</>
          ) : genUnavailable ? (
            <>
              Transcription isn&apos;t configured on this server. It needs a DeepGram API key
              (server setting <code>DEEPGRAM_API_KEY</code>); when enabled, session audio is sent to
              DeepGram&apos;s cloud to transcribe it. Reload this page after configuring it. You can
              still add rows by hand with <strong>Insert</strong>.
            </>
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
            <td colSpan={4} style={{ height: paddingTop, padding: 0, border: 'none' }} />
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
                fps={fps}
                onJump={jump}
                jumpUnavailable={jumpUnavailable}
                jumpReasonId={jumpReasonId}
              />
            );
          })}
        {paddingBottom > 0 && (
          <tr>
            <td colSpan={4} style={{ height: paddingBottom, padding: 0, border: 'none' }} />
          </tr>
        )}
      </FeedTable>
    </FeedShell>
  );
}
