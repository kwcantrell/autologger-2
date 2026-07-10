import clsx from 'clsx';
import { useSessionStatus } from '../../../api/hooks/useSessionStatus';
import micOffIcon from '../../../assets/icons/mic_off_icon.png';
import micTcOnIcon from '../../../assets/icons/mic_tc_on_icon.png';
import recordTcOnIcon from '../../../assets/icons/record_tc_on_icon.png';
import stopTcOffIcon from '../../../assets/icons/stop_tc_off_icon.png';
import styles from './TimecodeDisplay.module.css';

interface Props {
  sessionId: string;
}

export function TimecodeDisplay({ sessionId }: Props) {
  const { data: status } = useSessionStatus(sessionId);
  const isRolling = Boolean(status?.is_rolling);
  const isRecording = Boolean(status?.audio_recording_lease_alive);

  return (
    <div
      className={clsx(
        styles.v4ClockBox,
        styles.v4ClockBoxTc,
        isRolling && styles.clockTimecodeBoxLive,
      )}
    >
      <div
        className={clsx(styles.clockBox, styles.clockBoxTimecode, styles.v4ClockInV4Box)}
        aria-live="polite"
      >
        <span className={styles.clockLabel}>TIMECODE</span>
        <span className={styles.clockSessionLine} id="session-roll-line">
          <span className={styles.clockSessionIcons}>
            <img
              className={clsx(styles.clockSessionIcon, isRecording && styles.clockSessionIconLive)}
              src={isRecording ? micTcOnIcon : micOffIcon}
              alt=""
            />
            <img
              className={clsx(styles.clockSessionIcon, isRolling && styles.clockSessionIconLive)}
              src={isRolling ? recordTcOnIcon : stopTcOffIcon}
              alt=""
            />
          </span>
          <span className={styles.clockSessionText}>
            <span className={styles.clockSessionTimecode} id="session-tc-display">
              {status?.timecode ?? '00:00:00'}
            </span>
          </span>
        </span>
      </div>
    </div>
  );
}
