import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useCallback, useState } from 'react';
import { eventsKeys } from '../../../api/hooks/useEvents';
import { useSessionStatus } from '../../../api/hooks/useSessionStatus';
import { useTransport } from '../../../api/hooks/useTransport';
import micOffIcon from '../../../assets/icons/mic_off_icon.png';
import micOnIcon from '../../../assets/icons/mic_on_icon.png';
import pauseOnIcon from '../../../assets/icons/pause_on_icon.png';
import playOffIcon from '../../../assets/icons/play_off_icon.png';
import playOnIcon from '../../../assets/icons/play_on_icon.png';
import recordOffIcon from '../../../assets/icons/record_off_icon.png';
import recordOnIcon from '../../../assets/icons/record_on_icon.png';
import stopOffIcon from '../../../assets/icons/stop_off_icon.png';
import stopOnIcon from '../../../assets/icons/stop_on_icon.png';

import styles from './TransportControls.module.css';

/** Maps a {@link BtnConfig.icon} key to its content-hashed asset URL. */
const TRANSPORT_ICONS: Record<string, string> = {
  play_on: playOnIcon,
  play_off: playOffIcon,
  record_on: recordOnIcon,
  record_off: recordOffIcon,
  pause_on: pauseOnIcon,
  mic_on: micOnIcon,
  mic_off: micOffIcon,
  stop_on: stopOnIcon,
  stop_off: stopOffIcon,
};

export type TransportState = 'stop' | 'play' | 'rolling' | 'audio-recording';

export function getTransportState(isRolling: boolean, isRecording: boolean): TransportState {
  if (isRecording) return 'audio-recording';
  if (isRolling) return 'rolling';
  return 'stop';
}

type SolidKey = 'isSolidGrey' | 'isSolidGreen' | 'isSolidRed';
type ToneKey = 'toneGreen' | 'toneRed' | 'toneGrey' | 'toneLight';

interface BtnConfig {
  icon: string;
  solidClass: SolidKey;
  toneClass: ToneKey;
  enabled: boolean;
  ariaLabel: string;
}

function getConfigs(
  st: TransportState,
  remoteBlocked: boolean,
): [BtnConfig, BtnConfig, BtnConfig, BtnConfig] {
  const disabled = (icon: string, label: string): BtnConfig => ({
    icon,
    solidClass: 'isSolidGrey',
    toneClass: 'toneGrey',
    enabled: false,
    ariaLabel: label,
  });

  let configs: [BtnConfig, BtnConfig, BtnConfig, BtnConfig];
  switch (st) {
    case 'stop':
      configs = [
        {
          icon: 'play_on',
          solidClass: 'isSolidGrey',
          toneClass: 'toneGreen',
          enabled: true,
          ariaLabel: 'Play or pause audio',
        },
        {
          icon: 'record_on',
          solidClass: 'isSolidGrey',
          toneClass: 'toneRed',
          enabled: true,
          ariaLabel: 'Roll timecode',
        },
        disabled('mic_off', 'Record audio'),
        disabled('stop_off', 'Stop timecode'),
      ];
      break;
    case 'play':
      configs = [
        {
          icon: 'pause_on',
          solidClass: 'isSolidGreen',
          toneClass: 'toneGreen',
          enabled: true,
          ariaLabel: 'Pause audio',
        },
        disabled('record_off', 'Roll timecode'),
        disabled('mic_off', 'Record audio'),
        disabled('stop_off', 'Stop timecode'),
      ];
      break;
    case 'rolling':
      configs = [
        disabled('play_off', 'Play audio'),
        {
          icon: 'record_on',
          solidClass: 'isSolidRed',
          toneClass: 'toneRed',
          enabled: true,
          ariaLabel: 'Timecode rolling',
        },
        {
          icon: 'mic_off',
          solidClass: 'isSolidGrey',
          toneClass: 'toneRed',
          enabled: true,
          ariaLabel: 'Record audio',
        },
        {
          icon: 'stop_on',
          solidClass: 'isSolidGrey',
          toneClass: 'toneLight',
          enabled: true,
          ariaLabel: 'Stop timecode',
        },
      ];
      break;
    case 'audio-recording':
      configs = [
        disabled('play_off', 'Play audio'),
        {
          icon: 'record_on',
          solidClass: 'isSolidRed',
          toneClass: 'toneRed',
          enabled: true,
          ariaLabel: 'Timecode rolling',
        },
        {
          icon: 'mic_on',
          solidClass: 'isSolidRed',
          toneClass: 'toneRed',
          enabled: true,
          ariaLabel: 'Stop recording audio',
        },
        {
          icon: 'stop_on',
          solidClass: 'isSolidGrey',
          toneClass: 'toneLight',
          enabled: true,
          ariaLabel: 'Stop timecode',
        },
      ];
      break;
  }

  if (remoteBlocked) {
    return configs.map((c) => ({ ...c, enabled: false })) as [
      BtnConfig,
      BtnConfig,
      BtnConfig,
      BtnConfig,
    ];
  }
  return configs;
}

