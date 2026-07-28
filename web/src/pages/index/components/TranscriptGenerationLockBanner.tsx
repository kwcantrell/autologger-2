import { useEffect, useState } from 'react';
import {
  formatTranscriptGenerationElapsed,
  type TranscriptGenerationStatusBusy,
} from '../../../api/hooks/useTranscriptGenerationStatus';
import { navigate } from '../navigation';

interface Props {
  status: TranscriptGenerationStatusBusy;
  currentSessionId: string;
}

export function TranscriptGenerationLockBanner({ status, currentSessionId }: Props) {
  const displayName = status.session_title?.trim() || status.session_id;
  const crossSession = status.session_id !== currentSessionId;
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, []);

  const elapsed = formatTranscriptGenerationElapsed(status.started_at, nowMs);

  return (
    <span
      className="ml-2 self-center text-[0.78rem] text-v5-muted"
      role="status"
      aria-label="Transcript generation in progress"
    >
      Transcribing &ldquo;
      {crossSession ? (
        <a
          href={`/sessions/${encodeURIComponent(status.session_id)}`}
          className="text-v5-text underline decoration-v5-border-strong underline-offset-2 hover-always:text-v5-primary"
          onClick={(e) => {
            e.preventDefault();
            navigate(`/sessions/${encodeURIComponent(status.session_id)}`);
          }}
        >
          {displayName}
        </a>
      ) : (
        displayName
      )}
      &rdquo;&hellip; {elapsed}
    </span>
  );
}
