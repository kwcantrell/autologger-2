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

// --- converted class strings (were TransportControls.module.css) ---
// The whole tile stylesheet is anchored on SessionWorkspace-rendered ancestors:
//   [.v4-session-ctrl_&]:            v4 control-btn sizing
//   [.v5-session-controls-panel_&]:  v5 tile chrome (always inside #v4-log-session)
// The ::before hover-wash uses --session-ctl-accent; the 7-state accent matrix is
// set as arbitrary-property utilities per exclusive clsx branch (recipe 3/3b).

const CTRL_BTNS =
  'flex w-full min-w-0 flex-row flex-nowrap items-center justify-evenly gap-[0.35rem] my-(--v4-ctrl-btn-my) min-h-(--v4-ctrl-btn-h)';

// Base .sessionCtlBtn + .v4CtrlBtn shape, then the two ancestor contexts. The
// v5-panel context adds the isolate/overflow-hidden tile, the ::before wash layer
// (before: utilities), focus-visible ring, unguarded hover border-mix, and the
// motion-reduce transition kill (::before + self).
const CTRL_BTN =
  'box-border grid h-(--v4-ctrl-btn-h) max-h-(--v4-ctrl-btn-h) w-(--v4-ctrl-btn-w) flex-[0_0_var(--v4-ctrl-btn-w)] cursor-pointer place-items-center rounded-v4-9 border-0 bg-[#2d3039] p-0 [&:not(.isDisabled):hover]:[filter:brightness(1.5)] [.v4-session-ctrl_&]:h-(--v4-ctrl-btn-h) [.v4-session-ctrl_&]:max-h-(--v4-ctrl-btn-h) [.v4-session-ctrl_&]:min-h-(--v4-ctrl-btn-h) [.v4-session-ctrl_&]:w-(--v4-ctrl-btn-w) [.v4-session-ctrl_&]:flex-[0_0_var(--v4-ctrl-btn-w)] [.v4-session-ctrl_&]:[aspect-ratio:unset] [.v5-session-controls-panel_&]:relative [.v5-session-controls-panel_&]:isolate [.v5-session-controls-panel_&]:grid [.v5-session-controls-panel_&]:place-items-center [.v5-session-controls-panel_&]:overflow-hidden [.v5-session-controls-panel_&]:rounded-v5-md [.v5-session-controls-panel_&]:border [.v5-session-controls-panel_&]:border-[rgba(148,163,184,0.22)] [.v5-session-controls-panel_&]:[background:linear-gradient(180deg,rgba(255,255,255,0.07)_0%,rgba(255,255,255,0)_42%),linear-gradient(180deg,rgba(19,27,48,0.88),rgba(11,16,30,0.78))] [.v5-session-controls-panel_&]:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_4px_16px_rgba(2,8,23,0.42)] [.v5-session-controls-panel_&]:[--session-ctl-accent:var(--v5-primary)] [.v5-session-controls-panel_&]:[transition:border-color_0.15s_ease,box-shadow_0.15s_ease,background_0.15s_ease,opacity_0.15s_ease] [.v5-session-controls-panel_&]:before:pointer-events-none [.v5-session-controls-panel_&]:before:absolute [.v5-session-controls-panel_&]:before:inset-0 [.v5-session-controls-panel_&]:before:z-0 [.v5-session-controls-panel_&]:before:rounded-[inherit] [.v5-session-controls-panel_&]:before:opacity-0 [.v5-session-controls-panel_&]:before:[transition:opacity_0.15s_ease] [.v5-session-controls-panel_&]:before:[background:linear-gradient(165deg,color-mix(in_srgb,var(--session-ctl-accent)_22%,transparent),color-mix(in_srgb,var(--session-ctl-accent)_7%,transparent))] [.v5-session-controls-panel_&]:before:[content:""] [.v5-session-controls-panel_&]:focus-visible:outline-2 [.v5-session-controls-panel_&]:focus-visible:outline-offset-2 [.v5-session-controls-panel_&]:focus-visible:outline-[rgba(56,189,248,0.55)] [.v5-session-controls-panel_&:not(.isDisabled):hover]:[border-top-color:color-mix(in_srgb,var(--session-ctl-accent)_32%,transparent)] [.v5-session-controls-panel_&:not(.isDisabled):hover]:[border-bottom-color:color-mix(in_srgb,var(--session-ctl-accent)_14%,transparent)] [.v5-session-controls-panel_&:not(.isDisabled):hover]:[border-left-color:color-mix(in_srgb,var(--session-ctl-accent)_24%,rgba(148,163,184,0.22))] [.v5-session-controls-panel_&:not(.isDisabled):hover]:[border-right-color:color-mix(in_srgb,var(--session-ctl-accent)_24%,rgba(148,163,184,0.22))] [.v5-session-controls-panel_&:not(.isDisabled):hover]:before:opacity-100 motion-reduce:[.v5-session-controls-panel_&]:[transition:none] motion-reduce:[.v5-session-controls-panel_&]:before:[transition:none]';

