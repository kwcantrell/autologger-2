import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../../../api/client';
import { useCompanionPresence } from '../../../api/hooks/useCompanionPresence';
import { eventsKeys, useEvents } from '../../../api/hooks/useEvents';
import { useSessionSocket } from '../../../api/hooks/useSessionSocket';
import { useSessionStatus } from '../../../api/hooks/useSessionStatus';
import type { CompanionCommandType } from '../../../api/types';
import { showToast } from '../../../shared/components/Toast';
import { useDebugTransportOverride } from '../../../shared/hooks/useDebugTransportOverride';
import { ConfirmDialog } from '../../../shared/ui/ConfirmDialog';
import { Tooltip } from '../../../shared/ui/Tooltip';
import { AUTOLOGGER_LOADING_VIDEO_SRC } from '../../../shared/utils/loadingVideo';
import { useAudioClips } from '../hooks/useAudioClips';
import { useRecoveryStopWarning } from '../hooks/useRecoveryStopWarning';
import { useRemoteRecordingGate } from '../hooks/useRemoteRecordingGate';
import { useWaveforms } from '../hooks/useWaveforms';
import { AiPanel } from './AiPanel';
import { AiV2Panel } from './AiV2Panel';
import type { AudioPlayerHandle } from './AudioPlayer';
import { AudioPlayer } from './AudioPlayer';
import type { AudioRecorderHandle } from './AudioRecorder';
import { AudioRecorder } from './AudioRecorder';
import { AudioSaveOverlay } from './AudioSaveOverlay';
import { CategoryButtonStrip } from './CategoryButtonStrip';
import { EventLogSheet } from './EventLogSheet';
import { ExportModal } from './ExportModal';
import { feedTabButtonClassName } from './feedTabStyles';
import { MarkerNav } from './MarkerNav';
import { isTypingTarget, ShortcutsDialog } from './ShortcutsDialog';
import { TimecodeDisplay } from './TimecodeDisplay';
import { Timeline } from './Timeline';
import { getTransportState, TransportControls } from './TransportControls';

declare global {
  interface Window {
    AutoLogger_stopTransportIfNeeded?: () => void;
  }
}

interface Props {
  sessionId: string;
  ytImportPending?: boolean;
}

