import clsx from 'clsx';
import { useSessionStatus } from '../../../api/hooks/useSessionStatus';

interface Props {
  sessionId: string;
  /** Narrow horizontal clock for the maximize-log fused strip. */
  compact?: boolean;
}

// Inline currentColor glyphs (ui-refresh: replaces the pre-tinted PNG pairs —
// state now tints via text color, matching the transport tiles' SVG treatment).
function MicGlyph({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="9.25" y="3.5" width="5.5" height="10" rx="2.75" fill="currentColor" />
      <path
        d="M6 11.5C6 14.8137 8.68629 17.5 12 17.5C15.3137 17.5 18 14.8137 18 11.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path d="M12 17.5V21" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function RecordGlyph({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="6" fill="currentColor" />
    </svg>
  );
}

function StopGlyph({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="6.5" y="6.5" width="11" height="11" rx="1.75" fill="currentColor" />
    </svg>
  );
}

// Show Ignition timecode (redesign-show-ignition task 5.2; preview `.tc`): JetBrains Mono through
// the timecode token, tabular figures, no box. The two state glyphs keep their meaning (mic: this
// session is recording audio; roll: timecode is live). While timecode rolls the digits take the
// full foreground and the shell's live glow (`--tx-glow`, transparent when stopped).
export function TimecodeDisplay({ sessionId, compact = false }: Props) {
  const { data: status } = useSessionStatus(sessionId);
  const isRolling = Boolean(status?.is_rolling);
  const isRecording = Boolean(status?.audio_recording_lease_alive);
  const glyphSize = compact ? 16 : 18;
  const live = isRolling || isRecording;

  return (
    <div className="flex min-w-0 items-center" aria-live="polite">
      <span
        className={clsx(
          'flex min-w-0 items-center gap-2.5 whitespace-nowrap',
          live ? 'text-si-fg' : 'text-si-muted',
        )}
        id="session-roll-line"
      >
        <span className="inline-flex shrink-0 items-center gap-1" aria-hidden="true">
          <span
            className={clsx(
              'inline-flex',
              // Mic: red only while recording audio; foreground while rolling.
              isRecording ? 'text-(--si-rec)' : isRolling ? 'text-si-fg' : 'text-si-dim',
            )}
          >
            <MicGlyph size={glyphSize} />
          </span>
          <span className={clsx('inline-flex', live ? 'text-(--si-rec)' : 'text-si-dim')}>
            {isRolling ? <RecordGlyph size={glyphSize} /> : <StopGlyph size={glyphSize} />}
          </span>
        </span>
        <span
          className={clsx(
            'font-tc font-semibold leading-none tracking-[-0.01em] [font-variant-numeric:tabular-nums] [transition:text-shadow_0.5s]',
            compact ? 'text-[1.625rem] max-md:text-[1.5rem]' : 'text-[2.125rem]',
            live && '[text-shadow:0_0_20px_var(--tx-glow)]',
          )}
          id="session-tc-display"
        >
          {status?.timecode ?? '00:00:00'}
        </span>
      </span>
    </div>
  );
}
