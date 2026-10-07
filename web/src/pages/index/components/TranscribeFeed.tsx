import { useVirtualizer } from '@tanstack/react-virtual';
import { memo, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useSessionStatus } from '../../../api/hooks/useSessionStatus';
import { useTranscriptGenerationStatus } from '../../../api/hooks/useTranscriptGenerationStatus';
import {
  useGenerateTranscript,
  useInsertTranscriptWord,
  useTranscriptWords,
  useUpdateTranscriptWord,
} from '../../../api/hooks/useTranscriptWords';
import type { TranscriptWord, TranscriptWordVersionConflict } from '../../../api/types';
import { versionConflictOf } from '../../../api/versionConflict';
import { showToast } from '../../../shared/components/Toast';
import { TableCell, TableRow } from '../../../shared/components/ui/table';
import { conflictPromptCopy } from '../../../shared/hooks/conflictPromptCopy';
import { useVersionedSave } from '../../../shared/hooks/useVersionedSave';
import { useTranscriptWordsGate } from '../hooks/TranscriptWordsGateContext';
import { useGatedGenerate } from '../hooks/useGatedGenerate';
import { useTimelineSeek } from '../hooks/useTimelineSeek';
import { presentFields, useDraftStore } from '../utils/draftStore';
import { useRowSeeds } from '../utils/rowHolds';
import { followServer } from '../utils/seedStore';
import { clickSortReducer } from '../utils/sortReducer';
import { formatSpeaker, speakerOffsetFromWords } from '../utils/speakerOffset';
import { FeedShell } from './FeedShell';
import { type ColumnDef, FeedTable } from './FeedTable';
import { GenerateToolbar } from './GenerateToolbar';
import { JUMP_COLUMN } from './JumpToTimeButton';
import {
  TRANSCRIBE_DRAFT_FIELDS,
  type TranscribeDraft,
  TranscribeRow,
  type WordSaveOutcome,
} from './TranscribeRow';
import { TranscriptGenerationLockBanner } from './TranscriptGenerationLockBanner';

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

const FIELD_LABELS: Record<keyof TranscribeDraft, string> = {
  session_time: 'Session time',
  speaker: 'Speaker',
  word: 'Word',
};

interface Props {
  sessionId: string;
}