export function SessionWorkspace({ sessionId, ytImportPending }: Props) {
  const { data: status } = useSessionStatus(sessionId || null);

  // Wide events query — also feeds session.js's timeline marker rendering.
  // EventLogSheet/MarkerNav also use useEvents; React Query dedupes the cache key per limit/offset,
  // so this is a separate query that loads all events for the timeline. 2000 is the server's max limit.
  const { data: eventsRes } = useEvents(sessionId || null, { limit: 2000 });
  const events = eventsRes?.events ?? [];

  const { clips: audioClips, totalSec: audioTotalSec, segments } = useAudioClips(sessionId, events);

  const debugOverride = useDebugTransportOverride();
  const blocksMedia = useRemoteRecordingGate(sessionId || null);
  const recoveryStopPending = useRecoveryStopWarning(sessionId || null, blocksMedia);
  const { mergedPeaks, isDecoding: isWaveformDecoding } = useWaveforms(
    sessionId,
    audioClips,
    audioTotalSec,
  );

  const [isPlaying, setIsPlaying] = useState(false);
  const [audioPlaybackSec, setAudioPlaybackSec] = useState<number | null>(null);
  const isRolling = Boolean(status?.is_rolling);
  const isRecording = Boolean(status?.audio_recording_lease_alive);

  const transportState = debugOverride ?? getTransportState(isRolling, isRecording);
  const intrinsicState = isRecording
    ? 'audio-recording'
    : isRolling
      ? 'rolling'
      : isPlaying
        ? 'play'
        : 'stop';
  const effectiveTransport = debugOverride ?? intrinsicState;
  const liveDock = effectiveTransport === 'rolling' || effectiveTransport === 'audio-recording';

  const statusText =
    transportState === 'audio-recording'
      ? 'Recording'
      : transportState === 'rolling'
        ? 'Rolling'
        : 'Stopped';

  // Set body.dataset.v4Transport — CSS reads this to swap capture/playback panels.
  useEffect(() => {
    document.body.dataset.v4Transport = effectiveTransport;
  }, [effectiveTransport]);

  const [showExport, setShowExport] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);

  // "?" opens the keyboard-shortcut reference (ui-refresh) — never while typing
  // or while another dialog is up. Ctrl/Meta/Alt excluded; Shift deliberately
  // permitted (it is how "?" is typed on most layouts).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '?' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      if (document.querySelector('[role="dialog"]')) return;
      e.preventDefault();
      setShowShortcuts(true);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const [feedTab, setFeedTab] = useState<'events' | 'ai' | 'ai-v2'>('events');
  const [onOffState, setOnOffState] = useState<Map<string, 'on' | 'off'>>(new Map());
  const handleToggle = useCallback((categoryId: string) => {
    setOnOffState((prev) => {
      const next = new Map(prev);
      next.set(categoryId, prev.get(categoryId) === 'on' ? 'off' : 'on');
      return next;
    });
  }, []);

  const audioRecorderRef = useRef<AudioRecorderHandle>(null);
  const audioPlayerRef = useRef<AudioPlayerHandle>(null);
  const [isUploadingAudio, setIsUploadingAudio] = useState(false);

  const handleAudioRecord = useCallback(() => {
    audioRecorderRef.current?.toggle();
  }, []);

  const handleAudioPlay = useCallback(() => {
    audioPlayerRef.current?.toggle();
  }, []);

  const handleSeekAudio = useCallback((sec: number) => {
    audioPlayerRef.current?.seekToTimelineSec(sec);
  }, []);

  // Companion (Stream Deck) relay: report presence; execute relayed record/play commands.
  useCompanionPresence(sessionId || null, isPlaying);
  const executeRemoteCommand = useCallback(
    async (type: CompanionCommandType) => {
      if (type === 'play-toggle') {
        if (segments.length === 0) return { ok: false, error: 'No audio segments.' };
        audioPlayerRef.current?.toggle();
        showToast('Companion: play/pause');
        return { ok: true };
      }
      const recording = audioRecorderRef.current?.isRecording() ?? false;
      if (type === 'record-start' && recording) return { ok: true };
      if (type === 'record-stop' && !recording) return { ok: true };
      const starting = !recording;
      if (starting && blocksMedia) {
        return { ok: false, error: 'Another client holds the recording lease.' };
      }
      if (!audioRecorderRef.current) return { ok: false, error: 'Recorder unavailable.' };
      const ok = await audioRecorderRef.current.toggle();
      showToast(
        `Companion: ${starting ? 'record start' : 'record stop'}${ok ? '' : ' failed'}`,
        !ok,
      );
      return ok
        ? { ok: true }
        : {
            ok: false,
            error: starting
              ? 'Could not start recording (lease or microphone).'
              : 'Could not stop recording.',
          };
    },
    [blocksMedia, segments.length],
  );
  // The per-session DO WebSocket drives event/transport/audio/lease invalidation and
  // relays Companion record/play commands (replaces the deleted polls + long-poll relay).
  useSessionSocket(sessionId || null, { executeCommand: executeRemoteCommand });

  // Expose seek so timeline scrub and marker jumps drive the React audio player.
  useEffect(() => {
    window.AutoLogger_seekAudio = (sec: number) => {
      audioPlayerRef.current?.seekToTimelineSec(sec);
    };
    return () => {
      window.AutoLogger_seekAudio = undefined;
    };
  }, []);

  // Expose transport-stop for AppShell to call (fire-and-forget) before closing a session.
  useEffect(() => {
    if (!sessionId || blocksMedia || !isRolling) {
      window.AutoLogger_stopTransportIfNeeded = undefined;
      return;
    }
    window.AutoLogger_stopTransportIfNeeded = () => {
      apiFetch(`sessions/${encodeURIComponent(sessionId)}/transport/stop`, {
        method: 'POST',
      }).catch(() => {});
    };
    return () => {
      window.AutoLogger_stopTransportIfNeeded = undefined;
    };
  }, [sessionId, isRolling, blocksMedia]);

  // Event invalidation is driven by the WS `event.changed` frame (useSessionSocket),
  // replacing the old events_stream_revision /status watcher.
  const qc = useQueryClient();

  // Allow external callers (e.g., recovery-stop flow) to force a refetch of events.
  useEffect(() => {
    window.AutoLogger_invalidateEvents = () => {
      if (sessionId) qc.invalidateQueries({ queryKey: eventsKeys.all(sessionId) });
    };
    return () => {
      window.AutoLogger_invalidateEvents = undefined;
    };
  }, [sessionId, qc]);

  return (
    // v3-right-wrap (SW-rendered) resolved under its always-present
    // `.main-v3.v3-layout-session-focus` ancestor + the former `.v6SessionStage`
    // hashed local, both on this element. The min-height:0 !important quintet
    // rule (`.main-v3 .v3-right-wrap`) beats the focus rule's calc() via !important
    // → min-h-0. The `.v3-right-wrap` class string stays (retention).
    <section className="v3-right-wrap relative flex min-h-0 w-full min-w-0 flex-1 flex-col [overflow-x:clip] overflow-y-visible [isolation:isolate] z-0">
      {showExport && sessionId && (
        <ExportModal sessionId={sessionId} onClose={() => setShowExport(false)} />
      )}
      {/* Orphan-recording recovery warning (ui-refresh D13): themed replacement for the
          blocking window.confirm this used to render through. The hook re-validates the
          orphan + lease at accept-time and no-ops if either resolved in the meantime. */}
      {recoveryStopPending && (
        <ConfirmDialog
          open
          title={recoveryStopPending.title}
          message={recoveryStopPending.message}
          confirmLabel="Add synthetic stop"
          cancelLabel="Cancel"
          onConfirm={recoveryStopPending.onAccept}
          onCancel={recoveryStopPending.onDecline}
        />
      )}
      <ShortcutsDialog open={showShortcuts} onClose={() => setShowShortcuts(false)} />
      {/* Headless audio components */}
      {sessionId && (
        <>
          <AudioRecorder
            ref={audioRecorderRef}
            sessionId={sessionId}
            onPhaseChange={(phase) => setIsUploadingAudio(phase === 'uploading')}
          />
          <AudioPlayer
            ref={audioPlayerRef}
            segments={segments}
            clips={audioClips}
            onPlayingChange={setIsPlaying}
            onPlaybackSecChange={setAudioPlaybackSec}
          />
          <AudioSaveOverlay isUploading={isUploadingAudio} />
        </>
      )}

      <div
        id="v3-session-loading"
        /* `v3SessionLoading` string retained so the loading-video contextual @layer
         * rules (template-string media DOM) target this overlay; box styling inline. */
        className="v3SessionLoading hidden absolute inset-0 z-30 flex items-center justify-center bg-[rgba(15,17,22,0.56)] rounded-[10px] border border-border text-[0.9rem]"
        role="status"
        aria-busy={true}
        aria-live="polite"
        aria-label="Loading"
      >
        <div className="autologger-loading-video" data-autologger-animated-logo-loop="">
          <video
            className="autologger-loading-video__media"
            src={AUTOLOGGER_LOADING_VIDEO_SRC}
            preload="auto"
            muted
            playsInline
            disablePictureInPicture
          />
        </div>
      </div>

      {/* v3-session-active-root: desktop flex column filling the viewport; max-md
          reflows to plain block flow (see the column-reflow group below). */}
      <div
        id="v3-session-active"
        className="v3-session-active-root relative flex flex-1 flex-col [overflow-x:clip] overflow-y-visible min-h-[calc(100vh-2.2rem)] max-md:block max-md:min-h-0 max-md:h-auto"
      >
        {/* #v3-session-grid.v4-session-workspace — min-h-0 !important quintet
            member; desktop flex column, max-md plain block. The empty-id
            placeholder branch (`#v3-session-placeholder`) that used to swap
            against this element is retired (design D10, GATE-OVERRIDDEN):
            SessionRoute now gates the workspace mount on a resolved session,
            so SessionWorkspace only ever mounts with a session id and this
            grid no longer needs the `!sessionId` hidden toggle. */}
        <div
          id="v3-session-grid"
          className="v4-session-workspace flex flex-col flex-1 w-full min-w-0 items-stretch min-h-0 max-h-none [overflow-x:clip] overflow-y-visible max-md:block max-md:h-auto"
        >
          {/* #v4-log-session — ancestor id retained (drives descendant [#v4-log-session_&]
              variants + [data-v5-live-log] variants; perfDebug/e2e hooks target it).
              is-visible is always present here so display resolves to flex. min-h-0
              !important quintet member; max-md reflows to block. */}
          <section
            id="v4-log-session"
            className="v4-log-session is-visible flex flex-col flex-1 w-full max-w-full min-w-0 min-h-0 max-h-none gap-5 [overflow-x:clip] overflow-y-visible max-md:block max-md:h-auto"
            aria-label="Log session"
            data-v5-live-log={liveDock && sessionId ? '1' : ''}
          >
            {/* .v4-log-top.v4-log-top--playback under #v4-log-session — playback deck.
                width:100vw base overridden to 100%; padding zeroed by --playback. */}
            <div
              className="v4-log-top v4-log-top--playback flex flex-col w-full max-w-full flex-[0_0_auto] shrink-0 h-auto min-h-[calc(var(--v4-log-top-h)+4*var(--v4-nav-grid-my,0.5rem))] max-h-none p-0 gap-4 mt-0 bg-transparent border-none rounded-none shadow-none box-border overflow-visible"
              id="v4-log-top"
            >
              {/* Category strip — default position, visible in every non-live
                  transport state (ui-refresh: the stop/play states now show it too —
                  see the body[data-v4-transport] block in tailwind.css). Buttons are
                  disabled until rolling; the hint below names the reason so a stopped
                  session teaches the core loop instead of hiding it. */}
              <div className="v4-log-top__capture flex-1 flex-col min-h-0">
                {/* v4RollingArea */}
                <div className="flex flex-row items-stretch gap-4 flex-1 min-h-0">
                  <div className="v4-cat-buttons flex flex-row items-center flex-1 min-w-0 min-h-[var(--v4-cat-btn-h)]">
                    <div
                      className="v4-cat-buttons__scroll flex flex-row flex-nowrap items-center justify-evenly gap-3 w-full min-h-[var(--v4-cat-btn-h)] px-1 overflow-x-auto overflow-y-hidden [-webkit-overflow-scrolling:touch]"
                      id="v4-cat-buttons-scroll-default"
                    >
                      {!liveDock && sessionId && (
                        <CategoryButtonStrip
                          sessionId={sessionId}
                          isRolling={false}
                          onOffState={onOffState}
                          onToggle={handleToggle}
                        />
                      )}
                    </div>
                  </div>
                </div>
                {!liveDock && sessionId && (
                  <p className="m-0 mt-[0.45rem] w-full px-1 text-center text-[0.78rem] leading-[1.4] text-v5-muted">
                    Logging buttons enable while timecode rolls — press{' '}
                    <strong className="font-semibold text-v5-text">Roll</strong> in Session Controls
                    to start.
                  </p>
                )}
              </div>

              {/* v5-session-panels — row of two glass panels (timeline | controls);
                  max-md stacks to a column. */}
              <div className="v5-session-panels flex flex-row items-start gap-4 w-full min-w-0 box-border max-md:flex-col max-md:items-stretch">
                {/* Timeline glass panel. The id+2class rule set display:flex
                    unconditionally, so `flex` is safe inline; the base
                    .v4-log-top__playback display:none (transport @layer) loses to it. */}
                <section
                  className="v4-log-top__playback v5-session-timeline-panel flex flex-col flex-1 min-w-0 justify-start gap-[0.55rem] mt-0 ml-4 relative overflow-visible p-6 rounded-v5-lg glass-face border border-v5-border panel-elevate box-border max-md:mr-4"
                  id="v5-session-timeline-panel"
                  aria-label="Session timeline"
                >
                  <Timeline
                    sessionId={sessionId}
                    status={status ?? null}
                    events={events}
                    audioClips={audioClips}
                    totalSec={audioTotalSec}
                    mergedPeaks={mergedPeaks}
                    isWaveformDecoding={isWaveformDecoding}
                    audioPlaybackSec={audioPlaybackSec}
                    onSeekAudio={handleSeekAudio}
                    onExport={() => setShowExport(true)}
                    hidden={liveDock}
                  />

                  {/* Live-log panel — category strip moves here while rolling. The
                      old `.v5SessionLiveLog[hidden] { display:none !important }` rule
                      is replaced by a clsx branch: hidden → `hidden` (beats base flex);
                      shown → the flex column. */}
                  <section
                    className={clsx(
                      'w-full box-border',
                      liveDock ? 'flex flex-col flex-1 min-h-0' : 'hidden',
                    )}
                    id="v5-session-live-log"
                    aria-label="Log events"
                    hidden={!liveDock}
                  >
                    {/* v5SessionLiveLogHead is a v5-panel-head; margin-bottom:0 override
                        (the `.v5SessionLiveLogHead:global(.v5-panel-head)` rule) applied
                        inline as mb-0, winning over the multi-emitter panel-head base. */}
                    <div className="v5-panel-head flex-[0_0_auto] w-full box-border mb-0">
                      <div className="v5-panel-head__main">
                        <p className="v5-panel-eyebrow">Log events</p>
                      </div>
                    </div>
                    <div
                      id="cat-strip-live-slot"
                      className="flex-1 min-h-0 w-full min-w-0 overflow-x-hidden overflow-y-auto [-webkit-overflow-scrolling:touch] box-border"
                      role="toolbar"
                      aria-label="Log category"
                    >
                      {liveDock && sessionId && (
                        <CategoryButtonStrip
                          sessionId={sessionId}
                          isRolling={true}
                          onOffState={onOffState}
                          onToggle={handleToggle}
                        />
                      )}
                    </div>
                  </section>
                </section>

                {/* Controls panel — fixed --v5-aside-w basis on desktop; max-md fills
                    the stacked column width. */}
                <section
                  className="v5-session-controls-panel flex flex-col items-stretch flex-[0_0_min(var(--v5-aside-w),100%)] w-[min(var(--v5-aside-w),100%)] max-w-[min(var(--v5-aside-w),100%)] min-w-0 gap-[0.35rem] mr-4 relative overflow-visible p-6 rounded-v5-lg glass-face border border-v5-border panel-elevate text-left box-border max-md:flex-[0_0_auto] max-md:w-auto max-md:max-w-none max-md:ml-4"
                  aria-label="Session controls"
                >
                  <div className="v5-panel-head v5-panel-head--controls">
                    <div className="v5-panel-head__actions absolute top-[0.85rem] right-[1.1rem]">
                      <Tooltip content="Keyboard shortcuts (?)">
                        <button
                          type="button"
                          className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-[0.5rem] border border-v5-border-strong bg-white/[0.04] p-0 text-v5-muted [transition:border-color_0.15s_ease,color_0.15s_ease,background_0.15s_ease] hover-always:border-[color-mix(in_srgb,var(--v5-primary)_35%,var(--v5-border-strong))] hover-always:text-v5-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[rgba(56,189,248,0.55)]"
                          aria-label="Keyboard shortcuts"
                          onClick={() => setShowShortcuts(true)}
                        >
                          <svg
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            aria-hidden="true"
                          >
                            <rect
                              x="3"
                              y="6.5"
                              width="18"
                              height="11"
                              rx="2"
                              stroke="currentColor"
                              strokeWidth="1.6"
                            />
                            <path
                              d="M6.5 10H6.51M10 10H10.01M13.5 10H13.51M17 10H17.01M6.5 13.5H6.51M17 13.5H17.01M9.5 13.5H14.5"
                              stroke="currentColor"
                              strokeWidth="1.6"
                              strokeLinecap="round"
                            />
                          </svg>
                        </button>
                      </Tooltip>
                    </div>
                    <div className="v5-panel-head__main">
                      <p className="v5-panel-eyebrow">Session Controls</p>
                      {/* --status title: base main-title in the multi-emitter @layer;
                          the status class strings stay retained for nothing external,
                          so they're dropped — inline utilities carry the styling. */}
                      <h2
                        className="v5-panel-main-title v5-panel-main-title--status"
                        id="v5-controls-recording-head"
                        aria-live="polite"
                      >
                        {/* `[display:inline]` NOT `inline`: the bare `inline` utility
                            string collides with chrome.css's legacy `.inline` class
                            (font-size:.85rem, color:muted, display:inline-flex!important),
                            which would shrink the status text — see chrome.css comment. */}
                        <span className="[display:inline]">
                          <span className="text-v5-muted font-medium">Status: </span>
                          {isRecording && (
                            <span
                              className="mr-[0.35rem] inline-block h-2 w-2 rounded-full bg-[#ef4444] shadow-[0_0_8px_rgba(239,68,68,0.55)] animate-wf-label-pulse motion-reduce:animate-none"
                              aria-hidden="true"
                            />
                          )}
                          <span
                            className={clsx(
                              'font-semibold',
                              isRecording ? 'text-[#ef4444]' : 'text-v5-text',
                            )}
                            id="v5-controls-status-value"
                          >
                            {statusText}
                          </span>
                        </span>
                      </h2>
                    </div>
                  </div>

                  <aside
                    className="v4-session-aside w-full max-w-full min-w-0 self-stretch flex-1 flex flex-col items-stretch bg-transparent border-none shadow-none rounded-none box-border"
                    id="v4-session-aside"
                    aria-label="Session info and controls"
                  >
                    {/* v4-session-ctrl — under the controls panel, align-items:stretch. */}
                    <div className="v4-session-ctrl flex flex-1 flex-col items-stretch min-h-0">
                      {sessionId && <TimecodeDisplay sessionId={sessionId} />}
                      {sessionId && <MarkerNav sessionId={sessionId} />}
                      {sessionId && (
                        <TransportControls
                          sessionId={sessionId}
                          onAudioRecord={handleAudioRecord}
                          onAudioPlay={handleAudioPlay}
                          ytImportPending={ytImportPending}
                          isPlaying={isPlaying}
                        />
                      )}
                      {/* Divider rule — background var(--v5-line) wins (later rule);
                          under controls panel align-self:stretch, max-width:none. */}
                      <div
                        className="h-px m-0 border-none shrink-0 bg-v5-line self-stretch max-w-none"
                        role="presentation"
                      />
                      <Tooltip content="Copy session ID">
                        {/* Session-id line (ui-refresh): now an explicit copy chip —
                            the old <p> was silently click-to-copy with nothing
                            indicating it. Same mono/faint look, plus a copy glyph
                            and hover/focus affordance. Clipboard-unavailable
                            (non-secure LAN origins) reports failure instead of
                            silently no-oping (spec: never a silent no-op). */}
                        <button
                          type="button"
                          className={clsx(
                            'mt-[0.65rem] mb-0 inline-flex max-w-full min-w-0 cursor-pointer items-center gap-[0.4rem] self-start border-0 bg-transparent p-0 text-left text-[0.67rem] leading-[1.35] text-v5-soft [word-break:break-all] transition-colors hover-always:text-v5-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[rgba(56,189,248,0.55)]',
                            'mono',
                            'faint',
                          )}
                          id="v4-session-id-display"
                          aria-label="Copy session ID"
                          onClick={() => {
                            if (!sessionId) return;
                            if (!navigator.clipboard?.writeText) {
                              showToast(
                                'Clipboard unavailable on this origin — select and copy the ID manually.',
                                true,
                              );
                              return;
                            }
                            navigator.clipboard
                              .writeText(sessionId)
                              .then(() => showToast('Session ID copied.'))
                              .catch(() => showToast('Copy failed.', true));
                          }}
                        >
                          <span className="min-w-0 select-text">{sessionId || '—'}</span>
                          <svg
                            width="12"
                            height="12"
                            viewBox="0 0 24 24"
                            fill="none"
                            aria-hidden="true"
                            className="shrink-0 opacity-70"
                          >
                            <rect
                              x="9"
                              y="9"
                              width="11"
                              height="11"
                              rx="2"
                              stroke="currentColor"
                              strokeWidth="1.8"
                            />
                            <path
                              d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5V4.5A1.5 1.5 0 0 1 4.5 3H13.5A1.5 1.5 0 0 1 15 4.5V5"
                              stroke="currentColor"
                              strokeWidth="1.8"
                              strokeLinecap="round"
                            />
                          </svg>
                        </button>
                      </Tooltip>
                    </div>
                  </aside>
                </section>
              </div>
            </div>

            {sessionId && (
              // v5FeedTabsPanel literal retained: the sheet-corner-flatten rule
              // (reaches into FeedShell's `.v4-log-sheet.v5-event-feed`) is an
              // @layer components rule scoped by this ancestor class.
              <div className="v5FeedTabsPanel flex flex-col flex-[1_1_0] min-h-0">
                <div
                  className="flex shrink-0 items-end gap-[0.18rem] mx-4 -mb-px px-[0.65rem] pt-[0.45rem] relative z-[2]"
                  role="tablist"
                  aria-label="Feed tabs"
                >
                  {(
                    [
                      { id: 'events', label: 'Event Feed' },
                      { id: 'ai', label: 'AI' },
                      { id: 'ai-v2', label: 'AI v2' },
                    ] as const
                  ).map((tab) => {
                    const active = feedTab === tab.id;
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        className={feedTabButtonClassName(active)}
                        onClick={() => setFeedTab(tab.id)}
                      >
                        {tab.label}
                      </button>
                    );
                  })}
                </div>
                {/* All three top-level panels stay mounted (hidden via the
                    `hidden` attribute), not conditionally rendered: switching
                    tabs must not unmount AiPanel's hoisted chat state/stream
                    or AiV2Panel's hoisted design-turn state/stream (design
                    D9; ai-v2-dashboards spec "AI v2 tab in the session
                    workspace" — a conditional mount here would abort an
                    in-flight turn per the subprocess lifecycle rule). */}
                <div
                  className={clsx('flex flex-col flex-1 min-h-0', feedTab !== 'events' && 'hidden')}
                  hidden={feedTab !== 'events'}
                  role="tabpanel"
                  aria-label="Event Feed"
                >
                  <EventLogSheet sessionId={sessionId} />
                </div>
                <div
                  className={clsx('flex flex-col flex-1 min-h-0', feedTab !== 'ai' && 'hidden')}
                  hidden={feedTab !== 'ai'}
                  role="tabpanel"
                  aria-label="AI"
                >
                  <AiPanel sessionId={sessionId} />
                </div>
                <div
                  className={clsx('flex flex-col flex-1 min-h-0', feedTab !== 'ai-v2' && 'hidden')}
                  hidden={feedTab !== 'ai-v2'}
                  role="tabpanel"
                  aria-label="AI v2"
                >
                  {/* `key={sessionId}` (whole-branch audit fix wave, Fix 1):
                      forces a remount on SESSION change only — orthogonal to
                      the tab-mount discipline above, which never remounts on
                      a tab switch. Without it, `useSession`'s
                      `staleTime: Infinity` lets navigating between two
                      already-cached sessions update this `sessionId` prop
                      without remounting, leaking `editingDashboard`/
                      `proposedDashboard`/`proposedDashboardTurnId`/
                      `messages`/`pendingQuestion` from the prior session
                      (a not-yet-Kept proposal from session A could be Kept
                      onto session B). */}
                  <AiV2Panel key={sessionId} sessionId={sessionId} />
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </section>
  );
}
