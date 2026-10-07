import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useCallback, useEffect, useRef, useState } from 'react';
import { eventsKeys } from '../../../api/hooks/useEvents';
import { useSessionStatus } from '../../../api/hooks/useSessionStatus';
import { useTransport } from '../../../api/hooks/useTransport';
import { Button } from '../../../shared/components/ui/button';
import { Tooltip } from '../../../shared/ui/Tooltip';
import { markOriginated } from '../transportOrigination';

// Show Ignition transport controls (redesign-show-ignition task 5.2; preview `.ctl`): flat shadcn
// Buttons in the `transport` variant. The old tone/solid matrix collapses to two channels:
//   - `data-active`: the button whose action is live right now (pause while playing, roll while
//     rolling or recording, record-audio while recording) fills with the shell's live colour;
//   - `rec`: the roll glyph stays red while it is idle (preview `.ctl.rec svg`).
// Disabled controls dim through the Button's own disabled state.

const CTRL_BTNS =
  'flex w-full min-w-0 flex-row flex-nowrap items-center justify-evenly gap-1.5 my-(--v4-ctrl-btn-my)';
// Flatten into the parent flex (MaximizeLogStrip) so transport / marker / ?
// share one even gap — nested toolbars stacked uneven spacing.
const CTRL_BTNS_COMPACT = 'contents';
// Desktop strip: grow equally across the session-controls column.
const CTRL_BTN_COMPACT_DESKTOP_GROW = 'md:w-auto md:min-w-(--h-ctl) md:flex-1';
// The idle roll glyph (preview `.ctl.rec svg`).
const REC_GLYPH = 'text-(--si-rec)';

/** Inline SVG transport glyph. The legacy `<icon>_on`/`_off` key pairs map to
 *  one glyph per action — enabled/disabled looks come from the button's state
 *  classes via currentColor, not from separate pre-tinted assets. */
function TransportGlyph({ icon, size = 29 }: { icon: string; size?: number }) {
  const kind = icon.replace(/_(on|off)$/, '');
  switch (kind) {
    case 'play':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
          <path d="M8 5.5L18.5 12L8 18.5Z" fill="currentColor" />
        </svg>
      );
    case 'pause':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
          <rect x="7" y="5.5" width="3.4" height="13" rx="1" fill="currentColor" />
          <rect x="13.6" y="5.5" width="3.4" height="13" rx="1" fill="currentColor" />
        </svg>
      );
    case 'record':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="5.5" fill="currentColor" />
          <circle
            cx="12"
            cy="12"
            r="8.25"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
            opacity="0.45"
          />
        </svg>
      );
    case 'mic':
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
    case 'stop':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
          <rect x="6.5" y="6.5" width="11" height="11" rx="1.75" fill="currentColor" />
        </svg>
      );
    default:
      return null;
  }
}

export type TransportState = 'stop' | 'play' | 'rolling' | 'audio-recording';

export function getTransportState(isRolling: boolean, isRecording: boolean): TransportState {
  if (isRecording) return 'audio-recording';
  if (isRolling) return 'rolling';
  return 'stop';
}

interface BtnConfig {
  icon: string;
  /** The action is live now: the button fills with the shell's live colour. */
  active: boolean;
  /** The roll glyph keeps its red while idle. */
  rec: boolean;
  enabled: boolean;
  ariaLabel: string;
}

