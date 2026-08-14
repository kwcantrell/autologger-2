import { useEffect, useRef } from 'react';
import { getClientInstanceId } from '../../shared/utils/clientId';
import { apiFetch, apiUrl } from '../client';

const PRESENCE_INTERVAL_VISIBLE_MS = 5_000;
// A hidden tab keeps heartbeating, just half as often. It MUST stay under the server's
// PRESENCE_FRESH_MS = 15_000 (server/src/node/presence.ts): entries older than that are
// pruned, and Companion's primarySession()/requireActiveSession only see fresh entries —
// so a hidden tab that stopped posting would 409 ("No active session") every Companion
// command ~15s after backgrounding, even with the WS up and a recording rolling. 10s
// leaves 5s of margin for hidden-tab timer throttling (browsers clamp background timers
// to >=1s and align them to 1s boundaries; chained/late timers can slip further).
const PRESENCE_INTERVAL_HIDDEN_MS = 10_000;

/**
 * Reports this tab's presence (open session, visibility, playback state) to the server so
 * Companion can resolve "the" active session and target record/play relay commands.
 * Posts immediately, then on a cadence — every 5s while the tab is visible, every 10s
 * while it is hidden — and on session/visibility/playback change; clears via sendBeacon
 * on pagehide. Failures are silent — presence is best-effort.
 *
 * A hidden tab still heartbeats, because the server prunes presence entries at
 * PRESENCE_FRESH_MS (15s) and Companion refuses commands without a fresh entry; the win
 * over the old unconditional 5s timer is *reduced* background traffic, not zero. The
 * visibility transition itself is always reported immediately (so Companion learns
 * `visible: false` the instant it happens — that report is what lets it pick a different
 * tab). `isPlaying` is read through a render-updated ref rather than an effect dependency,
 * so a playback toggle no longer tears down and re-arms the interval; a second, small
 * effect posts once on the toggle without disturbing the cadence.
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
    let timerPeriod = 0;
    const cadenceMs = () =>
      document.visibilityState === 'visible'
        ? PRESENCE_INTERVAL_VISIBLE_MS
        : PRESENCE_INTERVAL_HIDDEN_MS;
    const armTimer = () => {
      const period = cadenceMs();
      // Idempotent: a visibilitychange that does not actually change visibility
      // (or a re-fired one) must not stack a second interval, or reset the phase
      // of the one already running at the right period.
      if (timer !== null && timerPeriod === period) return;
      if (timer !== null) clearInterval(timer);
      timerPeriod = period;
      timer = setInterval(post, period);
    };
    const stopTimer = () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
      timerPeriod = 0;
    };

    post();
    armTimer();

    const onVisibility = () => {
      // Always report the transition immediately — hiding is exactly the moment
      // Companion needs to hear about, and it is also when the cadence changes.
      post();
      armTimer();
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
