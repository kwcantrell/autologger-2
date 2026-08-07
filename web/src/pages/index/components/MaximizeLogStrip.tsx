import clsx from 'clsx';
import type { LogEvent, SessionStatus } from '../../../api/types';
import { Tooltip } from '../../../shared/ui/Tooltip';
import type { AudioClipLite } from '../../../shared/utils/waveformMerge';
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
  statusText: string;
  isRecording: boolean;
  isRolling?: boolean;
  /** Mobile: open the off-canvas nav rail (menu sits left of session controls). */
  onOpenMobileNav?: () => void;
}

// Live category buttons use --v4-cat-btn-h (~6.7rem); do not clamp to the
// shorter scrub-lane height or overflow-y:hidden will crop them.
const LIVE_BUTTONS_SLOT =
  'min-h-(--v4-cat-btn-h) h-auto max-h-none overflow-x-auto overflow-y-visible';

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
  statusText,
  isRecording,
  isRolling = false,
  onOpenMobileNav,
}: Props) {
  const code = (status?.show_code ?? '').trim();
  const showName = (status?.show_name ?? '').trim();
  const sessionTitle = (status?.title ?? '').trim() || (status?.deck_title ?? '').trim();
  const stripShow = showName || code || sessionTitle || '—';
  const stripSessionName = sessionTitle && sessionTitle !== stripShow ? sessionTitle : '';
  const dateText = fmtSessionDate(status?.session_created_at_utc ?? status?.now_utc);
  const displayStatus = ytImportPending ? 'Importing YouTube Audio' : statusText;
  const statusIsYtImport = displayStatus === 'Importing YouTube Audio';
  // Lock transport / marker / scrub / shortcuts while YouTube audio is importing.
  const controlsLocked = statusIsYtImport;
  const showMicLevel = isRecording;

  const liveButtons = (
    <div
      className={clsx(
        'v4-cat-buttons__scroll box-border flex w-full min-w-0 items-center',
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

  const sessionMeta = (
    <div className="flex min-w-0 flex-col gap-[0.15rem]">
      {/* Date lives in a hover/focus tooltip — saves a meta row; rail already
          shows dates for session picking. */}
      <Tooltip content={`Date ${dateText}`} side="right" align="start" delayDuration={200}>
        <p
          className="m-0 flex min-w-0 cursor-default flex-row flex-wrap items-baseline gap-x-[0.35rem] overflow-hidden [font-family:Inter,var(--font-poppins),system-ui,sans-serif] text-[0.78rem] leading-[1.15] text-v5-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[rgba(56,189,248,0.55)]"
          id="session-deck-title"
          tabIndex={0}
          aria-label={`Session ${stripShow}${stripSessionName ? ` · ${stripSessionName}` : ''}, date ${dateText}`}
        >
          <span
            id="session-title-code"
            className="session-title-code min-w-0 truncate font-semibold tracking-[-0.01em]"
          >
            {stripShow}
          </span>
          {stripSessionName ? (
            <>
              <span className="text-white/[0.32] font-medium select-none" aria-hidden={true}>
                &middot;
              </span>
              <span
                id="studio-name"
                className="min-w-0 truncate text-[0.74rem] font-normal text-v5-primary"
              >
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
        className="m-0 flex min-h-0 flex-row flex-nowrap items-center justify-start gap-x-[0.4rem] [font-family:Inter,var(--font-poppins),system-ui,sans-serif] text-[0.68rem] leading-none tracking-[0.04em]"
        id="v5-controls-recording-head"
        aria-live="polite"
      >
        <span className="[display:inline] text-v5-muted font-medium">Status:</span>
        {isRecording && (
          <span
            className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[#ef4444] shadow-[0_0_8px_rgba(239,68,68,0.55)] animate-wf-label-pulse motion-reduce:animate-none"
            aria-hidden="true"
          />
        )}
        <span
          className={clsx(
            'font-semibold',
            isRecording
              ? 'text-[#ef4444]'
              : statusIsYtImport
                ? 'text-[#fb923c] animate-yt-import-pulse motion-reduce:animate-none motion-reduce:text-[#ea580c]'
                : 'text-v5-text',
          )}
          id="v5-controls-status-value"
        >
          {displayStatus}
        </span>
        <span
          id="top-bar-mic-level"
          className="items-center gap-[0.35rem] h-[1.05rem]"
          data-show={showMicLevel ? '1' : undefined}
          aria-hidden="true"
          title="Microphone level"
        >
          <span className="block h-[0.55rem] w-[3.5rem] overflow-hidden rounded-[0.2rem] border border-[rgba(251,113,133,0.35)] bg-[rgba(7,11,20,0.55)]">
            <span
              id="top-bar-mic-level-fill"
              className="block h-full w-0 origin-left bg-[linear-gradient(90deg,#4ade80_0%,#facc15_55%,#f87171_100%)] transition-[width] duration-75 ease-linear"
            />
          </span>
        </span>
        <span
          className={clsx(
            'text-[0.68rem] font-semibold text-[#fecaca] [font-variant-numeric:tabular-nums]',
            'mono',
          )}
          id="top-bar-recording-dur"
          aria-hidden="true"
        >
          00:00:00
        </span>
      </h2>
    </div>
  );

  // Desktop: equal-grow tiles across the full controls column. Mobile keeps fixed tiles.
  // `!` beats the fixed flex-basis/width utilities on the shared tile classes.
  const stripBtnDesktopGrow = 'md:min-w-(--v4-ctrl-btn-w) md:w-auto! md:max-w-none md:flex-1!';
  // Mute secondary chrome only while stopped/playing — full tiles while rolling/recording.
  const secondaryQuiet = !isRolling && !isRecording;

  const transportButtons = (
    <div
      className="flex w-auto max-w-full flex-row flex-nowrap items-center justify-end gap-[0.3rem] overflow-visible md:w-full md:justify-start"
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
        <button
          type="button"
          className={clsx(
            'relative isolate box-border grid h-(--v4-ctrl-btn-h) max-h-(--v4-ctrl-btn-h) min-h-(--v4-ctrl-btn-h) w-(--v4-ctrl-btn-w) flex-[0_0_var(--v4-ctrl-btn-w)] place-items-center overflow-hidden p-0 [--session-ctl-accent:#e2e8f0] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[rgba(56,189,248,0.55)]',
            // Phone-only hide (`!` beats other display utilities on the tile).
            'max-md:hidden!',
            stripBtnDesktopGrow,
            secondaryQuiet
              ? controlsLocked
                ? 'cursor-not-allowed rounded-v5-md border border-[rgba(148,163,184,0.12)] bg-white/[0.02] opacity-[0.55] text-[rgba(226,232,240,0.55)] shadow-none'
                : // Soft mute: light border + faint fill (half as ghostly as full transparent).
                  'cursor-pointer rounded-v5-md border border-[rgba(148,163,184,0.14)] bg-white/[0.03] text-[rgba(226,232,240,0.62)] shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] [transition:color_0.15s_ease,background_0.15s_ease,border-color_0.15s_ease] hover-always:border-[rgba(148,163,184,0.22)] hover-always:bg-white/[0.06] hover-always:text-[rgba(226,232,240,0.88)]'
              : controlsLocked
                ? 'cursor-not-allowed rounded-v5-md border border-dashed border-[rgba(148,163,184,0.14)] bg-[rgba(7,11,20,0.55)] opacity-[0.48] shadow-none'
                : 'cursor-pointer rounded-v5-md border border-[rgba(148,163,184,0.22)] [background:linear-gradient(180deg,rgba(255,255,255,0.07)_0%,rgba(255,255,255,0)_42%),linear-gradient(180deg,rgba(19,27,48,0.88),rgba(11,16,30,0.78))] shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_4px_16px_rgba(2,8,23,0.42)] [transition:border-color_0.15s_ease,box-shadow_0.15s_ease,opacity_0.15s_ease] hover-always:[border-color:color-mix(in_srgb,var(--session-ctl-accent)_28%,rgba(148,163,184,0.22))]',
          )}
          aria-label="Keyboard shortcuts"
          disabled={controlsLocked}
          onClick={onOpenShortcuts}
        >
          <span
            aria-hidden="true"
            className={clsx(
              'relative z-[1] text-[1.05rem] font-semibold leading-none',
              secondaryQuiet
                ? 'text-current'
                : 'text-[color:color-mix(in_srgb,var(--session-ctl-accent)_70%,#e2e8f0)]',
            )}
          >
            ?
          </span>
        </button>
      </Tooltip>
    </div>
  );

  // Desktop: meta → timecode → buttons (column).
  // Mobile: chrome (menu + show/status) → instruments (timecode + buttons) → timeline.
  const transportAside = (
    <aside
      className={clsx(
        'v5-session-controls-panel flex w-full min-w-0 flex-col items-stretch gap-[0.4rem] self-stretch overflow-visible',
        'md:w-[min(100%,19.25rem)] md:shrink-0 md:justify-end md:self-end',
      )}
      aria-label="Session info and transport"
    >
      {/* Identity / chrome */}
      <div className="flex min-w-0 flex-row items-center gap-2">
        {onOpenMobileNav ? (
          <button
            type="button"
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center box-border rounded-v5-sm border border-v5-border-strong bg-white/[0.04] text-v5-text cursor-pointer md:hidden"
            aria-label="Open navigation"
            onClick={onOpenMobileNav}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M4 7H20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              <path d="M4 12H20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              <path d="M4 17H15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        ) : null}
        <div className="min-w-0 flex-1">{sessionMeta}</div>
      </div>

      {/* Instruments — timecode grows into spare width; buttons keep natural size. */}
      <div className="flex min-w-0 flex-row items-center gap-2 md:contents">
        <div className={clsx('min-w-0 flex-1 md:w-full', controlsLocked && 'opacity-[0.48]')}>
          <TimecodeDisplay sessionId={sessionId} compact />
        </div>
        <div className="w-auto max-w-full shrink-0 overflow-visible md:w-full">
          {transportButtons}
        </div>
      </div>
    </aside>
  );

  return (
    <div
      id="v5-maximize-log-strip"
      className={clsx(
        'v5-maximize-log-strip min-w-0 overflow-visible box-border bg-[#050912]',
        // Mobile: full-bleed band (controls + timeline); space before feed matches
        // desktop session gap-5 (parent is max-md:block so flex gap doesn't apply).
        'mx-0 mt-0 mb-5 w-full px-3 pt-2.5 pb-3 border-b border-white/[0.06]',
        // Desktop: inset rounded band around controls + timeline.
        'md:mx-4 md:mt-3 md:mb-0 md:w-[calc(100%-2rem)] md:rounded-v5-md md:border md:border-white/[0.06] md:px-3.5 md:py-3',
        '[--v4-ctrl-btn-h:2.15rem] [--v4-ctrl-btn-w:2.35rem] [--v4-ctrl-btn-my:0] [--v4-clock-box-h:2.15rem] [--v4-clock-box-mb:0] [--v4-clock-box-mv:0] [--v4-clock-label-straddle:0.28rem]',
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
    </div>
  );
}
