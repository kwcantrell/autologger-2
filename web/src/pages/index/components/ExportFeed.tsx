import { useMemo } from 'react';
import { API_ROOT } from '../../../api/client';
import { useTopics } from '../../../api/hooks/useTopics';
import { useTranscriptWords } from '../../../api/hooks/useTranscriptWords';
import { speakerOffsetFromWords } from '../utils/speakerOffset';
import { buildTopicsCsv, downloadTopicsCsv } from '../utils/topicsCsv';
import { buildTranscriptCsv, downloadTranscriptCsv } from '../utils/transcriptCsv';
import { FeedShell } from './FeedShell';
import { FeedToolbarCaption, IconDownload } from './feedToolbarCaption';

interface Props {
  sessionId: string;
}

const EXPORT_BTN = 'btn primary inline-flex items-center justify-center gap-2 text-center';

export function ExportFeed({ sessionId }: Props) {
  const base = `${API_ROOT}/sessions/${sessionId}`;
  const { data: words, isPending: wordsPending } = useTranscriptWords(sessionId);
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
      <div className="tool-row export-row flex flex-col gap-2 items-stretch max-w-md">
        <a className={EXPORT_BTN} href={`${base}/export.csv`} download>
          <FeedToolbarCaption alwaysLabel label="Event feed CSV" icon={<IconDownload />} />
        </a>
        <button
          type="button"
          className={EXPORT_BTN}
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
        </button>
        <button
          type="button"
          className={EXPORT_BTN}
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
        </button>
        <a
          className="btn inline-flex items-center justify-center gap-2 text-center"
          href={`${base}/export.jsonl`}
          download
        >
          <FeedToolbarCaption alwaysLabel label="Event feed JSONL" icon={<IconDownload />} />
        </a>
      </div>
    </FeedShell>
  );
}
