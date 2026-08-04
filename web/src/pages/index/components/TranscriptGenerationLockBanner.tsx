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
  // Null when the server redacted the holder (another studio's session) —
  // session_title is null alongside it, so there is nothing to name or link.
  const busySessionId = status.session_id;
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, []);

  const elapsed = formatTranscriptGenerationElapsed(status.started_at, nowMs);

  if (busySessionId === null) {
    return (
      <span
        className="ml-2 self-center text-[0.78rem] text-v5-muted"
        role="status"
        aria-label="Transcript generation in progress"
      >
        Transcribing another studio&rsquo;s session&hellip; {elapsed}
      </span>
    );
  }

  const displayName = status.session_title?.trim() || busySessionId;
  const crossSession = busySessionId !== currentSessionId;

  return (
    <span
      className="ml-2 self-center text-[0.78rem] text-v5-muted"
      role="status"
      aria-label="Transcript generation in progress"
    >
      Transcribing &ldquo;
      {crossSession ? (
        <a
          href={`/sessions/${encodeURIComponent(busySessionId)}`}
          className="text-v5-text underline decoration-v5-border-strong underline-offset-2 hover-always:text-v5-primary"
          onClick={(e) => {
            e.preventDefault();
            navigate(`/sessions/${encodeURIComponent(busySessionId)}`);
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