interface Props {
  sessionId: string;
  onAudioRecord?: () => void;
  onAudioPlay?: () => void;
  ytImportPending?: boolean;
  isPlaying?: boolean;
}

export function TransportControls({
  sessionId,
  onAudioRecord,
  onAudioPlay,
  ytImportPending,
  isPlaying,
}: Props) {
  const { data: status } = useSessionStatus(sessionId);
  const { start, stop } = useTransport(sessionId);
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);

  const isRolling = Boolean(status?.is_rolling);
  const isRecording = Boolean(status?.audio_recording_lease_alive);

  let transportState: TransportState = 'stop';
  if (isRecording) transportState = 'audio-recording';
  else if (isRolling) transportState = 'rolling';
  else if (isPlaying) transportState = 'play';

  // Remote lock: lease is alive but we don't hold it
  const leaseHolder = status?.audio_recording_lease_holder_id ?? null;
  const myClientId =
    typeof sessionStorage !== 'undefined'
      ? (sessionStorage.getItem('autologger:clientInstanceId') ?? null)
      : null;
  const remoteBlocked = Boolean(leaseHolder && myClientId && leaseHolder !== myClientId);

  const configs = getConfigs(transportState, remoteBlocked);
  if (ytImportPending && transportState === 'stop') {
    configs[1] = { ...configs[1], enabled: false };
  }

  const handleClick = useCallback(
    async (idx: number) => {
      if (busy) return;
      if (idx === 1) {
        // btn2: roll timecode (only in stop state)
        if (transportState !== 'stop') return;
        setBusy(true);
        try {
          await start.mutateAsync();
          qc.invalidateQueries({ queryKey: eventsKeys.all(sessionId) });
        } finally {
          setBusy(false);
        }
      } else if (idx === 3) {
        // btn4: stop timecode (rolling or audio-recording).
        // When audio is recording, stop the recording first so the segment is
        // saved — equivalent to pressing "Stop recording audio" then "Stop timecode".
        if (transportState === 'stop') return;
        setBusy(true);
        try {
          if (transportState === 'audio-recording') {
            onAudioRecord?.();
          }
          await stop.mutateAsync();
          qc.invalidateQueries({ queryKey: eventsKeys.all(sessionId) });
        } finally {
          setBusy(false);
        }
      } else if (idx === 0) {
        onAudioPlay?.();
      } else if (idx === 2) {
        onAudioRecord?.();
      }
    },
    [busy, transportState, start, stop, qc, sessionId, onAudioPlay, onAudioRecord],
  );

  return (
    <div
      className={styles.v4CtrlBtns}
      id="session-controls-v3"
      role="toolbar"
      aria-labelledby="v5-controls-recording-head"
    >
      {configs.map((cfg, i) => (
        <button
          key={cfg.ariaLabel}
          type="button"
          className={clsx(
            styles.v4CtrlBtn,
            styles.sessionCtlBtn,
            styles[cfg.solidClass],
            styles[cfg.toneClass],
            !cfg.enabled && styles.isDisabled,
          )}
          id={`btn-ctl-${i + 1}`}
          disabled={!cfg.enabled || busy}
          aria-label={cfg.ariaLabel}
          onClick={() => handleClick(i)}
        >
          <img
            className={styles.sessionCtlIcon}
            id={`btn-ctl-${i + 1}-icon`}
            src={TRANSPORT_ICONS[cfg.icon]}
            alt=""
          />
        </button>
      ))}
      {ytImportPending && transportState === 'stop' && (
        <p className={styles.ytImportStatusLabel} aria-live="polite">
          Importing YouTube audio…
        </p>
      )}
    </div>
  );
}
