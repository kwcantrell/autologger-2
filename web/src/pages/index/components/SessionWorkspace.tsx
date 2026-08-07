import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../../../api/client';
import { useCompanionPresence } from '../../../api/hooks/useCompanionPresence';
import { eventsKeys, useEvents, WORKSPACE_EVENTS_LIMIT } from '../../../api/hooks/useEvents';
import { useSessionSocket } from '../../../api/hooks/useSessionSocket';
import { useSessionStatus } from '../../../api/hooks/useSessionStatus';
import type { CompanionCommandType } from '../../../api/types';
import { showToast } from '../../../shared/components/Toast';
import { useDebugTransportOverride } from '../../../shared/hooks/useDebugTransportOverride';
import { ConfirmDialog } from '../../../shared/ui/ConfirmDialog';
import { AUTOLOGGER_LOADING_VIDEO_SRC } from '../../../shared/utils/loadingVideo';
import { AudioClipsProvider } from '../hooks/AudioClipsContext';
import { useAudioClips } from '../hooks/useAudioClips';
import { useRecoveryStopWarning } from '../hooks/useRecoveryStopWarning';
import { useRemoteRecordingGate } from '../hooks/useRemoteRecordingGate';
import { useWaveforms } from '../hooks/useWaveforms';
import { REVEAL_EVENT, scrollAndFlashEventRowWithRetry } from '../utils/revealEventInFeed';
import { AiPanel } from './AiPanel';
import { AiV2Panel } from './AiV2Panel';
import type { AudioPlayerHandle } from './AudioPlayer';
import { AudioPlayer } from './AudioPlayer';
import type { AudioRecorderHandle } from './AudioRecorder';
import { AudioRecorder } from './AudioRecorder';
import { AudioSaveOverlay } from './AudioSaveOverlay';
import { EventLogSheet } from './EventLogSheet';
import { ExportFeed } from './ExportFeed';
import { feedTabButtonClassName } from './feedTabStyles';
import { MaximizeLogStrip } from './MaximizeLogStrip';
import { isTypingTarget, ShortcutsDialog } from './ShortcutsDialog';
import { TopicsFeed } from './TopicsFeed';
import { TranscribeFeed } from './TranscribeFeed';
import { getTransportState } from './TransportControls';

declare global {
  interface Window {
    AutoLogger_stopTransportIfNeeded?: () => void;
  }
}

// Feed tab inventory — one source for the tablist buttons AND the tabpanel
// wrappers below (code-health-tail 4.8). `label` doubles as each panel's
// aria-label.
const FEED_TABS = [
  { id: 'events', label: 'Event Feed' },
  { id: 'transcript', label: 'Transcript' },
  { id: 'topics', label: 'Topics' },
  { id: 'assistant', label: 'Assistant' },
  { id: 'dashboards', label: 'Dashboards' },
  { id: 'export', label: 'Export' },
] as const;

type FeedTabId = (typeof FEED_TABS)[number]['id'];

interface Props {
  sessionId: string;
  ytImportPending?: boolean;
  onOpenMobileNav?: () => void;
}