// Tone/solid state matrix. Each branch sets --session-ctl-accent + border/shadow.
// isSolidGrey.toneGreen / .toneRed / .toneGrey / .toneLight (armed/idle hints):
const TONE_GREEN =
  '[.v5-session-controls-panel_&]:[--session-ctl-accent:rgb(52,211,153)]! [.v5-session-controls-panel_&]:border-[rgba(52,211,153,0.42)] [.v5-session-controls-panel_&]:shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_0_0_1px_rgba(52,211,153,0.1),0_4px_18px_rgba(2,8,23,0.45),0_0_22px_-10px_rgba(52,211,153,0.22)]';
const TONE_RED =
  '[.v5-session-controls-panel_&]:[--session-ctl-accent:#fb7185]! [.v5-session-controls-panel_&]:border-[rgba(251,113,133,0.48)] [.v5-session-controls-panel_&]:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_0_0_1px_rgba(251,113,113,0.12),0_4px_18px_rgba(2,8,23,0.45),0_0_22px_-10px_rgba(251,113,133,0.2)]';
const TONE_GREY =
  '[.v5-session-controls-panel_&]:[--session-ctl-accent:#94a3b8]! [.v5-session-controls-panel_&]:border-[rgba(148,163,184,0.16)] [.v5-session-controls-panel_&]:shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_2px_10px_rgba(2,8,23,0.35)]';
const TONE_LIGHT =
  '[.v5-session-controls-panel_&]:[--session-ctl-accent:#e2e8f0]! [.v5-session-controls-panel_&]:border-[rgba(226,232,240,0.32)] [.v5-session-controls-panel_&]:shadow-[inset_0_1px_0_rgba(255,255,255,0.09),0_4px_16px_rgba(2,8,23,0.4),0_0_18px_-10px_rgba(255,255,255,0.08)]';

// isSolidGreen (play active) / isSolidRed (roll hot): base tone-border swaps live
// on .sessionCtlBtn (no ancestor), the tile look + accent under the v5 panel, plus
// their own hover border-left/right mix.
const SOLID_GREEN =
  'border-solid border-[#4ab442] [.v5-session-controls-panel_&]:[--session-ctl-accent:#38bdf8]! [.v5-session-controls-panel_&]:border-[rgba(56,189,248,0.58)] [.v5-session-controls-panel_&]:[background:linear-gradient(180deg,rgba(56,189,248,0.22)_0%,rgba(56,189,248,0.06)_44%,rgba(255,255,255,0)_100%),linear-gradient(180deg,rgba(14,116,144,0.38),rgba(11,16,30,0.82))] [.v5-session-controls-panel_&]:shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_0_0_1px_rgba(56,189,248,0.15),0_4px_22px_rgba(2,8,23,0.5),0_0_32px_-8px_rgba(56,189,248,0.42)] [.v5-session-controls-panel_&:not(.isDisabled):hover]:[border-left-color:color-mix(in_srgb,var(--session-ctl-accent)_24%,rgba(56,189,248,0.58))] [.v5-session-controls-panel_&:not(.isDisabled):hover]:[border-right-color:color-mix(in_srgb,var(--session-ctl-accent)_24%,rgba(56,189,248,0.58))]';
