import { memo, useMemo } from 'react';
import { API_ROOT } from '../../../api/client';
import { useTopics } from '../../../api/hooks/useTopics';
import { useTranscriptWords } from '../../../api/hooks/useTranscriptWords';
import { Button } from '../../../shared/components/ui/button';
import { useTranscriptWordsGate } from '../hooks/TranscriptWordsGateContext';
import { speakerOffsetFromWords } from '../utils/speakerOffset';
import { buildTopicsCsv, downloadTopicsCsv } from '../utils/topicsCsv';
import { buildTranscriptCsv, downloadTranscriptCsv } from '../utils/transcriptCsv';
import { FeedShell } from './FeedShell';
import { FeedToolbarCaption, IconDownload } from './feedToolbarCaption';

interface Props {
  sessionId: string;
}

// Render-isolation memo (the WorkspaceStatic/TranscribeRow idiom). INVARIANT: every
// prop passed here must stay referentially stable across a SessionWorkspace render —
// today that is `sessionId` alone, memoized into `feedPanels` — or the playback-tick
// (~60/s) render isolation this buys reopens.
export const ExportFeed = memo(function ExportFeed({ sessionId }: Props) {
  const base = `${API_ROOT}/sessions/${sessionId}`;
  // `enabled` (perf plan B4). `isPending` already reads the way this panel
  // needs it to while the gate is shut: a disabled query stays `pending`, so
  // the Transcript CSV button is disabled — correct, since there are no words
  // to export yet. Activating the Export tab opens the gate in the same render
  // that first reveals this panel, so the user only ever sees the ordinary
  // pending → ready progression.
  const { data: words, isPending: wordsPending } = useTranscriptWords(sessionId, {
    enabled: useTranscriptWordsGate(),
  });
  const { data: topics, isPending: topicsPending } = useTopics(sessionId);

  const speakerOffset = useMemo(() => speakerOffsetFromWords(words), [words]);

  const wordCount = words?.length ?? 0;
  const topicCount = topics?.length ?? 0;

  return (
    <FeedShell
      countLabel="Export"
      headerId="v5-export-feed-head"
      feedAriaLabel="Export feed"
      toolbar={null}
      toolbarAriaLabel="Export feed tools"
      modifier="v5-export-feed flex flex-col flex-[1_1_0] min-h-0 overflow-hidden max-md:flex-[0_0_auto] max-md:max-h-[70dvh]"
    >
      <p className="m-0 mb-3 text-[0.82rem] leading-[1.45] text-v5-muted">
        Download a CSV for each feed individually.
      </p>
      {/* shadcn Button (shadcn-port-workspace D6): primary for the three CSVs, outline for the
          JSONL; the server-side exports stay real <a download> links via asChild. */}
      <div className="mt-3 flex max-w-md flex-col items-stretch gap-2">
        <Button asChild>
          <a href={`${base}/export.csv`} download>
            <FeedToolbarCaption alwaysLabel label="Event feed CSV" icon={<IconDownload />} />
          </a>
        </Button>
        <Button
          disabled={wordsPending || wordCount === 0}
          onClick={() => {
            if (!words || words.length === 0) return;
            downloadTranscriptCsv(sessionId, buildTranscriptCsv(words, speakerOffset));
          }}
        >
          <FeedToolbarCaption
            alwaysLabel
            label={`Transcript CSV${wordCount > 0 ? ` (${wordCount})` : ''}`}
            icon={<IconDownload />}
          />
        </Button>
        <Button
          disabled={topicsPending || topicCount === 0}
          onClick={() => {
            if (!topics || topics.length === 0) return;
            downloadTopicsCsv(sessionId, buildTopicsCsv(topics));
          }}
        >
          <FeedToolbarCaption
            alwaysLabel
            label={`Topics CSV${topicCount > 0 ? ` (${topicCount})` : ''}`}
            icon={<IconDownload />}
          />
        </Button>
        <Button variant="outline" asChild>
          <a href={`${base}/export.jsonl`} download>
            <FeedToolbarCaption alwaysLabel label="Event feed JSONL" icon={<IconDownload />} />
          </a>
        </Button>
      </div>
    </FeedShell>
  );
});