// Render-isolation memo (the WorkspaceStatic/TranscribeRow idiom). INVARIANT: every
// prop passed here must stay referentially stable across a SessionWorkspace render —
// today that is `sessionId` alone, memoized into `feedPanels` — or the playback-tick
// (~60/s) render isolation this buys reopens.
export const TranscribeFeed = memo(function TranscribeFeed({ sessionId }: Props) {
  // `enabled` (perf plan B4): this panel is mounted from session mount but
  // hidden until the Transcript tab is first activated — which is exactly when
  // the workspace's gate opens, so the first painted render here is the normal
  // loading state, not a stale "no words" one.
  const { data: words, isLoading } = useTranscriptWords(sessionId, {
    enabled: useTranscriptWordsGate(),
  });
  const { data: generationStatus } = useTranscriptGenerationStatus();
  const generate = useGenerateTranscript(sessionId);
  const insert = useInsertTranscriptWord(sessionId);
  const { mutateAsync: updateWord } = useUpdateTranscriptWord(sessionId);
  // --- Feed row jump (feed-row-seek, design D5/D7): one hook call per feed,
  // its `unavailable`/`jump` handed to every row as a prop/stable callback.
  // Transcript has no batch-edit mode (always editable), so the gate is just
  // loaded-status + not-rolling. `useTimelineSeek` reads the session-wide
  // clip layout via `AudioClipsContext` — no local `useEvents` call needed
  // here at all (whole-branch audit fix wave, finding C1/I3). ---
  const { data: status } = useSessionStatus(sessionId);
  const { unavailable: jumpUnavailable, jump } = useTimelineSeek(sessionId, false);
  const jumpReasonId = 'v5-transcribe-feed-jump-reason';
  const fps = status?.frame_rate ?? null;
  // Latched on the first 503 (ui-refresh D9: honest capability gate) — see
  // `useGatedGenerate` for the full rationale; the copy below tells the
  // operator to reload after configuring.
  const { genError, genUnavailable, handleGenerate } = useGatedGenerate(generate.mutate);
  // Default direction is oldest-first across all three feeds (owner decision
  // 2026-08-06, PR#4 review) — the log reads top-down like a sheet.
  const [sort, dispatchSort] = useReducer(sortReducer, { key: 'session_time', dir: 'asc' });
  // Reactive scroll viewport: FeedTable publishes its ScrollArea viewport via the
  // `scrollRef` callback below. Storing it in state (not a ref) re-renders so
  // useVirtualizer re-attaches the instant the viewport mounts, instead of waiting
  // for an unrelated background re-render (~1.5–2 s later).
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);

  function handleInsert() {
    insert.mutate({});
  }

  const speakerOffset = useMemo(() => speakerOffsetFromWords(words), [words]);

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

  // --- Row edit drafts ---
  // This feed virtualizes its rows, so a row's own state is not a safe place to
  // hold an uncommitted correction: React fires no blur when the virtualizer
  // unmounts the row, so scrolling past a half-typed edit destroyed it
  // silently. The feed owns the drafts instead (EventLogSheet's inline-draft
  // pattern, through the same `utils/draftStore` primitive) and each row writes
  // through on every keystroke — see `TranscribeDraft`.
  const drafts = useDraftStore<TranscribeDraft>();
  // --- Versioned saves (session-edit-conflicts D3/D4/D5/D9) ---
  // Every save is based on the row's SEED (`seeds.store`), never the cached
  // row; `seeds.holds` are the rows whose `edit` freezes their seed.
  const seeds = useRowSeeds<TranscriptWord>();
  const save = useVersionedSave(sessionId);
  const { run, isBusy } = save;
  // Keep theirs bumps the row's epoch, which is part of its React key, so every
  // mounted copy remounts and refills from the server row (D5).
  const [epochs, setEpochs] = useState<ReadonlyMap<string, number>>(() => new Map());
  // A session switch retires every row id these stores are keyed by (this panel is
  // mounted-hidden and unkeyed, so it is not remounted).
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is a prop, re-run when it changes
  useEffect(() => {
    drafts.clearAll();
    seeds.store.clearAll();
    setEpochs(new Map());
  }, [sessionId, drafts, seeds]);

  // D3 follow rule: a row's seed is the server row while the row holds nothing
  // (no draft, no edit, no save in flight or queued). Re-run when a save settles
  // too (`isBusy` changes identity), so a released row catches up.
  useEffect(() => {
    if (!words) return;
    followServer(
      seeds.store,
      words,
      (w) => w.id,
      (id) => drafts.read(id) !== undefined || seeds.holds.has(id) || isBusy(id),
    );
  }, [words, isBusy, drafts, seeds]);

  // Read at prompt time, so the stable `handleUpdate` below need not change
  // identity (and re-render every row) whenever the offset does.
  const speakerOffsetRef = useRef(speakerOffset);
  useEffect(() => {
    speakerOffsetRef.current = speakerOffset;
  }, [speakerOffset]);

  const handleUpdate = useCallback(
    async (wordId: string, patch: TranscribeDraft): Promise<WordSaveOutcome | undefined> => {
      // What this save is committing, and — separately — WHICH fields it
      // commits. A row PATCHes ONE blurred field at a time (`commitField`), so
      // the two are not the same question: the reference used to be the row's
      // whole stored draft, which made every untouched sibling field compare
      // equal to itself and be dropped as spent. An uncommitted correction in
      // another cell (or text a failed save had deliberately kept) then
      // vanished on the next remount, reverting to the server value with
      // nothing having persisted it. `patch` is already raw control text — the
      // row writes each keystroke through before it commits — so it IS the
      // draft-space reference for exactly the fields it carries.
      const covered = presentFields(patch, TRANSCRIBE_DRAFT_FIELDS);
      try {
        return await run<TranscriptWord, TranscriptWord>({
          rowKey: wordId,
          // The seed, read when this save's turn comes (after any earlier save
          // on the row has rebased it, D4). Never the cached row.
          baseVersion: () => seeds.store.get(wordId)?.version,
          send: (guard) => updateWord({ wordId, patch, guard }),
          conflictOf: (e) => versionConflictOf<TranscriptWordVersionConflict>(e)?.current ?? null,
          // Every field holding operator text — this patch, plus any sibling
          // still in the draft — so Keep theirs never discards text the dialog
          // did not show (D5).
          prompt: (current) => {
            const draft = drafts.read(wordId);
            const offset = speakerOffsetRef.current;
            const shown = (f: keyof TranscribeDraft, v: string | undefined) =>
              f === 'speaker' && v !== undefined ? formatSpeaker(v, offset) : v;
            return conflictPromptCopy(
              'edit',
              TRANSCRIBE_DRAFT_FIELDS.filter((f) => (patch[f] ?? draft?.[f]) !== undefined).map(
                (f) => ({
                  label: FIELD_LABELS[f],
                  theirs: shown(f, current[f]),
                  yours: shown(f, patch[f] ?? draft?.[f]),
                }),
              ),
            );
          },
          onSaved: (result) => {
            // Committed (`mutateAsync` resolves only after the mutation's
            // `invalidateQueries` refetch settles, so the row is already backed
            // by fresh server state). Drop ONLY what this save persisted, and
            // only if its text has not moved on: a round trip is long enough to
            // type into, and those later keystrokes are in the store. Same
            // shared draft-space comparison EventLogSheet uses.
            drafts.clearMatching(wordId, patch, covered);
            // D4 three-way rebase: a draft field that reads as the old seed is
            // not the operator's text; it refills from the saved row.
            const oldSeed = seeds.store.get(wordId);
            if (oldSeed) {
              drafts.clearMatching(
                wordId,
                {
                  session_time: oldSeed.session_time,
                  speaker: oldSeed.speaker,
                  word: oldSeed.word,
                },
                TRANSCRIBE_DRAFT_FIELDS,
              );
            }
            // Inside the row's chain, so a queued save on this row reads this
            // as its base.
            seeds.store.set(wordId, result);
          },
          onKeptTheirs: (current) => {
            // The prompt listed every field the draft held, so all of it goes.
            drafts.clear(wordId);
            seeds.store.set(wordId, current);
            setEpochs((prev) => new Map(prev).set(wordId, (prev.get(wordId) ?? 0) + 1));
          },
          // Dismissed: nothing. The draft (and the seed) stay, so saving again
          // asks again.
        });
      } catch (e) {
        // Failed: keep the draft, so the operator's text is still there on the
        // next remount instead of silently reverting, and say so.
        showToast(e instanceof Error ? e.message : 'Saving the word failed.', true);
        return undefined;
      }
    },
    [run, updateWord, drafts, seeds],
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

  // Shared aria-disabled latch toolbar — the a11y rationale (focusable
  // aria-disabled button + always-visible reason span) lives on GenerateToolbar.
  const genReasonId = 'v5-transcribe-gen-reason';
  const sameSessionGenerationBusy =
    generationStatus?.in_flight === true && generationStatus.session_id === sessionId;
  const toolbar = (
    <>
      <GenerateToolbar
        genError={genError}
        genUnavailable={genUnavailable}
        onGenerate={handleGenerate}
        generatePending={generate.isPending || sameSessionGenerationBusy}
        reasonId={genReasonId}
        reason={
          <>
            Transcription isn&apos;t configured on this server (needs <code>DEEPGRAM_API_KEY</code>
            ). Reload after configuring.
          </>
        }
        onInsert={handleInsert}
        insertPending={insert.isPending}
      />
      {generationStatus?.in_flight === true && (
        <TranscriptGenerationLockBanner status={generationStatus} currentSessionId={sessionId} />
      )}
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
          generate.isPending || sameSessionGenerationBusy ? (
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
              No transcript yet. Click <strong>Auto generate</strong> to transcribe audio.
            </>
          )
        }
        sortKey={sort.key}
        sortDir={sort.dir}
        onSort={(k) => dispatchSort(k as SortKey)}
        scrollRef={setScrollEl}
      >
        {paddingTop > 0 && (
          <TableRow>
            <TableCell
              colSpan={COLUMNS.length}
              style={{ height: paddingTop, padding: 0, border: 'none' }}
            />
          </TableRow>
        )}
        {sortedWords &&
          virtualItems.map((vRow) => {
            const w = sortedWords[vRow.index];
            return (
              <TranscribeRow
                key={`${w.id}:${epochs.get(w.id) ?? 0}`}
                row={w}
                speakerOffset={speakerOffset}
                onUpdate={handleUpdate}
                drafts={drafts}
                seeds={seeds}
                fps={fps}
                onJump={jump}
                jumpUnavailable={jumpUnavailable}
                jumpReasonId={jumpReasonId}
              />
            );
          })}
        {paddingBottom > 0 && (
          <TableRow>
            <TableCell
              colSpan={COLUMNS.length}
              style={{ height: paddingBottom, padding: 0, border: 'none' }}
            />
          </TableRow>
        )}
      </FeedTable>
      {save.conflictElement}
    </FeedShell>
  );
});