export function SessionWorkspace({ sessionId, ytImportPending, onOpenMobileNav }: Props) {
  const { data: status } = useSessionStatus(sessionId || null);

  // Wide events query feeding the timeline marker rendering.
  // EventLogSheet/MarkerNav also use useEvents; React Query dedupes the cache key per limit/offset,
  // so consumers wanting the full session share WORKSPACE_EVENTS_LIMIT (2000, the server's max limit).
  const { data: eventsRes } = useEvents(sessionId || null, { limit: WORKSPACE_EVENTS_LIMIT });
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
  // ui-refresh IA: Transcript/Topics were nested under an "AI" tab; they are
  // session DATA, so they sit beside the Event Feed now. The two agent
  // surfaces carry human names (Assistant, Dashboards) instead of "AI"/"AI v2".
  const [feedTab, setFeedTab] = useState<FeedTabId>('events');
  const feedTabRef = useRef(feedTab);
  feedTabRef.current = feedTab;
  const pendingRevealEventIdRef = useRef<string | null>(null);
  const [onOffState, setOnOffState] = useState<Map<string, 'on' | 'off'>>(new Map());
  const handleToggle = useCallback((categoryId: string) => {
    setOnOffState((prev) => {
      const next = new Map(prev);
      next.set(categoryId, prev.get(categoryId) === 'on' ? 'off' : 'on');
      return next;
    });
  }, []);

  // Timeline marker click → Event Feed tab + scroll/flash the matching row.
  // The retry loop (not a one-shot) also covers EventLogSheet growing its
  // loaded page in response to the same reveal event — the row may need a
  // fetch + render before it exists.
  const cancelRevealRetryRef = useRef<(() => void) | null>(null);
  const runReveal = useCallback((eventId: string) => {
    cancelRevealRetryRef.current?.();
    cancelRevealRetryRef.current = scrollAndFlashEventRowWithRetry(eventId);
  }, []);
  useEffect(() => {
    const onReveal = (ev: Event) => {
      const eventId = String(
        (ev as CustomEvent<{ eventId?: string }>).detail?.eventId ?? '',
      ).trim();
      if (!eventId) return;
      if (feedTabRef.current === 'events') {
        runReveal(eventId);
        return;
      }
      pendingRevealEventIdRef.current = eventId;
      setFeedTab('events');
    };
    document.body.addEventListener(REVEAL_EVENT, onReveal);
    return () => {
      document.body.removeEventListener(REVEAL_EVENT, onReveal);
      cancelRevealRetryRef.current?.();
      cancelRevealRetryRef.current = null;
    };
  }, [runReveal]);

  useEffect(() => {
    if (feedTab !== 'events') return;
    const eventId = pendingRevealEventIdRef.current;
    if (!eventId) return;
    pendingRevealEventIdRef.current = null;
    // Wait for the tabpanel to drop `hidden` before scrolling.
    window.requestAnimationFrame(() => runReveal(eventId));
  }, [feedTab, runReveal]);

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

  // Play-capable counterpart for feed row jumps (feed-row-seek design D1, D8): unlike
  // AutoLogger_seekAudio above (non-playing; MarkerNav's path), this always ends up
  // playing — starting playback on a paused player, continuing on a playing one. The
  // useTimelineSeek hook is the only intended caller; MarkerNav must keep using the
  // non-playing global.
  useEffect(() => {
    window.AutoLogger_seekAudioAndPlay = (sec: number) => {
      audioPlayerRef.current?.seekToTimelineSecAndPlay(sec);
    };
    return () => {
      window.AutoLogger_seekAudioAndPlay = undefined;
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

  // One panel per feed tab, keyed to FEED_TABS (code-health-tail 4.8). All
  // six render every pass — the wrapper map below hides, never unmounts.
  const feedPanels: Record<FeedTabId, ReactNode> = {
    events: <EventLogSheet sessionId={sessionId} />,
    transcript: <TranscribeFeed sessionId={sessionId} />,
    topics: <TopicsFeed sessionId={sessionId} />,
    assistant: <AiPanel sessionId={sessionId} />,
    // `key={sessionId}` (whole-branch audit fix wave, Fix 1): forces a remount
    // on SESSION change only — orthogonal to the tab-mount discipline below,
    // which never remounts on a tab switch. Without it, `useSession`'s
    // `staleTime: Infinity` lets navigating between two already-cached
    // sessions update this `sessionId` prop without remounting, leaking
    // `editingDashboard`/`proposedDashboard`/`proposedDashboardTurnId`/
    // `messages`/`pendingQuestion` from the prior session (a not-yet-Kept
    // proposal from session A could be Kept onto session B).
    dashboards: <AiV2Panel key={sessionId} sessionId={sessionId} />,
    export: <ExportFeed sessionId={sessionId} />,
  };

  return (
    // AudioClipsProvider (whole-branch audit fix wave, finding C1/I3): the ONE
    // `useAudioClips` layout computed above, published for `useTimelineSeek`
    // (consumed deep inside EventLogSheet/TranscribeFeed/TopicsFeed) to read
    // instead of each feed computing its own — see AudioClipsContext.tsx.
    <AudioClipsProvider clips={audioClips}>
      {
        // v3-right-wrap (SW-rendered) resolved under its always-present
        // `.main-v3.v3-layout-session-focus` ancestor + the former `.v6SessionStage`
        // hashed local, both on this element. The min-height:0 !important quintet
        // rule (`.main-v3 .v3-right-wrap`) beats the focus rule's calc() via !important
        // → min-h-0. The `.v3-right-wrap` class string stays (retention).
      }
      <section className="v3-right-wrap relative flex min-h-0 w-full min-w-0 flex-1 flex-col [overflow-x:clip] overflow-y-visible [isolation:isolate] z-0">
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
            {/* #v4-log-session — ancestor id retained (drives descendant
              [#v4-log-session_&] variants; perfDebug/e2e hooks target it).
              is-visible is always present here so display resolves to flex. min-h-0
              !important quintet member; max-md reflows to block. */}
            <section
              id="v4-log-session"
              className="v4-log-session is-visible flex flex-col flex-1 w-full max-w-full min-w-0 min-h-0 max-h-none gap-5 [overflow-x:clip] overflow-y-visible max-md:block max-md:h-auto"
              aria-label="Log session"
            >
              {/* Sole fused strip — always mounted; roll/rec only swaps the scrub lane. */}
              <div
                className="v4-log-top v4-log-top--playback flex flex-col w-full max-w-full flex-[0_0_auto] shrink-0 h-auto max-h-none p-0 gap-2 mt-0 bg-transparent border-none rounded-none shadow-none box-border overflow-visible"
                id="v4-log-top"
              >
                <MaximizeLogStrip
                  sessionId={sessionId}
                  status={status ?? null}
                  events={events}
                  audioClips={audioClips}
                  totalSec={audioTotalSec}
                  mergedPeaks={mergedPeaks}
                  isWaveformDecoding={isWaveformDecoding}
                  audioPlaybackSec={audioPlaybackSec}
                  onSeekAudio={handleSeekAudio}
                  onAudioRecord={handleAudioRecord}
                  onAudioPlay={handleAudioPlay}
                  ytImportPending={ytImportPending}
                  isPlaying={isPlaying}
                  onOpenShortcuts={() => setShowShortcuts(true)}
                  liveDock={liveDock}
                  onOffState={onOffState}
                  onToggle={handleToggle}
                  statusText={statusText}
                  isRecording={isRecording}
                  isRolling={isRolling}
                  onOpenMobileNav={onOpenMobileNav}
                />
              </div>

              {sessionId && (
                // v5FeedTabsPanel literal retained: the sheet-corner-flatten rule
                // (reaches into FeedShell's `.v4-log-sheet.v5-event-feed`) is an
                // @layer components rule scoped by this ancestor class.
                <div className="v5FeedTabsPanel flex flex-col flex-[1_1_0] min-h-0">
                  {/* Tabs share the sheet's mx-4 edge — no extra pad — so the lid
                      aligns with the feed container. */}
                  <div className="relative z-0 mx-4 flex shrink-0 items-end pt-[0.3rem] max-md:overflow-x-auto max-md:overflow-y-hidden max-md:[-webkit-overflow-scrolling:touch] max-md:[scrollbar-width:none]">
                    <div
                      className="flex min-w-0 flex-1 flex-nowrap items-end gap-[0.12rem]"
                      role="tablist"
                      aria-label="Feed tabs"
                    >
                      {FEED_TABS.map((tab) => {
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
                  </div>
                  {/* All six top-level panels stay mounted (hidden via the
                    `hidden` attribute), not conditionally rendered: switching
                    tabs must not unmount AiPanel's hoisted chat state/stream
                    or AiV2Panel's hoisted design-turn state/stream (design
                    D9; ai-v2-dashboards spec "AI v2 tab in the session
                    workspace" — a conditional mount here would abort an
                    in-flight turn per the subprocess lifecycle rule).
                    Transcript/Topics/Export inherit the same discipline so their
                    fetch state stays warm across switches. */}
                  {FEED_TABS.map((tab) => (
                    <div
                      key={tab.id}
                      className={clsx(
                        // Stack above the tablist so tabs tuck behind the feed
                        // sheet edge (tablist is z-0; sheet CSS also uses z-1).
                        'relative z-[1] flex flex-col flex-1 min-h-0',
                        feedTab !== tab.id && 'hidden',
                      )}
                      hidden={feedTab !== tab.id}
                      role="tabpanel"
                      aria-label={tab.label}
                    >
                      {feedPanels[tab.id]}
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        </div>
      </section>
    </AudioClipsProvider>
  );
}
