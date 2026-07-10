import clsx from 'clsx';
import { useSessionStatus } from '../../../api/hooks/useSessionStatus';
import micOffIcon from '../../../assets/icons/mic_off_icon.png';
import micTcOnIcon from '../../../assets/icons/mic_tc_on_icon.png';
import recordTcOnIcon from '../../../assets/icons/record_tc_on_icon.png';
import stopTcOffIcon from '../../../assets/icons/stop_tc_off_icon.png';

interface Props {
  sessionId: string;
}

export function TimecodeDisplay({ sessionId }: Props) {
  const { data: status } = useSessionStatus(sessionId);
  const isRolling = Boolean(status?.is_rolling);
  const isRecording = Boolean(status?.audio_recording_lease_alive);

  return (
    // Outer .v4-clock-box + .v4-clock-box--tc (the second .v4-clock-box block's
    // v5 override wins by source order: rounded-v5-md / border-v5-border-strong /
    // rgba bg / inset shadow). Live state (.clock-timecode-box-live) swaps the
    // border color to #b44242 — an exclusive branch replacing the border color.
    <div
      className={clsx(
        'relative box-border flex h-(--v4-clock-box-h) max-h-(--v4-clock-box-h) min-h-(--v4-clock-box-h) min-w-0 flex-[0_0_var(--v4-clock-box-h)] flex-col overflow-visible rounded-v5-md border bg-[rgba(255,255,255,0.04)] [box-shadow:inset_0_1px_0_rgba(255,255,255,0.05)] [margin:var(--v4-clock-box-mv)_0]',
        isRolling ? 'border-[#b44242]' : 'border-v5-border-strong',
      )}
    >
      {/* Inner .clock-box.clock-box-timecode.v4-clock-in-v4-box — the v4 box
          overrides most .clock-box chrome (transparent bg, no border/radius),
          keeps box-sizing/flex-col. .clock-box-timecode adds the extra top pad
          to clear the straddling label. */}
      <div
        className="box-border flex h-full min-h-0 flex-[1_1_auto] flex-col items-stretch justify-start gap-0 border-0 bg-transparent px-[0.45rem] pt-[calc(var(--v4-clock-inner-py)+var(--v4-clock-label-straddle))] pb-(--v4-clock-inner-py)"
        aria-live="polite"
      >
        {/* .clock-label under .v4-clock-box--tc .clock-box-timecode: absolutely
            positioned straddling badge. Live states tint it #b98686. */}
        <span
          className={clsx(
            'absolute top-0 left-[0.45rem] z-[2] block flex-none translate-y-[-50%] rounded-[0.125rem] bg-[#20232b] px-[0.15rem] py-0 text-[0.62rem] leading-none tracking-[0.12em] uppercase',
            isRolling ? 'text-[#b98686]' : 'text-[#bfc5cd]',
          )}
        >
          TIMECODE
        </span>
        {/* .clock-session-line under .clock-box-timecode + .v4-clock-in-v4-box:
            flex row filling remaining height; live tints #b44242, else #777e89. */}
        <span
          className={clsx(
            'flex min-h-0 w-full flex-[1_1_auto] items-stretch justify-between whitespace-nowrap font-mono text-[1.34rem] font-medium leading-[1.2] tracking-[0.04em] [font-variant-numeric:tabular-nums]',
            isRolling ? 'text-[#b44242]' : 'text-[#777e89]',
          )}
          id="session-roll-line"
        >
          <span className="inline-flex flex-shrink-0 items-center gap-[0.42rem] self-center p-0 leading-none">
            <img
              className="block h-[1.08rem] w-[1.08rem] object-contain opacity-95 [filter:none]"
              src={isRecording ? micTcOnIcon : micOffIcon}
              alt=""
            />
            <img
              className="block h-[1.08rem] w-[1.08rem] object-contain opacity-95 [filter:none]"
              src={isRolling ? recordTcOnIcon : stopTcOffIcon}
              alt=""
            />
          </span>
          <span className="flex min-h-0 flex-[1_1_auto] items-center justify-end self-stretch">
            <span
              className="[font-size:clamp(0.75rem,calc((var(--v4-clock-inner-h)-var(--v4-clock-inner-py)-var(--v4-clock-label-straddle)-var(--v4-clock-inner-py))*0.88),1.35rem)] font-medium leading-none [font-variant-numeric:tabular-nums]"
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
