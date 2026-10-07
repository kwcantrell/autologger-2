import clsx from 'clsx';
import { KeyboardIcon } from 'lucide-react';
import type { LogEvent, SessionStatus } from '../../../api/types';
import { Badge } from '../../../shared/components/ui/badge';
import { Button } from '../../../shared/components/ui/button';
import { Tooltip } from '../../../shared/ui/Tooltip';
import type { AudioClipLite } from '../../../shared/utils/waveformMerge';
import { type ShellTransportState, TRANSPORT_STATUS_LABEL } from '../coordination/transportStatus';
import { CategoryButtonStrip } from './CategoryButtonStrip';
import { MarkerNav } from './MarkerNav';
import { TimecodeDisplay } from './TimecodeDisplay';
import { Timeline } from './Timeline';
import { TransportControls } from './TransportControls';

interface Props {
  sessionId: string;
  status: SessionStatus | null;
  events: LogEvent[];
  audioClips: AudioClipLite[];
  totalSec: number;
  mergedPeaks: Float32Array | null;
  isWaveformDecoding?: boolean;
  audioPlaybackSec: number | null;
  onSeekAudio: (sec: number) => void;
  onAudioRecord: () => void;
  onAudioPlay: () => void;
  ytImportPending?: boolean;
  isPlaying: boolean;
  onOpenShortcuts: () => void;
  /** Rolling or audio-recording — replace scrubber with category buttons. */
  liveDock: boolean;
  onOffState: Map<string, 'on' | 'off'>;
  onToggle: (categoryId: string) => void;
  /**
   * The shell transport state SessionWorkspace publishes to the top bar (perf override
   * included): the pill reads the top bar's label for it. Recording comes from the session-wide
   * lease ("Truthful recording indication"), so a remote client's recording reads REC here too.
   */
  transport: ShellTransportState;
}

// Live category buttons fill --v4-cat-btn-h (~6.7rem); do not clamp to the
// shorter scrub-lane height or overflow-y:hidden will crop them.
const LIVE_BUTTONS_SLOT = 'min-h-(--v4-cat-btn-h) h-auto max-h-none overflow-visible';

function fmtSessionDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}/${d.getUTCFullYear()}`;
}

export function MaximizeLogStrip({
  sessionId,
  status,
  events,
  audioClips,
  totalSec,
  mergedPeaks,
  isWaveformDecoding,
  audioPlaybackSec,
  onSeekAudio,
  onAudioRecord,
  onAudioPlay,
  ytImportPending,
  isPlaying,
  onOpenShortcuts,
  liveDock,
  onOffState,
  onToggle,
  transport,
}: Props) {
  const code = (status?.show_code ?? '').trim();
  const showName = (status?.show_name ?? '').trim();
  // session-title-suffix (design D5, task 2.3): `deck_title` is now the server-derived
  // mirror of `title` everywhere on the wire, so the `?? deck_title` fallback this used
  // to need is vestigial — `title` alone is authoritative.
  const sessionTitle = (status?.title ?? '').trim();
  const stripShow = showName || code || sessionTitle || '—';
  const stripSessionName = sessionTitle && sessionTitle !== stripShow ? sessionTitle : '';
  const dateText = fmtSessionDate(status?.session_created_at_utc ?? status?.now_utc);
  const displayStatus = ytImportPending
    ? 'Importing YouTube Audio'
    : TRANSPORT_STATUS_LABEL[transport];
  const statusIsYtImport = displayStatus === 'Importing YouTube Audio';
  // Lock transport / marker / scrub / shortcuts while YouTube audio is importing.
  const controlsLocked = statusIsYtImport;

  const liveButtons = (
    <div
      className={clsx(
        'v4-cat-buttons__scroll box-border flex w-full min-w-0 items-stretch',
        LIVE_BUTTONS_SLOT,
      )}
      id="cat-strip-live-slot"
      role="toolbar"
      aria-label="Log category"
    >
      <CategoryButtonStrip
        sessionId={sessionId}
        isRolling={true}
        onOffState={onOffState}
        onToggle={onToggle}
      />
    </div>
  );

  // The strip's pill says what the top bar says (finish review fix round 1: the card read STOPPED
  // beside the bar's PLAY during playback). Both read the same shell state and the same label
  // map, and the pill takes the shell's transport colours, so its colour always matches its word.
  const sessionMeta = (
    <div className="flex min-w-0 flex-row flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
      {/* Date lives in a hover/focus tooltip — saves a meta row; rail already
          shows dates for session picking. */}
      <Tooltip content={`Date ${dateText}`} side="right" align="start" delayDuration={200}>
        {/* No aria-label: a generic <p> can't take one (a11y pass), and the
            visible show/name text plus the sr-only date span below already
            carry everything the label duplicated. */}
        <p
          className="m-0 flex min-w-0 flex-1 cursor-default flex-row items-baseline gap-x-1.5 overflow-hidden rounded-[4px] font-ui text-[0.8125rem] leading-tight text-si-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          id="session-deck-title"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: deliberately focusable — the date lives only in this hover/FOCUS tooltip (spec "Maximize-log fused transport strip": "date via hover/focus tooltip"), so keyboard users need a way to summon it.
          tabIndex={0}
        >
          <span
            id="session-title-code"
            className="session-title-code min-w-0 truncate font-semibold"
          >
            {stripShow}
          </span>
          {stripSessionName ? (
            <>
              <span className="shrink-0 text-si-dim select-none" aria-hidden={true}>
                &middot;
              </span>
              <span id="studio-name" className="min-w-0 truncate text-si-muted">
                {stripSessionName}
              </span>
            </>
          ) : null}
          <span id="session-aside-date" className="sr-only">
            {dateText}
          </span>
        </p>
      </Tooltip>

      <h2
        className="m-0 flex min-w-0 shrink-0 flex-row flex-nowrap items-center gap-2 font-ui text-[0.75rem] leading-none"
        id="v5-controls-recording-head"
        aria-live="polite"
      >
        <span className="sr-only">Status:</span>
        {statusIsYtImport ? (
          <Badge variant="outline" className="animate-yt-import-pulse motion-reduce:animate-none">
            <span id="v5-controls-status-value">{displayStatus}</span>
          </Badge>
        ) : (
          <Badge variant="transport">
            {transport === 'recording' && (
              <span
                data-slot="live-dot"
                className="size-1.5 shrink-0 rounded-full bg-current"
                aria-hidden="true"
              />
            )}
            <span id="v5-controls-status-value">{displayStatus}</span>
          </Badge>
        )}
        {/* Visibility comes from CSS `body.v4-is-recording` (AudioRecorder's
            LOCAL-recorder signal), never from the session-wide `isRecording`
            lease — a remote client's recording must not reveal this client's
            (necessarily empty) meter. */}
        <span
          id="top-bar-mic-level"
          className="items-center"
          aria-hidden="true"
          title="Microphone level"
        >
          <span className="block h-2 w-12 overflow-hidden rounded-[3px] border border-si-line bg-si-bg">
            <span
              id="top-bar-mic-level-fill"
              className="block h-full w-0 origin-left bg-si-accent transition-[width] duration-75 ease-linear"
            />
          </span>
        </span>
        <span
          className="font-tc text-[0.75rem] font-medium text-si-fg [font-variant-numeric:tabular-nums]"
          id="top-bar-recording-dur"
          aria-hidden="true"
        >
          00:00:00
        </span>
      </h2>
    </div>
  );

  const transportButtons = (
    <div
      className="flex w-full min-w-0 flex-row flex-wrap items-center gap-1.5 md:flex-nowrap"
      role="toolbar"
      aria-label="Session transport controls"
    >
      <TransportControls
        sessionId={sessionId}
        onAudioRecord={onAudioRecord}
        onAudioPlay={onAudioPlay}
        ytImportPending={controlsLocked || ytImportPending}
        isPlaying={isPlaying}
        compact
      />
      <MarkerNav sessionId={sessionId} disabled={controlsLocked} ungrouped />
      {/* Shortcuts reference is desktop-only — phones don't use keyboard shortcuts. */}
      <Tooltip content="Keyboard shortcuts (?)">
        <Button
          variant="transport"
          size="icon"
          className="max-md:hidden md:w-auto md:min-w-(--h-ctl) md:flex-1"
          aria-label="Keyboard shortcuts"
          disabled={controlsLocked}
          onClick={onOpenShortcuts}
        >
          <KeyboardIcon data-icon="inline-start" aria-hidden="true" />
        </Button>
      </Tooltip>
    </div>
  );

  // One column at every width (preview `.tc-block`): identity and status, then the timecode,
  // then the transport row. Desktop pins it to the strip's left edge; phones stack it above
  // the timeline lane and let the transport row wrap instead of running to the viewport edge.
  const transportAside = (
    <aside
      className={clsx(
        'v5-session-controls-panel flex w-full min-w-0 flex-col items-stretch gap-2.5 self-stretch',
        'md:w-[min(100%,19.25rem)] md:shrink-0 md:justify-center',
      )}
      aria-label="Session info and transport"
    >
      {/* The phone "Open navigation" button that sat here is gone: the top bar's sidebar
          trigger opens the sidebar sheet (redesign-show-ignition D8). */}
      {sessionMeta}
      <div className={clsx('min-w-0', controlsLocked && 'opacity-50')}>
        <TimecodeDisplay sessionId={sessionId} compact />
      </div>
      {transportButtons}
    </aside>
  );

  return (
    <section
      id="v5-maximize-log-strip"
      className={clsx(
        // Show Ignition transport card (preview `.transport`): the flat panel surface, line
        // and card radius; the `data-transport` rules in tailwind.css tint it while live.
        'v5-maximize-log-strip box-border min-w-0 overflow-visible rounded-card border border-si-line bg-si-panel',
        'mx-3 mt-3 mb-5 w-[calc(100%-1.5rem)] p-3',
        'md:mx-4 md:mb-0 md:w-[calc(100%-2rem)] md:px-3.5 md:py-3',
        '[--v4-ctrl-btn-my:0]',
      )}
      aria-label="Session transport"
    >
      <Timeline
        sessionId={sessionId}
        status={status}
        events={events}
        audioClips={audioClips}
        totalSec={totalSec}
        mergedPeaks={mergedPeaks}
        isWaveformDecoding={isWaveformDecoding}
        audioPlaybackSec={audioPlaybackSec}
        onSeekAudio={onSeekAudio}
        stripOnly
        stripTrailing={transportAside}
        stripLaneSlot={liveDock ? liveButtons : undefined}
        controlsLocked={controlsLocked}
      />
    </section>
  );
}