const SOLID_RED =
  'border-solid border-[#b44242] [.v5-session-controls-panel_&]:[--session-ctl-accent:#fb7185]! [.v5-session-controls-panel_&]:border-[rgba(251,113,133,0.58)] [.v5-session-controls-panel_&]:[background:linear-gradient(180deg,rgba(251,113,133,0.24)_0%,rgba(251,113,133,0.07)_42%,rgba(255,255,255,0)_100%),linear-gradient(180deg,rgba(127,29,29,0.42),rgba(11,16,30,0.84))] [.v5-session-controls-panel_&]:shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_0_0_1px_rgba(251,113,113,0.14),0_4px_22px_rgba(2,8,23,0.5),0_0_32px_-8px_rgba(248,113,113,0.38)] [.v5-session-controls-panel_&:not(.isDisabled):hover]:[border-left-color:color-mix(in_srgb,var(--session-ctl-accent)_24%,rgba(251,113,133,0.58))] [.v5-session-controls-panel_&:not(.isDisabled):hover]:[border-right-color:color-mix(in_srgb,var(--session-ctl-accent)_24%,rgba(251,113,133,0.58))]';
const SOLID_GREY = 'border-solid border-[#4c505a]';

// isDisabled: base dashed/transparent + muted; v5-panel disabled locks (former
// !important flags dropped — utility layer beats legacy). `.isDisabled` literal
// class retained so the not-[.isDisabled]: hover guards resolve.
// The v5-panel border/background/shadow locks keep `!` (Tailwind important) so the
// disabled look beats the tone/solid state utilities on the SAME element regardless
// of generated-stylesheet order (the former legacy !important intent — recipe H).
const IS_DISABLED =
  'isDisabled cursor-not-allowed border-dashed border-transparent text-[#656b78] opacity-[0.92] [.v5-session-controls-panel_&]:border-dashed [.v5-session-controls-panel_&]:border-[rgba(148,163,184,0.14)]! [.v5-session-controls-panel_&]:[background:rgba(7,11,20,0.55)]! [.v5-session-controls-panel_&]:shadow-none! [.v5-session-controls-panel_&]:opacity-[0.48] [.v5-session-controls-panel_&]:[filter:none]';

// .sessionCtlIcon: img variant (src) uses 1.2rem square, contain; the base 1.7×1.4
// non-img size never applies here (icons are always <img>). z-1 over the ::before.
const CTRL_ICON =
  'inline-flex h-[1.2rem] w-[1.2rem] items-center justify-center object-contain leading-none [.v5-session-controls-panel_&]:relative [.v5-session-controls-panel_&]:z-[1]';

const SOLID_CLASS = {
  isSolidGrey: SOLID_GREY,
  isSolidGreen: SOLID_GREEN,
  isSolidRed: SOLID_RED,
} as const;
const TONE_CLASS = {
  toneGreen: TONE_GREEN,
  toneRed: TONE_RED,
  toneGrey: TONE_GREY,
  toneLight: TONE_LIGHT,
} as const;

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
      className={CTRL_BTNS}
      id="session-controls-v3"
      role="toolbar"
      aria-labelledby="v5-controls-recording-head"
    >
      {configs.map((cfg, i) => (
        <button
          key={cfg.ariaLabel}
          type="button"
          className={clsx(
            CTRL_BTN,
            SOLID_CLASS[cfg.solidClass],
            TONE_CLASS[cfg.toneClass],
            !cfg.enabled && IS_DISABLED,
          )}
          id={`btn-ctl-${i + 1}`}
          disabled={!cfg.enabled || busy}
          aria-label={cfg.ariaLabel}
          onClick={() => handleClick(i)}
        >
          <img
            className={CTRL_ICON}
            id={`btn-ctl-${i + 1}-icon`}
            src={TRANSPORT_ICONS[cfg.icon]}
            alt=""
          />
        </button>
      ))}
      {ytImportPending && transportState === 'stop' && (
        <p
          className="m-0 mt-[0.35rem] w-full p-0 text-center text-[0.72rem] font-medium leading-[1.4] text-v5-muted animate-wf-label-pulse motion-reduce:animate-none motion-reduce:opacity-85"
          aria-live="polite"
        >
          Importing YouTube audio…
        </p>
      )}
    </div>
  );
}
