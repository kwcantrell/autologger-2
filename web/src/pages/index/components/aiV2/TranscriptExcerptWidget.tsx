// ai-v2-dashboards — transcript_excerpt catalog widget (task 4.3). Excerpt
// text is untrusted transcript content by design (design D5a) — rendered as
// TEXT ONLY, never markup. Timestamp/speaker degrade INDEPENDENTLY of text
// availability (task 4.7): a manually-entered transcript has real words but
// no timing, so the quote still renders while the timecode reads "—" and the
// speaker reads honest "Speaker N" — never a fabricated "0:00" or name. Can
// act as a `highlight_speaker` interaction TARGET (dims when a different
// speaker is highlighted elsewhere on the dashboard).

import clsx from 'clsx';
import { speakerColorVar, speakerLabel } from './palette';
import { UnavailableState } from './UnavailableState';
import type { TranscriptExcerptData } from './widgetTypes';

interface Props {
  data: TranscriptExcerptData;
  highlightSpeaker?: string | null;
}

export function TranscriptExcerptWidget({ data, highlightSpeaker }: Props) {
  if (!data.available) {
    return <UnavailableState reason={data.reason ?? 'No transcript excerpt is available.'} />;
  }
  const dimmed =
    Boolean(highlightSpeaker) && data.speaker !== null && highlightSpeaker !== data.speaker;
  return (
    <div
      className={clsx(
        'flex flex-1 min-h-0 flex-col justify-center gap-1.5 transition-opacity',
        dimmed && 'opacity-40',
      )}
      data-testid="aiv2-widget-transcript_excerpt"
    >
      <div className="flex items-center gap-1.5 text-[0.78rem] text-v5-muted">
        {data.speaker !== null && (
          <i
            aria-hidden="true"
            className="inline-block h-2 w-2 shrink-0 rounded-full"
            style={{ background: speakerColorVar(data.speaker) }}
          />
        )}
        <span>{data.speaker !== null ? speakerLabel(data.speaker) : 'Unknown speaker'}</span>
        {/* Never a fabricated "0:00" — an unavailable timestamp renders as an
            honest em dash, matching the mockup's degraded-excerpt example. */}
        <span className="ml-auto font-mono text-[0.75rem] [font-variant-numeric:tabular-nums] text-v5-soft">
          {data.timestampSec !== null ? formatMmSs(data.timestampSec) : '—'}
        </span>
      </div>
      {/* Untrusted transcript text — TEXT ONLY, never markup. */}
      <p className="m-0 line-clamp-3 max-w-[65ch] text-[0.92rem] leading-[1.5] text-v5-text">
        {data.text}
      </p>
    </div>
  );
}

function formatMmSs(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const mm = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}
