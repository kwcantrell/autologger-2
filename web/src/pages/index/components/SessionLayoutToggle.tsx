import clsx from 'clsx';
import type { SessionLayoutPreference } from '../utils/sessionLayoutPreference';
import { feedTabButtonClassName } from './feedTabStyles';

interface Props {
  preference: SessionLayoutPreference;
  onSetPreference: (value: SessionLayoutPreference) => void;
  isRolling: boolean;
  isRecording: boolean;
}

const REASON_ID = 'session-layout-toggle-reason';

export function SessionLayoutToggle({
  preference,
  onSetPreference,
  isRolling,
  isRecording,
}: Props) {
  const label = preference === 'default' ? 'Maximize log' : 'Default view';
  const forceBlocked = isRolling || isRecording;
  const blocked = preference === 'default' && forceBlocked;
  const reason =
    isRecording && blocked
      ? 'Maximize log is unavailable while the session is recording.'
      : isRolling && blocked
        ? 'Maximize log is unavailable while the session is rolling.'
        : null;

  return (
    <div className="ml-auto flex shrink-0 flex-col items-end gap-0.5 self-end pb-[0.55rem] pl-2">
      <button
        type="button"
        className={clsx(
          feedTabButtonClassName(false),
          'aria-disabled:pointer-events-none aria-disabled:cursor-not-allowed aria-disabled:opacity-45',
        )}
        aria-disabled={blocked || undefined}
        aria-describedby={blocked ? REASON_ID : undefined}
        onClick={() => {
          if (blocked) return;
          onSetPreference(preference === 'default' ? 'maximize-log' : 'default');
        }}
      >
        {label}
      </button>
      {reason ? (
        <span id={REASON_ID} className="max-w-[14rem] text-right text-[0.65rem] leading-snug text-v5-muted">
          {reason}
        </span>
      ) : null}
    </div>
  );
}