function getConfigs(
  st: TransportState,
  remoteBlocked: boolean,
): [BtnConfig, BtnConfig, BtnConfig, BtnConfig] {
  const disabled = (icon: string, label: string): BtnConfig => ({
    icon,
    active: false,
    rec: false,
    enabled: false,
    ariaLabel: label,
  });

  let configs: [BtnConfig, BtnConfig, BtnConfig, BtnConfig];
  switch (st) {
    case 'stop':
      configs = [
        {
          icon: 'play_on',
          active: false,
          rec: false,
          enabled: true,
          ariaLabel: 'Play or pause audio',
        },
        {
          icon: 'record_on',
          active: false,
          rec: true,
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
          active: true,
          rec: false,
          enabled: true,
          ariaLabel: 'Pause audio',
        },
        disabled('record_off', 'Roll timecode'),
        disabled('mic_off', 'Record audio'),
        disabled('stop_off', 'Stop timecode'),
      ];
      break;
    case 'rolling':
      // Roll is live (filled). Mic stays neutral until mic-recording
      // so rolling doesn't look like a take already started.
      configs = [
        disabled('play_off', 'Play audio'),
        {
          icon: 'record_on',
          active: true,
          rec: true,
          enabled: true,
          ariaLabel: 'Timecode rolling',
        },
        {
          icon: 'mic_off',
          active: false,
          rec: false,
          enabled: true,
          ariaLabel: 'Record audio',
        },
        {
          icon: 'stop_on',
          active: false,
          rec: false,
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
          active: true,
          rec: true,
          enabled: true,
          ariaLabel: 'Timecode rolling',
        },
        {
          icon: 'mic_on',
          active: true,
          rec: true,
          enabled: true,
          ariaLabel: 'Stop recording audio',
        },
        {
          icon: 'stop_on',
          active: false,
          rec: false,
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
  /** Smaller tiles for the maximize-log fused strip. */
  compact?: boolean;
}

export function TransportControls({
  sessionId,
  onAudioRecord,
  onAudioPlay,
  ytImportPending,
  isPlaying,
  compact = false,
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
  if (ytImportPending) {
    for (let i = 0; i < configs.length; i += 1) {
      configs[i] = { ...configs[i], enabled: false };
    }
  }

  // Async-gap guard (session-deep-links phase-5 review): `start.mutateAsync()`
  // below is awaited, so this component's route may have moved on — a switch
  // to another session (re-render with a new `sessionId` prop, no unmount) or
  // a close/interstitial swap (unmount) — by the time it resolves. Marking
  // origination for the stale, closed-over `sessionId` in that case would let
  // the departure watcher misfire on a LATER, unrelated departure (see
  // transportOrigination.ts's `markOriginated` doc comment). `latestSessionIdRef`
  // catches the switch case (it tracks the prop across re-renders while
  // mounted); `mountedRef` catches full unmount, which stops re-renders and
  // would otherwise leave `latestSessionIdRef` frozen on the now-stale id.
  const latestSessionIdRef = useRef(sessionId);
  latestSessionIdRef.current = sessionId;
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  const handleClick = useCallback(
    async (idx: number) => {
      if (busy) return;
      if (idx === 1) {
        // btn2: roll timecode (only in stop state)
        if (transportState !== 'stop') return;
        setBusy(true);
        try {
          await start.mutateAsync();
          // This client just issued transport-start for `sessionId` — track
          // origination (session-deep-links design D4) so the departure
          // watcher stops it, and only it, on route departure. Guarded: only
          // mark if this component is still mounted and still on `sessionId`'s
          // route (see the async-gap comment above the refs).
          if (mountedRef.current && latestSessionIdRef.current === sessionId) {
            markOriginated(sessionId);
          }
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
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: false positive — the label travels with role="toolbar" (both undefined when compact); the rule can't see the conditional pairing.
    <div
      className={compact ? CTRL_BTNS_COMPACT : CTRL_BTNS}
      id="session-controls-v3"
      role={compact ? undefined : 'toolbar'}
      aria-label={compact ? undefined : 'Session transport controls'}
    >
      {configs.map((cfg, i) => (
        <Tooltip key={cfg.ariaLabel} content={cfg.ariaLabel}>
          <Button
            variant="transport"
            size="icon"
            className={clsx(
              // Compact strip on phones: hide unavailable actions instead of greying them.
              compact && !cfg.enabled && 'max-md:hidden',
              compact && CTRL_BTN_COMPACT_DESKTOP_GROW,
            )}
            data-active={cfg.active || undefined}
            id={`btn-ctl-${i + 1}`}
            disabled={!cfg.enabled || busy}
            aria-label={cfg.ariaLabel}
            onClick={() => handleClick(i)}
          >
            <span
              className={clsx(
                'pointer-events-none inline-flex items-center justify-center',
                cfg.rec && !cfg.active && cfg.enabled && REC_GLYPH,
              )}
              id={`btn-ctl-${i + 1}-icon`}
            >
              <TransportGlyph icon={cfg.icon} size={compact ? 18 : 22} />
            </span>
          </Button>
        </Tooltip>
      ))}
      {ytImportPending && transportState === 'stop' && !compact && (
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
