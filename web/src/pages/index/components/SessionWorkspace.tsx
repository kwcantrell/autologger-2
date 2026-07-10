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
import { Tooltip } from '../../../shared/ui/Tooltip';
import { AUTOLOGGER_LOADING_VIDEO_SRC } from '../../../shared/utils/loadingVideo';
import { useAudioClips } from '../hooks/useAudioClips';
import { useRecoveryStopWarning } from '../hooks/useRecoveryStopWarning';
import { useRemoteRecordingGate } from '../hooks/useRemoteRecordingGate';
import { useWaveforms } from '../hooks/useWaveforms';
import type { AudioPlayerHandle } from './AudioPlayer';
import { AudioPlayer } from './AudioPlayer';
import type { AudioRecorderHandle } from './AudioRecorder';
import { AudioRecorder } from './AudioRecorder';
import { AudioSaveOverlay } from './AudioSaveOverlay';
import { CategoryButtonStrip } from './CategoryButtonStrip';
import { EventLogSheet } from './EventLogSheet';
import { ExportModal } from './ExportModal';
import { MarkerNav } from './MarkerNav';
import styles from './SessionWorkspace.module.css';
import { TimecodeDisplay } from './TimecodeDisplay';
import { Timeline } from './Timeline';
import { TopicsFeed } from './TopicsFeed';
import { TranscribeFeed } from './TranscribeFeed';
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
  useRecoveryStopWarning(sessionId || null, blocksMedia);
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
  const [feedTab, setFeedTab] = useState<'events' | 'transcribe' | 'topics'>('events');
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
    <section className={clsx('v3-right-wrap', styles.v6SessionStage)}>
      {showExport && sessionId && (
        <ExportModal sessionId={sessionId} onClose={() => setShowExport(false)} />
      )}
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
        className={clsx(styles.v3SessionLoading, 'hidden')}
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

      <div id="v3-session-active" className="v3-session-active-root">
        <div id="v3-session-placeholder" className={styles.v3SessionPlaceholder}>
          <p
            className={clsx(
              styles.v3SessionPlaceholderText,
              'muted',
              'animate__animated',
              'animate__pulse',
            )}
          >
            Select a session, or create a new one from the left rail.
          </p>
        </div>

        <div id="v3-session-grid" className="v4-session-workspace hidden">
          <section
            id="v4-log-session"
            className="v4-log-session is-visible"
            aria-label="Log session"
            data-v5-live-log={liveDock && sessionId ? '1' : ''}
          >
            <div className="v4-log-top v4-log-top--playback" id="v4-log-top">
              {/* Category strip — default position, shown when not rolling */}
              <div className="v4-log-top__capture">
                <div className={styles.v4RollingArea}>
                  <div className="v4-cat-buttons">
                    <div className="v4-cat-buttons__scroll" id="v4-cat-buttons-scroll-default">
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
              </div>

              <div className="v5-session-panels">
                {/* Timeline panel */}
                <section
                  className="v4-log-top__playback v5-session-timeline-panel"
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

                  {/* Live-log panel — category strip moves here while rolling */}
                  <section
                    className={styles.v5SessionLiveLog}
                    id="v5-session-live-log"
                    aria-label="Log events"
                    hidden={!liveDock}
                  >
                    <div className={clsx(styles.v5SessionLiveLogHead, 'v5-panel-head')}>
                      <div className="v5-panel-head__main">
                        <p className="v5-panel-eyebrow">Log events</p>
                      </div>
                    </div>
                    <div
                      id="cat-strip-live-slot"
                      className={styles.v5SessionLiveLogCats}
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

                {/* Controls panel — React drives status, timecode, and transport buttons */}
                <section className="v5-session-controls-panel" aria-label="Session controls">
                  <div className="v5-panel-head v5-panel-head--controls">
                    <div className="v5-panel-head__main">
                      <p className="v5-panel-eyebrow">Session Controls</p>
                      <h2
                        className="v5-panel-main-title v5-panel-main-title--status"
                        id="v5-controls-recording-head"
                        aria-live="polite"
                      >
                        <span className={styles.v5ControlsStatusLine}>
                          <span className={styles.v5ControlsStatusPrefix}>Status: </span>
                          <span
                            className={clsx(
                              styles.v5ControlsStatusValue,
                              isRecording && styles.v5ControlsStatusValueRecording,
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
                    className={clsx('v4-session-aside', styles.v5SessionControlsAside)}
                    id="v4-session-aside"
                    aria-label="Session info and controls"
                  >
                    <div className="v4-session-ctrl">
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
                      <div className={styles.v4SessionCtrlRule} role="presentation" />
                      <Tooltip content="Session ID">
                        <p
                          className={clsx(styles.v4SessionIdLine, 'mono', 'faint')}
                          id="v4-session-id-display"
                        >
                          {sessionId || '—'}
                        </p>
                      </Tooltip>
                    </div>
                  </aside>
                </section>
              </div>
            </div>

            {sessionId && (
              <div className={styles.v5FeedTabsPanel}>
                <div className={styles.v5FeedTabBar} role="tablist" aria-label="Feed tabs">
                  {(
                    [
                      { id: 'events', label: 'Event Feed' },
                      { id: 'transcribe', label: 'Transcribe Feed' },
                      { id: 'topics', label: 'Topics Feed' },
                    ] as const
                  ).map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      aria-selected={feedTab === tab.id}
                      className={clsx(
                        styles.v5FeedTab,
                        feedTab === tab.id && styles.v5FeedTabActive,
                      )}
                      onClick={() => setFeedTab(tab.id)}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
                {feedTab === 'events' && <EventLogSheet sessionId={sessionId} />}
                {feedTab === 'transcribe' && <TranscribeFeed sessionId={sessionId} />}
                {feedTab === 'topics' && <TopicsFeed sessionId={sessionId} />}
              </div>
            )}
          </section>
        </div>
      </div>
    </section>
  );
}
