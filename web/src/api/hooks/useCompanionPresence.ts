import { useEffect, useRef } from 'react';
import { getClientInstanceId } from '../../shared/utils/clientId';
import { apiFetch, apiUrl } from '../client';

const PRESENCE_INTERVAL_MS = 5_000;

/**
 * Reports this tab's presence (open session, visibility, playback state) to the server so
 * Companion can resolve "the" active session and target record/play relay commands.
 * Posts immediately, every 5s **while the tab is visible**, and on session/visibility/
 * playback change; clears via sendBeacon on pagehide. Failures are silent — presence is
 * best-effort.
 *
 * The 5s timer only runs while `document.visibilityState === 'visible'`: a hidden tab
 * posts once (so Companion learns `visible: false` the instant it happens — that report
 * is what lets it pick a different tab) and then goes quiet until it comes back. `isPlaying`
 * is read through a render-updated ref rather than an effect dependency, so a playback
 * toggle no longer tears down and re-arms the interval; a second, small effect posts once
 * on the toggle without disturbing the cadence.
 */
export function useCompanionPresence(sessionId: string | null, isPlaying: boolean): void {
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;
  /** Assigned by the main effect so the toggle effect below can post without owning the closure. */
  const postRef = useRef<() => void>(() => {});

  useEffect(() => {
    const clientId = getClientInstanceId();
    const post = () => {
      apiFetch('companion/presence', {
        method: 'POST',
        body: JSON.stringify({
          client_id: clientId,
          session_id: sessionId,
          visible: document.visibilityState === 'visible',
          is_playing: isPlayingRef.current,
        }),
      }).catch(() => {});
    };
    postRef.current = post;

    let timer: ReturnType<typeof setInterval> | null = null;
    const startTimer = () => {
      // Idempotent: a visibilitychange that does not actually change visibility
      // (or a re-fired one) must not stack a second interval.
      if (timer !== null) return;
      timer = setInterval(post, PRESENCE_INTERVAL_MS);
    };
    const stopTimer = () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };

    post();
    if (document.visibilityState === 'visible') startTimer();

    const onVisibility = () => {
      // Always report the transition immediately — hiding is exactly the moment
      // Companion needs to hear about, and it is also when the timer stops.
      post();
      if (document.visibilityState === 'visible') startTimer();
      else stopTimer();
    };
    document.addEventListener('visibilitychange', onVisibility);
    const onPageHide = () => {
      if (typeof navigator.sendBeacon !== 'function') return;
      try {
        const b = new Blob(
          [JSON.stringify({ client_id: clientId, session_id: null, closing: true })],
          { type: 'application/json' },
        );
        navigator.sendBeacon(apiUrl('companion/presence'), b);
      } catch {
        /* ignore */
      }
    };
    window.addEventListener('pagehide', onPageHide);
    return () => {
      stopTimer();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [sessionId]);

  // Immediate report on a playback toggle (Companion UX: play/pause must not
  // wait out the cadence). Skip-first-run guard expressed as a value compare —
  // seeded with the initial `isPlaying`, so the mount pass is a no-op and
  // StrictMode's double-invoked mount effect cannot post a phantom second time.
  // Deliberately does NOT touch the interval, so the cadence stays where the
  // main effect put it.
  const lastPostedPlayingRef = useRef(isPlaying);
  useEffect(() => {
    if (lastPostedPlayingRef.current === isPlaying) return;
    lastPostedPlayingRef.current = isPlaying;
    postRef.current();
  }, [isPlaying]);
}
