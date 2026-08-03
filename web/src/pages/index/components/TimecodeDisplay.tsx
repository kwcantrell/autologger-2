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

export function TimecodeDisplay({ sessionId, compact = false }: Props) {
  const { data: status } = useSessionStatus(sessionId);
  const isRolling = Boolean(status?.is_rolling);
  const isRecording = Boolean(status?.audio_recording_lease_alive);
  const glyphSize = compact ? 18 : 15;

  return (
    // Outer .v4-clock-box + .v4-clock-box--tc (the second .v4-clock-box block's
    // v5 override wins by source order: rounded-v5-md / border-v5-border-strong /
    // rgba bg / inset shadow). Live state (.clock-timecode-box-live) swaps the
    // border color to #b44242 — an exclusive branch replacing the border color.
    <div
      className={clsx(
        'relative box-border flex h-(--v4-clock-box-h) max-h-(--v4-clock-box-h) min-h-(--v4-clock-box-h) min-w-0 flex-col overflow-visible rounded-v5-md border bg-[rgba(255,255,255,0.04)] [box-shadow:inset_0_1px_0_rgba(255,255,255,0.05)] [margin:var(--v4-clock-box-mv)_0]',
        compact
          ? // Content-sized floor (icons + digits); stretch when the row has spare width.
            'w-full min-w-max flex-[1_1_auto]'
          : 'flex-[0_0_var(--v4-clock-box-h)]',
        isRolling ? 'border-[#b44242]' : 'border-v5-border-strong',
      )}
    >
      {/* Inner .clock-box.clock-box-timecode.v4-clock-in-v4-box — the v4 box
          overrides most .clock-box chrome (transparent bg, no border/radius),
          keeps box-sizing/flex-col. .clock-box-timecode adds the extra top pad
          to clear the straddling label. */}
      <div
        className={clsx(
          'box-border flex h-full min-h-0 flex-[1_1_auto] flex-col items-stretch justify-start gap-0 border-0 bg-transparent',
          compact
            ? 'px-[0.4rem] py-[0.1rem] justify-center'
            : 'px-[0.45rem] pt-[calc(var(--v4-clock-inner-py)+var(--v4-clock-label-straddle))] pb-(--v4-clock-inner-py)',
        )}
        aria-live="polite"
      >
        {/* .clock-label under .v4-clock-box--tc .clock-box-timecode: absolutely
            positioned straddling badge. Live states tint it #b98686. */}
        {!compact && (
          <span
            className={clsx(
              'absolute top-0 left-[0.45rem] z-[2] block flex-none translate-y-[-50%] rounded-[0.125rem] bg-[#20232b] px-[0.15rem] py-0 text-[0.62rem] leading-none tracking-[0.12em] uppercase',
              isRolling ? 'text-[#b98686]' : 'text-[#bfc5cd]',
            )}
          >
            TIMECODE
          </span>
        )}
        {/* .clock-session-line under .clock-box-timecode + .v4-clock-in-v4-box:
            flex row filling remaining height; live tints #b44242, else #777e89. */}
        <span
          className={clsx(
            'flex min-h-0 w-full flex-[1_1_auto] items-center whitespace-nowrap font-mono font-medium leading-[1.2] tracking-[0.04em] [font-variant-numeric:tabular-nums]',
            compact
              ? 'justify-between gap-[0.45rem] text-[1.2rem]'
              : 'justify-between text-[1.34rem]',
            isRolling ? 'text-[#b44242]' : 'text-[#777e89]',
          )}
          id="session-roll-line"
        >
          <span
            className={clsx(
              'inline-flex flex-shrink-0 items-center self-center p-0 leading-none',
              compact ? 'gap-[0.28rem]' : 'gap-[0.42rem]',
            )}
          >
            <span
              className={clsx(
                'inline-flex items-center justify-center',
                compact ? 'h-[1.2rem] w-[1.2rem]' : 'h-[1.08rem] w-[1.08rem]',
                // Mic: red only while mic-recording; white while rolling.
                isRecording
                  ? 'text-[#ef4444]'
                  : isRolling
                    ? 'text-[#e2e8f0]'
                    : 'text-[#6b7280]',
              )}
            >
              <MicGlyph size={glyphSize} />
            </span>
            <span
              className={clsx(
                'inline-flex items-center justify-center',
                compact ? 'h-[1.2rem] w-[1.2rem]' : 'h-[1.08rem] w-[1.08rem]',
                // Roll icon stays red while timecode is live.
                isRolling || isRecording ? 'text-[#b44242]' : 'text-[#6b7280]',
              )}
            >
              {isRolling ? <RecordGlyph size={glyphSize} /> : <StopGlyph size={glyphSize} />}
            </span>
          </span>
          <span
            className={clsx(
              'flex min-h-0 items-center self-stretch',
              compact ? 'shrink-0' : 'flex-[1_1_auto] justify-end',
            )}
          >
            <span
              className={clsx(
                'font-medium leading-none [font-variant-numeric:tabular-nums]',
                compact
                  ? 'text-[1.2rem] tracking-[0.03em]'
                  : '[font-size:clamp(0.75rem,calc((var(--v4-clock-inner-h)-var(--v4-clock-inner-py)-var(--v4-clock-label-straddle)-var(--v4-clock-inner-py))*0.88),1.35rem)]',
              )}
              id="session-tc-display"
            >
              {status?.timecode ?? '00:00:00'}
            </span>
          </span>
        </span>
      </div>
    </div>
  );
}
